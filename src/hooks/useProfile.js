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
  const [betaProUntil, setBetaProUntil] = useState(null)
  const [usage, setUsage] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!user) return null
    const [profileRes, countRes] = await Promise.all([
      supabase.from('profiles').select('tier, beta_pro_until').eq('id', user.id).single(),
      supabase
        .from('analyses')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', monthStartIso()),
    ])
    const fetchedTier = profileRes.data?.tier ?? 'free'
    setTier(fetchedTier)
    setBetaProUntil(profileRes.data?.beta_pro_until ?? null)
    setUsage(countRes.count ?? 0)
    setLoading(false)
    return fetchedTier
  }, [user])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Record beta feedback; the RPC grants 30 days of Pro and returns the new
  // expiry. Refresh so isPro/remaining reflect the grant immediately.
  const submitFeedback = useCallback(
    async (f) => {
      if (!user) return { ok: false, error: 'Not signed in.' }
      const { data, error } = await supabase.rpc('submit_feedback', {
        p_user_type: f.userType,
        p_material: f.material ?? null,
        p_accuracy: f.accuracy,
        p_improvement: f.improvement ?? null,
        p_would_pay: f.wouldPay,
        p_pay_amount: f.payAmount ?? null,
        p_method: f.method ?? null,
        p_mli_microns: f.mliMicrons ?? null,
        p_astm_g: f.astmG ?? null,
      })
      if (error) return { ok: false, error: error.message }
      await refresh()
      return { ok: true, until: data }
    },
    [user, refresh],
  )

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

  const betaProActive = betaProUntil ? new Date(betaProUntil) > new Date() : false
  const isPro = tier === 'pro' || betaProActive
  const remaining = isPro ? Infinity : Math.max(0, FREE_MONTHLY_LIMIT - (usage ?? 0))

  return {
    tier,
    isPro,
    betaProUntil,
    betaProActive,
    usage,
    remaining,
    limit: FREE_MONTHLY_LIMIT,
    loading,
    refresh,
    recordAnalysis,
    submitFeedback,
  }
}
