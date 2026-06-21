import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useProfile } from '../hooks/useProfile'
import { analyzeImage, astmGrainNumber } from '../lib/analysis'
import { startCheckout, openBillingPortal } from '../lib/billing'
import BetaBadge from '../components/BetaBadge'
import FeedbackModal from '../components/FeedbackModal'

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
    tier,
    isPro,
    betaProUntil,
    betaProActive,
    usage,
    remaining,
    limit,
    loading: profileLoading,
    refresh,
    recordAnalysis,
    submitFeedback,
  } = useProfile()
  const canvasRef = useRef(null)
  const fileInputRef = useRef(null)
  const draggingRef = useRef(false)
  const recordedRef = useRef(null)
  // What to do once feedback is submitted and beta Pro is granted — e.g. run the
  // export the user was gated on, or load the image they were blocked from.
  const afterFeedbackRef = useRef(null)

  const [billingBusy, setBillingBusy] = useState(false)
  const [billingError, setBillingError] = useState(null)
  const [checkoutPending, setCheckoutPending] = useState(false)
  const [exportError, setExportError] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)

  const [source, setSource] = useState(null) // { canvas, imageData, sampleScale, fileName, width, height }
  const [loadError, setLoadError] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  const [method, setMethod] = useState('threshold')
  const [orientation, setOrientation] = useState('both')
  const [magnification, setMagnification] = useState(100)
  const [scaleOverride, setScaleOverride] = useState(null)
  const [numLines, setNumLines] = useState(7)
  const [sensitivity, setSensitivity] = useState(0)
  const [showBoundaries, setShowBoundaries] = useState(true)

  // Manual intercept correction. correctionMode arms the canvas for click edits;
  // corrections is keyed by test-line index → { added, removed } positions in
  // the line's moving coordinate (x for horizontal lines, y for vertical).
  const [correctionMode, setCorrectionMode] = useState(false)
  const [corrections, setCorrections] = useState({})
  // Canvas zoom (CSS only — the attribute resolution is unchanged, and
  // toCanvasCoords maps via rect.width, so clicks stay accurate at any zoom).
  const [zoom, setZoom] = useState(1)

  // Scale bar calibration: mode 'idle' | 'drawing' | 'measured'
  const [calibration, setCalibration] = useState({ mode: 'idle', line: null, realMicrons: '' })
  const [calibrated, setCalibrated] = useState(null) // { realMicrons, lengthPx }

  // µm per pixel of the original image. Until calibrated from the scale bar,
  // falls back to a rule-of-thumb estimate from magnification (1 µm/px at 100x).
  const scale = scaleOverride ?? (magnification > 0 ? 100 / magnification : 1)

  // Open the feedback form; `after` runs once it's submitted and beta Pro is
  // granted. This is the single route to Pro during the beta — both the export
  // gate and the monthly-limit block funnel through it.
  function requestFeedback(after) {
    afterFeedbackRef.current = after || null
    setExportError(null)
    setShowFeedback(true)
  }

  async function loadFile(file, bypassLimit = false) {
    setLoadError(null)
    if (!file) return
    if (!bypassLimit && !profileLoading && !isPro && remaining <= 0) {
      requestFeedback(() => loadFile(file, true))
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

  // Line geometry is meaningless once a fresh analysis moves the lines, so drop
  // any corrections whenever the automated result changes.
  useEffect(() => {
    setCorrections({})
  }, [result])

  // The automated result with user corrections layered on. Per line we keep the
  // auto intercepts the user didn't remove, plus the ones they added; the grain
  // size is recomputed from the corrected total so edits update results live.
  const corrected = useMemo(() => {
    if (!result) return null
    const directions = {}
    let total = 0
    let addedCount = 0
    let removedCount = 0
    const lines = result.lines.map((line, i) => {
      const c = corrections[i]
      const autoKept = c ? line.intercepts.filter((p) => !c.removed.includes(p)) : line.intercepts
      const added = c ? c.added : []
      addedCount += added.length
      removedCount += c ? c.removed.length : 0
      const count = autoKept.length + added.length
      total += count
      directions[line.orientation] = (directions[line.orientation] ?? 0) + count
      return { ...line, autoKept, added, count }
    })
    return {
      lines,
      directions,
      total,
      mliPx: total > 0 ? result.totalLengthPx / total : null,
      addedCount,
      removedCount,
      edits: addedCount + removedCount,
      automatedTotal: result.totalIntercepts,
    }
  }, [result, corrections])

  // µm represented by one pixel of the (possibly downscaled) analysis image.
  const micronsPerAnalysisPx = source ? scale * source.sampleScale : null
  const mliMicrons = corrected?.mliPx ? corrected.mliPx * micronsPerAnalysisPx : null
  const grainNumber = astmGrainNumber(mliMicrons)

  // One analysis = one image loaded; parameter tweaks on the same image are
  // free. Record the AUTOMATED result (manual corrections are a user overlay,
  // not a separate analysis) on the first computed result for each new source.
  useEffect(() => {
    if (!source || !result || recordedRef.current === source) return
    recordedRef.current = source
    const automatedMli = result.mliPx ? result.mliPx * micronsPerAnalysisPx : null
    recordAnalysis({ mliMicrons: automatedMli, astmG: astmGrainNumber(automatedMli) }).then((ok) => {
      // Server rejected the usage row (over the monthly limit) — route to the
      // feedback gate so they can unlock beta Pro and keep going.
      if (!ok) requestFeedback(null)
    })
  }, [source, result, micronsPerAnalysisPx, recordAnalysis])

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
    const drawTick = (line, p, horizontal) => {
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
    for (const line of corrected.lines) {
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

      // Automated intercepts (rose) and user-added intercepts (emerald). When
      // correcting, ticks are drawn thicker so they're easier to aim at.
      ctx.lineWidth = correctionMode ? lineWidth * 1.5 : lineWidth
      ctx.strokeStyle = '#fb7185'
      for (const p of line.autoKept) drawTick(line, p, horizontal)
      ctx.strokeStyle = '#34d399'
      for (const p of line.added) drawTick(line, p, horizontal)
      ctx.lineWidth = lineWidth
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
  }, [source, result, corrected, correctionMode, showBoundaries, calibration.line])

  function toCanvasCoords(e) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  // Click on (or near) a test line: remove the nearest intercept if the click
  // lands on one, otherwise add a new intercept at that point on the line.
  function handleCorrectionClick(p) {
    if (!result) return
    const tick = Math.max(6, source.width / 240)
    const alongTol = Math.max(8, tick * 2) // how close to a tick counts as "on" it

    // Smallest gap between adjacent lines of an orientation — used to size the
    // catch band so a click is assigned to the nearest line with no dead zone
    // between lines, but a click clearly on one line of a close pair still wins.
    const minSpacing = (orient) => {
      const coords = result.lines
        .filter((l) => l.orientation === orient)
        .map((l) => (orient === 'horizontal' ? l.y : l.x))
        .sort((a, b) => a - b)
      let m = Infinity
      for (let k = 1; k < coords.length; k++) m = Math.min(m, coords[k] - coords[k - 1])
      return m
    }

    let best = null
    result.lines.forEach((line, i) => {
      const horizontal = line.orientation === 'horizontal'
      const perp = horizontal ? Math.abs(p.y - line.y) : Math.abs(p.x - line.x)
      const along = horizontal ? p.x : p.y
      const lo = horizontal ? line.x1 : line.y1
      const hi = horizontal ? line.x2 : line.y2
      const spacing = minSpacing(line.orientation)
      // Cover the gap to the next line (0.6×spacing) but never less than tick·3.
      const perpTol = Number.isFinite(spacing) ? Math.max(tick * 3, spacing * 0.6) : tick * 3
      if (perp <= perpTol && along >= lo - 2 && along <= hi + 2 && (!best || perp < best.perp)) {
        best = { i, line, along, perp }
      }
    })
    if (!best) return

    const { i, line, along } = best
    setCorrections((prev) => {
      const existing = prev[i] || { added: [], removed: [] }
      const c = { added: [...existing.added], removed: [...existing.removed] }
      const autoKept = line.intercepts.filter((pos) => !c.removed.includes(pos))

      let nearest = null
      for (const pos of autoKept) {
        const d = Math.abs(pos - along)
        if (d <= alongTol && (!nearest || d < nearest.d)) nearest = { pos, type: 'auto', d }
      }
      for (const pos of c.added) {
        const d = Math.abs(pos - along)
        if (d <= alongTol && (!nearest || d < nearest.d)) nearest = { pos, type: 'added', d }
      }

      if (nearest) {
        // Click landed on an existing marker → remove it (false positive).
        if (nearest.type === 'added') c.added = c.added.filter((pos) => pos !== nearest.pos)
        else c.removed.push(nearest.pos)
      } else {
        // Empty stretch → add a missed intercept here.
        c.added.push(Math.round(along))
      }
      return { ...prev, [i]: c }
    })
  }

  function handlePointerDown(e) {
    if (correctionMode && calibration.mode !== 'drawing') {
      handleCorrectionClick(toCanvasCoords(e))
      return
    }
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

  // PDF export is gated behind beta feedback for non-Pro users. handleExport
  // opens the feedback form; runExport does the actual generation. proOverride
  // lets a just-granted user export unwatermarked without waiting for the
  // profile refresh to land in state.
  function handleExport() {
    if (!result || mliMicrons == null) return
    if (!isPro) {
      requestFeedback(() => runExport(true))
      return
    }
    runExport()
  }

  async function runExport(proOverride) {
    setExportError(null)
    const canvas = canvasRef.current
    if (!canvas || !result || mliMicrons == null) return
    setExporting(true)
    try {
      // Lazy-load so jsPDF (~150 kB) stays out of the initial bundle.
      const { downloadReportPdf } = await import('../lib/report')
      downloadReportPdf({
        fileName: source.fileName,
        imageDataUrl: canvas.toDataURL('image/png'),
        imageWidth: source.width,
        imageHeight: source.height,
        method: result.method,
        orientation: result.orientation,
        numLines,
        sensitivity,
        mliMicrons,
        grainNumber,
        totalIntercepts: corrected.total,
        directions:
          result.orientation === 'both'
            ? {
                horizontal: { intercepts: corrected.directions.horizontal ?? 0 },
                vertical: { intercepts: corrected.directions.vertical ?? 0 },
              }
            : null,
        automatedIntercepts: corrected.automatedTotal,
        manualAdded: corrected.addedCount,
        manualRemoved: corrected.removedCount,
        manualEdits: corrected.edits,
        totalLengthMm: (result.totalLengthPx * micronsPerAnalysisPx) / 1000,
        detail: result.detail,
        scale,
        scaleSource: calibrated ? 'Scale bar calibration' : 'Magnification estimate',
        calibrated,
        magnification,
        isPro: proOverride ?? isPro,
        analyst: user?.email ?? '',
      })
    } catch (err) {
      console.error(err)
      setExportError('Could not generate the PDF. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-900">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-white">
              Grain<span className="text-teal-400">IQ</span>
            </h1>
            <BetaBadge />
          </div>
          <div className="flex items-center gap-4">
            {checkoutPending ? (
              <span className="text-sm text-teal-400">Finalising upgrade…</span>
            ) : (
              !profileLoading &&
              (tier === 'pro' ? (
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
              ) : betaProActive ? (
                <span className="rounded-full bg-teal-500/15 px-2.5 py-0.5 text-xs font-semibold text-teal-400">
                  Beta Pro · until{' '}
                  {new Date(betaProUntil).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                  })}
                </span>
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
              GrainIQ is in beta — share a little feedback to unlock 30 days of unlimited analyses.
            </p>
            <button
              onClick={() => requestFeedback(null)}
              className="mt-6 rounded-md bg-teal-500 px-6 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400"
            >
              Give feedback &amp; unlock
            </button>
            <p className="mt-4 text-xs text-slate-500">
              Or your free allowance resets on the 1st of each month.
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
                  <option value="threshold">Dark threshold — recommended</option>
                  <option value="watershed">Watershed segmentation</option>
                  <option value="canny">Edge detection (Canny)</option>
                </select>
                <p className="mt-2 text-xs text-slate-500">
                  Choose the method that best matches your micrograph. Dark threshold suits most
                  samples with dark etched boundaries; switch to watershed or Canny for the cases
                  below.
                </p>
                <dl className="mt-2 space-y-1 text-xs text-slate-500">
                  <div>
                    <dt className="inline font-medium text-slate-400">Dark threshold</dt>
                    <dd className="inline"> — recommended for most samples with dark etched boundaries.</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-slate-400">Watershed</dt>
                    <dd className="inline"> — best for large clear grain structures with thick boundaries.</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium text-slate-400">Canny</dt>
                    <dd className="inline"> — best for variable contrast or Barker&apos;s etched samples.</dd>
                  </div>
                </dl>

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
                          <dd className="text-slate-300">{corrected.directions.horizontal ?? 0}</dd>
                        </div>
                        <div className="flex justify-between text-sm">
                          <dt className="text-slate-500">Intercepts (vertical)</dt>
                          <dd className="text-slate-300">{corrected.directions.vertical ?? 0}</dd>
                        </div>
                        <div className="flex justify-between text-sm">
                          <dt className="text-slate-500">Intercepts (total)</dt>
                          <dd className="text-slate-300">{corrected.total}</dd>
                        </div>
                      </>
                    ) : (
                      <div className="flex justify-between border-t border-slate-800 pt-3 text-sm">
                        <dt className="text-slate-500">Intercepts counted</dt>
                        <dd className="text-slate-300">{corrected.total}</dd>
                      </div>
                    )}
                    {corrected.edits > 0 && (
                      <>
                        <div className="flex justify-between text-sm">
                          <dt className="text-slate-500">Automated count</dt>
                          <dd className="text-slate-400">{corrected.automatedTotal}</dd>
                        </div>
                        <div className="flex justify-between text-sm">
                          <dt className="text-emerald-400">Manual corrections</dt>
                          <dd className="text-emerald-400">
                            +{corrected.addedCount} / −{corrected.removedCount}
                          </dd>
                        </div>
                      </>
                    )}
                    <div className="flex justify-between text-sm">
                      <dt className="text-slate-500">Total line length</dt>
                      <dd className="text-slate-300">
                        {((result.totalLengthPx * micronsPerAnalysisPx) / 1000).toFixed(2)} mm
                      </dd>
                    </div>
                    {result.detail.grains !== undefined ? (
                      <>
                        <div className="flex justify-between text-sm">
                          <dt className="text-slate-500">Grains segmented</dt>
                          <dd className="text-slate-300">{result.detail.grains}</dd>
                        </div>
                        <div className="flex justify-between text-sm">
                          <dt className="text-slate-500">Threshold ({result.detail.polarity} boundaries)</dt>
                          <dd className="text-slate-300">{result.detail.threshold}</dd>
                        </div>
                      </>
                    ) : result.detail.threshold !== undefined ? (
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
                    No grain boundaries detected — try raising the detection sensitivity, or add
                    intercepts manually below.
                  </p>
                )}

                {result && (
                  <div className="mt-4 border-t border-slate-800 pt-3">
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => setCorrectionMode((m) => !m)}
                        className={
                          correctionMode
                            ? 'rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-emerald-400'
                            : secondaryButtonClasses
                        }
                      >
                        {correctionMode ? 'Done correcting' : 'Adjust intercepts'}
                      </button>
                      {corrected.edits > 0 && (
                        <button
                          onClick={() => setCorrections({})}
                          className="text-xs font-medium text-slate-400 underline hover:text-slate-300"
                        >
                          Reset corrections
                        </button>
                      )}
                    </div>
                    {correctionMode && (
                      <p className="mt-2 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                        Click an empty spot on a test line to add a missed intercept, or click an
                        existing tick to remove a false positive. The grain size updates instantly.
                      </p>
                    )}
                  </div>
                )}

                <button
                  onClick={handleExport}
                  disabled={mliMicrons == null || exporting}
                  className="mt-4 w-full rounded-md bg-teal-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {exporting
                    ? 'Generating…'
                    : isPro
                      ? 'Export report (PDF)'
                      : 'Export report (PDF) — quick feedback first'}
                </button>
                {!isPro && mliMicrons != null && (
                  <p className="mt-1.5 text-center text-xs text-slate-500">
                    Beta: answer a few questions to unlock the report and 30 days of unlimited
                    analyses.
                  </p>
                )}
                {exportError && (
                  <p role="alert" className="mt-2 rounded-md bg-red-950/60 px-3 py-2 text-xs text-red-400">
                    {exportError}
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
              <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
                <span className="font-medium">Zoom</span>
                <button
                  onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.5) * 10) / 10))}
                  disabled={zoom <= 1}
                  className="rounded border border-slate-700 px-2 py-0.5 text-sm leading-none hover:bg-slate-800 disabled:opacity-40"
                  aria-label="Zoom out"
                >
                  −
                </button>
                <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
                <button
                  onClick={() => setZoom((z) => Math.min(5, Math.round((z + 0.5) * 10) / 10))}
                  disabled={zoom >= 5}
                  className="rounded border border-slate-700 px-2 py-0.5 text-sm leading-none hover:bg-slate-800 disabled:opacity-40"
                  aria-label="Zoom in"
                >
                  +
                </button>
                {zoom !== 1 && (
                  <button onClick={() => setZoom(1)} className="underline hover:text-slate-200">
                    Reset
                  </button>
                )}
                {correctionMode && (
                  <span className="text-slate-500">
                    Zoom in to place intercepts on closely-spaced lines.
                  </span>
                )}
              </div>
              <div
                className={`max-h-[75vh] overflow-auto rounded-xl border ${
                  calibration.mode === 'drawing'
                    ? 'border-teal-500/60'
                    : correctionMode
                      ? 'border-emerald-500/60'
                      : 'border-slate-800'
                }`}
              >
                <canvas
                  ref={canvasRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  style={{ width: `${zoom * 100}%` }}
                  className={`block h-auto touch-none ${
                    calibration.mode === 'drawing'
                      ? 'cursor-crosshair'
                      : correctionMode
                        ? 'cursor-pointer'
                        : ''
                  }`}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-500">
                <span>
                  <span className="font-semibold text-teal-400">—</span> test lines
                </span>
                <span>
                  <span className="font-semibold text-rose-400">|</span> grain boundary intercepts
                </span>
                {corrected?.addedCount > 0 && (
                  <span>
                    <span className="font-semibold text-emerald-400">|</span> manually added
                  </span>
                )}
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


      {showFeedback && (
        <FeedbackModal
          submitFeedback={submitFeedback}
          context={{ method: result?.method, mliMicrons, astmG: grainNumber }}
          onClose={() => setShowFeedback(false)}
          onSuccess={() => {
            setShowFeedback(false)
            const after = afterFeedbackRef.current
            afterFeedbackRef.current = null
            if (after) after()
          }}
        />
      )}
    </div>
  )
}
