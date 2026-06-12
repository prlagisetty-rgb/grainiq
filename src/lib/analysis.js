// Mean Linear Intercept (MLI) grain size analysis — ASTM E112 Heyn lineal intercept method.
//
// Two boundary detection methods:
//  - 'canny' (default): CLAHE contrast enhancement → Gaussian blur → Sobel gradients →
//    non-maximum suppression → adaptive (per-tile) hysteresis thresholding →
//    morphological closing. Detects boundaries by local contrast change in either
//    direction, so it handles dark-etched boundaries and bright boundaries (e.g.
//    Barker's etched aluminium alloys) alike. CLAHE lifts faint boundaries before
//    detection, per-tile thresholds keep low-contrast regions detectable, and closing
//    bridges small gaps in boundary lines that would otherwise drop intercepts.
//  - 'threshold': global Otsu dark-pixel threshold (the original prototype method).
//    Only valid where boundaries etch darker than the grains.

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function toGrayscale(imageData) {
  const { data, width, height } = imageData
  const gray = new Uint8ClampedArray(width * height)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]
  }
  return gray
}

// Otsu's method: picks the threshold separating dark boundary pixels from bright grains.
function otsuThreshold(gray) {
  const hist = new Float64Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++

  const total = gray.length
  let sumAll = 0
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]

  let sumB = 0
  let weightB = 0
  let maxVariance = -1
  let threshold = 127

  for (let t = 0; t < 256; t++) {
    weightB += hist[t]
    if (weightB === 0) continue
    const weightF = total - weightB
    if (weightF === 0) break
    sumB += t * hist[t]
    const meanB = sumB / weightB
    const meanF = (sumAll - sumB) / weightF
    const variance = weightB * weightF * (meanB - meanF) ** 2
    if (variance > maxVariance) {
      maxVariance = variance
      threshold = t
    }
  }
  return threshold
}

// ---------------------------------------------------------------------------
// CLAHE — Contrast Limited Adaptive Histogram Equalisation
// ---------------------------------------------------------------------------

const CLAHE_TILES = 8

// Per-tile clipped histogram equalisation with bilinear blending between tile
// mappings, so faint local contrast is amplified without tile seams or the
// noise blow-up of unclipped equalisation.
function clahe(gray, width, height, clipLimit) {
  const tileW = Math.ceil(width / CLAHE_TILES)
  const tileH = Math.ceil(height / CLAHE_TILES)
  const maps = []

  for (let ty = 0; ty < CLAHE_TILES; ty++) {
    for (let tx = 0; tx < CLAHE_TILES; tx++) {
      const x0 = tx * tileW
      const y0 = ty * tileH
      const x1 = Math.min(width, x0 + tileW)
      const y1 = Math.min(height, y0 + tileH)
      const pixels = (x1 - x0) * (y1 - y0)

      const hist = new Float64Array(256)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) hist[gray[y * width + x]]++
      }

      const clip = Math.max(1, (clipLimit * pixels) / 256)
      let excess = 0
      for (let v = 0; v < 256; v++) {
        if (hist[v] > clip) {
          excess += hist[v] - clip
          hist[v] = clip
        }
      }
      const redistribute = excess / 256

      const map = new Uint8ClampedArray(256)
      let cumulative = 0
      for (let v = 0; v < 256; v++) {
        cumulative += hist[v] + redistribute
        map[v] = Math.round((cumulative / pixels) * 255)
      }
      maps.push(map)
    }
  }

  const out = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y++) {
    const tyf = y / tileH - 0.5
    let ty0 = Math.floor(tyf)
    const fy = tyf - ty0
    let ty1 = ty0 + 1
    if (ty0 < 0) ty0 = 0
    if (ty1 > CLAHE_TILES - 1) ty1 = CLAHE_TILES - 1

    for (let x = 0; x < width; x++) {
      const txf = x / tileW - 0.5
      let tx0 = Math.floor(txf)
      const fx = txf - tx0
      let tx1 = tx0 + 1
      if (tx0 < 0) tx0 = 0
      if (tx1 > CLAHE_TILES - 1) tx1 = CLAHE_TILES - 1

      const g = gray[y * width + x]
      const top = maps[ty0 * CLAHE_TILES + tx0][g] * (1 - fx) + maps[ty0 * CLAHE_TILES + tx1][g] * fx
      const bottom =
        maps[ty1 * CLAHE_TILES + tx0][g] * (1 - fx) + maps[ty1 * CLAHE_TILES + tx1][g] * fx
      out[y * width + x] = top * (1 - fy) + bottom * fy
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Canny pipeline
// ---------------------------------------------------------------------------

// Separable 5-tap Gaussian ([1,4,6,4,1]/16 per axis), edge-clamped.
function gaussianBlur(gray, width, height) {
  const kernel = [1, 4, 6, 4, 1]
  const tmp = new Float32Array(width * height)
  const out = new Float32Array(width * height)

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        let xx = x + k
        if (xx < 0) xx = 0
        else if (xx >= width) xx = width - 1
        acc += gray[row + xx] * kernel[k + 2]
      }
      tmp[row + x] = acc
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0
      for (let k = -2; k <= 2; k++) {
        let yy = y + k
        if (yy < 0) yy = 0
        else if (yy >= height) yy = height - 1
        acc += tmp[yy * width + x] * kernel[k + 2]
      }
      out[y * width + x] = acc / 256
    }
  }
  return out
}

