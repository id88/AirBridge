import "./styles.css";
import { AirBridgeSolver, type SerializedSession } from "./core/fountain";
import {
  formatBytes,
  formatMissingRanges,
  parseFrame,
  verifyAndExtractArchive,
  type ExtractedFile,
} from "./core/protocol";
import { deleteSession, listSessions, loadSession, saveSession } from "./core/storage";
import { DecoderPool, type EnginePreference } from "./scanner/decoderPool";
import { renderHeatmap } from "./ui/heatmap";

const isSingleFile = typeof __SINGLE_FILE_BUILD__ !== "undefined" && __SINGLE_FILE_BUILD__;

interface Diagnostics {
  capturedFrames: number;
  decodedCodes: number;
  validFrames: number;
  invalidFrames: number;
  duplicateFrames: number;
  lastDecodeMs: number;
  lastHitAt: number;
  activeEngine: "native" | "wasm" | "-";
}

interface CompletedPayload {
  sid: string;
  fullSha256: string;
  archiveBytes: Uint8Array;
  files: ExtractedFile[];
  elapsedSec: number;
}

class AirBridgeApp {
  private readonly root: HTMLElement;
  private readonly pool = new DecoderPool();

  private solver: AirBridgeSolver | null = null;
  private completed: CompletedPayload | null = null;
  private savedSessions: SerializedSession[] = [];

  private stream: MediaStream | null = null;
  private videoTrack: MediaStreamTrack | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private scanning = false;
  private rafId = 0;

  private enginePref: EnginePreference = "auto";
  private multiGrid = false;
  private vibrateOn = true;

  private startedAt = 0;
  private sessionNewBytes = 0;
  private fpsSamples: number[] = [];
  private freshBlocks = new Set<number>();
  private persistTimer: number | null = null;
  private showMissing = false;

  private diag: Diagnostics = {
    capturedFrames: 0,
    decodedCodes: 0,
    validFrames: 0,
    invalidFrames: 0,
    duplicateFrames: 0,
    lastDecodeMs: 0,
    lastHitAt: 0,
    activeEngine: "-",
  };

  // DOM refs
  private videoEl!: HTMLVideoElement;
  private placeholderEl!: HTMLElement;
  private scanFrameEl!: HTMLElement;
  private hudLeftEl!: HTMLElement;
  private hudRightEl!: HTMLElement;
  private toggleBtn!: HTMLButtonElement;
  private zoomWrapEl!: HTMLElement;
  private zoomInput!: HTMLInputElement;
  private zoomValEl!: HTMLElement;
  private pwaPillEl!: HTMLElement;
  private bannerEl!: HTMLElement;
  private progressCardEl!: HTMLElement;
  private progressTitleEl!: HTMLElement;
  private progressPctEl!: HTMLElement;
  private progressSolvedBar!: HTMLElement;
  private progressRankBar!: HTMLElement;
  private heatmapCanvas!: HTMLCanvasElement;
  private statSpeedEl!: HTMLElement;
  private statFpsEl!: HTMLElement;
  private statRankEl!: HTMLElement;
  private statEtaEl!: HTMLElement;
  private missingBoxEl!: HTMLElement;
  private diagHintEl!: HTMLElement;
  private diagTableEl!: HTMLElement;
  private resultCardEl!: HTMLElement;
  private sessionsCardEl!: HTMLElement;
  private sessionsListEl!: HTMLElement;
  private fileImportInput!: HTMLInputElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.renderShell();
    this.bindEvents();
    void this.bootstrap();
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <div class="brand">
            <img class="brand-logo" src="./icon.svg" alt="AirBridge" onerror="this.style.display='none'" />
            <div>
              <h1>AirBridge 离线接收端</h1>
              <small>单码 / 2×2 网格 / 自描述 XOR 喷泉</small>
            </div>
          </div>
          <span id="pwa-pill" class="pill">初始化中...</span>
        </header>

        <div id="env-banner" class="banner hidden"></div>

        <section class="card">
          <div class="viewport-wrap">
            <video id="camera-video" playsinline muted autoplay></video>
            <div id="viewport-placeholder" class="viewport-placeholder">
              <strong>对准电脑屏幕二维码即可接收</strong>
              <span>支持 1×1 单码与 2×2 多码网格，自动去重与喷泉恢复</span>
            </div>
            <div id="scan-frame" class="scan-frame hidden"></div>
            <div class="hud-overlay">
              <span id="hud-left" class="hud-chip">待机</span>
              <span id="hud-right" class="hud-chip">引擎: --</span>
            </div>
          </div>

