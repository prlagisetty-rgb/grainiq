// Mean Linear Intercept (MLI) grain size analysis — ASTM E112 Heyn lineal intercept method.
//
// Three boundary detection methods:
//  - 'watershed' (default): CLAHE → Gaussian blur → Otsu split into grain interior vs
//    boundary class (polarity auto-detected, so dark-etched and bright boundaries both
//    work) → chamfer distance transform → regional-maxima markers (one per grain
//    interior) → Meyer priority-flood watershed. Floods every grain outward from its
//    centre until floods collide, so it recovers the COMPLETE boundary network — a
//    boundary between two grains is found even where its local contrast is too weak
//    for an edge detector.
//  - 'canny': CLAHE → Gaussian blur → Sobel gradients → non-maximum suppression →
//    adaptive (per-tile) hysteresis thresholding → morphological closing. Finds
//    boundaries by contrast change; can miss low-gradient boundary segments.
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
// Watershed pipeline
// ---------------------------------------------------------------------------

// Separable 5x5 grayscale dilation (isMax) or erosion (!isMax), edge-clamped.
function grayMorph5(src, width, height, isMax) {
  const tmp = new Uint8Array(width * height)
  const out = new Uint8Array(width * height)
  const better = isMax ? (a, b) => (b > a ? b : a) : (a, b) => (b < a ? b : a)

  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let v = src[row + x]
      for (let k = -2; k <= 2; k++) {
        let xx = x + k
        if (xx < 0) xx = 0
        else if (xx >= width) xx = width - 1
        v = better(v, src[row + xx])
      }
      tmp[row + x] = v
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = tmp[y * width + x]
      for (let k = -2; k <= 2; k++) {
        let yy = y + k
        if (yy < 0) yy = 0
        else if (yy >= height) yy = height - 1
        v = better(v, tmp[yy * width + x])
      }
      out[y * width + x] = v
    }
  }
  return out
}

// Two-pass chamfer (3,4) distance transform: distance from each interior pixel
// to the nearest boundary-class pixel, in units of ~1/3 px. Out-of-image
// counts as boundary so border grains get sensible centres.
function chamferDistance(interior, width, height) {
  const INF = 1 << 29
  const dist = new Int32Array(width * height)
  for (let i = 0; i < dist.length; i++) dist[i] = interior[i] ? INF : 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (dist[i] === 0) continue
      const left = x > 0 ? dist[i - 1] : 0
      const up = y > 0 ? dist[i - width] : 0
      const upLeft = x > 0 && y > 0 ? dist[i - width - 1] : 0
      const upRight = x < width - 1 && y > 0 ? dist[i - width + 1] : 0
      dist[i] = Math.min(dist[i], left + 3, up + 3, upLeft + 4, upRight + 4)
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      if (dist[i] === 0) continue
      const right = x < width - 1 ? dist[i + 1] : 0
      const down = y < height - 1 ? dist[i + width] : 0
      const downRight = x < width - 1 && y < height - 1 ? dist[i + width + 1] : 0
      const downLeft = x > 0 && y < height - 1 ? dist[i + width - 1] : 0
      dist[i] = Math.min(dist[i], right + 3, down + 3, downRight + 4, downLeft + 4)
    }
  }
  return dist
}

// Connected-component labelling (BFS). 4-connectivity for interior regions
// (diagonal contact across a boundary must not merge grains); 8-connectivity
// for marker blobs.
function labelComponents(mask, width, height, useDiagonals) {
  const labels = new Int32Array(width * height)
  const stack = []
  let count = 0

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    count++
    labels[start] = count
    stack.length = 0
    stack.push(start)

    while (stack.length > 0) {
      const j = stack.pop()
      const jx = j % width
      const jy = (j - jx) / width
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          if (!useDiagonals && dx !== 0 && dy !== 0) continue
          const nx = jx + dx
          const ny = jy + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const n = ny * width + nx
          if (mask[n] && !labels[n]) {
            labels[n] = count
            stack.push(n)
          }
        }
      }
    }
  }
  return { labels, count }
}

