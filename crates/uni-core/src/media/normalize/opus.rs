//! Opus in WebM or Ogg, the only audio the relay takes as itself (`audio.rs`). It fails closed on any element it doesn't
//! know, so these are rebuilt rather than filtered: only what's listed here reaches the file, and the audio blocks are
//! copied byte for byte. Rewriting a browser recording that was already fine costs nothing and can't make it worse.
use super::{damaged, refuse};
use crate::Result;

const EBML: u32 = 0x1a45_dfa3;
const SEGMENT: u32 = 0x1853_8067;
const INFO: u32 = 0x1549_a966;
const TRACKS: u32 = 0x1654_ae6b;
const CLUSTER: u32 = 0x1f43_b675;
const SEEK_HEAD: u32 = 0x114d_9b74;
const CUES: u32 = 0x1c53_bb6b;
const TAGS: u32 = 0x1254_c367;
const CHAPTERS: u32 = 0x1043_a770;
const ATTACHMENTS: u32 = 0x1941_a469;
const TIMECODE_SCALE: u32 = 0x2a_d7b1;
const DURATION: u32 = 0x4489;
const TIMECODE: u32 = 0xe7;
const SIMPLE_BLOCK: u32 = 0xa3;
const BLOCK_GROUP: u32 = 0xa0;
const BLOCK: u32 = 0xa1;
/// What a killed recorder can leave unreadable at the end of a file: part of one block or page. More than this that won't
/// read is damage, and what lies past it would be lost without a word. (recordingJoin.ts allows the same.)
const CUT_SLACK: usize = 4096;

struct Element<'a> {
    id: u32,
    body: &'a [u8],
    unknown: bool,
    /// Its size runs past what's there: a recording cut short.
    cut: bool,
}

/// One element at `at`, its body running to the end of `b` if its size is unknown or overruns (a recording cut short).
fn element<'a>(b: &'a [u8], at: usize) -> Option<(Element<'a>, usize)> {
    let first = *b.get(at)?;
    let id_len = first.leading_zeros() as usize + 1;
    if id_len > 4 {
        return None;
    }
    let id = b
        .get(at..at + id_len)?
        .iter()
        .fold(0u32, |v, x| (v << 8) | u32::from(*x));
    let size_at = at + id_len;
    let first_size = *b.get(size_at)?;
    let size_len = first_size.leading_zeros() as usize + 1;
    if size_len > 8 {
        return None;
    }
    let mut size = u64::from(first_size) & (0xffu64 >> size_len);
    for x in b.get(size_at + 1..size_at + size_len)? {
        size = (size << 8) | u64::from(*x);
    }
    let unknown = size == (1u64 << (7 * size_len)) - 1;
    let start = size_at + size_len;
    let declared = if unknown {
        b.len()
    } else {
        start.checked_add(usize::try_from(size).ok()?)?
    };
    let end = declared.min(b.len());
    Some((
        Element {
            id,
            body: b.get(start..end)?,
            unknown,
            cut: declared > b.len(),
        },
        end,
    ))
}

fn elements(b: &[u8]) -> Vec<Element<'_>> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some((e, end)) = element(b, at) {
        out.push(e);
        at = end;
    }
    out
}

/// Write an element with a known size.
fn put(out: &mut Vec<u8>, id: u32, body: &[u8]) {
    let bytes = id.to_be_bytes();
    let skip = bytes.iter().take_while(|b| **b == 0).count();
    out.extend_from_slice(&bytes[skip..]);
    let size = body.len() as u64;
    if size < 0x7f {
        out.push(0x80 | size as u8);
    } else {
        out.push(0x01);
        out.extend_from_slice(&size.to_be_bytes()[1..]);
    }
    out.extend_from_slice(body);
}

fn opus_head_ok(b: &[u8]) -> bool {
    b.len() == 19 && b.starts_with(b"OpusHead\x01") && (1..=2).contains(&b[9]) && b[18] == 0
}

fn not_opus_audio() -> crate::Error {
    refuse("This recording isn't Opus audio; Buzz takes M4A (AAC), MP4 (H.264), or Opus in WebM or Ogg. Convert it, then attach it again.")
}

