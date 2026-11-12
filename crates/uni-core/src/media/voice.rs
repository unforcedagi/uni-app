//! A recording on its way to the relay, made into what stock Buzz takes: AAC, in parts of at most 9:50.
//!
//! The recorder (and the journal) keeps WebM with Opus, which Buzz refuses. On the upload path only, the Opus is decoded
//! and encoded as AAC with the platform's own codecs ([`Codecs`]); nothing is bundled. Two passes over the file, from disk:
//! the first decodes to measure loudness every 20 ms and picks where to cut ([`cuts`]); the second decodes again and
//! encodes each part with its own encoder, so a part never depends on another and memory doesn't grow with length.
//! Each part is a plain M4A ([`m4a`]) that the normalizer then makes into the relay's shape, as it does any M4A.
//!
//! Where the platform has no codecs (a Mac or Linux build today) the recording goes as it is, as before.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::normalize::{damaged, io_failed, refuse};
use crate::Result;

pub mod cuts;
mod m4a;
mod webm;

#[cfg(target_os = "android")]
mod android;

pub use webm::OpusHead;

/// The longest part: under the relay's 600 s for a video track, with room to spare (Buzz's own limit, upstream).
pub const MAX_PART_SECONDS: f64 = 590.0;
/// A cut is looked for this far back from the limit.
pub const SEARCH_SECONDS: f64 = 120.0;
/// AAC bit rate for a mono voice note: clear speech, about 360 KB a minute.
pub const AAC_BITRATE: u32 = 48_000;
/// What an encoder adds before and after the sound (priming and the last frame's padding), kept clear of the limit.
const CODEC_SLACK_SECONDS: f64 = 0.25;
/// Parts one message can carry (the app's and Buzz's limit on attachments).
pub const MAX_PARTS: usize = super::MAX_IMETA_PER_MESSAGE;

/// The platform's audio codecs.
pub trait Codecs: Sync {
    /// An Opus decoder for this track, or `None` if the platform has none.
    fn opus_decoder(&self, head: &OpusHead) -> Result<Option<Box<dyn Decoder>>>;
    /// A mono AAC-LC encoder, or `None` if the platform has none.
    fn aac_encoder(&self, rate: u32, bitrate: u32) -> Result<Option<Box<dyn Encoder>>>;
}

pub trait Decoder {
    /// Decodes one packet, or with `None` everything still held, appending mono samples to `pcm`.
    fn decode(&mut self, packet: Option<(&[u8], i64)>, pcm: &mut Vec<i16>) -> Result<()>;
    /// Samples a second in what comes out.
    fn rate(&self) -> u32;
}

