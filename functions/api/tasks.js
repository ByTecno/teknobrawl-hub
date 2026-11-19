// POST /api/tasks  →  guarda la lista de tareas del Hub en KV (clave tasks/list.json).
// La lectura va por GET /api/tasks/list.json ([[key]].js). El inicio de sesión lo exige _middleware.js.
//
// El navegador manda la lista completa (no cambios sueltos): KV puede servir una lectura de hasta 60 s de
// antigüedad, así que leer-modificar-escribir aquí podría perder un check hecho justo antes.
// Formato: {updated_at, tasks: [{id, title, day: "AAAA-MM-DD", done, done_at?, source?, detail?}]}

const KEY = "tasks/list.json";
const MAX_BYTES = 200 * 1024;
const MAX_TASKS = 1000;

export async function onRequestPost({ request, env }) {
  if (!(request.headers.get("content-type") || "").startsWith("application/json")) {
    return json({ error: "se esperaba JSON" }, 415);
  }
  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ error: "demasiado grande" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: "JSON no válido" }, 400); }

  const tasks = Array.isArray(body.tasks) ? body.tasks : null;
  if (!tasks || tasks.length > MAX_TASKS) return json({ error: "lista no válida" }, 400);
  const clean = [];
  for (const t of tasks) {
    if (!t || typeof t.id !== "string" || typeof t.title !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t.day || "")) {
      return json({ error: "tarea no válida" }, 400);
    }
    clean.push({
      id: t.id.slice(0, 64), title: t.title.slice(0, 300), day: t.day, done: !!t.done,
      ...(t.done_at ? { done_at: String(t.done_at).slice(0, 40) } : {}),
      ...(t.source ? { source: String(t.source).slice(0, 30) } : {}),
      ...(t.detail ? { detail: String(t.detail).slice(0, 1000) } : {}),
    });
  }
  const doc = { updated_at: new Date().toISOString(), tasks: clean };
  await env.HUB.put(KEY, JSON.stringify(doc));
  return json(doc, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
