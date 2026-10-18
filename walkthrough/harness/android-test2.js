(async () => {
  const T = window.__TAURI_INTERNALS__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sha = 'fc17a6aad1586839a26ba0aaf47dc8b11a9f12b8e2172d5ac28449003a0849e6';
  const origin = await T.invoke('relay_origin');
  let r;
  try { r = await T.invoke('media_stream', { url: origin + '/media/' + sha + '.mp4', sha, mime: 'video/mp4' }); } catch (e) { return { error: String(e) }; }
  const src = r.url ?? T.convertFileSrc(r.sha, 'unimedia');
  document.querySelectorAll('video.t172').forEach((x) => x.remove());
  const v = document.createElement('video');
  v.className = 't172'; v.muted = true; v.controls = true; v.playsInline = true;
  v.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:56vw;z-index:2147483647;background:#000';
  let stalls = 0; v.addEventListener('waiting', () => stalls++);
  v.src = src; document.body.appendChild(v);
  await v.play().catch((e) => {});
  const samples = [];
  for (let i = 0; i < 12; i++) { await sleep(1000); samples.push(Math.round(v.currentTime * 10) / 10); }
  v.currentTime = 45;
  const afterSeek = [];
  for (let i = 0; i < 6; i++) { await sleep(1000); afterSeek.push(Math.round(v.currentTime * 10) / 10); }
  return { src: src.replace(/[0-9a-f]{64}\/?/g, '<hex>/'), duration: v.duration, w: v.videoWidth, h: v.videoHeight, samples, afterSeek, stalls, readyState: v.readyState, err: v.error && v.error.code, frames: v.getVideoPlaybackQuality().totalVideoFrames };
})()
