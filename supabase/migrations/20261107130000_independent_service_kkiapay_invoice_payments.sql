begin;

create or replace function public.prepare_independent_service_payment(
  p_invoice_id uuid,p_amount numeric,p_idempotency_key text
)
returns public.independent_service_payments
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_uid uuid:=auth.uid(); v_invoice public.independent_service_invoices%rowtype; v_payment public.independent_service_payments%rowtype;
begin
  if v_uid is null or not exists(select 1 from public.user_roles ur where ur.user_id=v_uid and ur.role=any(array['pdg','dg','service_client','chef_equipe_service_client','comptable'])) then
    raise exception 'Accès non autorisé au paiement de cette facture' using errcode='42501';
  end if;
  if p_amount is null or p_amount<=0 then raise exception 'Le montant du paiement doit être positif'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key))<12 or length(p_idempotency_key)>120 then raise exception 'Clé de paiement invalide'; end if;
  select * into v_invoice from public.independent_service_invoices where id=p_invoice_id for update;
  if not found then raise exception 'Facture introuvable'; end if;
  if v_invoice.status in ('cancelled','paid') then raise exception 'Cette facture ne nécessite plus de paiement'; end if;
  if p_amount>greatest(0,v_invoice.amount_due-v_invoice.amount_paid) then raise exception 'Le montant dépasse le reste à payer'; end if;
  select * into v_payment from public.independent_service_payments where idempotency_key=trim(p_idempotency_key);
  if found then
    if v_payment.invoice_id<>p_invoice_id or v_payment.amount<>p_amount then raise exception 'Cette référence de paiement est déjà utilisée'; end if;
    return v_payment;
  end if;
  insert into public.independent_service_payments(invoice_id,provider,idempotency_key,amount,currency,status,provider_payload)
  values(p_invoice_id,'kkiapay',trim(p_idempotency_key),p_amount,v_invoice.currency,'pending',jsonb_build_object('initiated_by',v_uid,'initiated_at',now()))
  returning * into v_payment;
  return v_payment;
end; $$;
revoke all on function public.prepare_independent_service_payment(uuid,numeric,text) from public,anon;
grant execute on function public.prepare_independent_service_payment(uuid,numeric,text) to authenticated;

create or replace function public.finalize_independent_service_payment(
  p_payment_id uuid,p_transaction_id text,p_provider_amount numeric,p_provider_payload jsonb default '{}'::jsonb
)
returns public.independent_service_payments
language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_payment public.independent_service_payments%rowtype; v_invoice public.independent_service_invoices%rowtype; v_paid numeric;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'Accès réservé au service de paiement' using errcode='42501'; end if;
  if p_transaction_id is null or length(trim(p_transaction_id))=0 or length(p_transaction_id)>128 then raise exception 'Identifiant de transaction invalide'; end if;
  select * into v_payment from public.independent_service_payments where id=p_payment_id for update;
  if not found then raise exception 'Paiement introuvable'; end if;
  if v_payment.status='succeeded' and v_payment.provider_transaction_id=trim(p_transaction_id) then return v_payment; end if;
  if v_payment.status='succeeded' then raise exception 'Ce paiement est déjà confirmé'; end if;
  if abs(coalesce(p_provider_amount,0)-v_payment.amount)>1 then raise exception 'Le montant confirmé par Kkiapay ne correspond pas au montant attendu'; end if;
  if exists(select 1 from public.independent_service_payments where provider_transaction_id=trim(p_transaction_id) and id<>p_payment_id) then raise exception 'Cette transaction Kkiapay est déjà utilisée'; end if;
  select * into v_invoice from public.independent_service_invoices where id=v_payment.invoice_id for update;
  if not found then raise exception 'Facture introuvable'; end if;
  v_paid:=v_invoice.amount_paid+v_payment.amount;
  if v_paid>v_invoice.amount_due then raise exception 'Le cumul des paiements dépasse la facture'; end if;
  update public.independent_service_payments set status='succeeded',provider_transaction_id=trim(p_transaction_id),provider_payload=coalesce(p_provider_payload,'{}'::jsonb),verified_at=now(),updated_at=now() where id=p_payment_id returning * into v_payment;
  update public.independent_service_invoices set amount_paid=v_paid,status=case when v_paid>=amount_due then 'paid' else 'partial' end,updated_at=now() where id=v_invoice.id;
  return v_payment;
end; $$;
revoke all on function public.finalize_independent_service_payment(uuid,text,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.finalize_independent_service_payment(uuid,text,numeric,jsonb) to service_role;
commit;