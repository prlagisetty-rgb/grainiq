// Stripe webhook: keeps profiles.tier in sync with subscription state.
// Deploy with --no-verify-jwt (Stripe authenticates via signature, not Supabase JWT).
// Requires secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// Subscribed events: checkout.session.completed, customer.subscription.updated,
//                    customer.subscription.deleted

import Stripe from 'npm:stripe@18'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!)
const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  const body = await req.text()

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature!,
      Deno.env.get('STRIPE_WEBHOOK_SECRET')!,
    )
  } catch {
    return new Response('Webhook signature verification failed', { status: 400 })
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.supabase_user_id
      if (userId && session.mode === 'subscription') {
        await admin
          .from('profiles')
          .update({
            tier: 'pro',
            stripe_subscription_id: session.subscription as string,
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId)
      }
      break
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      const active =
        event.type !== 'customer.subscription.deleted' &&
        (sub.status === 'active' || sub.status === 'trialing')
      await admin
        .from('profiles')
        .update({
          tier: active ? 'pro' : 'free',
          stripe_subscription_id: active ? sub.id : null,
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_customer_id', sub.customer as string)
      break
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
