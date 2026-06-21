// Detection-accuracy validation harness.
//
//   node scripts/validate-accuracy.mjs            # score every manifest case
//   node scripts/validate-accuracy.mjs --all-methods   # also run the other methods per case
//   node scripts/validate-accuracy.mjs --lines <caseId> # print test-line geometry for manual counting
//   node scripts/validate-accuracy.mjs --self-test      # run the synthetic known-truth grid
//
// Why this exists: the project's status guard says no detection method may be
// called "resolved" until it hits 90%+ on real samples validated against
// certified manual counts. Until now the only quantitative check was a single
// synthetic grid (scripts/detection-sanity.mjs) plus an anecdotal "266" count,
// so every tuning change was guesswork. This harness measures the engine against
// ground truth you supply in validation/manifest.json and reports pass/fail
// against the 90% bar, per case and in aggregate. Exit code is non-zero if any
// real case fails, so it can gate CI later.
//
// Ground truth must be counted along the SAME test lines the tool draws
// (deterministic from image size + orientation + numLines). Use --lines <caseId>
// to print those line coordinates, then count intercepts on each line by hand.
// See validation/README.md for the full protocol.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeImage, astmGrainNumber } from '../src/lib/analysis.js'
import { decodePng } from './lib/png.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const VALIDATION_DIR = path.join(ROOT, 'validation')
const MANIFEST_PATH = path.join(VALIDATION_DIR, 'manifest.json')

// Pass bar: detected intercept total within this % of the manual count.
// 10% absolute error == the 90% detection target in the status guard.
const PASS_THRESHOLD_PCT = 10

const ALL_METHODS = ['threshold', 'watershed', 'canny']

function fmtPct(n) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

function manualTotalOf(c) {
  if (typeof c.manualTotal === 'number') return c.manualTotal
  if (Array.isArray(c.manualPerLine)) return c.manualPerLine.reduce((a, b) => a + b, 0)
  return null
}

function loadImage(c) {
  const imgPath = path.isAbsolute(c.image) ? c.image : path.join(VALIDATION_DIR, c.image)
  if (!fs.existsSync(imgPath)) {
    throw new Error(`image not found: ${imgPath}`)
  }
  if (!imgPath.toLowerCase().endsWith('.png')) {
    throw new Error(`only PNG fixtures are supported (got ${path.basename(imgPath)}) — re-export as PNG`)
  }
  return decodePng(imgPath)
}

// One case, one method → metrics row.
function scoreCase(c, image, method) {
  const params = { ...(c.params || {}), method }
  const result = analyzeImage(image, params)
  const manual = manualTotalOf(c)
  const detected = result.totalIntercepts

  const row = { method, detected, manual, lines: result.lines.length }
  if (manual && manual > 0) {
    row.ratePct = (detected / manual) * 100
    row.absErrPct = (Math.abs(detected - manual) / manual) * 100
    row.pass = row.absErrPct <= PASS_THRESHOLD_PCT
  }

  // Customer-facing outcome error, when a scale and a manual grain size exist.
  if (c.scaleMicronsPerPixel && result.mliPx) {
    const mli = result.mliPx * c.scaleMicronsPerPixel
    row.mliMicrons = mli
    row.astmG = astmGrainNumber(mli)
    if (typeof c.manualMliMicrons === 'number') {
      row.mliErrPct = ((mli - c.manualMliMicrons) / c.manualMliMicrons) * 100
      row.astmGDelta = row.astmG - astmGrainNumber(c.manualMliMicrons)
    }
  }

  // Per-line diagnostics localise WHERE detection misses, when supplied.
  if (Array.isArray(c.manualPerLine) && c.manualPerLine.length === result.lines.length) {
    row.perLine = result.lines.map((l, i) => ({
      detected: l.intercepts.length,
      manual: c.manualPerLine[i],
      diff: l.intercepts.length - c.manualPerLine[i],
    }))
  }
  return row
}

function printRow(row) {
  let line = `  ${row.method.padEnd(10)} detected ${String(row.detected).padStart(5)}`
  if (row.manual != null) {
    line += ` / manual ${String(row.manual).padStart(5)}  rate ${row.ratePct.toFixed(0)}%  err ${fmtPct(
      row.detected - row.manual < 0 ? -row.absErrPct : row.absErrPct,
    )}  ${row.pass ? 'PASS' : 'FAIL'}`
  } else {
    line += '  (no manual count — informational only)'
  }
  console.log(line)
  if (row.mliMicrons != null) {
    let m = `             MLI ${row.mliMicrons.toFixed(2)} µm  ASTM G ${row.astmG.toFixed(2)}`
    if (row.mliErrPct != null) m += `  (MLI err ${fmtPct(row.mliErrPct)}, ΔG ${row.astmGDelta.toFixed(2)})`
    console.log(m)
  }
  if (row.perLine) {
    const cells = row.perLine.map((p) => `${p.detected}/${p.manual}`).join('  ')
    console.log(`             per-line det/man: ${cells}`)
  }
}

