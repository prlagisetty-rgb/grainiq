// Mean Linear Intercept (MLI) grain size analysis — ASTM E112 Heyn lineal intercept method.
//
// Two boundary detection methods:
//  - 'canny' (default): Gaussian blur → Sobel gradients → non-maximum suppression →
//    hysteresis thresholding. Detects boundaries by local contrast change in either
//    direction, so it handles dark-etched boundaries and bright boundaries (e.g.
//    Barker's etched aluminium alloys) alike.
//  - 'threshold': global Otsu dark-pixel threshold (the original prototype method).
//    Only valid where boundaries etch darker than the grains.

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

// Strong edges (≥ high) seed flood fills that pull in connected weak edges (≥ low).
function hysteresis(nms, width, height, low, high) {
  const edges = new Uint8Array(width * height)
  const stack = []

  for (let i = 0; i < nms.length; i++) {
    if (nms[i] < high || edges[i]) continue
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
          if (!edges[n] && nms[n] >= low) {
            edges[n] = 1
            stack.push(n)
          }
        }
      }
    }
  }
  return edges
}

export function cannyEdges(gray, width, height, sensitivity = 0) {
  const blurred = gaussianBlur(gray, width, height)
  const { mag, dir } = sobelGradients(blurred, width, height)
  const thin = nonMaxSuppression(mag, dir, width, height)

  // Higher sensitivity → lower percentile → more pixels qualify as edges.
  const fraction = Math.min(0.995, Math.max(0.5, 0.9 - sensitivity * 0.005))
  const high = magnitudeAtPercentile(thin, fraction)
  const low = high * 0.4
  const edges = hysteresis(thin, width, height, low, high)
  return { edges, high, low }
}

// ---------------------------------------------------------------------------
// MLI analysis
// ---------------------------------------------------------------------------

/**
 * Run MLI analysis on an image.
 *
 * Horizontal test lines are spaced evenly down the image (5% margin on all
 * sides). Walking each line, a transition into a boundary pixel counts as one
 * intercept. minSpacing suppresses double counts from noise or thick
 * boundaries.
 *
 * Returns geometry in pixels; the caller converts to µm via its scale factor.
 * `mask` is the per-pixel boundary map (Uint8Array, 1 = boundary) for overlay
 * rendering.
 */
export function analyzeImage(
  imageData,
  { numLines = 7, sensitivity = 0, minSpacing = 8, method = 'canny' } = {},
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
  const x1 = marginX
  const x2 = width - marginX
  const usableHeight = height - 2 * marginY

  const lines = []
  let totalIntercepts = 0

  for (let n = 0; n < numLines; n++) {
    const y = Math.round(marginY + ((n + 0.5) / numLines) * usableHeight)
    const intercepts = []
    let inBoundary = false
    let lastIntercept = -Infinity

    for (let x = x1; x < x2; x++) {
      const isBoundary = mask[y * width + x] === 1
      if (isBoundary && !inBoundary) {
        if (x - lastIntercept >= minSpacing) {
          intercepts.push(x)
          lastIntercept = x
        }
        inBoundary = true
      } else if (!isBoundary) {
        inBoundary = false
      }
    }

    lines.push({ y, x1, x2, intercepts })
    totalIntercepts += intercepts.length
  }

  const totalLengthPx = (x2 - x1) * numLines
  const mliPx = totalIntercepts > 0 ? totalLengthPx / totalIntercepts : null

  return { lines, totalIntercepts, totalLengthPx, mliPx, method, detail, mask, width, height }
}

// ASTM E112: G = -6.643856 * log10(l̄) - 3.288, with mean intercept length l̄ in mm.
export function astmGrainNumber(mliMicrons) {
  if (!mliMicrons || mliMicrons <= 0) return null
  return -6.643856 * Math.log10(mliMicrons / 1000) - 3.288
}