          <div class="controls">
            <div class="btn-row">
              <button id="btn-toggle-scan" class="primary">开始扫码接收</button>
              <button id="btn-import-img" title="从相册或截图解码测试">图片扫码</button>
              <input id="file-import" type="file" accept="image/*" multiple class="hidden" />
            </div>

            <div id="zoom-wrap" class="zoom-row hidden">
              <span>变焦</span>
              <input id="zoom-slider" type="range" min="1" max="3" step="0.1" value="1" />
              <span id="zoom-val">1.0×</span>
            </div>

            <div class="control-grid">
              <label class="field-label">
                解码引擎
                <select id="sel-engine">
                  <option value="auto">自动 (推荐)</option>
                  <option value="native">原生硬解 (BarcodeDetector)</option>
                  <option value="wasm">ZXing-C++ WASM 线程池</option>
                </select>
              </label>
              <div class="toggle-row">
                <label><input id="chk-grid" type="checkbox" /> 2×2 网格增强</label>
                <label><input id="chk-vibe" type="checkbox" checked /> 震动反馈</label>
              </div>
            </div>
          </div>
        </section>

        <section id="progress-card" class="card hidden">
          <div class="progress-header">
            <strong id="progress-title">会话 #--------</strong>
            <strong id="progress-pct">0%</strong>
          </div>
          <div class="progress-track">
            <div id="bar-rank" class="progress-rank" style="width:0%"></div>
            <div id="bar-solved" class="progress-solved" style="width:0%"></div>
          </div>
          <canvas id="heatmap" class="heatmap-canvas"></canvas>

          <div class="stats-grid">
            <div class="stat-box"><span id="stat-speed" class="val">0 KB/s</span><span class="lbl">有效速率</span></div>
            <div class="stat-box"><span id="stat-fps" class="val">0</span><span class="lbl">扫描 FPS</span></div>
            <div class="stat-box"><span id="stat-rank" class="val">0/0</span><span class="lbl">秩 / 总块</span></div>
            <div class="stat-box"><span id="stat-eta" class="val">--</span><span class="lbl">预计剩余</span></div>
          </div>

          <div class="btn-row">
            <button id="btn-missing">查看缺失块号</button>
            <button id="btn-copy-missing">复制缺失区间</button>
            <button id="btn-reset" class="danger">重置会话</button>
          </div>

          <div id="missing-box" class="missing-box hidden"></div>
          <div id="diag-hint" class="diag-hint hidden"></div>

          <details style="margin-top:10px">
            <summary>实时诊断指标</summary>
            <div id="diag-table" class="diag-table"></div>
          </details>
        </section>

        <section id="result-card" class="card hidden"></section>

