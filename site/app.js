// TeknoBrawl Hub: pestañas Hoy, Semana, Mes, Análisis y Calendario. Sin dependencias.
// Los datos llegan de /api/<clave> (Workers KV), protegidos por el inicio de sesión de functions/_middleware.js.
"use strict";

/* =====================================================================
   Utilidades
   ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NF = new Intl.NumberFormat("es-ES");
const n0 = v => v == null || isNaN(v) ? "—" : NF.format(Math.round(v));
const n1 = v => v == null || isNaN(v) ? "—" : new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(v);
const eur = (v, d = 2) => v == null || isNaN(v) ? "—" : new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const pct = (v, d = 0) => v == null || isNaN(v) ? "—" : new Intl.NumberFormat("es-ES", { style: "percent", maximumFractionDigits: d, minimumFractionDigits: d }).format(v);
const signed = v => v == null || isNaN(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + NF.format(Math.abs(Math.round(v)));
function compact(v) {
  if (v == null || isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e6) return n1(v / 1e6).replace(",0", "") + " M";
  if (a >= 1e4) return NF.format(Math.round(v / 1e3)) + " K";
  if (a >= 1e3) return n1(v / 1e3).replace(",0", "") + " K";
  return NF.format(Math.round(v * 10) / 10);
}
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MONTHS_L = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const parseDay = s => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const dayShort = s => { const d = parseDay(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const monthShort = s => { const [y, m] = s.split("-").map(Number); return `${MONTHS[m - 1]} ${String(y).slice(2)}`; };
const monthLong = s => { const [y, m] = s.split("-").map(Number); return `${MONTHS_L[m - 1]} de ${y}`; };
const dateLong = s => { const d = parseDay(s); return `${d.getDate()} de ${MONTHS_L[d.getMonth()]} de ${d.getFullYear()}`; };
function ago(t) {
  const m = Math.round((Date.now() - Date.parse(t)) / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `hace ${m} min`;
  if (m < 48 * 60) return `hace ${Math.round(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} días`;
}
const hoursSince = t => (Date.now() - Date.parse(t)) / 3.6e6;
const median = a => { const s = a.filter(x => x != null && !isNaN(x)).sort((x, y) => x - y); if (!s.length) return null; const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const ytUrl = id => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function delta(change, { invert = false, abs = null } = {}) {
  if (change == null || isNaN(change)) return abs != null ? `<span class="delta flat">${esc(abs)}</span>` : "";
  const good = invert ? change < 0 : change > 0;
  const cls = Math.abs(change) < 0.005 ? "flat" : good ? "up" : "down";
  const arrow = change > 0.005 ? "▲" : change < -0.005 ? "▼" : "";
  return `<span class="delta ${cls}">${arrow} ${pct(Math.abs(change), Math.abs(change) < 0.1 ? 1 : 0)}</span>`;
}
const change = (a, b) => b ? (a - b) / Math.abs(b) : null;

function kpi(label, value, meta = "") {
  return `<div class="kpi"><div class="lbl">${esc(label)}</div><div class="val">${value}</div>${meta ? `<div class="meta">${meta}</div>` : ""}</div>`;
}

/* =====================================================================
   Datos
   ===================================================================== */

const cache = new Map();
let loadedAt = Date.now();

class AuthError extends Error {}

function load(key) {
  if (!cache.has(key)) {
    cache.set(key, fetch(`/api/${key}`, { cache: "no-store", credentials: "same-origin" }).then(async r => {
      if (r.status === 401) throw new AuthError("La sesión ha caducado.");
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Error ${r.status} al leer ${key}`);
      return r.json();
    }).catch(e => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}
const rows = key => load(key).then(d => (d && d.rows) || []);

function reloadAll() {
  cache.clear();
  loadedAt = Date.now();
  for (const v of Object.keys(VIEWS)) rendered[v] = false;
  refreshStatus();
  show(current, true);
}

/* =====================================================================
   Formatos (copia de FORMATS en pipeline/analisis.py, para vídeos que aún no están en videos.json)
   ===================================================================== */

const FORMATS = [
  ["Mejores para maxear", /^(?!.*TIPS).*MAXEAR/],
  ["Noticias y balance", /BALANCE|BRAWL TALK|NOTICIAS|ACTUALIZACI|FILTRAD|NOVEDADES|NUEVO BRAWLER|NUEVA TEMPORADA|SQUAD|BRAWLER SECRETO/],
  ["Opinión y vlogs", /ARRUINARON|PROBLEMA|DECADENCIA|YA NO ES|INUTILES|NECESARIOS|NECESITA\b|BUGS|OLVIDADAS|^HOLA|SORTEO|SUSCRIPTORES|SUBS EN|SETUP|ABRIENDO|ABRO |GASTANDO|ME TOCAN|COMPRO|CAJA MISTERIOSA|RULETA|CADA VEZ QUE|MI CUENTA|MIEMBRO|VETERANOS|SE COPIA/],
  ["Guías de eventos", /EVENTO|PIZZA|MEGAHUCHA|BRAWL PASS|HUEVOS|SUSHI|CARAMELOS|CAJA ELEGIR/],
  ["Competitivo y mapas", /COMPETITIVO|MAPA|RANKED|RANGO|MODO|MODIFICADOR|COPAS/],
  ["Guías y consejos", /TIPS|CONSEJOS|ERRORES|GUIA|COMO |TRUCOS|RECURSOS|GASTAR|CONSEGUIR|PROGRESAR|MAESTRIA|PRO |PROTIPS|PALABRAS|SECRETOS|CLAVES|CODIGO/],
  ["Skins", /SKIN/],
  ["Tops y tier lists", /PEOR|MEJOR|TOP|TIER|HIPERCARGA|GADGET|ESTELAR|SUPERS|PODERES|LEGENDARIO|MITICO|DIFICILES|FACILES|ROTOS|FUERTES|POPULARES|TRIOS|REFUERZOS|TITULOS/],
];
const norm = s => s.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toUpperCase().replace(/\s+/g, " ");
function guessFormat(title, durationS) {
  if (durationS != null && durationS <= 180) return "Short";
  const t = norm(title || "");
  for (const [name, rx] of FORMATS) if (rx.test(t)) return name;
  return "Otros";
}
const FORMAT_ORDER = ["Mejores para maxear", "Tops y tier lists", "Guías y consejos", "Guías de eventos", "Competitivo y mapas", "Noticias y balance", "Skins", "Opinión y vlogs", "Otros", "Short", "Directo"];
const formatColor = f => `var(--c${(FORMAT_ORDER.indexOf(f) % 9 + 9) % 9 + 1})`;

/* =====================================================================
   Gráficos (SVG propio, con tooltip)
   ===================================================================== */

function niceTicks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const span = max - min, step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const t = [];
  for (let v = lo; v <= hi + step / 2; v += step) t.push(Math.round(v * 1e6) / 1e6);
  return t;
}

const charts = new Set();
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { for (const c of charts) if (c.el.isConnected && c.el.offsetParent) c.draw(); }, 120);
});

/**
 * chart(el, opt)
 *  opt.type     "line" | "bar"
 *  opt.labels   etiquetas del eje x (una por punto)
 *  opt.xs       (solo línea) valores numéricos de x si no son equidistantes
 *  opt.series   [{name, color, values, dash, stack, faded:[bool], area}]
 *  opt.stacked  barras apiladas
 *  opt.yFmt     formato del eje y y del tooltip
 *  opt.xFmt     etiqueta del eje x a partir del índice
 *  opt.tipTitle título del tooltip a partir del índice
 *  opt.height   alto en px
 *  opt.divider  índice antes del cual dibujar una línea vertical
 *  opt.yMin     forzar mínimo
 */
function chart(el, opt) {
  el.classList.add("chart");
  el.innerHTML = "";
  const svgNS = "http://www.w3.org/2000/svg";
  const tip = document.createElement("div");
  tip.className = "tip";
  const obj = { el, draw };
  charts.add(obj);

  function draw() {
    const W = Math.max(el.clientWidth, 260);
    const H = opt.height || (W < 500 ? 190 : 230);
    const yFmt = opt.yFmt || compact;
    const n = opt.labels.length;
    const series = opt.series.filter(s => !s.hidden);
    // rango y
    let lo = opt.yMin ?? 0, hi = 0;
    if (opt.type === "bar" && opt.stacked) {
      for (let i = 0; i < n; i++) {
        let pos = 0, neg = 0;
        for (const s of series) { const v = s.values[i] || 0; v >= 0 ? pos += v : neg += v; }
        hi = Math.max(hi, pos); lo = Math.min(lo, neg);
      }
    } else {
      for (const s of series) for (const v of s.values) if (v != null && !isNaN(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
    }
    if (opt.yMax != null) hi = Math.max(hi, opt.yMax);
    const ticks = niceTicks(lo, hi || 1, W < 500 ? 3 : 4);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const labelW = Math.max(...ticks.map(t => yFmt(t).length)) * 6.6 + 8;
    const m = { l: labelW, r: 8, t: 8, b: 22 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const Y = v => m.t + ih - (v - y0) / (y1 - y0) * ih;
    const xsNum = opt.xs;
    const xMin = xsNum ? xsNum[0] : 0, xMax = xsNum ? xsNum[xsNum.length - 1] : n - 1;
    const band = iw / Math.max(n, 1);
    const X = i => opt.type === "bar" ? m.l + band * (i + .5)
      : m.l + (xMax === xMin ? iw / 2 : ((xsNum ? xsNum[i] : i) - xMin) / (xMax - xMin) * iw);

    let s = `<svg xmlns="${svgNS}" viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(opt.aria || "Gráfico")}">`;
    for (const t of ticks) {
      s += `<line class="${t === 0 && y0 < 0 ? "zero" : "gridline"}" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/>`;
      s += `<text x="${m.l - 6}" y="${Y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`;
    }
    // etiquetas x
    const maxLabels = Math.max(2, Math.floor(iw / 58));
    const stepL = Math.ceil(n / maxLabels);
    const xFmt = opt.xFmt || (i => opt.labels[i]);
    for (let i = 0; i < n; i += stepL) {
      const anchor = opt.type === "bar" ? "middle" : i === 0 ? "start" : "middle";
      s += `<text x="${X(i)}" y="${H - 6}" text-anchor="${anchor}">${esc(xFmt(i))}</text>`;
    }
    if (opt.divider != null) {
      const xd = opt.type === "bar" ? m.l + band * opt.divider : X(opt.divider);
      s += `<line class="divider" x1="${xd}" x2="${xd}" y1="${m.t}" y2="${m.t + ih}"/>`;
    }
    if (opt.type === "bar") {
      const bw = Math.max(2, Math.min(28, band * (series.length > 1 && !opt.stacked ? .38 : .66)));
      for (let i = 0; i < n; i++) {
        let pos = 0, neg = 0;
        series.forEach((se, k) => {
          const v = se.values[i];
          if (v == null || isNaN(v)) return;
          let x = X(i) - bw / 2, top, bot;
          if (opt.stacked) {
            if (v >= 0) { bot = pos; top = pos + v; pos = top; } else { top = neg; bot = neg + v; neg = bot; }
          } else {
            x = X(i) - (bw * series.length) / 2 + k * bw; top = Math.max(v, 0); bot = Math.min(v, 0);
          }
          const color = typeof se.color === "function" ? se.color(v, i) : se.color;
          const op = se.faded && se.faded[i] ? .45 : 1;
          const h = Math.max(Math.abs(Y(bot) - Y(top)), v ? 1 : 0);
          s += `<rect x="${x.toFixed(1)}" y="${Y(top).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, bw / 3)}" fill="${color}" opacity="${op}"/>`;
        });
      }
    } else {
      for (const se of series) {
        const pts = [];
        se.values.forEach((v, i) => { if (v != null && !isNaN(v)) pts.push([X(i), Y(v)]); });
        if (!pts.length) continue;
        if (se.area) {
          s += `<path d="M${pts[0][0]},${Y(Math.max(y0, 0))} L${pts.map(p => p.join(",")).join(" L")} L${pts[pts.length - 1][0]},${Y(Math.max(y0, 0))} Z" fill="${se.color}" opacity=".1"/>`;
        }
        s += `<path d="M${pts.map(p => p.map(c => c.toFixed(1)).join(",")).join(" L")}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2}" stroke-linejoin="round" stroke-linecap="round"${se.dash ? ' stroke-dasharray="5 4"' : ""}/>`;
        if (pts.length <= 2 || se.dots) for (const p of pts) s += `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="${se.color}"/>`;
      }
    }
    s += `<line class="guide" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>`;
    s += `<rect class="hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>`;
    s += `</svg>`;
    el.innerHTML = s;
    el.appendChild(tip);

    const svg = el.querySelector("svg"), guide = svg.querySelector(".guide"), hit = svg.querySelector(".hit");
    const idxAt = px => {
      if (opt.type === "bar") return Math.max(0, Math.min(n - 1, Math.floor((px - m.l) / band)));
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(X(i) - px); if (d < bd) { bd = d; best = i; } }
      return best;
    };
    const move = ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (W / r.width);
      const i = idxAt(px);
      const tt = opt.tipTitle ? opt.tipTitle(i) : opt.labels[i];
      const lines = series.map(se => {
        const v = se.values[i];
        if (v == null || isNaN(v)) return "";
        const c = typeof se.color === "function" ? se.color(v, i) : se.color;
        return `<div class="r"><span><i style="background:${c}"></i>${esc(se.name)}</span><b>${esc((se.fmt || opt.tipFmt || yFmt)(v))}</b></div>`;
      }).join("");
      if (opt.stacked && series.length > 1) {
        const tot = series.reduce((a, se) => a + (se.values[i] || 0), 0);
        tip.innerHTML = `<div class="t">${esc(tt)}</div>${lines}<div class="r muted"><span>Total</span><b>${esc((opt.tipFmt || yFmt)(tot))}</b></div>`;
      } else tip.innerHTML = `<div class="t">${esc(tt)}</div>${lines}`;
      const gx = X(i) * (r.width / W);
      guide.setAttribute("x1", X(i)); guide.setAttribute("x2", X(i)); guide.setAttribute("visibility", "visible");
      tip.classList.add("on");
      const tw = tip.offsetWidth, cw = el.clientWidth;
      let left = gx + 12;
      if (left + tw > cw) left = gx - tw - 12;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = "4px";
    };
    const leave = () => { tip.classList.remove("on"); guide.setAttribute("visibility", "hidden"); };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", leave);
  }
  draw();
  return obj;
}

