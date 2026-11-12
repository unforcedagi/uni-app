//! MP4, MOV and M4A: rewritten as `ftyp moov mdat`, holding one H.264 track and at most one AAC track.
//!
//! Sample bytes are copied, never touched. Only the chunks the kept tracks point at reach the new `mdat`, in their
//! original order: a dropped track's samples (a phone's GPS track, a timecode) are gone from the file, not just unlisted.
//! `moov` is rebuilt from an allowlist instead of being filtered, so a box this code has never heard of can't get through.
//! Everything else the relay's parser (`mp4` 0.14) is fussy about is written its way: `avcC` first in `avc1`, `esds` first
//! in a plain `mp4a`, ISO `hdlr` with a terminated name.
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use super::{
    audio_too_long, damaged, io_failed, megabytes, refuse, video_too_long, MAX_AUDIO_SECONDS,
    MAX_VIDEO_BYTES, MAX_VIDEO_HEIGHT, MAX_VIDEO_SECONDS,
    MAX_VIDEO_WIDTH,
};
use crate::Result;

/// A real `moov` is a few MB at most, even for an hour at 60 fps.
const MAX_INDEX_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES: usize = 200_000;
/// Far beyond anything the relay takes: an hour at 120 fps is 432,000, three hours of 48 kHz AAC about 506,000. Keeps a
/// crafted table from filling memory.
const MAX_SAMPLES: usize = 5_000_000;
/// What a killed recorder can leave unreadable at the end of a file. More than this past the last box is damage, and in a
/// fragmented file there would be samples lost beyond it without a word.
const CUT_SLACK: u64 = 4096;
/// Far more than a real fragment's index. A `moof` claiming more than is left and this much is a bad size, not a cut.
const MAX_CUT_MOOF: u64 = 16 * 1024 * 1024;

/// What the relay reads first to pick its pipeline (`should_stream_as_video`), plus QuickTime files with no `ftyp`.
pub(super) fn looks_like(head: &[u8]) -> bool {
    if head.len() < 8 {
        return false;
    }
    let known = [
        &b"ftyp"[..],
        b"moov",
        b"mdat",
        b"wide",
        b"free",
        b"skip",
        b"pnot",
    ]
    .contains(&&head[4..8]);
    let size = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
    known && (size == 0 || size == 1 || size >= 8)
}

pub(super) struct Rewritten {
    pub audio_only: bool,
}

// ── Reading ─────────────────────────────────────────────────────────────
fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?))
}
fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn be64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// The child boxes of `b`. Stops at anything malformed: padding after the last box is common and carries nothing kept.
fn children(b: &[u8]) -> Vec<(&[u8], &[u8])> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at + 8 <= b.len() {
        let compact = be32(b, at).unwrap_or(0) as usize;
        let (len, header) = match compact {
            0 => (b.len() - at, 8),
            1 => match be64(b, at + 8).and_then(|v| usize::try_from(v).ok()) {
                Some(v) => (v, 16),
                None => break,
            },
            n => (n, 8),
        };
        if len < header || len > b.len() - at {
            break;
        }
        out.push((&b[at + 4..at + 8], &b[at + header..at + len]));
        at += len;
    }
    out
}
/// Whether `b` is whole boxes, give or take zero padding. [`children`] stops quietly at a bad size, which is right for a
/// sample entry's tail but would lose a track here without a word.
fn is_whole(b: &[u8]) -> bool {
    let mut at = 0usize;
    for (_, body) in children(b) {
        at = body.as_ptr() as usize - b.as_ptr() as usize + body.len();
    }
    // Under a box header can't hide a box, and players read straight past it. Any more has to be padding.
    b.len() - at < 8 || b[at..].iter().all(|x| *x == 0)
}
fn child<'a>(b: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    children(b)
        .into_iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, body)| body)
}

struct TopBox {
    kind: [u8; 4],
    start: u64,
    body_at: u64,
    end: u64,
    /// Its declared size runs past the end of the file.
    cut: bool,
}

/// The file's top-level boxes, from their headers alone: `mdat` can be hundreds of MB.
fn top_level<R: Read + Seek>(
    f: &mut R,
    size: u64,
    unreadable_tail: &mut bool,
) -> Result<Vec<TopBox>> {
    let mut out = Vec::new();
    let mut at = 0u64;
    while at + 8 <= size {
        if out.len() == MAX_TOP_LEVEL_BOXES {
            return Err(damaged()); // the rest would be dropped without a word
        }
        f.seek(SeekFrom::Start(at)).map_err(io_failed)?;
        let mut h = [0u8; 16];
        f.read_exact(&mut h[..8]).map_err(io_failed)?;
        let compact = be32(&h, 0).unwrap_or(0) as u64;
        let kind: [u8; 4] = [h[4], h[5], h[6], h[7]];
        let (len, header) = match compact {
            0 => (size - at, 8),
            1 => {
                if at + 16 > size {
                    break;
                }
                f.read_exact(&mut h[8..16]).map_err(io_failed)?;
                (be64(&h, 8).unwrap_or(0), 16)
            }
            n => (n, 8),
        };
        if len < header {
            // Padding, or the end of a recording that was cut off. Past that, whatever follows can't be reached.
            *unreadable_tail = size - at > CUT_SLACK;
            break;
        }
        // A box running past the end is a file cut short. `mdat` may still hold everything the index points at, and each
        // chunk is checked; a cut index is refused when it's read, since what's missing from it wouldn't otherwise show.
        let end = at.saturating_add(len).min(size);
        out.push(TopBox {
            kind,
            start: at,
            body_at: at + header,
            end,
            cut: at.saturating_add(len) > size,
        });
        if at.saturating_add(len) >= size {
            break;
        }
        at += len;
    }
    Ok(out)
}

fn read_box<R: Read + Seek>(f: &mut R, b: &TopBox) -> Result<Vec<u8>> {
    if b.cut {
        return Err(damaged());
    }
    let len = b.end.saturating_sub(b.body_at);
    if len > MAX_INDEX_BYTES {
        return Err(refuse(
            "This file's index is too large to process, so it can't be sent.",
        ));
    }
    f.seek(SeekFrom::Start(b.body_at)).map_err(io_failed)?;
    let mut body = vec![0u8; len as usize];
    f.read_exact(&mut body).map_err(io_failed)?;
    Ok(body)
}

/// Where one chunk's bytes are in the source file.
#[derive(Clone, Copy)]
struct Chunk {
    from: u64,
    len: u64,
}

/// A track's sample tables as box bodies, ready to write, plus its chunks.
struct Tables {
    stts: Vec<u8>,
    ctts: Option<Vec<u8>>,
    stss: Option<Vec<u8>>,
    stsc: Vec<u8>,
    stsz: Vec<u8>,
    groups: Vec<([u8; 4], Vec<u8>)>,
    chunks: Vec<Chunk>,
    /// Samples in each of `chunks`.
    chunk_samples: Vec<u32>,
    samples: u32,
}

struct Track<'a> {
    id: u32,
    handler: [u8; 4],
    tkhd: &'a [u8],
    elst: Option<Vec<u8>>,
    timescale: u32,
    duration: u64,
    entry_kind: [u8; 4],
    entry: &'a [u8],
    tables: Tables,
    /// Why its tables can't be read. Only matters if it's the track that has to be kept.
    tables_error: Option<String>,
}

fn entry_of(stsd: &[u8]) -> Option<([u8; 4], &[u8])> {
    if be32(stsd, 4)? == 0 {
        return None;
    }
    let (kind, body) = children(stsd.get(8..)?).into_iter().next()?;
    Some((kind.try_into().ok()?, body))
}

