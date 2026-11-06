//! Images: the relay allows no metadata channel at all (validation.rs `validate_image_metadata_free`), up to 25 MP.
//!
//! PNG, WebP and GIF are cleaned structurally, so pixels and animation are untouched. JPEG is decoded and re-encoded,
//! since EXIF orientation has to be baked in before EXIF can go. Anything over the pixel limit is scaled to fit.
use super::{damaged, megabytes, refuse, MAX_GIF_BYTES, MAX_IMAGE_BYTES, MAX_PIXELS};
use crate::{Error, Result};

/// PNG ancillary chunks that affect only rendering and that the relay accepts.
/// Everything else ancillary (eXIf, iCCP, iTXt/tEXt/zTXt, pHYs, tIME, vendor
/// chunks such as Apple's iDOT) is a metadata channel the relay rejects.
const PNG_KEEP_ANCILLARY: [&[u8; 4]; 11] = [
    b"cHRM", b"gAMA", b"sBIT", b"sRGB", b"bKGD", b"hIST", b"tRNS", b"sPLT", b"acTL", b"fcTL",
    b"fdAT",
];

/// Remove metadata from PNG structurally: keep critical chunks and the
/// rendering/animation chunks above, drop the rest and anything after IEND.
/// Pixels (and APNG frames) are untouched, so this is lossless and cheap even
/// for large screenshots. Returns None when the bytes aren't a well-formed PNG.
fn strip_png_metadata(bytes: &[u8]) -> Option<Vec<u8>> {
    const SIG: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(SIG) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len());
    out.extend_from_slice(SIG);
    let mut i = SIG.len();
    loop {
        let header = bytes.get(i..i + 8)?;
        let len = u32::from_be_bytes(header[..4].try_into().ok()?) as usize;
        let kind: &[u8; 4] = header[4..8].try_into().ok()?;
        let end = i.checked_add(12)?.checked_add(len)?;
        if end > bytes.len() {
            return None;
        }
        let ancillary = kind[0] & 0x20 != 0;
        if !ancillary || PNG_KEEP_ANCILLARY.contains(&kind) {
            out.extend_from_slice(&bytes[i..end]);
        }
        if kind == b"IEND" {
            return Some(out);
        }
        i = end;
    }
}

fn png_is_animated(png: &[u8]) -> bool {
    let mut i = 8;
    while let Some(header) = png.get(i..i + 8) {
        if &header[4..8] == b"acTL" {
            return true;
        }
        if &header[4..8] == b"IDAT" {
            return false;
        }
        let Ok(len) = <[u8; 4]>::try_from(&header[..4]) else {
            return false;
        };
        i += 12 + u32::from_be_bytes(len) as usize;
    }
    false
}

fn webp_chunks(body: &[u8]) -> Option<Vec<([u8; 4], &[u8])>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < body.len() {
        // Stray bytes shorter than a chunk header, or a chunk that overruns, end the image: what follows isn't part of it.
        let Some(header) = body.get(i..i + 8) else {
            break;
        };
        let kind: [u8; 4] = header[..4].try_into().ok()?;
        let len = u32::from_le_bytes(header[4..8].try_into().ok()?) as usize;
        let start = i + 8;
        let Some(data) = body.get(start..start.checked_add(len)?) else {
            break;
        };
        out.push((kind, data));
        i = start + len + (len & 1);
    }
    Some(out)
}

fn webp_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(kind);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    if data.len() & 1 == 1 {
        out.push(0);
    }
}

/// Keep only the chunks the relay lists, clear the metadata flags and fix the RIFF size. None: not well-formed.
fn strip_webp_metadata(bytes: &[u8]) -> Option<Vec<u8>> {
    let declared = u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?) as usize;
    let end = declared.checked_add(8)?.min(bytes.len());
    let chunks = webp_chunks(bytes.get(12..end)?)?;
    let mut body = Vec::with_capacity(bytes.len());
    let mut has_image = false;
    for (kind, data) in chunks {
        match &kind {
            b"VP8X" => {
                let mut x = data.to_vec();
                *x.first_mut()? &= !(0x20 | 0x08 | 0x04);
                webp_chunk(&mut body, &kind, &x);
            }
            b"VP8 " | b"VP8L" | b"ALPH" | b"ANIM" => {
                has_image |= &kind != b"ANIM" && &kind != b"ALPH";
                webp_chunk(&mut body, &kind, data);
            }
            b"ANMF" => {
                // A frame's header, then only its picture chunks.
                let inner = webp_chunks(data.get(16..)?)?;
                let mut frame = data[..16].to_vec();
                for (k, d) in inner {
                    if matches!(&k, b"VP8 " | b"VP8L" | b"ALPH") {
                        webp_chunk(&mut frame, &k, d);
                    }
                }
                webp_chunk(&mut body, &kind, &frame);
                has_image = true;
            }
            _ => {} // ICCP, EXIF, XMP and anything unknown
        }
    }
    if !has_image {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() + 12);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend_from_slice(&body);
    Some(out)
}