        <section id="sessions-card" class="card hidden">
          <div class="progress-header">
            <strong>未完成会话（断点续传）</strong>
            <small style="color:var(--muted)">对准屏幕自动继续</small>
          </div>
          <div id="sessions-list" class="session-list"></div>
        </section>
      </div>
    `;

    this.videoEl = this.root.querySelector("#camera-video")!;
    this.placeholderEl = this.root.querySelector("#viewport-placeholder")!;
    this.scanFrameEl = this.root.querySelector("#scan-frame")!;
    this.hudLeftEl = this.root.querySelector("#hud-left")!;
    this.hudRightEl = this.root.querySelector("#hud-right")!;
    this.toggleBtn = this.root.querySelector("#btn-toggle-scan")!;
    this.zoomWrapEl = this.root.querySelector("#zoom-wrap")!;
    this.zoomInput = this.root.querySelector("#zoom-slider")!;
    this.zoomValEl = this.root.querySelector("#zoom-val")!;
    this.pwaPillEl = this.root.querySelector("#pwa-pill")!;
    this.bannerEl = this.root.querySelector("#env-banner")!;
    this.progressCardEl = this.root.querySelector("#progress-card")!;
    this.progressTitleEl = this.root.querySelector("#progress-title")!;
    this.progressPctEl = this.root.querySelector("#progress-pct")!;
    this.progressSolvedBar = this.root.querySelector("#bar-solved")!;
    this.progressRankBar = this.root.querySelector("#bar-rank")!;
    this.heatmapCanvas = this.root.querySelector("#heatmap")!;
    this.statSpeedEl = this.root.querySelector("#stat-speed")!;
    this.statFpsEl = this.root.querySelector("#stat-fps")!;
    this.statRankEl = this.root.querySelector("#stat-rank")!;
    this.statEtaEl = this.root.querySelector("#stat-eta")!;
    this.missingBoxEl = this.root.querySelector("#missing-box")!;
    this.diagHintEl = this.root.querySelector("#diag-hint")!;
    this.diagTableEl = this.root.querySelector("#diag-table")!;
    this.resultCardEl = this.root.querySelector("#result-card")!;
    this.sessionsCardEl = this.root.querySelector("#sessions-card")!;
    this.sessionsListEl = this.root.querySelector("#sessions-list")!;
    this.fileImportInput = this.root.querySelector("#file-import")!;
  }

  private bindEvents(): void {
    this.toggleBtn.addEventListener("click", () => {
      if (this.scanning) void this.stopCamera();
      else void this.startCamera();
    });

    this.root.querySelector("#btn-import-img")!.addEventListener("click", () => {
      this.fileImportInput.value = "";
      this.fileImportInput.click();
    });

    this.fileImportInput.addEventListener("change", () => {
      const files = this.fileImportInput.files;
      if (files && files.length > 0) void this.handleImportedImages(files);
    });

    this.root.querySelector("#sel-engine")!.addEventListener("change", (e) => {
      this.enginePref = (e.target as HTMLSelectElement).value as EnginePreference;
      this.updateHud();
    });

    this.root.querySelector("#chk-grid")!.addEventListener("change", (e) => {
      this.multiGrid = (e.target as HTMLInputElement).checked;
    });

    this.root.querySelector("#chk-vibe")!.addEventListener("change", (e) => {
      this.vibrateOn = (e.target as HTMLInputElement).checked;
    });

    this.zoomInput.addEventListener("input", () => {
      const z = Number(this.zoomInput.value);
      this.zoomValEl.textContent = `${z.toFixed(1)}×`;
      if (this.videoTrack) {
        void this.videoTrack.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] }).catch(() => {});
      }
    });

    this.root.querySelector("#btn-missing")!.addEventListener("click", () => {
      this.showMissing = !this.showMissing;
      this.updateProgressUI();
    });

    this.root.querySelector("#btn-copy-missing")!.addEventListener("click", async () => {
      if (!this.solver) return;
      const text = formatMissingRanges(this.solver.getMissingIndices());
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        this.showBanner(`已复制缺失块号: ${text}（在发送端按 M 键粘贴即可定向补漏）`, true);
      } catch {
        this.showMissing = true;
        this.updateProgressUI();
      }
    });

    this.root.querySelector("#btn-reset")!.addEventListener("click", () => {
      if (this.solver) void deleteSession(this.solver.sid);
      this.solver = null;
      this.completed = null;
      this.showMissing = false;
      this.progressCardEl.classList.add("hidden");
      this.resultCardEl.classList.add("hidden");
      void this.refreshSavedSessions();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.scanning) {
        void this.requestWakeLock();
      }
    });
  }

  private async bootstrap(): Promise<void> {
    // Check secure context for Android 14 camera API
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.showBanner(
        "当前页面非安全上下文（如直接打开 file://），Android 14 浏览器会禁用摄像头。请通过 HTTPS / GitHub Pages 打开（首次加载后自动离线可用），或使用 Termux 本地 http://127.0.0.1 启动。",
        false,
      );
    }

    // Register Service Worker for PWA offline caching (skip in single-file bundle)
    if (!isSingleFile && "serviceWorker" in navigator && window.isSecureContext) {
      try {
        await navigator.serviceWorker.register("./sw.js");
        this.pwaPillEl.textContent = "PWA 离线就绪";
        this.pwaPillEl.className = "pill ok";
      } catch {
        this.pwaPillEl.textContent = "在线模式";
        this.pwaPillEl.className = "pill";
      }
    } else if (isSingleFile) {
      this.pwaPillEl.textContent = "单文件离线包";
      this.pwaPillEl.className = "pill ok";
    } else {
      this.pwaPillEl.textContent = "受限上下文";
      this.pwaPillEl.className = "pill warn";
    }

    const { nativeSupported } = await this.pool.init();
    if (!nativeSupported) {
      const sel = this.root.querySelector("#sel-engine") as HTMLSelectElement;
      const opt = sel.querySelector('option[value="native"]') as HTMLOptionElement | null;
      if (opt) opt.textContent = "原生硬解 (当前浏览器不支持)";
    }
    this.updateHud();
    await this.refreshSavedSessions();
  }

  private showBanner(msg: string, info = false): void {
    this.bannerEl.textContent = msg;
    this.bannerEl.className = info ? "banner info" : "banner";
    if (info) {
      window.setTimeout(() => {
        if (this.bannerEl.textContent === msg) this.bannerEl.classList.add("hidden");
      }, 4500);
    }
  }

  private async requestWakeLock(): Promise<void> {
    try {
      if ("wakeLock" in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => {
          this.wakeLock = null;
        });
      }
    } catch {
      // Optional enhancement
    }
  }

  private async startCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.showBanner("当前环境无法调用摄像头，请使用 HTTPS 或 localhost 访问，或点击「图片扫码」测试。", false);
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();
      this.videoTrack = this.stream.getVideoTracks()[0] ?? null;

      // Enable continuous autofocus and zoom slider if supported by Android 14 camera
      if (this.videoTrack && typeof this.videoTrack.getCapabilities === "function") {
        const caps = this.videoTrack.getCapabilities() as MediaTrackCapabilities & {
          zoom?: { min: number; max: number; step?: number };
          focusMode?: string[];
        };
        if (caps.focusMode?.includes("continuous")) {
          void this.videoTrack
            .applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] })
            .catch(() => {});
        }
        if (caps.zoom && caps.zoom.max > caps.zoom.min) {
          this.zoomInput.min = String(caps.zoom.min);
          this.zoomInput.max = String(Math.min(caps.zoom.max, 4));
          this.zoomInput.step = String(caps.zoom.step || 0.1);
          this.zoomInput.value = String(caps.zoom.min);
          this.zoomValEl.textContent = `${caps.zoom.min.toFixed(1)}×`;
          this.zoomWrapEl.classList.remove("hidden");
        }
      }

      this.scanning = true;
      this.diag.lastHitAt = performance.now();
      this.placeholderEl.classList.add("hidden");
      this.scanFrameEl.classList.remove("hidden");
      this.toggleBtn.textContent = "停止扫码";
      this.toggleBtn.className = "danger";
      this.toggleBtn.style.flex = "1";
      await this.requestWakeLock();
      this.loop();
    } catch (err) {
      this.showBanner(`摄像头打开失败：${err instanceof Error ? err.message : String(err)}`, false);
    }
  }

  private async stopCamera(): Promise<void> {
    this.scanning = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
      this.videoTrack = null;
    }
    this.videoEl.srcObject = null;
    if (this.wakeLock) {
      await this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
    this.placeholderEl.classList.remove("hidden");
    this.scanFrameEl.classList.add("hidden");
    this.zoomWrapEl.classList.add("hidden");
    this.toggleBtn.textContent = "开始扫码接收";
    this.toggleBtn.className = "primary";
    this.hudLeftEl.textContent = "已停止";
  }

  private loop = (): void => {
    if (!this.scanning) return;
    if (this.pool.canAcceptFrame(this.enginePref)) {
      this.diag.capturedFrames++;
      void this.pool.decodeVideoFrame(this.videoEl, this.enginePref, this.multiGrid).then((out) => {
        if (!out || !this.scanning) return;
        this.diag.lastDecodeMs = out.elapsedMs;
        this.diag.activeEngine = out.engine;
        const now = performance.now();
        this.fpsSamples.push(now);
        while (this.fpsSamples.length > 0 && now - this.fpsSamples[0]! > 2000) {
          this.fpsSamples.shift();
        }
        if (out.texts.length > 0) {
          this.diag.decodedCodes += out.texts.length;
          this.diag.lastHitAt = now;
          void this.handleDecodedTexts(out.texts);
        }
        this.updateHud();
        this.updateDiagnosticsUI();
      });
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private async handleImportedImages(files: FileList): Promise<void> {
    let hitCount = 0;
    for (const file of Array.from(files)) {
      const out = await this.pool.decodeImageFile(file, this.multiGrid || true);
      this.diag.capturedFrames++;
      this.diag.lastDecodeMs = out.elapsedMs;
      this.diag.activeEngine = out.engine;
      if (out.texts.length > 0) {
        hitCount += out.texts.length;
        this.diag.decodedCodes += out.texts.length;
        await this.handleDecodedTexts(out.texts);
      }
    }
    if (hitCount === 0) {
      this.showBanner("所选图片中未识别到有效的 AirBridge 二维码。", false);
    }
  }

  private async handleDecodedTexts(texts: string[]): Promise<void> {
    let anyProgress = false;
    const freshThisTick: number[] = [];

    for (const raw of texts) {
      const frame = parseFrame(raw);
      if (!frame) {
        this.diag.invalidFrames++;
        continue;
      }
      this.diag.validFrames++;

      // Switch or restore session automatically when a new sid appears
      if (!this.solver || this.solver.sid !== frame.sid) {
        const restored = await loadSession(frame.sid);
        if (restored && restored.size === frame.size && restored.bs === frame.bs) {
          this.solver = AirBridgeSolver.deserialize(restored);
          this.showBanner(`已自动恢复断点会话 #${frame.sid.slice(0, 8)} (${this.solver.solvedCount}/${this.solver.total} 块)`, true);
        } else {
          this.solver = new AirBridgeSolver(frame.sid, frame.size, frame.bs);
        }
        this.completed = null;
        this.resultCardEl.classList.add("hidden");
        this.startedAt = performance.now();
        this.sessionNewBytes = 0;
        this.progressCardEl.classList.remove("hidden");
      }

      const res = this.solver.ingest(frame);
      if (res.status === "duplicate") {
        this.diag.duplicateFrames++;
      } else {
        anyProgress = true;
        this.sessionNewBytes += frame.bs;
        for (const id of res.newlySolved) freshThisTick.push(id);
      }

      if (res.status === "complete") {
        await this.onTransferComplete();
        return;
      }
    }

    if (anyProgress && this.solver) {
      this.freshBlocks = new Set(freshThisTick);
      if (this.vibrateOn && "vibrate" in navigator) {
        navigator.vibrate(15);
      }
      this.schedulePersist();
      this.updateProgressUI();
    }
  }

  private schedulePersist(): void {
    if (!this.solver || this.persistTimer !== null) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      if (this.solver && !this.solver.isComplete) {
        void saveSession(this.solver.serialize()).then(() => this.refreshSavedSessions());
      }
    }, 800);
  }

  private async onTransferComplete(): Promise<void> {
    if (!this.solver) return;
    const solver = this.solver;
    if (this.scanning) await this.stopCamera();
    this.updateProgressUI();

    try {
      const archiveBytes = solver.assemble();
      const { fullSha256, files } = await verifyAndExtractArchive(archiveBytes, solver.sid);
      const elapsedSec = Math.max(0.1, (performance.now() - this.startedAt) / 1000);
      this.completed = { sid: solver.sid, fullSha256, archiveBytes, files, elapsedSec };

      if (this.vibrateOn && "vibrate" in navigator) {
        navigator.vibrate([80, 60, 140]);
      }
      await deleteSession(solver.sid);
      await this.refreshSavedSessions();
      this.renderCompletedCard();
    } catch (err) {
      this.showBanner(`重组或校验失败：${err instanceof Error ? err.message : String(err)}`, false);
    }
  }

  private updateHud(): void {
    const fps = this.fpsSamples.length / 2;
    const engineLabel = this.diag.activeEngine !== "-"
      ? `${this.diag.activeEngine === "native" ? "原生硬解" : "ZXing WASM"} ${this.diag.lastDecodeMs}ms`
      : this.pool.resolveEngine(this.enginePref) === "native" ? "原生硬解(就绪)" : "ZXing WASM(就绪)";

    this.hudRightEl.textContent = `引擎: ${engineLabel}`;
    if (this.solver) {
      this.hudLeftEl.textContent = `进度 ${this.solver.rank}/${this.solver.total} | ${fps.toFixed(1)} FPS`;
    } else if (this.scanning) {
      this.hudLeftEl.textContent = `寻找二维码... | ${fps.toFixed(1)} FPS`;
    }
  }

  private updateProgressUI(): void {
    if (!this.solver) return;
    const { sid, total, solvedCount, rank, size, bs } = this.solver;
    const pct = Math.min(100, (rank / total) * 100);
    const solvedPct = Math.min(100, (solvedCount / total) * 100);

    this.progressTitleEl.textContent = `会话 #${sid.slice(0, 8)} · ${formatBytes(size)} (${bs}B/块)`;
    this.progressPctEl.textContent = `${pct.toFixed(1)}%`;
    this.progressSolvedBar.style.width = `${solvedPct}%`;
    this.progressRankBar.style.width = `${pct}%`;

    const elapsedSec = Math.max(0.5, (performance.now() - this.startedAt) / 1000);
    const speedBps = this.sessionNewBytes / elapsedSec;
    const remainingBytes = Math.max(0, (total - rank) * bs);
    const etaSec = speedBps > 50 ? remainingBytes / speedBps : 0;

    this.statSpeedEl.textContent = `${(speedBps / 1024).toFixed(1)} KB/s`;
    this.statFpsEl.textContent = `${(this.fpsSamples.length / 2).toFixed(1)}`;
    this.statRankEl.textContent = `${rank}/${total}`;
    this.statEtaEl.textContent = rank >= total ? "0s" : etaSec > 0 ? `${Math.ceil(etaSec)}s` : "--";

    renderHeatmap(this.heatmapCanvas, this.solver.getBlockStates(), this.freshBlocks);

    if (this.showMissing) {
      const missing = this.solver.getMissingIndices();
      this.missingBoxEl.textContent = missing.length
        ? `缺失 ${missing.length} 块（在发送端按 M 输入）: ${formatMissingRanges(missing)}`
        : "全部数据块已收齐！";
      this.missingBoxEl.classList.remove("hidden");
    } else {
      this.missingBoxEl.classList.add("hidden");
    }
    this.updateDiagnosticsUI();
  }

  private updateDiagnosticsUI(): void {
    const eqCount = this.solver?.equationCount ?? 0;
    this.diagTableEl.innerHTML = `
      <div>采集帧数: ${this.diag.capturedFrames}</div>
      <div>解出码数: ${this.diag.decodedCodes}</div>
      <div>有效帧: ${this.diag.validFrames}</div>
      <div>重复/线性相关: ${this.diag.duplicateFrames}</div>
      <div>无效/CRC错: ${this.diag.invalidFrames}</div>
      <div>GF(2) 待消元方程: ${eqCount}</div>
    `;

    const stallMs = this.scanning ? performance.now() - this.diag.lastHitAt : 0;
    if (this.scanning && stallMs > 2800 && (!this.solver || !this.solver.isComplete)) {
      this.diagHintEl.textContent = this.multiGrid
        ? "连续未识别：2×2 网格建议稍微拉远手机并用 1.5×~2× 变焦，避免屏幕反光，发送端帧率控制在 3~5 FPS。"
        : "连续未识别：请调整拍摄距离避开摩尔纹/反光，若码点过密可在发送端调小 -b 块大小或按 - 降低帧率。";
      this.diagHintEl.classList.remove("hidden");
    } else {
      this.diagHintEl.classList.add("hidden");
    }
  }

  private renderCompletedCard(): void {
    if (!this.completed) return;
    const { sid, fullSha256, archiveBytes, files, elapsedSec } = this.completed;
    const avgKbps = (archiveBytes.length / 1024 / elapsedSec).toFixed(1);

    this.resultCardEl.classList.remove("hidden");
    this.resultCardEl.innerHTML = `
      <div class="progress-header">
        <strong style="color:var(--green)">✓ 接收完成并通过 SHA-256 校验</strong>
        <span class="pill ok">${elapsedSec.toFixed(1)}s · ${avgKbps} KB/s</span>
      </div>
      <div style="font-size:11px;color:var(--muted);word-break:break-all;margin-bottom:8px">
        SHA-256: ${fullSha256}
      </div>
      <div class="btn-row">
        <button id="btn-dl-zip">下载原始 ZIP (${formatBytes(archiveBytes.length)})</button>
      </div>
      <div id="extracted-list" class="file-list"></div>
    `;

    this.resultCardEl.querySelector("#btn-dl-zip")!.addEventListener("click", () => {
      this.triggerDownload(`airbridge-${sid.slice(0, 8)}.zip`, archiveBytes, "application/zip");
    });

    const listEl = this.resultCardEl.querySelector("#extracted-list")!;
    for (const f of files) {
      const item = document.createElement("div");
      item.className = "file-item";

      const previewHtml = f.isText && f.textPreview !== undefined
        ? `<pre class="text-preview"></pre>`
        : "";
      const canShare = typeof navigator.share === "function" && typeof navigator.canShare === "function";

      item.innerHTML = `
        <div class="file-meta">
          <span class="file-name"></span>
          <span class="pill">${formatBytes(f.bytes.length)}</span>
        </div>
        ${previewHtml}
        <div class="btn-row">
          <button class="success btn-dl">保存文件</button>
          ${f.isText ? `<button class="btn-copy">复制文本</button>` : ""}
          ${canShare ? `<button class="btn-share">系统分享</button>` : ""}
        </div>
      `;

      item.querySelector(".file-name")!.textContent = f.name;
      if (f.isText && f.textPreview !== undefined) {
        const pre = item.querySelector(".text-preview")!;
        pre.textContent = f.textPreview.length > 4000
          ? `${f.textPreview.slice(0, 4000)}\n...（共 ${f.textPreview.length} 字符，完整内容请保存文件或点击复制）`
          : f.textPreview;
      }

      item.querySelector(".btn-dl")!.addEventListener("click", () => {
        const baseName = f.name.split("/").pop() || f.name;
        this.triggerDownload(baseName, f.bytes, f.isText ? "text/plain;charset=utf-8" : "application/octet-stream");
      });

      const copyBtn = item.querySelector(".btn-copy");
      if (copyBtn && f.textPreview !== undefined) {
        copyBtn.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(f.textPreview!);
            copyBtn.textContent = "已复制 ✓";
            setTimeout(() => (copyBtn.textContent = "复制文本"), 2000);
          } catch {
            this.showBanner("剪贴板写入失败，请手动长按上方预览框复制。", false);
          }
        });
      }

      const shareBtn = item.querySelector(".btn-share");
      if (shareBtn) {
        shareBtn.addEventListener("click", async () => {
          const baseName = f.name.split("/").pop() || f.name;
          const copy = new Uint8Array(f.bytes.byteLength);
          copy.set(f.bytes);
          const fileObj = new File([copy.buffer], baseName, {
            type: f.isText ? "text/plain" : "application/octet-stream",
          });
          if (navigator.canShare?.({ files: [fileObj] })) {
            await navigator.share({ files: [fileObj], title: baseName }).catch(() => {});
          } else {
            this.showBanner("当前浏览器不支持直接分享此文件类型，请点击「保存文件」。", true);
          }
        });
      }

      listEl.appendChild(item);
    }
  }

  private triggerDownload(filename: string, bytes: Uint8Array, mime: string): void {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy.buffer], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  private async refreshSavedSessions(): Promise<void> {
    this.savedSessions = await listSessions();
    const unfinished = this.savedSessions.filter((s) => s.solved.length < s.total);
    if (unfinished.length === 0) {
      this.sessionsCardEl.classList.add("hidden");
      return;
    }
    this.sessionsCardEl.classList.remove("hidden");
    this.sessionsListEl.innerHTML = "";
    for (const s of unfinished) {
      const row = document.createElement("div");
      row.className = "session-row";
      const rank = s.solved.length + s.basis.length;
      row.innerHTML = `
        <span>#${s.sid.slice(0, 8)} · ${formatBytes(s.size)} · 进度 ${rank}/${s.total}</span>
        <div class="btn-row">
          <button class="btn-resume">加载</button>
          <button class="danger btn-del">删除</button>
        </div>
      `;
      row.querySelector(".btn-resume")!.addEventListener("click", () => {
        this.solver = AirBridgeSolver.deserialize(s);
        this.completed = null;
        this.startedAt = performance.now();
        this.sessionNewBytes = 0;
        this.progressCardEl.classList.remove("hidden");
        this.resultCardEl.classList.add("hidden");
        this.updateProgressUI();
      });
      row.querySelector(".btn-del")!.addEventListener("click", async () => {
        await deleteSession(s.sid);
        await this.refreshSavedSessions();
      });
      this.sessionsListEl.appendChild(row);
    }
  }
}

const mount = document.getElementById("app");
if (mount) {
  new AirBridgeApp(mount);
}
