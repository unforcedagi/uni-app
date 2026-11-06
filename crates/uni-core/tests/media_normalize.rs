//! The relay refuses media it can't inspect; the app rewrites media so it never gets that far. These tests build the
//! shapes phones and tools really write (all made up), normalize them, then check the result with the same `mp4` parser
//! the relay runs plus a port of its box rules (crates/buzz-media validation.rs at the deployed relay). Sample bytes are
//! read back through that parser, so a wrong chunk offset fails here.
use std::path::{Path, PathBuf};
use std::process::Command;

use uni_core::media::normalize::{normalize_file, Normalized};

// ── Box builders ────────────────────────────────────────────────────────
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
fn u32s(v: &[u32]) -> Vec<u8> {
    v.iter().flat_map(|n| n.to_be_bytes()).collect()
}
fn ftyp(major: &[u8; 4], compat: &[&[u8; 4]]) -> Vec<u8> {
    let c: Vec<u8> = compat.iter().flat_map(|b| b.iter().copied()).collect();
    bx(b"ftyp", &[major, &[0, 0, 2, 0], &c])
}
fn mvhd(timescale: u32, duration: u32) -> Vec<u8> {
    let mut b = vec![0u8; 100];
    b[4..8].copy_from_slice(&1_700_000_000u32.to_be_bytes()); // a capture time that must not survive
    b[12..16].copy_from_slice(&timescale.to_be_bytes());
    b[16..20].copy_from_slice(&duration.to_be_bytes());
    b[20..24].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    b[24..26].copy_from_slice(&0x0100u16.to_be_bytes());
    b[36..40].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    b[52..56].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    b[68..72].copy_from_slice(&0x4000_0000u32.to_be_bytes());
    b[96..100].copy_from_slice(&9u32.to_be_bytes());
    bx(b"mvhd", &[&b])
}
fn tkhd(id: u32, duration: u32, w: u16, h: u16) -> Vec<u8> {
    let mut b = vec![0u8; 84];
    b[3] = 3;
    b[4..8].copy_from_slice(&1_700_000_000u32.to_be_bytes());
    b[12..16].copy_from_slice(&id.to_be_bytes());
    b[20..24].copy_from_slice(&duration.to_be_bytes());
    b[40..44].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    b[56..60].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    b[72..76].copy_from_slice(&0x4000_0000u32.to_be_bytes());
    b[76..78].copy_from_slice(&w.to_be_bytes());
    b[80..82].copy_from_slice(&h.to_be_bytes());
    bx(b"tkhd", &[&b])
}
fn mdhd(timescale: u32, duration: u32) -> Vec<u8> {
    let mut b = vec![0u8; 24];
    b[4..8].copy_from_slice(&1_700_000_000u32.to_be_bytes());
    b[12..16].copy_from_slice(&timescale.to_be_bytes());
    b[16..20].copy_from_slice(&duration.to_be_bytes());
    b[20..22].copy_from_slice(&0x55c4u16.to_be_bytes());
    bx(b"mdhd", &[&b])
}
fn hdlr_iso(kind: &[u8; 4], name: &str) -> Vec<u8> {
    let mut b = vec![0u8; 8];
    b.extend_from_slice(kind);
    b.extend_from_slice(&[0; 12]);
    b.extend_from_slice(name.as_bytes());
    b.push(0);
    bx(b"hdlr", &[&b])
}
/// QuickTime's form: component type, then a Pascal string, with no terminator.
fn hdlr_qt(component: &[u8; 4], kind: &[u8; 4], name: &str) -> Vec<u8> {
    let mut b = vec![0u8; 4];
    b.extend_from_slice(component);
    b.extend_from_slice(kind);
    b.extend_from_slice(&[0; 12]);
    b.push(name.len() as u8);
    b.extend_from_slice(name.as_bytes());
    bx(b"hdlr", &[&b])
}
fn avcc() -> Vec<u8> {
    bx(
        b"avcC",
        &[&[
            1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 3, 0x67, 0x42, 0xc0, 1, 0, 2, 0x68, 0xc8,
        ]],
    )
}
fn visual_entry(kind: &[u8; 4], w: u16, h: u16, children: &[Vec<u8>]) -> Vec<u8> {
    let mut b = vec![0u8; 78];
    b[7] = 1;
    b[24..26].copy_from_slice(&w.to_be_bytes());
    b[26..28].copy_from_slice(&h.to_be_bytes());
    b[28..32].copy_from_slice(&0x0048_0000u32.to_be_bytes());
    b[32..36].copy_from_slice(&0x0048_0000u32.to_be_bytes());
    b[40..42].copy_from_slice(&1u16.to_be_bytes());
    b[42] = 9;
    b[43..52].copy_from_slice(b"SECRETCAM");
    b[74..76].copy_from_slice(&24u16.to_be_bytes());
    b[76..78].copy_from_slice(&0xffffu16.to_be_bytes());
    for c in children {
        b.extend_from_slice(c);
    }
    bx(kind, &[&b])
}
fn esds() -> Vec<u8> {
    let dsi: &[u8] = &[0x05, 2, 0x12, 0x10];
    let mut dcd = vec![0x40, 0x15, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0];
    dcd.extend_from_slice(dsi);
    let mut es = vec![0, 1, 0, 0x04, dcd.len() as u8];
    es.extend_from_slice(&dcd);
    es.extend_from_slice(&[0x06, 1, 2]);
    let mut b = vec![0, 0, 0, 0, 0x03, es.len() as u8];
    b.extend_from_slice(&es);
    bx(b"esds", &[&b])
}
fn mp4a_v0() -> Vec<u8> {
    let mut b = vec![0u8; 28];
    b[7] = 1;
    b[17] = 2;
    b[19] = 16;
    b[24..28].copy_from_slice(&(44100u32 << 16).to_be_bytes());
    b.extend_from_slice(&esds());
    bx(b"mp4a", &[&b])
}
/// QuickTime sound description v1: esds sits inside `wave`, sixteen more header bytes before it.
fn mp4a_qt_v1() -> Vec<u8> {
    let mut b = vec![0u8; 44];
    b[7] = 1;
    b[9] = 1; // version 1
    b[17] = 2;
    b[19] = 16;
    b[24..28].copy_from_slice(&(44100u32 << 16).to_be_bytes());
    let wave = bx(
        b"wave",
        &[&bx(b"frma", &[b"mp4a"]), &esds(), &[0, 0, 0, 8, 0, 0, 0, 0]],
    );
    b.extend_from_slice(&wave);
    bx(b"mp4a", &[&b])
}
fn stsd(entry: &[u8]) -> Vec<u8> {
    bx(b"stsd", &[&[0, 0, 0, 0, 0, 0, 0, 1], entry])
}

/// One track's samples and how the file lays them out.
struct T {
    id: u32,
    handler: [u8; 4],
    entry: Vec<u8>,
    timescale: u32,
    delta: u32,
    samples: Vec<Vec<u8>>,
    per_chunk: usize,
    co64: bool,
    stz2: bool,
    qt: bool,
    extra_trak: Vec<Vec<u8>>,
    media_head: Vec<u8>,
}
fn video(id: u32, w: u16, h: u16, samples: Vec<Vec<u8>>) -> T {
    T {
        id,
        handler: *b"vide",
        entry: visual_entry(b"avc1", w, h, &[avcc()]),
        timescale: 30000,
        delta: 1000,
        samples,
        per_chunk: 2,
        co64: false,
        stz2: false,
        qt: false,
        extra_trak: vec![],
        media_head: bx(b"vmhd", &[&[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]]),
    }
}
fn audio(id: u32, samples: Vec<Vec<u8>>) -> T {
    T {
        id,
        handler: *b"soun",
        entry: mp4a_v0(),
        timescale: 44100,
        delta: 1024,
        samples,
        per_chunk: 3,
        co64: false,
        stz2: false,
        qt: false,
        extra_trak: vec![],
        media_head: bx(b"smhd", &[&[0; 8]]),
    }
}
fn trak_with_offsets(t: &T, offsets: &[u64]) -> Vec<u8> {
    let n = t.samples.len() as u32;
    let stts = bx(b"stts", &[&u32s(&[0, 1, n, t.delta])]);
    let chunks = t.samples.len().div_ceil(t.per_chunk.max(1)) as u32;
    let stsc = bx(b"stsc", &[&u32s(&[0, 1, 1, t.per_chunk as u32, 1])]);
    let stsz = if t.stz2 {
        let mut b = u32s(&[0, 16, n]); // field size 16
        for s in &t.samples {
            b.extend_from_slice(&(s.len() as u16).to_be_bytes());
        }
        bx(b"stz2", &[&b])
    } else {
        let mut v = vec![0, 0, n];
        v.extend(t.samples.iter().map(|s| s.len() as u32));
        bx(b"stsz", &[&u32s(&v)])
    };
    let stco = if t.co64 {
        let mut b = u32s(&[0, chunks]);
        for o in offsets {
            b.extend_from_slice(&o.to_be_bytes());
        }
        bx(b"co64", &[&b])
    } else {
        let mut v = vec![0, chunks];
        v.extend(offsets.iter().map(|o| *o as u32));
        bx(b"stco", &[&u32s(&v)])
    };
    let sdtp = bx(b"sdtp", &[&vec![0u8; 4 + n as usize]]); // legal, but not on the relay's list
    let stbl = bx(
        b"stbl",
        &[&stsd(&t.entry), &stts, &stsc, &stsz, &stco, &sdtp],
    );
    let dinf = if t.qt {
        bx(
            b"dinf",
            &[&bx(
                b"dref",
                &[&[0, 0, 0, 0, 0, 0, 0, 1], &bx(b"alis", &[&[0, 0, 0, 1]])],
            )],
        )
    } else {
        bx(
            b"dinf",
            &[&bx(
                b"dref",
                &[&[0, 0, 0, 0, 0, 0, 0, 1], &bx(b"url ", &[&[0, 0, 0, 1]])],
            )],
        )
    };
    let minf = if t.qt {
        bx(
            b"minf",
            &[
                &t.media_head,
                &hdlr_qt(b"dhlr", b"alis", "DataHandler"),
                &dinf,
                &stbl,
            ],
        )
    } else {
        bx(b"minf", &[&t.media_head, &dinf, &stbl])
    };
    let hd = if t.qt {
        hdlr_qt(b"mhlr", &t.handler, "SecretHandlerName")
    } else {
        hdlr_iso(&t.handler, "SecretHandlerName")
    };
    let duration = n * t.delta;
    let mdia = bx(b"mdia", &[&mdhd(t.timescale, duration), &hd, &minf]);
    let (w, h) = (640, 360);
    let mut parts: Vec<Vec<u8>> = vec![
        tkhd(t.id, duration / t.timescale.max(1) * 1000 + 1, w, h),
        mdia,
    ];
    parts.extend(t.extra_trak.iter().cloned());
    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    bx(b"trak", &refs)
}
/// What moov carries beside the tracks in a phone's file: location, make and model, in every form the relay looks for.
fn camera_extras() -> Vec<u8> {
    let xyz = bx(b"\xa9xyz", &[&[0, 13, 0x15, 0xc7], b"+00.00+000.00"]);
    let udta = bx(b"udta", &[&xyz, &bx(b"name", &[b"SECRETNAME"])]);
    let keys = bx(
        b"keys",
        &[
            &[0, 0, 0, 0, 0, 0, 0, 1],
            &bx(b"mdta", &[b"com.example.location.SECRET"]),
        ],
    );
    let ilst = bx(
        b"ilst",
        &[&bx(
            &[0, 0, 0, 1],
            &[&bx(b"data", &[&[0, 0, 0, 1, 0, 0, 0, 0], b"SECRETPLACE"])],
        )],
    );
    let meta = bx(b"meta", &[&hdlr_iso(b"mdta", ""), &keys, &ilst]);
    let iods = bx(
        b"iods",
        &[&[
            0, 0, 0, 0, 0x10, 0x80, 0x80, 0x80, 7, 0, 0x4f, 0xff, 0xff, 0x29, 0xff, 0xff,
        ]],
    );
    let mut out = udta;
    out.extend_from_slice(&meta);
    out.extend_from_slice(&iods);
    out
}

