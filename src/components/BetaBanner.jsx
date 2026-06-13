import { useState } from 'react'

// Dismissed state is held in sessionStorage so the banner stays hidden across
// route changes and reloads within the same browser session, then returns for a
// fresh session.
const STORAGE_KEY = 'grainiq-beta-dismissed'

// Slim amber notice pinned above all pages while GrainIQ is in beta.
export default function BetaBanner() {
  const [dismissed, setDismissed] = useState(
    () => typeof window !== 'undefined' && window.sessionStorage.getItem(STORAGE_KEY) === '1',
  )

  if (dismissed) return null

  function dismiss() {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // sessionStorage can throw in private mode — still dismiss for this session.
    }
    setDismissed(true)
  }

  return (
    <div className="relative bg-amber-400 text-amber-950">
      <p className="mx-auto max-w-7xl px-10 py-2 text-center text-sm font-medium">
        GrainIQ is currently in beta. Detection accuracy is actively being improved. We&apos;d love
        your feedback — contact us at{' '}
        <a
          href="mailto:feedback@grainiq.co.uk"
          className="font-semibold underline underline-offset-2 hover:text-amber-900"
        >
          feedback@grainiq.co.uk
        </a>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss beta notice"
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-amber-950/70 transition-colors hover:bg-amber-500/40 hover:text-amber-950"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
