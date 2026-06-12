// Creates a Stripe Checkout session for the Pro subscription.
// Requires secrets: STRIPE_SECRET_KEY, STRIPE_PRICE_ID_PRO

import Stripe from 'npm:stripe@18'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
    )
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return json({ error: 'Not authenticated' }, 401)

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('stripe_customer_id, tier')
      .eq('id', user.id)
      .single()
    if (profileError) {
      console.error(`profiles select failed (${user.id}):`, profileError.message)
      return json({ error: 'Could not load billing profile' }, 500)
    }

    if (profile.tier === 'pro') return json({ error: 'Already subscribed' }, 400)

    let customerId = profile.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      })
      customerId = customer.id
      const { error: saveError } = await admin
        .from('profiles')
        .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
        .eq('id', user.id)
      // Don't abort checkout — the webhook also writes the customer id on
      // checkout.session.completed — but make the failure visible in logs.
      if (saveError) {
        console.error(`stripe_customer_id save failed (${user.id}):`, saveError.message)
      }
    }

    const { returnUrl } = await req.json()
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: Deno.env.get('STRIPE_PRICE_ID_PRO')!, quantity: 1 }],
      success_url: `${returnUrl}?checkout=success`,
      cancel_url: `${returnUrl}?checkout=cancelled`,
      metadata: { supabase_user_id: user.id },
    })

    return json({ url: session.url })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Checkout failed' }, 500)
  }
})