function legend(items) {
  return `<div class="legend">${items.map(it => `<span><i class="${it.dash ? "dash" : it.line ? "line" : ""}" style="${it.dash ? `color:${it.color}` : `background:${it.color}`}"></i>${esc(it.name)}</span>`).join("")}</div>`;
}

function hbars(items, { fmt = compact, max, alt } = {}) {
  const mx = max ?? Math.max(...items.map(i => i.value), 1);
  return `<div class="hbars">${items.map(i => `
    <div class="hbar"><div class="row"><span title="${esc(i.label)}">${esc(i.label)}</span><span>${i.right ?? esc(fmt(i.value))}</span></div>
    <div class="track"><div class="fill${alt ? " alt" : ""}" style="width:${Math.max(0, i.value / mx * 100).toFixed(1)}%;${i.color ? `background:${i.color}` : ""}"></div></div></div>`).join("")}</div>`;
}

/** Tabla ordenable. cols: [{key, label, num, fmt(row) → html, sort(row) → valor}] */
function table(el, cols, data, { sortKey, desc = true, limit } = {}) {
  let key = sortKey, dir = desc ? -1 : 1;
  function render() {
    let d = data.slice();
    if (key) {
      const c = cols.find(c => c.key === key);
      const get = c.sort || (r => r[key]);
      d.sort((a, b) => {
        const va = get(a), vb = get(b);
        if (va == null) return 1; if (vb == null) return -1;
        return (typeof va === "string" ? va.localeCompare(vb, "es") : va - vb) * dir;
      });
    }
    if (limit) d = d.slice(0, limit);
    el.innerHTML = `<div class="table-wrap"><table><thead><tr>${cols.map(c =>
      `<th class="${c.num ? "num " : ""}${c.nosort ? "" : "sortable "}${c.key === key ? "sorted" + (dir > 0 ? " asc" : "") : ""}" data-k="${c.key}">${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${d.map(r => `<tr>${cols.map(c => `<td class="${c.num ? "num" : ""}${c.cls ? " " + c.cls : ""}">${c.fmt ? c.fmt(r) : esc(r[c.key])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    el.querySelectorAll("th.sortable").forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.k;
      if (k === key) dir = -dir; else { key = k; dir = -1; }
      render();
    }));
  }
  render();
}

// Algunas fuentes de tráfico llegan con el nombre interno de la API: se traducen y se suman a la fila equivalente.
const SOURCE_ES = { NO_LINK_OTHER: "Directo / desconocido", YT_OTHER_PAGE: "Otras páginas de YouTube", SOUND_PAGE: "Página de sonido",
  ANNOTATION: "Anotaciones", IMMERSIVE_LIVE: "Directos inmersivos", END_SCREEN: "Pantallas finales", PLAYLIST: "Listas de reproducción",
  NOTIFICATION: "Notificaciones", HASHTAGS: "Hashtags", EXT_URL: "Webs externas", CAMPAIGN_CARD: "Campañas", PRODUCT_PAGE: "Página de producto",
  VIDEO_REMIXES: "Remezclas", LIVE_REDIRECT: "Redirección de directos", SHORTS_CONTENT_LINKS: "Enlaces desde Shorts" };
function mergeSources(list, fields) {
  const out = new Map();
  for (const r of list) {
    const name = SOURCE_ES[r.source] ||
      (/^[A-Z_]+$/.test(r.source) ? r.source.replace(/_/g, " ").toLowerCase().replace(/^./, c => c.toUpperCase()) : r.source);
    const cur = out.get(name) || { ...Object.fromEntries(fields.map(f => [f, 0])), source: name };
    for (const f of fields) cur[f] += r[f] || 0;
    out.set(name, cur);
  }
  return [...out.values()];
}

const cleanTitle = t => String(t || "").replace(/\s*#[\p{L}\p{N}_]+/gu, "").trim() || t;
const thumbUrl = id => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
const thumb = (id, cls = "") => `<img class="thumb ${cls}" src="${thumbUrl(id)}" alt="" loading="lazy" decoding="async">`;

/**
 * Lista de vídeos con miniatura. metrics: [{label, fmt(r) → html}]; la primera es la principal.
 * opts: limit, rank (numerar), badge(r) → html sobre la miniatura
 */
function videoList(el, items, metrics, { limit, rank = false, badge } = {}) {
  const list = limit ? items.slice(0, limit) : items;
  if (!list.length) { el.innerHTML = `<div class="empty">Ninguno.</div>`; return; }
  el.innerHTML = `<ol class="vlist${rank ? " ranked" : ""}">${list.map((r, i) => {
    const date = r.published ? dayShort(r.published) + " " + r.published.slice(2, 4) : "";
    return `<li class="vrow">
      <a class="vthumb" href="${ytUrl(r.video_id)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
        ${thumb(r.video_id)}${rank ? `<span class="vrank">${i + 1}</span>` : ""}${badge ? badge(r) || "" : ""}</a>
      <div class="vbody">
        <a class="vtitle" href="${ytUrl(r.video_id)}" target="_blank" rel="noopener">${esc(cleanTitle(r.title))}</a>
        <div class="vmeta">${r.format ? `<span class="fdot" style="background:${formatColor(r.format)}"></span>${esc(r.format)}` : ""}${r.format && date ? " · " : ""}${date}</div>
        <div class="vstats">${metrics.map((m, k) => `<span class="${k === 0 ? "main" : ""}"><b>${m.fmt(r)}</b> ${esc(m.label)}</span>`).join("")}</div>
      </div>
    </li>`;
  }).join("")}</ol>`;
}

const videoCell = r => `<a href="${ytUrl(r.video_id)}" target="_blank" rel="noopener">${esc(r.title)}</a>${r.format ? `<span class="fmt">${esc(r.format)}${r.published ? " · " + dayShort(r.published) + " " + r.published.slice(2, 4) : ""}</span>` : ""}`;

/* =====================================================================
   Estado de los datos (indicador de frescura)
   ===================================================================== */

const JOBS = [
  { job: "hourly", name: "Cada hora", desc: "Contadores públicos de los vídeos recientes y del canal", maxH: 2.5 },
  { job: "sync", name: "Cada 6 horas", desc: "Analytics de YouTube y resumen de la semana", maxH: 8 },
  { job: "daily", name: "Cada día", desc: "Análisis completo, CTR e impresiones", maxH: 30 },
];

async function refreshStatus() {
  const btn = $("#fresh"), dot = btn.querySelector(".dot"), txt = btn.querySelector(".fresh-txt");
  const sts = await Promise.all(JOBS.map(j => load(`status/${j.job}.json`).catch(e => ({ _err: e }))));
  if (sts.some(s => s && s._err instanceof AuthError)) return authExpired();
  let level = "ok";
  const body = JOBS.map((j, i) => {
    const s = sts[i];
    let cls = "ok", line;
    if (!s || s._err) { cls = "warn"; line = s && s._err ? s._err.message : "Todavía no se ha ejecutado."; }
    else if (!s.ok) { cls = "bad"; line = `Error ${ago(s.finished_at)}: ${s.error || "sin detalle"}`; }
    else {
      const h = hoursSince(s.finished_at);
      if (h > j.maxH) cls = "warn";
      line = `Correcto ${ago(s.finished_at)} (${s.seconds} s)` + (s.data_until ? ` · Analytics hasta el ${dayShort(s.data_until)}` : "");
    }
    if (cls === "bad" || (cls === "warn" && level === "ok")) level = cls;
    const link = s && s.run_url ? ` · <a href="${esc(s.run_url)}" target="_blank" rel="noopener">registro</a>` : "";
    return `<div class="job"><span class="dot ${cls}"></span><div><div class="job-name">${j.name}</div><div class="job-desc">${esc(j.desc)}</div><div class="small">${esc(line)}${link}</div></div></div>`;
  }).join("");
  $("#status-body").innerHTML = body + `<p class="note">La API de YouTube publica la analítica con 1–2 días de retraso. Los contadores públicos (visualizaciones, me gusta y comentarios) sí están al día cada hora.</p>`;
  dot.className = "dot " + level;
  const h = sts[0] && !sts[0]._err ? sts[0].finished_at : null;
  const d = sts[1] && sts[1].data_until;
  txt.textContent = level === "bad" ? "Error en los datos" : h ? (innerWidth < 480 ? ago(h) : `Actualizado ${ago(h)}` + (d ? ` · Analytics al ${dayShort(d)}` : "")) : "Sin datos";
}

function authExpired() {
  $("#main").innerHTML = `<div class="card soon"><h2>La sesión ha caducado</h2><p class="muted">Vuelve a entrar con tu cuenta de Google.</p><p><a class="btn" href="/auth/login?next=${encodeURIComponent(location.href)}">Iniciar sesión</a></p></div>`;
}

/* =====================================================================
   Pestaña HOY
   ===================================================================== */

async function viewHoy(el) {
  const [snap, videos, shorts, fwc, formats, semana] = await Promise.all([
    load("snapshots/hourly.json"), rows("analisis/videos.json"), rows("analisis/shorts.json"),
    rows("analisis/first_week_curve.json"), rows("analisis/formats.json"), load("analisis/semana.json").catch(() => null),
  ]);
  const days = (semana && (semana.daily90 || semana.daily)) || [];
  const yday = days[days.length - 1], yday0 = days[days.length - 2];
  const ch = (snap && snap.channel) || [];
  const vids = Object.entries((snap && snap.videos) || {}).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.published.localeCompare(a.published));
  const now = new Date();
  const hello = now.getHours() < 14 ? "Buenos días" : now.getHours() < 21 ? "Buenas tardes" : "Buenas noches";
  const dateTxt = now.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });

  // cambio del canal en ~24 h a partir de las instantáneas
  const last = ch[ch.length - 1];
  const ref = pointBefore(ch, 24);
  const spanH = ref && last ? (Date.parse(last[0]) - Date.parse(ref[0])) / 3.6e6 : 0;
  const spanTxt = spanH >= 20 ? "en 24 h" : spanH >= 1 ? `en ${Math.round(spanH)} h` : "";

  const lastPub = vids[0];
  const daysSince = lastPub ? Math.floor(hoursSince(lastPub.published) / 24) : null;

  // vídeos en su primera semana
  const all = videos.concat(shorts);
  const firstWeek = vids.filter(v => hoursSince(v.published) <= 7 * 24);
  const tracked = firstWeek.map(v => trackVideo(v, all, fwc, formats));

  // avisos
  const alerts = [];
  for (const t of tracked) {
    if (t.hours < 24 || !t.expected) continue;
    const r = t.ratio;
    if (r < 0.7) alerts.push(["warn", "!", `<b>${esc(t.v.title)}</b> va por debajo de lo normal en su formato: ${n0(t.views)} visualizaciones frente a unas ${n0(t.expected)} esperadas a las ${Math.round(t.hours)} h (${pct(r)}).`]);
    else if (r > 1.3) alerts.push(["good", "▲", `<b>${esc(t.v.title)}</b> va por encima de lo normal: ${n0(t.views)} visualizaciones frente a unas ${n0(t.expected)} esperadas (${pct(r)}).`]);
    else alerts.push(["info", "i", `<b>${esc(t.v.title)}</b> va en línea con su formato (${pct(r)} de lo esperado a las ${Math.round(t.hours)} h).`]);
  }
  if (daysSince != null && daysSince >= 10) alerts.push(["info", "i", `Último vídeo publicado hace <b>${daysSince} días</b> (${dateLong(lastPub.published)}).`]);
  const sts = await Promise.all(JOBS.map(j => load(`status/${j.job}.json`).catch(() => null)));
  sts.forEach((s, i) => { if (s && !s.ok) alerts.push(["bad", "✕", `La tarea «${JOBS[i].name}» falló ${ago(s.finished_at)}. Revisa el estado de los datos.`]); });
  if (ch.length < 3) alerts.push(["info", "i", "Las instantáneas horarias acaban de empezar: las curvas hora a hora se irán llenando."]);

  el.innerHTML = `
    <div class="view-head"><div><h1>${hello}</h1><p>${esc(dateTxt[0].toUpperCase() + dateTxt.slice(1))}</p></div></div>
    <div class="kpis">
      ${kpi("Suscriptores", last ? n0(last[1]) : "—", `<span>YouTube lo redondea a la centena</span>`)}
      ${kpi(spanH >= 20 || !spanTxt ? "Visualizaciones · 24 h" : `Visualizaciones · ${Math.round(spanH)} h`,
        last && ref && spanTxt ? signed(last[2] - ref[2]) : "—",
        spanTxt ? `<span>Contador público, al día cada hora</span>` : `<span>Faltan instantáneas</span>`)}
      ${kpi(`Suscriptores netos · ${yday ? dayShort(yday.day) : "—"}`, yday ? signed(yday.subs_net) : "—",
        yday ? `${yday0 ? `<span class="delta ${yday.subs_net > yday0.subs_net ? "up" : yday.subs_net < yday0.subs_net ? "down" : "flat"}">${signed(yday.subs_net - yday0.subs_net)}</span>` : ""}<span>${yday.subs_gained != null ? `+${yday.subs_gained} / −${yday.subs_lost} · ` : ""}último día con datos</span>` : "")}
      ${kpi(`Ingresos · ${yday ? dayShort(yday.day) : "—"}`, yday ? eur(yday.revenue) : "—",
        yday ? `${yday0 ? delta(change(yday.revenue, yday0.revenue)) : ""}<span>${n0(yday.views)} visualizaciones ese día</span>` : "")}
    </div>
    <p class="note">Los suscriptores exactos, los ingresos y las visualizaciones por día llegan con la analítica de YouTube, que va 1–2 días por detrás.</p>

    <h2 class="section-title">Tareas</h2>
    <div class="card" id="hoy-tasks"></div>

    <h2 class="section-title">Avisos</h2>
    <div class="alerts">${alerts.length ? alerts.map(([c, i, t]) => `<div class="alert ${c}"><span class="ico">${i}</span><div>${t}</div></div>`).join("") : `<div class="alert good"><span class="ico">✓</span><div>Todo en orden.</div></div>`}</div>

    <h2 class="section-title">Vídeos en su primera semana</h2>
    <div id="hoy-first"></div>

    <h2 class="section-title">Vídeos recientes</h2>
    <div class="card"><div id="hoy-recent"></div><p class="note">Contadores públicos de la Data API, actualizados cada hora. «Últimas 24 h» sale de las instantáneas horarias.</p></div>

    <h2 class="section-title">Canal hora a hora</h2>
    <div class="card"><div class="card-head"><div><h2>Visualizaciones ganadas por hora</h2><div class="sub">Contador público del canal (YouTube lo actualiza con retraso y a saltos)</div></div></div><div id="hoy-channel"></div></div>
  `;

  renderTasks($("#hoy-tasks", el));

  const firstBox = $("#hoy-first", el);
  if (!tracked.length) {
    firstBox.innerHTML = `<div class="card"><div class="empty">Ningún vídeo en su primera semana. Cuando publiques, aquí verás su curva hora a hora comparada con lo normal en su formato.</div></div>`;
  } else {
    firstBox.innerHTML = `<div class="grid two">${tracked.map((t, i) => `
      <div class="card vid">
        <div class="vid-head"><a href="${ytUrl(t.v.id)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${thumb(t.v.id, "vid-thumb")}</a>
        <div><a class="vid-title" href="${ytUrl(t.v.id)}" target="_blank" rel="noopener" style="color:var(--fg)">${esc(cleanTitle(t.v.title))}</a>
        <div class="sub">${esc(t.format)} · publicado ${ago(t.v.published)}</div></div></div>
        <div class="vid-stats"><span><b>${n0(t.views)}</b> visualizaciones</span><span><b>${n0(t.likes)}</b> me gusta</span><span><b>${n0(t.comments)}</b> comentarios</span>
          ${t.expected ? `<span>${t.ratio >= 1.3 ? '<span class="pill good">' : t.ratio < 0.7 ? '<span class="pill bad">' : '<span class="pill">'}${pct(t.ratio)} de lo esperado</span></span>` : ""}</div>
        ${legend([{ name: "Visualizaciones", color: "var(--c1)", line: true }].concat(t.expected ? [{ name: `Lo normal en «${t.format}» (aprox.)`, color: "var(--axis)", dash: true }] : []))}
        <div id="fw-${i}"></div>
      </div>`).join("")}</div>`;
    tracked.forEach((t, i) => {
      const xs = t.curve.map(p => p[0]);
      chart($(`#fw-${i}`, el), {
        type: "line", labels: xs.map(h => `${Math.round(h)} h`), xs, height: 170,
        xFmt: i2 => `${Math.round(xs[i2])} h`, tipTitle: i2 => `${n1(xs[i2])} h desde la publicación`,
        series: [{ name: "Visualizaciones", color: "var(--c1)", values: t.curve.map(p => p[1]), area: true },
          ...(t.expected ? [{ name: "Esperado", color: "var(--axis)", dash: true, width: 1.5, values: xs.map(h => t.expectedAt(h)) }] : [])],
        yFmt: compact, tipFmt: n0,
      });
    });
  }

  // recientes
  const recent = vids.map(v => {
    const p = v.points || [], lp = p[p.length - 1], rp = pointBefore(p, 24);
    return { video_id: v.id, title: v.title, published: v.published, format: guessFormat(v.title, v.duration_s),
      views: lp && lp[1], likes: lp && lp[2], comments: lp && lp[3],
      d24: lp && rp && Date.parse(lp[0]) - Date.parse(rp[0]) >= 20 * 3.6e6 ? lp[1] - rp[1] : null };
  });
  videoList($("#hoy-recent", el), recent, [
    { label: "visualizaciones", fmt: r => n0(r.views) },
    { label: "en 24 h", fmt: r => r.d24 == null ? "—" : signed(r.d24) },
    { label: "me gusta", fmt: r => n0(r.likes) },
    { label: "coment.", fmt: r => n0(r.comments) },
  ], { limit: 8 });

  // canal: visualizaciones ganadas por hora (últimas 72 h)
  const chEl = $("#hoy-channel", el);
  const recentCh = ch.filter(p => hoursSince(p[0]) <= 72);
  if (recentCh.length < 3) chEl.innerHTML = `<div class="empty">Aún hay ${recentCh.length} instantánea${recentCh.length === 1 ? "" : "s"}. El gráfico aparece cuando haya unas cuantas horas de datos.</div>`;
  else {
    const gains = recentCh.slice(1).map((p, i) => [p[0], p[2] - recentCh[i][2]]);
    chart(chEl, {
      type: "bar", labels: gains.map(g => g[0]), height: 170,
      xFmt: i => { const d = new Date(gains[i][0]); return `${d.getHours()}:00`; },
      tipTitle: i => new Date(gains[i][0]).toLocaleString("es-ES", { weekday: "short", hour: "2-digit", minute: "2-digit" }),
      series: [{ name: "Visualizaciones", color: "var(--c2)", values: gains.map(g => g[1]) }], tipFmt: n0,
    });
  }
}