/// Chunks from the flat tables. Refuses a file whose tables don't add up, because the relay's parser and players would.
fn flat_tables(stbl: &[u8], size: u64) -> Result<Tables> {
    let bad = damaged;
    let stsc = child(stbl, b"stsc").ok_or_else(bad)?;
    let (sizes, stsz) = sample_sizes(stbl)?;
    let offsets: Vec<u64> = if let Some(c) = child(stbl, b"stco") {
        let n = be32(c, 4).ok_or_else(bad)? as usize;
        if n > MAX_SAMPLES {
            return Err(bad());
        }
        (0..n)
            .map(|i| be32(c, 8 + i * 4).map(u64::from).ok_or_else(bad))
            .collect::<Result<_>>()?
    } else if let Some(c) = child(stbl, b"co64") {
        let n = be32(c, 4).ok_or_else(bad)? as usize;
        if n > MAX_SAMPLES {
            return Err(bad());
        }
        (0..n)
            .map(|i| be64(c, 8 + i * 8).ok_or_else(bad))
            .collect::<Result<_>>()?
    } else {
        return Err(bad());
    };
    let rows = be32(stsc, 4).ok_or_else(bad)? as usize;
    let mut chunks = Vec::with_capacity(offsets.len());
    let mut chunk_samples = Vec::with_capacity(offsets.len());
    let mut next = 0usize;
    for row in 0..rows {
        let at = 8 + row * 12;
        let first = be32(stsc, at).ok_or_else(bad)? as usize;
        let per = be32(stsc, at + 4).ok_or_else(bad)? as usize;
        if be32(stsc, at + 8) != Some(1) {
            return Err(refuse(
                "This video changes format partway through, so it can't be sent as it is.",
            ));
        }
        let stop = if row + 1 < rows {
            be32(stsc, at + 12).ok_or_else(bad)? as usize
        } else {
            offsets.len() + 1
        };
        if first == 0 || stop < first || stop > offsets.len() + 1 {
            return Err(bad());
        }
        for chunk in first..stop {
            let take = per.min(sizes.len() - next);
            let len: u64 = sizes[next..next + take].iter().map(|s| u64::from(*s)).sum();
            let from = offsets[chunk - 1];
            if from.checked_add(len).is_none_or(|end| end > size) {
                return Err(bad());
            }
            chunks.push(Chunk { from, len });
            chunk_samples.push(take as u32);
            next += take;
        }
    }
    if next != sizes.len() || chunks.len() != offsets.len() {
        return Err(bad());
    }
    let mut groups = Vec::new();
    for (kind, body) in children(stbl) {
        // Only the kinds that change how the media decodes (AAC and H.264 pre-roll), each with its partner.
        if (kind == b"sgpd" || kind == b"sbgp") && matches!(body.get(4..8), Some(b"roll" | b"prol"))
        {
            groups.push((kind.try_into().unwrap_or(*b"free"), body.to_vec()));
        }
    }
    Ok(Tables {
        stts: child(stbl, b"stts").ok_or_else(bad)?.to_vec(),
        ctts: child(stbl, b"ctts").map(<[u8]>::to_vec),
        stss: child(stbl, b"stss").map(<[u8]>::to_vec),
        stsc: stsc.to_vec(),
        stsz,
        groups,
        chunks,
        chunk_samples,
        samples: sizes.len() as u32,
    })
}

/// Every sample's size, and an `stsz` body. `stz2` isn't one the relay's parser can read.
fn sample_sizes(stbl: &[u8]) -> Result<(Vec<u32>, Vec<u8>)> {
    let bad = damaged;
    if let Some(b) = child(stbl, b"stsz") {
        let fixed = be32(b, 4).ok_or_else(bad)?;
        let n = be32(b, 8).ok_or_else(bad)? as usize;
        if n > MAX_SAMPLES {
            return Err(bad());
        }
        let sizes = if fixed != 0 {
            vec![fixed; n]
        } else {
            (0..n)
                .map(|i| be32(b, 12 + i * 4).ok_or_else(bad))
                .collect::<Result<_>>()?
        };
        return Ok((sizes, b.to_vec()));
    }
    let b = child(stbl, b"stz2").ok_or_else(bad)?;
    let field = *b.get(7).ok_or_else(bad)?;
    let n = be32(b, 8).ok_or_else(bad)? as usize;
    if n > MAX_SAMPLES {
        return Err(bad());
    }
    let sizes: Vec<u32> = (0..n)
        .map(|i| match field {
            16 => be16(b, 12 + i * 2).map(u32::from).ok_or_else(bad),
            8 => b.get(12 + i).map(|v| u32::from(*v)).ok_or_else(bad),
            4 => b
                .get(12 + i / 2)
                .map(|v| u32::from(if i % 2 == 0 { v >> 4 } else { v & 15 }))
                .ok_or_else(bad),
            _ => Err(bad()),
        })
        .collect::<Result<_>>()?;
    Ok((sizes.clone(), stsz_body(&sizes)))
}

fn stsz_body(sizes: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + sizes.len() * 4);
    out.extend_from_slice(&[0; 8]);
    out.extend_from_slice(&(sizes.len() as u32).to_be_bytes());
    for s in sizes {
        out.extend_from_slice(&s.to_be_bytes());
    }
    out
}

fn mdhd_fields(b: &[u8]) -> Option<(u32, u64)> {
    match *b.first()? {
        1 => Some((be32(b, 20)?, be64(b, 24)?)),
        _ => Some((be32(b, 12)?, u64::from(be32(b, 16)?))),
    }
}
fn tkhd_id(b: &[u8]) -> Option<u32> {
    be32(b, if *b.first()? == 1 { 20 } else { 12 })
}
fn tkhd_duration(b: &[u8]) -> Option<u64> {
    if *b.first()? == 1 {
        be64(b, 28)
    } else {
        be32(b, 20).map(u64::from)
    }
}
fn tkhd_enabled(b: &[u8]) -> bool {
    b.get(3).is_some_and(|f| f & 1 != 0)
}

fn parse_track<'a>(trak: &'a [u8], size: u64) -> Result<Option<Track<'a>>> {
    let bad = damaged;
    if !is_whole(trak) {
        return Err(bad());
    }
    let tkhd = child(trak, b"tkhd").ok_or_else(bad)?;
    let mdia = child(trak, b"mdia").ok_or_else(bad)?;
    if !is_whole(mdia) || child(mdia, b"minf").is_some_and(|m| !is_whole(m)) {
        return Err(bad());
    }
    let handler: [u8; 4] = child(mdia, b"hdlr")
        .and_then(|h| h.get(8..12))
        .and_then(|h| h.try_into().ok())
        .ok_or_else(bad)?;
    let (timescale, duration) =
        mdhd_fields(child(mdia, b"mdhd").ok_or_else(bad)?).ok_or_else(bad)?;
    let Some(stbl) = child(mdia, b"minf").and_then(|m| child(m, b"stbl")) else {
        return Ok(None); // a reference to nothing; nothing here to keep
    };
    let Some((entry_kind, entry)) = child(stbl, b"stsd").and_then(entry_of) else {
        return Ok(None);
    };
    let keepable = (&handler == b"vide" && &entry_kind == b"avc1")
        || (&handler == b"soun" && &entry_kind == b"mp4a");
    // A fragmented file's moov usually lists no samples, but it can list the first stretch of them: flat_tables finds either.
    // Only a chosen track is copied, so a bad table only counts if this is the one that has to be kept. The count says
    // whether a track holds anything to name in a refusal.
    let counted = || {
        let samples = child(stbl, b"stsz")
            .or_else(|| child(stbl, b"stz2"))
            .and_then(|b| be32(b, 8))
            .unwrap_or(0);
        Tables {
            samples,
            ..empty_tables()
        }
    };
    let mut tables_error = None;
    let tables = if keepable {
        flat_tables(stbl, size).unwrap_or_else(|e| {
            tables_error = Some(e.to_string());
            counted()
        })
    } else {
        counted()
    };
    // Some writers leave the header's duration at zero. The table is what plays.
    let duration = if duration == 0 {
        stts_total(&tables.stts)
    } else {
        duration
    };
    let elst = child(trak, b"edts")
        .and_then(|e| child(e, b"elst"))
        .map(<[u8]>::to_vec);
    Ok(Some(Track {
        id: tkhd_id(tkhd).ok_or_else(bad)?,
        handler,
        tkhd,
        elst,
        timescale,
        duration,
        entry_kind,
        entry,
        tables,
        tables_error,
    }))
}