struct Built {
    path: PathBuf,
    /// (track id, samples) that must survive, in order.
    keep: Vec<(u32, Vec<Vec<u8>>)>,
}

/// Lay tracks out in one mdat after `head`, moov last, and return the file. Interleaved like a camera.
fn write_file(
    dir: &Path,
    name: &str,
    head: &[u8],
    tracks: &[T],
    extras: &[u8],
    keep: &[u32],
) -> Built {
    let mut mdat = Vec::new();
    let mut offsets: Vec<Vec<u64>> = tracks.iter().map(|_| vec![]).collect();
    let base = head.len() as u64 + 8 + 16; // a `free` box, then mdat's 64-bit header
    let most = tracks
        .iter()
        .map(|t| t.samples.len().div_ceil(t.per_chunk.max(1)))
        .max()
        .unwrap_or(0);
    for c in 0..most {
        for (ti, t) in tracks.iter().enumerate() {
            if let Some(chunk) = t.samples.chunks(t.per_chunk.max(1)).nth(c) {
                offsets[ti].push(base + mdat.len() as u64);
                for s in chunk {
                    mdat.extend_from_slice(s);
                }
            }
        }
    }
    let mut parts = vec![mvhd(1000, 4000)];
    for (t, o) in tracks.iter().zip(&offsets) {
        parts.push(trak_with_offsets(t, o));
    }
    parts.push(extras.to_vec());
    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    let moov = bx(b"moov", &refs);
    let mut f = head.to_vec();
    f.extend_from_slice(&bx(b"free", &[]));
    f.extend_from_slice(&1u32.to_be_bytes());
    f.extend_from_slice(b"mdat");
    f.extend_from_slice(&(mdat.len() as u64 + 16).to_be_bytes());
    f.extend_from_slice(&mdat);
    f.extend_from_slice(&moov);
    let path = dir.join(name);
    std::fs::write(&path, f).unwrap();
    Built {
        path,
        keep: tracks
            .iter()
            .filter(|t| keep.contains(&t.id))
            .map(|t| (t.id, t.samples.clone()))
            .collect(),
    }
}
fn samples(tag: u8, n: usize, size: usize) -> Vec<Vec<u8>> {
    (0..n)
        .map(|i| {
            let mut s = vec![tag; size + (i % 5)];
            s[..4.min(size)].copy_from_slice(&(i as u32).to_be_bytes()[..4.min(size)]);
            s
        })
        .collect()
}

// ── The relay's rules, ported (validation.rs at the deployed relay) ─────
fn relay_accepts(path: &Path) -> Result<(), String> {
    const ALLOWED: &[&[u8; 4]] = &[
        b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"trak", b"mdia", b"minf", b"stbl",
        b"edts", b"dinf", b"sinf", b"schi", b"udta", b"mvhd", b"tkhd", b"mdhd", b"hdlr", b"vmhd",
        b"smhd", b"dref", b"url ", b"urn ", b"stsd", b"stts", b"stss", b"ctts", b"stsc", b"stsz",
        b"stco", b"co64", b"sgpd", b"sbgp", b"elst",
    ];
    const CONTAINERS: &[&[u8; 4]] = &[
        b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"dinf", b"sinf", b"schi",
    ];
    const BRANDS: &[&[u8; 4]] = &[
        b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6", b"iso7", b"iso8", b"iso9", b"mp41",
        b"mp42", b"avc1", b"dash", b"M4V ",
    ];
    fn walk(b: &[u8], top: bool, moov_seen: &mut bool) -> Result<(), String> {
        let mut at = 0;
        while at < b.len() {
            let size = u32::from_be_bytes(b[at..at + 4].try_into().unwrap()) as usize;
            let kind: &[u8; 4] = b[at + 4..at + 8].try_into().unwrap();
            if size < 8 || at + size > b.len() {
                return Err(format!("bad box size in {}", String::from_utf8_lossy(kind)));
            }
            if !ALLOWED.contains(&kind) || kind == b"udta" {
                return Err(format!("metadata: {}", String::from_utf8_lossy(kind)));
            }
            if top && kind == b"moov" {
                *moov_seen = true;
            }
            if top && kind == b"mdat" && !*moov_seen {
                return Err("moov atom not at front".into());
            }
            if CONTAINERS.contains(&kind) {
                walk(&b[at + 8..at + size], false, moov_seen)?;
            }
            at += size;
        }
        Ok(())
    }
    let bytes = std::fs::read(path).unwrap();
    if &bytes[4..8] != b"ftyp"
        || !bytes[8..bytes[3] as usize]
            .chunks_exact(4)
            .any(|c| BRANDS.iter().any(|b| *b == c))
    {
        return Err("unsupported container".into());
    }
    walk(&bytes, true, &mut false)?;
    let size = bytes.len() as u64;
    let mp4 = mp4::Mp4Reader::read_header(std::io::Cursor::new(&bytes), size)
        .map_err(|e| format!("mp4 crate: {e}"))?;
    if mp4.major_brand().to_string() == "qt  " {
        return Err("qt brand".into());
    }
    let (mut videos, mut audios) = (0, 0);
    for t in mp4.tracks().values() {
        match t.track_type().map_err(|e| e.to_string())? {
            mp4::TrackType::Video => {
                videos += 1;
                if t.media_type().map_err(|e| e.to_string())? != mp4::MediaType::H264 {
                    return Err("wrong video codec".into());
                }
                let secs = t.duration().as_millis() as f64 / 1000.0;
                if secs <= 0.0 || secs > 600.0 {
                    return Err(format!("duration {secs}"));
                }
                if t.width() > 3840 || t.height() > 2160 {
                    return Err("resolution".into());
                }
            }
            mp4::TrackType::Audio => {
                audios += 1;
                if t.media_type().map_err(|e| e.to_string())? != mp4::MediaType::AAC {
                    return Err("wrong audio codec".into());
                }
            }
            _ => return Err("extra track".into()),
        }
    }
    if videos != 1 || audios > 1 {
        return Err(format!("{videos} video and {audios} audio tracks"));
    }
    Ok(())
}
/// Every sample, read back through the relay's parser at the offsets the output declares.
fn read_samples(path: &Path, id: u32) -> Vec<Vec<u8>> {
    let bytes = std::fs::read(path).unwrap();
    let size = bytes.len() as u64;
    let mut mp4 = mp4::Mp4Reader::read_header(std::io::Cursor::new(&bytes), size).unwrap();
    let count = mp4.sample_count(id).unwrap();
    (1..=count)
        .map(|i| mp4.read_sample(id, i).unwrap().unwrap().bytes.to_vec())
        .collect()
}
fn run(dir: &Path, file: &Path, name: &str) -> Normalized {
    normalize_file(file, name, dir).unwrap_or_else(|e| panic!("{name} refused: {e}"))
}
#[track_caller]
fn assert_clean(n: &Normalized) {
    relay_accepts(&n.path).unwrap_or_else(|e| panic!("relay refuses {}: {e}", n.filename));
    let all = std::fs::read(&n.path).unwrap();
    for needle in [
        &b"SECRET"[..],
        b"+00.00",
        b"SecretHandler",
        &1_700_000_000u32.to_be_bytes(),
    ] {
        assert!(
            !all.windows(needle.len()).any(|w| w == needle),
            "{:?} survived",
            String::from_utf8_lossy(needle)
        );
    }
}
#[track_caller]
fn assert_samples(n: &Normalized, built: &Built) {
    for (id, want) in &built.keep {
        let got = read_samples(&n.path, *id);
        assert_eq!(got.len(), want.len(), "track {id}: sample count");
        assert!(
            got == *want,
            "track {id}: sample bytes differ, so an offset is wrong"
        );
    }
}