/* ---------- Tareas (se guardan en KV con POST /api/tasks; copia local por si no hay conexión) ---------- */

const TASKS_LS = "hub-tasks";
const localDay = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
let tasksDoc = null;     // {updated_at, tasks}
let tasksPending = false;

async function loadTasks() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem(TASKS_LS) || "null"); } catch {}
  let remote = null;
  try { remote = await load("tasks/list.json"); } catch (e) { if (e instanceof AuthError) throw e; }
  // KV puede tardar hasta 60 s en reflejar un cambio: gana la copia más reciente.
  if (local && (!remote || (local.updated_at || "") > (remote.updated_at || ""))) {
    tasksDoc = local;
    if (local.pending) saveTasks();
  } else tasksDoc = remote || { updated_at: "", tasks: [] };
  return tasksDoc;
}

async function saveTasks() {
  tasksDoc.updated_at = new Date().toISOString();
  // poda: tareas hechas de hace más de 30 días
  const cut = localDay(-30);
  tasksDoc.tasks = tasksDoc.tasks.filter(t => !(t.done && t.day < cut));
  const keep = pending => { try { localStorage.setItem(TASKS_LS, JSON.stringify({ ...tasksDoc, pending })); } catch {} };
  keep(true);
  tasksPending = true;
  try {
    const r = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ tasks: tasksDoc.tasks }) });
    if (r.status === 401) throw new AuthError("La sesión ha caducado.");
    if (!r.ok) throw new Error(`Error ${r.status}`);
    const saved = await r.json();
    tasksDoc.updated_at = saved.updated_at;
    cache.delete("tasks/list.json");
    keep(false);
    tasksPending = false;
  } catch (e) {
    if (e instanceof AuthError) return authExpired();
    console.warn("No se pudieron guardar las tareas:", e);
  }
  document.querySelectorAll(".tasks-sync").forEach(n => n.textContent = tasksPending ? "Sin sincronizar: se reintentará" : "");
}

