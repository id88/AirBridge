import QrWorker from "./qr.worker?worker&inline";
import zxingWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

export type EnginePreference = "auto" | "native" | "wasm";

export interface DecodeOutput {
  texts: string[];
  elapsedMs: number;
  engine: "native" | "wasm";
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  ready: boolean;
}

function decodeDataUrlToBytes(url: string): ArrayBuffer {
  const comma = url.indexOf(",");
  const b64 = url.slice(comma + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function loadWasmBinary(): Promise<ArrayBuffer> {
  if (zxingWasmUrl.startsWith("data:")) {
    return decodeDataUrlToBytes(zxingWasmUrl);
  }
  const resolved = new URL(zxingWasmUrl, window.location.href).href;
  const res = await fetch(resolved);
  if (!res.ok) {
    throw new Error(`无法加载 ZXing WASM (${res.status})`);
  }
  return res.arrayBuffer();
}

export class DecoderPool {
  private nativeDetector: BarcodeDetectorInstance | null = null;
  private nativeSupported = false;
  private nativeBusy = false;

  private slots: WorkerSlot[] = [];
  private wasmInitPromise: Promise<void> | null = null;
  private nextJobId = 1;
  private pendingResolvers = new Map<number, (out: DecodeOutput) => void>();

  private scratchCanvas: HTMLCanvasElement;
  private scratchCtx: CanvasRenderingContext2D;

  constructor() {
    this.scratchCanvas = document.createElement("canvas");
    const ctx = this.scratchCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.scratchCtx = ctx;
  }

  async init(): Promise<{ nativeSupported: boolean; workerCount: number }> {
    if (typeof window !== "undefined" && typeof window.BarcodeDetector === "function") {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes("qr_code")) {
          this.nativeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
          this.nativeSupported = true;
        }
      } catch {
        this.nativeSupported = false;
      }
    }
    return { nativeSupported: this.nativeSupported, workerCount: this.desiredWorkerCount() };
  }

  get hasNative(): boolean {
    return this.nativeSupported && this.nativeDetector !== null;
  }

  private desiredWorkerCount(): number {
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 2;
    return Math.min(4, Math.max(2, cores - 1));
  }

  private async ensureWasmPool(): Promise<void> {
    if (this.slots.length > 0) return;
    if (this.wasmInitPromise) return this.wasmInitPromise;

    this.wasmInitPromise = (async () => {
      const wasmBuf = await loadWasmBinary();
      const count = this.desiredWorkerCount();
      const readyWaiters: Array<Promise<void>> = [];

      for (let i = 0; i < count; i++) {
        const worker = new QrWorker();
        const slot: WorkerSlot = { worker, busy: false, ready: false };
        this.slots.push(slot);

        const readyP = new Promise<void>((resolve, reject) => {
          worker.onmessage = (ev: MessageEvent) => {
            const msg = ev.data;
            if (msg.type === "ready") {
              slot.ready = true;
              resolve();
              return;
            }
            if (msg.type === "error") {
              reject(new Error(msg.message || "WASM worker init failed"));
              return;
            }
            if (msg.type === "result") {
              slot.busy = false;
              const cb = this.pendingResolvers.get(msg.id);
              if (cb) {
                this.pendingResolvers.delete(msg.id);
                cb({ texts: msg.texts, elapsedMs: msg.elapsedMs, engine: "wasm" });
              }
            }
          };
          worker.onerror = (e) => reject(new Error(e.message || "Worker error"));
        });

        const copy = wasmBuf.slice(0);
        worker.postMessage({ type: "init", wasmBinary: copy }, [copy]);
        readyWaiters.push(readyP);
      }

      await Promise.all(readyWaiters);
    })();

    return this.wasmInitPromise;
  }

  resolveEngine(pref: EnginePreference): "native" | "wasm" {
    if (pref === "native" && this.hasNative) return "native";
    if (pref === "wasm") return "wasm";
    return this.hasNative ? "native" : "wasm";
  }

  canAcceptFrame(pref: EnginePreference): boolean {
    const engine = this.resolveEngine(pref);
    if (engine === "native") return !this.nativeBusy;
    if (this.slots.length === 0) return true;
    return this.slots.some((s) => s.ready && !s.busy);
  }

  async decodeVideoFrame(
    video: HTMLVideoElement,
    pref: EnginePreference,
    multiGrid: boolean,
  ): Promise<DecodeOutput | null> {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) return null;

    const engine = this.resolveEngine(pref);

    if (engine === "native" && this.nativeDetector) {
      if (this.nativeBusy) return null;
      this.nativeBusy = true;
      const start = performance.now();
      try {
        const detected = await this.nativeDetector.detect(video);
        const texts = detected.map((b) => b.rawValue).filter(Boolean);
        return {
          texts,
          elapsedMs: Math.round(performance.now() - start),
          engine: "native",
        };
      } catch {
        return { texts: [], elapsedMs: Math.round(performance.now() - start), engine: "native" };
      } finally {
        this.nativeBusy = false;
      }
    }

    await this.ensureWasmPool();
    const slot = this.slots.find((s) => s.ready && !s.busy);
    if (!slot) return null; // Backpressure: drop frame when all workers are busy

    // Cap max capture dimension: 1280px for 2x2 grid, 960px for single QR
    const maxDim = multiGrid ? 1280 : 960;
    const scale = Math.min(1, maxDim / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (this.scratchCanvas.width !== w || this.scratchCanvas.height !== h) {
      this.scratchCanvas.width = w;
      this.scratchCanvas.height = h;
    }
    this.scratchCtx.drawImage(video, 0, 0, w, h);
    const imgData = this.scratchCtx.getImageData(0, 0, w, h);

    return this.dispatchToWorker(slot, imgData, multiGrid);
  }

  async decodeImageFile(file: File, multiGrid: boolean): Promise<DecodeOutput> {
    const bitmap = await createImageBitmap(file);
    try {
      const maxDim = 1600;
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      this.scratchCanvas.width = w;
      this.scratchCanvas.height = h;
      this.scratchCtx.drawImage(bitmap, 0, 0, w, h);
      const imgData = this.scratchCtx.getImageData(0, 0, w, h);

      await this.ensureWasmPool();
      const slot = this.slots.find((s) => s.ready && !s.busy) ?? this.slots[0]!;
      return await this.dispatchToWorker(slot, imgData, multiGrid);
    } finally {
      bitmap.close();
    }
  }

  private dispatchToWorker(slot: WorkerSlot, imgData: ImageData, multiGrid: boolean): Promise<DecodeOutput> {
    slot.busy = true;
    const id = this.nextJobId++;
    const buffer = imgData.data.buffer;

    return new Promise<DecodeOutput>((resolve) => {
      this.pendingResolvers.set(id, resolve);
      slot.worker.postMessage(
        {
          type: "decode",
          id,
          width: imgData.width,
          height: imgData.height,
          buffer,
          multiGrid,
        },
        [buffer],
      );
    });
  }

  dispose(): void {
    for (const s of this.slots) s.worker.terminate();
    this.slots = [];
    this.pendingResolvers.clear();
    this.wasmInitPromise = null;
  }
}
