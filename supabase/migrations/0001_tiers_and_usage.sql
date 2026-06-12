-- Tiers and usage tracking.
-- Run in the Supabase SQL editor (grainiq-dev first), or `supabase db push`.

-- Profiles: one row per user, tracks tier and Stripe linkage
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'pro')),
  stripe_customer_id text unique,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- Tier and Stripe columns are only written by the service role (edge
-- functions), which bypasses RLS — deliberately no insert/update policies.

-- Auto-create a profile when a user signs up
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for users who registered before this migration
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

-- Analyses: one row per analysis run. Drives the monthly usage limit now and
-- the audit trail later. No image data is ever stored — numeric results only.
create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  mli_microns double precision,
  astm_g double precision,
  created_at timestamptz not null default now()
);

create index analyses_user_created on public.analyses (user_id, created_at);

alter table public.analyses enable row level security;

create policy "Users can read own analyses"
  on public.analyses for select
  using (auth.uid() = user_id);

-- Free tier: 15 analyses per calendar month (UTC), enforced at insert time so
-- the limit cannot be bypassed from the client.
create function public.can_run_analysis(uid uuid)
returns boolean
language sql
security definer set search_path = public
as $$
  select
    coalesce((select tier from profiles where id = uid), 'free') = 'pro'
    or (
      select count(*) from analyses
      where user_id = uid
        and created_at >= date_trunc('month', now())
    ) < 15
$$;

create policy "Users can record analyses within their tier limit"
  on public.analyses for insert
  with check (auth.uid() = user_id and public.can_run_analysis(auth.uid()));