fn too_many_channels() -> crate::Error {
    refuse("This Opus audio isn't plain mono or stereo, which is all Buzz takes. Convert it, then attach it again.")
}

/// A Matroska or WebM file as the relay's single Opus track, or why it can't be.
pub(super) fn normalize_webm(b: &[u8]) -> Result<Vec<u8>> {
    let (header, after_header) = element(b, 0).ok_or_else(damaged)?;
    if header.id != EBML {
        return Err(damaged());
    }
    let (segment, _) = element(b, after_header).ok_or_else(damaged)?;
    if segment.id != SEGMENT {
        return Err(damaged());
    }
    let (mut info, mut tracks) = (None, None);
    let mut clusters: Vec<Vec<u8>> = Vec::new();
    let mut at = 0;
    while let Some((e, end)) = element(segment.body, at) {
        match e.id {
            // Half a header can't tell what the file is. A cluster can be cut: its whole blocks still play.
            INFO | TRACKS if e.cut => return Err(damaged()),
            // Not a cluster, running off the end with more than a cut would leave: a bad size, with audio lost behind it.
            id if e.cut && id != CLUSTER && e.body.len() > CUT_SLACK => return Err(damaged()),
            INFO if info.is_none() => info = Some(clean_info(e.body)),
            TRACKS if tracks.is_none() => tracks = Some(clean_tracks(e.body)?),
            CLUSTER => {
                let (cluster, consumed) = clean_cluster(e.body, e.unknown)?;
                if !cluster.is_empty() {
                    clusters.push(cluster);
                }
                if e.unknown {
                    let start = segment.body.len() - e.body.len();
                    at = start + consumed;
                    continue;
                }
            }
            _ => {} // the index, tags, chapters, attachments, padding, anything else
        }
        at = end;
    }
    if segment.body.len().saturating_sub(at) > CUT_SLACK {
        return Err(damaged());
    }
    let (Some(info), Some(tracks)) = (info, tracks) else {
        return Err(damaged());
    };
    if clusters.is_empty() {
        return Err(damaged());
    }
    let mut body = Vec::with_capacity(b.len());
    put(&mut body, INFO, &info);
    put(&mut body, TRACKS, &tracks);
    for c in &clusters {
        put(&mut body, CLUSTER, c);
    }
    let mut ebml = Vec::new();
    for (id, value) in [(0x4286u32, 1u8), (0x42f7, 1), (0x42f2, 4), (0x42f3, 8)] {
        put(&mut ebml, id, &[value]);
    }
    put(&mut ebml, 0x4282, b"webm");
    put(&mut ebml, 0x4287, &[4]);
    put(&mut ebml, 0x4285, &[2]);
    let mut out = Vec::with_capacity(body.len() + 64);
    put(&mut out, EBML, &ebml);
    put(&mut out, SEGMENT, &body);
    Ok(out)
}

/// The clock and the length; a writing app's name is the only other thing the relay allows, and nobody needs it.
fn clean_info(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for e in elements(b) {
        let keep = match e.id {
            TIMECODE_SCALE => (1..=8).contains(&e.body.len()),
            DURATION => e.body.len() == 4 || e.body.len() == 8,
            _ => false,
        };
        if keep {
            put(&mut out, e.id, e.body);
        }
    }
    out
}

