-- Independent service customers and isolated technical intervention records.
-- Preserve existing proforma snapshots while moving their customer relation out of public.clients.
create table if not exists public.independent_service_customers (
  id uuid primary key default gen_random_uuid(),
  customer_type text not null check (customer_type in ('particulier','personne_morale','groupement_familial')),
  display_name text not null,
  telephone text not null,
  email text,
  locality text,
  district_id uuid,
  region_id uuid,
  departement_id uuid,
  sous_prefecture_id uuid,
  village_id uuid,
  domicile text,
  details jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists independent_service_customers_name_idx on public.independent_service_customers(display_name);
create index if not exists independent_service_customers_phone_idx on public.independent_service_customers(telephone);

-- Keep historical proformas readable: migrate only referenced client snapshots, retaining their UUIDs.
insert into public.independent_service_customers(id,customer_type,display_name,telephone,email,locality,details,created_at,updated_at)
select c.id,
  case when c.type_compte in ('entreprise','personne_morale') then 'personne_morale'
       when c.type_compte in ('groupe_familial','famille_informelle') then 'groupement_familial'
       else 'particulier' end,
  coalesce(nullif(c.nom_complet,''), concat_ws(' ',c.prenoms,c.nom), 'Client indépendant'),
  coalesce(c.telephone,''),
  c.email,
  c.localite,
  to_jsonb(c),
  coalesce(c.created_at,now()),
  coalesce(c.updated_at,now())
from public.clients c
join public.independent_service_proformas p on p.client_id=c.id
on conflict (id) do nothing;

do $$
declare fk_name text;
begin
  select conname into fk_name
  from pg_constraint
  where conrelid='public.independent_service_proformas'::regclass
    and contype='f'
    and pg_get_constraintdef(oid) ilike '%client_id%clients%';
  if fk_name is not null then
    execute format('alter table public.independent_service_proformas drop constraint %I', fk_name);
  end if;
end $$;
alter table public.independent_service_proformas
  add constraint independent_service_proformas_customer_fk
  foreign key (client_id) references public.independent_service_customers(id) on delete restrict;

alter table public.independent_service_events drop constraint if exists independent_service_events_event_code_check;
alter table public.independent_service_events
  add constraint independent_service_events_event_code_check
  check (event_code in ('created','issued','accepted','modification_requested','refused','reissued','payment_confirmed','completed','cancelled','archived','technical_intervention'));

alter table public.independent_service_customers enable row level security;
drop policy if exists independent_service_customers_staff_read on public.independent_service_customers;
create policy independent_service_customers_staff_read on public.independent_service_customers for select to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client','comptable','manager_commercial_national','responsable_operations')));
drop policy if exists independent_service_customers_authorized_insert on public.independent_service_customers;
create policy independent_service_customers_authorized_insert on public.independent_service_customers for insert to authenticated with check
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')));
drop policy if exists independent_service_customers_authorized_update on public.independent_service_customers;
create policy independent_service_customers_authorized_update on public.independent_service_customers for update to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')))
with check (exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role in ('pdg','dg','service_client','chef_equipe_service_client')));
drop policy if exists independent_service_customers_pdg_delete on public.independent_service_customers;
create policy independent_service_customers_pdg_delete on public.independent_service_customers for delete to authenticated using
(exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid()) and ur.role='pdg'));
grant select,insert,update,delete on public.independent_service_customers to authenticated;

-- Technicians may append independent-service technical reports; they do not gain
-- write access to customer records, proformas, catalogue or standard interventions.
drop policy if exists independent_service_events_technician_insert on public.independent_service_events;
create policy independent_service_events_technician_insert on public.independent_service_events
for insert to authenticated with check (
  event_code='technical_intervention'
  and actor_type='staff'
  and actor_id=(select auth.uid())
  and exists(
    select 1 from public.user_roles ur
    where ur.user_id=(select auth.uid())
      and ur.role in ('pdg','dg','technicien','chef_equipe_technique','manager_technique_national','responsable_operations')
  )
);

drop policy if exists independent_service_proformas_technician_read on public.independent_service_proformas;
create policy independent_service_proformas_technician_read on public.independent_service_proformas
for select to authenticated using (
  status in ('acceptee','en_cours')
  and exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid())
    and ur.role in ('pdg','dg','technicien','chef_equipe_technique','manager_technique_national','responsable_operations'))
);
drop policy if exists independent_service_events_technician_read on public.independent_service_events;
create policy independent_service_events_technician_read on public.independent_service_events
for select to authenticated using (
  event_code='technical_intervention'
  and exists(select 1 from public.user_roles ur where ur.user_id=(select auth.uid())
    and ur.role in ('pdg','dg','technicien','chef_equipe_technique','manager_technique_national','responsable_operations'))
);

-- First submitted field report automatically moves an accepted proforma into execution.
create or replace function public.independent_service_mark_proforma_in_progress()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  if new.event_code='technical_intervention' then
    update public.independent_service_proformas
      set status='en_cours', updated_at=now()
      where id=new.proforma_id and status='acceptee';
  end if;
  return new;
end;
$$;
drop trigger if exists independent_service_mark_proforma_in_progress_trg on public.independent_service_events;
create trigger independent_service_mark_proforma_in_progress_trg
after insert on public.independent_service_events
for each row execute function public.independent_service_mark_proforma_in_progress();

revoke all on function public.independent_service_mark_proforma_in_progress() from public, anon, authenticated;
