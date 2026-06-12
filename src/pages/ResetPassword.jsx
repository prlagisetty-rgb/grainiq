import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import AuthLayout from '../components/AuthLayout'

const inputClasses =
  'mt-1 block w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500'

export default function ResetPassword() {
  const { session, updatePassword } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [linkTimedOut, setLinkTimedOut] = useState(false)

  // The recovery link signs the user in via URL tokens, which supabase-js
  // processes asynchronously after page load — give it a few seconds before
  // declaring the link dead.
  useEffect(() => {
    const timer = setTimeout(() => setLinkTimedOut(true), 4000)
    return () => clearTimeout(timer)
  }, [])

  if (!session) {
    if (!linkTimedOut) {
      return (
        <AuthLayout title="Verifying reset link…" subtitle="One moment.">
          <p className="text-sm text-slate-400">Checking your password reset link.</p>
        </AuthLayout>
      )
    }
    return (
      <AuthLayout
        title="Link invalid or expired"
        subtitle="Password reset links only work once and expire after a short time."
      >
        <Link
          to="/forgot-password"
          className="block w-full rounded-md bg-teal-500 px-4 py-2 text-center text-sm font-semibold text-slate-950 shadow-sm hover:bg-teal-400"
        >
          Request a new link
        </Link>
      </AuthLayout>
    )
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    const { error: updateError } = await updatePassword(password)
    setSubmitting(false)

    if (updateError) {
      setError(updateError.message)
    } else {
      navigate('/')
    }
  }

  return (
    <AuthLayout title="Set a new password" subtitle="Choose a new password for your account.">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="password" className="block text-sm font-medium text-slate-300">
            New password
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClasses}
          />
          <p className="mt-1 text-xs text-slate-500">At least 8 characters</p>
        </div>

        <div>
          <label htmlFor="confirm-password" className="block text-sm font-medium text-slate-300">
            Confirm new password
          </label>
          <input
            id="confirm-password"
            type="password"
            required
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={inputClasses}
          />
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-red-950/60 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-teal-500 px-4 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </AuthLayout>
  )
}