fn clean_tracks(b: &[u8]) -> Result<Vec<u8>> {
    let entries: Vec<_> = elements(b).into_iter().filter(|e| e.id == 0xae).collect();
    let is_video = |e: &Element<'_>| {
        elements(e.body)
            .iter()
            .any(|f| f.id == 0x83 && f.body == [1])
    };
    if entries.iter().any(is_video) {
        return Err(refuse("This video is WebM or MKV; Buzz only takes MP4 with H.264. Convert it, then attach it again."));
    }
    if entries.is_empty() {
        return Err(damaged());
    }
    if entries.len() != 1 {
        return Err(refuse("This recording has more than one audio track, and Buzz takes one. Convert it, then attach it again."));
    }
    let (mut codec, mut head) = (None, None);
    let mut body = Vec::new();
    put(&mut body, 0xd7, &[1]);
    put(&mut body, 0x83, &[2]);
    for f in elements(entries[0].body) {
        match f.id {
            0x86 => codec = Some(f.body),
            0x63a2 => head = Some(f.body),
            0x73c5 | 0x56aa | 0x56bb | 0x23e383 if (1..=8).contains(&f.body.len()) => {
                put(&mut body, f.id, f.body)
            }
            0xe1 => {
                let mut audio = Vec::new();
                for a in elements(f.body) {
                    if matches!(a.id, 0xb5 | 0x9f | 0x6264) && (1..=8).contains(&a.body.len()) {
                        put(&mut audio, a.id, a.body);
                    }
                }
                put(&mut body, 0xe1, &audio);
            }
            _ => {} // a title, a language, a writer's own elements
        }
    }
    if codec != Some(b"A_OPUS".as_slice()) {
        return Err(not_opus_audio());
    }
    let head = head.ok_or_else(damaged)?;
    if head.len() >= 19 && head.starts_with(b"OpusHead") && (head[9] > 2 || head[18] != 0) {
        return Err(too_many_channels());
    }
    if !opus_head_ok(head) {
        return Err(damaged());
    }
    put(&mut body, 0x86, b"A_OPUS");
    put(&mut body, 0x63a2, head);
    let mut out = Vec::new();
    put(&mut out, 0xae, &body);
    Ok(out)
}

/// Blocks must say track 1 and carry no lacing. Rewrites the track number when it's one byte, as Opus's always is.
fn clean_block(b: &[u8]) -> Result<Vec<u8>> {
    let first = *b.first().ok_or_else(damaged)?;
    if first & 0x80 == 0 || b.len() <= 4 || b[3] & 0x06 != 0 {
        return Err(damaged());
    }
    let mut out = b.to_vec();
    out[0] = 0x81;
    Ok(out)
}

/// A cluster's time and blocks. With an unknown size it ends at the next segment-level element; returns where.
fn clean_cluster(b: &[u8], unknown: bool) -> Result<(Vec<u8>, usize)> {
    let mut out = Vec::new();
    let mut has_block = false;
    let mut timecode = false;
    let mut at = 0;
    while at < b.len() {
        let Some((e, end)) = element(b, at) else {
            if b.len() - at > CUT_SLACK {
                return Err(damaged());
            }
            break;
        };
        if unknown
            && matches!(
                e.id,
                CLUSTER | CUES | TAGS | INFO | TRACKS | SEEK_HEAD | CHAPTERS | ATTACHMENTS
            )
        {
            break;
        }
        // A recorder killed partway: the blocks before the cut stand, and half a block would only fail in the decoder.
        if e.cut && matches!(e.id, SIMPLE_BLOCK | BLOCK_GROUP) {
            if e.body.len() > CUT_SLACK {
                return Err(damaged());
            }
            break;
        }
        match e.id {
            TIMECODE if !timecode && (1..=8).contains(&e.body.len()) => {
                timecode = true;
                put(&mut out, TIMECODE, e.body);
            }
            // No sound in it, which the relay refuses and nothing misses.
            SIMPLE_BLOCK if e.body.len() <= 4 => {}
            SIMPLE_BLOCK => {
                put(&mut out, SIMPLE_BLOCK, &clean_block(e.body)?);
                has_block = true;
            }
            BLOCK_GROUP => {
                let mut group = Vec::new();
                let mut holds_block = false;
                for f in elements(e.body) {
                    match f.id {
                        BLOCK if f.body.len() <= 4 => {}
                        BLOCK => {
                            put(&mut group, BLOCK, &clean_block(f.body)?);
                            holds_block = true;
                        }
                        0x9b | 0xfb | 0x75a2 if (1..=8).contains(&f.body.len()) => {
                            put(&mut group, f.id, f.body)
                        }
                        _ => {}
                    }
                }
                if holds_block {
                    put(&mut out, BLOCK_GROUP, &group);
                    has_block = true;
                }
            }
            _ => {} // position, previous size, a writer's own elements
        }
        at = end;
    }
    Ok((
        if has_block && timecode {
            out
        } else {
            Vec::new()
        },
        at,
    ))
}

