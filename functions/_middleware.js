// Inicio de sesión con Google para todo el Hub (web, API y vistas previas).
//
// Variables (secretos de Pages, producción y vista previa):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  cliente OAuth "Aplicación web" de Google Cloud
//   SESSION_SECRET                          clave aleatoria para firmar la cookie
//   ALLOWED_EMAILS                          correos permitidos, separados por comas
//
// Si falta alguna, el Hub queda cerrado (503).

const PROD_HOST = "teknobrawl-hub.pages.dev";
const SESSION_COOKIE = "hub_session";
const OAUTH_COOKIE = "hub_oauth";
const SESSION_DAYS = 90;   // duración de la sesión
const RENEW_DAYS = 60;     // si quedan menos días, se renueva sola al usar el Hub

export async function onRequest(ctx) {
  const { request, env, next } = ctx;
  const url = new URL(request.url);

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET || !env.ALLOWED_EMAILS) {
    return page(503, "Hub cerrado", "El inicio de sesión no está configurado.");
  }

  switch (url.pathname) {
    case "/auth/login": return login(url, env);
    case "/auth/callback": return callback(request, url, env);
    case "/auth/logout": return logout(url);
  }

  // Manifest e iconos de la PWA: públicos (no tienen datos) porque el navegador los pide sin la cookie al instalar.
  if (url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/")) return next();

  const session = await readSigned(getCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
  if (session && session.email && allowed(env, session.email)) {
    if (url.pathname === "/auth/me") return json({ email: session.email, exp: session.exp });
    const upstream = await next();
    if (session.exp - now() > RENEW_DAYS * 86400) return upstream;
    // Renovación automática: quien usa el Hub con frecuencia no tiene que volver a entrar.
    const res = new Response(upstream.body, upstream);
    const fresh = await sign({ email: session.email, exp: now() + SESSION_DAYS * 86400 }, env.SESSION_SECRET);
    res.headers.append("set-cookie", cookie(SESSION_COOKIE, fresh, { maxAge: SESSION_DAYS * 86400, domain: true }));
    return res;
  }

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    return json({ error: "no has iniciado sesión" }, 401);
  }
  return Response.redirect(`https://${PROD_HOST}/auth/login?next=${encodeURIComponent(url.href)}`, 302);
}

// ---------- rutas ----------

async function login(url, env) {
  const nextUrl = safeNext(url.searchParams.get("next"));
  if (url.hostname !== PROD_HOST) {
    // El retorno de Google solo está autorizado en el dominio principal.
    return Response.redirect(`https://${PROD_HOST}/auth/login?next=${encodeURIComponent(nextUrl)}`, 302);
  }
  const state = randomHex(16);
  const oauth = await sign({ state, next: nextUrl, exp: now() + 600 }, env.SESSION_SECRET);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `https://${PROD_HOST}/auth/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
    login_hint: emails(env)[0] || "",
  });
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, [
    cookie(OAUTH_COOKIE, oauth, { maxAge: 600, path: "/auth" }),
  ]);
}

async function callback(request, url, env) {
  const oauth = await readSigned(getCookie(request, OAUTH_COOKIE), env.SESSION_SECRET);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!oauth || !state || oauth.state !== state || !code) {
    return page(400, "No se pudo iniciar sesión", 'La solicitud ha caducado o no es válida. <a href="/auth/login">Vuelve a intentarlo</a>.');
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `https://${PROD_HOST}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.id_token) {
    return page(502, "No se pudo iniciar sesión", 'Google no ha devuelto la identidad. <a href="/auth/login">Vuelve a intentarlo</a>.');
  }

  // El id_token llega directamente de Google por HTTPS con nuestro secreto, así que basta con validar sus campos.
  const claims = JSON.parse(b64urlDecodeText(tokens.id_token.split(".")[1]));
  const email = String(claims.email || "").toLowerCase();
  const valid =
    ["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) &&
    claims.aud === env.GOOGLE_CLIENT_ID &&
    claims.exp > now() &&
    claims.email_verified === true;
  const clearOauth = cookie(OAUTH_COOKIE, "", { maxAge: 0, path: "/auth" });
  if (!valid || !allowed(env, email)) {
    return page(403, "Sin acceso", `La cuenta <b>${escapeHtml(email || "desconocida")}</b> no tiene acceso al Hub. <a href="/auth/login">Entrar con otra cuenta</a>.`, [clearOauth]);
  }

  const session = await sign({ email, exp: now() + SESSION_DAYS * 86400 }, env.SESSION_SECRET);
  return redirect(safeNext(oauth.next), [
    clearOauth,
    cookie(SESSION_COOKIE, session, { maxAge: SESSION_DAYS * 86400, domain: true }),
  ]);
}

function logout(url) {
  return page(200, "Sesión cerrada", '<a href="/auth/login">Volver a entrar</a>', [
    cookie(SESSION_COOKIE, "", { maxAge: 0, domain: url.hostname === PROD_HOST || url.hostname.endsWith("." + PROD_HOST) }),
  ]);
}

// ---------- utilidades ----------

const now = () => Math.floor(Date.now() / 1000);
const emails = (env) => env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const allowed = (env, email) => emails(env).includes(String(email).toLowerCase());

function safeNext(next) {
  try {
    const u = new URL(next || "/", `https://${PROD_HOST}`);
    if (u.protocol === "https:" && (u.hostname === PROD_HOST || u.hostname.endsWith("." + PROD_HOST))) return u.href;
  } catch {}
  return `https://${PROD_HOST}/`;
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function cookie(name, value, { maxAge, path = "/", domain = false }) {
  // domain: true → compartida con las vistas previas (*.teknobrawl-hub.pages.dev).
  return `${name}=${value}; Max-Age=${maxAge}; Path=${path}; ${domain ? `Domain=${PROD_HOST}; ` : ""}HttpOnly; Secure; SameSite=Lax`;
}

function redirect(location, cookies = []) {
  const h = new Headers({ location, "cache-control": "no-store" });
  cookies.forEach((c) => h.append("set-cookie", c));
  return new Response(null, { status: 302, headers: h });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function page(status, title, body, cookies = []) {
  const h = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  cookies.forEach((c) => h.append("set-cookie", c));
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f6f8;color:#1b1b1f}@media(prefers-color-scheme:dark){body{background:#121216;color:#ececf1}a{color:#8ab4ff}}main{max-width:480px;margin:15vh auto;padding:0 16px}</style>
</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
  return new Response(html, { status, headers: h });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const b64urlDecodeText = (str) => new TextDecoder().decode(b64urlDecode(str));

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(payload, secret) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

async function readSigned(value, secret) {
  if (!value || !value.includes(".")) return null;
  const [body, sig] = value.split(".");
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(b64urlDecodeText(body));
    return payload.exp > now() ? payload : null;
  } catch {
    return null;
  }
}
