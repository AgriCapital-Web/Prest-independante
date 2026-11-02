import { useEffect, useMemo, useState } from "react";
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";
import { supabase } from "./lib/supabase";
type Quote={id:string;reference:string;status:string;version:number;issued_at:string|null;valid_until:string|null;total_amount:number;currency:string;observations:string|null;client_phone:string;items?:{designation:string;quantity:number;unit:string;unit_price:number;amount:number}[]};
const money=(v:number)=>new Intl.NumberFormat("fr-FR",{style:"currency",currency:"XOF",maximumFractionDigits:0}).format(v||0);
const labels:Record<string,string>={emise:"À consulter",acceptee:"Accepté",modification_demandee:"Modification demandée",refusee:"Refusé",en_cours:"Intervention en cours",terminee:"Terminée",expiree:"Expiré",annulee:"Annulé"};
function authErrorMessage(error: any, stage: "send" | "verify") {
  const code = String(error?.code || error?.name || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  const status = Number(error?.status || error?.statusCode || 0);
  if (code.includes("abort") || message.includes("abort")) return "La demande a été interrompue. Réessayez.";
  if (code.includes("network") || message.includes("fetch") || message.includes("network") || message.includes("failed to")) return "Erreur réseau : vérifiez votre connexion Internet puis réessayez.";
  if (status === 429 || code.includes("rate") || message.includes("rate limit") || message.includes("too many")) return "Trop de tentatives. Patientez quelques minutes avant de réessayer.";
  if (status === 500 || status === 502 || status === 503 || status === 504) return "Le service d’authentification est momentanément indisponible. Réessayez plus tard.";
  if (stage === "send" && (message.includes("sms") || message.includes("whatsapp") || message.includes("provider") || message.includes("delivery"))) return "Échec de l’envoi via WhatsApp. Aucun SMS ne sera envoyé. Vérifiez le fournisseur WhatsApp configuré dans Supabase Auth et réessayez.";
  if (stage === "verify" && (message.includes("expired") || message.includes("otp_expired"))) return "Ce code a expiré. Demandez un nouveau code de vérification.";
  if (stage === "verify" && (message.includes("invalid") || message.includes("otp") || message.includes("token"))) return "Code incorrect. Vérifiez les 6 chiffres ou demandez un nouveau code.";
  if (message.includes("not authorized") || message.includes("not allowed") || message.includes("disabled")) return "Ce numéro ou cette méthode de connexion n’est pas autorisé. Contactez AgriCapital.";
  return stage === "send" ? "Impossible d’envoyer le code pour le moment. Vérifiez le numéro et réessayez." : "Impossible de vérifier le code pour le moment. Réessayez.";
}
const countryNames = new Intl.DisplayNames(["fr"], { type: "region" });
const countryFlag = (code: string) => String.fromCodePoint(...code.toUpperCase().split("").map(c => 127397 + c.charCodeAt(0)));
const countryOptions = getCountries().map(code => ({ code, name: countryNames.of(code) || code, calling: "+" + getCountryCallingCode(code) })).sort((a,b)=>a.name.localeCompare(b.name,"fr"));
export default function App(){const [country,setCountry]=useState<CountryCode>("CI");const [localPhone,setLocalPhone]=useState("");const phone = useMemo(()=>{const local=localPhone.replace(/[^0-9]/g,"");return local ? "+"+getCountryCallingCode(country)+local : "";},[country,localPhone]);const [otp,setOtp]=useState("");const [sent,setSent]=useState(false);const [session,setSession]=useState(false);const [quotes,setQuotes]=useState<Quote[]>([]);const [selected,setSelected]=useState<Quote|null>(null);const [reason,setReason]=useState("");const [action,setAction]=useState<"refuse"|"change"|null>(null);const [busy,setBusy]=useState(false);const [msg,setMsg]=useState("");
useEffect(()=>{if(!supabase)return;supabase.auth.getSession().then(({data})=>setSession(!!data.session));const {data}=supabase.auth.onAuthStateChange((_e,s)=>setSession(!!s));return()=>data.subscription.unsubscribe()},[]);
useEffect(()=>{if(session)load()},[session]);
async function load(){if(!supabase)return;setBusy(true);const {data,error}=await supabase.from("independent_service_proformas").select("id,reference,status,version,issued_at,valid_until,total_amount,currency,observations,client_phone,independent_service_items(designation,quantity,unit,unit_price,amount)").order("created_at",{ascending:false});setBusy(false);if(error){setMsg("Impossible de charger les devis. Vérifiez les règles d’accès client : "+error.message);return;}setQuotes((data||[]).map((q:any)=>({...q,items:q.independent_service_items||[]})));}
async function send(){
  setMsg("");
  if(!supabase){setMsg("Connexion au service d’authentification indisponible. Vérifiez les variables VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY puis redéployez.");return;}
  const parsed=phone ? parsePhoneNumberFromString(phone) : undefined;
  if(!parsed||!parsed.isValid()){setMsg("Le numéro saisi n’est pas valide pour le pays sélectionné.");return;}
  setBusy(true);
  try{
    const {error}=await supabase.auth.signInWithOtp({phone:parsed.number,options:{channel:"whatsapp"}});
    if(error){setMsg(authErrorMessage(error,"send"));return;}
    setSent(true);
    setOtp("");\n    setMsg("Code demandé via WhatsApp uniquement. Consultez le WhatsApp appairé à ce numéro.");
  }catch(e){
    setMsg("Impossible de joindre le service WhatsApp d’authentification. Aucun SMS ne sera envoyé. Vérifiez votre connexion puis réessayez.");
  }finally{setBusy(false);}
}
async function verify(){
  setMsg("");
  if(!supabase){setMsg("Connexion au service d’authentification indisponible. Vérifiez la configuration Supabase.");return;}
  const parsed=phone ? parsePhoneNumberFromString(phone) : undefined;
  if(!parsed||!parsed.isValid()){setMsg("Le numéro de téléphone n’est pas valide.");return;}
  if(!/^\d{6}$/.test(otp.trim())){setMsg("Saisissez le code de vérification à 6 chiffres.");return;}
  setBusy(true);
  try{
    const {error}=await supabase.auth.verifyOtp({phone:parsed.number,token:otp.trim(),type:"sms"});
    if(error){setMsg(authErrorMessage(error,"verify"));return;}
    setMsg("Vérification réussie.");
  }catch(e){
    setMsg("Impossible de vérifier le code. Vérifiez votre connexion puis réessayez.");
  }finally{setBusy(false);}
}
async function decide(kind:"accepted"|"refused"|"modification_requested"){if(!supabase||!selected)return;setBusy(true);setMsg("");const action=kind==="accepted"?"accept":kind==="refused"?"refuse":"request_change";const {error}=await supabase.rpc("independent_service_customer_reply",{p_quote:selected.id,p_action:action,p_reason:reason.trim()||null});setBusy(false);if(error){setMsg("Action non validée : "+error.message);return;}setMsg("Votre réponse a été enregistrée.");setSelected(null);setReason("");setAction(null);await load();}
async function logout(){await supabase?.auth.signOut();setQuotes([]);setSession(false)}
return <main><header><div className="brand"><img src="/logo-agricapital-official.png" alt="AgriCapital" /><span>Prestations indépendantes</span></div>{session&&<button className="out" onClick={logout}>Déconnexion</button>}</header>{!session?<section className="panel"><p className="eyebrow">ESPACE CLIENT SÉCURISÉ</p><h1 className="login-title">Consultez et suivez<br className="mobile-title-break"/> vos devis AgriCapital</h1><p className="intro">Accédez à vos devis et transmettez votre décision en toute sécurité.</p><label className="phone-label">N° de téléphone enregistré auprès d’AgriCapital</label><div className="phone-row"><div className="country-picker"><span aria-hidden="true">{countryFlag(country)}</span><select aria-label="Choisir le pays et son indicatif" value={country} onChange={e=>setCountry(e.target.value as CountryCode)} disabled={sent}>{countryOptions.map(c=><option key={c.code} value={c.code}>{c.name} ({c.calling})</option>)}</select></div><input type="tel" inputMode="tel" autoComplete="tel-national" value={localPhone} onChange={e=>setLocalPhone(e.target.value.replace(/[^0-9 ]/g,""))} placeholder="Numéro local" disabled={sent}/></div>{sent&&<><label>Code de vérification</label><input value={otp} onChange={e=>setOtp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="Code reçu sur WhatsApp"/></>}<button disabled={busy||!phone.trim()||(sent&&!otp.trim())} onClick={sent?verify:send}>{busy?"Patientez…":sent?"Vérifier le code":"Recevoir un code sur WhatsApp"}</button>{sent&&<button type="button" className="secondary" disabled={busy} onClick={send}>Renvoyer le code sur WhatsApp</button>}{msg&&<p className="notice">{msg}</p>}</section>:<section className="content"><div className="heading"><div><p className="eyebrow">VOTRE ESPACE</p><h1>Mes devis</h1></div><button className="refresh" onClick={load}>Actualiser</button></div>{msg&&<p className="notice">{msg}</p>}{busy&&<p>Chargement…</p>}{!busy&&!quotes.length&&<p className="empty">Aucun devis accessible pour ce compte.</p>}<div className="cards">{quotes.map(q=><article className="quote" key={q.id}><div className="quotehead"><strong>{q.reference}</strong><span className={"status "+q.status}>{labels[q.status]||q.status}</span></div><p className="amount">{money(q.total_amount)}</p><small>Version {q.version} · Émis le {q.issued_at?new Date(q.issued_at).toLocaleDateString("fr-FR"):"—"}</small><p className="muted">Valable jusqu’au {q.valid_until?new Date(q.valid_until).toLocaleDateString("fr-FR"):"—"}</p><button onClick={()=>setSelected(q)}>Consulter le devis</button></article>)}</div></section>}{selected&&<div className="overlay"><section className="modal"><button className="close" onClick={()=>{setSelected(null);setAction(null);setReason("")}}>×</button><p className="eyebrow">DEVIS · {selected.reference}</p><h2>{money(selected.total_amount)}</h2><p className="muted">Version {selected.version} · {labels[selected.status]||selected.status}</p>{selected.observations&&<p>{selected.observations}</p>}<div className="table">{(selected.items||[]).map((i,n)=><div className="line" key={n}><div><b>{i.designation}</b><small>{i.quantity} {i.unit} × {money(i.unit_price)}</small></div><strong>{money(i.amount)}</strong></div>)}</div><div className="line total"><b>Total</b><strong>{money(selected.total_amount)}</strong></div>{selected.status==="emise"&&<>{action?<><label>{action==="refuse"?"Motif du refus":"Modifications souhaitées"}</label><textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="Expliquez votre demande…" rows={4}/><button disabled={busy||!reason.trim()} onClick={()=>decide(action==="refuse"?"refused":"modification_requested")}>Confirmer</button><button className="secondary" onClick={()=>setAction(null)}>Retour</button></>:<div className="actions"><button disabled={busy} onClick={()=>decide("accepted")}>Accepter</button><button className="secondary" onClick={()=>setAction("change")}>Demander une modification</button><button className="danger" onClick={()=>setAction("refuse")}>Refuser</button></div>}</>}{selected.status!=="emise"&&<p className="notice">Votre réponse ou l’état de traitement est déjà enregistré.</p>}</section></div>}<footer>© AgriCapital SARL · Investir la terre, cultiver l’avenir</footer></main>}