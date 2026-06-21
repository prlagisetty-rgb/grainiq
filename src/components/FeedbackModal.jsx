import { useState } from 'react'

// Feedback gate shown before a free user's first PDF export. On submit it calls
// submitFeedback (which records the response and grants 30 days of beta Pro),
// then onSuccess proceeds to the export.

const USER_TYPES = [
  { value: 'student', label: 'Student' },
  { value: 'individual', label: 'Individual' },
  { value: 'small_business', label: 'Small business' },
  { value: 'large_organisation', label: 'Large organisation' },
]

const inputClasses =
  'mt-1 block w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500'

export default function FeedbackModal({ onClose, onSuccess, submitFeedback, context }) {
  const [userType, setUserType] = useState('')
  const [material, setMaterial] = useState('')
  const [accuracy, setAccuracy] = useState(0)
  const [hoverStar, setHoverStar] = useState(0)
  const [improvement, setImprovement] = useState('')
  const [wouldPay, setWouldPay] = useState(null) // true | false | null
  const [payAmount, setPayAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const valid =
    userType &&
    material.trim() &&
    accuracy >= 1 &&
    wouldPay !== null &&
    (!wouldPay || Number(payAmount) > 0)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!valid || submitting) return
    setSubmitting(true)
    setError(null)
    const { ok, error: err } = await submitFeedback({
      userType,
      material: material.trim(),
      accuracy,
      improvement: improvement.trim() || null,
      wouldPay,
      payAmount: wouldPay ? Number(payAmount) : null,
      method: context?.method ?? null,
      mliMicrons: context?.mliMicrons ?? null,
      astmG: context?.astmG ?? null,
    })
    if (!ok) {
      setError(err || 'Could not submit feedback. Please try again.')
      setSubmitting(false)
      return
    }
    onSuccess()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-8">
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="text-lg font-semibold text-white">A quick question before you export</h2>
        <p className="mt-1 text-sm text-slate-400">
          GrainIQ is in beta. Share your feedback and we&apos;ll unlock{' '}
          <span className="font-semibold text-teal-400">30 days of unlimited analyses</span>.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-5">
          {/* 1. User type */}
          <div>
            <label className="block text-sm font-medium text-slate-300">Which best describes you?</label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {USER_TYPES.map((t) => (
                <button
                  type="button"
                  key={t.value}
                  onClick={() => setUserType(t.value)}
                  className={`rounded-md border px-3 py-2 text-sm ${
                    userType === t.value
                      ? 'border-teal-500 bg-teal-500/10 text-teal-300'
                      : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* 2. Material and etching */}
          <div>
            <label htmlFor="fb-material" className="block text-sm font-medium text-slate-300">
              Material and etching method used
            </label>
            <input
              id="fb-material"
              type="text"
              value={material}
              onChange={(e) => setMaterial(e.target.value)}
              placeholder="e.g. low-carbon steel, 2% nital"
              className={inputClasses}
            />
          </div>

          {/* 3. Accuracy rating */}
          <div>
            <label className="block text-sm font-medium text-slate-300">
              How accurate was the detection?
            </label>
            <div className="mt-2 flex items-center gap-1" onMouseLeave={() => setHoverStar(0)}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  type="button"
                  key={n}
                  onClick={() => setAccuracy(n)}
                  onMouseEnter={() => setHoverStar(n)}
                  aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  className={`text-2xl leading-none ${
                    n <= (hoverStar || accuracy) ? 'text-amber-400' : 'text-slate-600'
                  }`}
                >
                  ★
                </button>
              ))}
              {accuracy > 0 && <span className="ml-2 text-xs text-slate-500">{accuracy}/5</span>}
            </div>
          </div>

          {/* 4. What would improve it */}
          <div>
            <label htmlFor="fb-improve" className="block text-sm font-medium text-slate-300">
              What would improve it? <span className="text-slate-500">(optional)</span>
            </label>
            <textarea
              id="fb-improve"
              rows={3}
              value={improvement}
              onChange={(e) => setImprovement(e.target.value)}
              className={inputClasses}
            />
          </div>

          {/* 5. Would you pay + how much */}
          <div>
            <label className="block text-sm font-medium text-slate-300">
              Would you pay for unlimited analyses?
            </label>
            <div className="mt-2 flex gap-2">
              {[
                { v: true, label: 'Yes' },
                { v: false, label: 'No' },
              ].map((o) => (
                <button
                  type="button"
                  key={o.label}
                  onClick={() => setWouldPay(o.v)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                    wouldPay === o.v
                      ? 'border-teal-500 bg-teal-500/10 text-teal-300'
                      : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            {wouldPay && (
              <div className="mt-3">
                <label htmlFor="fb-amount" className="block text-sm font-medium text-slate-300">
                  How much per month? (£)
                </label>
                <input
                  id="fb-amount"
                  type="number"
                  min="1"
                  step="any"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder="e.g. 89"
                  className={inputClasses}
                />
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-red-950/60 px-3 py-2 text-sm text-red-400">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={!valid || submitting}
              className="flex-1 rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : 'Submit & unlock export'}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
