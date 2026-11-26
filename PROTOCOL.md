# AirBridge Protocol v1 Specification

AirBridge v1 is a strictly unidirectional optical file-transfer protocol designed around **asymmetric complexity**: the offline Python sender can be typed by hand in ~80 lines of code, while the mobile Web/PWA receiver handles high-speed multi-QR decoding, Peeling + GF(2) fountain solving, persistence, and verification.

---

## 1. Container Layer (In-Memory ZIP)

1. One or more input files or directories are archived in memory into a standard ZIP stream (`ZIP_DEFLATED`).
2. Let `data` be the raw bytes of the ZIP archive, and `size = len(data)` (`size >= 1`).
3. Session & integrity identifier:
   ```text
   sid = sha256(data).hexdigest()[:16]   # 16 lowercase hex chars (64-bit prefix)
   ```
4. Block sizing:
   - Configured nominal block size `bs_cfg` (default `450`, recommended `256..600`).
   - Actual uniform block size: `bs = min(bs_cfg, size)`.
   - Total block count: `total = ceil(size / bs) = (size + bs - 1) // bs`.
5. Splitting:
   - For each `i` in `0 .. total - 1`:
     `chunk[i] = data[i * bs : (i + 1) * bs]` right-padded with `0x00` to exact length `bs`.
   - Every chunk has identical length `bs`, enabling zero-overhead XOR fountain coding and uniform GF(2) solving.
   - Upon full reconstruction, the receiver concatenates `chunk[0] .. chunk[total - 1]` and truncates to exact length `size` before SHA-256 verification and ZIP extraction.

---

## 2. Unified Frame Format (`AB1`)

Every QR code carries a pure-ASCII, pipe-delimited (`|`) UTF-8 string so it is 100% compatible with both Android Chrome's hardware-accelerated `BarcodeDetector` (UTF-16 string API) and `zxing-wasm`:

```text
AB1|<sid>|<size>|<bs>|<ids>|<crc8>|<b64_payload>
```

| Field | Format | Description |
| :--- | :--- | :--- |
| `magic` | Literal `AB1` | Protocol identifier & version 1 |
| `sid` | 16 lowercase hex chars | `sha256(zip_bytes)[:16]`; isolates transfer sessions and verifies full archive integrity |
| `size` | Positive base-10 integer | Exact ZIP archive byte length (`1 <= size <= 268435456`) |
| `bs` | Positive base-10 integer | Uniform block byte size (`1 <= bs <= 2048`) |
| `ids` | Comma-separated sorted unique integers | Block index list (`0 <= id < total`). Length 1 = systematic block (e.g. `5`); length ≥ 2 = self-describing XOR fountain equation (e.g. `2,5,19`) |
| `crc8` | 8 lowercase hex chars | `crc32(raw_payload) & 0xffffffff` formatted as `%08x` |
| `b64_payload` | Standard Base64 | Base64 encoding of `raw_payload` (exact length `bs` bytes) |

### Payload Semantics
- If `ids = [k]` (degree 1): `raw_payload = chunk[k]`.
- If `ids = [i_1, i_2, ..., i_d]` (degree `d >= 2`):
  `raw_payload = chunk[i_1] XOR chunk[i_2] XOR ... XOR chunk[i_d]`.

### Validation Rules (Receiver)
A decoded QR string is accepted **only if** all checks pass:
1. Exactly 7 `|`-delimited fields, field 0 equals `AB1`.
2. `sid` matches `/^[0-9a-f]{16}$/`.
3. `size >= 1`, `bs >= 1`, `total = ceil(size / bs) >= 1`.
4. `ids` parses to non-empty unique integers, each in `[0, total - 1]`.
5. `b64_payload` decodes cleanly to a byte array of exact length `bs`.
6. `crc32(decoded_bytes)` matches `crc8` (8 lowercase hex chars).

---

## 3. Transmission & Visual Carrier Rules

- **Systematic + Fountain Schedule**:
  - Pass 1 emits single blocks `0, 1, ..., total - 1` sequentially.
  - Subsequent passes (when fountain mode is enabled and `total >= 2`) emit self-describing XOR frames with degree sampled from `[2, 2, 3, 4, 6, 8, 12]` (capped at `total`), interleaving sequential single blocks periodically.
  - Because `ids` are self-described in each frame header, sender and receiver require **zero shared PRNG or degree-distribution synchronization**.
- **Single QR (1×1) & Multi-QR Grid (2×2)**:
  - A 2×2 grid places 4 independent `AB1` QR codes on one screen with white quiet zones (≥ 4 modules) and nearest-neighbor scaling.
  - The wire protocol is **identical** in 1×1 and 2×2 modes.
- **Manual Missing-Block Replay**:
  - The receiver exports missing block indices as compact ranges (e.g. `3,7-9,22`).
  - Entering that string in the sender replays only the specified single-block frames.

---

## 4. Integrity & Extraction

1. Once all `total` blocks are solved (via direct reception, Peeling, and/or GF(2) Gaussian elimination):
   - Reconstruct `archive = concat(chunk[0..total-1]).slice(0, size)`.
   - Compute `sha256(archive)` and verify its first 16 hex chars equal `sid`.
2. Extract files from `archive` using standard ZIP DEFLATE decompression (which validates each entry's internal CRC32).
