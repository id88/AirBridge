import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { parseFrame, verifyAndExtractArchive } from "../core/protocol";
import { AirBridgeSolver } from "../core/fountain";

const wasmPath = resolve(__dirname, "../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm");
const pyVenv = resolve(__dirname, "../../../sender/.venv/bin/python");
const senderDir = resolve(__dirname, "../../../sender");

interface RenderedBatch {
  sid: string;
  size: number;
  bs: number;
  expectedText: string;
  singlePngsB64: string[];
  gridPngsB64: string[];
}

function renderFromPython(): RenderedBatch {
  const script = `
import base64, io, json, sys, zipfile
sys.path.insert(0, ${JSON.stringify(senderDir)})
from airbridge_send import AirBridgeSender

text = "AirBridge End-to-End Optical QR Test! 中文内容测试 2026\\n" * 40
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("e2e_note.txt", text.encode("utf-8"))
zbytes = buf.getvalue()

# 1) Single QR mode (emit systematic + 2 XOR frames)
s1 = AirBridgeSender(zbytes, bs=140, grid=1, fountain=True)
single_pngs = []
for _ in range(s1.total + 2):
    im, _ = s1.render_screen(520, 520)
    out = io.BytesIO()
    im.save(out, format="PNG")
    single_pngs.append(base64.b64encode(out.getvalue()).decode("ascii"))

# 2) 2x2 Multi-QR grid mode
s2 = AirBridgeSender(zbytes, bs=140, grid=2, fountain=True)
grid_pngs = []
screens_needed = (s2.total + 3) // 4 + 1
for _ in range(screens_needed):
    im, _ = s2.render_screen(920, 920)
    out = io.BytesIO()
    im.save(out, format="PNG")
    grid_pngs.append(base64.b64encode(out.getvalue()).decode("ascii"))

print(json.dumps({
    "sid": s1.sid,
    "size": s1.size,
    "bs": s1.bs,
    "expectedText": text,
    "singlePngsB64": single_pngs,
    "gridPngsB64": grid_pngs,
}))
`;
  const raw = execFileSync(pyVenv, ["-c", script], { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(raw) as RenderedBatch;
}

describe("End-to-End Python QR Render -> ZXing-WASM Decode -> Archive Verify", () => {
  it("decodes Python 1x1 single QR PNGs and 2x2 multi-QR grid PNGs to identical original file", async () => {
    const wasmBuf = readFileSync(wasmPath);
    const wasmBinary = wasmBuf.buffer.slice(wasmBuf.byteOffset, wasmBuf.byteOffset + wasmBuf.byteLength);
    await prepareZXingModule({
      overrides: { wasmBinary },
      fireImmediately: true,
    });

    const batch = renderFromPython();

    // Test 1x1 Single QR end-to-end
    const solver1 = new AirBridgeSolver(batch.sid, batch.size, batch.bs);
    for (const pngB64 of batch.singlePngsB64) {
      const pngBytes = new Uint8Array(Buffer.from(pngB64, "base64"));
      const results = await readBarcodes(pngBytes, { formats: ["QRCode"], maxNumberOfSymbols: 2 });
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        const frame = parseFrame(r.text);
        expect(frame).not.toBeNull();
        solver1.ingest(frame!);
      }
    }
    expect(solver1.isComplete).toBe(true);
    const extracted1 = await verifyAndExtractArchive(solver1.assemble(), batch.sid);
    expect(extracted1.files[0]!.name).toBe("e2e_note.txt");
    expect(extracted1.files[0]!.textPreview).toBe(batch.expectedText);

    // Test 2x2 Multi-QR Grid end-to-end
    const solver2 = new AirBridgeSolver(batch.sid, batch.size, batch.bs);
    let totalGridCodesDecoded = 0;
    for (const pngB64 of batch.gridPngsB64) {
      const pngBytes = new Uint8Array(Buffer.from(pngB64, "base64"));
      const results = await readBarcodes(pngBytes, {
        formats: ["QRCode"],
        maxNumberOfSymbols: 6,
        tryHarder: true,
      });
      totalGridCodesDecoded += results.length;
      for (const r of results) {
        const frame = parseFrame(r.text);
        if (frame) solver2.ingest(frame);
      }
    }
    expect(totalGridCodesDecoded).toBeGreaterThanOrEqual(4);
    expect(solver2.isComplete).toBe(true);
    const extracted2 = await verifyAndExtractArchive(solver2.assemble(), batch.sid);
    expect(extracted2.files[0]!.name).toBe("e2e_note.txt");
    expect(extracted2.files[0]!.textPreview).toBe(batch.expectedText);
  }, 30000);
});