fn webp_is_animated(bytes: &[u8]) -> bool {
    webp_chunks(bytes.get(12..).unwrap_or(&[]))
        .is_some_and(|c| c.iter().any(|(k, _)| k == b"ANIM" || k == b"ANMF"))
}

/// Copy a GIF keeping only frames, their timing and the looping extension. None: not well-formed.
fn strip_gif_metadata(bytes: &[u8]) -> Option<Vec<u8>> {
    fn sub_blocks(bytes: &[u8], mut i: usize) -> Option<usize> {
        loop {
            let len = *bytes.get(i)? as usize;
            i = i.checked_add(1 + len)?;
            if len == 0 {
                return (i <= bytes.len()).then_some(i);
            }
            if i > bytes.len() {
                return None;
            }
        }
    }
    let packed = *bytes.get(10)?;
    let mut i = 13usize;
    if packed & 0x80 != 0 {
        i = i.checked_add(3usize << ((packed & 7) + 1))?;
    }
    let mut out = bytes.get(..i)?.to_vec();
    loop {
        match bytes.get(i).copied() {
            // Cut off after a whole block: end it where it stops, as a viewer would.
            None => break,
            Some(0x3b) => break,
            Some(0x2c) => {
                let image_packed = *bytes.get(i + 9)?;
                let mut end = i + 10;
                if image_packed & 0x80 != 0 {
                    end = end.checked_add(3usize << ((image_packed & 7) + 1))?;
                }
                let end = sub_blocks(bytes, end.checked_add(1)?)?;
                out.extend_from_slice(bytes.get(i..end)?);
                i = end;
            }
            Some(0x21) => {
                let label = *bytes.get(i + 1)?;
                match label {
                    0xf9 if bytes.get(i + 2) == Some(&4) && bytes.get(i + 7) == Some(&0) => {
                        out.extend_from_slice(bytes.get(i..i + 8)?);
                        i += 8;
                    }
                    0xff if bytes.get(i + 2) == Some(&11)
                        && matches!(
                            bytes.get(i + 3..i + 14),
                            Some(b"NETSCAPE2.0" | b"ANIMEXTS1.0")
                        )
                        && bytes.get(i + 14) == Some(&3)
                        && bytes.get(i + 15) == Some(&1)
                        && bytes.get(i + 18) == Some(&0) =>
                    {
                        out.extend_from_slice(bytes.get(i..i + 19)?);
                        i += 19;
                    }
                    _ => i = sub_blocks(bytes, i + 2)?, // comments, XMP, plain text, anything else
                }
            }
            Some(_) => return None,
        }
    }
    out.push(0x3b);
    Some(out)
}

fn fits(width: u32, height: u32) -> bool {
    u64::from(width) * u64::from(height) <= MAX_PIXELS
}

/// Width and height that fit the relay's pixel limit, same shape.
fn scaled_to_fit(width: u32, height: u32) -> (u32, u32) {
    let factor = (MAX_PIXELS as f64 / (f64::from(width) * f64::from(height))).sqrt();
    let w = ((f64::from(width) * factor).floor() as u32).max(1);
    let h = ((f64::from(height) * factor).floor() as u32).max(1);
    (w, h)
}

fn decoded(bytes: &[u8], format: image::ImageFormat) -> Result<image::DynamicImage> {
    use image::ImageDecoder as _;
    let bad = || {
        refuse("This image is damaged or in a form this device can't read, so it can't be sent.")
    };
    let mut decoder = image::ImageReader::with_format(std::io::Cursor::new(bytes), format)
        .into_decoder()
        .map_err(|_| bad())?;
    decoder
        .set_limits(image::Limits::default())
        .map_err(|_| too_big_to_decode())?;
    let orientation = decoder.orientation().map_err(|_| bad())?;
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|e| match e {
        image::ImageError::Limits(_) => too_big_to_decode(),
        _ => bad(),
    })?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn too_big_to_decode() -> Error {
    refuse(
        "This image is too large for this device to prepare. Scale it down, then attach it again.",
    )
}

fn shrink(img: image::DynamicImage) -> image::DynamicImage {
    if fits(img.width(), img.height()) {
        return img;
    }
    let (w, h) = scaled_to_fit(img.width(), img.height());
    img.thumbnail_exact(w, h)
}

fn encoded(img: &image::DynamicImage, format: image::ImageFormat) -> Result<Vec<u8>> {
    let failed = || refuse("Couldn't prepare this image on this device. Attach it again.");
    let mut out = std::io::Cursor::new(Vec::new());
    if format == image::ImageFormat::Jpeg {
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92);
        img.to_rgb8()
            .write_with_encoder(enc)
            .map_err(|_| failed())?;
    } else {
        img.write_to(&mut out, format).map_err(|_| failed())?;
    }
    Ok(out.into_inner())
}