// Markers from two complementary rules:
//  1. Regional maxima of the distance transform (plateaus with no higher
//     neighbour). Crucially these split regions that are MERGED by boundary
//     gaps: each true grain inside a merged region keeps its own local
//     maximum, and the watershed restores the missing boundary at the saddle
//     between them.
//  2. Per-component guarantee: any interior component large enough to be a
//     grain (max distance >= minDist) that ended up without a regional-max
//     marker gets its maximum-distance pixels as a marker, so no grain
//     interior is ever left unseeded.
function findMarkers(interior, dist, width, height, minDist) {
  const { labels: comp, count: compCount } = labelComponents(interior, width, height, false)
  const markerPixels = new Uint8Array(width * height)
  const hasMarker = new Uint8Array(compCount + 1)
  const visited = new Uint8Array(width * height)
  const queue = []

  for (let start = 0; start < dist.length; start++) {
    if (visited[start] || dist[start] < minDist) continue

    const value = dist[start]
    const plateau = [start]
    visited[start] = 1
    queue.length = 0
    queue.push(start)
    let isMax = true

    while (queue.length > 0) {
      const j = queue.pop()
      const jx = j % width
      const jy = (j - jx) / width
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = jx + dx
          const ny = jy + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const n = ny * width + nx
          if (dist[n] > value) isMax = false
          else if (dist[n] === value && !visited[n]) {
            visited[n] = 1
            plateau.push(n)
            queue.push(n)
          }
        }
      }
    }

    if (isMax) {
      for (const p of plateau) markerPixels[p] = 1
      hasMarker[comp[start]] = 1
    }
  }

  const compMax = new Int32Array(compCount + 1)
  for (let i = 0; i < comp.length; i++) {
    const c = comp[i]
    if (c && dist[i] > compMax[c]) compMax[c] = dist[i]
  }
  for (let i = 0; i < comp.length; i++) {
    const c = comp[i]
    if (!c || hasMarker[c]) continue
    if (compMax[c] >= minDist && dist[i] === compMax[c]) markerPixels[i] = 1
  }

  const blobs = labelComponents(markerPixels, width, height, true)
  return { ...blobs, components: compCount }
}

// Meyer's priority-flood watershed with a bucket queue. Floods all markers
// outward in elevation order (4-connected); pixels where two different floods
// meet become watershed lines (-1) — the grain boundary network.
function watershedFlood(elevation, markers, width, height, maxElevation) {
  const WSHED = -1
  const out = Int32Array.from(markers)
  const inQueue = new Uint8Array(width * height)
  const buckets = []
  for (let e = 0; e <= maxElevation; e++) buckets.push([])

  const pushNeighbours = (i, level) => {
    const x = i % width
    const y = (i - x) / width
    const neighbours = [
      x > 0 ? i - 1 : -1,
      x < width - 1 ? i + 1 : -1,
      y > 0 ? i - width : -1,
      y < height - 1 ? i + width : -1,
    ]
    for (const n of neighbours) {
      if (n >= 0 && out[n] === 0 && !inQueue[n]) {
        inQueue[n] = 1
        buckets[Math.max(elevation[n], level)].push(n)
      }
    }
  }

  for (let i = 0; i < out.length; i++) {
    if (out[i] > 0) pushNeighbours(i, elevation[i])
  }

  for (let level = 0; level <= maxElevation; level++) {
    const bucket = buckets[level]
    while (bucket.length > 0) {
      const i = bucket.pop()
      if (out[i] !== 0) continue

      const x = i % width
      const y = (i - x) / width
      let label = 0
      let isWatershed = false
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ]
      for (const n of neighbours) {
        if (n < 0) continue
        const l = out[n]
        if (l > 0) {
          if (label === 0) label = l
          else if (label !== l) isWatershed = true
        }
      }

      if (isWatershed || label === 0) {
        out[i] = WSHED
        continue
      }
      out[i] = label
      pushNeighbours(i, level)
    }
  }
  return out
}

