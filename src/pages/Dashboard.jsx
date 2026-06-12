import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { analyzeImage, astmGrainNumber } from '../lib/analysis'

const MAX_ANALYSIS_DIMENSION = 2400

const inputClasses =
  'mt-1 block w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500'

export default function Dashboard() {
  const { user, signOut } = useAuth()
  const canvasRef = useRef(null)
  const fileInputRef = useRef(null)

  const [source, setSource] = useState(null) // { canvas, imageData, sampleScale, fileName, width, height }
  const [loadError, setLoadError] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  const [magnification, setMagnification] = useState(100)
  const [scaleOverride, setScaleOverride] = useState(null)
  const [numLines, setNumLines] = useState(7)
  const [sensitivity, setSensitivity] = useState(0)

  // µm per pixel of the original image. Rule-of-thumb default (1 µm/px at 100x)
  // until scale bar calibration ships in V2 — always editable.
  const scale = scaleOverride ?? (magnification > 0 ? 100 / magnification : 1)

  async function loadFile(file) {
    setLoadError(null)
    if (!file) return
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
    () => (source ? analyzeImage(source.imageData, { numLines, sensitivity }) : null),
    [source, numLines, sensitivity],
  )

  // µm represented by one pixel of the (possibly downscaled) analysis image.
  const micronsPerAnalysisPx = source ? scale * source.sampleScale : null
  const mliMicrons = result?.mliPx ? result.mliPx * micronsPerAnalysisPx : null
  const grainNumber = astmGrainNumber(mliMicrons)

  useEffect(() => {
    if (!source || !result) return
    const canvas = canvasRef.current
    canvas.width = source.width
    canvas.height = source.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(source.canvas, 0, 0)

    const lineWidth = Math.max(1.5, source.width / 900)
    ctx.lineWidth = lineWidth
    for (const line of result.lines) {
      ctx.strokeStyle = '#2dd4bf'
      ctx.beginPath()
      ctx.moveTo(line.x1, line.y)
      ctx.lineTo(line.x2, line.y)
      ctx.stroke()

      ctx.strokeStyle = '#fb7185'
      const tick = Math.max(6, source.width / 240)
      for (const x of line.intercepts) {
        ctx.beginPath()
        ctx.moveTo(x, line.y - tick)
        ctx.lineTo(x, line.y + tick)
        ctx.stroke()
      }
    }
  }, [source, result])

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-900">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
          <h1 className="text-xl font-bold tracking-tight text-white">
            Grain<span className="text-teal-400">IQ</span>
          </h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-400">{user?.email}</span>
            <button
              onClick={signOut}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-300 hover:bg-slate-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8">
        {!source ? (
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
                  className="mt-3 w-full rounded-md border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-300 hover:bg-slate-800"
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
                <label htmlFor="magnification" className="mt-3 block text-sm font-medium text-slate-300">
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
                  Auto-estimated from magnification (assumes 1 µm/px at 100×). Override with your
                  microscope&apos;s calibrated value for accurate results.
                </p>
              </section>

              <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Test lines
                </h2>
                <label htmlFor="num-lines" className="mt-3 block text-sm font-medium text-slate-300">
                  Number of lines: <span className="text-teal-400">{numLines}</span>
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
                    <div className="flex justify-between border-t border-slate-800 pt-3 text-sm">
                      <dt className="text-slate-500">Intercepts counted</dt>
                      <dd className="text-slate-300">{result.totalIntercepts}</dd>
                    </div>
                    <div className="flex justify-between text-sm">
                      <dt className="text-slate-500">Total line length</dt>
                      <dd className="text-slate-300">
                        {((result.totalLengthPx * micronsPerAnalysisPx) / 1000).toFixed(2)} mm
                      </dd>
                    </div>
                    <div className="flex justify-between text-sm">
                      <dt className="text-slate-500">Threshold used</dt>
                      <dd className="text-slate-300">{result.threshold}</dd>
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
                className="h-auto max-w-full rounded-xl border border-slate-800"
              />
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-500">
                <span>
                  <span className="font-semibold text-teal-400">—</span> test lines
                </span>
                <span>
                  <span className="font-semibold text-rose-400">|</span> grain boundary intercepts
                </span>
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
    </div>
  )
}