fn stts_total(stts: &[u8]) -> u64 {
    let rows = be32(stts, 4).unwrap_or(0) as usize;
    (0..rows)
        .filter_map(|i| {
            Some(u64::from(be32(stts, 8 + i * 8)?) * u64::from(be32(stts, 12 + i * 8)?))
        })
        .sum()
}

fn empty_tables() -> Tables {
    Tables {
        stts: vec![],
        ctts: None,
        stss: None,
        stsc: vec![],
        stsz: vec![],
        groups: vec![],
        chunks: vec![],
        chunk_samples: vec![],
        samples: 0,
    }
}

// ── Fragmented files: a recorder's moof/mdat pairs become flat tables ───
#[derive(Default)]
struct Fragments {
    durations: Vec<u32>,
    sizes: Vec<u32>,
    offsets: Vec<i64>,
    sync: Vec<bool>,
    chunks: Vec<(u64, u32, u64)>, // offset, samples, bytes
    start: Option<u64>,
    end: u64,
}

/// A track's samples listed in moov itself, as the start of its fragments. They come first and start at zero.
fn fragments_from_flat(t: &Tables) -> Result<Fragments> {
    let bad = damaged;
    let mut out = Fragments::default();
    // No table to read: nothing listed, or a track that won't be kept and was only counted.
    if t.samples == 0 || t.stts.is_empty() {
        return Ok(out);
    }
    let count = t.samples as usize;
    for i in 0..be32(&t.stts, 4).ok_or_else(bad)? as usize {
        let (n, delta) = (
            be32(&t.stts, 8 + i * 8).ok_or_else(bad)? as usize,
            be32(&t.stts, 12 + i * 8).ok_or_else(bad)?,
        );
        if out.durations.len().saturating_add(n) > count {
            return Err(bad());
        }
        out.durations.resize(out.durations.len() + n, delta);
    }
    if out.durations.len() != count {
        return Err(bad());
    }
    out.offsets = vec![0; count];
    if let Some(c) = &t.ctts {
        let mut at = 0usize;
        for i in 0..be32(c, 4).ok_or_else(bad)? as usize {
            let n = be32(c, 8 + i * 8).ok_or_else(bad)? as usize;
            let raw = be32(c, 12 + i * 8).ok_or_else(bad)?;
            let offset = if c.first() == Some(&0) {
                i64::from(raw)
            } else {
                i64::from(raw as i32)
            };
            if at.saturating_add(n) > count {
                return Err(bad());
            }
            out.offsets[at..at + n].fill(offset);
            at += n;
        }
    }
    out.sync = vec![t.stss.is_none(); count];
    if let Some(s) = &t.stss {
        for i in 0..be32(s, 4).ok_or_else(bad)? as usize {
            let n = be32(s, 8 + i * 4).ok_or_else(bad)? as usize;
            *out.sync.get_mut(n.wrapping_sub(1)).ok_or_else(bad)? = true;
        }
    }
    let fixed = be32(&t.stsz, 4).ok_or_else(bad)?;
    for i in 0..count {
        out.sizes.push(if fixed != 0 {
            fixed
        } else {
            be32(&t.stsz, 12 + i * 4).ok_or_else(bad)?
        });
    }
    out.chunks = t
        .chunks
        .iter()
        .zip(&t.chunk_samples)
        .map(|(c, n)| (c.from, *n, c.len))
        .collect();
    out.start = Some(0);
    out.end = out.durations.iter().map(|d| u64::from(*d)).sum();
    Ok(out)
}

fn read_fragments<R: Read + Seek>(
    f: &mut R,
    boxes: &[TopBox],
    trex_of: &dyn Fn(u32) -> Option<(u32, u32, u32)>,
    tracks: &mut [(u32, Fragments)],
    size: u64,
) -> Result<()> {
    let bad = damaged;
    let mut total = 0u64;
    let mut seen = 0u64;
    for b in boxes.iter().filter(|b| &b.kind == b"moof") {
        // A recorder killed partway: the fragments before this one stand, as a player would show them.
        if b.cut {
            return if b.end - b.body_at > MAX_CUT_MOOF {
                Err(bad())
            } else {
                Ok(())
            };
        }
        let moof_start = b.start;
        total += b.end - b.body_at;
        if total > MAX_INDEX_BYTES {
            return Err(refuse(
                "This file's index is too large to process, so it can't be sent.",
            ));
        }
        let body = read_box(f, b)?;
        let mut previous_end = moof_start;
        for (kind, traf) in children(&body) {
            if kind != b"traf" {
                continue;
            }
            let tfhd = child(traf, b"tfhd").ok_or_else(bad)?;
            let flags = be32(tfhd, 0).ok_or_else(bad)? & 0x00ff_ffff;
            let id = be32(tfhd, 4).ok_or_else(bad)?;
            let (base_explicit, mut pos) = if flags & 1 != 0 {
                (Some(be64(tfhd, 8).ok_or_else(bad)?), 16)
            } else {
                (None, 8)
            };
            let mut next = |bit: u32| -> Option<u32> {
                if flags & bit == 0 {
                    return None;
                }
                let v = be32(tfhd, pos);
                pos += 4;
                v
            };
            if next(0x02).is_some_and(|d| d != 1) {
                return Err(refuse(
                    "This video changes format partway through, so it can't be sent as it is.",
                ));
            }
            let default_duration = next(0x08);
            let default_size = next(0x10);
            let default_flags = next(0x20);
            let (trex_duration, trex_size, trex_flags) = trex_of(id).unwrap_or((0, 0, 0));
            let default_duration = default_duration.unwrap_or(trex_duration);
            let default_size = default_size.unwrap_or(trex_size);
            let default_flags = default_flags.unwrap_or(trex_flags);
            let base = base_explicit.unwrap_or(if flags & 0x0002_0000 != 0 {
                moof_start
            } else {
                previous_end
            });

            let mut kept = tracks
                .iter_mut()
                .find(|(t, _)| *t == id)
                .map(|(_, frag)| frag);
            // Applied when this fragment's first samples arrive: an empty one says nothing about when the track starts.
            let mut time_now = child(traf, b"tfdt")
                .map(|tfdt| {
                    if tfdt.first() == Some(&1) {
                        be64(tfdt, 4)
                    } else {
                        be32(tfdt, 4).map(u64::from)
                    }
                    .ok_or_else(bad)
                })
                .transpose()?;
            let mut cursor = base;
            for (kind, trun) in children(traf) {
                if kind != b"trun" {
                    continue;
                }
                let version = *trun.first().ok_or_else(bad)?;
                let tflags = be32(trun, 0).ok_or_else(bad)? & 0x00ff_ffff;
                let count = be32(trun, 4).ok_or_else(bad)?;
                let mut at = 8usize;
                if tflags & 0x1 != 0 {
                    let off = be32(trun, at).ok_or_else(bad)? as i32;
                    at += 4;
                    cursor = base.checked_add_signed(i64::from(off)).ok_or_else(bad)?;
                }
                let first_flags = if tflags & 0x4 != 0 {
                    let v = be32(trun, at).ok_or_else(bad)?;
                    at += 4;
                    Some(v)
                } else {
                    None
                };
                let start = cursor;
                let mut bytes = 0u64;
                seen += u64::from(count);
                if seen > MAX_SAMPLES as u64 {
                    return Err(bad());
                }
                let mut batch = Vec::with_capacity(count as usize);
                for i in 0..count {
                    let mut read = |bit: u32| -> Result<Option<u32>> {
                        if tflags & bit == 0 {
                            return Ok(None);
                        }
                        let v = be32(trun, at).ok_or_else(bad)?;
                        at += 4;
                        Ok(Some(v))
                    };
                    let duration = read(0x100)?.unwrap_or(default_duration);
                    let sample_size = read(0x200)?.unwrap_or(default_size);
                    let sample_flags = read(0x400)?.unwrap_or(if i == 0 {
                        first_flags.unwrap_or(default_flags)
                    } else {
                        default_flags
                    });
                    let offset = read(0x800)?.map_or(0, |v| {
                        if version == 0 {
                            i64::from(v)
                        } else {
                            i64::from(v as i32)
                        }
                    });
                    bytes = bytes.saturating_add(u64::from(sample_size));
                    batch.push((
                        duration,
                        sample_size,
                        offset,
                        sample_flags & 0x0001_0000 == 0,
                    ));
                }
                // This run's samples aren't all there: the same killed recorder, so stop at the whole ones before it.
                if start.checked_add(bytes).is_none_or(|end| end > size) {
                    return Ok(());
                }
                if let (Some(frag), true) = (kept.as_deref_mut(), count > 0) {
                    if let Some(time) = time_now.take() {
                        if frag.start.is_none() {
                            frag.start = Some(time);
                            frag.end = time;
                        } else if time > frag.end {
                            // A gap between fragments: the sample before it lasts until the next one starts, as a player
                            // would show it.
                            if let Some(last) = frag.durations.last_mut() {
                                *last = last.saturating_add(
                                    u32::try_from(time - frag.end).unwrap_or(u32::MAX),
                                );
                            }
                            frag.end = time;
                        } else if time < frag.end {
                            // An overlap: a recorder's rounding, usually. Left alone these add up, and one track
                            // drifts away from the other. More than a sample's length is a clock restarting, not
                            // an overlap, and samples keep their own durations through it.
                            if let Some(last) = frag.durations.last_mut() {
                                let back = frag.end - time;
                                if back < u64::from(*last) {
                                    *last -= back as u32;
                                    frag.end = time;
                                }
                            }
                        }
                    }
                    for (duration, sample_size, offset, sync) in batch {
                        frag.durations.push(duration);
                        frag.sizes.push(sample_size);
                        frag.offsets.push(offset);
                        frag.sync.push(sync);
                        frag.end = frag.end.saturating_add(u64::from(duration));
                    }
                    frag.chunks.push((start, count, bytes));
                }
                cursor = start.saturating_add(bytes);
            }
            previous_end = cursor;
        }
    }
    Ok(())
}

