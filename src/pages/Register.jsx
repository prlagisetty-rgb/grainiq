import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import AuthLayout from '../components/AuthLayout'

const inputClasses =
  'mt-1 block w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500'

export default function Register() {
  const { session, signUp } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)

  if (session) {
    return <Navigate to="/" replace />
  }

  if (awaitingConfirmation) {
    return (
      <AuthLayout title="Check your email" subtitle={`We sent a confirmation link to ${email}.`}>
        <p className="text-sm text-slate-300">
          Click the link in the email to activate your account, then sign in.
        </p>
        <Link
          to="/login"
          className="mt-6 block w-full rounded-md bg-teal-500 px-4 py-2 text-center text-sm font-semibold text-slate-950 shadow-sm hover:bg-teal-400"
        >
          Go to sign in
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
    const { data, error: signUpError } = await signUp(email, password)
    setSubmitting(false)

    if (signUpError) {
      setError(signUpError.message)
    } else if (data.session) {
      navigate('/')
    } else {
      setAwaitingConfirmation(true)
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Free tier includes 15 analyses per month. No card required."
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

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-slate-300">
            Password
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
            Confirm password
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
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-400">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-teal-400 hover:text-teal-300">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  )
}