// Gradient magnitude plus direction quantized to 4 sectors (0°, 45°, 90°, 135°).
function sobelGradients(src, width, height) {
  const mag = new Float32Array(width * height)
  const dir = new Uint8Array(width * height)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const tl = src[i - width - 1]
      const t = src[i - width]
      const tr = src[i - width + 1]
      const l = src[i - 1]
      const r = src[i + 1]
      const bl = src[i + width - 1]
      const b = src[i + width]
      const br = src[i + width + 1]

      const gx = tr + 2 * r + br - tl - 2 * l - bl
      const gy = bl + 2 * b + br - tl - 2 * t - tr

      mag[i] = Math.sqrt(gx * gx + gy * gy)
      dir[i] = Math.round(Math.atan2(gy, gx) / (Math.PI / 4)) & 3
    }
  }
  return { mag, dir }
}

// Keep a pixel only if it is the local maximum along its gradient direction —
// thins smeared gradient ridges down to 1px boundary lines.
function nonMaxSuppression(mag, dir, width, height) {
  const out = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const m = mag[i]
      if (m === 0) continue
      let a
      let b
      switch (dir[i]) {
        case 0:
          a = mag[i - 1]
          b = mag[i + 1]
          break
        case 1:
          a = mag[i - width + 1]
          b = mag[i + width - 1]
          break
        case 2:
          a = mag[i - width]
          b = mag[i + width]
          break
        default:
          a = mag[i - width - 1]
          b = mag[i + width + 1]
          break
      }
      if (m >= a && m >= b) out[i] = m
    }
  }
  return out
}

// Magnitude value below which the given fraction of nonzero pixels fall.
function magnitudeAtPercentile(mag, fraction) {
  let max = 0
  for (let i = 0; i < mag.length; i++) if (mag[i] > max) max = mag[i]
  if (max === 0) return 0

  const bins = 256
  const hist = new Float64Array(bins)
  let count = 0
  for (let i = 0; i < mag.length; i++) {
    const m = mag[i]
    if (m > 0) {
      hist[Math.min(bins - 1, Math.floor((m / max) * bins))]++
      count++
    }
  }

  const target = count * fraction
  let cumulative = 0
  for (let bin = 0; bin < bins; bin++) {
    cumulative += hist[bin]
    if (cumulative >= target) return ((bin + 1) / bins) * max
  }
  return max
}

// Per-pixel high-threshold map: each tile gets its own percentile of local NMS
// magnitudes (so boundaries in lower-contrast regions still qualify), clamped
// to a global noise floor (so featureless regions don't promote noise), then
// bilinearly interpolated to avoid seams between tiles.
function adaptiveHighMap(nms, width, height, fraction, noiseFloorRatio) {
  let max = 0
  for (let i = 0; i < nms.length; i++) if (nms[i] > max) max = nms[i]
  if (max === 0) return null

  const globalHigh = magnitudeAtPercentile(nms, fraction)
  const floor = globalHigh * noiseFloorRatio

  const tiles = 8
  const tileW = Math.ceil(width / tiles)
  const tileH = Math.ceil(height / tiles)
  const bins = 128
  const tileHigh = new Float32Array(tiles * tiles)

  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const x0 = tx * tileW
      const y0 = ty * tileH
      const x1 = Math.min(width, x0 + tileW)
      const y1 = Math.min(height, y0 + tileH)

      const hist = new Float64Array(bins)
      let count = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const m = nms[y * width + x]
          if (m > 0) {
            hist[Math.min(bins - 1, Math.floor((m / max) * bins))]++
            count++
          }
        }
      }

      // Too few edge pixels for a meaningful local percentile — use the global value.
      let value = globalHigh
      if (count >= 64) {
        const target = count * fraction
        let cumulative = 0
        for (let bin = 0; bin < bins; bin++) {
          cumulative += hist[bin]
          if (cumulative >= target) {
            value = ((bin + 1) / bins) * max
            break
          }
        }
      }
      tileHigh[ty * tiles + tx] = Math.max(value, floor)
    }
  }

  const map = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const tyf = y / tileH - 0.5
    let ty0 = Math.floor(tyf)
    const fy = tyf - ty0
    let ty1 = ty0 + 1
    if (ty0 < 0) ty0 = 0
    if (ty1 > tiles - 1) ty1 = tiles - 1

    for (let x = 0; x < width; x++) {
      const txf = x / tileW - 0.5
      let tx0 = Math.floor(txf)
      const fx = txf - tx0
      let tx1 = tx0 + 1
      if (tx0 < 0) tx0 = 0
      if (tx1 > tiles - 1) tx1 = tiles - 1

      const top = tileHigh[ty0 * tiles + tx0] * (1 - fx) + tileHigh[ty0 * tiles + tx1] * fx
      const bottom = tileHigh[ty1 * tiles + tx0] * (1 - fx) + tileHigh[ty1 * tiles + tx1] * fx
      map[y * width + x] = top * (1 - fy) + bottom * fy
    }
  }

  return { map, tileHigh, globalHigh }
}