impl Fragments {
    /// When the last sample finishes showing, in media time from the track's first decode. With B-frames that's later than
    /// the last one decoded.
    fn shown_until(&self) -> u64 {
        let mut decode = 0i64;
        let mut end = 0i64;
        for (d, o) in self.durations.iter().zip(&self.offsets) {
            end = end.max(decode.saturating_add(*o).saturating_add(i64::from(*d)));
            decode = decode.saturating_add(i64::from(*d));
        }
        end.max(0) as u64
    }
}

fn tables_from_fragments(frag: &Fragments, handler: &[u8; 4]) -> Tables {
    fn runs<T: PartialEq + Copy>(v: &[T]) -> Vec<(u32, T)> {
        let mut out: Vec<(u32, T)> = Vec::new();
        for x in v {
            match out.last_mut() {
                Some((n, y)) if y == x => *n += 1,
                _ => out.push((1, *x)),
            }
        }
        out
    }
    let table = |rows: u32, cells: Vec<u8>| {
        let mut b = vec![0u8; 4];
        b.extend_from_slice(&rows.to_be_bytes());
        b.extend_from_slice(&cells);
        b
    };
    let r = runs(&frag.durations);
    let stts = table(
        r.len() as u32,
        r.iter()
            .flat_map(|(n, d)| [n.to_be_bytes(), d.to_be_bytes()].concat())
            .collect(),
    );
    let ctts = frag.offsets.iter().any(|o| *o != 0).then(|| {
        let r = runs(&frag.offsets);
        let mut b = table(
            r.len() as u32,
            r.iter()
                .flat_map(|(n, o)| [n.to_be_bytes(), (*o as i32).to_be_bytes()].concat())
                .collect(),
        );
        b[0] = 1; // signed offsets
        b
    });
    let stss = (handler == b"vide" && frag.sync.iter().any(|s| !*s)).then(|| {
        let rows: Vec<u32> = frag
            .sync
            .iter()
            .enumerate()
            .filter(|(_, s)| **s)
            .map(|(i, _)| i as u32 + 1)
            .collect();
        table(
            rows.len() as u32,
            rows.iter().flat_map(|n| n.to_be_bytes()).collect(),
        )
    });
    let mut rows: Vec<(u32, u32)> = Vec::new();
    for (i, (_, count, _)) in frag.chunks.iter().enumerate() {
        if rows.last().is_none_or(|(_, c)| c != count) {
            rows.push((i as u32 + 1, *count));
        }
    }
    let stsc = table(
        rows.len() as u32,
        rows.iter()
            .flat_map(|(first, count)| {
                [first.to_be_bytes(), count.to_be_bytes(), 1u32.to_be_bytes()].concat()
            })
            .collect(),
    );
    Tables {
        stts,
        ctts,
        stss,
        stsc,
        stsz: stsz_body(&frag.sizes),
        groups: vec![],
        chunks: frag
            .chunks
            .iter()
            .map(|(from, _, len)| Chunk {
                from: *from,
                len: *len,
            })
            .collect(),
        chunk_samples: frag.chunks.iter().map(|(_, n, _)| *n).collect(),
        samples: frag.sizes.len() as u32,
    }
}

// ── What the relay refuses and no rewrite can change ────────────────────
fn video_codec_name(kind: &[u8; 4]) -> String {
    match kind {
        b"hvc1" | b"hev1" | b"dvh1" | b"dvhe" => "H.265 (HEVC)".into(),
        b"av01" => "AV1".into(),
        b"vp09" => "VP9".into(),
        b"vp08" => "VP8".into(),
        b"mp4v" => "MPEG-4".into(),
        b"s263" | b"h263" => "H.263".into(),
        b"avc3" | b"avc2" | b"avc4" => "an H.264 variant Buzz can't read".into(),
        b"apch" | b"apcn" | b"apcs" | b"apco" | b"ap4h" | b"ap4x" => "ProRes".into(),
        b"jpeg" | b"mjpa" | b"mjpb" => "Motion JPEG".into(),
        _ => format!("in a format Buzz can't read ({})", printable(kind)),
    }
}
fn audio_codec_name(kind: &[u8; 4]) -> String {
    match kind {
        b"sowt" | b"twos" | b"lpcm" | b"in24" | b"in32" | b"fl32" | b"fl64" | b"raw " => {
            "uncompressed PCM".into()
        }
        b"alac" => "Apple Lossless".into(),
        b"ac-3" | b"ec-3" => "Dolby".into(),
        b"Opus" | b"opus" => "Opus".into(),
        b"fLaC" => "FLAC".into(),
        b".mp3" => "MP3".into(),
        b"samr" | b"sawb" => "AMR".into(),
        _ => format!("in a format Buzz can't read ({})", printable(kind)),
    }
}
fn printable(kind: &[u8; 4]) -> String {
    kind.iter()
        .map(|b| {
            if b.is_ascii_graphic() {
                *b as char
            } else {
                '?'
            }
        })
        .collect()
}

