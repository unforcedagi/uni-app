//! Whether a file's bytes are one whole, well-formed file of a type (T-45).
//!
//! A file's first bytes only say what it claims to be: a PNG signature
//! followed by anything, the start of a PDF, a zip's first entry. These
//! checks walk each format's structure to its end, so a truncated file, one
//! with something appended after its end, or one whose parts don't chain is
//! refused. They don't decode pixels or sound.
//!
//! Zip-based documents are read with the `zip` crate inside limits (entries,
//! declared sizes, compression ratio, overlapping entries), and the parts
//! that say what a document holds are decompressed and parsed as XML: an
//! Office file's content types, every relationship and every XML part's field
//! codes (found by content type and by bytes, not by name), an OpenDocument's
//! manifest and every attribute of its XML parts. RTF is read in one pass with
//! a bound on its work.

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};

use quick_xml::events::Event;

use quick_xml::XmlVersion;
use zip::{CompressionMethod, ZipArchive};

/// What a zip-based document turned out to be.
#[derive(Debug, PartialEq)]
pub enum Doc {
    Fine,
    /// Macros, an embedded object or control, a field (any Word field in an Office file, any RTF field but a
    /// web or mail link, DDE in OpenDocument), or something fetched from outside.
    Active,
    /// Not a whole, well-formed file of its type (or too big to check).
    Broken,
}

fn be16(b: &[u8], i: usize) -> Option<usize> {
    b.get(i..i.checked_add(2)?).map(|x| u16::from_be_bytes([x[0], x[1]]) as usize)
}

fn le16(b: &[u8], i: usize) -> Option<usize> {
    b.get(i..i.checked_add(2)?).map(|x| u16::from_le_bytes([x[0], x[1]]) as usize)
}

fn be32(b: &[u8], i: usize) -> Option<u32> {
    b.get(i..i.checked_add(4)?).map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]]))
}

fn le32(b: &[u8], i: usize) -> Option<u32> {
    b.get(i..i.checked_add(4)?).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]))
}

fn le64(b: &[u8], i: usize) -> Option<u64> {
    b.get(i..i.checked_add(8)?).map(|x| u64::from_le_bytes(x.try_into().unwrap()))
}

fn be64(b: &[u8], i: usize) -> Option<u64> {
    b.get(i..i.checked_add(8)?).map(|x| u64::from_be_bytes(x.try_into().unwrap()))
}

/// Signature, `IHDR` first, at least one `IDAT`, every chunk's CRC right, and `IEND` the last bytes.
pub fn png(b: &[u8]) -> bool {
    if !b.starts_with(b"\x89PNG\r\n\x1a\n") {
        return false;
    }
    let (mut at, mut data) = (8, false);
    loop {
        let Some(len) = be32(b, at).filter(|l| *l <= 0x7FFF_FFFF) else { return false };
        let Some(end) = at.checked_add(12 + len as usize).filter(|e| *e <= b.len()) else { return false };
        let kind = &b[at + 4..at + 8];
        if crc32fast::hash(&b[at + 4..end - 4]) != be32(b, end - 4).unwrap() || (at == 8 && (kind != b"IHDR" || len != 13)) {
            return false;
        }
        data |= kind == b"IDAT";
        if kind == b"IEND" {
            return data && len == 0 && end == b.len();
        }
        at = end;
    }
}

/// One or more whole JPEGs back to back: a phone's multi-picture or HDR photo (CIPA MPF, Ultra HDR, ISO gain
/// maps) puts more pictures after the first one's `EOI`. Nothing else may follow.
pub fn jpeg(b: &[u8]) -> bool {
    let mut at = 0;
    for _ in 0..16 {
        match jpeg_end(&b[at..]) {
            Some(end) if at + end == b.len() => return true,
            Some(end) => at += end,
            None => return false,
        }
    }
    false
}

/// Where the JPEG at the start of `b` ends: `SOI`, marker segments chaining to a scan after a frame header, then
/// the scan data (and any later segments and scans) up to the first `EOI`.
fn jpeg_end(b: &[u8]) -> Option<usize> {
    if !b.starts_with(b"\xFF\xD8") {
        return None;
    }
    let (mut at, mut frame, mut scan) = (2, false, false);
    loop {
        if scan {
            // entropy-coded data: FF 00 is a stuffed byte, FF D0-D7 a restart, FF FF fill; any other FF is a marker
            at += memchr::memchr(0xFF, &b[at..])?;
            if matches!(b.get(at + 1)?, 0x00 | 0xD0..=0xD7 | 0xFF) {
                at += 1;
                continue;
            }
        }
        if b.get(at) != Some(&0xFF) {
            return None;
        }
        while b.get(at + 1) == Some(&0xFF) {
            at += 1; // fill bytes
        }
        let marker = *b.get(at + 1)?;
        if marker == 0xD9 {
            return scan.then_some(at + 2);
        }
        // nothing standalone, and no second SOI
        if matches!(marker, 0x00 | 0x01 | 0xD0..=0xD8) {
            return None;
        }
        let len = be16(b, at + 2).filter(|l| *l >= 2)?;
        let end = at + 2 + len;
        if end > b.len() {
            return None;
        }
        frame |= matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if marker == 0xDA {
            if !frame {
                return None;
            }
            scan = true;
        }
        at = end;
    }
}

/// Header, screen descriptor and colour table, then extension and image blocks to the trailer, the last byte.
pub fn gif(b: &[u8]) -> bool {
    if !(b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a")) {
        return false;
    }
    let table = |packed: u8| if packed & 0x80 != 0 { 3usize << ((packed & 7) + 1) } else { 0 };
    // data sub-blocks up to the empty one; the offset after it
    let blocks = |mut at: usize| -> Option<usize> {
        loop {
            let n = *b.get(at)? as usize;
            at += 1 + n;
            if n == 0 {
                return Some(at);
            }
        }
    };
    let Some(&packed) = b.get(10) else { return false };
    let (mut at, mut image) = (13 + table(packed), false);
    loop {
        let next = match b.get(at) {
            Some(0x3B) => return image && at + 1 == b.len(),
            Some(0x21) => blocks(at + 2),
            Some(0x2C) => b.get(at + 9).and_then(|p| {
                let lzw = at + 10 + table(*p);
                b.get(lzw)?;
                blocks(lzw + 1)
            }),
            _ => None,
        };
        let Some(next) = next else { return false };
        image |= b[at] == 0x2C;
        at = next;
    }
}

/// A RIFF file of `form` whose size field is the file's and whose chunks chain to its end; their ids.
fn riff(b: &[u8], form: &[u8; 4]) -> Option<Vec<[u8; 4]>> {
    if !b.starts_with(b"RIFF") || b.get(8..12)? != form || le32(b, 4)? as usize != b.len() - 8 {
        return None;
    }
    let (mut at, mut ids) = (12, Vec::new());
    while at < b.len() {
        let id: [u8; 4] = b.get(at..at + 4)?.try_into().ok()?;
        let len = le32(b, at + 4)? as usize;
        let data_end = at.checked_add(8 + len).filter(|e| *e <= b.len())?;
        // an odd chunk is padded to even, except that some writers drop the last pad byte
        at = if data_end == b.len() { data_end } else { data_end + (len & 1) };
        ids.push(id);
    }
    (at == b.len() && !ids.is_empty()).then_some(ids)
}

