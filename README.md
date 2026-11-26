# AirBridge — 离线单向光学文件传输系统

**AirBridge** 是一套专为物理隔离（无网络、无蓝牙）环境设计的单向二维码文件传输系统，采用 **「极简手写发送端 × 强悍移动端接收端」** 的非对称架构：

- **离线发送端 (`sender/airbridge_send.py`)**：单一极简 Python 脚本，便于在无网机器上直接人工手敲。依赖 `qrcode`、`Pillow` 与内置 `tkinter`，一站式支持内存 ZIP 自动打包压缩（单文件/多文件/文件夹）、`AB1` 统一协议、**自描述 XOR 喷泉抗丢帧**、**1×1 单码与 2×2 多码网格实时切换**以及**键盘补漏交互**。
- **Android 14 手机接收端 (`receiver/`)**：纯前端 TypeScript + PWA 应用，同时支持构建**单文件离线 HTML 包**。内置 **Android 原生 `BarcodeDetector` 硬件加速 + `ZXing-C++ WASM` 多 Worker 线程池**双引擎、**Peeling + GF(2) 高斯消元喷泉求解器**、IndexedDB 断点续传、块级进度热力图、变焦/对焦与常亮控制。

---

## 目录结构

```text
AirBridge/
├── design_plan.md          # 调研报告与总体设计方案
├── PROTOCOL.md             # AirBridge v1 帧协议规范
├── protocol/
│   └── golden.json         # Python -> TypeScript 联调 Golden 测试向量
├── sender/
│   ├── airbridge_send.py   # 唯一极简统一发送端脚本
│   ├── requirements.txt    # qrcode + Pillow
│   └── test_sender.py      # 发送端单元测试 + Golden 生成器
└── receiver/
    ├── src/core/           # 协议解析、CRC32/SHA-256、GF(2) 喷泉求解器、IndexedDB 持久化
    ├── src/scanner/        # 双引擎解码调度器 + ZXing WASM Worker + 端到端光学解码测试
    ├── src/ui/             # 块级进度热力图
    ├── public/             # PWA Manifest、Service Worker、SVG 图标
    ├── dist/               # (构建产物) 静态站 + PWA（适合 GitHub Pages / HTTPS 部署）
    └── dist-single/        # (构建产物) 单文件离线 HTML（内嵌 WASM）
```

---

## 快速上手

### 1. 发送端（离线电脑）

确保已安装 `qrcode` 与 `Pillow`（`pip install qrcode Pillow`）：

```bash
# 发送单个文件（默认单码、450B/块、5 FPS、开启自描述 XOR 喷泉）
python3 sender/airbridge_send.py path/to/file.txt

# 发送多个文件或整个文件夹，启用 2×2 多码网格提速
python3 sender/airbridge_send.py -g 2 -b 400 -f 4 path/to/dir file2.bin
```

**播放窗口快捷键**：
- `Space`：暂停 / 继续
- `←` / `→`：单步切换上一帧 / 下一帧
- `+` / `-`：实时调整帧率（1 ~ 15 FPS）
- `G`：实时切换 `1×1` 单码 ↔ `2×2` 多码网格
- `F`：实时开启 / 关闭自描述 XOR 喷泉冗余
- `M`：弹窗输入手机端显示的缺失块号区间（如 `3,7-9,22`），立即定向补漏
- `Q` / `Esc`：退出

---

### 2. 接收端（Android 14 手机）

#### 构建产物

```bash
cd receiver
npm install
npm run build:all
```

构建完成后会生成两套产物：
1. **PWA 静态站**：`receiver/dist/`
   - 直接部署到 **GitHub Pages**、**Cloudflare Pages** 或任意 **HTTPS 服务器**。
   - Android 14 手机 Chrome 首次联网打开一次（推荐“添加到主屏幕”安装为 PWA），Service Worker 会将页面与 ZXing WASM 全量缓存到本地，之后彻底断网/飞行模式亦可扫码使用。
2. **单文件离线 HTML**：`receiver/dist-single/index.html`
   - 已将全部 JS、CSS、Worker 与 `zxing_reader.wasm` 内联为单个 HTML 文件。
   - **Android 14 注意**：Chrome 禁止在 `file://` 下调用摄像头，请通过 Termux 在本地以 `localhost` 提供服务：
     ```bash
     # 在手机 Termux 中进入存放单文件 index.html 的目录
     python3 -m http.server 8080
     # 浏览器访问 http://127.0.0.1:8080 即可开启摄像头
     ```

---

## 实战调优建议（Android 14）

- **1×1 单码模式**：默认 `-b 450 -f 5` 最稳妥；屏幕较小或反光严重时可降至 `-b 300 -f 4`。
- **2×2 多码网格模式**：建议电脑宽屏全屏/放大窗口，使用 `-g 2 -b 350 -f 4`，手机端勾选「2×2 网格增强」，稍微拉远距离并用页面内 **变焦滑块调至 1.5×~2.0×**，能显著消除摩尔纹并同时扫出 4 码。
- **尾帧收尾**：默认开启自描述 XOR 喷泉，缺失少量块时保持对准屏幕数秒即可自动经由 GF(2) 消元补齐；如手抄时未开喷泉，点击手机端「复制缺失区间」并在发送端按 `M` 粘贴即可秒补。

---

## 运行自动化测试

```bash
# 1. Python 发送端单元测试（同时更新 protocol/golden.json）
sender/.venv/bin/python sender/test_sender.py

# 2. Receiver 单元测试 + Golden 协议联调 + Python 真图渲染 -> ZXing WASM 端到端光学解码测试
cd receiver && npm test
```