/// The picture and sound to keep, or why neither can stand.
fn choose<'t, 'a>(
    tracks: &'t [Track<'a>],
) -> Result<(Option<&'t Track<'a>>, Option<&'t Track<'a>>)> {
    let has_samples = |t: &&Track<'_>| t.tables.samples > 0;
    let pick = |kind: &[u8; 4], handler: &[u8; 4]| {
        let found = || {
            tracks
                .iter()
                .filter(has_samples)
                .filter(|t| &t.handler == handler && &t.entry_kind == kind)
        };
        let readable = || found().filter(|t| t.tables_error.is_none());
        readable()
            .find(|t| tkhd_enabled(t.tkhd))
            .or_else(|| readable().next())
            .or_else(|| found().next())
    };
    if tracks.iter().any(|t| {
        &t.entry_kind == b"encv"
            || &t.entry_kind == b"enca"
            || &t.entry_kind == b"drmi"
            || &t.entry_kind == b"drms"
    }) {
        return Err(refuse("This file is copy-protected, so it can't be sent."));
    }
    let sound = pick(b"mp4a", b"soun");
    let picture = pick(b"avc1", b"vide");
    if let Some(reason) = [picture, sound]
        .into_iter()
        .flatten()
        .find_map(|t| t.tables_error.as_ref())
    {
        return Err(refuse(reason.clone()));
    }
    // Cover art is stored as a video track of one still image: not a picture to keep, and no reason to refuse.
    let is_cover = |t: &&Track<'_>| {
        matches!(&t.entry_kind, b"jpeg" | b"png " | b"mjpa") && t.tables.samples <= 1
    };
    let real_video: Vec<&Track<'_>> = tracks
        .iter()
        .filter(|t| &t.handler == b"vide")
        .filter(has_samples)
        .filter(|t| !(sound.is_some() && is_cover(t)))
        .collect();
    if picture.is_none() {
        if let Some(t) = real_video.first() {
            let codec = video_codec_name(&t.entry_kind);
            return Err(refuse(format!("This video is {codec}; Buzz only takes H.264. Convert it to H.264, then attach it again.")));
        }
    }
    if sound.is_none() {
        if let Some(t) = tracks
            .iter()
            .filter(has_samples)
            .find(|t| &t.handler == b"soun")
        {
            let codec = audio_codec_name(&t.entry_kind);
            let what = if picture.is_some() {
                "This video's sound is"
            } else {
                "This audio is"
            };
            return Err(refuse(format!(
                "{what} {codec}; Buzz only takes AAC. Convert it to AAC, then attach it again."
            )));
        }
    }
    if picture.is_none() && sound.is_none() {
        return Err(damaged());
    }
    Ok((picture, sound))
}

// ── Writing ─────────────────────────────────────────────────────────────
fn bx(kind: &[u8; 4], parts: &[&[u8]]) -> Vec<u8> {
    let len: usize = parts.iter().map(|p| p.len()).sum();
    let mut out = Vec::with_capacity(len + 8);
    out.extend_from_slice(&((len + 8) as u32).to_be_bytes());
    out.extend_from_slice(kind);
    for p in parts {
        out.extend_from_slice(p);
    }
    out
}

const IDENTITY: [u8; 36] = [
    0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0x40, 0, 0, 0,
];

/// `ftyp`: plain MP4, whatever the source called itself.
fn ftyp() -> Vec<u8> {
    bx(
        b"ftyp",
        &[b"isom", &[0, 0, 2, 0], b"isom", b"iso2", b"avc1", b"mp41"],
    )
}

fn mvhd(source: &[u8], timescale: u32, duration: u64, next_track: u32) -> Vec<u8> {
    let v1 = source.first() == Some(&1);
    let tail = if v1 { 32 } else { 20 };
    let rate = be32(source, tail)
        .filter(|r| *r != 0)
        .unwrap_or(0x0001_0000);
    let volume = be16(source, tail + 4).unwrap_or(0x0100);
    let matrix = source
        .get(tail + 16..tail + 52)
        .map_or(IDENTITY.to_vec(), <[u8]>::to_vec);
    let mut b = vec![0u8; 12];
    b.extend_from_slice(&timescale.to_be_bytes());
    b.extend_from_slice(&u32::try_from(duration).unwrap_or(u32::MAX).to_be_bytes());
    b.extend_from_slice(&rate.to_be_bytes());
    b.extend_from_slice(&volume.to_be_bytes());
    b.extend_from_slice(&[0; 10]);
    b.extend_from_slice(&matrix);
    b.extend_from_slice(&[0; 24]);
    b.extend_from_slice(&next_track.to_be_bytes());
    bx(b"mvhd", &[&b])
}

/// Capture times zeroed; marked as the track that plays, since nothing is left to choose between.
fn tkhd(source: &[u8], id: u32, duration: u64) -> Result<Vec<u8>> {
    let from = if source.first() == Some(&1) { 36 } else { 24 };
    let rest = source.get(from..from + 60).ok_or_else(damaged)?;
    let mut b = vec![0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0];
    b.extend_from_slice(&id.to_be_bytes());
    b.extend_from_slice(&[0; 4]);
    b.extend_from_slice(&u32::try_from(duration).unwrap_or(u32::MAX).to_be_bytes());
    b.extend_from_slice(&rest[..10]); // reserved, layer
    b.extend_from_slice(&[0; 2]); // alternate group: there are no alternates now
    b.extend_from_slice(&rest[12..]);
    Ok(bx(b"tkhd", &[&b]))
}

fn mdhd(timescale: u32, duration: u64) -> Vec<u8> {
    if let Ok(d) = u32::try_from(duration) {
        let mut b = vec![0u8; 12];
        b.extend_from_slice(&timescale.to_be_bytes());
        b.extend_from_slice(&d.to_be_bytes());
        b.extend_from_slice(&[0x55, 0xc4, 0, 0]);
        bx(b"mdhd", &[&b])
    } else {
        let mut b = vec![1, 0, 0, 0];
        b.extend_from_slice(&[0; 16]);
        b.extend_from_slice(&timescale.to_be_bytes());
        b.extend_from_slice(&duration.to_be_bytes());
        b.extend_from_slice(&[0x55, 0xc4, 0, 0]);
        bx(b"mdhd", &[&b])
    }
}

fn hdlr(handler: &[u8; 4]) -> Vec<u8> {
    let mut b = vec![0u8; 8];
    b.extend_from_slice(handler);
    b.extend_from_slice(&[0; 13]); // reserved, then an empty name
    bx(b"hdlr", &[&b])
}

fn dinf() -> Vec<u8> {
    bx(
        b"dinf",
        &[&bx(
            b"dref",
            &[&[0, 0, 0, 0, 0, 0, 0, 1], &bx(b"url ", &[&[0, 0, 0, 1]])],
        )],
    )
}

/// An `avc1` entry: fixed fields as they were, the encoder's name blanked, `avcC` first, then only what changes how it looks.
fn avc1(entry: &[u8]) -> Result<Vec<u8>> {
    let mut fixed = entry.get(..78).ok_or_else(damaged)?.to_vec();
    fixed[42..74].fill(0);
    fixed[6..8].copy_from_slice(&[0, 1]);
    let kids = children(&entry[78..]);
    let avcc = kids
        .iter()
        .find(|(k, _)| *k == b"avcC")
        .ok_or_else(damaged)?;
    let mut out = fixed;
    out.extend_from_slice(&bx(b"avcC", &[avcc.1]));
    for (kind, body) in &kids {
        let keep = match *kind {
            b"pasp" | b"clap" | b"fiel" => true,
            // An ICC profile (`prof`) has a description and a maker; the colour numbers (`nclx`, `nclc`) don't.
            b"colr" => matches!(body.get(..4), Some(b"nclx" | b"nclc")),
            _ => false,
        };
        if keep {
            let k: &[u8; 4] = (*kind).try_into().map_err(|_| damaged())?;
            out.extend_from_slice(&bx(k, &[body]));
        }
    }
    Ok(bx(b"avc1", &[&out]))
}