// ── Non-fast-start MP4 with metadata ────────────────────────────────────
#[test]
fn non_fast_start_mp4_with_metadata_is_rewritten_and_offsets_hold() {
    let d = tempfile::tempdir().unwrap();
    let tracks = [
        video(1, 640, 360, samples(0xA1, 40, 900)),
        audio(2, samples(0xB2, 60, 200)),
    ];
    let built = write_file(
        d.path(),
        "clip.mp4",
        &ftyp(b"isom", &[b"isom", b"mp42"]),
        &tracks,
        &camera_extras(),
        &[1, 2],
    );
    relay_accepts(&built.path).expect_err("the input must be refused, or this proves nothing");
    let n = run(d.path(), &built.path, "clip.mp4");
    assert_clean(&n);
    assert_samples(&n, &built);
    assert_eq!(n.filename, "clip.mp4");
    // Run again: same bytes, so a retried upload is the same blob.
    let again = run(d.path(), &built.path, "clip.mp4");
    assert_eq!(
        std::fs::read(&n.path).unwrap(),
        std::fs::read(&again.path).unwrap()
    );
    // Normalizing its own output keeps the samples and stays accepted.
    let twice = run(d.path(), &n.path, "clip.mp4");
    assert_clean(&twice);
    assert_samples(&twice, &built);
}

// ── A phone camera's MOV ────────────────────────────────────────────────
#[test]
fn camera_mov_becomes_mp4_with_only_its_picture_and_sound() {
    let d = tempfile::tempdir().unwrap();
    let mut v = video(1, 1920, 1080, samples(0xA1, 30, 1200));
    v.qt = true;
    // colr before avcC: the relay's parser wants avcC first or calls the file invalid.
    let colr = bx(b"colr", &[b"nclc", &[0, 1, 0, 1, 0, 1]]);
    let prof = bx(b"colr", &[b"prof", b"SECRETICC"]);
    let junk = bx(b"uuid", &[b"SECRETUUID000000"]);
    v.entry = visual_entry(b"avc1", 1920, 1080, &[colr, prof, avcc(), junk]);
    v.extra_trak = vec![
        bx(b"tapt", &[&bx(b"clef", &[&[0; 12]])]),
        bx(b"tref", &[&bx(b"tmcd", &[&[0, 0, 0, 3]])]),
        bx(b"udta", &[&bx(b"name", &[b"SECRETNAME"])]),
    ];
    let mut a = audio(2, samples(0xB2, 45, 180));
    a.qt = true;
    a.entry = mp4a_qt_v1();
    // A timed-metadata track holding GPS samples in mdat, and a timecode track.
    let mut gps = audio(
        3,
        vec![
            b"SECRET+00.00+000.00 fix 1".to_vec(),
            b"SECRET+00.00+000.00 fix 2".to_vec(),
        ],
    );
    gps.handler = *b"meta";
    gps.entry = bx(b"mebx", &[&[0, 0, 0, 0, 0, 0, 0, 1]]);
    gps.media_head = bx(b"nmhd", &[&[0; 4]]);
    gps.per_chunk = 1;
    let mut tc = audio(4, vec![vec![0x53, 0x45, 0x43, 0x52, 0x45, 0x54]]); // "SECRET" in a timecode sample
    tc.handler = *b"tmcd";
    tc.entry = bx(b"tmcd", &[&[0; 26]]);
    tc.media_head = bx(b"gmhd", &[&bx(b"gmin", &[&[0; 16]])]);
    tc.per_chunk = 1;
    let head = [ftyp(b"qt  ", &[b"qt  "]), bx(b"wide", &[])].concat();
    let built = write_file(
        d.path(),
        "IMG_0001.MOV",
        &head,
        &[v, a, gps, tc],
        &camera_extras(),
        &[1, 2],
    );
    relay_accepts(&built.path).expect_err("the input must be refused, or this proves nothing");
    let n = run(d.path(), &built.path, "IMG_0001.MOV");
    assert_clean(&n);
    assert_samples(&n, &built);
    assert_eq!(n.filename, "IMG_0001.mp4");
    // The decoder's setup came out of QuickTime's `wave` and into a plain `mp4a`: without it the sound won't play.
    let bytes = std::fs::read(&n.path).unwrap();
    let mp4 =
        mp4::Mp4Reader::read_header(std::io::Cursor::new(&bytes), bytes.len() as u64).unwrap();
    let sound = mp4.tracks().get(&2).unwrap();
    assert_eq!(
        sound.audio_profile().unwrap(),
        mp4::AudioObjectType::AacLowComplexity
    );
    assert_eq!(
        sound.sample_freq_index().unwrap(),
        mp4::SampleFreqIndex::Freq44100
    );
}

// ── M4A: the relay wants a picture, so it gets one still frame ──────────
#[test]
fn m4a_keeps_its_sound_and_gains_a_still_frame_the_relay_requires() {
    let d = tempfile::tempdir().unwrap();
    let a = audio(1, samples(0xB2, 200, 300));
    let built = write_file(
        d.path(),
        "voice memo.m4a",
        &ftyp(b"M4A ", &[b"M4A ", b"mp42", b"isom"]),
        &[a],
        &camera_extras(),
        &[1],
    );
    relay_accepts(&built.path).expect_err("the input must be refused, or this proves nothing");
    let n = run(d.path(), &built.path, "voice memo.m4a");
    assert_clean(&n);
    assert_samples(&n, &built);
    assert_eq!(
        n.filename, "voice memo.m4a",
        "named as sound, so the app shows an audio player"
    );
}

// ── Large files go through disk, not memory ─────────────────────────────
#[test]
fn a_file_over_50_mb_is_rewritten() {
    let d = tempfile::tempdir().unwrap();
    let tracks = [
        video(1, 1280, 720, samples(0xA1, 120, 480_000)),
        audio(2, samples(0xB2, 200, 400)),
    ];
    let built = write_file(
        d.path(),
        "big.mp4",
        &ftyp(b"mp42", &[b"mp42"]),
        &tracks,
        &camera_extras(),
        &[1, 2],
    );
    assert!(std::fs::metadata(&built.path).unwrap().len() > 50 * 1024 * 1024);
    let n = run(d.path(), &built.path, "big.mp4");
    assert_clean(&n);
    assert_samples(&n, &built);
}

// ── The other ways a file can hold its samples ─────────────────────────
#[test]
fn co64_stz2_and_several_mdats_are_read_correctly() {
    let d = tempfile::tempdir().unwrap();
    let mut v = video(1, 640, 360, samples(0xA1, 20, 500));
    v.co64 = true;
    v.stz2 = true;
    let mut a = audio(2, samples(0xB2, 20, 100));
    a.co64 = true;
    let built = write_file(
        d.path(),
        "c.mp4",
        &ftyp(b"isom", &[b"isom"]),
        &[v, a],
        &[],
        &[1, 2],
    );
    let n = run(d.path(), &built.path, "c.mp4");
    assert_clean(&n);
    assert_samples(&n, &built);
}

