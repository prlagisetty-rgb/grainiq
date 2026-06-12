import { supabase } from './supabase'

async function invokeForUrl(functionName) {
  const { data, error } = await supabase.functions.invoke(functionName, {
    body: { returnUrl: window.location.origin },
  })
  if (error) throw new Error('Billing request failed — please try again.')
  if (!data?.url) throw new Error(data?.error ?? 'Billing request failed — please try again.')
  return data.url
}

// Both redirect away from the app on success.
export async function startCheckout() {
  window.location.href = await invokeForUrl('create-checkout-session')
}

export async function openBillingPortal() {
  window.location.href = await invokeForUrl('create-portal-session')
}