fn number(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |v, x| (v << 8) | u64::from(*x))
}

/// How long a WebM from [`normalize_webm`] runs, as the relay measures it (`audio.rs`): the later of the declared length
/// and the last block's start, in seconds.
pub(super) fn webm_seconds(clean: &[u8]) -> f64 {
    let Some((segment, _)) = element(clean, element(clean, 0).map_or(0, |(_, end)| end)) else {
        return 0.0;
    };
    let mut scale = 1_000_000u64; // one tick is a millisecond unless Info says otherwise
    let mut end = 0.0f64;
    for e in elements(segment.body) {
        match e.id {
            INFO => {
                for f in elements(e.body) {
                    match (f.id, f.body.len()) {
                        (TIMECODE_SCALE, _) => scale = number(f.body),
                        (DURATION, 4) => end = end.max(f64::from(f32::from_be_bytes(f.body.try_into().unwrap_or_default()))),
                        (DURATION, 8) => end = end.max(f64::from_be_bytes(f.body.try_into().unwrap_or_default())),
                        _ => {}
                    }
                }
            }
            CLUSTER => {
                let mut timecode = 0u64;
                let mut latest: Option<i16> = None;
                let mut seen = |block: &[u8]| {
                    if let Some(rel) = block.get(1..3) {
                        let rel = i16::from_be_bytes([rel[0], rel[1]]);
                        latest = Some(latest.map_or(rel, |l| l.max(rel)));
                    }
                };
                for f in elements(e.body) {
                    match f.id {
                        TIMECODE => timecode = number(f.body),
                        SIMPLE_BLOCK => seen(f.body),
                        BLOCK_GROUP => elements(f.body).iter().filter(|g| g.id == BLOCK).for_each(|g| seen(g.body)),
                        _ => {}
                    }
                }
                if let Some(rel) = latest {
                    end = end.max((timecode as f64 + f64::from(rel)).max(0.0));
                }
            }
            _ => {}
        }
    }
    end * scale as f64 / 1e9
}

/// How long an Ogg Opus from [`normalize_ogg`] runs, as the relay measures it: the furthest granule, less the pre-skip,
/// in 48 kHz samples.
pub(super) fn ogg_seconds(clean: &[u8]) -> f64 {
    let (pages, _) = pages(clean);
    let pre_skip = pages
        .first()
        .and_then(|p| p.body.get(10..12))
        .map_or(0, |b| u64::from(u16::from_le_bytes([b[0], b[1]])));
    let end = pages
        .iter()
        .map(|p| u64::from_le_bytes(p.granule))
        .filter(|g| *g != u64::MAX)
        .max()
        .unwrap_or(0);
    end.saturating_sub(pre_skip) as f64 / 48_000.0
}

// ── Ogg ─────────────────────────────────────────────────────────────────
const OGG_CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = (i as u32) << 24;
        let mut bit = 0;
        while bit < 8 {
            crc = (crc << 1)
                ^ if crc & 0x8000_0000 != 0 {
                    0x04c1_1db7
                } else {
                    0
                };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
};

fn ogg_crc(b: &[u8]) -> u32 {
    b.iter().fold(0u32, |crc, byte| {
        (crc << 8) ^ OGG_CRC_TABLE[((crc >> 24) as u8 ^ *byte) as usize]
    })
}

fn ogg_page(
    out: &mut Vec<u8>,
    flags: u8,
    granule: [u8; 8],
    serial: [u8; 4],
    seq: u32,
    lacing: &[u8],
    body: &[u8],
) {
    let start = out.len();
    out.extend_from_slice(b"OggS\0");
    out.push(flags);
    out.extend_from_slice(&granule);
    out.extend_from_slice(&serial);
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.push(lacing.len() as u8);
    out.extend_from_slice(lacing);
    out.extend_from_slice(body);
    let crc = ogg_crc(&out[start..]);
    out[start + 22..start + 26].copy_from_slice(&crc.to_le_bytes());
}

struct Page<'a> {
    flags: u8,
    granule: [u8; 8],
    serial: [u8; 4],
    lacing: &'a [u8],
    body: &'a [u8],
}

