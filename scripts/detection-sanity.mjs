// Sanity check: detection methods vs a synthetic grain grid where half the
// boundaries are deliberately faint (gray 185 on 200 interiors).
// A complete-network method should count every boundary crossing.
// Run: node scripts/detection-sanity.mjs

import { analyzeImage } from '../src/lib/analysis.js'

const W = 400
const H = 400
const CELL = 50 // 8x8 grid -> 7 internal boundaries per direction

const gray = new Uint8Array(W * H).fill(200)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const onVertical = x % CELL < 2 && x > 2 && x < W - 2
    const onHorizontal = y % CELL < 2 && y > 2 && y < H - 2
    if (onVertical || onHorizontal) {
      const idx = onVertical ? Math.floor(x / CELL) : Math.floor(y / CELL)
      gray[y * W + x] = idx % 2 === 0 ? 60 : 185 // alternate strong / faint
    }
  }
}

const data = new Uint8ClampedArray(W * H * 4)
for (let i = 0; i < W * H; i++) {
  data[i * 4] = gray[i]
  data[i * 4 + 1] = gray[i]
  data[i * 4 + 2] = gray[i]
  data[i * 4 + 3] = 255
}
const imageData = { data, width: W, height: H }

console.log('Expected: 7 intercepts per horizontal line (4 strong + 3 faint boundaries)\n')
for (const method of ['watershed', 'canny', 'threshold']) {
  const r = analyzeImage(imageData, { method, orientation: 'horizontal', numLines: 5 })
  const perLine = r.lines.map((l) => l.intercepts.length).join(', ')
  console.log(
    `${method.padEnd(10)} per-line: [${perLine}]  total: ${r.totalIntercepts}  detail: ${JSON.stringify(r.detail)}`,
  )
}
