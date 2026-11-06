//! Run the upload normalizer on files, and nothing else: no key, no network. For checking its output with other tools.
//!
//! cargo run -p uni-core --example normalize_file -- <out-dir> <file>...
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = Path::new(&args[1]);
    for path in &args[2..] {
        let input = Path::new(path);
        let name = input.file_name().unwrap().to_string_lossy().to_string();
        match uni_core::media::normalize::normalize_file(input, &name, out) {
            Ok(n) if n.rewritten => {
                let dest = out.join(&n.filename);
                let dest = if dest == input {
                    out.join(format!("clean-{}", n.filename))
                } else {
                    dest
                };
                std::fs::rename(&n.path, &dest).unwrap();
                println!("REWRITTEN {name} -> {}", dest.display());
            }
            Ok(_) => println!("UNCHANGED {name}"),
            Err(e) => println!("REFUSED   {name}: {e}"),
        }
    }
}
