//! The smallest M4A that holds an AAC stream: `ftyp mdat moov`, one sound track, written as the frames arrive.
//!
//! Frames go to disk straight away; only their sizes are kept (4 bytes each, under 30,000 for a part). It's not what the
//! relay takes yet: the normalizer moves `moov` first and puts the still frame beside the sound.
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use crate::media::normalize::io_failed;
use crate::Result;

/// AAC-LC: every frame is this many samples.
pub const FRAME_SAMPLES: u32 = 1024;
/// Frames per chunk: about a second, so a player can find its place without a huge table.
const CHUNK_FRAMES: usize = 48;

pub struct M4aWriter {
    out: BufWriter<File>,
    mdat_at: u64,
    written: u64,
    sizes: Vec<u32>,
    rate: u32,
    channels: u16,
}

fn bx(kind: &[u8; 4], parts: &[&[u8]]) -> Vec<u8> {
    let len: usize = 8 + parts.iter().map(|p| p.len()).sum::<usize>();
    let mut b = Vec::with_capacity(len);
    b.extend_from_slice(&(len as u32).to_be_bytes());
    b.extend_from_slice(kind);
    for p in parts {
        b.extend_from_slice(p);
    }
    b
}

fn full(kind: &[u8; 4], version_flags: u32, body: &[u8]) -> Vec<u8> {
    bx(kind, &[&version_flags.to_be_bytes(), body])
}

/// An MPEG-4 descriptor: tag, length, body.
fn descriptor(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut d = vec![tag];
    // Four-byte length form, as most muxers write it; any length under 2^28 fits.
    let n = body.len() as u32;
    d.extend_from_slice(&[0x80 | (n >> 21) as u8 & 0x7f, 0x80 | (n >> 14) as u8 & 0x7f, 0x80 | (n >> 7) as u8 & 0x7f, n as u8 & 0x7f]);
    d.extend_from_slice(body);
    d
}

const IDENTITY: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

impl M4aWriter {
    pub fn create(path: &Path, rate: u32, channels: u16) -> Result<Self> {
        let mut out = BufWriter::with_capacity(256 * 1024, File::create(path).map_err(io_failed)?);
        let ftyp = bx(b"ftyp", &[b"M4A ", &0u32.to_be_bytes(), b"M4A ", b"mp42", b"isom"]);
        out.write_all(&ftyp).map_err(io_failed)?;
        let mdat_at = ftyp.len() as u64;
        out.write_all(&[0, 0, 0, 0]).map_err(io_failed)?; // the size, filled in at the end
        out.write_all(b"mdat").map_err(io_failed)?;
        Ok(M4aWriter { out, mdat_at, written: 0, sizes: Vec::new(), rate, channels })
    }

    pub fn frame(&mut self, frame: &[u8]) -> Result<()> {
        self.out.write_all(frame).map_err(io_failed)?;
        self.written += frame.len() as u64;
        self.sizes.push(frame.len() as u32);
        Ok(())
    }

    pub fn frames(&self) -> usize {
        self.sizes.len()
    }

    /// Seconds of sound written so far.
    pub fn seconds(&self) -> f64 {
        self.sizes.len() as f64 * f64::from(FRAME_SAMPLES) / f64::from(self.rate)
    }