// Strong edges (≥ local high) seed flood fills that pull in connected weak
// edges (≥ lowRatio × local high).
function hysteresisAdaptive(nms, width, height, highMap, lowRatio) {
  const edges = new Uint8Array(width * height)
  const stack = []

  for (let i = 0; i < nms.length; i++) {
    if (edges[i] || nms[i] < highMap[i]) continue
    edges[i] = 1
    stack.push(i)
    while (stack.length > 0) {
      const j = stack.pop()
      const jx = j % width
      const jy = (j - jx) / width
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = jx + dx
          const ny = jy + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const n = ny * width + nx
          if (!edges[n] && nms[n] >= highMap[n] * lowRatio) {
            edges[n] = 1
            stack.push(n)
          }
        }
      }
    }
  }
  return edges
}

// ---------------------------------------------------------------------------
// Morphology
// ---------------------------------------------------------------------------

function dilate3(mask, width, height) {
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (mask[i]) {
        out[i] = 1
        continue
      }
      let hit = 0
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          if (mask[ny * width + nx]) {
            hit = 1
            break
          }
        }
      }
      out[i] = hit
    }
  }
  return out
}

function erode3(mask, width, height) {
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!mask[i]) continue
      let keep = 1
      for (let dy = -1; dy <= 1 && keep; dy++) {
        const ny = y + dy
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) {
            keep = 0
            break
          }
        }
      }
      out[i] = keep
    }
  }
  return out
}

// Closing (dilate → erode) bridges 1–2px gaps in detected boundary lines so a
// test line crossing a slightly broken boundary still registers one intercept.
function morphologicalClose(mask, width, height) {
  return erode3(dilate3(mask, width, height), width, height)
}

// ---------------------------------------------------------------------------
// Edge detection entry point
// ---------------------------------------------------------------------------

export function cannyEdges(gray, width, height, sensitivity = 0) {
  // The single sensitivity control (-40..+40) drives all three adaptive knobs.
  // Higher sensitivity → stronger CLAHE, lower tile percentile, lower noise
  // floor — each monotonically increases detected boundaries.
  const claheClip = clamp(2.5 + sensitivity * 0.03, 1.5, 4)
  const fraction = clamp(0.88 - sensitivity * 0.005, 0.6, 0.99)
  const noiseFloorRatio = clamp(0.25 - sensitivity * 0.003, 0.08, 0.5)

  const enhanced = clahe(gray, width, height, claheClip)
  const blurred = gaussianBlur(enhanced, width, height)
  const { mag, dir } = sobelGradients(blurred, width, height)
  const thin = nonMaxSuppression(mag, dir, width, height)

  const adaptive = adaptiveHighMap(thin, width, height, fraction, noiseFloorRatio)
  if (!adaptive) {
    return { edges: new Uint8Array(width * height), high: 0, low: 0 }
  }

  const raw = hysteresisAdaptive(thin, width, height, adaptive.map, 0.4)
  const edges = morphologicalClose(raw, width, height)

  // Report the median tile threshold as the representative value.
  const sorted = Array.from(adaptive.tileHigh).sort((a, b) => a - b)
  const high = sorted[Math.floor(sorted.length / 2)]
  return { edges, high, low: high * 0.4 }
}

// ---------------------------------------------------------------------------
// MLI analysis
// ---------------------------------------------------------------------------

