import { unzipSync } from "fflate";
import { crc32Hex, sha256Hex } from "./checksum";

export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_BLOCK_SIZE = 2048;

export interface ParsedFrame {
  sid: string;
  size: number;
  bs: number;
  total: number;
  ids: number[];
  crc: string;
  payload: Uint8Array;
}

export interface ExtractedFile {
  name: string;
  bytes: Uint8Array;
  isText: boolean;
  textPreview?: string;
}

const SID_RE = /^[0-9a-f]{16}$/;
const CRC_RE = /^[0-9a-f]{8}$/;

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export function parseFrame(rawText: string): ParsedFrame | null {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("AB1|")) return null;
  const parts = trimmed.split("|");
  if (parts.length !== 7) return null;

  const [, sid, sizeStr, bsStr, idsStr, crc, b64] = parts;
  if (!sid || !SID_RE.test(sid)) return null;
  if (!crc || !CRC_RE.test(crc)) return null;

  const size = Number(sizeStr);
  const bs = Number(bsStr);
  if (!Number.isInteger(size) || size < 1 || size > MAX_ARCHIVE_BYTES) return null;
  if (!Number.isInteger(bs) || bs < 1 || bs > MAX_BLOCK_SIZE) return null;
  const total = Math.ceil(size / bs);
  if (total < 1) return null;

  if (!idsStr) return null;
  const idParts = idsStr.split(",");
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const token of idParts) {
    if (!/^\d+$/.test(token)) return null;
    const id = Number(token);
    if (!Number.isInteger(id) || id < 0 || id >= total || seen.has(id)) return null;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) return null;

  const payload = decodeBase64(b64 ?? "");
  if (!payload || payload.length !== bs) return null;
  if (crc32Hex(payload) !== crc) return null;

  return { sid, size, bs, total, ids, crc, payload };
}

export function formatMissingRanges(missing: number[]): string {
  if (missing.length === 0) return "";
  const sorted = [...missing].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (cur === prev + 1) {
      prev = cur;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = cur;
      prev = cur;
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(",");
}

function isLikelyText(name: string, bytes: Uint8Array): boolean {
  if (bytes.length > 512 * 1024) return false;
  const textExt = /\.(txt|md|json|yaml|yml|toml|ini|conf|cfg|log|csv|xml|html|css|js|ts|py|java|go|rs|c|cpp|h|sh|sql|env)$/i;
  const sampleLen = Math.min(bytes.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = bytes[i]!;
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) suspicious++;
  }
  if (textExt.test(name)) return suspicious === 0;
  return sampleLen > 0 && suspicious / sampleLen < 0.02;
}

function sanitizeZipPath(name: string): string {
  const cleaned = name
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
  return cleaned || "airbridge-file.bin";
}

export async function verifyAndExtractArchive(
  archiveBytes: Uint8Array,
  expectedSid: string,
): Promise<{ fullSha256: string; files: ExtractedFile[] }> {
  const fullSha256 = await sha256Hex(archiveBytes);
  if (!fullSha256.startsWith(expectedSid)) {
    throw new Error(`整包 SHA-256 校验失败（期望前缀 ${expectedSid}，实际 ${fullSha256.slice(0, 16)}）`);
  }

  const unzipped = unzipSync(archiveBytes);
  const files: ExtractedFile[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });

  for (const [rawName, content] of Object.entries(unzipped)) {
    if (rawName.endsWith("/") && content.length === 0) continue;
    const name = sanitizeZipPath(rawName);
    const text = isLikelyText(name, content);
    files.push({
      name,
      bytes: content,
      isText: text,
      textPreview: text ? decoder.decode(content) : undefined,
    });
  }

  if (files.length === 0) {
    throw new Error("压缩包内没有可提取的文件");
  }
  return { fullSha256, files };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
