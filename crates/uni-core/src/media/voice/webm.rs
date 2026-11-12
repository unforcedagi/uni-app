//! Opus packets out of a WebM recording, read from disk as they're needed: memory doesn't grow with the length.
//!
//! The file is walked flat. A segment and its clusters are entered rather than read whole, since a recorder writes both
//! with an unknown size; the IDs of their children don't overlap, so a block found after a cluster's end is simply the
//! next cluster's. The track is checked by the same rules as the normalizer's ([`super::super::normalize::opus_head`]).
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use crate::media::normalize::{damaged, io_failed, opus_head};
use crate::Result;

const EBML: u32 = 0x1a45_dfa3;
const SEGMENT: u32 = 0x1853_8067;
const INFO: u32 = 0x1549_a966;
const TRACKS: u32 = 0x1654_ae6b;
const CLUSTER: u32 = 0x1f43_b675;
const TIMECODE_SCALE: u32 = 0x2a_d7b1;
const TIMECODE: u32 = 0xe7;
const SIMPLE_BLOCK: u32 = 0xa3;
const BLOCK_GROUP: u32 = 0xa0;
const BLOCK: u32 = 0xa1;
/// Headers and a block group are read whole; anything claiming more is a bad size, not audio.
const MAX_READ: u64 = 1024 * 1024;
/// What a killed recorder can leave unreadable at the end (as the normalizer allows).
const CUT_SLACK: u64 = 4096;

/// A track's setup: the `OpusHead` the decoder needs, and its channel count.
#[derive(Debug, Clone)]
pub struct OpusHead {
    pub bytes: Vec<u8>,
    pub channels: u8,
    /// Samples at 48 kHz the decoder drops from the start.
    pub pre_skip: u16,
}

pub struct Packets {
    r: BufReader<File>,
    at: u64,
    len: u64,
    scale_ns: u64,
    cluster_ticks: u64,
    track: Option<u64>,
    pub head: OpusHead,
}

/// One Opus packet and when it starts, in microseconds.
pub struct Packet {
    pub data: Vec<u8>,
    pub time_us: i64,
}

