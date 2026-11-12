//! Android's own codecs, through the NDK's `AMediaCodec` (libmediandk): the Opus decoder every Android has had since 5.0,
//! and the AAC encoder the compatibility rules require of handhelds (CDD 5.1). Run synchronously: queue what fits, take
//! what's ready, and on the end of the stream wait for the codec to say it has given everything back.
use std::time::Duration;

use ndk::media::media_codec::{
    DequeuedInputBufferResult, DequeuedOutputBufferInfoResult, MediaCodec, MediaCodecDirection,
};
use ndk::media::media_format::MediaFormat;

use super::{Codecs, Decoder, Encoder, OpusHead};
use crate::media::normalize::refuse;
use crate::Result;

const END_OF_STREAM: u32 = 4; // AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM
const CODEC_CONFIG: u32 = 2; // AMEDIACODEC_BUFFER_FLAG_CODEC_CONFIG
const WAIT: Duration = Duration::from_millis(10);
/// A codec that hasn't moved for this long after the end was sent has stopped.
const DRAIN_LIMIT: Duration = Duration::from_secs(10);

pub struct Android;

fn failed() -> crate::Error {
    refuse("Couldn't convert this recording on this device. Retry.")
}

fn start(codec: Option<MediaCodec>, format: &MediaFormat, direction: MediaCodecDirection) -> Result<Option<MediaCodec>> {
    let Some(codec) = codec else { return Ok(None) };
    if codec.configure(format, None, direction).is_err() || codec.start().is_err() {
        tracing::warn!("voice: codec wouldn't start");
        return Ok(None);
    }
    Ok(Some(codec))
}

impl Codecs for Android {
    fn opus_decoder(&self, head: &OpusHead) -> Result<Option<Box<dyn Decoder>>> {
        let mut f = MediaFormat::new();
        f.set_str("mime", "audio/opus");
        f.set_i32("sample-rate", 48_000);
        f.set_i32("channel-count", i32::from(head.channels));
        // As MediaExtractor hands them over: the OpusHead, the pre-skip and the seek pre-roll, in nanoseconds.
        f.set_buffer("csd-0", &head.bytes);
        f.set_buffer("csd-1", &(i64::from(head.pre_skip) * 1_000_000_000 / 48_000).to_le_bytes());
        f.set_buffer("csd-2", &80_000_000i64.to_le_bytes());
        let codec = start(MediaCodec::from_decoder_type("audio/opus"), &f, MediaCodecDirection::Decoder)?;
        Ok(codec.map(|codec| Box::new(Codec { codec, rate: 48_000, channels: usize::from(head.channels), config: None, ended: false, fed: 0, whole_input: true }) as Box<dyn Decoder>))
    }

    fn aac_encoder(&self, rate: u32, bitrate: u32) -> Result<Option<Box<dyn Encoder>>> {
        let mut f = MediaFormat::new();
        f.set_str("mime", "audio/mp4a-latm");
        f.set_i32("sample-rate", rate as i32);
        f.set_i32("channel-count", 1);
        f.set_i32("aac-profile", 2); // AACObjectLC
        f.set_i32("bitrate", bitrate as i32);
        f.set_i32("max-input-size", 16 * 1024);
        let codec = start(MediaCodec::from_encoder_type("audio/mp4a-latm"), &f, MediaCodecDirection::Encoder)?;
        Ok(codec.map(|codec| Box::new(Codec { codec, rate, channels: 1, config: None, ended: false, fed: 0, whole_input: false }) as Box<dyn Encoder>))
    }
}

struct Codec {
    codec: MediaCodec,
    rate: u32,
    channels: usize,
    config: Option<Vec<u8>>,
    ended: bool,
    /// Samples given to an encoder so far: its input timestamps.
    fed: u64,
    /// Each input is one packet that must go in one buffer (a decoder); otherwise a stream of samples (an encoder).
    whole_input: bool,
}