async function renderTasks(box) {
  box.innerHTML = `<div class="empty">Cargando tareas…</div>`;
  await loadTasks();
  const today = localDay(0), tomorrow = localDay(1);
  const draw = () => {
    const ts = tasksDoc.tasks;
    const late = ts.filter(t => t.day < today && !t.done);
    const byTime = (a, b) => (a.detail || "~").localeCompare(b.detail || "~");
    const tod = ts.filter(t => t.day === today).sort(byTime);
    const tom = ts.filter(t => t.day === tomorrow).sort(byTime);
    const doneN = tod.filter(t => t.done).length;
    const totalN = tod.length + late.length;
    const ratio = totalN ? doneN / totalN : 0;
    const item = t => `<li class="task${t.done ? " done" : ""}">
        <label><input type="checkbox" data-id="${esc(t.id)}" ${t.done ? "checked" : ""}><span class="task-title">${esc(t.title)}${t.detail ? `<span class="task-detail">${esc(t.detail)}</span>` : ""}</span></label>
        ${t.day < today ? `<span class="pill warn">${dayShort(t.day)}</span>` : ""}
        ${t.source === "calendario" ? `<span class="pill" title="Del calendario de producción">Plan</span>` : `<button type="button" class="task-del" data-del="${esc(t.id)}" aria-label="Borrar «${esc(t.title)}»" title="Borrar">✕</button>`}
      </li>`;
    box.innerHTML = `
      <div class="card-head" style="margin-bottom:8px"><div><h2>Hoy</h2><div class="sub">${totalN ? `${doneN} de ${totalN} hechas` : "Sin tareas para hoy"}</div></div>
        <span class="small muted tasks-sync">${tasksPending ? "Sin sincronizar: se reintentará" : ""}</span></div>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${totalN}" aria-valuenow="${doneN}"><div style="width:${(ratio * 100).toFixed(0)}%"></div></div>
      <ul class="tasks">${late.map(item).join("")}${tod.map(item).join("")}</ul>
      ${tom.length ? `<div class="sub" style="margin:14px 0 6px;font-weight:600">Mañana</div><ul class="tasks">${tom.map(item).join("")}</ul>` : ""}
      <form class="task-add" autocomplete="off">
        <input type="text" name="title" maxlength="300" placeholder="Añadir tarea…" aria-label="Nueva tarea" required>
        <select name="day" aria-label="Día"><option value="${today}">Hoy</option><option value="${tomorrow}">Mañana</option></select>
        <button class="btn" type="submit">Añadir</button>
      </form>
      <p class="note">Las tareas «Plan» llegan solas del calendario de producción (pestaña Calendario); también puedes añadir las tuyas.</p>`;
    box.querySelectorAll("input[type=checkbox]").forEach(cb => cb.addEventListener("change", () => {
      const t = tasksDoc.tasks.find(x => x.id === cb.dataset.id);
      if (!t) return;
      t.done = cb.checked;
      if (t.done) t.done_at = new Date().toISOString(); else delete t.done_at;
      rendered.calendario = false;
      draw(); saveTasks();
    }));
    box.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
      tasksDoc.tasks = tasksDoc.tasks.filter(x => x.id !== b.dataset.del);
      draw(); saveTasks();
    }));
    box.querySelector(".task-add").addEventListener("submit", ev => {
      ev.preventDefault();
      const f = ev.target, title = f.title.value.trim();
      if (!title) return;
      tasksDoc.tasks.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, day: f.day.value, done: false, source: "manual" });
      draw(); saveTasks();
      box.querySelector(".task-add input").focus();
    });
  };
  draw();
}

function pointBefore(points, hours) {
  if (!points.length) return null;
  const target = Date.now() - hours * 3.6e6;
  let best = points[0];
  for (const p of points) if (Date.parse(p[0]) <= target) best = p;
  return best;
}

/** Curva hora a hora de un vídeo nuevo y lo esperado según su formato. */
function trackVideo(v, all, fwc, formats) {
  const known = all.find(r => r.video_id === v.id);
  const format = known ? known.format : guessFormat(v.title, v.duration_s);
  const pub = Date.parse(v.published);
  const pts = v.points || [];
  const lp = pts[pts.length - 1] || [];
  const curve = [[0, 0], ...pts.map(p => [(Date.parse(p[0]) - pub) / 3.6e6, p[1]])].filter(p => p[0] >= 0);
  // referencia d7: la que calculó analisis.py, o la mediana de d7 del mismo formato en los 180 días previos (mín. 3)
  let d7 = known && known.format_d7_benchmark;
  if (!d7) {
    const prior = all.filter(r => r.format === format && r.video_id !== v.id && r.d7 != null &&
      (pub - parseDay(r.published)) / 864e5 <= 180 && (pub - parseDay(r.published)) > 7 * 864e5);
    d7 = prior.length >= 3 ? median(prior.map(r => r.d7)) : (formats.find(f => f.format === format) || {}).median_d7;
  }
  // reparto acumulado por días (share_of_d28) normalizado al día 6 → fracción del d7 conseguida al final de cada día
  const shares = fwc.filter(r => r.format === format && r.day <= 6).sort((a, b) => a.day - b.day);
  let expectedAt = null;
  if (d7 && shares.length === 7) {
    const s6 = shares[6].share_of_d28;
    const knots = [[0, 0], ...shares.map(r => [(r.day + 1) * 24, r.share_of_d28 / s6])];
    expectedAt = h => {
      if (h >= knots[knots.length - 1][0]) return d7;
      for (let k = 1; k < knots.length; k++) if (h <= knots[k][0]) {
        const [x0, y0] = knots[k - 1], [x1, y1] = knots[k];
        return d7 * (y0 + (y1 - y0) * (h - x0) / (x1 - x0));
      }
      return d7;
    };
  }
  const hours = hoursSince(v.published);
  const lastH = curve.length ? curve[curve.length - 1][0] : hours;
  const expected = expectedAt ? expectedAt(lastH) : null;
  return { v, format, curve, views: lp[1], likes: lp[2], comments: lp[3], hours, expected, expectedAt,
    ratio: expected ? lp[1] / expected : null };
}

/* =====================================================================
   Pestaña SEMANA
   ===================================================================== */

async function viewSemana(el) {
  const s = await load("analisis/semana.json");
  if (!s) { el.innerHTML = `<div class="card empty">Todavía no hay resumen semanal.</div>`; return; }
  const K = Object.fromEntries((s.kpis || []).map(k => [k.metric, k]));
  const w = s.window;
  const k = (m, label, fmt = n0, opts = {}) => {
    const x = K[m]; if (!x) return "";
    // Con valores que pueden ser negativos (suscriptores netos) el % engaña: se muestra la diferencia.
    const d = opts.diff ? `<span class="delta ${x.last7 > x.prev7 ? "up" : x.last7 < x.prev7 ? "down" : "flat"}">${signed(x.last7 - x.prev7)}</span>` : delta(x.change, opts);
    return kpi(label, fmt(x.last7), `${d}<span>antes ${fmt(x.prev7)}</span>${opts.extra || ""}`);
  };
  const reach = (s.reach || []).slice().sort((a, b) => a.day.localeCompare(b.day));
  const inWin = reach.filter(r => r.day >= w.from && r.day <= w.to), inPrev = reach.filter(r => r.day >= w.prev_from && r.day <= w.prev_to);
  const ctrOf = a => { const imp = a.reduce((x, r) => x + r.impressions, 0); return imp ? a.reduce((x, r) => x + r.impressions * r.ctr, 0) / imp : null; };
  const ctrW = ctrOf(inWin), ctrP = ctrOf(inPrev);

  el.innerHTML = `
    <div class="view-head"><div><h1>Semana</h1><p>Del ${dayShort(w.from)} al ${dayShort(w.to)}, frente a los 7 días anteriores (${dayShort(w.prev_from)}–${dayShort(w.prev_to)}). YouTube publica la analítica con 1–2 días de retraso.</p></div></div>
    <div class="kpis">
      ${k("views", "Visualizaciones")}
      ${k("hours", "Horas vistas")}
      ${k("subs_net", "Suscriptores netos", signed, { diff: true, extra: K.subs_gained ? `<span>+${n0(K.subs_gained.last7)} / −${n0(K.subs_lost.last7)}</span>` : "" })}
      ${k("revenue", "Ingresos estimados", v => eur(v))}
      ${k("views_long", "Visualizaciones de vídeos largos")}
      ${k("views_shorts", "Visualizaciones de shorts")}
      ${kpi("CTR de las miniaturas", ctrW == null ? "—" : pct(ctrW, 1), ctrW == null ? "<span>Sin datos de la Reporting API</span>" : `${ctrP ? delta(change(ctrW, ctrP)) : ""}<span>${inWin.length} de 7 días con datos</span>`)}
      ${k("shares", "Veces compartido")}
    </div>

    <div class="grid two" style="margin-top:12px">
      <div class="card"><div class="card-head"><div><h2>Visualizaciones por día</h2><div class="sub">La semana anterior, más clara</div></div></div>
        ${legend([{ name: "Vídeos largos", color: "var(--c1)" }, { name: "Shorts", color: "var(--c2)" }])}<div id="sem-daily"></div></div>
      <div class="card"><div class="card-head"><div><h2>Suscriptores netos por día</h2><div class="sub">Ganados menos perdidos</div></div></div><div id="sem-subs"></div></div>
    </div>

    <h2 class="section-title">Vídeos nuevos de la semana</h2>
    <div class="card"><div id="sem-new"></div></div>

    <h2 class="section-title">Lo más visto en la semana</h2>
    <div class="card"><div id="sem-top"></div></div>

    <div class="grid two" style="margin-top:12px">
      <div class="card"><div class="card-head"><div><h2>De dónde vienen las visualizaciones</h2><div class="sub">Últimos 7 días, con el cambio frente a los 7 anteriores</div></div></div><div id="sem-traffic"></div></div>
      <div class="card"><div class="card-head"><div><h2>Impresiones y CTR</h2><div class="sub">Reporting API, por día (no llega todos los días)</div></div></div>
        ${legend([{ name: "Impresiones", color: "var(--c4)" }, { name: "CTR", color: "var(--c3)", line: true }])}<div id="sem-reach"></div><div id="sem-ctr"></div></div>
    </div>
  `;

  const daily = s.daily || [];
  const faded = daily.map(d => d.day < w.from);
  chart($("#sem-daily", el), {
    type: "bar", stacked: true, labels: daily.map(d => d.day), xFmt: i => dayShort(daily[i].day),
    tipTitle: i => parseDay(daily[i].day).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "short" }),
    series: [{ name: "Vídeos largos", color: "var(--c1)", values: daily.map(d => d.views_long), faded },
      { name: "Shorts", color: "var(--c2)", values: daily.map(d => d.views_shorts), faded }],
    divider: daily.findIndex(d => d.day >= w.from), tipFmt: n0,
  });
  chart($("#sem-subs", el), {
    type: "bar", labels: daily.map(d => d.day), xFmt: i => dayShort(daily[i].day),
    tipTitle: i => parseDay(daily[i].day).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "short" }),
    series: [{ name: "Suscriptores netos", color: v => v >= 0 ? "var(--good)" : "var(--bad)", values: daily.map(d => d.subs_net), faded }],
    divider: daily.findIndex(d => d.day >= w.from), yFmt: v => signed(v), tipFmt: signed,
  });

  const nv = s.new_videos || [];
  if (!nv.length) $("#sem-new", el).innerHTML = `<div class="empty">No se publicó ningún vídeo en esta ventana.</div>`;
  else videoList($("#sem-new", el), nv, [
    { label: "visualizaciones", fmt: r => n0(r.views_total) },
    { label: "en la semana", fmt: r => n0(r.views_7d) },
    { label: "me gusta", fmt: r => n0(r.likes_total) },
    { label: "suscr.", fmt: r => signed(r.subs_7d) },
  ]);

  videoList($("#sem-top", el), (s.top_videos || []).slice().sort((a, b) => b.views_7d - a.views_7d), [
    { label: "en 7 días", fmt: r => `${n0(r.views_7d)} ${delta(change(r.views_7d, r.views_prev7d))}` },
    { label: "ingresos", fmt: r => eur(r.revenue_7d) },
    { label: "suscr.", fmt: r => signed(r.subs_7d) },
  ], { limit: 10, rank: true });

  const tr = mergeSources(s.traffic || [], ["views_7d", "views_prev7d"]).filter(t => t.views_7d > 0 || t.views_prev7d > 0).sort((a, b) => b.views_7d - a.views_7d);
  $("#sem-traffic", el).innerHTML = tr.length ? hbars(tr.map(t => ({ label: t.source, value: t.views_7d,
    right: `${n0(t.views_7d)} ${delta(change(t.views_7d, t.views_prev7d)) || ""}` }))) : `<div class="empty">Sin datos.</div>`;

  if (!reach.length) $("#sem-reach", el).innerHTML = `<div class="empty">La Reporting API todavía no ha entregado datos de esta ventana.</div>`;
  else {
    chart($("#sem-reach", el), {
      type: "bar", labels: reach.map(r => r.day), xFmt: i => dayShort(reach[i].day), height: 160,
      tipTitle: i => dateLong(reach[i].day),
      series: [{ name: "Impresiones", color: "var(--c4)", values: reach.map(r => r.impressions) }], tipFmt: n0,
    });
    chart($("#sem-ctr", el), {
      type: "line", labels: reach.map(r => r.day), xFmt: i => dayShort(reach[i].day), height: 120,
      tipTitle: i => dateLong(reach[i].day),
      series: [{ name: "CTR", color: "var(--c3)", values: reach.map(r => r.ctr), dots: true }], yFmt: v => pct(v, 1), tipFmt: v => pct(v, 1),
    });
  }
}

