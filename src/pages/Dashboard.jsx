import { useAuth } from '../context/AuthContext'

export default function Dashboard() {
  const { user, signOut } = useAuth()

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            Grain<span className="text-blue-600">IQ</span>
          </h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-500">{user?.email}</span>
            <button
              onClick={signOut}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-12">
        <div className="rounded-xl border-2 border-dashed border-slate-300 bg-white p-12 text-center">
          <h2 className="text-lg font-semibold text-slate-900">Analysis tool coming soon</h2>
          <p className="mt-2 text-sm text-slate-500">
            Upload a micrograph, get mean linear intercept grain size and ASTM grain number in
            under a minute.
          </p>
        </div>
      </main>
    </div>
  )
}
