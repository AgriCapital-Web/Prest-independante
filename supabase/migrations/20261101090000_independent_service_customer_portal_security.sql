-- Secure customer portal access via verified Supabase Auth phone number.
-- Customer actions are atomic RPCs: customers cannot edit prices, items, or quote totals.
create or replace function public.independent_service_customer_owns_quote(p_quote uuid)
returns boolean language sql stable security definer set search_path=public,auth
as $$
 select exists(
  select 1 from public.independent_service_proformas p
  join public.independent_service_customers c on c.id=p.client_id
  where p.id=p_quote and c.telephone=coalesce((select phone from auth.users where id=auth.uid()),'')
    and c.archived_at is null
 );
$$;
revoke all on function public.independent_service_customer_owns_quote(uuid) from public,anon;
grant execute on function public.independent_service_customer_owns_quote(uuid) to authenticated;

drop policy if exists independent_service_customer_portal_read on public.independent_service_proformas;
create policy independent_service_customer_portal_read on public.independent_service_proformas
for select to authenticated using (public.independent_service_customer_owns_quote(id));
drop policy if exists independent_service_customer_items_read on public.independent_service_items;
create policy independent_service_customer_items_read on public.independent_service_items
for select to authenticated using (public.independent_service_customer_owns_quote(proforma_id));
drop policy if exists independent_service_customer_events_read on public.independent_service_events;
create policy independent_service_customer_events_read on public.independent_service_events
for select to authenticated using (public.independent_service_customer_owns_quote(proforma_id));

create or replace function public.independent_service_customer_reply(p_quote uuid,p_action text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=public,auth
as $$
declare q public.independent_service_proformas%rowtype; new_status text; code text;
begin
 if not public.independent_service_customer_owns_quote(p_quote) then
  raise exception 'Dossier non autorisé' using errcode='42501';
 end if;
 if p_action not in ('accept','refuse','request_change') then raise exception 'Action invalide'; end if;
 if p_action in ('refuse','request_change') and length(trim(coalesce(p_reason,'')))<3 then
  raise exception 'Un motif détaillé est requis';
 end if;
 select * into q from public.independent_service_proformas where id=p_quote for update;
 if q.status<>'emise' then raise exception 'Ce devis ne peut plus recevoir de réponse'; end if;
 if q.valid_until is not null and q.valid_until<current_date then
  update public.independent_service_proformas set status='expiree',updated_at=now() where id=p_quote;
  raise exception 'Le devis est expiré';
 end if;
 new_status:=case p_action when 'accept' then 'acceptee' when 'refuse' then 'refusee' else 'modification_demandee' end;
 code:=case p_action when 'accept' then 'accepted' when 'refuse' then 'refused' else 'modification_requested' end;
 update public.independent_service_proformas set status=new_status,
  accepted_at=case when p_action='accept' then now() else accepted_at end,
  refused_at=case when p_action='refuse' then now() else refused_at end,updated_at=now()
 where id=p_quote;
 insert into public.independent_service_events(proforma_id,event_code,actor_type,actor_id,reason,details)
 values(p_quote,code,'customer',auth.uid(),nullif(trim(p_reason),''),jsonb_build_object('source','customer_portal'));
 return jsonb_build_object('ok',true,'status',new_status);
end $$;
revoke all on function public.independent_service_customer_reply(uuid,text,text) from public,anon;
grant execute on function public.independent_service_customer_reply(uuid,text,text) to authenticated;

-- Phone matching is based on the verified Auth phone; no broad customer update policy is granted.