/* =====================================================================
   Pestaña MES
   ===================================================================== */

let mesRange = 28;   // 28 = últimos 28 días; 12 = últimos 12 meses; 0 = todo

async function viewMes(el) {
  const [monthly, kpis, countries, semana] = await Promise.all([rows("analisis/monthly.json"), rows("analisis/kpis.json"),
    rows("analisis/countries.json"), load("analisis/semana.json").catch(() => null)]);
  const K = Object.fromEntries(kpis.map(k => [k.metric, k]));
  const d90 = (semana && semana.daily90) || [];
  const RANGES = [[28, "28 días"], [12, "12 meses"], [0, "Todo"]];
  if (!d90.length && mesRange === 28) mesRange = 12;

  el.innerHTML = `
    <div class="view-head"><div><h1>Mes</h1><p id="mes-desc"></p></div>
      <div class="seg" id="mes-range">${RANGES.map(([r, l]) => `<button type="button" data-r="${r}"${r === 28 && !d90.length ? " disabled" : ""}>${l}</button>`).join("")}</div></div>
    <div class="kpis" id="mes-kpis"></div>
    <p class="note" id="mes-note"></p>
    <div class="grid two" style="margin-top:12px">
      <div class="card"><div class="card-head"><div><h2 id="mes-t-views"></h2></div></div>${legend([{ name: "Vídeos largos", color: "var(--c1)" }, { name: "Shorts", color: "var(--c2)" }])}<div id="mes-views"></div></div>
      <div class="card"><div class="card-head"><div><h2 id="mes-t-rev"></h2></div></div>${legend([{ name: "Vídeos largos", color: "var(--c1)" }, { name: "Shorts", color: "var(--c2)" }, { name: "Otros (membresías…)", color: "var(--c3)" }])}<div id="mes-rev"></div></div>
      <div class="card"><div class="card-head"><div><h2 id="mes-t-subs"></h2></div></div><div id="mes-subs"></div></div>
      <div class="card"><div class="card-head"><div><h2 id="mes-t-pub"></h2></div></div>${legend([{ name: "Vídeos largos", color: "var(--c1)" }, { name: "Shorts", color: "var(--c2)" }])}<div id="mes-pub"></div></div>
    </div>
    <h2 class="section-title">Vídeos largos frente a shorts</h2>
    <div class="card" id="mes-split"></div>
    <h2 class="section-title">Países</h2>
    <div class="card"><div id="mes-countries"></div><p class="note">Desde siempre (los datos de países no se guardan por periodos). RPM = ingresos por cada 1.000 visualizaciones.</p></div>
  `;

  const sumOf = (list, f) => list.reduce((a, r) => a + (r[f] || 0), 0);
  const draw = () => {
    el.querySelectorAll("#mes-range button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.r === mesRange)));
    const days = mesRange === 28;
    let m, prev, desc, label = "";
    if (days) {
      m = d90.slice(-28); prev = d90.slice(-56, -28);
      desc = `Del ${dayShort(m[0].day)} al ${dayShort(m[m.length - 1].day)}: los últimos 28 días con datos (YouTube va 1–2 días por detrás), frente a los 28 anteriores.`;
      label = "los 28 anteriores";
    } else if (mesRange === 12) {
      m = monthly.slice(-12); prev = monthly.length >= 24 ? monthly.slice(-24, -12) : [];
      desc = `De ${monthLong(m[0].month)} a ${monthLong(m[m.length - 1].month)}, frente a los 12 meses anteriores.`;
      label = "los 12 anteriores";
    } else {
      m = monthly; prev = [];
      desc = "Todo el histórico del canal, desde abril de 2024.";
    }
    $("#mes-desc", el).textContent = desc;

    // KPI del periodo
    const box = (name, f, fmt, { diff = false, extra = "" } = {}) => {
      const cur = sumOf(m, f), old = prev.length ? sumOf(prev, f) : null;
      let meta = "";
      if (old != null) meta = (diff
        ? `<span class="delta ${cur > old ? "up" : cur < old ? "down" : "flat"}">${signed(cur - old)}</span>`
        : delta(change(cur, old))) + `<span>${fmt(old)} en ${label}</span>`;
      return kpi(name, fmt(cur), meta + extra);
    };
    if (mesRange === 0) {
      $("#mes-kpis", el).innerHTML = [
        kpi("Visualizaciones", compact(K["Visualizaciones"]?.value), `<span>Desde siempre</span>`),
        kpi("Horas vistas", compact(K["Horas de visualización"]?.value), `<span>Desde siempre</span>`),
        kpi("Suscriptores", n0(K["Suscriptores"]?.value), `<span>Total actual</span>`),
        kpi("Ingresos estimados", eur(K["Ingresos estimados (€)"]?.value, 0), `<span>Desde siempre</span>`),
      ].join("");
    } else {
      $("#mes-kpis", el).innerHTML = [
        box("Visualizaciones", "views", compact),
        box("Horas vistas", "hours", v => compact(Math.round(v))),
        box("Suscriptores netos", "subs_net", signed, { diff: true,
          extra: days ? `<span>+${n0(sumOf(m, "subs_gained"))} / −${n0(sumOf(m, "subs_lost"))}</span>` : "" }),
        box("Ingresos estimados", "revenue", v => eur(v)),
      ].join("");
    }
    const curM = monthly[monthly.length - 1];
    $("#mes-note", el).textContent = !days && curM && curM.partial ? `${monthLong(curM.month)} está en curso: sus barras van más claras.` : "";

    const unit = days ? "día" : "mes";
    $("#mes-t-views", el).textContent = `Visualizaciones por ${unit}`;
    $("#mes-t-rev", el).textContent = `Ingresos estimados por ${unit}`;
    $("#mes-t-subs", el).textContent = `Suscriptores netos por ${unit}`;
    $("#mes-t-pub", el).textContent = `Publicaciones por ${unit}`;

    const faded = m.map(r => !!r.partial);
    const base = days
      ? { type: "bar", labels: m.map(r => r.day), xFmt: i => dayShort(m[i].day),
          tipTitle: i => parseDay(m[i].day).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "short" }) }
      : { type: "bar", labels: m.map(r => r.month), xFmt: i => monthShort(m[i].month), tipTitle: i => monthLong(m[i].month) + (m[i].partial ? " (en curso)" : "") };
    chart($("#mes-views", el), { ...base, stacked: true, tipFmt: n0, series: [
      { name: "Vídeos largos", color: "var(--c1)", values: m.map(r => r.views_long), faded },
      { name: "Shorts", color: "var(--c2)", values: m.map(r => r.views_shorts), faded }] });
    chart($("#mes-rev", el), { ...base, stacked: true, yFmt: v => eur(v, days ? 2 : 0), tipFmt: v => eur(v), series: [
      { name: "Vídeos largos", color: "var(--c1)", values: m.map(r => r.revenue_long), faded },
      { name: "Shorts", color: "var(--c2)", values: m.map(r => r.revenue_shorts), faded },
      { name: "Otros", color: "var(--c3)", values: m.map(r => Math.max(0, +((r.revenue || 0) - (r.revenue_long || 0) - (r.revenue_shorts || 0)).toFixed(2))), faded }] });
    chart($("#mes-subs", el), { ...base, yFmt: signed, tipFmt: signed, series: [
      { name: "Suscriptores netos", color: v => v >= 0 ? "var(--good)" : "var(--bad)", values: m.map(r => r.subs_net), faded }] });
    chart($("#mes-pub", el), { ...base, stacked: true, tipFmt: n0, yMax: days ? 1 : undefined, series: [
      { name: "Vídeos largos", color: "var(--c1)", values: m.map(r => r.published_long), faded },
      { name: "Shorts", color: "var(--c2)", values: m.map(r => r.published_shorts), faded }] });

    const vL = sumOf(m, "views_long"), vS = sumOf(m, "views_shorts"), rL = sumOf(m, "revenue_long"), rS = sumOf(m, "revenue_shorts");
    const rpmL = vL ? rL / vL * 1000 : null, rpmS = vS ? rS / vS * 1000 : null;
    const pubL = sumOf(m, "published_long"), pubS = sumOf(m, "published_shorts");
    $("#mes-split", el).innerHTML = `
      <div class="sub" style="margin-bottom:12px">${days ? "Últimos 28 días" : mesRange ? "Últimos 12 meses" : "Desde abril de 2024"} · publicados: ${pubL} vídeos largos y ${pubS} shorts</div>
      ${hbars([
        { label: "Visualizaciones · vídeos largos", value: vL, right: `${compact(vL)} · ${pct(vL / ((vL + vS) || 1))}` },
        { label: "Visualizaciones · shorts", value: vS, right: `${compact(vS)} · ${pct(vS / ((vL + vS) || 1))}`, color: "var(--c2)" },
      ])}
      <div style="height:14px"></div>
      ${hbars([
        { label: "Ingresos · vídeos largos", value: rL, right: `${eur(rL, days ? 2 : 0)} · RPM ${eur(rpmL)}` },
        { label: "Ingresos · shorts", value: rS, right: `${eur(rS, days ? 2 : 0)} · RPM ${eur(rpmS)}`, color: "var(--c2)" },
      ])}`;
  };
  el.querySelectorAll("#mes-range button").forEach(b => b.addEventListener("click", () => { mesRange = +b.dataset.r; draw(); }));
  draw();

  table($("#mes-countries", el), [
    { key: "country", label: "País" },
    { key: "views", label: "Visualiz.", num: true, fmt: r => compact(r.views) },
    { key: "views_share", label: "% visualiz.", num: true, fmt: r => pct(r.views_share, 1) },
    { key: "revenue_share", label: "% ingresos", num: true, fmt: r => pct(r.revenue_share, 1) },
    { key: "revenue", label: "Ingresos", num: true, fmt: r => eur(r.revenue, 0) },
    { key: "rpm_long", label: "RPM largos", num: true, fmt: r => eur(r.rpm_long) },
  ], countries, { sortKey: "views", limit: 15 });
}

