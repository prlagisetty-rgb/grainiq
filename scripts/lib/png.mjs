// Minimal PNG decoder — zero external dependencies, uses only Node built-ins.
//
// Decodes a PNG file to a browser-ImageData-shaped object
// ({ data: Uint8ClampedArray RGBA, width, height }) so the pure analysis engine
// in src/lib/analysis.js can run on real micrographs under Node, exactly as it
// runs on canvas ImageData in the browser.
//
// Supported: bit depth 8 (colour types 0/2/3/4/6) and bit depth 16 (0/2/4/6,
// high byte taken). Non-interlaced only. These cover every PNG a normal export
// (ImageJ, microscope software, screenshot, "Save as PNG") produces. Anything
// outside that throws a clear error rather than returning silently-wrong pixels
// — a validation harness must never score garbage.

import zlib from 'node:zlib'
import fs from 'node:fs'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// Channels per pixel for each PNG colour type.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePngBuffer(buf) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buf[i] !== SIGNATURE[i]) throw new Error('Not a PNG file (bad signature)')
  }

  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  const idat = []

  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const dataStart = pos + 8

    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart)
      height = buf.readUInt32BE(dataStart + 4)
      bitDepth = buf[dataStart + 8]
      colorType = buf[dataStart + 9]
      interlace = buf[dataStart + 12]
    } else if (type === 'PLTE') {
      palette = buf.subarray(dataStart, dataStart + length)
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + length))
    } else if (type === 'IEND') {
      break
    }

    pos = dataStart + length + 4 // skip data + CRC
  }

  if (interlace !== 0) throw new Error('Interlaced PNG is not supported — re-export without interlacing')
  if (!(colorType in CHANNELS)) throw new Error(`Unsupported PNG colour type ${colorType}`)
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth} — re-export as 8-bit`)
  }
  if (colorType === 3 && !palette) throw new Error('Palette PNG missing PLTE chunk')

  const channels = CHANNELS[colorType]
  const bytesPerSample = bitDepth / 8
  const bpp = channels * bytesPerSample // bytes per pixel, for filtering
  const rowBytes = width * bpp

  const raw = zlib.inflateSync(Buffer.concat(idat))
  if (raw.length < (rowBytes + 1) * height) {
    throw new Error('PNG data shorter than expected — file may be truncated')
  }

  // Un-filter scanlines in place into `recon` (height * rowBytes, no filter byte).
  const recon = new Uint8Array(rowBytes * height)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const rowStart = y * rowBytes
    const prevStart = (y - 1) * rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[rp + i]
      const a = i >= bpp ? recon[rowStart + i - bpp] : 0
      const b = y > 0 ? recon[prevStart + i] : 0
      const c = y > 0 && i >= bpp ? recon[prevStart + i - bpp] : 0
      let value
      switch (filter) {
        case 0:
          value = x
          break
        case 1:
          value = x + a
          break
        case 2:
          value = x + b
          break
        case 3:
          value = x + ((a + b) >> 1)
          break
        case 4:
          value = x + paeth(a, b, c)
          break
        default:
          throw new Error(`Unknown PNG filter type ${filter}`)
      }
      recon[rowStart + i] = value & 0xff
    }
    rp += rowBytes
  }

  // Expand to RGBA. For 16-bit, take the high byte of each sample.
  const data = new Uint8ClampedArray(width * height * 4)
  const sampleAt = (rowStart, channel) => recon[rowStart + (channel * bytesPerSample)]

  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes
    for (let x = 0; x < width; x++) {
      const px = rowStart + x * bpp
      const o = (y * width + x) * 4
      if (colorType === 0) {
        const v = sampleAt(px, 0)
        data[o] = data[o + 1] = data[o + 2] = v
        data[o + 3] = 255
      } else if (colorType === 4) {
        const v = sampleAt(px, 0)
        data[o] = data[o + 1] = data[o + 2] = v
        data[o + 3] = sampleAt(px, 1)
      } else if (colorType === 2) {
        data[o] = sampleAt(px, 0)
        data[o + 1] = sampleAt(px, 1)
        data[o + 2] = sampleAt(px, 2)
        data[o + 3] = 255
      } else if (colorType === 6) {
        data[o] = sampleAt(px, 0)
        data[o + 1] = sampleAt(px, 1)
        data[o + 2] = sampleAt(px, 2)
        data[o + 3] = sampleAt(px, 3)
      } else {
        // Palette (colour type 3). Index → PLTE RGB triple.
        const idx = recon[px]
        data[o] = palette[idx * 3]
        data[o + 1] = palette[idx * 3 + 1]
        data[o + 2] = palette[idx * 3 + 2]
        data[o + 3] = 255
      }
    }
  }

  return { data, width, height }
}

export function decodePng(filePath) {
  return decodePngBuffer(fs.readFileSync(filePath))
}
