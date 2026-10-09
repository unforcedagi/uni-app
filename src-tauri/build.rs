fn main() {
    // The wry version the self-test pass is keyed on (see `webview_runtime`): read it from the lockfile.
    let lock = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../Cargo.lock");
    println!("cargo:rerun-if-changed={}", lock.display());
    let text = std::fs::read_to_string(&lock).unwrap_or_default();
    let version = text
        .split("[[package]]")
        .find(|p| p.lines().any(|l| l.trim() == "name = \"wry\""))
        .and_then(|p| p.lines().find_map(|l| l.trim().strip_prefix("version = \"")?.strip_suffix('"')))
        .unwrap_or("unknown");
    println!("cargo:rustc-env=UNI_WRY_VERSION={version}");
    tauri_build::build()
}
