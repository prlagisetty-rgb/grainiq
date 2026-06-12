import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useProfile } from '../hooks/useProfile'
import { analyzeImage, astmGrainNumber } from '../lib/analysis'
import { startCheckout, openBillingPortal } from '../lib/billing'

// Canny runs on every slider tick, so cap the analysis resolution to keep it
// interactive. sampleScale corrects the µm conversion for the downscale.
const MAX_ANALYSIS_DIMENSION = 1600

const inputClasses =
  'mt-1 block w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500'

const secondaryButtonClasses =
  'rounded-md border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-300 hover:bg-slate-800'

function lineLength(line) {
  if (!line) return 0
  return Math.hypot(line.x2 - line.x1, line.y2 - line.y1)
}

export default function Dashboard() {
  const { user, signOut } = useAuth()
  const {
    isPro,
    usage,
    remaining,
    limit,
    loading: profileLoading,
    refresh,
    recordAnalysis,
  } = useProfile()
  const canvasRef = useRef(null)
  const fileInputRef = useRef(null)
  const draggingRef = useRef(false)
  const recordedRef = useRef(null)

  const [showUpgrade, setShowUpgrade] = useState(false)
  const [billingBusy, setBillingBusy] = useState(false)
  const [billingError, setBillingError] = useState(null)
  const [checkoutPending, setCheckoutPending] = useState(false)

  const [source, setSource] = useState(null) // { canvas, imageData, sampleScale, fileName, width, height }
  const [loadError, setLoadError] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  const [method, setMethod] = useState('canny')
  const [orientation, setOrientation] = useState('both')
  const [magnification, setMagnification] = useState(100)
  const [scaleOverride, setScaleOverride] = useState(null)
  const [numLines, setNumLines] = useState(7)
  const [sensitivity, setSensitivity] = useState(0)
  const [showBoundaries, setShowBoundaries] = useState(true)

  // Scale bar calibration: mode 'idle' | 'drawing' | 'measured'
  const [calibration, setCalibration] = useState({ mode: 'idle', line: null, realMicrons: '' })
  const [calibrated, setCalibrated] = useState(null) // { realMicrons, lengthPx }

  // µm per pixel of the original image. Until calibrated from the scale bar,
  // falls back to a rule-of-thumb estimate from magnification (1 µm/px at 100x).
  const scale = scaleOverride ?? (magnification > 0 ? 100 / magnification : 1)

  async function loadFile(file) {
    setLoadError(null)
    if (!file) return
    if (!profileLoading && !isPro && remaining <= 0) {
      setShowUpgrade(true)
      return
    }
    if (!file.type.startsWith('image/')) {
      setLoadError('That file is not an image. Use PNG, JPEG, BMP or WebP (export TIFFs to PNG first).')
      return
    }
    try {
      const bitmap = await createImageBitmap(file)
      const factor = Math.min(1, MAX_ANALYSIS_DIMENSION / Math.max(bitmap.width, bitmap.height))
      const width = Math.round(bitmap.width * factor)
      const height = Math.round(bitmap.height * factor)
      const offscreen = document.createElement('canvas')
      offscreen.width = width
      offscreen.height = height
      const ctx = offscreen.getContext('2d')
      ctx.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()
      setSource({
        canvas: offscreen,
        imageData: ctx.getImageData(0, 0, width, height),
        sampleScale: 1 / factor,
        fileName: file.name,
        width,
        height,
      })
      // Line coordinates are meaningless on a new image; the calibrated µm/px
      // remains valid for images from the same microscope setup, so keep it.
      setCalibration({ mode: 'idle', line: null, realMicrons: '' })
    } catch {
      setLoadError('Could not decode that image. Use PNG, JPEG, BMP or WebP (export TIFFs to PNG first).')
    }
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragActive(false)
    loadFile(e.dataTransfer.files[0])
  }

  const result = useMemo(
    () =>
      source
        ? analyzeImage(source.imageData, { numLines, sensitivity, method, orientation })
        : null,
    [source, numLines, sensitivity, method, orientation],
  )

  // µm represented by one pixel of the (possibly downscaled) analysis image.
  const micronsPerAnalysisPx = source ? scale * source.sampleScale : null
  const mliMicrons = result?.mliPx ? result.mliPx * micronsPerAnalysisPx : null
  const grainNumber = astmGrainNumber(mliMicrons)

  // One analysis = one image loaded; parameter tweaks on the same image are
  // free. Record on the first computed result for each new source.
  useEffect(() => {
    if (!source || !result || recordedRef.current === source) return
    recordedRef.current = source
    recordAnalysis({ mliMicrons, astmG: grainNumber }).then((ok) => {
      if (!ok) setShowUpgrade(true)
    })
  }, [source, result, mliMicrons, grainNumber, recordAnalysis])

  // Returning from Stripe Checkout: poll until the webhook flips the tier.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') !== 'success') return
    window.history.replaceState({}, '', window.location.pathname)
    setCheckoutPending(true)
    let attempts = 0
    const timer = setInterval(async () => {
      attempts += 1
      const tier = await refresh()
      if (tier === 'pro' || attempts >= 15) {
        clearInterval(timer)
        setCheckoutPending(false)
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [refresh])

  async function handleUpgrade() {
    setBillingBusy(true)
    setBillingError(null)
    try {
      await startCheckout()
    } catch (err) {
      setBillingError(err.message)
      setBillingBusy(false)
    }
  }

  async function handleBillingPortal() {
    setBillingBusy(true)
    setBillingError(null)
    try {
      await openBillingPortal()
    } catch (err) {
      setBillingError(err.message)
      setBillingBusy(false)
    }
  }

  const blocked = !profileLoading && !isPro && remaining <= 0

  useEffect(() => {
    if (!source || !result) return
    const canvas = canvasRef.current
    canvas.width = source.width
    canvas.height = source.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(source.canvas, 0, 0)

    if (showBoundaries) {
      const overlay = new ImageData(source.width, source.height)
      const od = overlay.data
      for (let i = 0; i < result.mask.length; i++) {
        if (result.mask[i]) {
          const o = i * 4
          od[o] = 250
          od[o + 1] = 204
          od[o + 2] = 21
          od[o + 3] = 150
        }
      }
      const tmp = document.createElement('canvas')
      tmp.width = source.width
      tmp.height = source.height
      tmp.getContext('2d').putImageData(overlay, 0, 0)
      ctx.drawImage(tmp, 0, 0)
    }

    const lineWidth = Math.max(1.5, source.width / 900)
    const tick = Math.max(6, source.width / 240)
    ctx.lineWidth = lineWidth
    for (const line of result.lines) {
      const horizontal = line.orientation === 'horizontal'
      ctx.strokeStyle = '#2dd4bf'
      ctx.beginPath()
      if (horizontal) {
        ctx.moveTo(line.x1, line.y)
        ctx.lineTo(line.x2, line.y)
      } else {
        ctx.moveTo(line.x, line.y1)
        ctx.lineTo(line.x, line.y2)
      }
      ctx.stroke()

      ctx.strokeStyle = '#fb7185'
      for (const p of line.intercepts) {
        ctx.beginPath()
        if (horizontal) {
          ctx.moveTo(p, line.y - tick)
          ctx.lineTo(p, line.y + tick)
        } else {
          ctx.moveTo(line.x - tick, p)
          ctx.lineTo(line.x + tick, p)
        }
        ctx.stroke()
      }
    }

    if (calibration.line) {
      const { x1, y1, x2, y2 } = calibration.line
      ctx.strokeStyle = '#f8fafc'
      ctx.lineWidth = lineWidth * 1.5
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      // End caps
      const cap = Math.max(8, source.width / 200)
      const angle = Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2
      const cx = Math.cos(angle) * cap
      const cy = Math.sin(angle) * cap
      for (const [px, py] of [
        [x1, y1],
        [x2, y2],
      ]) {
        ctx.beginPath()
        ctx.moveTo(px - cx / 2, py - cy / 2)
        ctx.lineTo(px + cx / 2, py + cy / 2)
        ctx.stroke()
      }
    }
  }, [source, result, showBoundaries, calibration.line])

  function toCanvasCoords(e) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  function handlePointerDown(e) {
    if (calibration.mode !== 'drawing') return
    draggingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toCanvasCoords(e)
    setCalibration((c) => ({ ...c, line: { x1: p.x, y1: p.y, x2: p.x, y2: p.y } }))
  }

  function handlePointerMove(e) {
    if (!draggingRef.current) return
    const p = toCanvasCoords(e)
    setCalibration((c) => ({ ...c, line: { ...c.line, x2: p.x, y2: p.y } }))
  }

  function handlePointerUp() {
    if (!draggingRef.current) return
    draggingRef.current = false
    setCalibration((c) =>
      lineLength(c.line) > 5 ? { ...c, mode: 'measured' } : { ...c, line: null },
    )
  }

  function applyCalibration() {
    const lengthPx = lineLength(calibration.line)
    const real = Number(calibration.realMicrons)
    if (!real || real <= 0 || lengthPx === 0) return
    setScaleOverride(real / (lengthPx * source.sampleScale))
    setCalibrated({ realMicrons: real, lengthPx })
    setCalibration((c) => ({ ...c, mode: 'idle', realMicrons: '' }))
  }

  function clearCalibration() {
    setScaleOverride(null)
    setCalibrated(null)
    setCalibration({ mode: 'idle', line: null, realMicrons: '' })
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-900">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
          <h1 className="text-xl font-bold tracking-tight text-white">
            Grain<span className="text-teal-400">IQ</span>
          </h1>
          <div className="flex items-center gap-4">
            {checkoutPending ? (
              <span className="text-sm text-teal-400">Finalising upgrade…</span>
            ) : (
              !profileLoading &&
              (isPro ? (
                <>
                  <span className="rounded-full bg-teal-500/15 px-2.5 py-0.5 text-xs font-semibold text-teal-400">
                    Pro
                  </span>
                  <button
                    onClick={handleBillingPortal}
                    disabled={billingBusy}
                    className="text-sm text-slate-400 hover:text-slate-300 disabled:opacity-60"
                  >
                    Manage billing
                  </button>
                </>
              ) : (
                <>
                  <span className={`text-sm ${remaining <= 3 ? 'text-amber-400' : 'text-slate-400'}`}>
                    {usage ?? 0}/{limit} analyses this month
                  </span>
                  <button
                    onClick={handleUpgrade}
                    disabled={billingBusy}
                    className="rounded-md bg-teal-500 px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-teal-400 disabled:opacity-60"
                  >
                    Upgrade to Pro
                  </button>
                </>
              ))
            )}
            <span className="text-sm text-slate-400">{user?.email}</span>
            <button onClick={signOut} className={secondaryButtonClasses}>
              Sign out
            </button>
          </div>
        </div>
        {billingError && (
          <div className="border-t border-red-900 bg-red-950/60 px-4 py-2 text-center text-sm text-red-400">
            {billingError}
          </div>
        )}
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8">
        {!source && blocked ? (
          <div className="mx-auto max-w-2xl rounded-xl border border-teal-500/30 bg-slate-900 px-8 py-16 text-center">
            <h2 className="text-lg font-semibold text-white">
              You&apos;ve used all {limit} free analyses this month
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              Upgrade to Pro for unlimited analyses — £89/month, cancel anytime.
            </p>
            <button
              onClick={handleUpgrade}
              disabled={billingBusy}
              className="mt-6 rounded-md bg-teal-500 px-6 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400 disabled:opacity-60"
            >
              {billingBusy ? 'Opening checkout…' : 'Upgrade to Pro'}
            </button>
            <p className="mt-4 text-xs text-slate-500">
              Your free allowance resets on the 1st of each month.
            </p>
          </div>
        ) : !source ? (
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragActive(true)
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current.click()}
            className={`mx-auto flex max-w-2xl cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-8 py-20 text-center transition-colors ${
              dragActive
                ? 'border-teal-400 bg-teal-500/10'
                : 'border-slate-700 bg-slate-900 hover:border-teal-500/60'
            }`}
          >
            <p className="text-lg font-semibold text-white">Drop a micrograph here</p>
            <p className="mt-1 text-sm text-slate-400">or click to browse — PNG, JPEG, BMP, WebP</p>
            <p className="mt-6 text-xs text-teal-400/80">
              Images are processed entirely in your browser — never uploaded, never stored.
            </p>
            {loadError && (
              <p role="alert" className="mt-4 rounded-md bg-red-950/60 px-3 py-2 text-sm text-red-400">
                {loadError}
              </p>
            )}
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
            <aside className="space-y-6">
              <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Image</h2>
                <p className="mt-2 truncate text-sm text-white" title={source.fileName}>
                  {source.fileName}
                </p>
                <button
                  onClick={() => fileInputRef.current.click()}
                  className={`mt-3 w-full ${secondaryButtonClasses}`}
                >
                  Replace image
                </button>
                {loadError && (
                  <p role="alert" className="mt-3 rounded-md bg-red-950/60 px-3 py-2 text-sm text-red-400">
                    {loadError}
                  </p>
                )}
              </section>

              <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Calibration
                </h2>

                {calibration.mode === 'idle' && (
                  <button
                    onClick={() => setCalibration((c) => ({ ...c, mode: 'drawing', line: null }))}
                    className="mt-3 w-full rounded-md bg-teal-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400"
                  >
                    Calibrate from scale bar
                  </button>
                )}
                {calibration.mode === 'drawing' && (
                  <div className="mt-3 space-y-3">
                    <p className="rounded-md bg-teal-500/10 px-3 py-2 text-sm text-teal-300">
                      Drag a line along the scale bar on the image.
                    </p>
                    <button
                      onClick={() => setCalibration({ mode: 'idle', line: null, realMicrons: '' })}
                      className={`w-full ${secondaryButtonClasses}`}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                {calibration.mode === 'measured' && (
                  <div className="mt-3 space-y-3">
                    <p className="text-sm text-slate-300">
                      Measured <span className="text-teal-400">{lineLength(calibration.line).toFixed(1)} px</span>
                    </p>
                    <div>
                      <label htmlFor="real-microns" className="block text-sm font-medium text-slate-300">
                        Scale bar length (µm)
                      </label>
                      <input
                        id="real-microns"
                        type="number"
                        min="0.001"
                        step="any"
                        value={calibration.realMicrons}
                        onChange={(e) =>
                          setCalibration((c) => ({ ...c, realMicrons: e.target.value }))
                        }
                        className={inputClasses}
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={applyCalibration}
                        disabled={!Number(calibration.realMicrons)}
                        className="flex-1 rounded-md bg-teal-500 px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Apply
                      </button>
                      <button
                        onClick={() =>
                          setCalibration((c) => ({ ...c, mode: 'drawing', line: null }))
                        }
                        className={`flex-1 ${secondaryButtonClasses}`}
                      >
                        Redraw
                      </button>
                    </div>
                  </div>
                )}

                {calibrated ? (
                  <div className="mt-4 rounded-md border border-teal-500/30 bg-teal-500/5 px-3 py-2">
                    <p className="text-sm text-teal-300">
                      Calibrated: {scale.toFixed(4)} µm/px
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {calibrated.realMicrons} µm over {calibrated.lengthPx.toFixed(1)} px
                    </p>
                    <button
                      onClick={clearCalibration}
                      className="mt-2 text-xs font-medium text-slate-400 underline hover:text-slate-300"
                    >
                      Clear calibration
                    </button>
                  </div>
                ) : (
                  <>
                    <label
                      htmlFor="magnification"
                      className="mt-4 block text-sm font-medium text-slate-300"
                    >
                      Magnification (×)
                    </label>
                    <input
                      id="magnification"
                      type="number"
                      min="1"
                      value={magnification}
                      onChange={(e) => {
                        setMagnification(Number(e.target.value))
                        setScaleOverride(null)
                      }}
                      className={inputClasses}
                    />
                    <label htmlFor="scale" className="mt-4 block text-sm font-medium text-slate-300">
                      Scale (µm/pixel)
                    </label>
                    <input
                      id="scale"
                      type="number"
                      min="0.001"
                      step="0.01"
                      value={Number(scale.toFixed(4))}
                      onChange={(e) => setScaleOverride(Number(e.target.value))}
                      className={inputClasses}
                    />
                    <p className="mt-2 text-xs text-slate-500">
                      Rough estimate from magnification (assumes 1 µm/px at 100×). For accurate
                      results, calibrate from the scale bar above.
                    </p>
                  </>
                )}
              </section>

              <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Detection
                </h2>
                <label htmlFor="method" className="mt-3 block text-sm font-medium text-slate-300">
                  Boundary detection method
                </label>
                <select
                  id="method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  className={inputClasses}
                >
                  <option value="canny">Edge detection (Canny) — recommended</option>
                  <option value="threshold">Dark threshold (legacy)</option>
                </select>
                <p className="mt-2 text-xs text-slate-500">
                  Edge detection finds boundaries by contrast change, so it works whether
                  boundaries etch dark or bright (e.g. Barker&apos;s etched aluminium). Dark
                  threshold only suits dark-etched boundaries.
                </p>

                <label htmlFor="orientation" className="mt-4 block text-sm font-medium text-slate-300">
                  Test line orientation
                </label>
                <select
                  id="orientation"
                  value={orientation}
                  onChange={(e) => setOrientation(e.target.value)}
                  className={inputClasses}
                >
                  <option value="both">Horizontal + vertical (ASTM E112 recommended)</option>
                  <option value="horizontal">Horizontal only</option>
                  <option value="vertical">Vertical only</option>
                </select>
                <p className="mt-2 text-xs text-slate-500">
                  Combining directions averages over grain elongation; use a single direction to
                  probe anisotropy.
                </p>

                <label htmlFor="num-lines" className="mt-4 block text-sm font-medium text-slate-300">
                  {orientation === 'both' ? 'Lines per direction' : 'Number of lines'}:{' '}
                  <span className="text-teal-400">{numLines}</span>
                </label>
                <input
                  id="num-lines"
                  type="range"
                  min="3"
                  max="15"
                  value={numLines}
                  onChange={(e) => setNumLines(Number(e.target.value))}
                  className="mt-2 w-full accent-teal-500"
                />

                <label htmlFor="sensitivity" className="mt-4 block text-sm font-medium text-slate-300">
                  Detection sensitivity: <span className="text-teal-400">{sensitivity}</span>
                </label>
                <input
                  id="sensitivity"
                  type="range"
                  min="-40"
                  max="40"
                  value={sensitivity}
                  onChange={(e) => setSensitivity(Number(e.target.value))}
                  className="mt-2 w-full accent-teal-500"
                />
                <p className="mt-2 text-xs text-slate-500">
                  Raise if boundaries are being missed, lower if noise is counted as boundaries.
                </p>

                <label className="mt-4 flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={showBoundaries}
                    onChange={(e) => setShowBoundaries(e.target.checked)}
                    className="accent-teal-500"
                  />
                  Highlight detected boundaries
                </label>
              </section>

              <section className="rounded-xl border border-teal-500/30 bg-slate-900 p-5">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Results</h2>
                {mliMicrons ? (
                  <dl className="mt-3 space-y-3">
                    <div>
                      <dt className="text-xs text-slate-500">Mean linear intercept</dt>
                      <dd className="text-2xl font-bold text-teal-400">
                        {mliMicrons.toFixed(2)} <span className="text-base font-medium">µm</span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">ASTM grain size number (G)</dt>
                      <dd className="text-2xl font-bold text-white">{grainNumber.toFixed(1)}</dd>
                    </div>
                    {result.orientation === 'both' ? (
                      <>
                        <div className="flex justify-between border-t border-slate-800 pt-3 text-sm">
                          <dt className="text-slate-500">Intercepts (horizontal)</dt>
                          <dd className="text-slate-300">{result.directions.horizontal.intercepts}</dd>
                        </div>
                        <div className="flex justify-between text-sm">
                          <dt className="text-slate-500">Intercepts (vertical)</dt>
                          <dd className="text-slate-300">{result.directions.vertical.intercepts}</dd>
                        </div>
                        <div className="flex justify-between text-sm">
                          <dt className="text-slate-500">Intercepts (total)</dt>
                          <dd className="text-slate-300">{result.totalIntercepts}</dd>
                        </div>
                      </>
                    ) : (
                      <div className="flex justify-between border-t border-slate-800 pt-3 text-sm">
                        <dt className="text-slate-500">Intercepts counted</dt>
                        <dd className="text-slate-300">{result.totalIntercepts}</dd>
                      </div>
                    )}
                    <div className="flex justify-between text-sm">
                      <dt className="text-slate-500">Total line length</dt>
                      <dd className="text-slate-300">
                        {((result.totalLengthPx * micronsPerAnalysisPx) / 1000).toFixed(2)} mm
                      </dd>
                    </div>
                    {result.detail.threshold !== undefined ? (
                      <div className="flex justify-between text-sm">
                        <dt className="text-slate-500">Threshold used</dt>
                        <dd className="text-slate-300">{result.detail.threshold}</dd>
                      </div>
                    ) : (
                      <div className="flex justify-between text-sm">
                        <dt className="text-slate-500">Edge thresholds (low–high)</dt>
                        <dd className="text-slate-300">
                          {result.detail.lowThreshold}–{result.detail.highThreshold}
                        </dd>
                      </div>
                    )}
                    <div className="flex justify-between text-sm">
                      <dt className="text-slate-500">Scale source</dt>
                      <dd className="text-slate-300">
                        {calibrated ? 'Scale bar' : 'Magnification estimate'}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-3 text-sm text-amber-400">
                    No grain boundaries detected — try raising the detection sensitivity.
                  </p>
                )}
                <p className="mt-4 border-t border-slate-800 pt-3 text-xs leading-relaxed text-slate-500">
                  Results generated by GrainIQ are indicative and intended to support analysis. They
                  do not constitute certified measurement under ASTM E112 or ISO 643 and should not
                  be used as the sole basis for material certification without independent
                  verification.
                </p>
              </section>
            </aside>

            <section>
              <canvas
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                className={`h-auto max-w-full touch-none rounded-xl border ${
                  calibration.mode === 'drawing'
                    ? 'cursor-crosshair border-teal-500/60'
                    : 'border-slate-800'
                }`}
              />
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-500">
                <span>
                  <span className="font-semibold text-teal-400">—</span> test lines
                </span>
                <span>
                  <span className="font-semibold text-rose-400">|</span> grain boundary intercepts
                </span>
                {showBoundaries && (
                  <span>
                    <span className="font-semibold text-yellow-400">▒</span> detected boundaries
                  </span>
                )}
                {calibration.line && (
                  <span>
                    <span className="font-semibold text-slate-100">⊢⊣</span> scale bar measurement
                  </span>
                )}
                <span className="ml-auto text-teal-400/80">
                  Processed in your browser — never uploaded, never stored.
                </span>
              </div>
            </section>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            loadFile(e.target.files[0])
            e.target.value = ''
          }}
        />
      </main>

      {showUpgrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4">
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-8 text-center">
            <h2 className="text-lg font-semibold text-white">Free limit reached</h2>
            <p className="mt-2 text-sm text-slate-400">
              You&apos;ve used all {limit} free analyses this month. Upgrade to Pro for unlimited
              analyses — £89/month, cancel anytime.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                onClick={handleUpgrade}
                disabled={billingBusy}
                className="flex-1 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400 disabled:opacity-60"
              >
                {billingBusy ? 'Opening checkout…' : 'Upgrade to Pro'}
              </button>
              <button
                onClick={() => setShowUpgrade(false)}
                className={`flex-1 ${secondaryButtonClasses}`}
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