pub fn webp(b: &[u8]) -> bool {
    riff(b, b"WEBP").is_some_and(|ids| match &ids[0] {
        b"VP8 " | b"VP8L" => true,
        b"VP8X" => ids.iter().any(|i| matches!(i, b"VP8 " | b"VP8L" | b"ANMF")),
        _ => false,
    })
}

pub fn wav(b: &[u8]) -> bool {
    riff(b, b"WAVE").is_some_and(|ids| ids.contains(b"fmt ") && ids.contains(b"data"))
}

/// Top-level ISO-BMFF boxes chained to the end of the file; their types.
fn iso_boxes(b: &[u8]) -> Option<Vec<[u8; 4]>> {
    let (mut at, mut types) = (0usize, Vec::new());
    while at < b.len() {
        let kind: [u8; 4] = b.get(at + 4..at + 8)?.try_into().ok()?;
        if !kind.iter().all(|c| c.is_ascii_alphanumeric() || *c == b' ') {
            return None;
        }
        let (size, header) = match be32(b, at)? {
            0 => ((b.len() - at) as u64, 8),
            1 => (be64(b, at + 8)?, 16),
            n => (n as u64, 8),
        };
        if size < header {
            return None;
        }
        at = at.checked_add(usize::try_from(size).ok()?)?;
        types.push(kind);
    }
    (at == b.len() && !types.is_empty()).then_some(types)
}