/// The file's whole pages, and where they stop.
fn pages(b: &[u8]) -> (Vec<Page<'_>>, usize) {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(head) = b.get(at..at + 27) {
        if &head[..4] != b"OggS" || head[4] != 0 {
            break;
        }
        let n = head[26] as usize;
        let Some(lacing) = b.get(at + 27..at + 27 + n) else {
            break;
        };
        let len: usize = lacing.iter().map(|v| *v as usize).sum();
        let Some(body) = b.get(at + 27 + n..at + 27 + n + len) else {
            break;
        };
        out.push(Page {
            flags: head[5] & 0x07,
            granule: head[6..14].try_into().unwrap_or_default(),
            serial: head[14..18].try_into().unwrap_or_default(),
            lacing,
            body,
        });
        at += 27 + n + len;
    }
    (out, at)
}

/// Ogg Opus with the comment packet replaced by an empty one, pages renumbered and their checksums redone.
pub(super) fn normalize_ogg(b: &[u8]) -> Result<Vec<u8>> {
    let (pages, read_to) = pages(b);
    // Unreadable bytes past the last page: a page cut short, if that's all; otherwise damage.
    if b.len() - read_to > CUT_SLACK && !b.get(read_to..read_to + 4).is_some_and(|m| m == b"OggS") {
        return Err(damaged());
    }
    let first = pages.first().ok_or_else(damaged)?;
    if pages.iter().any(|p| p.serial != first.serial) {
        return Err(refuse("This recording holds more than one stream, and Buzz takes one. Convert it, then attach it again."));
    }
    if !first.body.starts_with(b"OpusHead") {
        return Err(not_opus_audio());
    }
    // Walk the packets until the comment packet ends; the audio starts on the next page.
    let mut packets: Vec<Vec<u8>> = vec![Vec::new()];
    let mut audio_from = None;
    'walk: for (i, p) in pages.iter().enumerate() {
        let mut at = 0;
        for (s, len) in p.lacing.iter().enumerate() {
            let size = *len as usize;
            let last = packets.last_mut().ok_or_else(damaged)?;
            // Enough to recognise each: a head is 19 bytes, and comments (which can hold cover art) are thrown away.
            let room = 64usize.saturating_sub(last.len());
            last.extend_from_slice(&p.body[at..at + size.min(room)]);
            at += size;
            if size < 255 {
                if packets.len() == 2 {
                    if s + 1 != p.lacing.len() {
                        return Err(damaged()); // audio sharing the comment's page: Opus forbids it
                    }
                    audio_from = Some(i + 1);
                    break 'walk;
                }
                packets.push(Vec::new());
            }
        }
    }
    let audio_from = audio_from.ok_or_else(damaged)?;
    let head = &packets[0];
    if head.len() >= 19 && (head[9] > 2 || head[18] != 0) {
        return Err(too_many_channels());
    }
    if !opus_head_ok(head) {
        return Err(damaged());
    }
    if !packets[1].starts_with(b"OpusTags") {
        return Err(damaged());
    }
    // Cut off with a packet left open: back to the last page that closes one, since end-of-stream can't close it.
    let mut audio = &pages[audio_from..];
    while audio.last().is_some_and(|p| p.lacing.last() == Some(&255)) {
        audio = &audio[..audio.len() - 1];
    }
    if audio.is_empty() {
        return Err(damaged());
    }
    let mut out = Vec::with_capacity(b.len());
    ogg_page(&mut out, 2, [0; 8], first.serial, 0, &[19], head);
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&7u32.to_le_bytes());
    tags.extend_from_slice(b"libopus");
    tags.extend_from_slice(&0u32.to_le_bytes());
    ogg_page(
        &mut out,
        0,
        [0; 8],
        first.serial,
        1,
        &[tags.len() as u8],
        &tags,
    );
    for (i, p) in audio.iter().enumerate() {
        let is_last = i + 1 == audio.len();
        let flags = if is_last {
            (p.flags & !2) | 4
        } else {
            p.flags & !(2 | 4)
        };
        ogg_page(
            &mut out,
            flags,
            p.granule,
            p.serial,
            i as u32 + 2,
            p.lacing,
            p.body,
        );
    }
    Ok(out)
}
