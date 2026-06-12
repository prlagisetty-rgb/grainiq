# Stripe + Supabase one-time setup

Everything below uses **Stripe test mode** and the **grainiq-dev** Supabase project.
Repeat with live keys and grainiq-production only when ready for real customers.

## 1. Run the database migration

Supabase dashboard → SQL Editor → paste and run
`supabase/migrations/0001_tiers_and_usage.sql`.

This creates `profiles` (tier + Stripe linkage, auto-created per user, backfilled
for existing users) and `analyses` (usage tracking / future audit trail), with the
15-per-month free limit enforced by RLS at insert time.

## 2. Create the Pro product in Stripe

1. Stripe dashboard → make sure **Test mode** is toggled on
2. Product catalogue → Add product:
   - Name: **GrainIQ Pro**
   - Price: **£89.00 GBP**, recurring, monthly
3. Copy the price ID (`price_…`) — needed in step 4

## 3. Install the Supabase CLI and link the project

```powershell
scoop install supabase
# or: npm install -g supabase
supabase login
supabase link --project-ref <grainiq-dev project ref>   # ref is in the dashboard URL
```

## 4. Set function secrets

Keys from Stripe dashboard → Developers → API keys (test mode, `sk_test_…`):

```powershell
supabase secrets set STRIPE_SECRET_KEY=sk_test_...
supabase secrets set STRIPE_PRICE_ID_PRO=price_...
```

(`STRIPE_WEBHOOK_SECRET` comes in step 6.)

## 5. Deploy the edge functions

```powershell
supabase functions deploy create-checkout-session
supabase functions deploy create-portal-session
supabase functions deploy stripe-webhook --no-verify-jwt
```

`--no-verify-jwt` is required on the webhook: Stripe authenticates with its
signature, not a Supabase JWT.

## 6. Register the webhook in Stripe

1. Stripe dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
3. Events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the signing secret (`whsec_…`) and set it:

```powershell
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

## 7. Activate the billing portal (test mode)

Stripe dashboard → Settings → Billing → Customer portal → Save the default
configuration. Portal sessions fail until this is saved once.

## 8. End-to-end test

1. `npm run dev`, sign in, run an analysis → header shows `1/15 analyses this month`
2. Click **Upgrade to Pro** → Stripe Checkout → pay with `4242 4242 4242 4242`,
   any future expiry, any CVC
3. Redirect back → "Finalising upgrade…" → **Pro** badge appears (webhook latency
   is a few seconds)
4. **Manage billing** opens the Stripe portal; cancel the subscription there and
   the tier drops back to free (immediately on cancellation event)
5. Free limit: run 15 analyses on a free account (or temporarily lower the limit
   in `can_run_analysis` + `useProfile.js`), then confirm the 16th image load is
   blocked with the upgrade prompt