/// A hand-made fragmented file: empty sample tables in moov, samples in moof/mdat pairs (what MediaRecorder writes).
fn fragmented(dir: &Path, default_base_moof: bool) -> Built {
    let vs = samples(0xA1, 12, 700);
    let empty_stbl = |entry: &[u8]| {
        bx(
            b"stbl",
            &[
                &stsd(entry),
                &bx(b"stts", &[&u32s(&[0, 0])]),
                &bx(b"stsc", &[&u32s(&[0, 0])]),
                &bx(b"stsz", &[&u32s(&[0, 0, 0])]),
                &bx(b"stco", &[&u32s(&[0, 0])]),
            ],
        )
    };
    let trak = bx(
        b"trak",
        &[
            &tkhd(1, 0, 640, 360),
            &bx(
                b"mdia",
                &[
                    &mdhd(30000, 0),
                    &hdlr_iso(b"vide", "SecretHandlerName"),
                    &bx(
                        b"minf",
                        &[
                            &bx(b"vmhd", &[&[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]]),
                            &bx(
                                b"dinf",
                                &[&bx(
                                    b"dref",
                                    &[&[0, 0, 0, 0, 0, 0, 0, 1], &bx(b"url ", &[&[0, 0, 0, 1]])],
                                )],
                            ),
                            &empty_stbl(&visual_entry(b"avc1", 640, 360, &[avcc()])),
                        ],
                    ),
                ],
            ),
        ],
    );
    let trex = bx(b"trex", &[&u32s(&[0, 1, 1, 1000, 0, 0x0001_0000])]);
    let moov = bx(b"moov", &[&mvhd(1000, 0), &trak, &bx(b"mvex", &[&trex])]);
    let mut f = ftyp(b"isom", &[b"isom", b"iso5"]);
    f.extend_from_slice(&moov);
    for (i, group) in vs.chunks(4).enumerate() {
        let moof_start = f.len() as u64;
        // tfhd: default-base-is-moof, or an explicit base-data-offset
        let tfhd = if default_base_moof {
            bx(b"tfhd", &[&u32s(&[0x0002_0000, 1])])
        } else {
            let mut b = u32s(&[0x0000_0001, 1]);
            b.extend_from_slice(&moof_start.to_be_bytes());
            bx(b"tfhd", &[&b])
        };
        let mut tfdt = vec![1u8, 0, 0, 0];
        tfdt.extend_from_slice(&((i as u64) * 4000).to_be_bytes());
        let tfdt = bx(b"tfdt", &[&tfdt]);
        let trun_flags = 0x0000_0001u32 | 0x4 | 0x200; // data-offset, first-sample-flags, sizes
        let mut trun = u32s(&[trun_flags, group.len() as u32, 0, 0x0200_0000]);
        for s in group {
            trun.extend_from_slice(&(s.len() as u32).to_be_bytes());
        }
        let build = |offset: u32| {
            let mut t = trun.clone();
            t[8..12].copy_from_slice(&offset.to_be_bytes());
            bx(
                b"moof",
                &[
                    &bx(b"mfhd", &[&u32s(&[0, i as u32 + 1])]),
                    &bx(b"traf", &[&tfhd, &tfdt, &bx(b"trun", &[&t])]),
                ],
            )
        };
        let len = build(0).len() as u32;
        f.extend_from_slice(&build(len + 8));
        let body: Vec<u8> = group.concat();
        f.extend_from_slice(&bx(b"mdat", &[&body]));
    }
    let path = dir.join(if default_base_moof {
        "frag.mp4"
    } else {
        "frag2.mp4"
    });
    std::fs::write(&path, f).unwrap();
    Built {
        path,
        keep: vec![(1, vs)],
    }
}
#[test]
fn a_fragmented_recording_becomes_flat() {
    let d = tempfile::tempdir().unwrap();
    for base in [true, false] {
        let built = fragmented(d.path(), base);
        relay_accepts(&built.path).expect_err("the input must be refused, or this proves nothing");
        let n = run(d.path(), &built.path, "rec.mp4");
        assert_clean(&n);
        assert_samples(&n, &built);
        let bytes = std::fs::read(&n.path).unwrap();
        let mp4 =
            mp4::Mp4Reader::read_header(std::io::Cursor::new(&bytes), bytes.len() as u64).unwrap();
        let t = mp4.tracks().get(&1).unwrap();
        assert_eq!(t.duration().as_millis(), 400, "12 samples of 1000 at 30000");
    }
}

/// A file whose own clock doesn't start at zero, in fragments and in its edit list alike, still plays from its start.
#[test]
fn a_fragmented_clock_that_starts_late_is_brought_to_zero() {
    let d = tempfile::tempdir().unwrap();
    let built = fragmented(d.path(), true);
    let mut bytes = std::fs::read(&built.path).unwrap();
    // Move every tfdt on by 100 seconds, and say so in an edit list, as a stream cut from a longer one does.
    let mut at = 0;
    while let Some(p) = bytes[at..].windows(4).position(|w| w == b"tfdt") {
        let time = p + at + 8;
        let v = u64::from_be_bytes(bytes[time..time + 8].try_into().unwrap()) + 3_000_000;
        bytes[time..time + 8].copy_from_slice(&v.to_be_bytes());
        at = time + 8;
    }
    let mut elst = u32s(&[0, 1, 0, 3_000_000]);
    elst.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    let edts = bx(b"edts", &[&bx(b"elst", &[&elst])]);
    let trak = bytes.windows(4).position(|w| w == b"trak").unwrap() - 4;
    let moov = bytes.windows(4).position(|w| w == b"moov").unwrap() - 4;
    let tkhd_end = trak + 8 + 8 + 84;
    bytes.splice(tkhd_end..tkhd_end, edts.iter().copied());
    for box_at in [trak, moov] {
        let size =
            u32::from_be_bytes(bytes[box_at..box_at + 4].try_into().unwrap()) + edts.len() as u32;
        bytes[box_at..box_at + 4].copy_from_slice(&size.to_be_bytes());
    }
    std::fs::write(&built.path, bytes).unwrap();
    let n = run(d.path(), &built.path, "rec.mp4");
    assert_clean(&n);
    assert_samples(&n, &built);
    let out = std::fs::read(&n.path).unwrap();
    let mp4 = mp4::Mp4Reader::read_header(std::io::Cursor::new(&out), out.len() as u64).unwrap();
    assert!(mp4.duration().as_millis() >= 400, "{:?}", mp4.duration());
}

/// A recorder killed partway leaves a last fragment that stops short. What came before it plays, so it goes.
#[test]
fn a_recording_cut_off_mid_fragment_keeps_the_whole_fragments() {
    let d = tempfile::tempdir().unwrap();
    let built = fragmented(d.path(), true);
    let bytes = std::fs::read(&built.path).unwrap();
    std::fs::write(&built.path, &bytes[..bytes.len() - 900]).unwrap();
    let n = run(d.path(), &built.path, "rec.mp4");
    assert_clean(&n);
    let got = read_samples(&n.path, 1);
    assert_eq!(got.len(), 8, "the last of three fragments of four is cut");
    assert!(got[..] == built.keep[0].1[..8]);
}

/// Three stray bytes at the end of an index: players read past them, so it isn't damage.
#[test]
fn stray_bytes_after_the_last_box_are_not_damage() {
    let d = tempfile::tempdir().unwrap();
    let built = write_file(
        d.path(),
        "s.mp4",
        &ftyp(b"isom", &[b"isom"]),
        &[video(1, 640, 360, samples(0xA1, 4, 100))],
        &[],
        &[1],
    );
    let mut bytes = std::fs::read(&built.path).unwrap();
    let at = bytes.windows(4).position(|w| w == b"moov").unwrap() - 4;
    let size = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) + 3;
    bytes[at..at + 4].copy_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&[1, 2, 3]);
    std::fs::write(&built.path, bytes).unwrap();
    let n = run(d.path(), &built.path, "s.mp4");
    assert_samples(&n, &built);
}

// ── A file that can't be fixed says why, in one line ────────────────────
#[track_caller]
fn refused(d: &Path, file: &Path, name: &str) -> String {
    let e = match normalize_file(file, name, d) {
        Ok(n) => panic!("{name} was accepted as {}", n.filename),
        Err(e) => e.to_string(),
    };
    assert!(
        !e.contains('\n') && !e.contains('{') && !e.contains("media:"),
        "not one plain line: {e}"
    );
    e
}
#[test]
fn what_cant_be_fixed_is_refused_in_one_plain_line() {
    let d = tempfile::tempdir().unwrap();
    let head = ftyp(b"isom", &[b"isom"]);
    let mut hevc = video(1, 640, 360, samples(0xA1, 4, 100));
    hevc.entry = visual_entry(b"hvc1", 640, 360, &[bx(b"hvcC", &[&[1, 2, 3]])]);
    let f = write_file(d.path(), "h.mp4", &head, &[hevc], &[], &[]);
    assert!(refused(d.path(), &f.path, "h.mp4").contains("H.265"));

    let mut long = video(1, 640, 360, samples(0xA1, 4, 100));
    long.timescale = 1;
    long.delta = 200; // 800 seconds
    let f = write_file(d.path(), "l.mp4", &head, &[long], &[], &[]);
    assert!(refused(d.path(), &f.path, "l.mp4").contains("10 minutes"));

    let f = write_file(
        d.path(),
        "w.mp4",
        &head,
        &[video(1, 7680, 4320, samples(0xA1, 4, 100))],
        &[],
        &[],
    );
    assert!(refused(d.path(), &f.path, "w.mp4").contains("3840"));

    let mut pcm = audio(2, samples(0xB2, 4, 100));
    pcm.entry = bx(b"sowt", &[&[0; 28]]);
    let f = write_file(
        d.path(),
        "p.mov",
        &head,
        &[video(1, 640, 360, samples(0xA1, 4, 100)), pcm],
        &[],
        &[],
    );
    assert!(refused(d.path(), &f.path, "p.mov").contains("AAC"));

    // Sound just under the limit with a late start: its picture has to last until the sound ends, which is over it.
    let mut late = audio(1, samples(0xB2, 4, 100));
    late.timescale = 1;
    late.delta = 150; // 600 seconds of sound
    let mut f = write_file(d.path(), "n.m4a", &head, &[late], &[], &[]);
    {
        // The track header says longer than its media: a lead-in before the sound.
        let mut bytes = std::fs::read(&f.path).unwrap();
        let tk = bytes.windows(4).position(|w| w == b"tkhd").unwrap() + 4;
        bytes[tk + 20..tk + 24].copy_from_slice(&601_000u32.to_be_bytes());
        std::fs::write(&f.path, bytes).unwrap();
        f.keep.clear();
    }
    assert!(refused(d.path(), &f.path, "n.m4a").contains("10 minutes"));

    // Cut short: the samples moov promises aren't in the file.
    let f = write_file(
        d.path(),
        "t.mp4",
        &head,
        &[video(1, 640, 360, samples(0xA1, 40, 4000))],
        &[],
        &[],
    );
    let mut bytes = std::fs::read(&f.path).unwrap();
    let at = bytes.windows(4).position(|w| w == b"moov").unwrap() - 4;
    let moov = bytes.split_off(at);
    bytes.truncate(bytes.len() / 2);
    bytes.extend_from_slice(&moov);
    std::fs::write(&f.path, bytes).unwrap();
    assert!(refused(d.path(), &f.path, "t.mp4").contains("damaged"));

    // A moov cut short loses tracks without looking wrong: the sound would quietly go.
    let f = write_file(
        d.path(),
        "m.mp4",
        &head,
        &[
            video(1, 640, 360, samples(0xA1, 4, 100)),
            audio(2, samples(0xB2, 4, 100)),
        ],
        &[],
        &[],
    );
    let bytes = std::fs::read(&f.path).unwrap();
    std::fs::write(&f.path, &bytes[..bytes.len() - 300]).unwrap();
    assert!(refused(d.path(), &f.path, "m.mp4").contains("damaged"));

    let heic = d.path().join("p.heic");
    std::fs::write(
        &heic,
        [ftyp(b"heic", &[b"mif1", b"heic"]), bx(b"meta", &[&[0; 8]])].concat(),
    )
    .unwrap();
    assert!(refused(d.path(), &heic, "p.heic").contains("HEIC"));

    let mp3 = d.path().join("s.mp3");
    std::fs::write(
        &mp3,
        [
            &b"ID3\x03\0\0\0\0\0\0"[..],
            &[0xff, 0xfb, 0x90, 0x64],
            &[0; 400],
        ]
        .concat(),
    )
    .unwrap();
    assert!(refused(d.path(), &mp3, "s.mp3")
        .to_lowercase()
        .contains("mp3"));

    let exe = d.path().join("a.bin");
    std::fs::write(&exe, [&b"\x7fELF\x02\x01\x01\0"[..], &[0; 64]].concat()).unwrap();
    assert!(refused(d.path(), &exe, "a.bin").contains("program"));
}
#[test]
fn a_name_at_the_relay_limit_stays_within_it_when_its_extension_changes() {
    let d = tempfile::tempdir().unwrap();
    let f = write_file(
        d.path(),
        "c.mov",
        &ftyp(b"qt  ", &[b"qt  "]),
        &[video(1, 640, 360, samples(0xA1, 4, 100))],
        &[],
        &[],
    );
    let long = format!("{}.m", "é".repeat(126));
    assert!(long.len() <= 255);
    let n = run(d.path(), &f.path, &long);
    assert!(
        n.filename.len() <= 255 && n.filename.ends_with(".mp4"),
        "{} bytes: {}",
        n.filename.len(),
        n.filename
    );
}
#[test]
fn a_plain_document_passes_through_untouched() {
    let d = tempfile::tempdir().unwrap();
    let doc = d.path().join("notes.txt");
    std::fs::write(&doc, "made up notes\n").unwrap();
    let n = run(d.path(), &doc, "notes.txt");
    assert_eq!(n.path, doc);
    assert_eq!(n.filename, "notes.txt");
}

