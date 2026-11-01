-- Independent services and proformas. Applied to the AgriCapital CRM Supabase project.
create table if not exists public.independent_service_catalog (
  id uuid primary key default gen_random_uuid(), code text not null unique, designation text not null,
  description text, default_unit text not null default 'forfait', active boolean not null default true,
  sort_order integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.independent_service_proformas (
  id uuid primary key default gen_random_uuid(), reference text not null unique,
  client_id uuid not null references public.clients(id) on delete restrict,
  client_type text not null default 'personne' check (client_type in ('personne','entreprise','groupe_familial')),
  client_name text not null, client_phone text not null, client_email text, client_locality text,
  assigned_commercial_id uuid,
  status text not null default 'brouillon' check (status in ('brouillon','emise','acceptee','modification_demandee','refusee','en_cours','terminee','annulee','expiree')),
  version integer not null default 1 check (version > 0),
  previous_version_id uuid references public.independent_service_proformas(id) on delete restrict,
  issued_at timestamptz, valid_until date, accepted_at timestamptz, refused_at timestamptz, completed_at timestamptz,
  subtotal numeric(14,2) not null default 0 check (subtotal >= 0),
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  total_amount numeric(14,2) not null default 0 check (total_amount >= 0),
  currency text not null default 'XOF' check (currency = 'XOF'), observations text, pdf_path text,
  created_by uuid references auth.users(id) on delete set null, updated_by uuid references auth.users(id) on delete set null,
  archived_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint independent_service_proforma_dates check (valid_until is null or issued_at is not null)
);
create index if not exists independent_service_proformas_client_idx on public.independent_service_proformas(client_id, created_at desc);
create index if not exists independent_service_proformas_status_idx on public.independent_service_proformas(status, created_at desc);
create index if not exists independent_service_proformas_commercial_idx on public.independent_service_proformas(assigned_commercial_id);
create table if not exists public.independent_service_items (
  id uuid primary key default gen_random_uuid(), proforma_id uuid not null references public.independent_service_proformas(id) on delete cascade,
  catalog_id uuid references public.independent_service_catalog(id) on delete set null, designation text not null, description text,
  quantity numeric(14,3) not null check (quantity > 0), unit text not null,
  unit_price numeric(14,2) not null check (unit_price >= 0), amount numeric(14,2) not null check (amount >= 0),
  hectares numeric(14,3) check (hectares is null or hectares >= 0), sort_order integer not null default 0, created_at timestamptz not null default now()
);
create index if not exists independent_service_items_proforma_idx on public.independent_service_items(proforma_id, sort_order);
create table if not exists public.independent_service_events (
  id uuid primary key default gen_random_uuid(), proforma_id uuid not null references public.independent_service_proformas(id) on delete cascade,
  event_code text not null check (event_code in ('created','issued','accepted','modification_requested','refused','reissued','payment_confirmed','completed','cancelled','archived')),
  actor_type text not null check (actor_type in ('staff','customer','system')), actor_id uuid, reason text,
  details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists independent_service_events_proforma_idx on public.independent_service_events(proforma_id, created_at desc);

alter table public.independent_service_catalog enable row level security;
alter table public.independent_service_proformas enable row level security;
alter table public.independent_service_items enable row level security;
alter table public.independent_service_events enable row level security;

create policy independent_service_catalog_staff_read on public.independent_service_catalog for select to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client','comptable','manager_commercial_national','responsable_operations')));
create policy independent_service_catalog_managers_write on public.independent_service_catalog for all to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')))
with check (exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')));
create policy independent_service_proformas_staff_read on public.independent_service_proformas for select to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client','comptable','manager_commercial_national','responsable_operations')));
create policy independent_service_proformas_authorized_insert on public.independent_service_proformas for insert to authenticated with check
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')));
create policy independent_service_proformas_authorized_update on public.independent_service_proformas for update to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')))
with check (exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')));
create policy independent_service_proformas_pdg_delete on public.independent_service_proformas for delete to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg')));
create policy independent_service_items_staff_read on public.independent_service_items for select to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client','comptable','manager_commercial_national','responsable_operations')));
create policy independent_service_items_authorized_insert on public.independent_service_items for insert to authenticated with check
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')));
create policy independent_service_items_authorized_update on public.independent_service_items for update to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')))
with check (exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')));
create policy independent_service_items_authorized_delete on public.independent_service_items for delete to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')));
create policy independent_service_events_staff_read on public.independent_service_events for select to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client','comptable','manager_commercial_national','responsable_operations')));
create policy independent_service_events_authorized_insert on public.independent_service_events for insert to authenticated with check
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')));

grant select,insert,update,delete on public.independent_service_catalog, public.independent_service_proformas, public.independent_service_items to authenticated;
grant select,insert on public.independent_service_events to authenticated;
insert into public.independent_service_catalog(code,designation,default_unit,sort_order) values
('plants','Fourniture de plants','plant',10),('transport_plants','Transport de plants','forfait',20),
('staking','Piquetage','ha',30),('digging','Trouaison','u',40),('planting','Mise en terre','plant',50),
('farm_labor','Main-d’œuvre agricole','j',60),('other','Autre prestation','forfait',90)
on conflict(code) do nothing;
