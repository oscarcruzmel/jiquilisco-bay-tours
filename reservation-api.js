const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
const now = () => Math.floor(Date.now() / 1000);
const id = () => crypto.randomUUID();
const enc = new TextEncoder();
const bytesToHex = bytes => [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("");
const randomToken = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
async function digest(value) { return bytesToHex(await crypto.subtle.digest("SHA-256", enc.encode(value))); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return bytesToHex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 210000, hash: "SHA-256" }, key, 256));
}
const safeEqual = (a, b) => { if (!a || a.length !== b.length) return false; let n = 0; for (let i=0;i<a.length;i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i); return n === 0; };
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
function cookieValue(request, name) { return (request.headers.get("Cookie") || "").split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) || ""; }
async function body(request) { try { return await request.json(); } catch { return {}; } }
const bounded = (value, max = 200) => String(value ?? "").trim().slice(0, max);
const dateValid = date => { if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false; const parsed=Date.parse(`${date}T12:00:00Z`); return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===date; };
function departureEpoch(date, time) { return Date.parse(`${date}T${/^\d\d:\d\d$/.test(time) ? time : "06:00"}:00-06:00`) / 1000; }
const tx = db => db.batch;

async function adminFor(request, env) {
  const token = cookieValue(request, "jbt_admin"); if (!token) return null;
  const hash = await digest(token);
  return env.RESERVATIONS_DB.prepare(`SELECT a.* FROM admins a JOIN admin_sessions s ON s.admin_id=a.id WHERE s.token_hash=? AND s.expires_at>? AND a.active=1`).bind(hash, now()).first();
}
async function customerFor(request, env, token = "") {
  const value = token || new URL(request.url).searchParams.get("token") || "";
  if (!value) return null;
  return env.RESERVATIONS_DB.prepare("SELECT * FROM reservations WHERE customer_token_hash=?").bind(await digest(value)).first();
}
function isOwner(admin) { return admin?.role === "owner"; }
const audit = (db, reservationId, actorId, type, details = {}) => db.prepare("INSERT INTO reservation_events (id,reservation_id,actor_id,event_type,details_json,created_at) VALUES (?,?,?,?,?,?)").bind(id(), reservationId, actorId || null, type, JSON.stringify(details), now());