// ── Images ──────────────────────────────────────────────────────────────
fn webp_chunks(bytes: &[u8]) -> Vec<String> {
    let mut at = 12;
    let mut out = vec![];
    while at + 8 <= bytes.len() {
        out.push(String::from_utf8_lossy(&bytes[at..at + 4]).into_owned());
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        at += 8 + len + (len & 1);
    }
    out
}
fn webp_chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut c = kind.to_vec();
    c.extend_from_slice(&(body.len() as u32).to_le_bytes());
    c.extend_from_slice(body);
    if body.len() & 1 == 1 {
        c.push(0);
    }
    c
}
#[test]
fn animated_webp_loses_metadata_and_keeps_its_frames() {
    let d = tempfile::tempdir().unwrap();
    let vp8x = webp_chunk(b"VP8X", &[0x2e, 0, 0, 0, 15, 0, 0, 15, 0, 0]); // ICC, EXIF, XMP and animation flags
    let frame = [
        vec![0u8; 16],
        webp_chunk(b"VP8L", &[0x2f, 1, 2, 3]),
        webp_chunk(b"unkn", b"SECRET"),
    ]
    .concat();
    let body = [
        vp8x,
        webp_chunk(b"ICCP", b"SECRETICC!"),
        webp_chunk(b"ANIM", &[0; 6]),
        webp_chunk(b"ANMF", &frame),
        webp_chunk(b"EXIF", b"SECRETEXIF"),
        webp_chunk(b"XMP ", b"SECRETXMP"),
    ]
    .concat();
    let mut f = b"RIFF".to_vec();
    f.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
    f.extend_from_slice(b"WEBP");
    f.extend_from_slice(&body);
    f.extend_from_slice(b"trailing");
    let p = d.path().join("a.webp");
    std::fs::write(&p, f).unwrap();
    let n = run(d.path(), &p, "a.webp");
    let out = std::fs::read(&n.path).unwrap();
    assert_eq!(webp_chunks(&out), ["VP8X", "ANIM", "ANMF"]);
    assert_eq!(out[20] & 0x2c, 0, "metadata flags cleared");
    assert_eq!(out[20] & 0x02, 0x02, "still animated");
    assert_eq!(
        u32::from_le_bytes(out[4..8].try_into().unwrap()) as usize + 8,
        out.len()
    );
    assert!(!out.windows(6).any(|w| w == b"SECRET"));
}
#[test]
fn gif_loses_comments_and_keeps_frames_and_looping() {
    let d = tempfile::tempdir().unwrap();
    let mut g = b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff".to_vec();
    g.extend_from_slice(b"\x21\xff\x0bNETSCAPE2.0\x03\x01\0\0\0");
    g.extend_from_slice(b"\x21\xfe\x06SECRET\0");
    g.extend_from_slice(b"\x21\xff\x0bXMP DataXMP\x06SECRET\0");
    g.extend_from_slice(b"\x21\xf9\x04\0\x05\0\0\0");
    g.extend_from_slice(b"\x2c\0\0\0\0\x01\0\x01\0\0\x02\x02\x44\x01\0");
    g.extend_from_slice(b"\x21\x01\x0c\0\0\0\0\0\0\0\0\0\0\0\0\x06SECRET\0");
    g.push(0x3b);
    g.extend_from_slice(b"SECRET-after-the-trailer");
    let p = d.path().join("a.gif");
    std::fs::write(&p, g).unwrap();
    let n = run(d.path(), &p, "a.gif");
    let out = std::fs::read(&n.path).unwrap();
    assert!(!out.windows(6).any(|w| w == b"SECRET"));
    assert!(out.windows(11).any(|w| w == b"NETSCAPE2.0"));
    assert!(out.windows(4).any(|w| w == b"\x21\xf9\x04\0"));
    assert!(out.windows(10).any(|w| w == b"\x2c\0\0\0\0\x01\0\x01\0\0"));
    assert_eq!(out.last(), Some(&0x3b));
}
#[test]
fn a_photo_over_the_relay_pixel_limit_is_scaled_to_fit() {
    let d = tempfile::tempdir().unwrap();
    let img = image::RgbImage::from_pixel(7000, 4000, image::Rgb([40, 90, 200])); // 28 MP
    let p = d.path().join("big.jpg");
    img.save(&p).unwrap();
    let n = run(d.path(), &p, "big.jpg");
    let out = image::load_from_memory(&std::fs::read(&n.path).unwrap()).unwrap();
    assert!(
        u64::from(out.width()) * u64::from(out.height()) <= 25_000_000,
        "{}x{}",
        out.width(),
        out.height()
    );
    assert!(
        (f64::from(out.width()) / f64::from(out.height()) - 1.75).abs() < 0.01,
        "same shape"
    );
}

#[test]
fn an_animation_over_the_pixel_limit_says_so_before_the_upload() {
    let d = tempfile::tempdir().unwrap();
    let mut canvas = vec![0x02, 0, 0, 0];
    canvas.extend_from_slice(&5999u32.to_le_bytes()[..3]);
    canvas.extend_from_slice(&5999u32.to_le_bytes()[..3]);
    let body = [
        webp_chunk(b"VP8X", &canvas),
        webp_chunk(b"ANIM", &[0; 6]),
        webp_chunk(
            b"ANMF",
            &[vec![0u8; 16], webp_chunk(b"VP8L", &[0x2f, 1, 2, 3])].concat(),
        ),
    ]
    .concat();
    let mut f = b"RIFF".to_vec();
    f.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
    f.extend_from_slice(b"WEBP");
    f.extend_from_slice(&body);
    let p = d.path().join("a.webp");
    std::fs::write(&p, f).unwrap();
    assert!(refused(d.path(), &p, "a.webp").contains("25 megapixels"));
}

