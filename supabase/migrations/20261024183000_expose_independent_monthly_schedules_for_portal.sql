do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.portal_current_payment_state(uuid)'::regprocedure) into v_def;
  v_new:=replace(v_def,
    $find$  arrears_amount numeric := 0;
  total_paid numeric := 0;$find$,
    $replace$  arrears_amount numeric := 0;
  total_paid numeric := 0;
  monthly_schedules jsonb := '[]'::jsonb;
  v_months_elapsed integer := 0;
  v_months_remaining integer := 0;$replace$);
  v_new:=replace(v_new,
    $find$      select a.id from public.acquisitions a where a.client_id=_client_id$find$,
    $replace$      select a.id,a.offre_nom,a.formule_nom,a.mensualite_montant,a.duree_paiement_mois,a.superficie_ha
        from public.acquisitions a where a.client_id=_client_id$replace$);
  v_new:=replace(v_new,
    $find$      arrears_days := greatest(arrears_days,coalesce((v_state#>>'{mensualite,mensualites_arrivees}')::integer,0));
    end loop;$find$,
    $replace$      arrears_days := greatest(arrears_days,coalesce((v_state#>>'{mensualite,mensualites_arrivees}')::integer,0));
      v_months_elapsed:=greatest(0,coalesce((v_state#>>'{mensualite,mensualites_arrivees}')::integer,0));
      v_months_remaining:=greatest(0,coalesce(v_acquisition.duree_paiement_mois,0)-v_months_elapsed);
      monthly_schedules:=monthly_schedules || jsonb_build_array(jsonb_build_object(
        'acquisition_id',v_acquisition.id,'offre_nom',v_acquisition.offre_nom,'formule_nom',v_acquisition.formule_nom,
        'montant_mensuel',greatest(0,coalesce((v_state#>>'{mensualite,montant}')::numeric,v_acquisition.mensualite_montant,0)),
        'mois_restants',v_months_remaining,'superficie_ha',coalesce(v_acquisition.superficie_ha,0)
      ));
    end loop;$replace$);
  v_new:=replace(v_new,
    $find$'montant_arriere',round(arrears_amount,2),'hectares_actifs',round(active_ha,4)$find$,
    $replace$'montant_arriere',round(arrears_amount,2),'hectares_actifs',round(active_ha,4),'echeancier_souscriptions',monthly_schedules$replace$);
  if v_new=v_def then raise exception 'La structure du calcul financier global a changé; migration annulée.'; end if;
  execute v_new;
end $$;

create or replace function public.portal_plantation_payment_state(_client_id uuid,_plantation_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  p public.plantations%rowtype;
  a public.acquisitions%rowtype;
  v_acquisition_count integer:=0;
  v_state jsonb;
  v_months_elapsed integer:=0;
  v_months_remaining integer:=0;
begin
  if auth.role() is distinct from 'service_role'
     and (auth.uid() is null or not private.can_access_client(auth.uid(),_client_id)) then
    raise exception 'Accès refusé' using errcode='42501';
  end if;
  select * into p from public.plantations where id=_plantation_id and client_id=_client_id;
  if not found then raise exception 'Plantation introuvable'; end if;
  if p.acquisition_id is not null then
    select * into a from public.acquisitions where id=p.acquisition_id and client_id=_client_id;
    if not found then raise exception 'Souscription de la plantation introuvable'; end if;
    v_state:=public.acquisition_current_payment_state(a.id);
    v_months_elapsed:=greatest(0,coalesce((v_state#>>'{mensualite,mensualites_arrivees}')::integer,0));
    v_months_remaining:=greatest(0,coalesce(a.duree_paiement_mois,0)-v_months_elapsed);
    return jsonb_set(v_state,'{mensualite,echeancier_souscriptions}',jsonb_build_array(jsonb_build_object(
      'acquisition_id',a.id,'offre_nom',a.offre_nom,'formule_nom',a.formule_nom,
      'montant_mensuel',greatest(0,coalesce((v_state#>>'{mensualite,montant}')::numeric,a.mensualite_montant,0)),
      'mois_restants',v_months_remaining,'superficie_ha',coalesce(a.superficie_ha,0)
    )),true);
  end if;
  select count(*)::integer into v_acquisition_count from public.acquisitions a
    where a.client_id=_client_id and lower(coalesce(a.statut,'')) not in ('annule','annulee','annulée','cancelled','supprime','supprimee','supprimé','refuse','refusee','refusé');
  if v_acquisition_count=0 then return public.portal_current_payment_state(_client_id); end if;
  return jsonb_build_object(
    'paiement_initial',jsonb_build_object('montant_officiel',0,'deja_paye',0,'solde',0,'disponible',false),
    'mensualite',jsonb_build_object('montant',0,'montant_a_payer',0,'disponible',false,'jours_retard',0,'montant_arriere',0,'hectares_actifs',coalesce(p.superficie_activee,0),'echeancier_souscriptions','[]'::jsonb),
    'total_paye',0,'souscriptions_actives',0,'sans_contrat_financier',true
  );
end;
$function$;