fn vint(r: &mut impl Read, id: bool) -> std::io::Result<Option<(u64, usize, bool)>> {
    let mut first = [0u8; 1];
    if r.read(&mut first)? == 0 {
        return Ok(None);
    }
    let len = first[0].leading_zeros() as usize + 1;
    if len > if id { 4 } else { 8 } {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut v = if id { u64::from(first[0]) } else { u64::from(first[0]) & (0xff >> len) };
    let mut rest = [0u8; 7];
    r.read_exact(&mut rest[..len - 1])?;
    for b in &rest[..len - 1] {
        v = (v << 8) | u64::from(*b);
    }
    let unknown = !id && v == (1u64 << (7 * len)) - 1;
    Ok(Some((v, len, unknown)))
}

impl Packets {
    /// Opens a WebM and reads up to its first cluster: the track must be one Opus track, mono or stereo.
    pub fn open(path: &Path) -> Result<Self> {
        let f = File::open(path).map_err(io_failed)?;
        let len = f.metadata().map_err(io_failed)?.len();
        let mut p = Packets {
            r: BufReader::with_capacity(64 * 1024, f),
            at: 0,
            len,
            scale_ns: 1_000_000,
            cluster_ticks: 0,
            track: None,
            head: OpusHead { bytes: vec![], channels: 0, pre_skip: 0 },
        };
        let (id, size, _) = p.header()?.ok_or_else(damaged)?;
        if id != EBML {
            return Err(damaged());
        }
        p.skip(size)?;
        let (id, _, _) = p.header()?.ok_or_else(damaged)?;
        if id != SEGMENT {
            return Err(damaged());
        }
        // Info and Tracks come before the first cluster in anything a recorder writes.
        let mut tracks = None;
        loop {
            let start = p.at;
            let Some((id, size, unknown)) = p.header()? else { break };
            match id {
                INFO => {
                    let body = p.body(size, unknown)?;
                    if let Some(scale) = child_number(&body, TIMECODE_SCALE) {
                        p.scale_ns = scale.max(1);
                    }
                }
                TRACKS => tracks = Some(p.body(size, unknown)?),
                CLUSTER => {
                    p.seek_to(start)?;
                    break;
                }
                _ => p.skip_known(size, unknown)?,
            }
        }
        let tracks = tracks.ok_or_else(damaged)?;
        let (bytes, number) = opus_head(&tracks)?;
        p.track = number;
        p.head = OpusHead { channels: bytes[9], pre_skip: u16::from_le_bytes([bytes[10], bytes[11]]), bytes };
        Ok(p)
    }

    fn header(&mut self) -> Result<Option<(u32, u64, bool)>> {
        let start = self.at;
        let Some((id, id_len, _)) = vint(&mut self.r, true).map_err(|_| damaged())? else {
            return Ok(None);
        };
        let Some((size, size_len, unknown)) = vint(&mut self.r, false).map_err(|_| damaged())? else {
            return Err(damaged());
        };
        self.at = start + (id_len + size_len) as u64;
        Ok(Some((id as u32, size, unknown)))
    }

    fn body(&mut self, size: u64, unknown: bool) -> Result<Vec<u8>> {
        if unknown || size > MAX_READ || self.at + size > self.len {
            return Err(damaged());
        }
        let mut b = vec![0u8; size as usize];
        self.r.read_exact(&mut b).map_err(io_failed)?;
        self.at += size;
        Ok(b)
    }

    fn skip(&mut self, size: u64) -> Result<()> {
        self.r.seek_relative(i64::try_from(size).map_err(|_| damaged())?).map_err(io_failed)?;
        self.at += size;
        Ok(())
    }

    fn skip_known(&mut self, size: u64, unknown: bool) -> Result<()> {
        if unknown {
            return Err(damaged());
        }
        self.skip(size)
    }

    fn seek_to(&mut self, at: u64) -> Result<()> {
        self.r.seek(SeekFrom::Start(at)).map_err(io_failed)?;
        self.at = at;
        Ok(())
    }

    /// The next packet, or `None` at the end. A block cut off by a killed recorder ends the recording there.
    pub fn next_packet(&mut self) -> Result<Option<Packet>> {
        loop {
            let Some((id, size, unknown)) = self.header()? else { return Ok(None) };
            match id {
                // Entered, never skipped: their children follow.
                SEGMENT | CLUSTER => {}
                TIMECODE => self.cluster_ticks = number(&self.body(size, unknown)?),
                SIMPLE_BLOCK | BLOCK_GROUP => {
                    if unknown || self.at + size > self.len {
                        // Half a block at the end of a killed recording: what came before it stands.
                        if self.len.saturating_sub(self.at) > CUT_SLACK {
                            return Err(damaged());
                        }
                        return Ok(None);
                    }
                    let body = self.body(size, false)?;
                    let block = if id == BLOCK_GROUP {
                        match find_child(&body, BLOCK) {
                            Some(b) => b.to_vec(),
                            None => continue,
                        }
                    } else {
                        body
                    };
                    if let Some(packet) = self.packet(block)? {
                        return Ok(Some(packet));
                    }
                }
                _ => {
                    if unknown || self.at + size > self.len {
                        if self.len.saturating_sub(self.at) > CUT_SLACK {
                            return Err(damaged());
                        }
                        return Ok(None);
                    }
                    self.skip(size)?
                }
            }
        }
    }

    fn packet(&self, block: Vec<u8>) -> Result<Option<Packet>> {
        let mut c = std::io::Cursor::new(&block);
        let (track, len, _) = vint(&mut c, false).map_err(|_| damaged())?.ok_or_else(damaged)?;
        if block.len() < len + 3 {
            return Err(damaged());
        }
        if self.track.is_some_and(|t| t != track) {
            return Ok(None);
        }
        let rel = i64::from(i16::from_be_bytes([block[len], block[len + 1]]));
        if block[len + 2] & 0x06 != 0 {
            return Err(damaged()); // laced: no recorder writes Opus that way, and the normalizer refuses it too
        }
        let data = block[len + 3..].to_vec();
        if data.is_empty() {
            return Ok(None);
        }
        let ticks = self.cluster_ticks as i64 + rel;
        Ok(Some(Packet { data, time_us: ticks.max(0).saturating_mul(self.scale_ns as i64) / 1000 }))
    }
}

fn number(b: &[u8]) -> u64 {
    b.iter().take(8).fold(0u64, |v, x| (v << 8) | u64::from(*x))
}

fn find_child(b: &[u8], want: u32) -> Option<&[u8]> {
    let mut c = std::io::Cursor::new(b);
    loop {
        let (id, _, _) = vint(&mut c, true).ok()??;
        let (size, _, unknown) = vint(&mut c, false).ok()??;
        let at = c.position() as usize;
        let end = if unknown { b.len() } else { at.checked_add(usize::try_from(size).ok()?)? };
        if end > b.len() {
            return None;
        }
        if id as u32 == want {
            return Some(&b[at..end]);
        }
        c.set_position(end as u64);
    }
}

fn child_number(b: &[u8], want: u32) -> Option<u64> {
    find_child(b, want).filter(|v| (1..=8).contains(&v.len())).map(number)
}
