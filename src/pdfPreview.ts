// First-page PDF thumbnails via pdf.js, loaded lazily so the main bundle stays small.
// Legacy build: the Daylight's WebView may lag current Chrome.
let lib: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;

function pdfjs() {
  lib ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]).then(([m, worker]) => {
    m.GlobalWorkerOptions.workerSrc = worker.default;
    return m;
  });
  return lib;
}

/** Render page 1 of a PDF to a PNG blob URL no wider than `width` CSS px. */
export async function pdfThumbnail(bytes: ArrayBuffer, width = 240): Promise<{ src: string; pages: number }> {
  const m = await pdfjs();
  const task = m.getDocument({ data: new Uint8Array(bytes.slice(0)) });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = (width * Math.min(2, window.devicePixelRatio || 1)) / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("render failed"))), "image/png"));
    return { src: URL.createObjectURL(blob), pages: doc.numPages };
  } finally {
    void task.destroy();
  }
}
