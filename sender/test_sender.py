#!/usr/bin/env python3
"""Unit tests & golden fixture generator for AirBridge Python sender."""
import base64
import hashlib
import io
import json
import os
import tempfile
import unittest
import zipfile
import zlib

from airbridge_send import AirBridgeSender, pack_zip, parse_ranges


class TestAirBridgeSender(unittest.TestCase):
    def test_pack_zip_file_and_dir(self):
        with tempfile.TemporaryDirectory() as d:
            f1 = os.path.join(d, "hello.txt")
            with open(f1, "w", encoding="utf-8") as fp:
                fp.write("Hello AirBridge! 你好离线传输！")
            sub = os.path.join(d, "sub")
            os.makedirs(sub)
            f2 = os.path.join(sub, "data.bin")
            with open(f2, "wb") as fp:
                fp.write(bytes(range(256)) * 4)

            zbytes = pack_zip([f1, sub])
            with zipfile.ZipFile(io.BytesIO(zbytes), "r") as z:
                names = set(z.namelist())
                self.assertIn("hello.txt", names)
                self.assertIn(os.path.join("sub", "data.bin"), names)
                self.assertEqual(z.read("hello.txt").decode("utf-8"), "Hello AirBridge! 你好离线传输！")
                self.assertEqual(z.read(os.path.join("sub", "data.bin")), bytes(range(256)) * 4)

    def test_parse_ranges(self):
        self.assertEqual(parse_ranges("3, 7-9, 22, 7, 999, -1", 30), [3, 7, 8, 9, 22])
        self.assertEqual(parse_ranges("", 10), [])

    def test_frame_format_and_xor_fountain(self):
        payload = bytes((i * 37) % 256 for i in range(1500))
        sender = AirBridgeSender(payload, bs=400, fountain=True)
        self.assertEqual(sender.total, 4)
        self.assertEqual(sender.sid, hashlib.sha256(payload).hexdigest()[:16])

        # Systematic frames
        f0 = sender.make_frame([0])
        parts = f0.split("|")
        self.assertEqual(len(parts), 7)
        self.assertEqual(parts[0], "AB1")
        self.assertEqual(parts[1], sender.sid)
        self.assertEqual(int(parts[2]), 1500)
        self.assertEqual(int(parts[3]), 400)
        self.assertEqual(parts[4], "0")
        raw0 = base64.b64decode(parts[6])
        self.assertEqual(len(raw0), 400)
        self.assertEqual(parts[5], f"{zlib.crc32(raw0) & 0xffffffff:08x}")

        # XOR frame: chunk[0] ^ chunk[2] ^ chunk[3]
        fx = sender.make_frame([0, 2, 3])
        px = fx.split("|")
        self.assertEqual(px[4], "0,2,3")
        rawx = base64.b64decode(px[6])
        expected = bytes(a ^ b ^ c for a, b, c in zip(sender.chunks[0], sender.chunks[2], sender.chunks[3]))
        self.assertEqual(rawx, expected)
        self.assertEqual(px[5], f"{zlib.crc32(rawx) & 0xffffffff:08x}")

    def test_render_single_and_grid_images(self):
        payload = b"AirBridge optical test " * 80
        s1 = AirBridgeSender(payload, bs=300, grid=1)
        im1, tag1 = s1.render_screen(640, 640)
        self.assertGreaterEqual(im1.width, 160)
        self.assertEqual(tag1, "0")

        s2 = AirBridgeSender(payload, bs=300, grid=2)
        im2, tag2 = s2.render_screen(900, 900)
        self.assertGreaterEqual(im2.width, 320)
        self.assertEqual(len(tag2.split(",")), 4)


def generate_golden_fixture(out_path):
    """Generates a deterministic golden fixture consumed by receiver Vitest tests."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        zi = zipfile.ZipInfo("hello_airbridge.txt", date_time=(2026, 1, 1, 0, 0, 0))
        z.writestr(zi, "AirBridge Golden Vector — 中文测试 1234567890\n" * 60)
    zbytes = buf.getvalue()
    sender = AirBridgeSender(zbytes, bs=120, fountain=True)
    frames = [sender.make_frame([i]) for i in range(sender.total)]
    # Add self-describing XOR parity frames that can recover dropped systematic blocks
    xor_sets = [
        [0, 1],
        [1, 2],
        [0, 2, 3] if sender.total > 3 else [0, 1],
        list(range(sender.total)),
    ]
    xor_frames = [sender.make_frame(sorted(set(ids))) for ids in xor_sets if max(ids) < sender.total]
    fixture = {
        "sid": sender.sid,
        "size": sender.size,
        "bs": sender.bs,
        "total": sender.total,
        "expectedFileName": "hello_airbridge.txt",
        "expectedText": "AirBridge Golden Vector — 中文测试 1234567890\n" * 60,
        "systematicFrames": frames,
        "xorFrames": xor_frames,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fp:
        json.dump(fixture, fp, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    fixture_path = os.path.join(os.path.dirname(__file__), "..", "protocol", "golden.json")
    generate_golden_fixture(fixture_path)
    unittest.main()