    /// Writes the index. `config` is the encoder's AudioSpecificConfig.
    pub fn finish(mut self, config: &[u8], avg_bitrate: u32) -> Result<()> {
        let data_at = self.mdat_at + 8;
        let mdat_len = 8 + self.written;
        let mdat_len = u32::try_from(mdat_len).map_err(|_| io_failed(std::io::ErrorKind::FileTooLarge.into()))?;
        let n = self.sizes.len() as u32;
        let duration = u64::from(n) * u64::from(FRAME_SAMPLES);
        let duration32 = u32::try_from(duration).unwrap_or(u32::MAX);

        let mut mvhd = Vec::new();
        for v in [0u32, 0, self.rate, duration32, 0x0001_0000] {
            mvhd.extend_from_slice(&v.to_be_bytes());
        }
        mvhd.extend_from_slice(&0x0100u16.to_be_bytes());
        mvhd.extend_from_slice(&[0; 10]);
        for v in IDENTITY {
            mvhd.extend_from_slice(&v.to_be_bytes());
        }
        mvhd.extend_from_slice(&[0; 24]);
        mvhd.extend_from_slice(&2u32.to_be_bytes()); // next track id
        let mvhd = full(b"mvhd", 0, &mvhd);

        let mut tkhd = Vec::new();
        for v in [0u32, 0, 1, 0, duration32, 0, 0] {
            tkhd.extend_from_slice(&v.to_be_bytes());
        }
        tkhd.extend_from_slice(&[0, 0, 0, 0]); // layer, alternate group
        tkhd.extend_from_slice(&0x0100u16.to_be_bytes()); // volume
        tkhd.extend_from_slice(&[0, 0]);
        for v in IDENTITY {
            tkhd.extend_from_slice(&v.to_be_bytes());
        }
        tkhd.extend_from_slice(&[0; 8]); // width, height
        let tkhd = full(b"tkhd", 3, &tkhd); // enabled, in movie

        let mut mdhd = Vec::new();
        for v in [0u32, 0, self.rate, duration32] {
            mdhd.extend_from_slice(&v.to_be_bytes());
        }
        mdhd.extend_from_slice(&0x55c4u16.to_be_bytes()); // "und"
        mdhd.extend_from_slice(&[0, 0]);
        let mdhd = full(b"mdhd", 0, &mdhd);
        let hdlr = full(b"hdlr", 0, &[&[0u8; 4][..], b"soun", &[0; 12], b"SoundHandler\0"].concat());

        let decoder_config = {
            let mut d = vec![0x40, 0x15, 0, 0, 0];
            let largest = self.sizes.iter().copied().max().unwrap_or(0);
            d[2..5].copy_from_slice(&largest.to_be_bytes()[1..]);
            let peak = largest.saturating_mul(8).saturating_mul(self.rate) / FRAME_SAMPLES;
            d.extend_from_slice(&peak.max(avg_bitrate).to_be_bytes());
            d.extend_from_slice(&avg_bitrate.to_be_bytes());
            d.extend_from_slice(&descriptor(0x05, config));
            descriptor(0x04, &d)
        };
        let es = descriptor(0x03, &[&[0u8, 0, 0][..], &decoder_config, &descriptor(0x06, &[2])].concat());
        let esds = full(b"esds", 0, &es);
        let mut mp4a = vec![0u8; 6];
        mp4a.extend_from_slice(&1u16.to_be_bytes()); // data reference
        mp4a.extend_from_slice(&[0; 8]);
        mp4a.extend_from_slice(&self.channels.to_be_bytes());
        mp4a.extend_from_slice(&16u16.to_be_bytes());
        mp4a.extend_from_slice(&[0; 4]);
        mp4a.extend_from_slice(&(self.rate.min(0xffff) << 16).to_be_bytes());
        mp4a.extend_from_slice(&esds);
        let stsd = full(b"stsd", 0, &[&1u32.to_be_bytes()[..], &bx(b"mp4a", &[&mp4a])].concat());

        let stts = full(b"stts", 0, &[1u32, n, FRAME_SAMPLES].iter().flat_map(|v| v.to_be_bytes()).collect::<Vec<_>>());
        let chunks = self.sizes.len().div_ceil(CHUNK_FRAMES);
        let last = self.sizes.len() - chunks.saturating_sub(1) * CHUNK_FRAMES;
        let mut stsc_rows = vec![[1u32, CHUNK_FRAMES.min(self.sizes.len()) as u32, 1]];
        if chunks > 1 && last != CHUNK_FRAMES {
            stsc_rows.push([chunks as u32, last as u32, 1]);
        }
        let mut stsc = (stsc_rows.len() as u32).to_be_bytes().to_vec();
        stsc.extend(stsc_rows.iter().flatten().flat_map(|v| v.to_be_bytes()));
        let stsc = full(b"stsc", 0, &stsc);
        let mut stsz = vec![0u8; 4];
        stsz.extend_from_slice(&n.to_be_bytes());
        stsz.extend(self.sizes.iter().flat_map(|v| v.to_be_bytes()));
        let stsz = full(b"stsz", 0, &stsz);
        let mut stco = (chunks as u32).to_be_bytes().to_vec();
        let mut at = data_at;
        for c in self.sizes.chunks(CHUNK_FRAMES) {
            stco.extend_from_slice(&u32::try_from(at).unwrap_or(u32::MAX).to_be_bytes());
            at += c.iter().map(|s| u64::from(*s)).sum::<u64>();
        }
        let stco = full(b"stco", 0, &stco);

        let stbl = bx(b"stbl", &[&stsd, &stts, &stsc, &stsz, &stco]);
        let dinf = bx(b"dinf", &[&full(b"dref", 0, &[&1u32.to_be_bytes()[..], &full(b"url ", 1, &[])].concat())]);
        let smhd = full(b"smhd", 0, &[0; 4]);
        let minf = bx(b"minf", &[&smhd, &dinf, &stbl]);
        let mdia = bx(b"mdia", &[&mdhd, &hdlr, &minf]);
        let trak = bx(b"trak", &[&tkhd, &mdia]);
        let moov = bx(b"moov", &[&mvhd, &trak]);
        self.out.write_all(&moov).map_err(io_failed)?;
        self.out.seek(SeekFrom::Start(self.mdat_at)).map_err(io_failed)?;
        self.out.write_all(&mdat_len.to_be_bytes()).map_err(io_failed)?;
        let f = self.out.into_inner().map_err(|e| io_failed(e.into_error()))?;
        f.sync_all().map_err(io_failed)?;
        Ok(())
    }
}
