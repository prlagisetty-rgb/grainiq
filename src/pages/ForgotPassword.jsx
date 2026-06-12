import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import AuthLayout from '../components/AuthLayout'

const inputClasses =
  'mt-1 block w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500'

export default function ForgotPassword() {
  const { resetPassword } = useAuth()
  const [email, setEmail] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  if (sent) {
    return (
      <AuthLayout
        title="Check your email"
        subtitle={`If an account exists for ${email}, we sent a password reset link.`}
      >
        <Link
          to="/login"
          className="block w-full rounded-md bg-teal-500 px-4 py-2 text-center text-sm font-semibold text-slate-950 shadow-sm hover:bg-teal-400"
        >
          Back to sign in
        </Link>
      </AuthLayout>
    )
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const { error: resetError } = await resetPassword(email)
    setSubmitting(false)

    if (resetError) {
      setError(resetError.message)
    } else {
      setSent(true)
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your account email and we'll send you a reset link."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-slate-300">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
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
          {submitting ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-400">
        Remembered it?{' '}
        <Link to="/login" className="font-medium text-teal-400 hover:text-teal-300">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  )
}