pub trait Encoder {
    /// Encodes mono samples, or with `None` everything still held, handing each AAC frame to `out`.
    fn encode(&mut self, pcm: Option<&[i16]>, out: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<()>;
    /// The AudioSpecificConfig, once the encoder has said it.
    fn config(&self) -> Option<Vec<u8>>;
}

/// This platform's codecs, if it has any this code can use.
pub fn platform_codecs() -> Option<&'static dyn Codecs> {
    #[cfg(target_os = "android")]
    {
        Some(&android::Android)
    }
    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

/// A part ready for the normalizer, in order.
#[derive(Debug)]
pub struct Part {
    pub path: PathBuf,
    pub seconds: f64,
}

/// What [`convert`] did, and what it saw.
#[derive(Debug)]
pub struct Converted {
    pub parts: Vec<Part>,
    /// Seconds of sound decoded.
    pub seconds: f64,
}

/// Removes files it holds unless told they're kept.
struct Remove(Vec<PathBuf>);
impl Drop for Remove {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Whether a file starts as a WebM (or Matroska) does.
pub fn is_webm(path: &Path) -> bool {
    use std::io::Read as _;
    let mut head = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && head == [0x1a, 0x45, 0xdf, 0xa3]
}

/// More than one message's parts would hold.
fn too_long(seconds: f64, max_part_seconds: f64) -> crate::Error {
    refuse(format!(
        "This recording is {} long; a message takes up to {MAX_PARTS} parts of {}, {} in all. Send it in pieces.",
        super::normalize::clock(seconds),
        super::normalize::clock(max_part_seconds),
        super::normalize::clock(max_part_seconds * MAX_PARTS as f64)
    ))
}

fn convert_failed() -> crate::Error {
    refuse("Couldn't convert this recording on this device. Retry.")
}

fn stopped() -> crate::Error {
    refuse("Upload stopped.")
}

/// Opus in a WebM, as AAC parts of at most `max_part_seconds` in `work_dir`, cut at pauses. `Ok(None)`: this platform
/// can't decode or encode, and the recording should go as it is. `stop` set ends it early (the upload was dropped), and
/// whatever it had made goes.
pub fn convert(input: &Path, work_dir: &Path, codecs: &dyn Codecs, max_part_seconds: f64, stop: &AtomicBool) -> Result<Option<Converted>> {
    std::fs::create_dir_all(work_dir).map_err(io_failed)?;
    // Pass 1: loudness every step, and the cuts.
    let mut packets = webm::Packets::open(input)?;
    let Some(mut decoder) = codecs.opus_decoder(&packets.head)? else { return Ok(None) };
    // A decoder alone is no use: see that there's an encoder before any of the work.
    if codecs.aac_encoder(decoder.rate(), AAC_BITRATE)?.is_none() {
        return Ok(None);
    }
    let max_steps = ((max_part_seconds - CODEC_SLACK_SECONDS) / cuts::STEP_SECONDS).floor() as usize;
    let mut pcm = Vec::with_capacity(8192);
    let mut steps: Vec<f32> = Vec::new();
    let mut step: Vec<i16> = Vec::with_capacity(2048);
    let mut total: u64 = 0;
    let mut step_len = 0usize;
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err(stopped());
        }
        // Longer than every part a message can carry: no point decoding the rest.
        if steps.len() > max_steps * MAX_PARTS {
            return Err(too_long(steps.len() as f64 * cuts::STEP_SECONDS, max_part_seconds));
        }
        let packet = packets.next_packet()?;
        decoder.decode(packet.as_ref().map(|p| (&p.data[..], p.time_us)), &mut pcm)?;
        if step_len == 0 && !pcm.is_empty() {
            step_len = (f64::from(decoder.rate()) * cuts::STEP_SECONDS).round().max(1.0) as usize;
        }
        total += pcm.len() as u64;
        for s in pcm.drain(..) {
            step.push(s);
            if step.len() == step_len {
                steps.push(cuts::loudness_db(&step));
                step.clear();
            }
        }
        if packet.is_none() {
            break;
        }
    }
    if !step.is_empty() {
        steps.push(cuts::loudness_db(&step));
    }
    if total == 0 {
        return Err(damaged());
    }
    let rate = decoder.rate();
    drop(decoder);
    let seconds = total as f64 / f64::from(rate);
    let search_steps = (SEARCH_SECONDS / cuts::STEP_SECONDS).round() as usize;
    let cut_at: Vec<u64> =
        cuts::choose(&steps, max_steps, search_steps).into_iter().map(|c| c as u64 * step_len as u64).collect();
    if cut_at.len() + 1 > MAX_PARTS {
        return Err(too_long(seconds, max_part_seconds));
    }

    // Pass 2: decode again, one encoder and one file per part.
    let mut packets = webm::Packets::open(input)?;
    let mut decoder = codecs.opus_decoder(&packets.head)?.ok_or_else(convert_failed)?;
    let stem = format!("voice-{}", uuid::Uuid::new_v4().simple());
    let mut made = Remove(Vec::new());
    let mut parts = Vec::new();
    let mut part = Writing::start(work_dir.join(format!("{stem}-1.m4a")), rate, codecs, &mut made)?;
    let mut at: u64 = 0;
    let mut next = 0usize;
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err(stopped());
        }
        let packet = packets.next_packet()?;
        decoder.decode(packet.as_ref().map(|p| (&p.data[..], p.time_us)), &mut pcm)?;
        let mut rest = &pcm[..];
        while !rest.is_empty() {
            let take = cut_at.get(next).map_or(rest.len(), |c| rest.len().min((c - at) as usize));
            part.encode(&rest[..take])?;
            at += take as u64;
            rest = &rest[take..];
            if cut_at.get(next) == Some(&at) {
                next += 1;
                let following = Writing::start(work_dir.join(format!("{stem}-{}.m4a", next + 1)), rate, codecs, &mut made)?;
                parts.push(std::mem::replace(&mut part, following).finish(max_part_seconds)?);
            }
        }
        pcm.clear();
        if packet.is_none() {
            break;
        }
    }
    parts.push(part.finish(max_part_seconds)?);
    made.0.clear(); // every part made it: the caller has them now
    Ok(Some(Converted { parts, seconds }))
}