async function settings(db) {
  const rows = await db.prepare("SELECT key,value_json FROM settings").all();
  return Object.fromEntries((rows.results || []).map(r => [r.key, JSON.parse(r.value_json)]));
}
async function sendEmail(env, to, subject, text) {
  if (!env.EMAIL || !to) return { status: "skipped", error: "Email binding or recipient is not configured" };
  try { await env.EMAIL.send({ to, from: env.BOOKING_EMAIL_FROM || "reservations@jiquiliscobay.com", subject, text }); return { status: "sent", error: "" }; }
  catch (error) { return { status: "failed", error: String(error?.message || error).slice(0, 240) }; }
}
async function sendWhatsApp(env, recipient, template, lang, params = []) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !recipient || !template) return { status: "skipped", error: "WhatsApp Cloud API credentials, recipient, or approved template are not configured" };
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: recipient.replace(/\D/g, ""), type: "template", template: { name: template, language: { code: lang === "es" ? "es" : "en_US" }, components: params.length ? [{ type: "body", parameters: params.map(text => ({ type: "text", text: String(text).slice(0, 500) })) }] : [] } })
    });
    if (!response.ok) return { status: "failed", error: `WhatsApp API returned ${response.status}` };
    return { status: "sent", error: "" };
  } catch (error) { return { status: "failed", error: String(error?.message || error).slice(0, 240) }; }
}
async function expireCheckout(env, sessionId) {
  if(!sessionId||!env.STRIPE_SECRET_KEY) return;
  try { await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,{method:"POST",headers:{authorization:`Bearer ${env.STRIPE_SECRET_KEY}`}}); } catch {}
}
async function notify(env, reservation, type, extra = "", suppliedToken = "") {
  const db = env.RESERVATIONS_DB;
  const accessToken = suppliedToken || randomToken();
  if (!suppliedToken) await db.prepare("UPDATE reservations SET customer_token_hash=? WHERE id=?").bind(await digest(accessToken),reservation.id).run();
  const portalUrl = `https://${reservation.language === "es" ? "bahiajiquilisco.com" : "jiquiliscobay.com"}/portal.html?token=${accessToken}`;
  const adminRows = await db.prepare("SELECT whatsapp_phone FROM admins WHERE active=1 AND whatsapp_phone<>''").all();
  const adminTemplate = env.WHATSAPP_ADMIN_TEMPLATE || "";
  const customerTemplate = env.WHATSAPP_CUSTOMER_TEMPLATE || "";
  const title = type.replaceAll("_", " ");
  const content = `${title}: ${reservation.customer_name} · ${reservation.tour_date} ${reservation.start_time} (El Salvador). ${reservation.tour_name}. Ref ${reservation.id.slice(0,8)}. ${extra}\nManage your reservation: ${portalUrl}`.trim();
  for (const a of adminRows.results || []) {
    const result = await sendWhatsApp(env, a.whatsapp_phone, adminTemplate, reservation.language, [title, reservation.customer_name, reservation.tour_date, reservation.start_time, reservation.tour_name, reservation.id.slice(0,8)]);
    await db.prepare("INSERT INTO notification_outbox (id,reservation_id,channel,recipient,template,payload_json,status,error,attempts,created_at,sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id(),reservation.id,"whatsapp",a.whatsapp_phone,adminTemplate,JSON.stringify({type}),result.status,result.error,1,now(),result.status === "sent" ? now() : null).run();
  }
  const email = await sendEmail(env, reservation.customer_email, `Jiquilisco Bay Tours · ${title}`, `${content}\n\nEl Salvador local time (UTC−06:00).`);
  await db.prepare("INSERT INTO notification_outbox (id,reservation_id,channel,recipient,template,payload_json,status,error,attempts,created_at,sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id(),reservation.id,"email",reservation.customer_email,type,JSON.stringify({content}),email.status,email.error,1,now(),email.status === "sent" ? now() : null).run();
  if (reservation.whatsapp_opt_in && reservation.customer_phone) {
    const wa = await sendWhatsApp(env, reservation.customer_phone, customerTemplate, reservation.language, [title, reservation.customer_name, reservation.tour_date, reservation.start_time, reservation.tour_name, portalUrl]);
    await db.prepare("INSERT INTO notification_outbox (id,reservation_id,channel,recipient,template,payload_json,status,error,attempts,created_at,sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id(),reservation.id,"whatsapp",reservation.customer_phone,customerTemplate,JSON.stringify({type}),wa.status,wa.error,1,now(),wa.status === "sent" ? now() : null).run();
  }
}
async function loadReservation(db, reservationId) { return db.prepare("SELECT * FROM reservations WHERE id=?").bind(reservationId).first(); }
async function syncRefundState(db, reservationId) {
  const r=await loadReservation(db,reservationId); if(!r) return;
  const paid=[]; if(r.deposit_paid_at) paid.push("deposit"); if(r.balance_paid_at) paid.push("balance");
  const rows=await db.prepare("SELECT payment_kind,status FROM reservation_refunds WHERE reservation_id=?").bind(reservationId).all();
  const complete=paid.length>0&&paid.every(kind=>(rows.results||[]).some(x=>x.payment_kind===kind&&x.status==="succeeded"));
  await db.prepare("UPDATE reservations SET status=?,updated_at=? WHERE id=?").bind(complete?"refunded":"refund_pending",now(),reservationId).run();
}
function moneyCents(total) { return Math.round(Number(total) * 100); }
async function computePrice(db, input) {
  const cfg = (await settings(db)).pricing || { tours: { explorer:150, mangrove:225, fullday:350, sunset:150 }, atv:{1:35,2:60,4:100}, horse:{30:35,60:50,sunset:65}, guide:{half:25,full:50}, meals:{breakfast:8,lunch:12,dinner:15} };
  const add = input.addons || {};
  const tours=["explorer","mangrove","fullday","sunset",""], hours=[1,2,4], horses=["30","60","sunset",""], guides=["half","full",""];
  if(!tours.includes(input.tour_code)||!hours.includes(Number(add.atv_hours))||!horses.includes(String(add.horse_code||""))||!guides.includes(String(add.guide||""))) throw new Error("Invalid tour or add-on selection.");
  const adults=Math.max(1,Math.min(30,Number(input.adults)||1)), children=Math.max(0,Math.min(30,Number(input.children)||0));
  let total = Number(input.tour_code ? cfg.tours?.[input.tour_code] : 0);
  total += Number(cfg.atv?.[Number(add.atv_hours)] || 0) * Math.max(0,Math.min(2,Number(add.atv_qty)||0));
  total += Number(add.horse_code?cfg.horse?.[add.horse_code]:0) * Math.max(0,Math.min(12,Number(add.horse_riders)||0));
  total += Number(add.guide?cfg.guide?.[add.guide]:0);
  const mealSet=[...new Set(Array.isArray(add.meals)?add.meals:[])]; if(mealSet.some(x=>!["breakfast","lunch","dinner"].includes(x))) throw new Error("Invalid meal selection.");
  for (const meal of mealSet) total += Number(cfg.meals?.[meal] || 0) * (adults + children);
  if(!Number.isFinite(total)||total<0||total>100000) throw new Error("The selected price is invalid.");
  return moneyCents(total);
}
function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ["https://jiquiliscobay.com","https://www.jiquiliscobay.com","https://bahiajiquilisco.com","https://www.bahiajiquilisco.com"];
  return allowed.includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS", "vary": "Origin" } : {};
}

export async function handleReservationApi(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const headers = cors(request);
  if (method === "OPTIONS") return new Response(null,{status:204,headers});
  if (!env.RESERVATIONS_DB) return json({ok:false,error:"Reservation service is not configured yet"},503,headers);
  const db = env.RESERVATIONS_DB;
  try {
    if (path === "/api/reservations" && method === "POST") {
      const x = await body(request); const lang = x.language === "es" ? "es" : "en";
      const name=bounded(x.name,160), email=bounded(x.email,200), phone=bounded(x.phone,32), date=bounded(x.date,10), time=bounded(x.start_time,20) || "unsure";
      if (!name || !/^\S+@\S+\.\S+$/.test(email) || !/^\+?[0-9 ()-]{8,30}$/.test(phone) || !dateValid(date) || !x.tour_name) return json({ok:false,error:"Check your name, email, phone, date and tour selections."},400,headers);
      const adults=Math.max(1,Math.min(30,Number(x.adults)||1)), children=Math.max(0,Math.min(30,Number(x.children)||0));
      if (departureEpoch(date,time) < now()+72*3600) return json({ok:false,error:lang==="es"?"Las reservas requieren al menos 72 horas de anticipación.":"Bookings must be made at least 72 hours in advance."},400,headers);
      const startTime = /^\d\d:\d\d$/.test(time) || time==="sunset" ? time : "unsure";
      const total=await computePrice(db,{...x,addons:x.addons||{}}); if (total <= 0) return json({ok:false,error:"Select a priced tour or add-on."},400,headers);
      const reservationId=id(), token=randomToken(), stamp=now();
      await db.prepare(`INSERT INTO reservations (id,customer_token_hash,customer_name,customer_email,customer_phone,whatsapp_opt_in,language,tour_date,start_time,party_json,tour_name,addons_json,notes,total_cents,status,original_tour_date,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'requested',?,?,?)`)
        .bind(reservationId,await digest(token),name,email,phone,x.whatsapp_opt_in?1:0,lang,date,startTime,JSON.stringify({adults,children}),bounded(x.tour_name,160),JSON.stringify(x.addons||{}),bounded(x.notes,1500),total,date,stamp,stamp).run();
      await audit(db,reservationId,null,"request_created",{language:lang});
      const r=await loadReservation(db,reservationId); await notify(env,r,"booking_request","",token);
      return json({ok:true,id:reservationId,portal_url:`${url.origin}/portal.html?token=${token}`,status:"requested",message:lang==="es"?"Solicitud recibida. Te enviaremos una respuesta cuando el equipo revise la disponibilidad.":"Request received. We’ll send an update after the team checks availability."},201,headers);
    }
    if (path === "/api/reservations/availability" && method === "GET") {
      const month=bounded(url.searchParams.get("month"),7); if (!/^\d{4}-\d{2}$/.test(month)) return json({ok:false,error:"Use a YYYY-MM month."},400,headers);
      const rows=await db.prepare("SELECT tour_date FROM reserved_dates WHERE tour_date LIKE ? ORDER BY tour_date").bind(`${month}-%`).all();
      return json({ok:true,busy:(rows.results||[]).map(x=>x.tour_date)},200,headers);
    }
    if (path === "/api/reservations/config" && method === "GET") {
      const cfg=await settings(db); return json({ok:true,pricing:cfg.pricing||{tours:{explorer:150,mangrove:225,fullday:350,sunset:150},atv:{1:35,2:60,4:100},horse:{30:35,60:50,sunset:65},guide:{half:25,full:50},meals:{breakfast:8,lunch:12,dinner:15}},policies:cfg.policies||{deposit_percent:25,reschedule_notice_hours:72,reschedule_credit_days:90,balance_due_hours:24}},200,headers);
    }
    if (path === "/api/admin/setup" && method === "POST") {
      if (!env.ADMIN_SETUP_TOKEN) return json({ok:false,error:"Owner setup is disabled until ADMIN_SETUP_TOKEN is configured."},503,headers);
      const existing=await db.prepare("SELECT COUNT(*) n FROM admins").first(); if (Number(existing?.n)) return json({ok:false,error:"Setup has already been completed."},409,headers);
      const x=await body(request), setup=bounded(request.headers.get("x-setup-token"),500), email=bounded(x.email,200).toLowerCase(), name=bounded(x.name,160), password=String(x.password||"");
      if (!safeEqual(setup,env.ADMIN_SETUP_TOKEN) || !/^\S+@\S+\.\S+$/.test(email) || password.length<12 || name.length<2 || !/^\+?[0-9 ()-]{8,30}$/.test(bounded(x.phone,32))) return json({ok:false,error:"Valid setup token, name, email, WhatsApp phone, and a 12-character password are required."},400,headers);
      const salt=randomToken(), aid=id(); await db.prepare("INSERT INTO admins(id,email,name,whatsapp_phone,password_hash,password_salt,role,can_manage_bookings) VALUES(?,?,?,?,?,?,'owner',1)").bind(aid,email,name,bounded(x.phone,32),await passwordHash(password,salt),salt).run();
      const token=randomToken(); await db.prepare("INSERT INTO admin_sessions(token_hash,admin_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await digest(token),aid,now()+12*3600,now()).run();
      return json({ok:true,admin:{id:aid,email,name,role:"owner"}},200,{...headers,"set-cookie":cookie("jbt_admin",token,12*3600)});
    }
    if (path === "/api/admin/login" && method === "POST") {
      const x=await body(request), email=bounded(x.email,200).toLowerCase(); const a=await db.prepare("SELECT * FROM admins WHERE email=? AND active=1").bind(email).first();
      if (!a || !safeEqual(await passwordHash(String(x.password||""),a.password_salt),a.password_hash)) return json({ok:false,error:"Email or password is incorrect."},401,headers);
      const token=randomToken(); await db.prepare("INSERT INTO admin_sessions(token_hash,admin_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await digest(token),a.id,now()+12*3600,now()).run();
      return json({ok:true,admin:{id:a.id,email:a.email,name:a.name,role:a.role,can_manage_bookings:!!a.can_manage_bookings}},200,{...headers,"set-cookie":cookie("jbt_admin",token,12*3600)});
    }
    if (path === "/api/admin/logout" && method === "POST") {
      const token=cookieValue(request,"jbt_admin"); if(token) await db.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await digest(token)).run();
      return json({ok:true},200,{...headers,"set-cookie":cookie("jbt_admin","",0)});
    }
    if (path === "/api/admin/session" && method === "GET") {
      const a=await adminFor(request,env); return a?json({ok:true,admin:{id:a.id,email:a.email,name:a.name,role:a.role,can_manage_bookings:!!a.can_manage_bookings}},200,headers):json({ok:false},401,headers);
    }
    const admin = path.startsWith("/api/admin/") ? await adminFor(request,env) : null;
    if (path.startsWith("/api/admin/") && !admin && path!=="/api/admin/invitations/accept") return json({ok:false,error:"Sign in is required."},401,headers);
    if (path === "/api/admin/reservations" && method === "GET") {
      if (!admin.can_manage_bookings && !isOwner(admin)) return json({ok:false,error:"Booking access is disabled."},403,headers);
      const rows=await db.prepare("SELECT * FROM reservations ORDER BY CASE status WHEN 'requested' THEN 0 WHEN 'alternative_offered' THEN 1 ELSE 2 END, tour_date ASC LIMIT 300").all();
      return json({ok:true,reservations:rows.results||[]},200,headers);
    }
    if (path === "/api/admin/settings" && method === "GET") return json({ok:true,settings:await settings(db),owner:isOwner(admin)},200,headers);
    if (path === "/api/admin/settings" && method === "POST") {
      if (!isOwner(admin)) return json({ok:false,error:"Owner access is required."},403,headers);
      const x=await body(request); const allowed=["pricing","policies"];
      if(x.pricing){const map={tours:["explorer","mangrove","fullday","sunset"],atv:["1","2","4"],horse:["30","60","sunset"],guide:["half","full"],meals:["breakfast","lunch","dinner"]};for(const [group,keys]of Object.entries(map)){if(!x.pricing[group]||typeof x.pricing[group]!=="object"||keys.some(k=>!Number.isFinite(Number(x.pricing[group][k]))||Number(x.pricing[group][k])<0||Number(x.pricing[group][k])>100000))return json({ok:false,error:`Enter valid nonnegative USD prices for ${group}.`},400,headers)}}
      if(x.policies){for(const [key,min,max]of [["deposit_percent",5,100],["reschedule_notice_hours",72,720],["reschedule_credit_days",90,365],["balance_due_hours",24,720]])if(!Number.isFinite(Number(x.policies[key]))||Number(x.policies[key])<min||Number(x.policies[key])>max)return json({ok:false,error:`Policy ${key} must be between ${min} and ${max}.`},400,headers);if(typeof x.policies.customer_deposit_refundable!=="boolean")return json({ok:false,error:"Set customer_deposit_refundable to true or false."},400,headers)}
      const statements=[]; for(const key of allowed) if(x[key]) statements.push(db.prepare("INSERT INTO settings(key,value_json,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by").bind(key,JSON.stringify(x[key]),now(),admin.id));
      if(statements.length) await db.batch(statements); return json({ok:true,settings:await settings(db)},200,headers);
    }
    if (path === "/api/admin/invitations" && method === "POST") {
      if(!isOwner(admin)) return json({ok:false,error:"Owner access is required."},403,headers);
      const x=await body(request), email=bounded(x.email,200).toLowerCase(), name=bounded(x.name,160), phone=bounded(x.phone,32);
      if(!/^\S+@\S+\.\S+$/.test(email)||!name) return json({ok:false,error:"Name and valid email are required."},400,headers);
      const token=randomToken(), expires=now()+7*86400;
      await db.prepare("INSERT INTO invitations(token_hash,email,name,whatsapp_phone,created_by,expires_at) VALUES(?,?,?,?,?,?)").bind(await digest(token),email,name,phone,admin.id,expires).run();
      const link=`${url.origin}/admin.html#invite=${token}`;
      const sent=await sendEmail(env,email,"Jiquilisco Bay Tours staff account",`Hello ${name},\n\nSet your staff account password here (link valid for 7 days):\n${link}\n\nUse a unique password of at least 12 characters.`);
      return json({ok:true,email_sent:sent.status==="sent",invitation_url:sent.status==="sent"?"":link,message:sent.status==="sent"?"Invitation sent.":"Invitation created, but email delivery is not configured; copy the invitation link below."},201,headers);
    }
    if(path==="/api/admin/invitations/accept" && method==="POST") {
      const x=await body(request), token=bounded(x.token,200), password=String(x.password||""); if(password.length<12) return json({ok:false,error:"Use a password of at least 12 characters."},400,headers);
      const inv=await db.prepare("SELECT * FROM invitations WHERE token_hash=? AND expires_at>? AND used_at IS NULL").bind(await digest(token),now()).first(); if(!inv) return json({ok:false,error:"Invitation is invalid or expired."},400,headers);
      const salt=randomToken(), aid=id(); const cmds=[db.prepare("INSERT INTO admins(id,email,name,whatsapp_phone,password_hash,password_salt,role,can_manage_bookings) VALUES(?,?,?,?,?,?,'staff',1)").bind(aid,inv.email,inv.name,inv.whatsapp_phone,await passwordHash(password,salt),salt),db.prepare("UPDATE invitations SET used_at=? WHERE token_hash=? AND used_at IS NULL").bind(now(),await digest(token))]; await db.batch(cmds);
      const session=randomToken(); await db.prepare("INSERT INTO admin_sessions(token_hash,admin_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await digest(session),aid,now()+12*3600,now()).run();
      return json({ok:true},200,{...headers,"set-cookie":cookie("jbt_admin",session,12*3600)});
    }
    if(path==="/api/admin/users" && method==="GET") {
      if(!isOwner(admin)) return json({ok:false,error:"Owner access is required."},403,headers);
      const rows=await db.prepare("SELECT id,email,name,whatsapp_phone,role,can_manage_bookings,active,created_at FROM admins ORDER BY role,email").all(); return json({ok:true,users:rows.results||[]},200,headers);
    }
    const userMatch=path.match(/^\/api\/admin\/users\/([^/]+)$/);
    if(userMatch&&method==="POST") {
      if(!isOwner(admin)) return json({ok:false,error:"Owner access is required."},403,headers);
      if(userMatch[1]===admin.id) return json({ok:false,error:"Use account security settings to change your own access."},400,headers);
      const x=await body(request); await db.prepare("UPDATE admins SET can_manage_bookings=?,active=? WHERE id=? AND role='staff'").bind(x.can_manage_bookings?1:0,x.active===false?0:1,userMatch[1]).run(); return json({ok:true},200,headers);
    }
    const match=path.match(/^\/api\/admin\/reservations\/([^/]+)\/action$/);
    if(match&&method==="POST") {
      if(!admin.can_manage_bookings&&!isOwner(admin)) return json({ok:false,error:"Booking access is disabled."},403,headers);
      const x=await body(request), reservation=await loadReservation(db,match[1]); if(!reservation) return json({ok:false,error:"Reservation not found."},404,headers);
      const stamp=now(), action=bounded(x.action,30); let stmts=[];
      if(action==="approve") {
        let offer={}; try { offer=JSON.parse(reservation.customer_message||"{}"); } catch {}
        const date=offer.reschedule?offer.date:reservation.tour_date;
        if(departureEpoch(date,reservation.start_time)<stamp+24*3600) return json({ok:false,error:"Approval must leave at least 24 hours before departure so payment can be completed."},409,headers);
        if(offer.reschedule || offer.operator_reschedule) {
          const currentStatus=reservation.balance_paid_at?"confirmed":"deposit_paid";
          const reserved=offer.operator_reschedule?db.prepare("INSERT INTO reserved_dates(tour_date,reservation_id,created_at) VALUES(?,?,?) ON CONFLICT(reservation_id) DO UPDATE SET tour_date=excluded.tour_date").bind(date,reservation.id,stamp):db.prepare("UPDATE reserved_dates SET tour_date=? WHERE reservation_id=?").bind(date,reservation.id);
          stmts=[reserved,db.prepare("UPDATE reservations SET tour_date=?,status=?,reschedule_used=CASE WHEN ? THEN reschedule_used ELSE 1 END,reschedule_credit_until=CASE WHEN ? THEN reschedule_credit_until ELSE date(original_tour_date,'+90 days') END,balance_due_at=?,customer_message='',updated_at=? WHERE id=? AND status='alternative_offered'").bind(date,currentStatus,offer.operator_reschedule?1:0,offer.operator_reschedule?1:0,departureEpoch(date,reservation.start_time)-86400,stamp,reservation.id),audit(db,reservation.id,admin.id,offer.operator_reschedule?"operator_reschedule_approved":"reschedule_approved",{date})];
        } else {
          const policy=(await settings(db)).policies||{}; const percent=Math.max(1,Math.min(100,Number(policy.deposit_percent)||25)); const deposit=Math.round(reservation.total_cents*percent/100); const dueHours=Math.max(24,Number(policy.balance_due_hours)||24);
          stmts=[db.prepare("INSERT INTO reserved_dates(tour_date,reservation_id,created_at) VALUES(?,?,?)").bind(date,reservation.id,stamp),db.prepare("UPDATE reservations SET status='approved',deposit_cents=?,balance_cents=?,balance_due_at=?,updated_at=? WHERE id=? AND status IN ('requested','alternative_offered')").bind(deposit,reservation.total_cents-deposit,departureEpoch(date,reservation.start_time)-dueHours*3600,stamp,reservation.id),audit(db,reservation.id,admin.id,"approved",{date,deposit_percent:percent})];
        }
      } else if(action==="decline") {
        let offer={};try{offer=JSON.parse(reservation.customer_message||"{}")}catch{};const restored=offer.operator_reschedule?"operator_cancelled":offer.reschedule?(offer.prior_status||(reservation.balance_paid_at?"confirmed":"deposit_paid")):"declined";
        stmts=[db.prepare("UPDATE reservations SET status=?,customer_message=?,updated_at=? WHERE id=? AND status IN ('requested','alternative_offered')").bind(restored,bounded(x.message,500),stamp,reservation.id),...(offer.operator_reschedule?[db.prepare("DELETE FROM reserved_dates WHERE reservation_id=?").bind(reservation.id)]:[]),audit(db,reservation.id,admin.id,"declined",{message:bounded(x.message,500),restored_status:restored})];
      } else if(action==="alternative") {
        const date=bounded(x.date,10); if(!dateValid(date)||date===reservation.tour_date||departureEpoch(date,reservation.start_time)<stamp+72*3600) return json({ok:false,error:"Choose an alternative date at least 72 hours ahead."},400,headers);
        let prior={};try{prior=JSON.parse(reservation.customer_message||"{}")}catch{};const offer={date,message:bounded(x.message,500)};if(prior.reschedule||prior.operator_reschedule){offer.reschedule=!!prior.reschedule;offer.operator_reschedule=!!prior.operator_reschedule;offer.prior_status=prior.prior_status||(reservation.balance_paid_at?"confirmed":"deposit_paid")}
        stmts=[db.prepare("UPDATE reservations SET status='alternative_offered',customer_message=?,updated_at=? WHERE id=? AND status IN ('requested','alternative_offered')").bind(JSON.stringify(offer),stamp,reservation.id),audit(db,reservation.id,admin.id,"alternative_offered",{date,message:bounded(x.message,500)})];
      } else if(action==="operator_cancel") {
        const resolution=x.resolution;
        if(!["refund","reschedule"].includes(resolution)) return json({ok:false,error:"Choose refund or reschedule for an operator cancellation."},400,headers);
        if(resolution==="refund") {
          await Promise.all([expireCheckout(env,reservation.stripe_deposit_session),expireCheckout(env,reservation.stripe_balance_session)]);
          stmts=[db.prepare("UPDATE reservations SET status='operator_cancelled',customer_message='Operator cancellation: full refund or rescheduling is available.',updated_at=? WHERE id=?").bind(stamp,reservation.id),db.prepare("DELETE FROM reserved_dates WHERE reservation_id=?").bind(reservation.id),audit(db,reservation.id,admin.id,"operator_cancelled_refund_option",{})];
        } else {
          const date=bounded(x.date,10); if(!dateValid(date)||date===reservation.tour_date||departureEpoch(date,reservation.start_time)<stamp+72*3600) return json({ok:false,error:"Choose a different alternative date at least 72 hours ahead."},400,headers);
          await expireCheckout(env,reservation.stripe_balance_session);
          stmts=[db.prepare("UPDATE reservations SET status='alternative_offered',customer_message=?,updated_at=? WHERE id=?").bind(JSON.stringify({date,operator_reschedule:true,prior_status:reservation.status}),stamp,reservation.id),audit(db,reservation.id,admin.id,"operator_reschedule_offered",{date})];
        }
      } else return json({ok:false,error:"Action must be approve, decline, or alternative."},400,headers);
      try { await db.batch(stmts); } catch(error) { if(action==="approve" && /UNIQUE|constraint/i.test(String(error))) return json({ok:false,error:"That date was just booked. Choose an alternative date."},409,headers); throw error; }
      const updated=await loadReservation(db,reservation.id); await notify(env,updated,`booking_${action}`,x.message||"");
      return json({ok:true,reservation:updated},200,headers);
    }
    const refundMatch=path.match(/^\/api\/admin\/reservations\/([^/]+)\/refund$/);
    if(refundMatch&&method==="POST") {
      if(!isOwner(admin)) return json({ok:false,error:"Only the owner can issue refunds."},403,headers);
      if(!env.STRIPE_SECRET_KEY) return json({ok:false,error:"Stripe is not configured yet."},503,headers);
      const r=await loadReservation(db,refundMatch[1]); if(!r) return json({ok:false,error:"Reservation not found."},404,headers);
      const x=await body(request), paymentKind=x.kind==="balance"?"balance":"deposit", sessionId=paymentKind==="balance"?r.stripe_balance_session:r.stripe_deposit_session;
      const refundPolicy=(await settings(db)).policies||{};const customerRefundAllowed=r.status==="cancelled"&&refundPolicy.customer_deposit_refundable===true&&x?.kind==="deposit";
      if(r.status!=="operator_cancelled"&&r.status!=="refund_pending"&&!customerRefundAllowed) return json({ok:false,error:"Refunds are available for operator cancellations, or for eligible customer cancellations set by the owner."},409,headers);
      if(!sessionId) return json({ok:false,error:"No paid Stripe checkout session exists for this payment."},409,headers);
      const sessionRes=await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent`,{headers:{authorization:`Bearer ${env.STRIPE_SECRET_KEY}`}}); if(!sessionRes.ok) return json({ok:false,error:"Unable to retrieve the Stripe payment."},502,headers);
      const session=await sessionRes.json(), paymentIntent=typeof session.payment_intent==="string"?session.payment_intent:session.payment_intent?.id;
      if(!paymentIntent||!session.payment_status||session.payment_status!=="paid") return json({ok:false,error:"Stripe does not show this payment as paid."},409,headers);
      const form=new URLSearchParams({payment_intent:paymentIntent,reason:"requested_by_customer"}); const refundRes=await fetch("https://api.stripe.com/v1/refunds",{method:"POST",headers:{authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,"content-type":"application/x-www-form-urlencoded","idempotency-key":`jbt-refund-${r.id}-${paymentKind}`},body:form}); if(!refundRes.ok) return json({ok:false,error:"Stripe could not issue the refund."},502,headers);
      const refund=await refundRes.json(); await db.prepare("INSERT INTO reservation_refunds(id,reservation_id,payment_kind,amount_cents,status,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(reservation_id,payment_kind) DO UPDATE SET id=excluded.id,amount_cents=excluded.amount_cents,status=excluded.status").bind(refund.id,r.id,paymentKind,Number(refund.amount)||0,refund.status||"pending",now()).run();
      await db.prepare("UPDATE reservations SET status='refund_pending',updated_at=? WHERE id=?").bind(now(),r.id).run(); await audit(db,r.id,admin.id,"stripe_refund_created",{refund_id:refund.id,kind:paymentKind});
      if(refund.status==="succeeded") await syncRefundState(db,r.id);
      return json({ok:true,refund_id:refund.id,status:refund.status},200,headers);
    }
    if(path==="/api/reservations/portal"&&method==="GET") {
      const r=await customerFor(request,env); if(!r) return json({ok:false,error:"Reservation link is invalid."},404,headers);
      const {customer_token_hash,...visible}=r; return json({ok:true,reservation:visible},200,headers);
    }
    if(path==="/api/reservations/portal/action"&&method==="POST") {
      const x=await body(request), r=await customerFor(request,env,x.token); if(!r) return json({ok:false,error:"Reservation link is invalid."},404,headers);
      const action=bounded(x.action,30), stamp=now();
      if(action==="accept_alternative") {
        if(r.status!=="alternative_offered") return json({ok:false,error:"There is no alternative date awaiting your response."},409,headers);
        let offer={}; try{offer=JSON.parse(r.customer_message)}catch{}; const date=offer.date; if(!dateValid(date)) return json({ok:false,error:"Alternative date is invalid."},409,headers);
        if(offer.operator_reschedule) {
          const prior=offer.prior_status||"confirmed";
          try { await db.batch([db.prepare("UPDATE reservations SET tour_date=?,status=?,customer_message='',updated_at=? WHERE id=? AND status='alternative_offered'").bind(date,prior,stamp,r.id),db.prepare("INSERT INTO reserved_dates(tour_date,reservation_id,created_at) VALUES(?,?,?) ON CONFLICT(reservation_id) DO UPDATE SET tour_date=excluded.tour_date").bind(date,r.id,stamp),audit(db,r.id,null,"operator_reschedule_accepted",{date})]); }
          catch(error){if(/UNIQUE|constraint/i.test(String(error))) return json({ok:false,error:"That date is no longer available. Contact the team."},409,headers);throw error;}
          const updated=await loadReservation(db,r.id); await notify(env,updated,"operator_reschedule_accepted","No additional deposit is due.",x.token); return json({ok:true,status:updated.status},200,headers);
        }
        if(offer.reschedule) {
          const prior=offer.prior_status||(r.balance_paid_at?"confirmed":"deposit_paid");
          try{await db.batch([db.prepare("UPDATE reservations SET tour_date=?,status=?,reschedule_used=1,reschedule_credit_until=date(original_tour_date,'+90 days'),customer_message='',balance_due_at=?,updated_at=? WHERE id=? AND status='alternative_offered'").bind(date,prior,departureEpoch(date,r.start_time)-86400,stamp,r.id),db.prepare("UPDATE reserved_dates SET tour_date=? WHERE reservation_id=?").bind(date,r.id),audit(db,r.id,null,"reschedule_alternative_accepted",{date})])}catch(error){if(/UNIQUE|constraint/i.test(String(error)))return json({ok:false,error:"That date is no longer available. Contact the team."},409,headers);throw error}
          const updated=await loadReservation(db,r.id);await notify(env,updated,"reschedule_alternative_accepted","No additional deposit is due.",x.token);return json({ok:true,status:updated.status},200,headers)
        }
        const policy=(await settings(db)).policies||{}; const percent=Math.max(1,Math.min(100,Number(policy.deposit_percent)||25)); const deposit=Math.round(r.total_cents*percent/100); const dueHours=Math.max(24,Number(policy.balance_due_hours)||24);
        try { await db.batch([db.prepare("UPDATE reservations SET tour_date=?,status='approved',deposit_cents=?,balance_cents=?,balance_due_at=?,customer_message='',updated_at=? WHERE id=? AND status='alternative_offered'").bind(date,deposit,r.total_cents-deposit,departureEpoch(date,r.start_time)-dueHours*3600,stamp,r.id),db.prepare("INSERT INTO reserved_dates(tour_date,reservation_id,created_at) VALUES(?,?,?)").bind(date,r.id,stamp),audit(db,r.id,null,"alternative_accepted",{date})]); }
        catch(error){if(/UNIQUE|constraint/i.test(String(error))) return json({ok:false,error:"That date is no longer available. Contact the team."},409,headers);throw error;}
        const updated=await loadReservation(db,r.id); await notify(env,updated,"booking_alternative_accepted","",x.token); return json({ok:true,status:updated.status},200,headers);
      }
      if(action==="cancel") {
        if(["cancelled","declined","refunded"].includes(r.status)) return json({ok:true,status:r.status},200,headers);
        if(r.status==="requested"||r.status==="alternative_offered") {
          let offer={};try{offer=JSON.parse(r.customer_message||"{}")}catch{}
          if(offer.operator_reschedule){await db.batch([db.prepare("UPDATE reservations SET status='operator_cancelled',customer_message='Customer declined operator rescheduling; full refund or another reschedule is available.',updated_at=? WHERE id=?").bind(stamp,r.id),db.prepare("DELETE FROM reserved_dates WHERE reservation_id=?").bind(r.id),audit(db,r.id,null,"customer_declined_operator_reschedule",{})]);const updated=await loadReservation(db,r.id);await notify(env,updated,"customer_declined_operator_reschedule","The operator cancellation refund policy applies.",x.token);return json({ok:true,status:"operator_cancelled",deposit_refundable:true},200,headers)}
          if(r.status==="alternative_offered") await Promise.all([expireCheckout(env,r.stripe_deposit_session),expireCheckout(env,r.stripe_balance_session)]);
          await db.batch([db.prepare("UPDATE reservations SET status='cancelled',updated_at=? WHERE id=?").bind(stamp,r.id),db.prepare("DELETE FROM reserved_dates WHERE reservation_id=?").bind(r.id),audit(db,r.id,null,"customer_cancelled",{deposit_nonrefundable:!!r.deposit_paid_at})]);const updated=await loadReservation(db,r.id);await notify(env,updated,"customer_cancelled","The 25% deposit is nonrefundable for customer cancellations.",x.token);return json({ok:true,status:"cancelled",deposit_refundable:false},200,headers);
        }
        if(r.status==="confirmed"||r.status==="deposit_paid"||r.status==="approved") {
          if(departureEpoch(r.tour_date,r.start_time)<=stamp) return json({ok:false,error:"This departure has already started."},409,headers);
          await Promise.all([expireCheckout(env,r.stripe_deposit_session),expireCheckout(env,r.stripe_balance_session)]);
          await db.batch([db.prepare("UPDATE reservations SET status='cancelled',updated_at=? WHERE id=?").bind(stamp,r.id),db.prepare("DELETE FROM reserved_dates WHERE reservation_id=?").bind(r.id),audit(db,r.id,null,"customer_cancelled",{deposit_nonrefundable:true})]);
          const updated=await loadReservation(db,r.id); await notify(env,updated,"customer_cancelled","The 25% deposit is nonrefundable for customer cancellations.",x.token); return json({ok:true,status:"cancelled",deposit_refundable:false},200,headers);
        }
        return json({ok:false,error:"This reservation cannot be cancelled in its current status."},409,headers);
      }
      if(action==="reschedule") {
        const date=bounded(x.date,10), policy=(await settings(db)).policies||{}, notice=Math.max(72,Number(policy.reschedule_notice_hours)||72), creditDays=Math.max(90,Number(policy.reschedule_credit_days)||90);
        if(!["confirmed","deposit_paid"].includes(r.status)||r.reschedule_used||!r.deposit_paid_at||!dateValid(date)||date===r.tour_date) return json({ok:false,error:"Rescheduling is available once after the deposit has been paid; select a different date."},409,headers);
        if(departureEpoch(r.tour_date,r.start_time)-stamp<notice*3600) return json({ok:false,error:`Rescheduling must be requested at least ${notice} hours before departure. Contact the team for help.`},409,headers);
        if(Date.parse(`${date}T00:00:00-06:00`)>Date.parse(`${r.original_tour_date}T00:00:00-06:00`)+creditDays*86400*1000) return json({ok:false,error:`The new tour date must be within ${creditDays} days of the original date.`},400,headers);
        if(departureEpoch(date,r.start_time)<stamp+notice*3600) return json({ok:false,error:`Choose a new date at least ${notice} hours ahead.`},400,headers);
        await expireCheckout(env,r.stripe_balance_session);
        await db.prepare("UPDATE reservations SET status='alternative_offered',customer_message=?,updated_at=? WHERE id=?").bind(JSON.stringify({date,reschedule:true,prior_status:r.status}),stamp,r.id).run(); await audit(db,r.id,null,"reschedule_requested",{date}); const updated=await loadReservation(db,r.id); await notify(env,updated,"reschedule_requested","",x.token); return json({ok:true,status:updated.status},200,headers);
      }
      if(action==="request_operator_refund") {
        if(r.status!=="operator_cancelled") return json({ok:false,error:"A full refund is available only after an operator cancellation."},409,headers);
        await db.prepare("UPDATE reservations SET status='refund_pending',customer_message='Customer requested the operator-cancellation refund.',updated_at=? WHERE id=?").bind(stamp,r.id).run(); await audit(db,r.id,null,"operator_refund_requested",{}); const updated=await loadReservation(db,r.id); await notify(env,updated,"operator_refund_requested","Your refund request was sent to the owner for processing.",x.token); return json({ok:true,status:"refund_pending"},200,headers);
      }
      if(action==="request_operator_reschedule") {
        if(r.status!=="operator_cancelled") return json({ok:false,error:"Operator rescheduling is available only after an operator cancellation."},409,headers);
        const date=bounded(x.date,10); if(!dateValid(date)||date===r.tour_date||departureEpoch(date,r.start_time)<stamp+72*3600) return json({ok:false,error:"Choose a different date at least 72 hours ahead."},400,headers);
        const prior=r.balance_paid_at?"confirmed":"deposit_paid";
        await expireCheckout(env,r.stripe_balance_session);
        await db.prepare("UPDATE reservations SET status='alternative_offered',customer_message=?,updated_at=? WHERE id=?").bind(JSON.stringify({date,operator_reschedule:true,customer_requested:true,prior_status:prior}),stamp,r.id).run(); await audit(db,r.id,null,"operator_reschedule_requested",{date}); const updated=await loadReservation(db,r.id); await notify(env,updated,"operator_reschedule_requested","",x.token); return json({ok:true,status:updated.status},200,headers);
      }
      return json({ok:false,error:"Unknown action."},400,headers);
    }
    if(path==="/api/payments/checkout"&&method==="POST") {
      const x=await body(request), r=await customerFor(request,env,x.token); if(!r) return json({ok:false,error:"Reservation link is invalid."},404,headers);
      if(!env.STRIPE_SECRET_KEY) return json({ok:false,error:"Stripe is not configured yet."},503,headers);
      const mode=x.kind==="balance"?"balance":"deposit"; if(mode==="deposit"&&r.status!=="approved") return json({ok:false,error:"The deposit link is available after approval."},409,headers);
      if(mode==="balance"&&(r.status!=="deposit_paid"||!r.balance_cents)) return json({ok:false,error:"The balance is not due yet."},409,headers);
      if(mode==="balance"&&r.balance_due_at&&now()>r.balance_due_at) return json({ok:false,error:"The balance deadline has passed. Contact the team."},409,headers);
      const existing=mode==="deposit"?r.stripe_deposit_session:r.stripe_balance_session;
      if(existing){try{const old=await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(existing)}`,{headers:{authorization:`Bearer ${env.STRIPE_SECRET_KEY}`}});if(old.ok){const session=await old.json();if(session.status==="open"&&session.url)return json({ok:true,url:session.url},200,headers)}}catch{}}
      const amount=mode==="deposit"?r.deposit_cents:r.balance_cents, form=new URLSearchParams({mode:"payment",success_url:`${url.origin}/portal.html?token=${x.token}&payment=success`,cancel_url:`${url.origin}/portal.html?token=${x.token}&payment=cancelled`,customer_email:r.customer_email,"line_items[0][price_data][currency]":"usd","line_items[0][price_data][unit_amount]":String(amount),"line_items[0][price_data][product_data][name]":mode==="deposit"?"Jiquilisco Bay Tours reservation deposit":"Jiquilisco Bay Tours remaining balance","metadata[reservation_id]":r.id,"metadata[payment_kind]":mode} );
      const res=await fetch("https://api.stripe.com/v1/checkout/sessions",{method:"POST",headers:{authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,"content-type":"application/x-www-form-urlencoded"},body:form}); if(!res.ok) return json({ok:false,error:"Unable to create Stripe checkout session."},502,headers); const data=await res.json();
      const field=mode==="deposit"?"stripe_deposit_session":"stripe_balance_session"; await db.prepare(`UPDATE reservations SET ${field}=?,updated_at=? WHERE id=?`).bind(data.id,now(),r.id).run(); return json({ok:true,url:data.url},200,headers);
    }
    if(path==="/api/payments/webhook"&&method==="POST") {
      if(!env.STRIPE_WEBHOOK_SECRET) return json({ok:false,error:"Stripe webhook is not configured."},503,headers);
      const sig=request.headers.get("stripe-signature")||"", raw=await request.text(), bits=Object.fromEntries(sig.split(",").map(p=>p.split("="))), timestamp=bits.t, v1=bits.v1;
      if(!timestamp||!v1||Math.abs(now()-Number(timestamp))>300) return json({ok:false,error:"Invalid webhook signature."},400,headers);
      const key=await crypto.subtle.importKey("raw",enc.encode(env.STRIPE_WEBHOOK_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]); const signed=bytesToHex(await crypto.subtle.sign("HMAC",key,enc.encode(`${timestamp}.${raw}`))); if(!safeEqual(signed,v1)) return json({ok:false,error:"Invalid webhook signature."},400,headers);
      const event=JSON.parse(raw); if(event.type==="checkout.session.completed") {
        const s=event.data.object, rid=s.metadata?.reservation_id, kind=s.metadata?.payment_kind, r=await loadReservation(db,rid); if(r) {
          let change=null;
          if(kind==="deposit") change=await db.prepare("UPDATE reservations SET status='deposit_paid',deposit_paid_at=?,updated_at=? WHERE id=? AND status='approved'").bind(now(),now(),r.id).run();
          if(kind==="balance") change=await db.prepare("UPDATE reservations SET status='confirmed',balance_paid_at=?,updated_at=? WHERE id=? AND status='deposit_paid'").bind(now(),now(),r.id).run();
          if(change?.meta?.changes){const updated=await loadReservation(db,r.id); await audit(db,r.id,null,`${kind}_payment_paid`,{stripe_session:s.id}); await notify(env,updated,`${kind}_payment_paid`)}
        }
      }
      if(["refund.updated","refund.failed"].includes(event.type)) {
        const refund=event.data.object; await db.prepare("UPDATE reservation_refunds SET status=? WHERE id=?").bind(refund.status||"failed",refund.id).run(); const link=await db.prepare("SELECT reservation_id FROM reservation_refunds WHERE id=?").bind(refund.id).first(); if(link) await syncRefundState(db,link.reservation_id);
      }
      await db.prepare("INSERT INTO stripe_webhook_events(event_id,event_type,received_at) VALUES(?,?,?) ON CONFLICT(event_id) DO NOTHING").bind(event.id,event.type,now()).run();
      return json({received:true},200,headers);
    }
    return json({ok:false,error:"Not found."},404,headers);
  } catch(error) {
    console.error("reservation api failure",error);
    return json({ok:false,error:"The reservation service hit an unexpected error."},500,headers);
  }
}

export async function runReservationReminders(env) {
  if(!env.RESERVATIONS_DB) return;
  const db=env.RESERVATIONS_DB, stamp=now();
  await db.batch([db.prepare("DELETE FROM admin_sessions WHERE expires_at<?").bind(stamp),db.prepare("DELETE FROM invitations WHERE expires_at<? OR used_at IS NOT NULL").bind(stamp-30*86400)]);
  const balances=await db.prepare("SELECT * FROM reservations WHERE status='deposit_paid' AND balance_due_at BETWEEN ? AND ? AND balance_cents>0 AND balance_reminder_sent_at IS NULL").bind(stamp,stamp+26*3600).all();
  for(const r of balances.results||[]) { await notify(env,r,"balance_due_reminder"); await db.prepare("UPDATE reservations SET balance_reminder_sent_at=?,updated_at=? WHERE id=?").bind(stamp,stamp,r.id).run(); }
  const due=await db.prepare("SELECT * FROM reservations WHERE status='confirmed' AND trip_reminder_sent_at IS NULL").all();
  for(const r of due.results||[]) { const departure=departureEpoch(r.tour_date,r.start_time); if(departure>=stamp+23*3600&&departure<=stamp+25*3600) { await notify(env,r,"tour_departure_reminder"); await db.prepare("UPDATE reservations SET trip_reminder_sent_at=?,updated_at=? WHERE id=?").bind(stamp,stamp,r.id).run(); } }
}