// Walk one test line through the boundary mask. getIndex maps the moving
// coordinate to a mask index; a transition into a boundary pixel counts as one
// intercept, with minSpacing suppressing double counts from noise or thick
// boundaries.
function walkLine(mask, getIndex, from, to, minSpacing) {
  const intercepts = []
  let inBoundary = false
  let lastIntercept = -Infinity

  for (let p = from; p < to; p++) {
    const isBoundary = mask[getIndex(p)] === 1
    if (isBoundary && !inBoundary) {
      if (p - lastIntercept >= minSpacing) {
        intercepts.push(p)
        lastIntercept = p
      }
      inBoundary = true
    } else if (!isBoundary) {
      inBoundary = false
    }
  }
  return intercepts
}

/**
 * Run MLI analysis on an image.
 *
 * Test lines are spaced evenly across the image (5% margin on all sides) in
 * the requested orientation(s). 'both' (the ASTM E112-recommended default)
 * places numLines in each direction — never fewer than 3 per direction — so
 * the measurement averages over grain elongation.
 *
 * Returns geometry in pixels; the caller converts to µm via its scale factor.
 * Each entry in `lines` carries its orientation ('horizontal' lines have
 * {y, x1, x2}, 'vertical' have {x, y1, y2}; intercepts are the moving
 * coordinate). `directions` holds per-orientation totals. `mask` is the
 * per-pixel boundary map (Uint8Array, 1 = boundary) for overlay rendering.
 */
export function analyzeImage(
  imageData,
  { numLines = 7, sensitivity = 0, minSpacing = 8, method = 'canny', orientation = 'both' } = {},
) {
  const { width, height } = imageData
  const gray = toGrayscale(imageData)

  let mask
  let detail
  if (method === 'threshold') {
    const threshold = Math.min(255, Math.max(0, otsuThreshold(gray) + sensitivity))
    mask = new Uint8Array(width * height)
    for (let i = 0; i < mask.length; i++) mask[i] = gray[i] < threshold ? 1 : 0
    detail = { threshold }
  } else {
    const { edges, high, low } = cannyEdges(gray, width, height, sensitivity)
    mask = edges
    detail = { highThreshold: Math.round(high), lowThreshold: Math.round(low) }
  }

  const marginX = Math.round(width * 0.05)
  const marginY = Math.round(height * 0.05)
  const linesPerDirection = orientation === 'both' ? Math.max(3, numLines) : numLines

  const lines = []
  const directions = {}

  if (orientation === 'horizontal' || orientation === 'both') {
    const x1 = marginX
    const x2 = width - marginX
    const usable = height - 2 * marginY
    let intercepts = 0
    for (let n = 0; n < linesPerDirection; n++) {
      const y = Math.round(marginY + ((n + 0.5) / linesPerDirection) * usable)
      const hits = walkLine(mask, (x) => y * width + x, x1, x2, minSpacing)
      lines.push({ orientation: 'horizontal', y, x1, x2, intercepts: hits })
      intercepts += hits.length
    }
    directions.horizontal = {
      lines: linesPerDirection,
      intercepts,
      lengthPx: (x2 - x1) * linesPerDirection,
    }
  }

  if (orientation === 'vertical' || orientation === 'both') {
    const y1 = marginY
    const y2 = height - marginY
    const usable = width - 2 * marginX
    let intercepts = 0
    for (let n = 0; n < linesPerDirection; n++) {
      const x = Math.round(marginX + ((n + 0.5) / linesPerDirection) * usable)
      const hits = walkLine(mask, (y) => y * width + x, y1, y2, minSpacing)
      lines.push({ orientation: 'vertical', x, y1, y2, intercepts: hits })
      intercepts += hits.length
    }
    directions.vertical = {
      lines: linesPerDirection,
      intercepts,
      lengthPx: (y2 - y1) * linesPerDirection,
    }
  }

  let totalIntercepts = 0
  let totalLengthPx = 0
  for (const dir of Object.values(directions)) {
    totalIntercepts += dir.intercepts
    totalLengthPx += dir.lengthPx
  }
  const mliPx = totalIntercepts > 0 ? totalLengthPx / totalIntercepts : null

  return {
    lines,
    directions,
    orientation,
    totalIntercepts,
    totalLengthPx,
    mliPx,
    method,
    detail,
    mask,
    width,
    height,
  }
}

// ASTM E112: G = -6.643856 * log10(l̄) - 3.288, with mean intercept length l̄ in mm.
export function astmGrainNumber(mliMicrons) {
  if (!mliMicrons || mliMicrons <= 0) return null
  return -6.643856 * Math.log10(mliMicrons / 1000) - 3.288
}