fn within_size(bytes: Vec<u8>) -> Result<Vec<u8>> {
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(refuse(format!(
            "This image is {}; Buzz takes up to {}.",
            megabytes(bytes.len() as u64),
            megabytes(MAX_IMAGE_BYTES)
        )));
    }
    Ok(bytes)
}

/// Make an image acceptable to the relay, or say why it can't be. Anything that isn't one of the relay's images passes through.
pub fn sanitize_image_for_upload(bytes: Vec<u8>) -> Result<Vec<u8>> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let clean = strip_png_metadata(&bytes).ok_or_else(damaged)?;
        // IHDR comes first, and it's all the relay reads to measure the image.
        let dimension = |at: usize| {
            clean
                .get(at..at + 4)
                .and_then(|b| b.try_into().ok())
                .map(u32::from_be_bytes)
                .ok_or_else(damaged)
        };
        let (w, h) = (dimension(16)?, dimension(20)?);
        // EXIF is rare in a PNG, but where it turns the image that has to be baked in before it goes.
        use image::ImageDecoder as _;
        let turned = !png_is_animated(&clean)
            && image::ImageReader::with_format(
                std::io::Cursor::new(&bytes),
                image::ImageFormat::Png,
            )
            .into_decoder()
            .and_then(|mut d| d.orientation())
            .is_ok_and(|o| o != image::metadata::Orientation::NoTransforms);
        if turned {
            let upright = shrink(decoded(&bytes, image::ImageFormat::Png)?);
            return within_size(encoded(&upright, image::ImageFormat::Png)?);
        }
        if fits(w, h) {
            return within_size(clean);
        }
        if png_is_animated(&clean) {
            return Err(refuse(format!("This animation is {w}x{h}; Buzz takes up to 25 megapixels. Scale it down, then attach it again.")));
        }
        let scaled = shrink(decoded(&clean, image::ImageFormat::Png)?);
        return within_size(encoded(&scaled, image::ImageFormat::Png)?);
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        let scaled = shrink(decoded(&bytes, image::ImageFormat::Jpeg)?);
        return within_size(encoded(&scaled, image::ImageFormat::Jpeg)?);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        let clean = strip_gif_metadata(&bytes).ok_or_else(damaged)?;
        let w = u32::from(u16::from_le_bytes([clean[6], clean[7]]));
        let h = u32::from(u16::from_le_bytes([clean[8], clean[9]]));
        if !fits(w, h) {
            return Err(refuse(format!("This GIF is {w}x{h}; Buzz takes up to 25 megapixels. Scale it down, then attach it again.")));
        }
        if clean.len() as u64 > MAX_GIF_BYTES {
            return Err(refuse(format!(
                "This GIF is {}; Buzz takes GIFs up to {}. Shorten it, then attach it again.",
                megabytes(clean.len() as u64),
                megabytes(MAX_GIF_BYTES)
            )));
        }
        return Ok(clean);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        let clean = strip_webp_metadata(&bytes).ok_or_else(damaged)?;
        if webp_is_animated(&clean) {
            // The canvas size is all the relay measures, and frames can't be scaled without re-encoding them.
            let canvas = webp_chunks(&clean[12..]).and_then(|c| {
                c.into_iter()
                    .find(|(k, _)| k == b"VP8X")
                    .map(|(_, d)| d.to_vec())
            });
            if let Some(d) = canvas.filter(|d| d.len() >= 10) {
                let w = u32::from_le_bytes([d[4], d[5], d[6], 0]) + 1;
                let h = u32::from_le_bytes([d[7], d[8], d[9], 0]) + 1;
                if !fits(w, h) {
                    return Err(refuse(format!("This animation is {w}x{h}; Buzz takes up to 25 megapixels. Scale it down, then attach it again.")));
                }
            }
            return within_size(clean);
        }
        use image::ImageDecoder as _;
        let turned =
            image::ImageReader::with_format(std::io::Cursor::new(&bytes), image::ImageFormat::WebP)
                .into_decoder()
                .and_then(|mut d| d.orientation())
                .is_ok_and(|o| o != image::metadata::Orientation::NoTransforms);
        let (w, h) =
            image::ImageReader::with_format(std::io::Cursor::new(&clean), image::ImageFormat::WebP)
                .into_dimensions()
                .map_err(|_| damaged())?;
        // Only these need the pixels: the rest keep their compressed bytes, with no loss and no growth.
        if !turned && fits(w, h) {
            return within_size(clean);
        }
        let scaled = shrink(decoded(&bytes, image::ImageFormat::WebP)?);
        return within_size(encoded(&scaled, image::ImageFormat::WebP)?);
    }
    Ok(bytes)
}