/* =====================================================================
   Pestaña ANÁLISIS
   ===================================================================== */

async function viewAnalisis(el) {
  let [formats, videos, fwc, ret, traffic, traffic90, audience, search, monthly, shortsRows] = await Promise.all([
    rows("analisis/formats.json"), rows("analisis/videos.json"), rows("analisis/first_week_curve.json"),
    rows("analisis/retention_curve.json"), rows("analisis/traffic.json"), rows("analisis/traffic_90d.json"),
    rows("analisis/audience.json"), rows("analisis/search_terms.json"), rows("analisis/monthly.json"),
    rows("analisis/shorts.json"),
  ]);
  traffic = mergeSources(traffic, ["views_long", "views_shorts", "hours_long", "share_long", "share_shorts"]);
  traffic90 = mergeSources(traffic90, ["views", "share"]);
  const generated = ((await load("analisis/videos.json")).meta || []).find(m => m.label === "Generado");
  const resumen = await load("claude/resumen.json").catch(e => { if (e instanceof AuthError) throw e; return null; });

  // hallazgos calculados
  const tot = f => monthly.reduce((a, r) => a + (r[f] || 0), 0);
  const vL = tot("views_long"), vS = tot("views_shorts"), rL = tot("revenue_long"), rS = tot("revenue_shorts");
  const longF = formats.filter(f => f.format !== "Short" && f.format !== "Directo" && f.videos >= 5);
  const best = longF.slice().sort((a, b) => b.median_d7 - a.median_d7)[0];
  const second = longF.slice().sort((a, b) => b.median_d7 - a.median_d7)[1];
  const evergreen = videos.filter(isEvergreen);
  const lateBloom = videos.filter(isLateBloomer);
  const egByFormat = {};
  evergreen.forEach(v => egByFormat[v.format] = (egByFormat[v.format] || 0) + 1);
  const egTop = Object.entries(egByFormat).sort((a, b) => b[1] - a[1])[0];
  const trTot = traffic.reduce((a, t) => a + t.views_long + t.views_shorts, 0);
  const trShare = rx => traffic.filter(t => rx.test(t.source)).reduce((a, t) => a + t.views_long + t.views_shorts, 0) / (trTot || 1);
  const endShare = trShare(/pantalla|final/i), plShare = trShare(/lista/i);

  el.innerHTML = `
    <div class="view-head"><div><h1>Análisis</h1><p>Lo que funciona en el canal, con todo el histórico. ${generated ? `Datos calculados el ${esc(dayShort(generated.value))}.` : ""}</p></div></div>

    <div id="an-claude"></div>

    <h2 class="section-title">Datos clave</h2>
    <div class="findings">
      <div class="card finding"><div class="big">${pct(rL / (rL + rS))}</div><h3>de los ingresos son de vídeos largos</h3><p>Los shorts traen el ${pct(vS / (vL + vS))} de las visitas, con un RPM de ${eur(rS / vS * 1000)} (largos: ${eur(rL / vL * 1000)}).</p></div>
      ${best ? `<div class="card finding"><div class="big">${compact(best.median_d7)}</div><h3>en 7 días: «${esc(best.format)}»</h3><p>Tu formato más fuerte.${second ? ` El siguiente, «${esc(second.format)}», hace ${compact(second.median_d7)}.` : ""}</p></div>` : ""}
      <div class="card finding"><div class="big">${evergreen.length}</div><h3>vídeos siguen trayendo visitas</h3><p>Con más de 6 meses${egTop ? `; sobre todo «${esc(egTop[0])}» (${egTop[1]})` : ""}.</p></div>
      <div class="card finding bad"><div class="big">${pct(endShare + plShare, 1)}</div><h3>de las visitas llegan por pantallas finales o listas</h3><p>El canal no lleva de un vídeo al siguiente.</p></div>
    </div>

    <h2 class="section-title">Rendimiento por formato</h2>
    <div class="card"><div class="card-head"><div><h2>Visualizaciones en la primera semana (mediana)</h2><div class="sub">Vídeos largos de cada formato, desde siempre</div></div></div><div id="an-fbars"></div></div>
    <div class="card" style="margin-top:12px"><div class="card-head"><div><h2>El vídeo más visto de cada formato</h2></div></div><div class="gallery" id="an-best"></div></div>
    <div class="card" style="margin-top:12px"><div id="an-formats"></div><p class="note">CTR de por vida (Studio). Ret. 50 % = parte de la audiencia que sigue a mitad del vídeo. Cola = visualizaciones a 90 días ÷ a 7 días. Pulsa una columna para ordenar.</p></div>

    <h2 class="section-title">Primera semana</h2>
    <div class="card"><div class="card-head"><div><h2>% de las visualizaciones a 28 días conseguido cada día</h2><div class="sub">Mediana por formato. Día 0 = día de publicación.</div></div></div><div class="chips" id="an-fw-chips"></div><div id="an-fw"></div></div>
    <div class="card" style="margin-top:12px"><div class="card-head"><div><h2>Los 20 últimos vídeos largos</h2><div class="sub">La etiqueta de la miniatura compara sus 7 primeros días con la mediana de su formato (1,0× = lo normal)</div></div></div><div id="an-last"></div></div>

    <h2 class="section-title">Retención por formato</h2>
    <div class="card"><div class="card-head"><div><h2>Audiencia que sigue viendo en cada punto del vídeo</h2><div class="sub">Mediana por formato. Por encima del 100 % = partes que se vuelven a ver.</div></div></div><div class="chips" id="an-ret-chips"></div><div id="an-ret"></div></div>

    <h2 class="section-title">Vídeos que destacan</h2>
    <div class="grid two">
      <div class="card"><div class="card-head"><div><h2>Evergreen</h2><div class="sub">≥ 6 meses, ≥ 5.000 visualizaciones y siguen sumando</div></div></div><div id="an-ever"></div></div>
      <div class="card"><div class="card-head"><div><h2>Despegue tardío</h2><div class="sub">Casi todas sus visitas llegaron después de la primera semana</div></div></div><div id="an-late"></div></div>
    </div>

    <h2 class="section-title">Audiencia y tráfico</h2>
    <div class="grid two">
      <div class="card"><div class="card-head"><div><h2>De dónde vienen las visualizaciones</h2><div class="sub">Desde siempre: % de cada tipo de vídeo</div></div></div>${legend([{ name: "Vídeos largos", color: "var(--c1)" }, { name: "Shorts", color: "var(--c2)" }])}<div id="an-traffic"></div></div>
      <div class="card"><div class="card-head"><div><h2>Tráfico de los últimos 90 días</h2></div></div><div id="an-traffic90"></div></div>
      <div class="card"><div class="card-head"><div><h2>Quién ve el canal</h2></div></div><div id="an-aud"></div></div>
      <div class="card"><div class="card-head"><div><h2>Búsquedas que más visitas traen</h2><div class="sub">Desde siempre</div></div></div><div id="an-search"></div></div>
    </div>
  `;

  renderResumen($("#an-claude", el), resumen);
  el.querySelector(".findings").insertAdjacentHTML("afterend",
    `<p class="note">Estas cifras las calcula la web con los datos del día: se actualizan solas cada mañana (unas 05:50, hora de España).</p>`);

  const fSorted = formats.filter(f => f.format !== "Short" && f.format !== "Directo").sort((a, b) => b.median_d7 - a.median_d7);
  $("#an-fbars", el).innerHTML = hbars(fSorted.map(f => ({ label: `${f.format} (${f.videos})`, value: f.median_d7, color: formatColor(f.format), right: n0(f.median_d7) })));

  const bestOf = fSorted.map(f => videos.filter(v => v.format === f.format).sort((a, b) => b.views - a.views)[0]).filter(Boolean);
  const topShort = shortsRows.slice().sort((a, b) => b.views - a.views)[0];
  if (topShort) bestOf.push(topShort);
  $("#an-best", el).innerHTML = bestOf.map(v => `
    <a class="gcard" href="${ytUrl(v.video_id)}" target="_blank" rel="noopener">
      ${thumb(v.video_id)}
      <span class="gfmt"><span class="fdot" style="background:${formatColor(v.format)}"></span>${esc(v.format)}</span>
      <span class="gtitle">${esc(cleanTitle(v.title))}</span>
      <span class="gviews"><b>${compact(v.views)}</b> visualizaciones</span>
    </a>`).join("");

  table($("#an-formats", el), [
    { key: "format", label: "Formato", fmt: r => `<span class="pill" style="background:transparent;padding:0"><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${formatColor(r.format)};margin-right:6px"></i></span>${esc(r.format)}` },
    { key: "videos", label: "Vídeos", num: true, fmt: r => `${r.videos}${r.videos_last_year ? ` <span class="muted small">(${r.videos_last_year} último año)</span>` : ""}` },
    { key: "median_d7", label: "Mediana 7 d", num: true, fmt: r => n0(r.median_d7) },
    { key: "median_ctr", label: "CTR", num: true, fmt: r => r.median_ctr == null ? "—" : n1(r.median_ctr) + " %" },
    { key: "median_ret_50pct", label: "Ret. 50 %", num: true, fmt: r => pct(r.median_ret_50pct) },
    { key: "rpm", label: "RPM", num: true, fmt: r => eur(r.rpm) },
    { key: "revenue", label: "Ingresos", num: true, fmt: r => eur(r.revenue, 0) },
    { key: "subs_per_1k", label: "Suscr./1.000", num: true, fmt: r => n1(r.subs_per_1k) },
    { key: "median_tail_d90_vs_d7", label: "Cola", num: true, fmt: r => r.median_tail_d90_vs_d7 == null ? "—" : n1(r.median_tail_d90_vs_d7) + "×" },
    { key: "last90", label: "Visualiz. 90 d", num: true, fmt: r => compact(r.last90) },
  ], formats, { sortKey: "median_d7" });

  // primera semana: curvas por formato
  const fwFormats = FORMAT_ORDER.filter(f => fwc.some(r => r.format === f));
  multiLine($("#an-fw-chips", el), $("#an-fw", el), fwFormats, ["Mejores para maxear", "Tops y tier lists", "Guías y consejos", "Short"],
    f => fwc.filter(r => r.format === f).sort((a, b) => a.day - b.day).map(r => r.share_of_d28),
    { labels: [...Array(28).keys()].map(d => `Día ${d}`), xFmt: i => `D${i}`, yFmt: v => pct(v), yMax: 1, n: f => (fwc.find(r => r.format === f) || {}).videos });

  const ret0 = fwFormats.filter(f => ret.some(r => r.format === f));
  const xsRet = [...new Set(ret.map(r => r.x))].sort((a, b) => a - b);
  multiLine($("#an-ret-chips", el), $("#an-ret", el), ret0, ["Mejores para maxear", "Tops y tier lists", "Guías y consejos", "Noticias y balance"],
    f => { const m = new Map(ret.filter(r => r.format === f).map(r => [r.x, r.watch_ratio])); return xsRet.map(x => m.get(x) ?? null); },
    { labels: xsRet.map(x => pct(x)), xFmt: i => pct(xsRet[i]), yFmt: v => pct(v), tipTitle: i => `Al ${pct(xsRet[i])} del vídeo`, n: f => (ret.find(r => r.format === f) || {}).videos });

  const last20 = videos.slice().sort((a, b) => b.published.localeCompare(a.published)).slice(0, 20);
  videoList($("#an-last", el), last20, [
    { label: "en 7 días", fmt: r => n0(r.d7) },
    { label: "CTR", fmt: r => r.ctr == null ? "—" : n1(r.ctr) + " %" },
    { label: "ret. 50 %", fmt: r => pct(r.ret_50pct) },
    { label: "ingresos", fmt: r => eur(r.revenue) },
  ], { badge: r => r.vs_format == null ? "" : `<span class="vbadge ${r.vs_format >= 1.2 ? "good" : r.vs_format < 0.8 ? "bad" : ""}">${n1(r.vs_format)}×</span>` });

  videoList($("#an-ever", el), evergreen.slice().sort((a, b) => b.last90 - a.last90), [
    { label: "en 90 días", fmt: r => n0(r.last90) },
    { label: "en total", fmt: r => compact(r.views) },
  ], { limit: 8, rank: true });
  if (!lateBloom.length) $("#an-late", el).innerHTML = `<div class="empty">Ninguno.</div>`;
  else videoList($("#an-late", el), lateBloom.slice().sort((a, b) => b.views - a.views), [
    { label: "en total", fmt: r => compact(r.views) },
    { label: "en la 1.ª semana", fmt: r => pct((r.d7 || 0) / r.views) },
  ], { limit: 8, rank: true });

  const trSorted = traffic.slice().sort((a, b) => (b.share_long + b.share_shorts) - (a.share_long + a.share_shorts)).slice(0, 10);
  $("#an-traffic", el).innerHTML = `<div class="hbars">${trSorted.map(t => `
    <div class="hbar"><div class="row"><span>${esc(t.source)}</span><span>${pct(t.share_long, 1)} · ${pct(t.share_shorts, 1)}</span></div>
    <div class="track"><div class="fill" style="width:${(t.share_long * 100).toFixed(1)}%"></div></div>
    <div class="track" style="margin-top:2px"><div class="fill alt" style="width:${(t.share_shorts * 100).toFixed(1)}%"></div></div></div>`).join("")}</div>`;
  $("#an-traffic90", el).innerHTML = hbars(traffic90.slice().sort((a, b) => b.views - a.views).slice(0, 10).map(t => ({ label: t.source, value: t.views, right: `${compact(t.views)} · ${pct(t.share, 1)}` })));

  const groups = [...new Set(audience.map(a => a.group))];
  $("#an-aud", el).innerHTML = groups.map(g => {
    let items = audience.filter(a => a.group === g);
    if (g.startsWith("Edad")) items = items.slice(0, 8);
    return `<div class="sub" style="margin:${g === groups[0] ? 0 : 16}px 0 8px;font-weight:600">${esc(g)}</div>` +
      hbars(items.map(a => ({ label: a.label, value: a.value, right: pct(a.value, 1) })), { max: g.startsWith("Visual") ? 1 : undefined });
  }).join("");
  $("#an-search", el).innerHTML = hbars(search.slice(0, 15).map(s => ({ label: s.term, value: s.views })), { alt: true });
}

