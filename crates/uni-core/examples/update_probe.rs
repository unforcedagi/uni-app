//! Fetch the Android update manifest with the same client the app uses.
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    uni_core::init_crypto();
    let body = uni_core::media::https_client_following_redirects(std::time::Duration::from_secs(12))?
        .get("https://github.com/unforcedagi/uni-app/releases/latest/download/android.json")
        .send().await?.error_for_status()?.text().await?;
    println!("{body}");
    Ok(())
}
