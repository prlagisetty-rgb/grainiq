import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Must match the limit in can_run_analysis() (supabase/migrations/0001).
export const FREE_MONTHLY_LIMIT = 15

// Calendar month in UTC, matching date_trunc('month', now()) on the server.
function monthStartIso() {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

export function useProfile() {
  const { user } = useAuth()
  const [tier, setTier] = useState(null)
  const [usage, setUsage] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!user) return null
    const [profileRes, countRes] = await Promise.all([
      supabase.from('profiles').select('tier').eq('id', user.id).single(),
      supabase
        .from('analyses')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', monthStartIso()),
    ])
    const fetchedTier = profileRes.data?.tier ?? 'free'
    setTier(fetchedTier)
    setUsage(countRes.count ?? 0)
    setLoading(false)
    return fetchedTier
  }, [user])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Inserts a usage row; RLS rejects it once a free user is over the limit,
  // so the count cannot be bypassed client-side. Returns false when blocked.
  const recordAnalysis = useCallback(
    async ({ mliMicrons, astmG }) => {
      if (!user) return false
      const { error } = await supabase.from('analyses').insert({
        user_id: user.id,
        mli_microns: mliMicrons,
        astm_g: astmG,
      })
      if (error) {
        await refresh()
        return false
      }
      setUsage((current) => (current ?? 0) + 1)
      return true
    },
    [user, refresh],
  )

  const isPro = tier === 'pro'
  const remaining = isPro ? Infinity : Math.max(0, FREE_MONTHLY_LIMIT - (usage ?? 0))

  return { tier, isPro, usage, remaining, limit: FREE_MONTHLY_LIMIT, loading, refresh, recordAnalysis }
}
