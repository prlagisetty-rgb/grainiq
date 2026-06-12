// Mean Linear Intercept (MLI) grain size analysis — ASTM E112 Heyn lineal intercept method.
// Threshold-based boundary detection (prototype-grade); server-side OpenCV planned for MVP.

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

/**
 * Run MLI analysis on an image.
 *
 * Horizontal test lines are spaced evenly down the image (5% margin on all
 * sides). Walking each line, a transition from grain (bright) into boundary
 * (dark, below threshold) counts as one intercept. minSpacing suppresses
 * double counts from noise within a single boundary.
 *
 * Returns geometry in pixels; the caller converts to µm via its scale factor.
 */
export function analyzeImage(imageData, { numLines = 7, sensitivity = 0, minSpacing = 8 } = {}) {
  const { width, height } = imageData
  const gray = toGrayscale(imageData)
  const threshold = Math.min(255, Math.max(0, otsuThreshold(gray) + sensitivity))

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
      const isDark = gray[y * width + x] < threshold
      if (isDark && !inBoundary) {
        if (x - lastIntercept >= minSpacing) {
          intercepts.push(x)
          lastIntercept = x
        }
        inBoundary = true
      } else if (!isDark) {
        inBoundary = false
      }
    }

    lines.push({ y, x1, x2, intercepts })
    totalIntercepts += intercepts.length
  }

  const totalLengthPx = (x2 - x1) * numLines
  const mliPx = totalIntercepts > 0 ? totalLengthPx / totalIntercepts : null

  return { lines, totalIntercepts, totalLengthPx, mliPx, threshold }
}

// ASTM E112: G = -6.643856 * log10(l̄) - 3.288, with mean intercept length l̄ in mm.
export function astmGrainNumber(mliMicrons) {
  if (!mliMicrons || mliMicrons <= 0) return null
  return -6.643856 * Math.log10(mliMicrons / 1000) - 3.288
}