/** Resumen escrito por Claude (clave claude/resumen.json; lo regenera la tarea semanal de Claude). */
function renderResumen(box, r) {
  if (!r) {
    box.innerHTML = `<div class="card claude"><div class="claude-head"><span class="claude-badge">Resumen de Claude</span></div>
      <div class="empty">Todavía no hay resumen. Lo escribe la tarea semanal de Claude.</div></div>`;
    return;
  }
  const host = u => { try { return new URL(u).hostname; } catch { return ""; } };
  const recCard = (i, n) => `
    <div class="rec">
      ${i.video_id ? `<a class="rec-thumb" href="${ytUrl(i.video_id)}" target="_blank" rel="noopener" title="Ejemplo del canal">${thumb(i.video_id)}<span class="rec-ex">Ejemplo</span></a>` : ""}
      <div class="rec-body">
        <div class="rec-top"><span class="rec-n">${n}</span>${i.tag ? `<span class="pill">${esc(i.tag)}</span>` : ""}</div>
        <div class="rec-title">${esc(i.title)}</div>
        ${i.detail ? `<div class="rec-detail">${esc(i.detail)}</div>` : ""}
      </div>
    </div>`;
  const rec = r.recommendations || {};
  box.innerHTML = `
    <div class="card claude">
      <div class="claude-head"><span class="claude-badge">✦ Resumen de Claude</span>
        <span class="small muted">${esc(dayShort(r.generated_at))}${r.data_until ? ` · datos hasta el ${esc(dayShort(r.data_until))}` : ""}${r.next ? ` · próximo: ${esc(r.next)}` : ""}</span></div>
      ${r.headline ? `<h2 class="claude-headline">${esc(r.headline)}</h2>` : ""}
      ${(r.summary || []).map(p => `<p class="claude-lead">${esc(p)}</p>`).join("")}
      ${r.stats && r.stats.length ? `<div class="cstats">${r.stats.map(x => `<div class="cstat ${esc(x.tone || "")}"><b>${esc(x.value)}</b><span>${esc(x.label)}</span></div>`).join("")}</div>` : ""}

      ${rec.long && rec.long.length ? `<h3 class="claude-h">🎬 Qué vídeos largos hacer</h3><div class="recs">${rec.long.map((i, k) => recCard(i, k + 1)).join("")}</div>` : ""}
      ${rec.shorts && rec.shorts.length ? `<h3 class="claude-h">📱 Qué shorts hacer</h3><div class="recs">${rec.shorts.map((i, k) => recCard(i, k + 1)).join("")}</div>` : ""}

      ${r.trends && r.trends.length ? `<h3 class="claude-h">🔥 Tendencias del nicho ahora</h3><div class="trends">${r.trends.map(t => `
        <a class="trend" href="${esc(t.url || "#")}" target="_blank" rel="noopener">
          ${host(t.url) ? `<img class="favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host(t.url))}&sz=64" alt="" loading="lazy">` : ""}
          <span><b>${esc(t.title)}</b>${t.detail ? `<span class="trend-d">${esc(t.detail)}</span>` : ""}<span class="trend-s">${esc(t.source || host(t.url))} ↗</span></span>
        </a>`).join("")}</div>` : ""}

      ${(r.sections || []).length ? `<div class="works">${r.sections.map((s, k) => {
        const tone = s.tone || (k === 0 ? "good" : "bad");
        return `<div class="works-col ${tone}"><h3 class="claude-h">${tone === "good" ? "✓" : "✕"} ${esc(s.title)}</h3>
          <ul>${(s.points || []).map(p => `<li><b>${esc(p.title || p)}</b>${p.detail ? `<span>${esc(p.detail)}</span>` : ""}</li>`).join("")}</ul></div>`;
      }).join("")}</div>` : ""}
      ${r.method ? `<p class="note">${esc(r.method)}</p>` : ""}
    </div>`;
}

function isEvergreen(v) {
  return v.age_days >= 180 && v.views >= 5000 && ((v.share_after_d90 ?? 0) >= 0.3 || (v.last90 ?? 0) >= 500);
}
function isLateBloomer(v) {
  const fw = v.d7 || 0;
  return (v.peak_week_start_day >= 21 && v.peak_week_views > 1.5 * fw) || (v.views >= 10000 && fw <= 0.2 * v.views);
}

/** Gráfico de líneas con un chip por serie para mostrarla u ocultarla. */
function multiLine(chipsEl, chartEl, names, initial, valuesOf, o) {
  const on = new Set(initial.filter(f => names.includes(f)));
  const series = names.map(f => ({ name: f, color: formatColor(f), values: valuesOf(f), hidden: !on.has(f) }));
  const c = chart(chartEl, { type: "line", labels: o.labels, xFmt: o.xFmt, yFmt: o.yFmt, tipTitle: o.tipTitle, yMax: o.yMax, series, height: 240, tipFmt: o.yFmt });
  chipsEl.innerHTML = names.map(f => `<button type="button" class="chip" aria-pressed="${on.has(f)}" data-f="${esc(f)}"><i style="background:${formatColor(f)}"></i>${esc(f)}${o.n && o.n(f) ? ` <span class="faint">(${o.n(f)})</span>` : ""}</button>`).join("");
  chipsEl.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => {
    const f = b.dataset.f, s = series.find(x => x.name === f);
    s.hidden = !s.hidden;
    if (series.every(x => x.hidden)) s.hidden = false;
    b.setAttribute("aria-pressed", String(!s.hidden));
    c.draw();
  }));
}

/* =====================================================================
   Pestaña CALENDARIO (fase 4): lo genera pipeline/calendario.py cada hora → calendar/plan.json
   ===================================================================== */

