import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

interface InitMsg {
  type: "init";
  wasmBinary: ArrayBuffer;
}

interface DecodeMsg {
  type: "decode";
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  multiGrid: boolean;
}

type WorkerInMsg = InitMsg | DecodeMsg;

let readyPromise: Promise<unknown> | null = null;

function cropImageData(
  src: Uint8ClampedArray,
  srcW: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): ImageData {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcOff = ((y0 + row) * srcW + x0) * 4;
    const dstOff = row * w * 4;
    out.set(src.subarray(srcOff, srcOff + w * 4), dstOff);
  }
  return new ImageData(out, w, h);
}

self.onmessage = async (event: MessageEvent<WorkerInMsg>) => {
  const msg = event.data;

  if (msg.type === "init") {
    try {
      readyPromise = prepareZXingModule({
        overrides: { wasmBinary: msg.wasmBinary },
        fireImmediately: true,
      });
      await readyPromise;
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === "decode") {
    const start = performance.now();
    try {
      if (readyPromise) await readyPromise;
      const rgba = new Uint8ClampedArray(msg.buffer);
      const full = new ImageData(rgba, msg.width, msg.height);

      const results = await readBarcodes(full, {
        formats: ["QRCode"],
        maxNumberOfSymbols: msg.multiGrid ? 6 : 2,
        tryHarder: false,
        tryRotate: true,
        tryDownscale: true,
        downscaleFactor: 2,
      });

      const texts = new Set<string>();
      for (const r of results) {
        if (r.text) texts.add(r.text);
      }

      // If 2x2 grid mode is active and full-frame scan caught fewer than 4 codes,
      // scan 4 slightly overlapping quadrants to pick up dense grid cells reliably.
      if (msg.multiGrid && texts.size < 4 && msg.width >= 320 && msg.height >= 320) {
        const halfW = Math.floor(msg.width * 0.56);
        const halfH = Math.floor(msg.height * 0.56);
        const rightX = msg.width - halfW;
        const bottomY = msg.height - halfH;
        const quads: Array<[number, number]> = [
          [0, 0],
          [rightX, 0],
          [0, bottomY],
          [rightX, bottomY],
        ];
        for (const [qx, qy] of quads) {
          const sub = cropImageData(rgba, msg.width, qx, qy, halfW, halfH);
          const qRes = await readBarcodes(sub, {
            formats: ["QRCode"],
            maxNumberOfSymbols: 2,
            tryHarder: false,
            tryRotate: false,
            tryDownscale: false,
          });
          for (const r of qRes) {
            if (r.text) texts.add(r.text);
          }
        }
      }

      self.postMessage({
        type: "result",
        id: msg.id,
        texts: [...texts],
        elapsedMs: Math.round(performance.now() - start),
      });
    } catch {
      self.postMessage({
        type: "result",
        id: msg.id,
        texts: [],
        elapsedMs: Math.round(performance.now() - start),
      });
    }
  }
};
