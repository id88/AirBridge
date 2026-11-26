/**
 * Renders block-level reception progress onto a compact HTML5 Canvas.
 * Green = solved, Amber = GF(2) constrained pivot, Slate = missing, Cyan = freshly received.
 */
export function renderHeatmap(
  canvas: HTMLCanvasElement,
  states: Uint8Array,
  freshSet: Set<number>,
): void {
  const total = states.length;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = canvas.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 64;
  const width = Math.floor(cssWidth * dpr);
  const height = Math.floor(cssHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#090e1a";
  ctx.fillRect(0, 0, width, height);
  if (total === 0) return;

  const pad = Math.round(4 * dpr);
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);

  // Pick a clean grid aspect ratio that fits all blocks comfortably
  const cols = Math.min(total, Math.max(8, Math.ceil(Math.sqrt(total * (innerW / innerH)))));
  const rows = Math.ceil(total / cols);
  const cellW = innerW / cols;
  const cellH = innerH / rows;
  const gap = cellW >= 5 * dpr && cellH >= 5 * dpr ? Math.round(1 * dpr) : 0;

  for (let i = 0; i < total; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = pad + c * cellW;
    const y = pad + r * cellH;
    const w = Math.max(1, cellW - gap);
    const h = Math.max(1, cellH - gap);

    const st = states[i]!;
    if (freshSet.has(i)) {
      ctx.fillStyle = "#38bdf8";
    } else if (st === 1) {
      ctx.fillStyle = "#34d399";
    } else if (st === 2) {
      ctx.fillStyle = "#f59e0b";
    } else {
      ctx.fillStyle = "#1e293b";
    }
    ctx.fillRect(x, y, w, h);
  }
}
