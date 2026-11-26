#!/usr/bin/env python3
"""AirBridge 极简离线发送端：单码 / 2x2 多码网格 / 自描述 XOR 喷泉"""
import argparse, base64, hashlib, io, os, random, sys, tkinter as tk, zipfile, zlib
from tkinter import simpledialog
import qrcode
from PIL import Image, ImageTk


def pack_zip(paths):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in map(os.path.abspath, paths):
            if os.path.isdir(p):
                base = os.path.dirname(p)
                for root, _, files in os.walk(p):
                    for f in files:
                        fp = os.path.join(root, f)
                        z.write(fp, os.path.relpath(fp, base))
            else:
                z.write(p, os.path.basename(p))
    return buf.getvalue()


def parse_ranges(text, total):
    out = []
    for part in text.replace(" ", "").split(","):
        if not part:
            continue
        try:
            a, b = map(int, part.split("-", 1)) if ("-" in part and not part.startswith("-")) else (int(part), int(part))
            out.extend(i for i in range(a, b + 1) if 0 <= i < total)
        except ValueError:
            pass
    return list(dict.fromkeys(out))


class AirBridgeSender:
    def __init__(self, data, bs=450, fps=5.0, grid=1, fountain=True, ecc="L"):
        self.size, self.bs = len(data), min(bs, len(data))
        self.sid = hashlib.sha256(data).hexdigest()[:16]
        self.chunks = [data[i : i + self.bs].ljust(self.bs, b"\x00") for i in range(0, self.size, self.bs)]
        self.total, self.fps, self.grid, self.fountain = len(self.chunks), fps, grid, fountain
        self.ecc = getattr(qrcode.constants, f"ERROR_CORRECT_{ecc.upper()}", qrcode.constants.ERROR_CORRECT_L)
        self.seq, self.paused, self.replay, self.hist, self.pos = 0, False, [], [], -1

    def make_frame(self, ids):
        v = 0
        for i in ids:
            v ^= int.from_bytes(self.chunks[i], "big")
        raw = v.to_bytes(self.bs, "big")
        crc = f"{zlib.crc32(raw) & 0xffffffff:08x}"
        return f"AB1|{self.sid}|{self.size}|{self.bs}|{','.join(map(str, ids))}|{crc}|{base64.b64encode(raw).decode()}"

    def next_ids(self):
        s, self.seq = self.seq, self.seq + 1
        if self.replay:
            return [self.replay[s % len(self.replay)]]
        if s < self.total or not self.fountain or self.total < 2 or s % 5 == 0:
            return [s % self.total]
        d = min(self.total, random.choice((2, 2, 3, 4, 6, 8, 12)))
        return sorted(random.sample(range(self.total), d))

    def qr_img(self, text, px):
        qr = qrcode.QRCode(error_correction=self.ecc, border=4, box_size=1)
        qr.add_data(text)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white").convert("L")
        s = max(1, px // img.width)
        scaled = img.resize((img.width * s, img.height * s), Image.NEAREST)
        box = Image.new("L", (px, px), 255)
        box.paste(scaled, ((px - scaled.width) // 2, (px - scaled.height) // 2))
        return box

    def render_screen(self, w, h):
        cols = 2 if self.grid == 2 else 1
        cell = max(160, min(w // cols, h // cols) - 16)
        side = cell * cols + 16 * (cols + 1)
        canvas, tags = Image.new("L", (side, side), 255), []
        for idx in range(cols * cols):
            ids = self.next_ids()
            tags.append(str(ids[0]) if len(ids) == 1 else f"X{len(ids)}")
            r, c = divmod(idx, cols)
            canvas.paste(self.qr_img(self.make_frame(ids), cell), (16 + c * (cell + 16), 16 + r * (cell + 16)))
        return canvas, ",".join(tags)

    def run(self):
        root = tk.Tk()
        root.title(f"AirBridge | {self.sid[:8]} | {self.size}B / {self.total}块")
        root.configure(bg="white")
        root.geometry("820x860")
        info = tk.Label(root, bg="#111", fg="#fff", font=("TkFixedFont", 11), pady=6)
        info.pack(fill="x")
        lbl = tk.Label(root, bg="white")
        lbl.pack(expand=True, fill="both")

        def show(img, tag):
            tk_img = ImageTk.PhotoImage(img)
            lbl.img = tk_img
            lbl.config(image=tk_img)
            rep = f" | 补漏:{len(self.replay)}" if self.replay else ""
            st = "暂停" if self.paused else f"{self.fps:.1f}FPS"
            info.config(text=f"{self.sid[:8]} | {self.total}块 | [{tag}] | {self.grid}x{self.grid} | {st} | 喷泉:{'开' if self.fountain else '关'}{rep}  [Space ←→ +- G F M]")

        def step(d=1):
            w, h = max(root.winfo_width(), 640), max(root.winfo_height() - 40, 600)
            if d < 0 and self.pos > 0:
                self.pos -= 1
            elif d > 0 and self.pos + 1 < len(self.hist):
                self.pos += 1
            else:
                self.hist = (self.hist + [self.render_screen(w, h)])[-30:]
                self.pos = len(self.hist) - 1
            show(*self.hist[self.pos])

        def tick():
            if not self.paused:
                step(1)
            root.after(max(50, int(1000 / self.fps)), tick)

        def on_key(e):
            k = e.keysym.lower()
            if k == "space":
                self.paused = not self.paused
                if self.pos >= 0: show(*self.hist[self.pos])
            elif k in ("right", "down"): self.paused = True; step(1)
            elif k in ("left", "up"): self.paused = True; step(-1)
            elif k in ("plus", "equal"): self.fps = min(15.0, self.fps + 1.0)
            elif k == "minus": self.fps = max(1.0, self.fps - 1.0)
            elif k == "g": self.grid = 2 if self.grid == 1 else 1; self.hist.clear(); self.pos = -1; step(1)
            elif k == "f": self.fountain = not self.fountain
            elif k == "m":
                self.paused = True
                s = simpledialog.askstring("补漏模式", "输入缺失块号(如 3,7-9,22)，留空取消:")
                if s is not None: self.replay, self.seq, self.paused = parse_ranges(s, self.total), 0, False
            elif k in ("q", "escape"): root.destroy()

        root.bind("<Key>", on_key)
        root.after(100, tick)
        root.mainloop()


def main():
    p = argparse.ArgumentParser(description="AirBridge 离线二维码发送端")
    p.add_argument("paths", nargs="+")
    p.add_argument("-b", "--bs", type=int, default=450)
    p.add_argument("-f", "--fps", type=float, default=5.0)
    p.add_argument("-g", "--grid", type=int, choices=(1, 2), default=1)
    p.add_argument("-e", "--ecc", choices=("L", "M", "Q", "H"), default="L")
    p.add_argument("--no-fountain", action="store_true")
    a = p.parse_args()
    data = pack_zip(a.paths)
    if not data: sys.exit("错误: 打包数据为空")
    AirBridgeSender(data, a.bs, a.fps, a.grid, not a.no_fountain, a.ecc).run()


if __name__ == "__main__":
    main()