impl Codec {
    /// Puts `input` in (all of it, across as many buffers as it takes), or the end of the stream with `None`, taking
    /// output as it comes. After the end, waits until the codec gives its own end back. What's ready is always taken
    /// before waiting for room: a codec with nowhere to put its output stops taking input.
    fn run(&mut self, input: Option<&[u8]>, pts_us: i64, out: &mut dyn FnMut(&Codec, &[u8], u32) -> Result<()>) -> Result<()> {
        if self.ended {
            return Err(failed());
        }
        let mut rest = input;
        let mut sent_end = false;
        let mut quiet_since = std::time::Instant::now();
        loop {
            // Everything ready now; after the end has gone in, wait a little for more.
            loop {
                let wait = if sent_end { WAIT } else { Duration::ZERO };
                match self.codec.dequeue_output_buffer(wait).map_err(|_| failed())? {
                    DequeuedOutputBufferInfoResult::Buffer(buf) => {
                        let info = *buf.info();
                        let (offset, size) = (info.offset().max(0) as usize, info.size().max(0) as usize);
                        let bytes = buf.buffer().get(offset..offset + size).ok_or_else(failed)?.to_vec();
                        self.codec.release_output_buffer(buf, false).map_err(|_| failed())?;
                        out(self, &bytes, info.flags())?;
                        quiet_since = std::time::Instant::now();
                        if info.flags() & END_OF_STREAM != 0 {
                            self.ended = true;
                            return Ok(());
                        }
                    }
                    DequeuedOutputBufferInfoResult::OutputFormatChanged => {
                        let f = self.codec.output_format();
                        if let Some(rate) = f.i32("sample-rate").filter(|r| *r > 0) {
                            self.rate = rate as u32;
                        }
                        if let Some(ch) = f.i32("channel-count").filter(|c| *c > 0) {
                            self.channels = ch as usize;
                        }
                        if let Some(csd) = f.buffer("csd-0") {
                            self.config.get_or_insert_with(|| csd.to_vec());
                        }
                    }
                    DequeuedOutputBufferInfoResult::OutputBuffersChanged => {}
                    DequeuedOutputBufferInfoResult::TryAgainLater => break,
                }
            }
            if quiet_since.elapsed() > DRAIN_LIMIT {
                tracing::warn!("voice: codec stopped answering");
                return Err(failed());
            }
            match rest {
                // All in, and what was ready taken: the rest comes out with the next call.
                Some([]) => return Ok(()),
                None if sent_end => continue,
                _ => {}
            }
            if let DequeuedInputBufferResult::Buffer(mut buf) = self.codec.dequeue_input_buffer(WAIT).map_err(|_| failed())? {
                let space = buf.buffer_mut();
                match rest {
                    Some(b) => {
                        // A decoder's packet goes whole (half an Opus packet is noise); an encoder's samples may span buffers,
                        // but never split one: whole frames of 16-bit samples, `channels` at a time.
                        let frame = 2 * self.channels.max(1);
                        let n = if self.whole_input {
                            if b.len() > space.len() {
                                tracing::warn!("voice: a packet larger than the decoder's buffer");
                                return Err(failed());
                            }
                            b.len()
                        } else {
                            b.len().min(space.len() / frame * frame)
                        };
                        for (d, s) in space[..n].iter_mut().zip(&b[..n]) {
                            d.write(*s);
                        }
                        self.codec.queue_input_buffer(buf, 0, n, pts_us.max(0) as u64, 0).map_err(|_| failed())?;
                        rest = Some(&b[n..]);
                    }
                    None => {
                        self.codec.queue_input_buffer(buf, 0, 0, pts_us.max(0) as u64, END_OF_STREAM).map_err(|_| failed())?;
                        sent_end = true;
                    }
                }
                quiet_since = std::time::Instant::now();
            }
        }
    }
}

impl Decoder for Codec {
    fn decode(&mut self, packet: Option<(&[u8], i64)>, pcm: &mut Vec<i16>) -> Result<()> {
        let (data, pts) = match packet {
            Some((d, t)) => (Some(d), t),
            None => (None, 0),
        };
        self.run(data, pts, &mut |codec, bytes, _| {
            // 16-bit little-endian, interleaved: mixed down to one channel.
            let ch = codec.channels.max(1);
            for frame in bytes.chunks_exact(2 * ch) {
                let sum: i32 = frame.chunks_exact(2).map(|s| i32::from(i16::from_le_bytes([s[0], s[1]]))).sum();
                pcm.push((sum / ch as i32) as i16);
            }
            Ok(())
        })
    }

    fn rate(&self) -> u32 {
        self.rate
    }
}

impl Encoder for Codec {
    fn encode(&mut self, pcm: Option<&[i16]>, out: &mut dyn FnMut(&[u8]) -> Result<()>) -> Result<()> {
        let bytes: Option<Vec<u8>> = pcm.map(|p| p.iter().flat_map(|s| s.to_le_bytes()).collect());
        // Timestamps only keep the codec's order; the M4A gives every frame its 1024 samples.
        let pts = (self.fed * 1_000_000 / u64::from(self.rate.max(1))) as i64;
        self.fed += pcm.map_or(0, |p| p.len() as u64);
        let mut config = None;
        self.run(bytes.as_deref(), pts, &mut |_, frame, flags| {
            if flags & CODEC_CONFIG != 0 {
                config = Some(frame.to_vec());
            } else if !frame.is_empty() {
                out(frame)?;
            }
            Ok(())
        })?;
        if let Some(c) = config {
            self.config.get_or_insert(c);
        }
        Ok(())
    }

    fn config(&self) -> Option<Vec<u8>> {
        self.config.clone()
    }
}

impl Drop for Codec {
    fn drop(&mut self) {
        let _ = self.codec.stop();
    }
}