/// One part being encoded.
struct Writing {
    path: PathBuf,
    writer: m4a::M4aWriter,
    encoder: Box<dyn Encoder>,
}

impl Writing {
    fn start(path: PathBuf, rate: u32, codecs: &dyn Codecs, made: &mut Remove) -> Result<Self> {
        made.0.push(path.clone());
        let writer = m4a::M4aWriter::create(&path, rate, 1)?;
        let encoder = codecs.aac_encoder(rate, AAC_BITRATE)?.ok_or_else(convert_failed)?;
        Ok(Writing { path, writer, encoder })
    }

    fn encode(&mut self, pcm: &[i16]) -> Result<()> {
        let writer = &mut self.writer;
        self.encoder.encode(Some(pcm), &mut |f| writer.frame(f))
    }

    fn finish(mut self, max_part_seconds: f64) -> Result<Part> {
        let writer = &mut self.writer;
        self.encoder.encode(None, &mut |f| writer.frame(f))?;
        let config = self.encoder.config().ok_or_else(convert_failed)?;
        let seconds = self.writer.seconds();
        // The cuts leave room for the codec's own additions, so either of these is a fault, not a long recording.
        if self.writer.frames() == 0 || seconds > max_part_seconds {
            return Err(convert_failed());
        }
        self.writer.finish(&config, AAC_BITRATE)?;
        Ok(Part { path: self.path, seconds })
    }
}

