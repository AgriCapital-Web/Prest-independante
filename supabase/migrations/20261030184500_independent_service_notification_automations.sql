-- Automated SMS notices for independent-service customer lifecycle.
insert into public.notification_automations
  (code,nom,description,evenement,canal,sujet,contenu,criteres,conditions,actif,cooldown_minutes)
values
  ('independent_service_customer_registered','Client prestation independante - dossier cree',
   'Confirmation SMS apres creation du dossier de prestation independante.',
   'proforma_independante_creee','sms','Dossier de prestation enregistre',
   'AgriCapital: Votre dossier de prestation independante est enregistre. Notre equipe vous contactera pour la suite.',
   '{}'::jsonb,'{}'::jsonb,true,0),
  ('independent_service_proforma_issued','Client prestation independante - proforma emise',
   'Notification SMS apres emission de la proforma independante.',
   'proforma_independante_emise','sms','Votre proforma est emise',
   'AgriCapital: Votre proforma de prestation independante est emise. Contactez notre equipe pour toute question.',
   '{}'::jsonb,'{}'::jsonb,true,0)
on conflict (code) do update set
  nom=excluded.nom,description=excluded.description,evenement=excluded.evenement,
  canal=excluded.canal,sujet=excluded.sujet,contenu=excluded.contenu,
  criteres=excluded.criteres,conditions=excluded.conditions,actif=true,
  cooldown_minutes=0,updated_at=now();
