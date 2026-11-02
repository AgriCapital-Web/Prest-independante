import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info"};
const json=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"Content-Type":"application/json"}});
const sha=async(v:string)=>{const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");};
const normalize=(v:any)=>{const d=String(v||"").replace(/\D/g,"").replace(/^00/,"");if(d.length<8||d.length>15)throw Error("Numéro de téléphone invalide.");if(d.startsWith("225"))return d;return "225"+d;};
const e164=(v:any)=>{const d=String(v||"").replace(/\D/g,"").replace(/^00/,"");if(!d)throw Error("Numéro absent");return "+"+(d.startsWith("225")?d:"225"+d);};
const secret=()=>Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}").default||"";
async function sender(admin:any){
 const [{data:key,error:ke},{data:phone,error:pe}]=await Promise.all([admin.rpc("senndo_get_secret",{p_name:"senndo_api_key"}),admin.rpc("senndo_get_secret",{p_name:"senndo_whatsapp_sender_phone"})]);
 if(ke||pe||typeof key!=="string"||!key||typeof phone!=="string"||!phone.trim())throw Error("La configuration Senndo WhatsApp existante est indisponible.");
 const resp=await fetch("https://api.senndo.com/v1/wa/sessions",{headers:{authorization:"Bearer "+key,accept:"application/json"},signal:AbortSignal.timeout(15000)});
 const payload=await resp.json().catch(()=>null);if(!resp.ok)throw Error("Lecture de la session WhatsApp Senndo impossible (HTTP "+resp.status+").");
 const arr=(v:any):any[]=>Array.isArray(v)?v:v&&typeof v==="object"?Object.values(v):[];
 const sessions=[...arr(payload),...arr(payload?.sessions),...arr(payload?.data?.sessions),...arr(payload?.data),...arr(payload?.items),...arr(payload?.results)];
 const norm=(v:any)=>String(v||"").split("@")[0].split(":")[0].replace(/\D/g,"").replace(/^225/,"");
 const connected=sessions.filter(x=>["connected","open","ready","authenticated"].includes(String(x?.status||x?.state||x?.connectionStatus||"").toLowerCase()));
 const wanted=norm(phone);
 const matches=connected.filter(x=>[x.phoneNumber,x.phone_number,x.phone,x.displayPhoneNumber,x.number,x.jid,x.user?.id,x.me?.id,x.session?.phoneNumber].some(v=>v&&norm(v)===wanted));
 const chosen=matches.length===1?matches[0]:(matches.length===0&&connected.length===1?connected[0]:null);
 const id=chosen?.senderSessionId||chosen?.sender_session_id||chosen?.sessionId||chosen?.session_id||chosen?.uuid||chosen?.id;
 if(!chosen||!id)throw Error("Aucune session WhatsApp Senndo appairée et connectée correspondant au numéro configuré.");
 return {key,sessionId:String(id)};
}
async function sendWhatsApp(admin:any,to:string,code:string,otpId:string){
 const {key,sessionId}=await sender(admin);
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
  if(action==="reply"){
   const quoteId=String(body.quote_id||""),kind=String(body.action_kind||""),reason=String(body.reason||"").trim();
   if(!["accept","refuse","request_change"].includes(kind))return json({success:false,error:"Action non valide."},400);
   if(kind!=="accept"&&reason.length<3)return json({success:false,error:"Un motif détaillé est requis."},400);
   const {data:q,error}=await admin.from("independent_service_proformas").select("id,status,valid_until").eq("id",quoteId).eq("client_id",customerId).maybeSingle();if(error)throw error;if(!q)return json({success:false,error:"Devis introuvable."},404);
   if(q.status!=="emise")return json({success:false,error:"Ce devis ne peut plus recevoir de réponse."},409);
   if(q.valid_until&&q.valid_until<new Date().toISOString().slice(0,10)){await admin.from("independent_service_proformas").update({status:"expiree"}).eq("id",quoteId);return json({success:false,error:"Le devis est expiré."},409);}
   const status=kind==="accept"?"acceptee":kind==="refuse"?"refusee":"modification_demandee",event=kind==="accept"?"accepted":kind==="refuse"?"refused":"modification_requested";
   const {error:up}=await admin.from("independent_service_proformas").update({status,accepted_at:kind==="accept"?new Date().toISOString():null,refused_at:kind==="refuse"?new Date().toISOString():null,updated_at:new Date().toISOString()}).eq("id",quoteId).eq("client_id",customerId);if(up)throw up;
   const {error:ev}=await admin.from("independent_service_events").insert({proforma_id:quoteId,event_code:event,actor_type:"customer",reason:reason||null,details:{source:"customer_portal_senndo"}});if(ev)throw ev;
   return json({success:true,status});
  }
  return json({success:false,error:"Action inconnue."},400);
 }catch(e){console.error("independent-service-portal",e);return json({success:false,error:e instanceof Error?e.message:"Erreur serveur."},500);}
});