/// Stand-ins for the platform's codecs (outside this code's control, and absent on the machines tests run on), and
/// recordings shaped as a browser's MediaRecorder writes them.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// "Decodes" a packet `[0xfc, level_hi, level_lo]` (one 20 ms Opus frame by its TOC byte) into 960 samples swinging
    /// to ±level; "encodes" every 1024 samples into a 6-byte frame, after two frames of priming, as an AAC encoder does.
    pub struct FakeCodecs;
    pub static FAKE: FakeCodecs = FakeCodecs;
    struct FakeDecoder;
    struct FakeEncoder {
        held: usize,
        started: bool,
    }

    impl Codecs for FakeCodecs {
        fn opus_decoder(&self, head: &OpusHead) -> Result<Option<Box<dyn Decoder>>> {
            assert!(head.bytes.starts_with(b"OpusHead"));
            Ok(Some(Box::new(FakeDecoder)))
        }
        fn aac_encoder(&self, rate: u32, _bitrate: u32) -> Result<Option<Box<dyn Encoder>>> {
            assert_eq!(rate, 48_000);
            Ok(Some(Box::new(FakeEncoder { held: 0, started: false })))
        }
    }
    impl Decoder for FakeDecoder {
        fn decode(&mut self, packet: Option<(&[u8], i64)>, pcm: &mut Vec<i16>) -> Result<()> {
            if let Some((p, _)) = packet {
                let level = i16::from_be_bytes([p[1], p[2]]);
                pcm.extend((0..960).map(|i| if i % 2 == 0 { level } else { -level }));
            }
            Ok(())
        }
        fn rate(&self) -> u32 {
            48_000
        }
    }
    impl Encoder for FakeEncoder {
        fn encode(&mut self, pcm: Option<&[i16]>, out: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<()> {
            const FRAME: [u8; 6] = [0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c];
            if !self.started {
                self.started = true;
                out(&FRAME)?;
                out(&FRAME)?;
            }
            match pcm {
                Some(p) => {
                    self.held += p.len();
                    while self.held >= 1024 {
                        self.held -= 1024;
                        out(&FRAME)?;
                    }
                }
                None if self.held > 0 => {
                    self.held = 0;
                    out(&FRAME)?;
                }
                None => {}
            }
            Ok(())
        }
        fn config(&self) -> Option<Vec<u8>> {
            Some(vec![0x11, 0x88]) // AAC-LC, 48 kHz, mono
        }
    }

    fn put(out: &mut Vec<u8>, id: &[u8], body: &[u8]) {
        out.extend_from_slice(id);
        out.push(0x01);
        out.extend_from_slice(&(body.len() as u64).to_be_bytes()[1..]);
        out.extend_from_slice(body);
    }
    fn unknown(out: &mut Vec<u8>, id: &[u8]) {
        out.extend_from_slice(id);
        out.extend_from_slice(&[0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    }

    /// A WebM with one Opus packet per 20 ms at each loudness in `levels`, its segment and clusters of unknown size.
    pub fn webm(levels: &[i16]) -> Vec<u8> {
        let mut f = Vec::new();
        let mut ebml = Vec::new();
        put(&mut ebml, &[0x42, 0x82], b"webm");
        put(&mut f, &[0x1a, 0x45, 0xdf, 0xa3], &ebml);
        unknown(&mut f, &[0x18, 0x53, 0x80, 0x67]);
        let mut info = Vec::new();
        put(&mut info, &[0x2a, 0xd7, 0xb1], &1_000_000u32.to_be_bytes());
        put(&mut f, &[0x15, 0x49, 0xa9, 0x66], &info);
        let mut entry = Vec::new();
        put(&mut entry, &[0xd7], &[1]);
        put(&mut entry, &[0x83], &[2]);
        put(&mut entry, &[0x86], b"A_OPUS");
        put(&mut entry, &[0x63, 0xa2], b"OpusHead\x01\x01\x38\x01\x80\xbb\0\0\0\0\0");
        let mut tracks = Vec::new();
        put(&mut tracks, &[0xae], &entry);
        put(&mut f, &[0x16, 0x54, 0xae, 0x6b], &tracks);
        for (c, levels) in levels.chunks(50).enumerate() {
            unknown(&mut f, &[0x1f, 0x43, 0xb6, 0x75]);
            put(&mut f, &[0xe7], &(c as u32 * 1000).to_be_bytes());
            for (i, level) in levels.iter().enumerate() {
                let mut block = vec![0x81];
                block.extend_from_slice(&(i as i16 * 20).to_be_bytes());
                block.push(0x80);
                block.push(0xfc);
                block.extend_from_slice(&level.to_be_bytes());
                put(&mut f, &[0xa3], &block);
            }
        }
        f
    }

    /// Talk (loud) and pauses (near silence), as (seconds, talking) runs: one level per 20 ms.
    pub fn speech(runs: &[(f64, bool)]) -> Vec<i16> {
        runs.iter().flat_map(|(s, talk)| std::iter::repeat_n(if *talk { 8000 } else { 30 }, (s / 0.02).round() as usize)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    /// Each part as the relay's parser reads it once normalized: (picture track's length, sound track's length).
    fn normalized_lengths(path: &Path, name: &str, dir: &Path) -> (f64, f64) {
        let n = super::super::normalize::normalize_file(path, name, dir).unwrap();
        assert!(n.filename.ends_with(".m4a"), "{}", n.filename);
        let bytes = std::fs::read(&n.path).unwrap();
        let mp4 = mp4::Mp4Reader::read_header(std::io::Cursor::new(&bytes), bytes.len() as u64).unwrap();
        let (mut video, mut audio) = (0.0, 0.0);
        for t in mp4.tracks().values() {
            let secs = t.duration().as_millis() as f64 / 1000.0;
            match t.track_type().unwrap() {
                mp4::TrackType::Video => video = secs,
                mp4::TrackType::Audio => audio = secs,
                _ => panic!("extra track"),
            }
        }
        (video, audio)
    }

    #[test]
    fn a_long_recording_is_cut_at_its_pauses_into_parts_the_relay_takes() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("rec.webm");
        // 21 minutes: pauses at 8:20 and 17:30 (each a second), talk everywhere else, so two cuts, each in a pause and
        // not at 9:50 mid-word.
        let runs = [(500.0, true), (1.0, false), (549.0, true), (1.0, false), (209.0, true)];
        std::fs::write(&input, webm(&speech(&runs))).unwrap();
        let out = convert(&input, dir.path(), &FAKE, MAX_PART_SECONDS, &AtomicBool::new(false)).unwrap().unwrap();
        assert!((out.seconds - 1260.0).abs() < 0.01, "{}", out.seconds);
        let ends: Vec<f64> = out.parts.iter().scan(0.0, |at, p| { *at += p.seconds; Some(*at) }).collect();
        assert_eq!(out.parts.len(), 3, "{ends:?}");
        // Each part also carries its encoder's priming (two frames here), so a cut is found within 0.1 s of its pause.
        assert!((500.0..501.2).contains(&ends[0]), "first cut ends part 1 at {}", ends[0]);
        assert!((1050.0..1051.3).contains(&ends[1]), "second cut ends part 2 at {}", ends[1]);
        for (k, p) in out.parts.iter().enumerate() {
            assert!(p.seconds <= MAX_PART_SECONDS, "part {k} is {} s", p.seconds);
            let (video, audio) = normalized_lengths(&p.path, &format!("{} of 3 · rec.m4a", k + 1), dir.path());
            // Stock Buzz measures the still frame; it lasts as long as the sound.
            assert!((video - p.seconds).abs() < 0.01 && (audio - p.seconds).abs() < 0.01, "{video} {audio} {}", p.seconds);
            assert!(video <= 600.0);
        }
    }

    #[test]
    fn a_recording_without_pauses_still_fits_and_a_short_one_is_one_part() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("rec.webm");
        std::fs::write(&input, webm(&speech(&[(1200.0, true)]))).unwrap();
        let out = convert(&input, dir.path(), &FAKE, MAX_PART_SECONDS, &AtomicBool::new(false)).unwrap().unwrap();
        assert_eq!(out.parts.len(), 3);
        assert!(out.parts.iter().all(|p| p.seconds <= MAX_PART_SECONDS));
        std::fs::write(&input, webm(&speech(&[(3.0, true), (1.0, false), (3.0, true)]))).unwrap();
        let out = convert(&input, dir.path(), &FAKE, MAX_PART_SECONDS, &AtomicBool::new(false)).unwrap().unwrap();
        assert_eq!(out.parts.len(), 1);
    }

    #[test]
    fn a_dropped_upload_stops_the_conversion_and_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("rec.webm");
        std::fs::write(&input, webm(&speech(&[(30.0, true)]))).unwrap();
        let err = convert(&input, dir.path(), &FAKE, MAX_PART_SECONDS, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err.to_string(), "Upload stopped.");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_damaged_recording_is_refused_and_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("rec.webm");
        let whole = webm(&speech(&[(30.0, true)]));
        let tracks_end = whole.windows(4).position(|w| w == [0x1f, 0x43, 0xb6, 0x75]).unwrap();
        std::fs::write(&input, &whole[..tracks_end - 6]).unwrap(); // inside the track: no whole Opus head
        assert!(convert(&input, dir.path(), &FAKE, MAX_PART_SECONDS, &AtomicBool::new(false)).is_err());
        // A recorder killed partway keeps what it wrote: half a block at the end is dropped, not the recording.
        std::fs::write(&input, &whole[..whole.len() - 3]).unwrap();
        let out = convert(&input, dir.path(), &FAKE, MAX_PART_SECONDS, &AtomicBool::new(false)).unwrap().unwrap();
        assert!((out.seconds - 29.98).abs() < 0.001, "{}", out.seconds);
        for p in out.parts {
            std::fs::remove_file(p.path).unwrap();
        }
        let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("rec.webm")]);
    }
}
