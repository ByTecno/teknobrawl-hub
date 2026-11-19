// GET /api/<clave>  →  devuelve el valor guardado en Workers KV (binding HUB).
// Solo claves sencillas (letras, números, guiones, puntos y barras).
export async function onRequestGet({ params, env }) {
  const key = (params.key || []).join("/");
  if (!/^[\w.\-\/]{1,200}$/.test(key)) {
    return json({ error: "clave no válida" }, 400);
  }
  const value = await env.HUB.get(key);
  if (value === null) return json({ error: "no existe", key }, 404);
  return new Response(value, {
    headers: {
      "content-type": key.endsWith(".json") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