/// A plain `mp4a`, whichever QuickTime sound description it came in. The relay's parser reads only this form.
fn mp4a(entry: &[u8], timescale: u32) -> Result<Vec<u8>> {
    let version = be16(entry, 8).ok_or_else(damaged)?;
    let (kids_at, channels, rate) = match version {
        0 => (
            28,
            be16(entry, 16).unwrap_or(2),
            be32(entry, 24).unwrap_or(0),
        ),
        1 => (
            44,
            be16(entry, 16).unwrap_or(2),
            be32(entry, 24).unwrap_or(0),
        ),
        2 => {
            let hz = entry
                .get(32..40)
                .and_then(|b| b.try_into().ok())
                .map_or(0.0, f64::from_be_bytes);
            (
                64,
                be32(entry, 40).unwrap_or(2) as u16,
                ((hz as u32).min(0xffff)) << 16,
            )
        }
        _ => return Err(damaged()),
    };
    let esds_at = |at: usize| {
        let kids = children(entry.get(at..)?);
        kids.iter()
            .find(|(k, _)| *k == b"esds")
            .map(|(_, b)| *b)
            .or_else(|| {
                kids.iter()
                    .find(|(k, _)| *k == b"wave")
                    .and_then(|(_, wave)| child(wave, b"esds"))
            })
    };
    // ISO's own version 1 has QuickTime's version number and none of its extra fields.
    let esds = esds_at(kids_at).or_else(|| if version == 1 { esds_at(28) } else { None });
    let esds = esds.ok_or_else(damaged)?;
    let rate = if rate != 0 {
        rate
    } else {
        timescale.min(0xffff) << 16
    };
    let mut b = vec![0u8; 8];
    b[7] = 1;
    b.extend_from_slice(&[0; 8]);
    b.extend_from_slice(&channels.to_be_bytes());
    b.extend_from_slice(&[0, 16, 0, 0, 0, 0]);
    b.extend_from_slice(&rate.to_be_bytes());
    b.extend_from_slice(&bx(b"esds", &[esds]));
    Ok(bx(b"mp4a", &[&b]))
}

struct Planned {
    stsd_entry: Vec<u8>,
    handler: [u8; 4],
    tkhd: Vec<u8>,
    edts: Option<Vec<u8>>,
    timescale: u32,
    media_duration: u64,
    head: Vec<u8>,
    stts: Vec<u8>,
    ctts: Option<Vec<u8>>,
    stss: Option<Vec<u8>>,
    stsc: Vec<u8>,
    stsz: Vec<u8>,
    groups: Vec<([u8; 4], Vec<u8>)>,
}

fn trak(p: &Planned, offsets: &[u32]) -> Vec<u8> {
    let mut stco = vec![0u8; 4];
    stco.extend_from_slice(&(offsets.len() as u32).to_be_bytes());
    for o in offsets {
        stco.extend_from_slice(&o.to_be_bytes());
    }
    let mut parts = vec![
        bx(b"stsd", &[&[0, 0, 0, 0, 0, 0, 0, 1], &p.stsd_entry]),
        bx(b"stts", &[&p.stts]),
    ];
    if let Some(c) = &p.ctts {
        parts.push(bx(b"ctts", &[c]));
    }
    if let Some(s) = &p.stss {
        parts.push(bx(b"stss", &[s]));
    }
    parts.push(bx(b"stsc", &[&p.stsc]));
    parts.push(bx(b"stsz", &[&p.stsz]));
    parts.push(bx(b"stco", &[&stco]));
    for (kind, body) in &p.groups {
        parts.push(bx(kind, &[body]));
    }
    let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
    let stbl = bx(b"stbl", &refs);
    let minf = bx(b"minf", &[&p.head, &dinf(), &stbl]);
    let mdia = bx(
        b"mdia",
        &[
            &mdhd(p.timescale, p.media_duration),
            &hdlr(&p.handler),
            &minf,
        ],
    );
    match &p.edts {
        Some(e) => bx(b"trak", &[&p.tkhd, e, &mdia]),
        None => bx(b"trak", &[&p.tkhd, &mdia]),
    }
}

fn vmhd() -> Vec<u8> {
    bx(b"vmhd", &[&[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]])
}
fn smhd() -> Vec<u8> {
    bx(b"smhd", &[&[0; 8]])
}
fn table32(rows: &[[u32; 2]]) -> Vec<u8> {
    let mut b = vec![0u8; 4];
    b.extend_from_slice(&(rows.len() as u32).to_be_bytes());
    for r in rows {
        b.extend_from_slice(&r[0].to_be_bytes());
        b.extend_from_slice(&r[1].to_be_bytes());
    }
    b
}

// The relay refuses sound with no picture, so sound gets one still black frame, shown for as long as the sound lasts.
// 640x360 Constrained Baseline, encoded once with:
//   ffmpeg -f lavfi -i color=black:s=640x360:r=1:d=1 -frames:v 1 -c:v libx264 -profile:v baseline -level 3.0 -preset veryslow
const STILL_WIDTH: u16 = 640;
const STILL_HEIGHT: u16 = 360;
const STILL_AVCC: &[u8] = include_bytes!("still_avcc.bin");
/// The frame, length-prefixed as `avcC` says (4 bytes).
const STILL_SAMPLE: &[u8] = include_bytes!("still_frame.bin");