// ── Opus: the relay's two audio containers ─────────────────────────────
fn ogg_crc(b: &[u8]) -> u32 {
    let mut crc = 0u32;
    for (i, byte) in b.iter().enumerate() {
        let value = if (22..26).contains(&i) { 0 } else { *byte };
        crc ^= u32::from(value) << 24;
        for _ in 0..8 {
            crc = (crc << 1)
                ^ if crc & 0x8000_0000 != 0 {
                    0x04c1_1db7
                } else {
                    0
                };
        }
    }
    crc
}
fn ogg_page(flags: u8, seq: u32, packet: &[u8]) -> Vec<u8> {
    let mut lacing = vec![255u8; packet.len() / 255];
    lacing.push((packet.len() % 255) as u8);
    let mut p = b"OggS\0".to_vec();
    p.push(flags);
    p.extend_from_slice(&[0; 8]);
    p.extend_from_slice(&7u32.to_le_bytes());
    p.extend_from_slice(&seq.to_le_bytes());
    p.extend_from_slice(&[0; 4]);
    p.push(lacing.len() as u8);
    p.extend_from_slice(&lacing);
    p.extend_from_slice(packet);
    let crc = ogg_crc(&p);
    p[22..26].copy_from_slice(&crc.to_le_bytes());
    p
}
#[test]
fn ogg_opus_loses_its_tags_and_every_page_checks_out() {
    let d = tempfile::tempdir().unwrap();
    let head = b"OpusHead\x01\x01\x38\x01\x80\xbb\0\0\0\0\0".to_vec();
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&6u32.to_le_bytes());
    tags.extend_from_slice(b"SECRET");
    tags.extend_from_slice(&1u32.to_le_bytes());
    tags.extend_from_slice(&11u32.to_le_bytes());
    tags.extend_from_slice(b"TITLE=SECRE");
    let mut f = ogg_page(2, 0, &head);
    f.extend_from_slice(&ogg_page(0, 1, &tags));
    f.extend_from_slice(&ogg_page(0, 2, &[0xfc; 300]));
    f.extend_from_slice(&ogg_page(4, 3, &[0xfc; 80]));
    let p = d.path().join("v.ogg");
    std::fs::write(&p, f).unwrap();
    let n = run(d.path(), &p, "v.ogg");
    let out = std::fs::read(&n.path).unwrap();
    assert!(!out.windows(6).any(|w| w == b"SECRET"));
    let (mut at, mut seq, mut last_flags) = (0, 0u32, 0);
    while at < out.len() {
        assert_eq!(&out[at..at + 4], b"OggS");
        let segs = out[at + 26] as usize;
        let body: usize = out[at + 27..at + 27 + segs]
            .iter()
            .map(|v| *v as usize)
            .sum();
        let end = at + 27 + segs + body;
        assert_eq!(
            ogg_crc(&out[at..end]),
            u32::from_le_bytes(out[at + 22..at + 26].try_into().unwrap()),
            "page {seq} crc"
        );
        assert_eq!(
            u32::from_le_bytes(out[at + 18..at + 22].try_into().unwrap()),
            seq
        );
        last_flags = out[at + 5];
        seq += 1;
        at = end;
    }
    assert_eq!(seq, 4);
    assert_eq!(last_flags & 4, 4, "ends with end-of-stream");
}

// ── Real files from ffmpeg: packets identical, offsets right, it plays ──
/// ffmpeg with the encoders the real-file tests need. A build without them skips, like a machine without ffmpeg.
fn have_ffmpeg() -> bool {
    Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .is_ok_and(|o| {
            let list = String::from_utf8_lossy(&o.stdout).into_owned();
            o.status.success()
                && ["libx264", "libopus", " aac "]
                    .iter()
                    .all(|e| list.contains(e))
        })
}
fn ffmpeg(args: &[&str]) {
    let o = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .args(args)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}
/// Hash of every packet of the kept streams, without decoding: the same list means the same media in the same order.
fn packet_hashes(path: &Path, map: &str) -> String {
    let o = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args(["-map", map, "-c", "copy", "-f", "framemd5", "-"])
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    // Keep stream, dts, pts, duration, size and hash per packet. The comment header names the file's streams, and trailing
    // side data is the demuxer's trim note for the last audio packet, which a flat file's edit list makes explicit.
    String::from_utf8(o.stdout)
        .unwrap()
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(|l| l.split(',').take(6).collect::<Vec<_>>().join(","))
        .collect::<Vec<_>>()
        .join("\n")
}
/// What each kept stream declares to a decoder: profile, picture size and format, sound rate and channels.
fn stream_setup(path: &Path) -> String {
    let probe = |select: &str, fields: &str| {
        let o = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                select,
                "-show_entries",
                fields,
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .unwrap();
        // A file with a timecode lists its stream twice, the second under its program: the first says it all.
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .to_string()
    };
    format!(
        "{} / {}",
        probe("v:0", "stream=codec_name,profile,width,height,pix_fmt"),
        probe("a:0", "stream=codec_name,profile,sample_rate,channels")
    )
}
fn decodes(path: &Path) {
    let o = Command::new("ffmpeg")
        .args(["-hide_banner", "-v", "error", "-xerror", "-i"])
        .arg(path)
        .args(["-f", "null", "-"])
        .output()
        .unwrap();
    assert!(
        o.status.success() && o.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
}
#[test]
fn real_ffmpeg_files_keep_every_packet() {
    if !have_ffmpeg() {
        eprintln!("skipped: no ffmpeg here");
        return;
    }
    let d = tempfile::tempdir().unwrap();
    let src = [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=15:d=2",
        "-f",
        "lavfi",
        "-i",
        "sine=f=330:r=44100:d=2",
    ];
    let codecs = [
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a",
        "64k",
    ];
    let meta = [
        "-metadata",
        "title=SECRETTITLE",
        "-metadata",
        "location=+00.00+000.00/",
    ];
    let cases: Vec<(&str, Vec<&str>)> = vec![
        ("plain.mp4", vec![]),
        (
            "frag.mp4",
            vec!["-movflags", "frag_keyframe+empty_moov+default_base_moof"],
        ),
        ("frag2.mp4", vec!["-movflags", "frag_keyframe+empty_moov"]),
        (
            "cam.mov",
            vec![
                "-timecode",
                "01:02:03:04",
                "-movflags",
                "use_metadata_tags",
                "-f",
                "mov",
            ],
        ),
    ];
    for (name, extra) in cases {
        let input = d.path().join(name);
        let mut args: Vec<&str> = src.to_vec();
        args.extend_from_slice(&codecs);
        args.extend_from_slice(&meta);
        args.extend_from_slice(&extra);
        args.push(input.to_str().unwrap());
        ffmpeg(&args);
        let n = run(d.path(), &input, name);
        relay_accepts(&n.path).unwrap_or_else(|e| panic!("{name}: {e}"));
        decodes(&n.path);
        for map in ["0:v:0", "0:a:0"] {
            let (a, b) = (packet_hashes(&input, map), packet_hashes(&n.path, map));
            if a != b {
                let diff: Vec<_> = a
                    .lines()
                    .zip(b.lines())
                    .filter(|(x, y)| x != y)
                    .take(3)
                    .collect();
                panic!(
                    "{name} {map}: {} vs {} packets; first differences {diff:#?}",
                    a.lines().count(),
                    b.lines().count()
                );
            }
        }
        assert!(
            !std::fs::read(&n.path)
                .unwrap()
                .windows(6)
                .any(|w| w == b"SECRET"),
            "{name}"
        );
        assert_eq!(
            stream_setup(&input),
            stream_setup(&n.path),
            "{name}: how a decoder is told to read it"
        );
    }
    // Samples in moov *and* moof: nothing lost. ffmpeg writes this for plain frag_keyframe.
    let base = d.path().join("base.mp4");
    let mut args: Vec<&str> = src.to_vec();
    args.extend_from_slice(&codecs);
    args.extend_from_slice(&["-g", "5"]); // keyframes to fragment at
    args.push(base.to_str().unwrap());
    ffmpeg(&args);
    let hybrid = d.path().join("hybrid.mp4");
    ffmpeg(&[
        "-i",
        base.to_str().unwrap(),
        "-c",
        "copy",
        "-movflags",
        "frag_keyframe",
        hybrid.to_str().unwrap(),
    ]);
    let n = run(d.path(), &hybrid, "hybrid.mp4");
    relay_accepts(&n.path).unwrap();
    for map in ["0:v:0", "0:a:0"] {
        assert_eq!(
            packet_hashes(&hybrid, map),
            packet_hashes(&n.path, map),
            "hybrid {map}"
        );
    }
    // The same with a timecode track, which isn't kept and lists its one sample in moov.
    let timed = d.path().join("timed.mp4");
    ffmpeg(&[
        "-i",
        base.to_str().unwrap(),
        "-c",
        "copy",
        "-timecode",
        "01:00:00:00",
        "-movflags",
        "frag_keyframe",
        timed.to_str().unwrap(),
    ]);
    let n = run(d.path(), &timed, "timed.mp4");
    relay_accepts(&n.path).unwrap();
    for map in ["0:v:0", "0:a:0"] {
        assert_eq!(
            packet_hashes(&timed, map),
            packet_hashes(&n.path, map),
            "timed {map}"
        );
    }
    // B-frames in a fragmented file: the edit reaches the last frame shown, not the last one decoded.
    let bframes = d.path().join("bframes.mp4");
    ffmpeg(&[
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=30:d=2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-bf",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "frag_keyframe+empty_moov+delay_moov",
        bframes.to_str().unwrap(),
    ]);
    let n = run(d.path(), &bframes, "bframes.mp4");
    let frames = |p: &Path| {
        let o = Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(p)
            .args(["-map", "0:v", "-f", "framecrc", "-"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|l| !l.starts_with('#'))
            .count()
    };
    assert_eq!(frames(&bframes), frames(&n.path), "frames shown");
    // Sound that starts late, said by a leading empty edit in a fragmented file: still late, so still in sync.
    let late = d.path().join("late.mp4");
    let b = base.to_str().unwrap();
    ffmpeg(&[
        "-i",
        b,
        "-itsoffset",
        "1.5",
        "-i",
        b,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c",
        "copy",
        "-movflags",
        "frag_keyframe+empty_moov+delay_moov",
        late.to_str().unwrap(),
    ]);
    let n = run(d.path(), &late, "late.mp4");
    relay_accepts(&n.path).unwrap();
    let first_pts = |p: &Path| {
        let o = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "packet=pts_time",
                "-read_intervals",
                "%+#1",
                "-of",
                "csv=p=0",
            ])
            .arg(p)
            .output()
            .unwrap();
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .next()
            .unwrap_or("")
            .trim_end_matches(',')
            .parse::<f64>()
            .unwrap()
    };
    let (before, after) = (first_pts(&late), first_pts(&n.path));
    assert!(
        before > 1.0,
        "the input must start late, or this proves nothing: {before}"
    );
    assert!(
        (before - after).abs() < 0.03,
        "sound moved from {before} to {after}"
    );
    // M4A, moov last: sound identical, and the still frame decodes.
    let input = d.path().join("a.m4a");
    ffmpeg(&[
        "-f",
        "lavfi",
        "-i",
        "sine=f=330:r=44100:d=3",
        "-c:a",
        "aac",
        "-metadata",
        "title=SECRETTITLE",
        "-f",
        "ipod",
        input.to_str().unwrap(),
    ]);
    let n = run(d.path(), &input, "a.m4a");
    relay_accepts(&n.path).unwrap();
    decodes(&n.path);
    assert_eq!(
        packet_hashes(&input, "0:a:0"),
        packet_hashes(&n.path, "0:a:0")
    );
    let probe = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,duration",
            "-of",
            "csv=p=0",
        ])
        .arg(&n.path)
        .output()
        .unwrap();
    let text = String::from_utf8(probe.stdout).unwrap();
    assert!(text.contains("h264") && text.contains("aac"), "{text}");
}
#[test]
fn real_tagged_webm_and_ogg_lose_tags_and_keep_every_packet() {
    if !have_ffmpeg() {
        eprintln!("skipped: no ffmpeg here");
        return;
    }
    let d = tempfile::tempdir().unwrap();
    for name in ["t.webm", "t.ogg"] {
        let input = d.path().join(name);
        ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            "sine=f=300:r=48000:d=2",
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            "-metadata",
            "title=SECRETTITLE",
            input.to_str().unwrap(),
        ]);
        let n = run(d.path(), &input, name);
        assert_eq!(
            packet_hashes(&input, "0:a:0").lines().count(),
            packet_hashes(&n.path, "0:a:0").lines().count()
        );
        let hashes = |p: &Path| {
            packet_hashes(p, "0:a:0")
                .lines()
                .map(|l| l.rsplit(',').next().unwrap().trim().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(hashes(&input), hashes(&n.path), "{name}");
        assert!(
            !std::fs::read(&n.path)
                .unwrap()
                .windows(6)
                .any(|w| w == b"SECRET"),
            "{name}"
        );
        decodes(&n.path);
    }
}