const HEIF_BRANDS: &[&[u8; 4]] = &[b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1"];

/// An image `ftyp` brand, then boxes to the end, with a `meta` box (where HEIF keeps its image).
pub fn heif(b: &[u8]) -> bool {
    iso_boxes(b).is_some_and(|t| &t[0] == b"ftyp" && b.get(8..12).is_some_and(|brand| HEIF_BRANDS.iter().any(|h| brand == *h)) && t.contains(b"meta"))
}

/// Box types an MP4 or QuickTime file may start with.
pub const ISO_MEDIA_FIRST: &[&[u8; 4]] = &[b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip", b"pnot"];

/// MP4 / QuickTime: boxes to the end of the file, with the `moov` box a player needs.
pub fn iso_media(b: &[u8]) -> bool {
    iso_boxes(b).is_some_and(|t| ISO_MEDIA_FIRST.contains(&&t[0]) && t.contains(b"moov"))
}

/// `BM`, the file size it states is the file's; a known header (OS/2 1.x core or 2.x, or Windows info versions
/// 1–5) with one plane, a width, a height (negative: stored top-down), 1, 4, 8, 16, 24 or 32 bits a pixel and
/// uncompressed pixels (plain, or bit fields at 16 or 32 bits; RLE and a JPEG or PNG inside are refused); no color
/// profile fetched from a path. The file is its header, masks and color table, then its pixels (every row, padded
/// to 4 bytes) and any embedded profile, in either order, with at most 3 zero bytes between or after them.
pub fn bmp(b: &[u8]) -> bool {
    let walk = || -> Option<bool> {
        if !b.starts_with(b"BM") || le32(b, 2)? as usize != b.len() {
            return Some(false);
        }
        let (offset, dib) = (u64::from(le32(b, 10)?), le32(b, 14)?);
        let (width, height, planes, bits, compression, colors) = match dib {
            12 => (le16(b, 18)? as i64, le16(b, 20)? as i64, le16(b, 22)?, le16(b, 24)?, 0, 0),
            40 | 52 | 56 | 64 | 108 | 124 => (le32(b, 18)? as i32 as i64, le32(b, 22)? as i32 as i64, le16(b, 26)?, le16(b, 28)?, le32(b, 30)?, u64::from(le32(b, 46)?)),
            _ => return Some(false),
        };
        if planes != 1 || width <= 0 || height == 0 || ![1, 4, 8, 16, 24, 32].contains(&bits) {
            return Some(false);
        }
        // the three bit-field masks follow a 40-byte header; later headers hold them. OS/2 2.x (64) numbers its
        // compressions differently, so only plain pixels there.
        let masks = match compression {
            0 => 0,
            3 if (bits == 16 || bits == 32) && dib != 64 => if dib == 40 { 12 } else { 0 },
            _ => return Some(false),
        };
        let palette = match bits {
            1 | 4 | 8 if colors > 1 << bits => return Some(false),
            1 | 4 | 8 if colors == 0 => 1 << bits,
            _ => colors,
        };
        let entry = if dib == 12 { 3 } else { 4 };
        let table_end = 14 + u64::from(dib) + masks + palette * entry;
        let stride = (width as u64 * bits as u64).div_ceil(32) * 4;
        let mut regions = vec![(offset, offset.checked_add(stride.checked_mul(height.unsigned_abs())?)?)];
        if dib >= 108 {
            match le32(b, 14 + 56)? {
                // PROFILE_LINKED: a file name the viewer would open, on a share as easily as on disk
                0x4C49_4E4B => return Some(false),
                // PROFILE_EMBEDDED: the profile's offset is from the header
                0x4D42_4544 if dib == 124 => {
                    let at = 14 + u64::from(le32(b, 14 + 112)?);
                    regions.push((at, at.checked_add(u64::from(le32(b, 14 + 116)?))?));
                }
                _ => {}
            }
        }
        regions.sort_unstable();
        // nothing hides between the parts, or after them: at most 3 zero bytes of alignment
        let small_zero_gap = |from: u64, to: u64| to >= from && to - from <= 3 && b.get(from as usize..to as usize).is_some_and(|g| g.iter().all(|c| *c == 0));
        let mut at = table_end;
        for (start, end) in regions {
            if !small_zero_gap(at, start) {
                return Some(false);
            }
            at = end;
        }
        Some(small_zero_gap(at, b.len() as u64))
    };
    walk() == Some(true)
}

/// `%PDF-1.x` or `2.x` first; at the end, `startxref` pointing at a cross-reference, then `%%EOF` and nothing but whitespace.
pub fn pdf(b: &[u8]) -> bool {
    if !(b.starts_with(b"%PDF-1.") || b.starts_with(b"%PDF-2.")) {
        return false;
    }
    let tail = &b[b.len().saturating_sub(1024)..];
    let Some(eof) = memchr::memmem::rfind(tail, b"%%EOF") else { return false };
    if !tail[eof + 5..].iter().all(|c| c.is_ascii_whitespace() || *c == 0) {
        return false;
    }
    let Some(sx) = memchr::memmem::rfind(&tail[..eof], b"startxref") else { return false };
    let Ok(Ok(offset)) = std::str::from_utf8(&tail[sx + 9..eof]).map(|s| s.trim().parse::<usize>()) else { return false };
    let Some(at) = b.get(offset..) else { return false };
    let at = &at[at.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(at.len())..];
    // a classic table, or a cross-reference stream: `12 0 obj`
    at.starts_with(b"xref") || {
        let s = String::from_utf8_lossy(&at[..at.len().min(40)]).into_owned();
        let mut words = s.split_ascii_whitespace();
        words.next().is_some_and(|n| n.bytes().all(|c| c.is_ascii_digit())) && words.next().is_some_and(|g| g.bytes().all(|c| c.is_ascii_digit())) && words.next().is_some_and(|w| w.starts_with("obj"))
    }
}

/// Most bytes an RTF pass may visit for each byte of the file; a file that would take more is refused.
pub const RTF_WORK_PER_BYTE: usize = 3;

/// Control words a field instruction may hold: character formatting, none of which hides text, shows text hidden
/// from outside or starts a destination. Matched exactly, as Word does; anything else in an instruction is
/// refused, but for [`RTF_UNHIDING_WORDS`]. `\webhidden` hides text only in Word's web view, not from a field.
const RTF_INSTRUCTION_WORDS: &[&[u8]] = &[
    b"rtlch", b"ltrch", b"fcs", b"af", b"afs", b"ab", b"ai", b"alang", b"loch", b"hich", b"dbch", b"f", b"fs", b"b",
    b"i", b"ul", b"ulnone", b"uld", b"uldb", b"ulth", b"ulw", b"ulwave", b"ulc", b"cf", b"cb", b"highlight", b"lang",
    b"langfe", b"langnp", b"langfenp", b"insrsid", b"charrsid", b"kerning", b"noproof", b"cgrid", b"expnd",
    b"expndtw", b"charscalex", b"super", b"sub", b"nosupersub", b"up", b"dn", b"caps", b"scaps", b"strike",
    b"outl", b"shad", b"embo", b"impr", b"cchs", b"webhidden", b"chshdng", b"chcbpat", b"chcfpat",
];

/// Formatting an instruction may hold only in a file that hides no text (no `\v` or `\deleted` anywhere):
/// `\plain` would show text hidden from outside the instruction, and a `\cs` style may itself be hidden.
const RTF_UNHIDING_WORDS: &[&[u8]] = &[b"plain", b"cs"];

/// Whether an RTF file has any control word that hides text (`\v`, `\deleted`, in any case, wherever it is).
fn rtf_hides(b: &[u8]) -> bool {
    memchr::memchr_iter(b'\\', b).any(|at| {
        let word = &b[at + 1..][..b[at + 1..].iter().take_while(|c| c.is_ascii_alphabetic()).count()];
        word.eq_ignore_ascii_case(b"v") || word.eq_ignore_ascii_case(b"deleted")
    })
}

/// Control words a field's own group may hold besides its two parts: `\fldedit` and the like, which change how
/// it updates.
const RTF_FIELD_WORDS: &[&[u8]] = &[b"flddirty", b"fldedit", b"fldlock", b"fldpriv"];

/// An open RTF field: the depth of the group its `\field` word opens, how many instruction and result groups it
/// has had, and its instruction's text so far, lowercased.
struct RtfField {
    depth: usize,
    instructions: u8,
    results: u8,
    text: Vec<u8>,
}

/// RTF in one pass over its control words, braces and text, with a hard bound on the work: `{\rtf`, braces
/// balanced (`\binN` data skipped), the outer group closing at the end; refused as active with an embedded
/// object (`\obj…`, the Equation Editor exploits) or any field but a web or mail link. Rather than decode an
/// instruction as Word would, this fails closed, on the field's shape first. `\field` must open its group, and
/// that group holds only spaces and line breaks, [`RTF_FIELD_WORDS`], at most one instruction group
/// (`{\*\fldinst …}` or `{\fldinst …}`) and at most one result group (`{\fldrslt …}`). A `\fldinst` anywhere else
/// is active, in a destination or a result too, so an instruction is one group and nothing a reader skips sits
/// between its pieces. Inside it, only [`RTF_INSTRUCTION_WORDS`], text and plain groups are allowed: any other
/// control word (`\uN`, `\bin`, `\v` …) or any control symbol (a `\'hh` escape, a `\*` destination, `\\`, `\~` …)
/// is active, since a reader skips a destination's text and the text around it joins up. What is
/// left is text a reader sees all of or none of, and it must be empty or [`rtf_link_only`]; any other instruction
/// (`DDEAUTO`, `INCLUDEPICTURE`, `INCLUDETEXT`, `LINK`, `PAGE` …) is active. A field nested in another's result is
/// checked on its own.
/// Control words are matched without case where that refuses more, exactly where it skips data. Also returns the
/// bytes visited, at most [`RTF_WORK_PER_BYTE`] per byte.
pub fn rtf(b: &[u8]) -> (Doc, usize) {
    if !b.starts_with(b"{\\rtf") {
        return (Doc::Broken, 0);
    }
    let limit = RTF_WORK_PER_BYTE.saturating_mul(b.len()).saturating_add(64);
    let trailing = b.iter().rev().take_while(|c| c.is_ascii_whitespace() || **c == 0).count();
    let end = b.len() - trailing;
    let mut work = trailing;
    // the depth of the group holding the field instruction being read, and the fields open around this point
    let (mut depth, mut i, mut instruction) = (0usize, 0usize, None::<usize>);
    let mut fields: Vec<RtfField> = Vec::new();
    // whether the file hides any text, found when an instruction first needs to know
    let mut hides = None;
    // nothing but `{`, `\*` and whitespace since the last `{`: a word here opens its group. Every token clears
    // it unless its arm says otherwise.
    let mut opening = false;
    let digits = |from: usize| b[from..end].iter().take_while(|c| c.is_ascii_digit()).count();
    while i < end {
        work += 1;
        if work > limit {
            return (Doc::Broken, work);
        }
        let was_opening = std::mem::take(&mut opening);
        // directly in a field's own group; or at the start of a group opened there, whose first word must name
        // it the field's instruction or its result
        let in_field = fields.last().is_some_and(|f| f.depth == depth);
        let naming = was_opening && fields.last().is_some_and(|f| f.depth + 1 == depth);
        match b[i] {
            b'\\' if i + 1 < end && b[i + 1].is_ascii_alphabetic() => {
                let letters = b[i + 1..end].iter().take_while(|c| c.is_ascii_alphabetic()).count();
                let exact = &b[i + 1..i + 1 + letters];
                let word = exact.to_ascii_lowercase();
                let mut at = i + 1 + letters;
                let negative = at < end && b[at] == b'-' && at + 1 < end && b[at + 1].is_ascii_digit();
                let number = digits(at + usize::from(negative));
                let param = &b[at + usize::from(negative)..at + usize::from(negative) + number];
                at += usize::from(negative) + number;
                // a space after a control word is its delimiter
                at += usize::from(at < end && b[at] == b' ');
                work += at - i - 1;
                if word.starts_with(b"obj") {
                    return (Doc::Active, work);
                }
                if instruction.is_some() && word == b"bin" {
                    return (Doc::Active, work);
                }
                // a field's parts: one instruction, one result, nothing else in its group
                if word.starts_with(b"fldinst") {
                    let Some(field) = fields.last_mut().filter(|_| naming) else { return (Doc::Active, work) };
                    field.instructions += 1;
                    if field.instructions > 1 {
                        return (Doc::Active, work);
                    }
                } else if naming {
                    let Some(field) = fields.last_mut().filter(|_| exact == b"fldrslt") else { return (Doc::Active, work) };
                    field.results += 1;
                    if field.results > 1 {
                        return (Doc::Active, work);
                    }
                } else if in_field && !RTF_FIELD_WORDS.contains(&exact) {
                    return (Doc::Active, work);
                }
                // only `\bin` exactly skips data: Word reads `\BIN` as an unknown word and parses what follows
                if exact == b"bin" {
                    // a count readers agree on: no sign, no leading zero, within a 32-bit parameter
                    let plain = !negative && !param.is_empty() && (param == b"0" || param[0] != b'0') && param.len() <= 10;
                    let Some(n) = std::str::from_utf8(param).ok().and_then(|p| p.parse::<i32>().ok()).filter(|_| plain) else { return (Doc::Broken, work) };
                    let n = n as usize;
                    i = match at.checked_add(n) {
                        Some(next) if next <= end => next,
                        _ => return (Doc::Broken, work),
                    };
                    continue;
                }
                if instruction.is_some() && !RTF_INSTRUCTION_WORDS.contains(&exact) {
                    let unhiding = RTF_UNHIDING_WORDS.contains(&exact)
                        && !*hides.get_or_insert_with(|| {
                            work += b.len();
                            rtf_hides(b)
                        });
                    if !unhiding {
                        return (Doc::Active, work);
                    }
                }
                if exact == b"field" {
                    if !was_opening {
                        return (Doc::Active, work);
                    }
                    fields.push(RtfField { depth, instructions: 0, results: 0, text: Vec::new() });
                }
                if word.starts_with(b"fldinst") {
                    instruction = Some(depth);
                }
                i = at;
                continue;
            }
            // a control symbol: \' (a byte in hex) \\ \{ \} \~ \* …; only `\*` may come before the word that names
            // a field's part, and none sits in the field's own group or in an instruction (no address holds one)
            b'\\' => {
                let symbol = b.get(i + 1).copied();
                if instruction.is_some() || in_field || (naming && symbol != Some(b'*')) {
                    return (Doc::Active, work);
                }
                opening = was_opening && symbol == Some(b'*');
                i += 2;
                continue;
            }
            b'{' | b'}' if naming => return (Doc::Active, work),
            b'{' => {
                depth += 1;
                opening = true;
            }
            // insignificant whitespace between `{` and the word that opens or names a group: it stays "opening".
            // A reader drops line breaks; a space or tab in an instruction is part of its text.
            b'\r' | b'\n' | b' ' | b'\t' => {
                opening = was_opening;
                if let Some(field) = fields.last_mut().filter(|_| instruction.is_some() && matches!(b[i], b' ' | b'\t')) {
                    field.text.push(b[i]);
                }
            }
            b'}' => {
                let Some(d) = depth.checked_sub(1) else { return (Doc::Broken, work) };
                depth = d;
                if instruction.is_some_and(|at| depth < at) {
                    instruction = None;
                }
                while let Some(field) = fields.pop_if(|f| depth < f.depth) {
                    work += field.text.len();
                    if !field.text.iter().all(|c| *c == b' ') && !rtf_link_only(&field.text) {
                        return (Doc::Active, work);
                    }
                }
                if depth == 0 {
                    return (if i + 1 == end { Doc::Fine } else { Doc::Broken }, work);
                }
            }
            c if naming || (in_field && !c.is_ascii_whitespace()) => return (Doc::Active, work),
            c if instruction.is_some() => {
                if let Some(field) = fields.last_mut() {
                    field.text.push(c.to_ascii_lowercase());
                }
            }
            _ => {}
        }
        i += 1;
    }
    (Doc::Broken, work)
}


/// Whether an RTF field instruction's text (lowercased) is `HYPERLINK` and one
/// `http`, `https` or `mailto` address, quoted or not, and nothing else: a link a reader follows only when it is
/// clicked. Every other instruction is refused, rather than listing the ones that load or run outside content
/// (`DDE`, `INCLUDEPICTURE`, `INCLUDETEXT`, `LINK`, `IMPORT` …), and so is any switch (`\l`, `\o`, `\t`, `\m`) and
/// any other address (`file:`, a share `\\host`). The address is printable ASCII with no quote, so it holds no space
/// and no second argument; the text has no backslash or brace, since [`rtf`] refuses a control symbol in it. Only spaces separate; a tab anywhere refuses.
fn rtf_link_only(text: &[u8]) -> bool {
    let trim = |s: &[u8]| -> std::ops::Range<usize> {
        let start = s.iter().take_while(|c| **c == b' ').count();
        start..s.len() - s[start..].iter().rev().take_while(|c| **c == b' ').count()
    };
    let Some(rest) = text[trim(text)].strip_prefix(b"hyperlink ") else { return false };
    let rest = &rest[trim(rest)];
    let target = match rest.strip_prefix(b"\"") {
        Some(quoted) => match quoted.strip_suffix(b"\"") {
            Some(target) => target,
            None => return false,
        },
        None => rest,
    };
    [&b"http://"[..], b"https://", b"mailto:"].iter().any(|scheme| target.starts_with(scheme))
        && target.iter().all(|c| c.is_ascii_graphic() && *c != b'"')
}

/// Where an ID3v2 tag at the start ends (0 with none); `None` for a broken one.
fn after_id3(b: &[u8]) -> Option<usize> {
    if !b.starts_with(b"ID3") {
        return Some(0);
    }
    let size = b.get(6..10).filter(|s| s.iter().all(|c| c & 0x80 == 0))?.iter().fold(0usize, |a, c| a << 7 | *c as usize);
    let footer = if b.get(5)? & 0x10 != 0 { 10 } else { 0 };
    Some(10 + size + footer).filter(|e| *e <= b.len())
}

/// The length of the MPEG audio frame whose header starts `h`.
fn mpeg_frame(h: &[u8]) -> Option<usize> {
    let &[a, b, c, _, ..] = h else { return None };
    let (version, layer) = ((b >> 3) & 3, (b >> 1) & 3); // version 3: MPEG-1, 2: MPEG-2, 0: 2.5; layer 3: I, 2: II, 1: III
    let (bitrate, rate, pad) = ((c >> 4) as usize, ((c >> 2) & 3) as usize, ((c >> 1) & 1) as usize);
    if a != 0xFF || b & 0xE0 != 0xE0 || version == 1 || layer == 0 || bitrate == 0 || bitrate == 15 || rate == 3 {
        return None;
    }
    let kbps: [usize; 14] = match (version == 3, layer) {
        (true, 3) => [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
        (true, 2) => [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
        (true, _) => [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
        (false, 3) => [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
        (false, _) => [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    };
    let bps = kbps[bitrate - 1] * 1000;
    let hz = [44100, 48000, 32000][rate] >> [2, 0, 1, 0][version as usize];
    Some(match layer {
        3 => (12 * bps / hz + pad) * 4,
        1 if version != 3 => 72 * bps / hz + pad,
        _ => 144 * bps / hz + pad,
    })
}

/// Where an APEv2 tag ending `b` starts, if it is one: a footer, items that fill the space before it exactly
/// (each a size, flags, a printable key ended by NUL, and the value), and the header its flags promise.
fn ape_start(b: &[u8]) -> Option<usize> {
    let footer = b.len().checked_sub(32)?;
    if !b[footer..].starts_with(b"APETAGEX") {
        return None;
    }
    let size = le32(b, footer + 12)? as usize; // the items and this footer
    let count = le32(b, footer + 16)?;
    let has_header = le32(b, footer + 20)? & 0x8000_0000 != 0;
    let items = footer.checked_sub(size.checked_sub(32)?)?;
    let mut at = items;
    for _ in 0..count {
        let value = le32(b, at)? as usize;
        let key_at = at.checked_add(8)?;
        let key = memchr::memchr(0, b.get(key_at..footer)?)?;
        if !(2..=255).contains(&key) || !b[key_at..key_at + key].iter().all(|c| (0x20..0x7F).contains(c)) {
            return None;
        }
        at = key_at.checked_add(key + 1)?.checked_add(value)?;
    }
    if at != footer {
        return None;
    }
    if has_header {
        let header = items.checked_sub(32)?;
        return b[header..].starts_with(b"APETAGEX").then_some(header);
    }
    Some(items)
}

/// What may follow an MP3's frames: zero padding, an APEv2 tag, an ID3v1 tag (128 bytes), in any order.
fn mp3_tail(mut tail: &[u8]) -> bool {
    loop {
        if tail.iter().all(|c| *c == 0) {
            return true;
        }
        let n = tail.len();
        if n >= 128 && tail[n - 128..].starts_with(b"TAG") {
            tail = &tail[..n - 128];
        } else if let Some(start) = ape_start(tail) {
            tail = &tail[..start];
        } else if tail[n - 1] == 0 {
            tail = &tail[..n - tail.iter().rev().take_while(|c| **c == 0).count()];
        } else {
            return false;
        }
    }
}

/// MP3: an optional ID3v2 tag, then MPEG audio frames, each whole, then only padding and tags ([`mp3_tail`]).
pub fn mp3(b: &[u8]) -> bool {
    let Some(mut at) = after_id3(b) else { return false };
    let mut frames = 0;
    while let Some(len) = b.get(at..).and_then(mpeg_frame) {
        if at + len > b.len() {
            return false;
        }
        at += len;
        frames += 1;
    }
    frames > 0 && mp3_tail(&b[at.min(b.len())..])
}

/// AAC in ADTS frames, to the end of the file.
pub fn adts(b: &[u8]) -> bool {
    let Some(mut at) = after_id3(b) else { return false };
    let mut frames = 0;
    while at < b.len() {
        let Some(h) = b.get(at..at + 7).filter(|h| h[0] == 0xFF && h[1] & 0xF6 == 0xF0) else { return false };
        let len = ((h[3] & 3) as usize) << 11 | (h[4] as usize) << 3 | (h[5] >> 5) as usize;
        if len < 7 {
            return false;
        }
        at += len;
        frames += 1;
    }
    frames > 0 && at == b.len()
}

/// Ogg pages chained to the end of the file, the first beginning a stream and the last ending one.
pub fn ogg(b: &[u8]) -> bool {
    let (mut at, mut last) = (0, 0u8);
    while at < b.len() {
        let Some(h) = b.get(at..at + 27).filter(|h| h.starts_with(b"OggS") && h[4] == 0) else { return false };
        if at == 0 && h[5] & 2 == 0 {
            return false;
        }
        let n = h[26] as usize;
        let Some(table) = b.get(at + 27..at + 27 + n) else { return false };
        at += 27 + n + table.iter().map(|s| *s as usize).sum::<usize>();
        last = h[5];
    }
    at == b.len() && last & 4 != 0
}

/// An EBML variable-length number at `at`: its length and value; `None` for the reserved all-ones (unknown) size.
fn vint(b: &[u8], at: usize, keep_marker: bool) -> Option<(usize, Option<u64>)> {
    let first = *b.get(at)?;
    let len = first.leading_zeros() as usize + 1;
    let bytes = b.get(at..at + len).filter(|_| len <= 8)?;
    let mask = if keep_marker { 0xFF } else { 0xFFu8.checked_shr(len as u32).unwrap_or(0) };
    let v = bytes[1..].iter().fold((first & mask) as u64, |v, x| v << 8 | *x as u64);
    let unknown = !keep_marker && v == (1u64 << (7 * len)) - 1;
    Some((len, (!unknown).then_some(v)))
}

/// An EBML element at `at`: its id, where its data starts, and its size if known.
fn ebml_element(b: &[u8], at: usize) -> Option<(u64, usize, Option<usize>)> {
    let (id_len, id) = vint(b, at, true)?;
    let (size_len, size) = vint(b, at + id_len, false)?;
    let size = match size {
        Some(s) => Some(usize::try_from(s).ok()?),
        None => None,
    };
    Some((id?, at + id_len + size_len, size))
}

/// WebM: an EBML header naming `webm`, then a Segment ending at the end of the file. An element of unknown size (a
/// browser's recorder writes the Segment and each Cluster that way) is walked into, so its children must chain to
/// the end instead.
pub fn webm(b: &[u8]) -> bool {
    let walk = || -> Option<bool> {
        let (id, start, size) = ebml_element(b, 0)?;
        let header_end = start.checked_add(size?)?;
        if id != 0x1A45_DFA3 || header_end > b.len() {
            return None;
        }
        let (mut at, mut webm) = (start, false);
        while at < header_end {
            let (id, data, size) = ebml_element(b, at)?;
            let end = data.checked_add(size?)?;
            webm |= id == 0x4282 && b.get(data..end)? == b"webm";
            at = end;
        }
        let (id, data, size) = ebml_element(b, header_end)?;
        if !webm || at != header_end || id != 0x1853_8067 {
            return None;
        }
        if let Some(size) = size {
            return Some(data.checked_add(size)? == b.len());
        }
        let mut at = data;
        while at < b.len() {
            let (_, data, size) = ebml_element(b, at)?;
            at = match size {
                Some(size) => data.checked_add(size)?,
                None => data,
            };
        }
        Some(at == b.len())
    };
    walk() == Some(true)
}

// ── Zip-based documents ─────────────────────────────────────────────────

/// Most entries a document may have.
const MAX_ENTRIES: usize = 10_000;
/// Most the entries may add up to, uncompressed, as declared.
const MAX_TOTAL: u64 = 1 << 30;
/// Highest compression ratio for an entry over 10 MiB.
const MAX_RATIO: u64 = 200;
/// Most Uni decompresses from one part, and from one document.
const MAX_PART: u64 = 64 << 20;
const MAX_READ: u64 = 256 << 20;

type Zip<'a> = ZipArchive<Cursor<&'a [u8]>>;

/// The zip, if it is one whole archive (a local header first, the central directory at the end, nothing before
/// it) inside the limits: no encrypted entries, only stored or deflated ones, no two entries with one name or
/// sharing bytes.
fn open_zip(b: &[u8]) -> Option<(Zip<'_>, Vec<String>)> {
    if !b.starts_with(b"PK\x03\x04") {
        return None;
    }
    // the end record (with its comment) ends the file, so nothing rides after the archive
    let from = b.len().saturating_sub(22 + 0xFFFF);
    let eocd = from + memchr::memmem::rfind(&b[from..], b"PK\x05\x06")?;
    if eocd + 22 + le16(b, eocd + 20)? != b.len() {
        return None;
    }
    let mut z = ZipArchive::new(Cursor::new(b)).ok()?;
    if z.offset() != 0 || z.is_empty() || z.len() > MAX_ENTRIES {
        return None;
    }
    let (mut total, mut spans, mut names, mut seen, mut central) = (0u64, Vec::new(), Vec::new(), HashSet::new(), u64::MAX);
    for i in 0..z.len() {
        let f = z.by_index_raw(i).ok()?;
        if f.encrypted() || !matches!(f.compression(), CompressionMethod::Stored | CompressionMethod::Deflated) {
            return None;
        }
        let (size, packed) = (f.size(), f.compressed_size());
        total = total.checked_add(size)?;
        if total > MAX_TOTAL || (size > 10 << 20 && size / packed.max(1) > MAX_RATIO) {
            return None;
        }
        // Office part names are case-insensitive, so two that differ in case are one name read two ways
        let name = f.name().to_lowercase();
        if !seen.insert(name.clone()) {
            return None;
        }
        // the local header names the same entry as the central directory
        let local = usize::try_from(f.header_start()).ok()?;
        let name_len = le16(b, local + 26)?;
        if b.get(local..local + 4)? != b"PK\x03\x04" || b.get(local + 30..local + 30 + name_len)? != f.name_raw() {
            return None;
        }
        // a data descriptor (flag bit 3) may follow the data, if it is this entry's: [signature,] CRC, sizes
        let descriptor = (le16(b, local + 6)? & 8 != 0).then_some((f.crc32(), packed, size));
        spans.push((f.header_start(), f.data_start().checked_add(packed)?, descriptor));
        central = central.min(f.central_header_start());
        names.push(name);
    }
    // the entries fill the file from the start to the central directory, with no gap where anything could hide
    spans.sort_unstable();
    // what may sit between one entry's data and the next header: nothing, or that entry's own data descriptor
    let gap_ok = |at: u64, gap: u64, descriptor: Option<(u32, u64, u64)>| -> bool {
        if gap == 0 {
            return true;
        }
        let Some((crc, packed, size)) = descriptor else { return false };
        let Some(d) = usize::try_from(at).ok().and_then(|a| b.get(a..a.checked_add(gap as usize)?)) else { return false };
        let d = d.strip_prefix(b"PK\x07\x08").unwrap_or(d);
        match d.len() {
            12 => le32(d, 0) == Some(crc) && le32(d, 4).map(u64::from) == Some(packed) && le32(d, 8).map(u64::from) == Some(size),
            20 => le32(d, 0) == Some(crc) && le64(d, 4) == Some(packed) && le64(d, 12) == Some(size),
            _ => false,
        }
    };
    let (mut at, mut descriptor) = (0u64, None);
    for (start, end, has_descriptor) in spans {
        if !gap_ok(at, start.checked_sub(at)?, descriptor) {
            return None;
        }
        (at, descriptor) = (end, has_descriptor);
    }
    if !gap_ok(at, central.checked_sub(at)?, descriptor) {
        return None;
    }
    Some((z, names))
}

/// An entry decompressed as UTF-8 text (a BOM dropped), within [`MAX_PART`] and what is left of `budget`.
fn read_text(z: &mut Zip<'_>, index: usize, budget: &mut u64) -> Option<String> {
    let cap = MAX_PART.min(*budget);
    let mut out = Vec::new();
    z.by_index(index).ok()?.take(cap + 1).read_to_end(&mut out).ok()?;
    if out.len() as u64 > cap {
        return None;
    }
    *budget -= out.len() as u64;
    let text = String::from_utf8(out).ok()?;
    Some(text.strip_prefix('\u{FEFF}').map(str::to_string).unwrap_or(text))
}

/// Walk `xml`: `element(name, attributes)` for each element, `text(name, text)` for text directly inside one
/// (local names, lowercased; values with references resolved). False if `xml` isn't well-formed (one root
/// element, only XML whitespace outside it), declares a DTD, uses an unknown entity, or `element` returns false.
/// An empty part (LibreOffice writes some) has no root and is let through; see [`blank`].
fn walk_xml(xml: &str, mut element: impl FnMut(&str, &[(String, String)]) -> bool, mut text: impl FnMut(&str, &str)) -> bool {
    let mut reader = quick_xml::Reader::from_str(xml);
    let (mut open, mut rooted): (Vec<String>, bool) = (Vec::new(), false);
    loop {
        let Ok(event) = reader.read_event() else { return false };
        // outside the root element: only whitespace, comments and processing instructions, and one root
        if open.is_empty() {
            let fine = match &event {
                Event::Start(_) | Event::Empty(_) => !std::mem::replace(&mut rooted, true),
                Event::Text(t) => blank(t.as_ref()),
                Event::CData(_) | Event::GeneralRef(_) => false,
                _ => true,
            };
            if !fine {
                return false;
            }
        }
        match event {
            Event::Eof => return open.is_empty() && (rooted || blank(xml)),
            Event::DocType(_) => return false,
            Event::Start(ref e) | Event::Empty(ref e) => {
                let name = e.local_name().as_ref().to_lowercase();
                let mut attrs = Vec::new();
                for a in e.attributes() {
                    let Ok(a) = a else { return false };
                    let Ok(value) = a.normalized_value(XmlVersion::Implicit1_0) else { return false };
                    attrs.push((a.key.local_name().as_ref().to_lowercase(), value.into_owned()));
                }
                if !element(&name, &attrs) {
                    return false;
                }
                if matches!(event, Event::Start(_)) {
                    open.push(name);
                }
            }
            Event::End(_) => {
                open.pop();
            }
            Event::Text(ref t) => text(open.last().map_or("", String::as_str), &t.xml_content(XmlVersion::Implicit1_0)),
            Event::CData(ref t) => text(open.last().map_or("", String::as_str), &t.xml_content(XmlVersion::Implicit1_0)),
            Event::GeneralRef(ref r) => {
                let resolved = match r.resolve_char_ref() {
                    Ok(Some(c)) => c.to_string(),
                    Ok(None) => match quick_xml::escape::resolve_predefined_entity(r) {
                        Some(s) => s.to_string(),
                        None => return false,
                    },
                    Err(_) => return false,
                };
                text(open.last().map_or("", String::as_str), &resolved);
            }
            _ => {}
        }
    }
}

/// Whether `s` is nothing but XML whitespace (space, tab, CR, LF; not a form feed, which XML doesn't allow).
fn blank(s: &str) -> bool {
    s.bytes().all(|c| matches!(c, b' ' | b'\t' | b'\r' | b'\n'))
}

/// Content types that hold code or an object: macro-enabled parts, VBA, OLE objects, ActiveX, links to other
/// workbooks (where DDE lives in a spreadsheet).
const OFFICE_ACTIVE_TYPES: &[&str] = &["macroenabled", "vbaproject", "vbadata", "oleobject", "activex", "externallink", "keymapcustomizations"];
/// Relationship kinds (the last part of the type URI) that load code, an object, a control, another document
/// or a template.
const OFFICE_ACTIVE_RELS: &[&str] = &["oleobject", "package", "control", "activexcontrol", "activexcontrolbinary", "vbaproject", "vbaprojectsignature", "wordvbadata", "keymapcustomizations", "attachedtemplate", "subdocument", "frame", "afchunk", "externallinkpath"];
/// Entry names that are code or objects whatever refers to them.
const OFFICE_ACTIVE_NAMES: &[&str] = &["vbaproject", "vbadata", "activex", "oleobject", "embeddings/"];
/// Whether an entry's first bytes are XML in any encoding an XML reader detects (a byte-order mark, UTF-16 or
/// UTF-32 without one, leading whitespace), whatever the entry is called or declared as.
fn sniffs_as_xml(z: &mut Zip<'_>, index: usize) -> Option<bool> {
    let mut head = Vec::new();
    z.by_index(index).ok()?.take(512).read_to_end(&mut head).ok()?;
    let marks: &[&[u8]] = &[b"\xFF\xFE", b"\xFE\xFF", b"\0<", b"\0\0\0<", b"\0\0\xFE\xFF"];
    let h = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&head);
    let h = &h[h.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(h.len())..];
    Some(h.starts_with(b"<") || marks.iter().any(|m| head.starts_with(m)) || (h.is_empty() && head.len() == 512))
}

/// Whether a content type is XML: `…/xml` or `…+xml` (not merely `openxmlformats` in its name).
fn xml_type(t: &str) -> bool {
    let subtype = t.split(';').next().unwrap_or("").trim().rsplit('/').next().unwrap_or("");
    subtype == "xml" || subtype.ends_with("+xml")
}

/// A part name as every lookup compares it, whether it comes from the zip, an `Override` or a relationship: no
/// leading `/`, `%hh` escapes decoded once, lowercased (Office reads part names without case). `None` for a name
/// no part may have (ECMA-376 part 2, 6.2.2.2): a `%` not followed by two hex digits, an escaped `/` or `\` or
/// unreserved character (a letter, digit, `-`, `.`, `_` or `~`, so `%2E%2E` can't become `..` after `..` is
/// resolved), or escapes that don't decode to UTF-8.
fn part_name(name: &str) -> Option<String> {
    let name = name.trim().trim_start_matches('/');
    let (b, mut out, mut i) = (name.as_bytes(), Vec::new(), 0);
    let hex = |h: &[u8]| h.iter().all(u8::is_ascii_hexdigit).then(|| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()).flatten();
    while i < b.len() {
        match b[i] {
            b'%' => {
                let byte = b.get(i + 1..i + 3).and_then(hex)?;
                if byte.is_ascii_alphanumeric() || b"-._~/\\".contains(&byte) {
                    return None;
                }
                out.push(byte);
                i += 3;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok().map(|s| s.to_lowercase())
}

/// A relationship's internal target, resolved against the folder of the part its `.rels` describes.
fn resolve_target(rels: &str, target: &str) -> Option<String> {
    // `word/_rels/document.xml.rels` describes `word/document.xml`, so targets are relative to `word/`
    let source_dir = rels.strip_suffix(".rels")?.rsplit_once("_rels/").map_or("", |(dir, _)| dir);
    let joined = if target.starts_with('/') { target.to_string() } else { format!("{source_dir}{target}") };
    let mut segments: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            s => segments.push(s),
        }
    }
    part_name(&segments.join("/"))
}

/// Office Open XML: a whole zip with `[Content_Types].xml`, `_rels/.rels` and parts in `folder`, whose root
/// relationship leads to a part that was parsed as XML and is declared XML. Every part that is XML (by its
/// content type, from an `Override` or the `Default` for its extension, or by its bytes) is parsed, whatever it
/// is called. Part names are compared as [`part_name`] gives them, entries' too, so two entries that differ only
/// by escapes are refused. Refused as active if any content type, relationship or entry name is code or an
/// object, any relationship other than a hyperlink points outside the file, or any part has a Word field
/// (`fldSimple`, `fldChar`, `instrText`, `delInstrText`).
pub fn ooxml(b: &[u8], folder: &str) -> Doc {
    let Some((mut z, raw)) = open_zip(b) else { return Doc::Broken };
    let Some(names) = raw.iter().map(|n| part_name(n)).collect::<Option<Vec<String>>>() else { return Doc::Broken };
    let mut distinct = HashSet::new();
    if !names.iter().all(|n| distinct.insert(n.as_str())) {
        return Doc::Broken;
    }
    let present = |n: &str| names.iter().any(|x| x == n);
    if !present("[content_types].xml") || !present("_rels/.rels") || !names.iter().any(|n| n.starts_with(folder)) {
        return Doc::Broken;
    }
    if raw.iter().chain(&names).any(|n| OFFICE_ACTIVE_NAMES.iter().any(|a| n.contains(a))) {
        return Doc::Active;
    }
    let mut budget = MAX_READ;
    // the content types first: they say which parts are XML
    let types_at = names.iter().position(|n| n == "[content_types].xml").unwrap();
    let Some(types_xml) = read_text(&mut z, types_at, &mut budget) else { return Doc::Broken };
    let (mut defaults, mut overrides) = (HashMap::new(), HashMap::new());
    let mut active = false;
    let ok = walk_xml(
        &types_xml,
        |element, attrs| {
            let one = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.to_lowercase());
            let types: Vec<String> = attrs.iter().filter(|(n, _)| n == "contenttype").map(|(_, v)| v.to_lowercase()).collect();
            active |= types.iter().any(|t| OFFICE_ACTIVE_TYPES.iter().any(|a| t.contains(a)));
            // every ContentType given: a decoy attribute can't make an XML part look like a picture
            match element {
                "default" => {
                    defaults.insert(one("extension").unwrap_or_default(), types);
                }
                "override" => {
                    // a name that can't be compared is a part no lookup could find
                    let Some(part) = part_name(&one("partname").unwrap_or_default()) else { return false };
                    overrides.insert(part, types);
                }
                _ => {}
            }
            true
        },
        |_, _| {},
    );
    if !ok {
        return Doc::Broken;
    }
    let content_type = |name: &str| -> Option<&Vec<String>> {
        overrides.get(name).or_else(|| name.rsplit_once('/').map_or(name, |(_, f)| f).rsplit_once('.').and_then(|(_, ext)| defaults.get(ext)))
    };
    // the parts parsed as XML, by name
    let (mut main_parts, mut parsed) = (Vec::new(), HashSet::new());
    for (i, name) in names.iter().enumerate() {
        if name.ends_with('/') {
            continue;
        }
        let declared_xml = content_type(name).is_some_and(|t| t.iter().any(|t| xml_type(t)));
        let xml_part = name.ends_with(".rels") || declared_xml || {
            let Some(sniffed) = sniffs_as_xml(&mut z, i) else { return Doc::Broken };
            sniffed
        };
        if !xml_part || i == types_at {
            continue;
        }
        let Some(xml) = read_text(&mut z, i, &mut budget) else { return Doc::Broken };
        let ok = walk_xml(
            &xml,
            |element, attrs| {
                // every attribute with this local name: a prefixed decoy can't hide the one Office reads
                let all = |k: &'static str| attrs.iter().filter(move |(n, _)| n == k).map(|(_, v)| v.to_lowercase());
                match element {
                    "relationship" => {
                        let kinds: Vec<String> = all("type").map(|t| t.rsplit('/').next().unwrap_or("").to_string()).collect();
                        if kinds.is_empty() {
                            return false;
                        }
                        let external = all("targetmode").any(|m| m != "internal");
                        active |= kinds.iter().any(|k| OFFICE_ACTIVE_RELS.contains(&k.as_str()) || (external && k != "hyperlink"))
                            || all("target").any(|t| t.contains("embeddings/") || t.contains("mhtml:"));
                        if name == "_rels/.rels" && kinds.iter().any(|k| k == "officedocument") {
                            main_parts.extend(all("target").map(|t| resolve_target(name, &t)));
                        }
                    }
                    // a field, whatever it says: a complex field's instruction is built from pieces, and readers
                    // differ on which count (tracked changes, compatibility branches, nested fields, other runs'
                    // text, hidden text), and a simple one can load from outside (`INCLUDEPICTURE`, `LINK`)
                    "fldsimple" | "fldchar" | "instrtext" | "delinstrtext" => active = true,
                    _ => {}
                }
                true
            },
            |_, _| {},
        );
        if !ok {
            return Doc::Broken;
        }
        // an empty part passes, but isn't a document
        if !blank(&xml) {
            parsed.insert(name.as_str());
        }
    }
    if active {
        return Doc::Active;
    }
    // the main document is a part that was parsed as XML above, and is declared XML
    let main_ok = |p: &Option<String>| p.as_ref().is_some_and(|p| parsed.contains(p.as_str()) && content_type(p).is_some_and(|t| t.iter().any(|t| xml_type(t))));
    if main_parts.is_empty() || !main_parts.iter().all(main_ok) {
        return Doc::Broken;
    }
    Doc::Fine
}

/// OpenDocument: a whole zip whose first entry is `mimetype`, stored, holding `mime`, with a manifest; refused as
/// active with macros (`Basic/`, `Scripts/`), an OLE object, an applet or plugin, an event bound to a script or
/// macro (by URL, `vnd.sun.star.script:` or `macro:`, or by language and macro name), or an image, object or frame
/// loaded from outside the file.
pub fn odf(b: &[u8], mime: &str) -> Doc {
    // the first local header: `mimetype` (8 bytes), its contents after the name and any extra field
    let at = 30 + 8 + le16(b, 28).unwrap_or(0);
    if le16(b, 26) != Some(8) || b.get(30..38) != Some(b"mimetype") || b.get(at..at + mime.len()) != Some(mime.as_bytes()) {
        return Doc::Broken;
    }
    let Some((mut z, names)) = open_zip(b) else { return Doc::Broken };
    let stored = z.by_index_raw(0).is_ok_and(|f| f.compression() == CompressionMethod::Stored && f.size() == mime.len() as u64);
    // the parts every document has, which must not be empty
    let required = |n: &str| n == "meta-inf/manifest.xml" || n == "content.xml";
    if names[0] != "mimetype" || !stored || names.iter().filter(|n| required(n)).count() != 2 {
        return Doc::Broken;
    }
    let macro_dir = |p: &str| p.starts_with("basic/") || p.starts_with("scripts/") || p.contains("/basic/") || p.contains("/scripts/");
    // a binary OLE object is stored as a top-level `Object N` file (an ODF object is a folder of XML)
    let ole_part = |p: &str| p.starts_with("object ") && !p.contains('/');
    if names.iter().any(|n| macro_dir(n) || ole_part(n)) {
        return Doc::Active;
    }
    let mut budget = MAX_READ;
    let mut active = false;
    for (i, name) in names.iter().enumerate() {
        if !name.ends_with(".xml") && !name.ends_with(".rdf") {
            continue;
        }
        let Some(xml) = read_text(&mut z, i, &mut budget) else { return Doc::Broken };
        if required(name) && blank(&xml) {
            return Doc::Broken;
        }
        let ok = walk_xml(
            &xml,
            |element, attrs| {
                let attr = |k: &'static str| attrs.iter().filter(move |(n, _)| n == k).map(|(_, v)| v.trim().to_lowercase());
                for (key, value) in attrs {
                    let v = value.trim_start().to_lowercase();
                    active |= ["vnd.sun.star.script", "vnd.sun.star.basic", "macro:", ".uno:", "vnd.sun.star.uno"].iter().any(|p| v.starts_with(p));
                    // the older binding form: a language and a macro name
                    active |= key == "macro-name" || (key == "language" && ["starbasic", "ooo:script", "basic", "javascript", "python"].iter().any(|l| v.contains(l)));
                    if element == "file-entry" {
                        active |= (key == "media-type" && ["oleobject", "basic", "script"].iter().any(|t| v.contains(t))) || (key == "full-path" && macro_dir(&v));
                    }
                }
                match element {
                    // an OLE object, a Java applet, a plugin
                    "object-ole" | "applet" | "plugin" => active = true,
                    // an event bound to a script; in a presentation, only "run a program" and "OLE verb" actions run anything
                    "event-listener" => active |= attr("action").next().is_none_or(|a| a == "execute" || a == "verb"),
                    // a hyperlink may point anywhere
                    "a" => {}
                    // anything else that loads from outside the file: an image, object, frame, linked section or
                    // table, a template or auto-reload address; `\\host\share` is a Windows file share
                    _ => active |= attr("href").any(|h| h.contains(':') || h.starts_with(['/', '\\']) || h.split(['/', '\\']).any(|seg| seg == "..")),
                }
                // DDE links and connections
                active |= element.starts_with("dde-");
                true
            },
            |_, _| {},
        );
        if !ok {
            return Doc::Broken;
        }
    }
    if active { Doc::Active } else { Doc::Fine }
}

/// Apple iWork: a whole zip with an `Index/` folder or an `index.xml`.
pub fn iwork(b: &[u8]) -> bool {
    open_zip(b).is_some_and(|(_, names)| names.iter().any(|n| n.starts_with("index/") || n == "index.xml"))
}
