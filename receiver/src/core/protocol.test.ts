import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrame, formatMissingRanges, verifyAndExtractArchive } from "./protocol";
import { AirBridgeSolver } from "./fountain";

interface GoldenFixture {
  sid: string;
  size: number;
  bs: number;
  total: number;
  expectedFileName: string;
  expectedText: string;
  systematicFrames: string[];
  xorFrames: string[];
}

const goldenPath = resolve(__dirname, "../../../protocol/golden.json");
const golden: GoldenFixture = JSON.parse(readFileSync(goldenPath, "utf-8"));

describe("AirBridge Protocol v1 & Golden Fixture", () => {
  it("parses all Python-generated systematic and XOR frames", () => {
    for (let i = 0; i < golden.systematicFrames.length; i++) {
      const parsed = parseFrame(golden.systematicFrames[i]!);
      expect(parsed).not.toBeNull();
      expect(parsed!.sid).toBe(golden.sid);
      expect(parsed!.size).toBe(golden.size);
      expect(parsed!.bs).toBe(golden.bs);
      expect(parsed!.ids).toEqual([i]);
      expect(parsed!.payload.length).toBe(golden.bs);
    }

    for (const raw of golden.xorFrames) {
      const parsed = parseFrame(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.ids.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("rejects corrupted CRC, invalid magic, out-of-range index, or wrong payload length", () => {
    const valid = golden.systematicFrames[0]!;
    const parts = valid.split("|");

    // Bad magic
    expect(parseFrame(["AB2", ...parts.slice(1)].join("|"))).toBeNull();
    // Corrupted CRC
    expect(parseFrame([...parts.slice(0, 5), "00000000", parts[6]].join("|"))).toBeNull();
    // Out-of-range block ID
    expect(parseFrame([...parts.slice(0, 4), String(golden.total), parts[5], parts[6]].join("|"))).toBeNull();
    // Truncated payload
    expect(parseFrame([...parts.slice(0, 6), parts[6]!.slice(0, 4)].join("|"))).toBeNull();
  });

  it("reconstructs and verifies the golden ZIP archive from systematic frames", async () => {
    const solver = new AirBridgeSolver(golden.sid, golden.size, golden.bs);
    for (const raw of golden.systematicFrames) {
      solver.ingest(parseFrame(raw)!);
    }
    expect(solver.isComplete).toBe(true);

    const archive = solver.assemble();
    const { files, fullSha256 } = await verifyAndExtractArchive(archive, golden.sid);
    expect(fullSha256.startsWith(golden.sid)).toBe(true);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe(golden.expectedFileName);
    expect(files[0]!.isText).toBe(true);
    expect(files[0]!.textPreview).toBe(golden.expectedText);
  });

  it("recovers missing systematic blocks using Python-generated self-describing XOR frames", async () => {
    if (golden.total < 2) return;
    const solver = new AirBridgeSolver(golden.sid, golden.size, golden.bs);
    // Deliberately drop block 0 and block 1
    for (let i = 2; i < golden.systematicFrames.length; i++) {
      solver.ingest(parseFrame(golden.systematicFrames[i]!)!);
    }
    expect(solver.isComplete).toBe(false);
    expect(solver.getMissingIndices()).toEqual([0, 1]);

    // Feed XOR frames [0,1] and [1,2] -> peels block 1 then block 0!
    for (const raw of golden.xorFrames) {
      solver.ingest(parseFrame(raw)!);
    }
    expect(solver.isComplete).toBe(true);

    const archive = solver.assemble();
    const { files } = await verifyAndExtractArchive(archive, golden.sid);
    expect(files[0]!.textPreview).toBe(golden.expectedText);
  });

  it("formats compact missing block ranges accurately", () => {
    expect(formatMissingRanges([])).toBe("");
    expect(formatMissingRanges([3, 7, 8, 9, 22, 10, 0])).toBe("0,3,7-10,22");
  });
});