#[test]
fn other_ogg_and_cut_webm_get_the_right_reason() {
    let d = tempfile::tempdir().unwrap();
    // Vorbis keeps its comments and setup on one page; the reason is the codec, not damage.
    let mut f = ogg_page(
        2,
        0,
        b"\x01vorbis\0\0\0\0\x01\x44\xac\0\0\0\0\0\0\0\0\0\0\0\0\xb8\x01",
    );
    let both = {
        let mut p = b"OggS\0\x04".to_vec();
        p.extend_from_slice(&[0; 8]);
        p.extend_from_slice(&7u32.to_le_bytes());
        p.extend_from_slice(&1u32.to_le_bytes());
        p.extend_from_slice(&[0; 4]);
        p.extend_from_slice(&[2, 7, 7]); // two packets on one page
        p.extend_from_slice(b"\x03vorbis\x05vorbis");
        let crc = ogg_crc(&p);
        p[22..26].copy_from_slice(&crc.to_le_bytes());
        p
    };
    f.extend_from_slice(&both);
    let p = d.path().join("v.ogg");
    std::fs::write(&p, f).unwrap();
    assert!(refused(d.path(), &p, "v.ogg").contains("isn't Opus"));
    if have_ffmpeg() {
        let w = d.path().join("c.webm");
        ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            "sine=d=1",
            "-c:a",
            "libopus",
            w.to_str().unwrap(),
        ]);
        let bytes = std::fs::read(&w).unwrap();
        let tracks = bytes
            .windows(4)
            .position(|x| x == [0x16, 0x54, 0xae, 0x6b])
            .unwrap();
        std::fs::write(&w, &bytes[..tracks + 12]).unwrap();
        assert!(refused(d.path(), &w, "c.webm").contains("damaged"));
    }
}
#[test]
fn ogg_opus_with_cover_art_in_its_tags_loses_the_art() {
    let d = tempfile::tempdir().unwrap();
    let head = b"OpusHead\x01\x01\x38\x01\x80\xbb\0\0\0\0\0".to_vec();
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&6u32.to_le_bytes());
    tags.extend_from_slice(b"SECRET");
    tags.extend_from_slice(&1u32.to_le_bytes());
    let art = vec![b'A'; 200_000];
    tags.extend_from_slice(&(art.len() as u32).to_le_bytes());
    tags.extend_from_slice(&art);
    // A comment this big spans pages: full ones of 255-byte segments, then the end of the packet.
    let mut f = ogg_page(2, 0, &head);
    let chunks: Vec<&[u8]> = tags.chunks(255 * 255).collect();
    let mut seq = 1;
    for (i, c) in chunks.iter().enumerate() {
        let continued = u8::from(i > 0);
        let lacing_full = c.len() == 255 * 255;
        let mut lacing = vec![255u8; c.len() / 255];
        if !lacing_full {
            lacing.push((c.len() % 255) as u8);
        }
        let mut p = b"OggS\0".to_vec();
        p.push(continued);
        p.extend_from_slice(&[0; 8]);
        p.extend_from_slice(&7u32.to_le_bytes());
        p.extend_from_slice(&(seq as u32).to_le_bytes());
        p.extend_from_slice(&[0; 4]);
        p.push(lacing.len() as u8);
        p.extend_from_slice(&lacing);
        p.extend_from_slice(c);
        let crc = ogg_crc(&p);
        p[22..26].copy_from_slice(&crc.to_le_bytes());
        f.extend_from_slice(&p);
        seq += 1;
    }
    f.extend_from_slice(&ogg_page(4, seq as u32, &[0xfc; 80]));
    let p = d.path().join("v.ogg");
    std::fs::write(&p, f).unwrap();
    let n = run(d.path(), &p, "v.ogg");
    let out = std::fs::read(&n.path).unwrap();
    assert!(out.len() < 400, "{} bytes", out.len());
    assert!(!out.windows(6).any(|w| w == b"SECRET"));
    assert!(out.windows(8).any(|w| w == b"OpusTags"));
}

/// A fragment whose clock restarts from zero isn't an overlap: samples keep their durations, so the length survives.
#[test]
fn a_fragment_clock_that_restarts_keeps_every_sample_its_length() {
    let d = tempfile::tempdir().unwrap();
    let built = fragmented(d.path(), true);
    let mut bytes = std::fs::read(&built.path).unwrap();
    let last = bytes.windows(4).rposition(|w| w == b"tfdt").unwrap() + 8;
    bytes[last..last + 8].copy_from_slice(&0u64.to_be_bytes());
    std::fs::write(&built.path, bytes).unwrap();
    let n = run(d.path(), &built.path, "rec.mp4");
    assert_samples(&n, &built);
    let out = std::fs::read(&n.path).unwrap();
    let mp4 = mp4::Mp4Reader::read_header(std::io::Cursor::new(&out), out.len() as u64).unwrap();
    assert_eq!(mp4.tracks().get(&1).unwrap().duration().as_millis(), 400);
}

/// A recorder killed partway, cut at every late byte: the audio before the cut still goes, and only whole blocks with it.
#[test]
fn a_webm_recording_cut_anywhere_keeps_its_whole_blocks() {
    let d = tempfile::tempdir().unwrap();
    let real = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/examples/testdata/voice_chrome_mediarecorder.webm"
    ))
    .unwrap();
    let p = d.path().join("v.webm");
    let blocks = |b: &[u8]| {
        // Count SimpleBlocks by walking the rewritten file, whose sizes are all known.
        let at = b
            .windows(4)
            .position(|w| w == [0x1f, 0x43, 0xb6, 0x75])
            .unwrap();
        b[at..].windows(2).filter(|w| *w == [0xa3, 0x01]).count()
            + b[at..]
                .windows(2)
                .filter(|w| w[0] == 0xa3 && w[1] >= 0x81 && w[1] < 0xff)
                .count()
    };
    std::fs::write(&p, &real).unwrap();
    let whole = blocks(&std::fs::read(run(d.path(), &p, "v.webm").path).unwrap());
    assert!(whole > 5);
    for cut in 1..=40 {
        std::fs::write(&p, &real[..real.len() - cut]).unwrap();
        let n = run(d.path(), &p, "v.webm");
        let out = std::fs::read(&n.path).unwrap();
        assert!(blocks(&out) > 2, "cut {cut}: the audio before it went too");
        if have_ffmpeg() {
            let o = Command::new("ffmpeg")
                .args(["-v", "error", "-xerror", "-i"])
                .arg(&n.path)
                .args(["-f", "null", "-"])
                .output()
                .unwrap();
            assert!(
                o.status.success() && o.stderr.is_empty(),
                "cut {cut}: {}",
                String::from_utf8_lossy(&o.stderr)
            );
        }
    }
}