export function watershedBoundaries(gray, width, height, sensitivity = 0) {
  // Sensitivity (-40..+40): stronger CLAHE, a threshold shifted to classify
  // more pixels as boundary, and a lower marker floor (more grains resolved).
  const claheClip = clamp(2.5 + sensitivity * 0.03, 1.5, 4)
  const minMarkerPx = clamp(2 - sensitivity * 0.03, 1, 4)

  const enhanced = clahe(gray, width, height, claheClip)
  const blurred = gaussianBlur(enhanced, width, height)
  const smooth = new Uint8ClampedArray(width * height)
  for (let i = 0; i < smooth.length; i++) smooth[i] = blurred[i]

  // Boundary class by local depth, not absolute level: bottom-hat
  // (closing − image) lights up thin DARK valleys by how far they dip below
  // their surroundings; top-hat (image − opening) does the same for thin
  // BRIGHT ridges. This catches faint boundaries that a global Otsu threshold
  // classifies as grain interior. Polarity = whichever hat carries more mass.
  const hatCut = clamp(10 - sensitivity * 0.15, 3, 20)
  const closing = grayMorph5(grayMorph5(smooth, width, height, true), width, height, false)
  const opening = grayMorph5(grayMorph5(smooth, width, height, false), width, height, true)
  let darkMass = 0
  let brightMass = 0
  for (let i = 0; i < smooth.length; i++) {
    if (closing[i] - smooth[i] > hatCut) darkMass++
    if (smooth[i] - opening[i] > hatCut) brightMass++
  }
  const boundaryIsDark = darkMass >= brightMass

  // The 5x5 hat can't fill boundary bands wider than ~4px, so back it up with
  // the global Otsu class — but only when that class is a clear minority
  // (a genuine thin network rather than half the histogram).
  const otsu = otsuThreshold(smooth)
  const threshold = clamp(otsu + (boundaryIsDark ? 1 : -1) * sensitivity * 0.5, 1, 254)
  let otsuClassCount = 0
  for (let i = 0; i < smooth.length; i++) {
    if (boundaryIsDark ? smooth[i] < threshold : smooth[i] > threshold) otsuClassCount++
  }
  const useOtsu = otsuClassCount / smooth.length < 0.4

  const boundaryClass = new Uint8Array(width * height)
  for (let i = 0; i < boundaryClass.length; i++) {
    const hatHit = boundaryIsDark
      ? closing[i] - smooth[i] > hatCut
      : smooth[i] - opening[i] > hatCut
    const otsuHit = useOtsu && (boundaryIsDark ? smooth[i] < threshold : smooth[i] > threshold)
    boundaryClass[i] = hatHit || otsuHit ? 1 : 0
  }

  // Seal small gaps in the boundary network (binary closing) so the flood
  // cannot leak between grains through broken boundary segments.
  const sealed = morphologicalClose(boundaryClass, width, height)
  const interior = new Uint8Array(width * height)
  for (let i = 0; i < interior.length; i++) interior[i] = sealed[i] ? 0 : 1

  const dist = chamferDistance(interior, width, height)
  let maxDist = 0
  for (let i = 0; i < dist.length; i++) if (dist[i] > maxDist) maxDist = dist[i]

  const polarity = boundaryIsDark ? 'dark' : 'bright'
  const empty = () => ({
    mask: new Uint8Array(width * height),
    grains: 0,
    threshold: Math.round(threshold),
    polarity,
  })
  if (maxDist === 0) return empty()

  const { labels, count, components } = findMarkers(
    interior,
    dist,
    width,
    height,
    Math.round(minMarkerPx * 3),
  )
  if (count === 0) return empty()

  // Flood grain centres (high distance) first; boundary-class pixels last.
  const maxElevation = maxDist + 1
  const elevation = new Int32Array(width * height)
  for (let i = 0; i < elevation.length; i++) {
    elevation[i] = interior[i] ? maxDist - dist[i] : maxElevation
  }

  const segmented = watershedFlood(elevation, labels, width, height, maxElevation)

  // Boundary mask = watershed pixels PLUS label transitions. Meyer's flood can
  // leave two regions directly adjacent with no watershed pixel between them
  // (zero-width line); marking one side of every label change closes the gap.
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const label = segmented[i]
      if (label === -1) {
        mask[i] = 1
        continue
      }
      if (label > 0) {
        const right = x < width - 1 ? segmented[i + 1] : label
        const down = y < height - 1 ? segmented[i + width] : label
        // Mark both sides so a test line lying inside a claimed boundary band
        // still meets the mask.
        if (right > 0 && right !== label) {
          mask[i] = 1
          mask[i + 1] = 1
        }
        if (down > 0 && down !== label) {
          mask[i] = 1
          mask[i + width] = 1
        }
      }
    }
  }

  // Extend the mask through thick boundary bands: watershed lines form at the
  // band edges, leaving the band interior label-claimed — but a boundary-class
  // pixel touching a marked pixel is part of the same physical boundary.
  // Bands are at most ~5px wide (the hat structuring element), so 3 dilation
  // passes restricted to boundary-class pixels reach closure.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false
    const snapshot = Uint8Array.from(mask)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (snapshot[i] || interior[i]) continue
        let touchesMask = false
        for (let dy = -1; dy <= 1 && !touchesMask; dy++) {
          const ny = y + dy
          if (ny < 0 || ny >= height) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            if (nx < 0 || nx >= width) continue
            if (snapshot[ny * width + nx]) {
              touchesMask = true
              break
            }
          }
        }
        if (touchesMask) {
          mask[i] = 1
          changed = true
        }
      }
    }
    if (!changed) break
  }

  return { mask, grains: count, components, threshold: Math.round(threshold), polarity }
}

// ---------------------------------------------------------------------------
// MLI analysis
// ---------------------------------------------------------------------------

// Strip connected components smaller than minSize pixels (8-connectivity).
// Orphan 1–2px speckles in a thresholded or edge map sit directly on a test
// line and get miscounted as intercepts (false positives); a real grain
// boundary is a large connected structure, so clearing the specks removes that
// error class without dropping any true crossing. Returns a fresh mask.
function removeSmallComponents(mask, width, height, minSize) {
  const { labels, count } = labelComponents(mask, width, height, true)
  if (count === 0) return mask
  const sizes = new Int32Array(count + 1)
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) sizes[labels[i]]++
  }
  const out = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && sizes[labels[i]] >= minSize) out[i] = 1
  }
  return out
}

