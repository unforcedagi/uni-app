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

fn convert_failed() -> crate::Error {
    refuse("Couldn't convert this recording on this device. Retry.")
}

/// Opus in a WebM, as AAC parts of at most `max_part_seconds` in `work_dir`, cut at pauses. `Ok(None)`: this platform
/// can't decode or encode, and the recording should go as it is.
pub fn convert(input: &Path, work_dir: &Path, codecs: &dyn Codecs, max_part_seconds: f64) -> Result<Option<Converted>> {
    std::fs::create_dir_all(work_dir).map_err(io_failed)?;
    // Pass 1: loudness every step, and the cuts.
    let mut packets = webm::Packets::open(input)?;
    let Some(mut decoder) = codecs.opus_decoder(&packets.head)? else { return Ok(None) };
    let mut pcm = Vec::with_capacity(8192);
    let mut steps: Vec<f32> = Vec::new();
    let mut step: Vec<i16> = Vec::with_capacity(2048);
    let mut total: u64 = 0;
    let mut step_len = 0usize;
    loop {
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
    let max_steps = ((max_part_seconds - CODEC_SLACK_SECONDS) / cuts::STEP_SECONDS).floor() as usize;
    let search_steps = (SEARCH_SECONDS / cuts::STEP_SECONDS).round() as usize;
    let cut_at: Vec<u64> =
        cuts::choose(&steps, max_steps, search_steps).into_iter().map(|c| c as u64 * step_len as u64).collect();
    if cut_at.len() + 1 > MAX_PARTS {
        return Err(refuse(format!(
            "This recording is {} long; a message takes up to {MAX_PARTS} parts of {}, {} in all. Send it in pieces.",
            super::normalize::clock(seconds),
            super::normalize::clock(max_part_seconds),
            super::normalize::clock(max_part_seconds * MAX_PARTS as f64)
        )));
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