/// The same for Ogg: a last page that leaves its packet open drops back to the last one that closes.
#[test]
fn an_ogg_recording_cut_after_an_open_packet_keeps_what_came_before() {
    let d = tempfile::tempdir().unwrap();
    let head = b"OpusHead\x01\x01\x38\x01\x80\xbb\0\0\0\0\0".to_vec();
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&7u32.to_le_bytes());
    tags.extend_from_slice(b"libopus");
    tags.extend_from_slice(&0u32.to_le_bytes());
    let mut f = ogg_page(2, 0, &head);
    f.extend_from_slice(&ogg_page(0, 1, &tags));
    f.extend_from_slice(&ogg_page(0, 2, &[0xfc; 80]));
    // A page of one full segment: its packet goes on in a page that never came.
    let mut open = b"OggS\0\0".to_vec();
    open.extend_from_slice(&[0; 8]);
    open.extend_from_slice(&7u32.to_le_bytes());
    open.extend_from_slice(&3u32.to_le_bytes());
    open.extend_from_slice(&[0; 4]);
    open.extend_from_slice(&[1, 255]);
    open.extend_from_slice(&[0xfc; 255]);
    let crc = ogg_crc(&open);
    open[22..26].copy_from_slice(&crc.to_le_bytes());
    f.extend_from_slice(&open);
    let p = d.path().join("v.ogg");
    std::fs::write(&p, f).unwrap();
    let n = run(d.path(), &p, "v.ogg");
    let out = std::fs::read(&n.path).unwrap();
    assert_eq!(
        out.windows(4).filter(|w| *w == b"OggS").count(),
        3,
        "head, tags and the one whole audio page"
    );
}

/// A second sound track with tables that don't add up is never copied, so it can't sink the picture and sound beside it.
#[test]
fn a_broken_track_that_wont_be_kept_does_not_sink_the_file() {
    let d = tempfile::tempdir().unwrap();
    let mut bad = audio(3, samples(0xC3, 8, 100));
    bad.per_chunk = 1;
    let tracks = [
        video(1, 640, 360, samples(0xA1, 8, 200)),
        audio(2, samples(0xB2, 8, 100)),
        bad,
    ];
    let built = write_file(
        d.path(),
        "b.mp4",
        &ftyp(b"isom", &[b"isom"]),
        &tracks,
        &[],
        &[1, 2],
    );
    let mut bytes = std::fs::read(&built.path).unwrap();
    // Track 3's samples-per-chunk row: say its samples use a second description, which is never written.
    let third = bytes
        .windows(4)
        .enumerate()
        .filter(|(_, w)| *w == b"stsc")
        .map(|(i, _)| i)
        .nth(2)
        .unwrap();
    bytes[third + 4 + 4 + 4 + 8..third + 4 + 4 + 4 + 12].copy_from_slice(&2u32.to_be_bytes());
    std::fs::write(&built.path, bytes).unwrap();
    let n = run(d.path(), &built.path, "b.mp4");
    assert_clean(&n);
    assert_samples(&n, &built);
    // The same fault on the only sound there is still says so.
    let mut only = audio(2, samples(0xB2, 8, 100));
    only.per_chunk = 1;
    let built = write_file(
        d.path(),
        "c.mp4",
        &ftyp(b"isom", &[b"isom"]),
        &[video(1, 640, 360, samples(0xA1, 8, 200)), only],
        &[],
        &[],
    );
    let mut bytes = std::fs::read(&built.path).unwrap();
    let second = bytes
        .windows(4)
        .enumerate()
        .filter(|(_, w)| *w == b"stsc")
        .map(|(i, _)| i)
        .nth(1)
        .unwrap();
    bytes[second + 4 + 4 + 4 + 8..second + 4 + 4 + 4 + 12].copy_from_slice(&2u32.to_be_bytes());
    std::fs::write(&built.path, bytes).unwrap();
    assert!(refused(d.path(), &built.path, "c.mp4").contains("changes format"));
}

/// ISO's own version 1 sound entry has QuickTime's version number and none of its extra fields.
#[test]
fn an_iso_version_1_sound_entry_is_read() {
    let d = tempfile::tempdir().unwrap();
    let mut a = audio(2, samples(0xB2, 8, 100));
    let mut b = vec![0u8; 28];
    b[7] = 1;
    b[9] = 1; // version 1
    b[17] = 2;
    b[19] = 16;
    b[24..28].copy_from_slice(&(44100u32 << 16).to_be_bytes());
    b.extend_from_slice(&esds());
    a.entry = bx(b"mp4a", &[&b]);
    let built = write_file(
        d.path(),
        "v1.mp4",
        &ftyp(b"isom", &[b"isom"]),
        &[video(1, 640, 360, samples(0xA1, 8, 200)), a],
        &[],
        &[1, 2],
    );
    let n = run(d.path(), &built.path, "v1.mp4");
    assert_clean(&n);
    assert_samples(&n, &built);
}

/// EXIF can turn a PNG too: it has to be baked in before the EXIF goes, as for a JPEG.
#[test]
fn a_png_turned_by_exif_stays_turned() {
    let d = tempfile::tempdir().unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::RgbImage::new(4, 2)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let mut png = png.into_inner();
    // Big-endian TIFF with one tag: orientation 6, rotate 90.
    let exif = [
        &b"MM\0*\0\0\0\x08\0\x01"[..],
        &[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0],
        &[0, 0, 0, 0],
    ]
    .concat();
    let mut chunk = (exif.len() as u32).to_be_bytes().to_vec();
    let body = [&b"eXIf"[..], &exif].concat();
    chunk.extend_from_slice(&body);
    chunk.extend_from_slice(&crc32fast::hash(&body).to_be_bytes());
    png.splice(33..33, chunk);
    let p = d.path().join("t.png");
    std::fs::write(&p, &png).unwrap();
    let n = run(d.path(), &p, "t.png");
    let out = std::fs::read(&n.path).unwrap();
    assert!(!out.windows(4).any(|w| w == b"eXIf"));
    let img = image::load_from_memory(&out).unwrap();
    assert_eq!((img.width(), img.height()), (2, 4));
}

/// A still photo that doesn't name itself first: the brand list, then the rest of ftyp, say what it is.
#[test]
fn still_image_brands_get_their_own_line() {
    let d = tempfile::tempdir().unwrap();
    for (major, compat) in [(b"hevm", &[b"mif1"]), (b"abcd", &[b"heic"])] {
        let p = d.path().join("p.heic");
        std::fs::write(&p, [ftyp(major, compat), bx(b"meta", &[&[0; 8]])].concat()).unwrap();
        assert!(
            refused(d.path(), &p, "p.heic").contains("HEIC"),
            "{:?}",
            major
        );
    }
}

/// Damage partway isn't a killed recorder: quietly sending what came before would lose the rest of the recording.
#[test]
fn damage_partway_is_refused_and_never_sent_shortened() {
    let d = tempfile::tempdir().unwrap();
    // Ogg: a good page, garbage, then pages that would be lost.
    let head = b"OpusHead\x01\x01\x38\x01\x80\xbb\0\0\0\0\0".to_vec();
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&7u32.to_le_bytes());
    tags.extend_from_slice(b"libopus");
    tags.extend_from_slice(&0u32.to_le_bytes());
    let mut f = ogg_page(2, 0, &head);
    f.extend_from_slice(&ogg_page(0, 1, &tags));
    f.extend_from_slice(&ogg_page(0, 2, &[0xfc; 80]));
    f.extend_from_slice(&vec![0x55; 8192]);
    for seq in 3..40 {
        f.extend_from_slice(&ogg_page(if seq == 39 { 4 } else { 0 }, seq, &[0xfc; 200]));
    }
    let p = d.path().join("v.ogg");
    std::fs::write(&p, f).unwrap();
    assert!(refused(d.path(), &p, "v.ogg").contains("damaged"));

    // WebM: an early block whose size is corrupt, running on past the rest of the recording.
    let mut w = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/examples/testdata/voice_chrome_mediarecorder.webm"
    ))
    .unwrap();
    let cluster = w
        .windows(4)
        .position(|x| x == [0x1f, 0x43, 0xb6, 0x75])
        .unwrap();
    // Past the first few, so that whole audio comes before the fault and it can't be mistaken for an empty file.
    let mut block = cluster + w[cluster..].iter().position(|b| *b == 0xa3).unwrap();
    for _ in 0..8 {
        assert_eq!(w[block], 0xa3);
        assert_eq!(
            w[block + 1] & 0xc0,
            0x40,
            "a two-byte size, to overwrite in place"
        );
        block += 3 + ((usize::from(w[block + 1] & 0x3f) << 8) | usize::from(w[block + 2]));
    }
    assert!(w.len() - block > 4096, "more than a cut would leave");
    w[block + 1] = 0x7f;
    w[block + 2] = 0xfe;
    let p = d.path().join("w.webm");
    std::fs::write(&p, w).unwrap();
    assert!(refused(d.path(), &p, "w.webm").contains("damaged"));

    // Fragmented MP4: a bad box size between fragments, with more fragments after it.
    let built = fragmented(d.path(), true);
    let mut bytes = std::fs::read(&built.path).unwrap();
    let second = bytes
        .windows(4)
        .enumerate()
        .filter(|(_, w)| *w == b"moof")
        .map(|(i, _)| i)
        .nth(1)
        .unwrap()
        - 4;
    bytes[second..second + 4].copy_from_slice(&3u32.to_be_bytes());
    bytes.extend_from_slice(&vec![0x55; 8192]);
    std::fs::write(&built.path, bytes).unwrap();
    assert!(refused(d.path(), &built.path, "rec.mp4").contains("damaged"));
}