fn still_frame_track(id: u32, movie_timescale: u32, movie_duration: u64) -> Planned {
    let mut entry = vec![0u8; 78];
    entry[7] = 1;
    entry[24..26].copy_from_slice(&STILL_WIDTH.to_be_bytes());
    entry[26..28].copy_from_slice(&STILL_HEIGHT.to_be_bytes());
    entry[28..32].copy_from_slice(&0x0048_0000u32.to_be_bytes());
    entry[32..36].copy_from_slice(&0x0048_0000u32.to_be_bytes());
    entry[40..42].copy_from_slice(&1u16.to_be_bytes());
    entry[74..76].copy_from_slice(&24u16.to_be_bytes());
    entry[76..78].copy_from_slice(&0xffffu16.to_be_bytes());
    entry.extend_from_slice(&bx(b"avcC", &[STILL_AVCC]));
    let mut head = vec![0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0];
    head.extend_from_slice(&id.to_be_bytes());
    head.extend_from_slice(&[0; 4]);
    head.extend_from_slice(
        &u32::try_from(movie_duration)
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    head.extend_from_slice(&[0; 16]);
    head.extend_from_slice(&IDENTITY);
    head.extend_from_slice(&(u32::from(STILL_WIDTH) << 16).to_be_bytes());
    head.extend_from_slice(&(u32::from(STILL_HEIGHT) << 16).to_be_bytes());
    Planned {
        stsd_entry: bx(b"avc1", &[&entry]),
        handler: *b"vide",
        tkhd: bx(b"tkhd", &[&head]),
        edts: None,
        timescale: movie_timescale,
        media_duration: movie_duration,
        head: vmhd(),
        stts: table32(&[[1, u32::try_from(movie_duration).unwrap_or(u32::MAX)]]),
        ctts: None,
        stss: None,
        stsc: {
            let mut b = vec![0u8; 4];
            b.extend_from_slice(&1u32.to_be_bytes());
            for v in [1u32, 1, 1] {
                b.extend_from_slice(&v.to_be_bytes());
            }
            b
        },
        stsz: stsz_body(&[STILL_SAMPLE.len() as u32]),
        groups: vec![],
    }
}

fn scale(value: u64, to: u32, from: u32) -> u64 {
    if from == 0 {
        return 0;
    }
    u64::try_from(u128::from(value) * u128::from(to) / u128::from(from)).unwrap_or(u64::MAX)
}

/// An edit list for a flat copy of a fragmented track, and the track's length with it: wait for the track's start and any
/// empty edits it opened with (how a recorder says the sound starts late), then play from where its own edit list said
/// (past an encoder's lead-in) to the end. Rounds up: a length rounded down would cut the last frame short.
fn fragment_edits(
    source: Option<&[u8]>,
    delay: u64,
    track_start: u64,
    shown_until: u64,
    movie_timescale: u32,
    media_timescale: u32,
) -> (Option<Vec<u8>>, u64) {
    let mut delay = delay;
    let mut media_time = 0i64;
    if let Some(e) = source {
        let v1 = e.first() == Some(&1);
        let step = if v1 { 20 } else { 12 };
        for i in 0..be32(e, 4).unwrap_or(0) as usize {
            let at = 8 + i * step;
            let row = if v1 {
                be64(e, at).zip(be64(e, at + 8).map(|t| t as i64))
            } else {
                be32(e, at)
                    .map(u64::from)
                    .zip(be32(e, at + 4).map(|t| i64::from(t as i32)))
            };
            match row {
                Some((length, -1)) => delay = delay.saturating_add(length),
                Some((_, time)) if time >= 0 => {
                    media_time = time;
                    break;
                }
                _ => break,
            }
        }
    }
    // Here the track's first sample is at zero, whatever its clock said in the source.
    let media_time = (media_time as u64).saturating_sub(track_start) as i64;
    let played = shown_until.saturating_sub(media_time as u64);
    let length = u64::try_from(
        (u128::from(played) * u128::from(movie_timescale))
            .div_ceil(u128::from(media_timescale.max(1))),
    )
    .unwrap_or(u64::MAX);
    if delay == 0 && media_time == 0 {
        return (None, length);
    }
    let mut rows: Vec<(u64, i64)> = Vec::new();
    if delay > 0 {
        rows.push((delay, -1));
    }
    rows.push((length, media_time));
    let mut b = vec![1u8, 0, 0, 0];
    b.extend_from_slice(&(rows.len() as u32).to_be_bytes());
    for (d, t) in rows {
        b.extend_from_slice(&d.to_be_bytes());
        b.extend_from_slice(&t.to_be_bytes());
        b.extend_from_slice(&[0, 1, 0, 0]);
    }
    (
        Some(bx(b"edts", &[&bx(b"elst", &[&b])])),
        delay.saturating_add(length),
    )
}

// ── The rewrite ─────────────────────────────────────────────────────────
/// Write `out` from `input`. `None`: there is no `moov`, and no `ftyp` claims this is media, so it's an ordinary file.
pub(super) fn rewrite(input: &Path, size: u64, out: &Path) -> Result<Option<Rewritten>> {
    // No read buffer: a seek throws it away, and a fragmented file has a box header to read per fragment.
    let mut f = std::fs::File::open(input).map_err(io_failed)?;
    let mut unreadable_tail = false;
    let boxes = top_level(&mut f, size, &mut unreadable_tail)?;
    let ftyp_box = boxes.iter().find(|b| &b.kind == b"ftyp");
    if let Some(b) = ftyp_box {
        let body = read_box(&mut f, b)?;
        if let Some(line) = still_image_brand(&body) {
            return Err(refuse(line));
        }
    }
    let Some(moov_box) = boxes.iter().find(|b| &b.kind == b"moov") else {
        let Some(b) = ftyp_box else { return Ok(None) };
        return Err(if lists_still_image_brand(&read_box(&mut f, b)?) {
            refuse(STILL_IMAGE_LINE)
        } else {
            damaged()
        });
    };
    let moov = read_box(&mut f, moov_box)?;
    if !is_whole(&moov) {
        return Err(damaged());
    }
    let mvhd_src = child(&moov, b"mvhd").ok_or_else(damaged)?;
    let movie_timescale = be32(mvhd_src, if mvhd_src.first() == Some(&1) { 20 } else { 12 })
        .filter(|t| *t != 0)
        .ok_or_else(damaged)?;
    let fragmented = boxes.iter().any(|b| &b.kind == b"moof");
    if fragmented && unreadable_tail {
        return Err(damaged());
    }

    let mut tracks: Vec<Track<'_>> = Vec::new();
    for (kind, body) in children(&moov) {
        if kind == b"trak" {
            if let Some(t) = parse_track(body, size)? {
                tracks.push(t);
            }
        }
    }

    let mut starts: Vec<(u32, u64)> = Vec::new();
    let mut shown: Vec<(u32, u64)> = Vec::new();
    if fragmented {
        // Tables come from the fragments. Read them for the tracks that could be kept, then decide.
        let mvex = child(&moov, b"mvex").ok_or_else(damaged)?;
        let trex: Vec<(u32, (u32, u32, u32))> = children(mvex)
            .into_iter()
            .filter(|(k, _)| *k == b"trex")
            .filter_map(|(_, t)| Some((be32(t, 4)?, (be32(t, 12)?, be32(t, 16)?, be32(t, 20)?))))
            .collect();
        // A default of another description would point at an entry this rewrite doesn't write. Refused for any track, since
        // nothing real does this.
        let default_description = |t: &[u8]| be32(t, 8).is_some_and(|d| d != 1);
        if children(mvex)
            .iter()
            .any(|(k, t)| *k == b"trex" && default_description(t))
        {
            return Err(refuse(
                "This video changes format partway through, so it can't be sent as it is.",
            ));
        }
        let trex_of = |id: u32| trex.iter().find(|(t, _)| *t == id).map(|(_, v)| *v);
        let mut frags: Vec<(u32, Fragments)> = tracks
            .iter()
            .map(|t| Ok((t.id, fragments_from_flat(&t.tables)?)))
            .collect::<Result<_>>()?;
        read_fragments(&mut f, &boxes, &trex_of, &mut frags, size)?;
        for (t, (_, frag)) in tracks.iter_mut().zip(&frags) {
            // A track the relay can't take has no tables to fill in; its sample count is all a refusal needs.
            if !frag.sizes.is_empty() {
                t.tables = tables_from_fragments(frag, &t.handler);
                t.duration = frag.durations.iter().map(|d| u64::from(*d)).sum();
            }
            starts.push((t.id, frag.start.unwrap_or(0)));
            shown.push((t.id, frag.shown_until()));
        }
    }

    let (picture, sound) = choose(&tracks)?;
    let audio_only = picture.is_none();

    // The relay's limits, on the numbers it reads: each kept track's media header, the longer one deciding. One frame
    // over sound (the still frame added below, or a picture that is one frame already) is audio; more is video.
    let secs_of = |t: &Track<'_>| -> Result<f64> {
        if t.timescale == 0 {
            return Err(damaged());
        }
        // The relay's arithmetic: milliseconds, rounded down, from the media header.
        let millis = u128::from(t.duration) * 1000 / u128::from(t.timescale);
        Ok(millis as f64 / 1000.0)
    };
    // Picture first, so the first length is the one that must be above zero.
    let secs: Vec<f64> = [picture, sound].into_iter().flatten().map(secs_of).collect::<Result<_>>()?;
    if let Some(first) = secs.first() {
        if *first <= 0.0 {
            return Err(damaged());
        }
        let longest = secs.iter().copied().fold(0.0, f64::max);
        let is_audio = sound.is_some() && picture.is_none_or(|p| p.tables.samples == 1);
        if is_audio && longest > MAX_AUDIO_SECONDS {
            return Err(audio_too_long(longest, MAX_AUDIO_SECONDS));
        }
        if !is_audio && longest > MAX_VIDEO_SECONDS {
            return Err(video_too_long(longest));
        }
    }
    if let Some(p) = picture {
        let (w, h) = (
            be16(p.entry, 24).ok_or_else(damaged)?,
            be16(p.entry, 26).ok_or_else(damaged)?,
        );
        if u32::from(w) > MAX_VIDEO_WIDTH || u32::from(h) > MAX_VIDEO_HEIGHT {
            return Err(refuse(format!("This video is {w}x{h}; Buzz takes up to {MAX_VIDEO_WIDTH}x{MAX_VIDEO_HEIGHT} (wide, not tall). Scale it down, then attach it again.")));
        }
    }

    // Plan the kept tracks, picture first.
    let kept: Vec<&Track<'_>> = picture.into_iter().chain(sound).collect();
    let earliest = kept
        .iter()
        .filter_map(|t| {
            starts
                .iter()
                .find(|(id, _)| *id == t.id)
                .map(|(_, s)| scale(*s, movie_timescale, t.timescale))
        })
        .min()
        .unwrap_or(0);
    let mut planned: Vec<Planned> = Vec::new();
    let mut lengths: Vec<u64> = Vec::new();
    let mut used_ids: Vec<u32> = Vec::new();
    for t in &kept {
        if t.timescale == 0 {
            return Err(damaged());
        }
        // Track id 0 is illegal, and two tracks with one id collapse into one in the relay's parser.
        let id = if t.id == 0 || used_ids.contains(&t.id) {
            kept.iter().map(|k| k.id).max().unwrap_or(0) + 1 + used_ids.len() as u32
        } else {
            t.id
        };
        used_ids.push(id);
        let movie_length = scale(t.duration, movie_timescale, t.timescale);
        let (duration, edts) = if fragmented {
            let start = starts
                .iter()
                .find(|(i, _)| *i == t.id)
                .map_or(0, |(_, s)| scale(*s, movie_timescale, t.timescale));
            let (edits, length) = fragment_edits(
                t.elst.as_deref(),
                start.saturating_sub(earliest),
                starts
                    .iter()
                    .find(|(i, _)| *i == t.id)
                    .map_or(0, |(_, s)| *s),
                shown
                    .iter()
                    .find(|(i, _)| *i == t.id)
                    .map_or(t.duration, |(_, s)| *s),
                movie_timescale,
                t.timescale,
            );
            (length, edits)
        } else {
            let declared = tkhd_duration(t.tkhd).unwrap_or(0);
            (
                if declared > 0 { declared } else { movie_length },
                t.elst.as_ref().map(|e| bx(b"edts", &[&bx(b"elst", &[e])])),
            )
        };
        lengths.push(duration);
        let (entry, head) = if &t.handler == b"vide" {
            (avc1(t.entry)?, vmhd())
        } else {
            (mp4a(t.entry, t.timescale)?, smhd())
        };
        planned.push(Planned {
            stsd_entry: entry,
            handler: t.handler,
            tkhd: tkhd(t.tkhd, id, duration)?,
            edts,
            timescale: t.timescale,
            media_duration: t.duration,
            head,
            stts: t.tables.stts.clone(),
            ctts: t.tables.ctts.clone(),
            stss: t.tables.stss.clone(),
            stsc: t.tables.stsc.clone(),
            stsz: t.tables.stsz.clone(),
            groups: t.tables.groups.clone(),
        });
    }
    let movie_duration = lengths.iter().copied().max().unwrap_or(0);
    if movie_duration == 0 {
        return Err(damaged());
    }
    // The still frame lasts as long as the movie, lead-in included, and that's what the relay measures.
    if audio_only
        && u128::from(movie_duration) * 1000 / u128::from(movie_timescale)
            > MAX_AUDIO_SECONDS as u128 * 1000
    {
        return Err(audio_too_long(movie_duration as f64 / f64::from(movie_timescale), MAX_AUDIO_SECONDS));
    }
    let still = audio_only.then(|| {
        let id = used_ids.iter().max().copied().unwrap_or(0) + 1;
        used_ids.push(id);
        still_frame_track(id, movie_timescale, movie_duration)
    });

    // The chunks to copy, in the order they sit in the source, so the interleave stays as it was.
    let mut order: Vec<(usize, usize, Chunk)> = Vec::new();
    for (ti, t) in kept.iter().enumerate() {
        for (ci, c) in t.tables.chunks.iter().enumerate() {
            order.push((ti, ci, *c));
        }
    }
    order.sort_by_key(|(ti, ci, c)| (c.from, *ti, *ci));
    let still_len = if still.is_some() {
        STILL_SAMPLE.len() as u64
    } else {
        0
    };
    let media_len: u64 = still_len + order.iter().map(|(_, _, c)| c.len).sum::<u64>();

    let build_moov = |base: u64| -> Vec<u8> {
        let mut offsets: Vec<Vec<u32>> = planned
            .iter()
            .enumerate()
            .map(|(i, _)| vec![0; kept[i].tables.chunks.len()])
            .collect();
        let mut at = base + still_len;
        for (ti, ci, c) in &order {
            offsets[*ti][*ci] = at as u32;
            at += c.len;
        }
        let next_track = used_ids.iter().max().copied().unwrap_or(0) + 1;
        let mut parts = vec![mvhd(mvhd_src, movie_timescale, movie_duration, next_track)];
        if let Some(s) = &still {
            parts.push(trak(s, &[base as u32]));
        }
        for (p, o) in planned.iter().zip(&offsets) {
            parts.push(trak(p, o));
        }
        let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
        bx(b"moov", &refs)
    };
    let type_box = ftyp();
    let moov_len = build_moov(0).len() as u64;
    let total = type_box.len() as u64 + moov_len + 8 + media_len;
    if total > MAX_VIDEO_BYTES {
        return Err(refuse(format!(
            "This video is {}; Buzz takes up to {}. Trim it, then attach it again.",
            megabytes(total),
            megabytes(MAX_VIDEO_BYTES)
        )));
    }
    let base = type_box.len() as u64 + moov_len + 8;
    let new_moov = build_moov(base);
    debug_assert_eq!(new_moov.len() as u64, moov_len);

    let mut w =
        BufWriter::with_capacity(1024 * 1024, std::fs::File::create(out).map_err(io_failed)?);
    w.write_all(&type_box).map_err(io_failed)?;
    w.write_all(&new_moov).map_err(io_failed)?;
    w.write_all(&((media_len + 8) as u32).to_be_bytes())
        .map_err(io_failed)?;
    w.write_all(b"mdat").map_err(io_failed)?;
    if still.is_some() {
        w.write_all(STILL_SAMPLE).map_err(io_failed)?;
    }
    let mut src = f;
    for (_, _, c) in &order {
        src.seek(SeekFrom::Start(c.from)).map_err(io_failed)?;
        let copied = std::io::copy(&mut (&mut src).take(c.len), &mut w).map_err(io_failed)?;
        if copied != c.len {
            return Err(damaged());
        }
    }
    w.flush().map_err(io_failed)?;
    Ok(Some(Rewritten { audio_only }))
}

const STILL_IMAGE_LINE: &str = "This photo is HEIC or AVIF, and Buzz only takes JPEG, PNG, GIF or WebP. Convert it, then attach it again.";

/// Whether a file with no `moov` names a still-image format among its other brands, after the 8 bytes of major and minor.
fn lists_still_image_brand(ftyp_body: &[u8]) -> bool {
    ftyp_body.get(8..).is_some_and(|brands| {
        brands
            .chunks_exact(4)
            .any(|b| still_image_brand(b).is_some())
    })
}

/// Still-image formats share this container. The relay refuses them, and they have no `moov` to find.
fn still_image_brand(ftyp_body: &[u8]) -> Option<&'static str> {
    match ftyp_body.get(..4)? {
        b"heic" | b"heix" | b"heim" | b"heis" | b"hevc" | b"hevx" | b"hevm" | b"hevs" | b"mif1"
        | b"msf1" | b"avif" | b"avis" => Some(STILL_IMAGE_LINE),
        _ => None,
    }
}