function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return { cases: [] }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
}

// --- Synthetic known-truth grid (proves the harness math end to end) ---------

function buildSyntheticGrid() {
  const W = 400
  const H = 400
  const CELL = 50
  const gray = new Uint8Array(W * H).fill(200)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const onVertical = x % CELL < 2 && x > 2 && x < W - 2
      const onHorizontal = y % CELL < 2 && y > 2 && y < H - 2
      if (onVertical || onHorizontal) {
        const idx = onVertical ? Math.floor(x / CELL) : Math.floor(y / CELL)
        gray[y * W + x] = idx % 2 === 0 ? 60 : 185
      }
    }
  }
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = gray[i]
    data[i * 4 + 3] = 255
  }
  return { data, width: W, height: H }
}

function runSelfTest() {
  console.log('Self-test — synthetic 8×8 grid, watershed, 5 horizontal lines')
  const image = buildSyntheticGrid()
  const numLines = 5
  const result = analyzeImage(image, { method: 'watershed', orientation: 'horizontal', numLines })
  // Geometric truth: each horizontal line crosses 7 vertical boundaries, unless
  // it lands ON a horizontal boundary (multiple of 50) — then it runs along it
  // and the gap-sealed mask reads it as 1 long intercept.
  const expected = result.lines.map((l) => (l.y % 50 < 2 ? 1 : 7))
  const detected = result.lines.map((l) => l.intercepts.length)
  console.log(`  expected per-line: [${expected.join(', ')}]`)
  console.log(`  detected per-line: [${detected.join(', ')}]`)
  const ok = expected.every((e, i) => detected[i] === e)
  console.log(ok ? '  SELF-TEST PASS' : '  SELF-TEST FAIL')
  return ok
}

// --- Line-geometry print (for doing the manual count) ------------------------

function printLines(caseId) {
  const { cases } = readManifest()
  const c = cases.find((x) => x.id === caseId)
  if (!c) {
    console.error(`No case with id "${caseId}" in manifest.`)
    process.exit(1)
  }
  const image = loadImage(c)
  const result = analyzeImage(image, { ...(c.params || {}) })
  console.log(`Test-line geometry for "${c.id}" (${image.width}×${image.height})`)
  console.log('Count grain-boundary intercepts along each line below, in order:\n')
  result.lines.forEach((l, i) => {
    if (l.orientation === 'horizontal') {
      console.log(`  line ${i}: horizontal at y=${l.y}, from x=${l.x1} to x=${l.x2}`)
    } else {
      console.log(`  line ${i}: vertical at x=${l.x}, from y=${l.y1} to y=${l.y2}`)
    }
  })
  console.log('\nPut these counts in the case\'s "manualPerLine" array (same order).')
}

// --- Main --------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) {
    process.exit(runSelfTest() ? 0 : 1)
  }
  const linesIdx = args.indexOf('--lines')
  if (linesIdx !== -1) {
    printLines(args[linesIdx + 1])
    return
  }
  const allMethods = args.includes('--all-methods')

  const { cases } = readManifest()
  if (!cases || cases.length === 0) {
    console.log('No validation cases yet.\n')
    console.log('Add real micrographs to validation/fixtures/ and ground-truth')
    console.log('entries to validation/manifest.json. See validation/README.md.')
    console.log('\nRun `node scripts/validate-accuracy.mjs --self-test` to check the harness itself.')
    return
  }

  let failures = 0
  let scored = 0
  let errSum = 0

  for (const c of cases) {
    console.log(`\n${c.id}${c.description ? ` — ${c.description}` : ''}`)
    let image
    try {
      image = loadImage(c)
    } catch (e) {
      console.log(`  ERROR: ${e.message}`)
      failures++
      continue
    }
    const methods = allMethods ? ALL_METHODS : [c.params?.method || 'threshold']
    for (const method of methods) {
      const row = scoreCase(c, image, method)
      printRow(row)
      // Pass/fail is judged on the case's chosen method only.
      if (method === (c.params?.method || 'threshold') && row.absErrPct != null) {
        scored++
        errSum += row.absErrPct
        if (!row.pass) failures++
      }
    }
  }

  console.log('\n──────────────────────────────────────────')
  if (scored > 0) {
    console.log(`Cases scored: ${scored}   Mean abs error: ${(errSum / scored).toFixed(1)}%`)
    console.log(`Pass bar: ≤${PASS_THRESHOLD_PCT}% error (90% detection)   Failures: ${failures}`)
  } else {
    console.log('No cases had a manual count to score against.')
  }
  process.exit(failures > 0 ? 1 : 0)
}

main()