const PHASES = {
  guion: ["Guion", "var(--c2)"], gameplays: ["Gameplays", "var(--c4)"], voz: ["Voz", "var(--c5)"],
  montaje: ["Edición", "var(--c3)"], repaso: ["Edición", "var(--c3)"], miniatura: ["Miniatura", "var(--c8)"],
  subida: ["Subida", "var(--c7)"], short: ["Short", "var(--c6)"], publicar: ["Publicación", "var(--accent)"],
};
const LEGEND = ["guion", "gameplays", "voz", "montaje", "miniatura", "subida", "short", "publicar"];
const DOW = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return isoDay(d); };
const mondayOf = s => { const d = parseDay(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDay(d); };
const dowOf = s => (parseDay(s).getDay() + 6) % 7;
const hrs = h => n1(h).replace(",0", "");
const calState = { mode: "semana", anchor: null, sel: null };

function personalByDay(personal) {
  const out = {};
  for (const p of personal || []) {
    if (p.all_day) {
      const end = p.end > p.start ? p.end : addDays(p.start, 1);
      for (let d = p.start; d < end; d = addDays(d, 1)) (out[d] ||= []).push({ title: p.title, allDay: true });
    } else {
      const a = p.start.slice(0, 10), b = p.end.slice(0, 10);
      for (let d = a; d <= b; d = addDays(d, 1)) {
        const s = d === a ? p.start.slice(11, 16) : "00:00", e = d === b ? p.end.slice(11, 16) : "24:00";
        if (e > s) (out[d] ||= []).push({ title: p.title, start: s, end: e });
      }
    }
  }
  return out;
}

async function viewCalendario(el) {
  const [plan] = await Promise.all([load("calendar/plan.json"), loadTasks()]);
  el.innerHTML = `<div class="view-head"><div><h1>Calendario</h1>
      <p>${plan ? `Producción hasta el ${dateLong(plan.until)} · se recoloca cada hora según tus planes` : "Calendario de producción"}</p></div>
      <div class="seg" id="cal-mode"><button type="button" data-m="semana">Semana</button><button type="button" data-m="mes">Mes</button></div></div>
    <div id="cal-body"></div>`;
  const body = $("#cal-body", el);
  if (!plan) {
    body.innerHTML = `<div class="card soon"><h2>Aún no hay calendario</h2><p class="muted">Se genera en la tarea de cada hora cuando el calendario de Google está autorizado.</p></div>`;
    return;
  }
  const today = localDay(0);
  calState.anchor ||= today;
  calState.sel ||= today;
  const done = new Map((tasksDoc?.tasks || []).filter(t => t.source === "calendario").map(t => [t.id, t]));
  const items = plan.items.map(i => i.type === "task" && done.has(i.id) ? { ...i, done: done.get(i.id).done } : i);
  const byDay = {};
  for (const i of items) (byDay[i.day] ||= []).push(i);
  const pers = personalByDay(plan.personal);
  const free = new Set(plan.free_days || []);
  const videos = new Map((plan.videos || []).map(v => [v.id, v]));

  const timeOf = x => x.allDay ? "" : (x.start || "~");
  const dayItems = d => [...(byDay[d] || []), ...(pers[d] || []).map(p => ({ ...p, type: "personal" }))]
    .sort((a, b) => timeOf(a).localeCompare(timeOf(b)) || (a.type === "publish" ? 1 : 0) - (b.type === "publish" ? 1 : 0));
  const hoursOf = d => (byDay[d] || []).filter(i => i.type === "task").reduce((a, i) => a + (i.mins || 0), 0) / 60;

  const itemHtml = i => {
    if (i.type === "personal") return `<li class="ci personal"><span class="ct">${i.allDay ? "Todo el día" : `${i.start}–${i.end}`}</span>
        <span class="cbar"></span><span class="cx"><span class="cttl">${esc(i.title)}</span></span></li>`;
    const [lbl, col] = PHASES[i.phase] || ["", "var(--faint)"];
    const v = videos.get(i.video);
    if (i.type === "publish") {
      return `<li class="ci pub" style="--pc:${col}"><span class="ct">${esc(i.start)}</span><span class="cbar"></span>
        <span class="cx"><span class="ctag">${v?.kind === "short" ? "Sale el short" : "Sale el vídeo"}</span><span class="cttl">${esc(i.title)}</span></span></li>`;
    }
    return `<li class="ci${i.done ? " done" : ""}${i.late ? " late" : ""}" style="--pc:${col}">
      <span class="ct">${i.start ? `${i.start}–${i.end}` : ""}</span><span class="cbar"></span>
      <label class="cx" for="cb-${esc(i.id)}"><span class="ctag">${esc(lbl)}${i.late ? " · <b>con retraso</b>" : ""}</span>
        <span class="cttl">${esc(i.phase === "short" ? i.title.replace(/^[^:]+:\s*/, "") : i.label)}</span>
        ${i.phase === "short" ? `<span class="cvid">${esc(i.label)}</span>` : v ? `<span class="cvid">${esc(v.title)}</span>` : ""}</label>
      <input type="checkbox" id="cb-${esc(i.id)}" data-id="${esc(i.id)}" ${i.done ? "checked" : ""} aria-label="Hecha: ${esc(i.title)}"></li>`;
  };

  const dayHead = d => {
    const dd = parseDay(d), h = hoursOf(d);
    return `<div class="cday-h"><span class="cday-n${d === today ? " today" : ""}">${DOW[dowOf(d)]} <b>${dd.getDate()}</b> ${MONTHS[dd.getMonth()]}</span>
      <span class="small muted">${free.has(d) ? "Día libre" : h ? `${hrs(h)} h` : ""}</span></div>`;
  };
  const dayList = d => {
    const list = dayItems(d);
    return list.length ? `<ul class="clist">${list.map(itemHtml).join("")}</ul>`
      : `<div class="cempty">${free.has(d) ? "Día libre" : "Sin tareas"}</div>`;
  };

  const draw = () => {
    $("#cal-mode", el).querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === calState.mode));
    const legend = `<div class="clegend">${LEGEND.map(k => `<span><i style="background:${PHASES[k][1]}"></i>${PHASES[k][0]}</span>`).join("")}<span><i class="pers"></i>Planes personales</span></div>`;
    let nav, grid;
    if (calState.mode === "semana") {
      const mon = mondayOf(calState.anchor), sun = addDays(mon, 6);
      const days = [...Array(7)].map((_, k) => addDays(mon, k));
      const tot = days.reduce((a, d) => a + hoursOf(d), 0);
      const pubs = days.flatMap(d => (byDay[d] || []).filter(i => i.type === "publish"));
      const nL = pubs.filter(p => p.kind === "largo").length, nS = pubs.filter(p => p.kind === "short").length;
      nav = `<div class="cnav"><button class="btn" type="button" data-nav="-1" aria-label="Semana anterior">‹</button>
        <div class="cnav-t"><b>${dayShort(mon)} – ${dayShort(sun)}</b>
        <span class="small muted">${tot ? `${hrs(tot)} h de trabajo` : "Sin tareas"}${nL ? ` · ${nL} ${nL === 1 ? "vídeo" : "vídeos"}` : ""}${nS ? ` · ${nS} shorts` : ""}</span></div>
        <button class="btn" type="button" data-nav="1" aria-label="Semana siguiente">›</button></div>`;
      grid = `<div class="cweek">${days.map(d => `<section class="cday${d === today ? " is-today" : ""}${d < today ? " past" : ""}${free.has(d) ? " free" : ""}">${dayHead(d)}${dayList(d)}</section>`).join("")}</div>`;
    } else {
      const a = parseDay(calState.anchor), first = isoDay(new Date(a.getFullYear(), a.getMonth(), 1));
      const cells = [];
      for (let d = mondayOf(first); cells.length < 42; d = addDays(d, 1)) cells.push(d);
      while (cells.slice(-7).every(d => parseDay(d).getMonth() !== a.getMonth())) cells.splice(-7);
      nav = `<div class="cnav"><button class="btn" type="button" data-nav="-1" aria-label="Mes anterior">‹</button>
        <div class="cnav-t"><b>${monthLong(first.slice(0, 7)).replace(/^./, c => c.toUpperCase())}</b></div>
        <button class="btn" type="button" data-nav="1" aria-label="Mes siguiente">›</button></div>`;
      const cell = d => {
        const its = byDay[d] || [], p = pers[d] || [];
        const out = parseDay(d).getMonth() !== a.getMonth();
        const pubs = its.filter(i => i.type === "publish");
        const marks = pubs.map(i => `<span class="cm-pub${i.kind === "short" ? " s" : ""}" title="${i.kind === "short" ? "Short" : "Vídeo"}"></span>`).join("");
        const dots = its.filter(i => i.type === "task").map(i => `<i style="background:${(PHASES[i.phase] || [])[1]}"${i.done ? ' class="d"' : ""}></i>`).join("");
        const labels = [...pubs.filter(i => i.kind === "largo").map(i => `<span class="cm-l pubL">▶ ${esc(i.title)}</span>`),
          ...[...new Set(its.filter(i => i.type === "task").map(i => i.phase === "repaso" ? "montaje" : i.phase))].map(ph => `<span class="cm-l" style="--pc:${PHASES[ph][1]}">${PHASES[ph][0]}</span>`),
          ...p.slice(0, 1).map(x => `<span class="cm-l pers">${esc(x.title)}</span>`)].slice(0, 4).join("");
        return `<button type="button" class="cm${out ? " out" : ""}${d === today ? " today" : ""}${d === calState.sel ? " sel" : ""}${free.has(d) ? " free" : ""}" data-day="${d}" aria-label="${dateLong(d)}">
          <span class="cm-n"><span>${parseDay(d).getDate()}</span>${marks}</span>
          <span class="cm-dots">${dots}${p.length ? `<i class="pers"></i>` : ""}</span>
          <span class="cm-ls">${labels}</span></button>`;
      };
      grid = `<div class="cmonth"><div class="cm-head">${DOW.map(x => `<span>${x}</span>`).join("")}</div>
        <div class="cm-grid">${cells.map(cell).join("")}</div></div>
        <div class="cday-sel">${dayHead(calState.sel)}${dayList(calState.sel)}</div>`;
    }
    body.innerHTML = `<div class="card">${nav}${legend}${grid}</div>
      ${plan.unplaced?.length ? `<div class="error-box" style="margin-top:12px">${plan.unplaced.length} tareas no caben antes del final del calendario: revisa tus planes o la configuración.</div>` : ""}
      <p class="note">Las tareas se reparten solas de 18:30 a 23:30 (el fin de semana, de 10:00 a 18:30, con un día libre) sin pisar tus planes de Google Calendar: si añades uno, en menos de una hora se recolocan. También están en el calendario «TeknoBrawl» del móvil, con aviso a las ${esc(plan.aviso || "18:15")}.</p>`;
    body.querySelectorAll("[data-nav]").forEach(b => b.addEventListener("click", () => {
      const k = +b.dataset.nav;
      if (calState.mode === "semana") calState.anchor = addDays(calState.anchor, 7 * k);
      else { const d = parseDay(calState.anchor); calState.anchor = isoDay(new Date(d.getFullYear(), d.getMonth() + k, 1)); }
      draw();
    }));
    body.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => { calState.sel = b.dataset.day; draw(); }));
    body.querySelectorAll(".ci input[type=checkbox]").forEach(cb => cb.addEventListener("change", () => {
      const id = cb.dataset.id, it = items.find(x => x.id === id);
      let t = tasksDoc.tasks.find(x => x.id === id);
      if (!t && it) { t = { id, title: it.title.slice(0, 300), day: it.day, done: false, source: "calendario" }; tasksDoc.tasks.push(t); }
      if (!t) return;
      t.done = cb.checked;
      if (t.done) t.done_at = new Date().toISOString(); else delete t.done_at;
      if (it) it.done = t.done;
      rendered.hoy = false;
      draw(); saveTasks();
    }));
  };
  $("#cal-mode", el).querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    calState.mode = b.dataset.m;
    if (calState.mode === "mes") calState.sel = calState.anchor;
    draw();
  }));
  draw();
}

/* =====================================================================
   Navegación
   ===================================================================== */

const ICONS = {
  hoy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  semana: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  mes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-9"/><path d="M15 7h5v5"/></svg>',
  analisis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 13v-2M11 13V8M14 13v-3"/></svg>',
  calendario: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
};
const VIEWS = { hoy: ["Hoy", viewHoy], semana: ["Semana", viewSemana], mes: ["Mes", viewMes], analisis: ["Análisis", viewAnalisis], calendario: ["Calendario", viewCalendario] };
const rendered = {};
let current = "hoy";

function buildNav() {
  const html = Object.entries(VIEWS).map(([k, [label]]) => `<a href="#${k}" data-tab="${k}">${ICONS[k]}<span>${label}</span></a>`).join("");
  $("#tabs-bottom").innerHTML = html;
  $("#tabs-top").innerHTML = Object.entries(VIEWS).map(([k, [label]]) => `<a href="#${k}" data-tab="${k}">${label}</a>`).join("");
}

async function show(tab, force = false) {
  if (!VIEWS[tab]) tab = "hoy";
  current = tab;
  document.querySelectorAll("a[data-tab]").forEach(a => {
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  document.querySelectorAll(".view").forEach(v => v.hidden = v.dataset.tab !== tab);
  document.title = `${VIEWS[tab][0]} · TeknoBrawl Hub`;
  const el = $(`#view-${tab}`);
  if (rendered[tab] && !force) { for (const c of charts) if (el.contains(c.el)) c.draw(); return; }
  rendered[tab] = true;
  el.innerHTML = `<div class="loading">Cargando…</div>`;
  try { await VIEWS[tab][1](el); }
  catch (e) {
    rendered[tab] = false;
    if (e instanceof AuthError) return authExpired();
    console.error(e);
    el.innerHTML = `<div class="error-box">No se han podido cargar los datos: ${esc(e.message)}. <button class="btn" type="button" onclick="location.reload()">Reintentar</button></div>`;
  }
}

/* tema */
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.content = dark ? "#0f0f12" : "#f5f5f7");
}
function initTheme() {
  let t = null;
  try { t = localStorage.getItem("hub-theme"); } catch {}
  applyTheme(t);
  $("#theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    try { localStorage.setItem("hub-theme", next); } catch {}
    applyTheme(next);
  });
}

/* hoja de estado */
function initSheet() {
  const sheet = $("#status-sheet");
  $("#fresh").addEventListener("click", () => { sheet.hidden = false; });
  sheet.addEventListener("click", e => { if (e.target === sheet || e.target.closest("[data-close]")) sheet.hidden = true; });
  document.addEventListener("keydown", e => { if (e.key === "Escape") sheet.hidden = true; });
  $("#reload").addEventListener("click", () => { sheet.hidden = true; reloadAll(); });
  fetch("/auth/me", { cache: "no-store" }).then(r => r.json()).then(me => {
    if (me.email) $("#who").textContent = `Sesión hasta el ${new Date(me.exp * 1000).toLocaleDateString("es-ES")}`;
  }).catch(() => {});
}

buildNav();
initTheme();
initSheet();
refreshStatus();
window.addEventListener("hashchange", () => show(location.hash.slice(1)));
show(location.hash.slice(1) || "hoy");
// al volver a la app tras un rato, recargar los datos
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - loadedAt > 15 * 60 * 1000) reloadAll();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
