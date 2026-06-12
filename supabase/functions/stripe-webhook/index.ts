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

  // A failed tier update must return 5xx so Stripe retries the event.
  async function applyUpdate(
    values: Record<string, unknown>,
    column: string,
    match: string,
  ): Promise<Response | null> {
    const { data, error } = await admin
      .from('profiles')
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq(column, match)
      .select('id')
    if (error) {
      console.error(`profiles update failed (${event.type}, ${column}=${match}):`, error.message)
      return new Response('Profile update failed', { status: 500 })
    }
    if (!data || data.length === 0) {
      console.error(`profiles update matched no rows (${event.type}, ${column}=${match})`)
      return new Response('Profile not found', { status: 500 })
    }
    console.log(`profiles updated (${event.type}, ${column}=${match}):`, JSON.stringify(values))
    return null
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.supabase_user_id
      if (userId && session.mode === 'subscription') {
        const failure = await applyUpdate(
          {
            tier: 'pro',
            stripe_customer_id: session.customer as string,
            stripe_subscription_id: session.subscription as string,
          },
          'id',
          userId,
        )
        if (failure) return failure
      }
      break
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription
      // 'incomplete' is a transient pre-payment state: a subscription.updated
      // event carrying it can arrive after checkout.session.completed and must
      // not downgrade a freshly upgraded account.
      if (event.type === 'customer.subscription.updated' && sub.status === 'incomplete') break
      const active =
        event.type !== 'customer.subscription.deleted' &&
        (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due')
      const failure = await applyUpdate(
        {
          tier: active ? 'pro' : 'free',
          stripe_subscription_id: active ? sub.id : null,
        },
        'stripe_customer_id',
        sub.customer as string,
      )
      if (failure) return failure
      break
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
