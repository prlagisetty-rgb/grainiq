// Sanity checks for boundary detection on synthetic grain grids.
// Run: node scripts/detection-sanity.mjs
//
// Image A: 8x8 grid, alternating strong (60) / faint (185) boundaries on 200
//          interiors. Complete-network detection should count every crossing.
// Image B: same grid with a 6px hole punched in the middle of every boundary
//          segment — open boundary edges that leak a naive flood and merge
//          adjacent grains. Markers + watershed must still separate them.

import { analyzeImage } from '../src/lib/analysis.js'

const W = 400
const H = 400
const CELL = 50 // 8x8 grid -> 7 internal boundaries per direction

function buildGrid({ withGaps }) {
  const gray = new Uint8Array(W * H).fill(200)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const onVertical = x % CELL < 2 && x > 2 && x < W - 2
      const onHorizontal = y % CELL < 2 && y > 2 && y < H - 2
      if (onVertical || onHorizontal) {
        if (withGaps) {
          // 6px hole at the midpoint of each segment
          const along = onVertical ? y : x
          const mid = Math.floor(along / CELL) * CELL + CELL / 2
          if (Math.abs(along - mid) <= 3) continue
        }
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
  return { data, width: W, height: H }
}

function report(label, imageData) {
  console.log(`\n${label} — expected ~7 intercepts per line, 64 grains`)
  for (const method of ['watershed', 'canny', 'threshold']) {
    const r = analyzeImage(imageData, { method, orientation: 'horizontal', numLines: 5 })
    const perLine = r.lines.map((l) => l.intercepts.length).join(', ')
    console.log(
      `${method.padEnd(10)} per-line: [${perLine}]  total: ${r.totalIntercepts}  detail: ${JSON.stringify(r.detail)}`,
    )
  }
}

report('Image A: intact boundaries (strong + faint)', buildGrid({ withGaps: false }))
report('Image B: 6px gaps in every boundary segment', buildGrid({ withGaps: true }))
