import { describe, it, expect } from "vitest";
import { AirBridgeSolver } from "./fountain";
import { crc32Hex } from "./checksum";
import type { ParsedFrame } from "./protocol";

function makeSyntheticChunks(total: number, bs: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const buf = new Uint8Array(bs);
    for (let j = 0; j < bs; j++) {
      buf[j] = ((i + 1) * 31 + j * 17) & 0xff;
    }
    chunks.push(buf);
  }
  return chunks;
}

function makeFrame(sid: string, size: number, bs: number, chunks: Uint8Array[], ids: number[]): ParsedFrame {
  const payload = new Uint8Array(bs);
  for (const id of ids) {
    const c = chunks[id]!;
    for (let j = 0; j < bs; j++) payload[j] = payload[j]! ^ c[j]!;
  }
  return {
    sid,
    size,
    bs,
    total: chunks.length,
    ids,
    crc: crc32Hex(payload),
    payload,
  };
}

describe("AirBridgeSolver (Peeling + GF(2) Gaussian Elimination)", () => {
  it("solves pure coupled GF(2) equations with zero degree-1 blocks", () => {
    const total = 6;
    const bs = 32;
    const size = total * bs - 5;
    const sid = "0123456789abcdef";
    const chunks = makeSyntheticChunks(total, bs);
    const solver = new AirBridgeSolver(sid, size, bs);

    // 6 linearly independent degree >= 2 equations (none has degree 1!)
    const eqs = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [0, 2, 5], // independent because sum of first 5 is [0,5]; [0,2,5] adds block 2!
    ];

    for (let i = 0; i < eqs.length - 1; i++) {
      const res = solver.ingest(makeFrame(sid, size, bs, chunks, eqs[i]!));
      expect(res.status).toBe("equation");
      expect(solver.isComplete).toBe(false);
    }

    // Adding a linearly dependent equation ([0, 2] = [0,1] ^ [1,2]) must be detected as duplicate
    const dup = solver.ingest(makeFrame(sid, size, bs, chunks, [0, 2]));
    expect(dup.status).toBe("duplicate");

    // Adding final independent equation reaches full rank -> solves all 6 blocks at once!
    const fin = solver.ingest(makeFrame(sid, size, bs, chunks, eqs[5]!));
    expect(fin.status).toBe("complete");
    expect(solver.isComplete).toBe(true);

    const assembled = solver.assemble();
    expect(assembled.length).toBe(size);
    for (let i = 0; i < total; i++) {
      const start = i * bs;
      const end = Math.min(size, start + bs);
      expect(assembled.subarray(start, end)).toEqual(chunks[i]!.subarray(0, end - start));
    }
  });

  it("handles large 120-block transfer with 25% packet loss + random self-describing XOR recovery", () => {
    const total = 120;
    const bs = 128;
    const size = total * bs - 19;
    const sid = "fedcba9876543210";
    const chunks = makeSyntheticChunks(total, bs);
    const solver = new AirBridgeSolver(sid, size, bs);

    // Deliver 75% of systematic blocks (drop every 4th block -> 30 missing)
    for (let i = 0; i < total; i++) {
      if (i % 4 !== 0) {
        solver.ingest(makeFrame(sid, size, bs, chunks, [i]));
      }
    }
    expect(solver.solvedCount).toBe(90);

    // Deterministic PRNG for test reproducibility
    let seed = 42;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    const degrees = [2, 2, 3, 4, 6, 8, 12];
    let xorCount = 0;
    while (!solver.isComplete && xorCount < 400) {
      const d = degrees[Math.floor(nextRand() * degrees.length)]!;
      const picked = new Set<number>();
      while (picked.size < d) {
        picked.add(Math.floor(nextRand() * total));
      }
      solver.ingest(makeFrame(sid, size, bs, chunks, [...picked].sort((a, b) => a - b)));
      xorCount++;
    }

    expect(solver.isComplete).toBe(true);
    expect(xorCount).toBeLessThan(120);

    const assembled = solver.assemble();
    expect(assembled.length).toBe(size);
    for (let i = 0; i < total; i++) {
      const start = i * bs;
      const end = Math.min(size, start + bs);
      expect(assembled.subarray(start, end)).toEqual(chunks[i]!.subarray(0, end - start));
    }
  });

  it("round-trips serialize() and deserialize() cleanly mid-transfer", () => {
    const total = 10;
    const bs = 16;
    const size = total * bs;
    const sid = "aaaaaaaaaaaaaaaa";
    const chunks = makeSyntheticChunks(total, bs);

    const s1 = new AirBridgeSolver(sid, size, bs);
    for (let i = 0; i < 6; i++) s1.ingest(makeFrame(sid, size, bs, chunks, [i]));
    s1.ingest(makeFrame(sid, size, bs, chunks, [6, 7]));
    s1.ingest(makeFrame(sid, size, bs, chunks, [7, 8]));

    const saved = s1.serialize();
    const s2 = AirBridgeSolver.deserialize(saved);
    expect(s2.solvedCount).toBe(6);
    expect(s2.equationCount).toBe(2);

    s2.ingest(makeFrame(sid, size, bs, chunks, [8]));
    s2.ingest(makeFrame(sid, size, bs, chunks, [9]));
    expect(s2.isComplete).toBe(true);
    expect(s2.assemble()).toEqual(new Uint8Array(chunks.flatMap((c) => [...c])));
  });
});
