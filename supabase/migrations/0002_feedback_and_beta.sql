-- Feedback-gated beta: collect structured feedback after an analysis and, in
-- return, grant the user 30 days of unlimited (Pro-equivalent) analyses.
-- Run in the Supabase SQL editor (grainiq-dev first), or `supabase db push`.

-- Time-limited Pro grant, separate from the Stripe-driven `tier` column so the
-- two paths never fight: `tier` stays owned by the billing webhook, while
-- `beta_pro_until` is owned by the feedback flow below. A user is effectively
-- Pro if either says so.
alter table public.profiles
  add column if not exists beta_pro_until timestamptz;

-- Feedback responses. One row per submission. No image data — text + ratings,
-- plus the numeric analysis context so responses can be correlated with the
-- results users were looking at.
create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  user_type text not null
    check (user_type in ('student', 'individual', 'small_business', 'large_organisation')),
  material_etching text,
  accuracy_rating int not null check (accuracy_rating between 1 and 5),
  improvement text,
  would_pay boolean not null,
  pay_amount_gbp numeric check (pay_amount_gbp is null or pay_amount_gbp >= 0),
  method text,
  mli_microns double precision,
  astm_g double precision,
  created_at timestamptz not null default now()
);

create index feedback_user_created on public.feedback (user_id, created_at);

alter table public.feedback enable row level security;

-- Users can read their own submissions. Inserts go exclusively through
-- submit_feedback() (security definer), which also performs the Pro grant
-- atomically, so there is deliberately no direct insert policy.
create policy "Users can read own feedback"
  on public.feedback for select
  using (auth.uid() = user_id);

-- Record feedback and grant 30 days of beta Pro in one transaction. Runs as the
-- definer so it can write profiles.beta_pro_until (which clients cannot).
-- Returns the new expiry so the client can show it. Extends from the later of
-- now or any existing grant, so resubmitting never shortens an active window.
create function public.submit_feedback(
  p_user_type text,
  p_material text,
  p_accuracy int,
  p_improvement text,
  p_would_pay boolean,
  p_pay_amount numeric default null,
  p_method text default null,
  p_mli_microns double precision default null,
  p_astm_g double precision default null
)
returns timestamptz
language plpgsql
security definer set search_path = public
as $$
declare
  v_until timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.feedback (
    user_id, user_type, material_etching, accuracy_rating, improvement,
    would_pay, pay_amount_gbp, method, mli_microns, astm_g
  ) values (
    auth.uid(), p_user_type, p_material, p_accuracy, p_improvement,
    p_would_pay, p_pay_amount, p_method, p_mli_microns, p_astm_g
  );

  -- 30 days from now, but never shorten an existing longer grant. Does not
  -- stack: resubmitting while a grant is active just keeps it at >= 30 days out.
  v_until := greatest(
    coalesce((select beta_pro_until from profiles where id = auth.uid()), to_timestamp(0)),
    now() + interval '30 days'
  );
  update public.profiles set beta_pro_until = v_until, updated_at = now()
  where id = auth.uid();

  return v_until;
end;
$$;

-- Free tier: 15 analyses per calendar month (UTC). Now also unlimited while a
-- beta Pro grant is active. Replaces the 0001 definition.
create or replace function public.can_run_analysis(uid uuid)
returns boolean
language sql
security definer set search_path = public
as $$
  select
    coalesce((select tier from profiles where id = uid), 'free') = 'pro'
    or coalesce((select beta_pro_until from profiles where id = uid), to_timestamp(0)) > now()
    or (
      select count(*) from analyses
      where user_id = uid
        and created_at >= date_trunc('month', now())
    ) < 15
$$;

grant select on public.feedback to authenticated;
grant select, insert, update, delete on public.feedback to service_role;
grant execute on function public.submit_feedback(
  text, text, int, text, boolean, numeric, text, double precision, double precision
) to authenticated;
