//! Prepare recordings exactly as the upload does, with no key and no network: Opus in WebM through this platform's codecs
//! into AAC parts cut at pauses (`media::voice_parts`), then each part through the normalizer. Prints each part's length,
//! where the cuts fell, the time taken and the most memory the process held. Built for Android and run on a device or
//! emulator, since only there are the codecs:
//!
//! cargo build -p uni-core --example voice_probe --target x86_64-linux-android
//! adb push target/x86_64-linux-android/debug/examples/voice_probe /data/local/tmp/
//! adb shell /data/local/tmp/voice_probe <out-dir> <file.webm>...
use std::path::Path;

/// Peak resident memory (VmHWM), in kB.
fn peak_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM:")).map(str::to_string))
        .and_then(|l| l.split_whitespace().nth(1).and_then(|v| v.parse().ok()))
        .unwrap_or(0)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = Path::new(&args[1]);
    std::fs::create_dir_all(out).unwrap();
    let codecs = uni_core::media::voice::platform_codecs();
    println!("codecs: {}", if codecs.is_some() { "this platform's" } else { "none here: recordings go as they are" });
    for path in &args[2..] {
        let input = Path::new(path);
        let name = input.file_name().unwrap().to_string_lossy().to_string();
        let started = std::time::Instant::now();
        let parts = match uni_core::media::voice_parts(input, &name, out, codecs) {
            Ok(Some(parts)) => parts,
            Ok(None) => {
                println!("{name}: not converted");
                continue;
            }
            Err(e) => {
                println!("{name}: REFUSED {e}");
                continue;
            }
        };
        let converted = started.elapsed();
        println!("{name}: {} part(s), converted in {:.1} s, peak memory so far {} kB", parts.len(), converted.as_secs_f64(), peak_kb());
        for (part, part_name) in &parts {
            match uni_core::media::normalize::normalize_file(part, part_name, out) {
                Ok(n) => {
                    let dest = out.join(&n.filename);
                    std::fs::rename(&n.path, &dest).unwrap();
                    println!("  {} -> {} ({} bytes)", part_name, dest.display(), std::fs::metadata(&dest).unwrap().len());
                }
                Err(e) => println!("  {part_name}: REFUSED {e}"),
            }
            let _ = std::fs::remove_file(part);
        }
        println!("{name}: done in {:.1} s, peak memory {} kB", started.elapsed().as_secs_f64(), peak_kb());
    }
}
