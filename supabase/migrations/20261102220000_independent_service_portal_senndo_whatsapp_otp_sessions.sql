-- Secure OTP-based access for independent service quotations using the existing paired Senndo WhatsApp session.
create table if not exists public.independent_service_portal_otps (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.independent_service_customers(id) on delete cascade,
  phone_e164 text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  verified_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists independent_service_portal_otps_phone_created_idx
  on public.independent_service_portal_otps(phone_e164, created_at desc);
create table if not exists public.independent_service_portal_sessions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.independent_service_customers(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists independent_service_portal_sessions_token_idx
  on public.independent_service_portal_sessions(token_hash);
alter table public.independent_service_portal_otps enable row level security;
alter table public.independent_service_portal_sessions enable row level security;
revoke all on public.independent_service_portal_otps from anon, authenticated;
revoke all on public.independent_service_portal_sessions from anon, authenticated;