// Mean boundary stroke width (px) of a mask, estimated as 2·area / perimeter,
// where perimeter counts mask-pixel sides facing background or the image edge.
// For a ribbon of width w and length L≫w this returns ≈ w (a 1px line → ~1, a
// 3px band → ~3). Used to size speckle removal to the boundaries actually
// detected, so thin 1–2px line maps aren't stripped of real fragments while
// thick watershed bands can still shed larger noise blobs.
function averageBoundaryWidth(mask, width, height) {
  let area = 0
  let perimeter = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (!mask[i]) continue
      area++
      if (x === 0 || !mask[i - 1]) perimeter++
      if (x === width - 1 || !mask[i + 1]) perimeter++
      if (y === 0 || !mask[i - width]) perimeter++
      if (y === height - 1 || !mask[i + width]) perimeter++
    }
  }
  return perimeter === 0 ? 0 : (2 * area) / perimeter
}

// Intercept detection samples a band this many pixels either side of the test
// line (perpendicular to its direction) instead of only the line itself, so a
// single-pixel gap in a THIN line map (threshold, canny) exactly at a crossing
// point still registers rather than dropping a real intercept (false negative).
// Not used for watershed: its mask is already gap-sealed at every crossing, so a
// band there only reaches sideways into the adjacent boundary and over-counts.
const BAND_HALF = 3

// Walk one test line, counting transitions into the boundary mask as intercepts.
// `isBoundary(p)` is the band sampler for moving coordinate p; minSpacing
// suppresses double counts from noise or thick boundaries.
function walkLine(isBoundary, from, to, minSpacing) {
  const intercepts = []
  let inBoundary = false
  let lastIntercept = -Infinity

  for (let p = from; p < to; p++) {
    const boundary = isBoundary(p)
    if (boundary && !inBoundary) {
      if (p - lastIntercept >= minSpacing) {
        intercepts.push(p)
        lastIntercept = p
      }
      inBoundary = true
    } else if (!boundary) {
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
  { numLines = 7, sensitivity = 0, minSpacing = 8, method = 'watershed', orientation = 'both' } = {},
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
  } else if (method === 'canny') {
    const { edges, high, low } = cannyEdges(gray, width, height, sensitivity)
    mask = edges
    detail = { highThreshold: Math.round(high), lowThreshold: Math.round(low) }
  } else {
    const ws = watershedBoundaries(gray, width, height, sensitivity)
    mask = ws.mask
    detail = {
      grains: ws.grains,
      components: ws.components,
      threshold: ws.threshold,
      polarity: ws.polarity,
    }
  }

  // Clean every method's mask before counting, sizing the cut to the boundaries
  // actually detected: a component thinner than the mean boundary width can't be
  // a real segment. Thin line maps (faint/broken threshold + canny) fall to the
  // 2px floor — only true single-pixel orphans go — which recovers the real 2px
  // fragments a fixed 3px cut was deleting; only genuinely thick (≥3px) masks
  // keep the 3px cut. No-op on the gap-sealed watershed network either way.
  const minComponent = clamp(Math.floor(averageBoundaryWidth(mask, width, height)), 2, 3)
  mask = removeSmallComponents(mask, width, height, minComponent)

  const marginX = Math.round(width * 0.05)
  const marginY = Math.round(height * 0.05)
  const linesPerDirection = orientation === 'both' ? Math.max(3, numLines) : numLines

  // Widen intercept detection to a band only for the thin-line methods; the
  // gap-sealed watershed mask is walked exactly on the line (bandHalf 0 reduces
  // the band loop to a single on-line sample).
  const bandHalf = method === 'watershed' ? 0 : BAND_HALF

  const lines = []
  const directions = {}

  if (orientation === 'horizontal' || orientation === 'both') {
    const x1 = marginX
    const x2 = width - marginX
    const usable = height - 2 * marginY
    let intercepts = 0
    for (let n = 0; n < linesPerDirection; n++) {
      const y = Math.round(marginY + ((n + 0.5) / linesPerDirection) * usable)
      // Band perpendicular to the line spans rows y-bandHalf..y+bandHalf.
      const hits = walkLine(
        (x) => {
          for (let off = -bandHalf; off <= bandHalf; off++) {
            const yy = y + off
            if (yy >= 0 && yy < height && mask[yy * width + x] === 1) return true
          }
          return false
        },
        x1,
        x2,
        minSpacing,
      )
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
      // Band perpendicular to the line spans columns x-bandHalf..x+bandHalf.
      const hits = walkLine(
        (y) => {
          for (let off = -bandHalf; off <= bandHalf; off++) {
            const xx = x + off
            if (xx >= 0 && xx < width && mask[y * width + xx] === 1) return true
          }
          return false
        },
        y1,
        y2,
        minSpacing,
      )
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
