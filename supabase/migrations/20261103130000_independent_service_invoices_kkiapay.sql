-- Independent services: invoices and Kkiapay payment records.
-- Payment confirmation is server-owned; clients cannot mark transactions as paid.
begin;

create table if not exists public.independent_service_invoices (
  id uuid primary key default gen_random_uuid(),
  proforma_id uuid not null references public.independent_service_proformas(id) on delete restrict,
  invoice_number text not null unique,
  status text not null default 'issued' check (status in ('issued','partially_paid','paid','cancelled')),
  currency text not null default 'XOF' check (currency = 'XOF'),
  amount_due numeric(14,2) not null check (amount_due >= 0),
  amount_paid numeric(14,2) not null default 0 check (amount_paid >= 0),
  issued_at timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint independent_service_invoice_paid_lte_due check (amount_paid <= amount_due)
);

create unique index if not exists independent_service_invoice_one_per_proforma
  on public.independent_service_invoices(proforma_id)
  where status <> 'cancelled';

create table if not exists public.independent_service_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.independent_service_invoices(id) on delete restrict,
  provider text not null default 'kkiapay' check (provider = 'kkiapay'),
  provider_transaction_id text unique,
  idempotency_key text not null unique,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'XOF' check (currency = 'XOF'),
  status text not null default 'pending' check (status in ('pending','succeeded','failed','cancelled')),
  checkout_url text,
  provider_payload jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists independent_service_payments_invoice_status_idx
  on public.independent_service_payments(invoice_id,status,created_at desc);

alter table public.independent_service_invoices enable row level security;
alter table public.independent_service_payments enable row level security;

-- Reads and mutations are mediated by the authenticated portal/CRM server endpoints.
revoke all on public.independent_service_invoices from anon, authenticated;
revoke all on public.independent_service_payments from anon, authenticated;
grant select, insert, update, delete on public.independent_service_invoices to service_role;
grant select, insert, update, delete on public.independent_service_payments to service_role;

commit;
