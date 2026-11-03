import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info"};
const json=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json"}});
const sha=async(v:string)=>{const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");};
const normalize=(v:any)=>{const d=String(v||"").replace(/\D/g,"").replace(/^00/,"");if(d.length<8||d.length>15)throw Error("Numéro de téléphone invalide.");if(d.startsWith("225"))return d;return "225"+d;};
const e164=(v:any)=>{const d=String(v||"").replace(/\D/g,"").replace(/^00/,"");if(!d)throw Error("Numéro absent");return "+"+(d.startsWith("225")?d:"225"+d);};
const secret=()=>Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default||"";
async function resolveSender(admin: any): Promise<{ key: string; sessionId: string }> {
  const [{ data: apiKey, error: apiError }, { data: configuredPhone, error: phoneError }] = await Promise.all([
    admin.rpc("senndo_get_secret", { p_name: "senndo_api_key" }),
    admin.rpc("senndo_get_secret", { p_name: "senndo_whatsapp_sender_phone" }),
  ]);
  if (apiError || typeof apiKey !== "string" || !apiKey) throw new Error("Clé API Senndo non configurée");
  if (phoneError || typeof configuredPhone !== "string" || !configuredPhone.trim()) throw new Error("Numéro de session WhatsApp Senndo non configuré en base.");

  const response = await fetch("https://api.senndo.com/v1/wa/sessions", {
    method: "GET",
    headers: { authorization: "Bearer " + apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Impossible de lire les sessions WhatsApp Senndo (HTTP " + response.status + ").");

  const asArray = (value: any): any[] => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
  const rawSessions = [
    ...asArray(payload),
    ...asArray(payload?.sessions),
    ...asArray(payload?.data?.sessions),
    ...asArray(payload?.data),
    ...asArray(payload?.items),
    ...asArray(payload?.results),
    ...asArray(payload?.data?.items),
    ...asArray(payload?.data?.results),
    ...asArray(payload?.session),
    ...asArray(payload?.data?.session),
  ];
  const seenSessions = new Set<any>();
  const sessions = rawSessions
    .filter((item: any) => item && typeof item === "object" && !seenSessions.has(item) && (seenSessions.add(item), true))
    .map((item: any) => {
      const nested = item.session && typeof item.session === "object" ? item.session
        : item.data?.session && typeof item.data.session === "object" ? item.data.session : null;
      return nested ? {
        ...item, ...nested,
        id: nested.id ?? item.id,
        sessionId: nested.sessionId ?? nested.session_id ?? item.sessionId ?? item.session_id,
        senderSessionId: nested.senderSessionId ?? nested.sender_session_id ?? item.senderSessionId ?? item.sender_session_id,
        uuid: nested.uuid ?? item.uuid,
      } : item;
    });

  const nestedObjects = (root: any, depth = 0): any[] => {
    if (!root || typeof root !== "object" || depth > 5) return [];
    return [root, ...Object.values(root).flatMap((value: any) => nestedObjects(value, depth + 1))];
  };
  const technicalSessionId = (session: any): string => {
    const objects = nestedObjects(session);
    const preferred = [
      "senderSessionId", "sender_session_id", "sessionId", "session_id",
      "uniqueSessionId", "unique_session_id", "sessionKey", "session_key",
      "sessionUid", "session_uid", "sessionIdentifier", "session_identifier",
      "instanceId", "instance_id", "deviceId", "device_id", "sid", "uuid", "id",
    ];
    for (const key of preferred) {
      const value = objects.map((object: any) => object?.[key]).find((candidate: any) =>
        (typeof candidate === "string" && candidate.trim()) ||
        (typeof candidate === "number" && Number.isFinite(candidate)));
      if (value !== undefined) return String(value).trim();
    }
    return "";
  };
  const normalizePhone = (value: unknown) => {
    const rawPhone = String(value ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");
    if (!rawPhone) return "";
    const national = rawPhone.startsWith("225") ? rawPhone.slice(3) : rawPhone;
    if (national.length === 10 && /^0[157]\d{8}$/.test(national)) return "225" + national.slice(-8);
    if (national.length === 8) return "225" + national;
    return rawPhone;
  };
  const phoneValues = (session: any) => [
    session?.phoneNumber, session?.phone_number, session?.phone, session?.displayPhoneNumber,
    session?.display_phone_number, session?.number, session?.jid, session?.user?.id,
    session?.user?.jid, session?.me?.id, session?.me?.jid, session?.account?.phone,
    session?.account?.phoneNumber, session?.profile?.phone, session?.whatsapp?.phone,
    session?.session?.phoneNumber, session?.session?.phone_number, session?.session?.user?.id,
    session?.session?.me?.id, session?.creds?.me?.id, session?.authState?.creds?.me?.id,
  ].filter((value) => (typeof value === "string" || typeof value === "number") && String(value).trim());
  const statusOf = (session: any) => String(
    session?.status ?? session?.state ?? session?.connectionStatus ?? session?.connection_status ??
    session?.connection?.status ?? session?.session?.status ?? ""
  ).trim().toLowerCase();
  const connected = sessions.filter((session: any) => ["connected", "open", "ready", "authenticated"].includes(statusOf(session)));
  const senderDigits = normalizePhone(configuredPhone);
  if (!senderDigits) throw new Error("Le numéro de session WhatsApp Senndo configuré est invalide.");
  const matches = connected.filter((session: any) => phoneValues(session).some((value: unknown) => normalizePhone(value) === senderDigits));

  // Senndo peut omettre le téléphone d'une session. Si une seule session est connectée,
  // elle est non ambiguë et peut être utilisée; plusieurs sessions exigent une correspondance exacte.
  const session = matches.length === 1 ? matches[0] : (matches.length === 0 && connected.length === 1 ? connected[0] : null);
  const senderSessionId = session ? technicalSessionId(session) : "";
  if (!session || !senderSessionId) {
    throw new Error(connected.length === 0
      ? "Aucune session WhatsApp connectée n’a été trouvée dans Senndo."
      : connected.length > 1 && matches.length !== 1
        ? "Plusieurs sessions WhatsApp sont connectées sans correspondance unique avec le numéro configuré."
        : "La session WhatsApp est connectée, mais Senndo ne fournit pas son identifiant technique.");
  }
  return { key: apiKey, sessionId: senderSessionId };
}


async function sendWhatsApp(admin:any,to:string,code:string,otpId:string){
 const {key,sessionId}=await resolveSender(admin);
 const response=await fetch("https://api.senndo.com/v1/messages",{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json",accept:"application/json"},body:JSON.stringify({channel:"whatsapp_baileys",to,text:"*AgriCapital 360* | Votre code de vérification : *"+code+"*. Valable 10 minutes. Ne le partagez pas.",senderSessionId:sessionId,idempotencyKey:"ind-service-otp:"+otpId}),signal:AbortSignal.timeout(30000)});
 const payload=await response.json().catch(()=>null);if(!response.ok)throw Error("Senndo a refusé l’envoi WhatsApp (HTTP "+response.status+"). "+String(payload?.message||payload?.error||"").slice(0,200));
}
async function customerByPhone(admin:any,phone:string){
 const tail=phone.slice(-8);const {data,error}=await admin.from("independent_service_customers").select("id,telephone,archived_at").ilike("telephone","%"+tail).is("archived_at",null).limit(50);if(error)throw error;
 return (data||[]).find((c:any)=>{try{return normalize(c.telephone)===phone;}catch{return false;}})||null;
}
async function sessionCustomer(admin:any,token:string){
 if(!token)throw Error("Session client absente.");const hash=await sha(token);
 const {data,error}=await admin.from("independent_service_portal_sessions").select("customer_id,expires_at,revoked_at").eq("token_hash",hash).maybeSingle();if(error)throw error;
 if(!data||data.revoked_at||new Date(data.expires_at).getTime()<=Date.now())throw Error("Session expirée. Reconnectez-vous.");
 await admin.from("independent_service_portal_sessions").update({last_seen_at:new Date().toISOString()}).eq("token_hash",hash);return data.customer_id;
}
serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{headers:cors});
 try{
  const body=await req.json();const action=String(body?.action||"");const service=secret();if(!service)throw Error("Service base de données indisponible.");
  const admin=createClient(Deno.env.get("SUPABASE_URL")!,service);
  if(action==="request_otp"){
   const phone=normalize(body.phone);const customer=await customerByPhone(admin,phone);if(!customer)return json({success:false,error:"Aucun dossier de prestations indépendantes ne correspond à ce numéro."},404);
   const {data:recent}=await admin.from("independent_service_portal_otps").select("created_at").eq("customer_id",customer.id).gte("created_at",new Date(Date.now()-60_000).toISOString()).limit(1);
   if(recent?.length)return json({success:false,error:"Un code vient d’être demandé. Patientez une minute."},429);
   const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");const expires=new Date(Date.now()+10*60_000).toISOString();
   const {data:row,error}=await admin.from("independent_service_portal_otps").insert({customer_id:customer.id,phone_e164:e164(body.phone),code_hash:await sha(code+":"+phone+":"+service),expires_at:expires}).select("id").single();if(error)throw error;
   try{await sendWhatsApp(admin,e164(body.phone),code,row.id);}catch(e){await admin.from("independent_service_portal_otps").delete().eq("id",row.id);throw e;}
   return json({success:true,otp_sent:true,expires_in:600});
  }
  if(action==="verify_otp"){
   const phone=normalize(body.phone);const code=String(body.code||"");if(!/^\d{6}$/.test(code))return json({success:false,error:"Saisissez le code à 6 chiffres."},400);
   const customer=await customerByPhone(admin,phone);if(!customer)return json({success:false,error:"Dossier client introuvable."},404);
   const {data:otp,error}=await admin.from("independent_service_portal_otps").select("*").eq("customer_id",customer.id).is("verified_at",null).gt("expires_at",new Date().toISOString()).order("created_at",{ascending:false}).limit(1).maybeSingle();if(error)throw error;
   if(!otp||otp.attempts>=5)return json({success:false,error:"Code expiré ou trop de tentatives. Demandez un nouveau code."},400);
   const hash=await sha(code+":"+phone+":"+service);if(hash!==otp.code_hash){await admin.from("independent_service_portal_otps").update({attempts:otp.attempts+1}).eq("id",otp.id);return json({success:false,error:"Code incorrect."},401);}
   await admin.from("independent_service_portal_otps").update({verified_at:new Date().toISOString()}).eq("id",otp.id);
   const raw=crypto.randomUUID()+"."+crypto.randomUUID()+"."+crypto.randomUUID();await admin.from("independent_service_portal_sessions").insert({customer_id:customer.id,token_hash:await sha(raw),expires_at:new Date(Date.now()+7*86400_000).toISOString()});
   return json({success:true,access_token:raw});
  }
  if(action==="logout"){const token=String(body.access_token||"");if(token)await admin.from("independent_service_portal_sessions").update({revoked_at:new Date().toISOString()}).eq("token_hash",await sha(token));return json({success:true});}
  const customerId=await sessionCustomer(admin,String(body.access_token||""));
  if(action==="quotes"){
   const {data,error}=await admin.from("independent_service_proformas").select("id,reference,status,version,issued_at,valid_until,total_amount,currency,observations,client_phone,independent_service_items(designation,quantity,unit,unit_price,amount)").eq("client_id",customerId).order("created_at",{ascending:false});if(error)throw error;
   return json({success:true,quotes:(data||[]).map((q:any)=>({...q,items:q.independent_service_items||[]}))});
  }
  if(action==="invoices"){
   const {data,error}=await admin.from("independent_service_invoices").select("id,proforma_id,invoice_number,status,currency,amount_due,amount_paid,issued_at,independent_service_proformas!inner(reference,client_id)").eq("independent_service_proformas.client_id",customerId).order("issued_at",{ascending:false});if(error)throw error;
   return json({success:true,invoices:(data||[]).map((invoice:any)=>({...invoice,quote_reference:invoice.independent_service_proformas?.reference}))});
  }
  if(action==="reply"){
   const quoteId=String(body.quote_id||""),kind=String(body.action_kind||""),reason=String(body.reason||"").trim();
   if(!["accept","refuse","request_change"].includes(kind))return json({success:false,error:"Action non valide."},400);
   if(kind!=="accept"&&reason.length<3)return json({success:false,error:"Un motif détaillé est requis."},400);
   const {data:q,error}=await admin.from("independent_service_proformas").select("id,status,valid_until").eq("id",quoteId).eq("client_id",customerId).maybeSingle();if(error)throw error;if(!q)return json({success:false,error:"Devis introuvable."},404);
   if(q.status!=="emise")return json({success:false,error:"Ce devis ne peut plus recevoir de réponse."},409);
   if(q.valid_until&&q.valid_until<new Date().toISOString().slice(0,10)){await admin.from("independent_service_proformas").update({status:"expiree"}).eq("id",quoteId);return json({success:false,error:"Le devis est expiré."},409);}
   const status=kind==="accept"?"acceptee":kind==="refuse"?"refusee":"modification_demandee",event=kind==="accept"?"accepted":kind==="refuse"?"refused":"modification_requested";
   const {error:up}=await admin.from("independent_service_proformas").update({status,accepted_at:kind==="accept"?new Date().toISOString():null,refused_at:kind==="refuse"?new Date().toISOString():null,updated_at:new Date().toISOString()}).eq("id",quoteId).eq("client_id",customerId);if(up)throw up;
   if(kind==="accept"){
     const {data:existing,error:lookupError}=await admin.from("independent_service_invoices").select("id").eq("proforma_id",quoteId).neq("status","cancelled").maybeSingle();if(lookupError)throw lookupError;
     if(!existing){
       const {data:proforma,error:proformaError}=await admin.from("independent_service_proformas").select("reference,total_amount,currency").eq("id",quoteId).single();if(proformaError)throw proformaError;
       const invoiceNumber="FAC-"+new Date().toISOString().slice(0,10).replace(/-/g,"")+"-"+String(proforma.reference||quoteId.slice(0,8)).replace(/[^A-Za-z0-9]/g,"").slice(-10).toUpperCase();
       const {error:invoiceError}=await admin.from("independent_service_invoices").insert({proforma_id:quoteId,invoice_number:invoiceNumber,status:"issued",currency:"XOF",amount_due:proforma.total_amount,amount_paid:0});if(invoiceError)throw invoiceError;
     }
   }
   const {error:ev}=await admin.from("independent_service_events").insert({proforma_id:quoteId,event_code:event,actor_type:"customer",reason:reason||null,details:{source:"customer_portal_senndo"}});if(ev)throw ev;
   return json({success:true,status});
  }
  return json({success:false,error:"Action inconnue."},400);
 }catch(e){console.error("independent-service-portal",e);return json({success:false,error:e instanceof Error?e.message:"Erreur serveur."},500);}
});
