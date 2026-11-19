"""Workers KV por la API REST de Cloudflare (sin dependencias externas). Nunca imprime credenciales.

Credenciales: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID y KV_NAMESPACE_ID, de las variables de entorno
(secretos de GitHub) o, si no están, del .env de TB_ROOT.

Uso desde el PC (lo envuelve scripts/hub_setup.py):
  python kv.py pull-db            # baja la base de datos de la nube a TB_ROOT/data/teknobrawl.db
  python kv.py push-db [--force]  # sube la local (solo la primera vez: sin --force no pisa la de la nube)
  python kv.py list [prefijo]     # lista los nombres de las claves
"""
from __future__ import annotations

import gzip
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("TB_ROOT") or Path(__file__).resolve().parent.parent)
DB = ROOT / "data" / "teknobrawl.db"
DB_KEY = "db/teknobrawl.db.gz"
DB_BACKUP_KEY = "db/teknobrawl.prev.db.gz"
MAX_VALUE = 25 * 1024 * 1024        # límite de KV por valor
SAFE_VALUE = 20 * 1024 * 1024       # a partir de aquí, avisar y no subir (margen)
_NAMES = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "KV_NAMESPACE_ID")


def _cfg():
    env = {}
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    env.update({k: os.environ[k] for k in _NAMES if os.environ.get(k)})
    missing = [k for k in _NAMES if not env.get(k)]
    if missing:
        sys.exit(f"Faltan credenciales de Cloudflare: {', '.join(missing)}")
    return env


def _req(method, path, data=None, ctype=None, retries=4):
    c = _cfg()
    url = (f"https://api.cloudflare.com/client/v4/accounts/{c['CLOUDFLARE_ACCOUNT_ID']}"
           f"/storage/kv/namespaces/{c['KV_NAMESPACE_ID']}{path}")
    headers = {"Authorization": f"Bearer {c['CLOUDFLARE_API_TOKEN']}"}
    if ctype:
        headers["Content-Type"] = ctype
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=headers),
                                        timeout=120) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return 404, b""
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(2 ** attempt * 3)
                continue
            body = e.read()[:300].decode("utf-8", "replace")
            raise RuntimeError(f"KV {method} {path.split('?')[0]}: HTTP {e.code} {body}") from None
        except urllib.error.URLError:
            if attempt < retries - 1:
                time.sleep(2 ** attempt * 3)
                continue
            raise


def _k(key):
    return "/values/" + urllib.parse.quote(key, safe="")


def get(key) -> bytes | None:
    status, body = _req("GET", _k(key))
    return None if status == 404 else body


def get_json(key, default=None):
    b = get(key)
    return default if b is None else json.loads(b)


def put(key, value: bytes | str, ctype="application/octet-stream"):
    if isinstance(value, str):
        value = value.encode("utf-8")
    if len(value) > MAX_VALUE:
        raise RuntimeError(f"{key}: {len(value)} bytes, por encima del límite de KV (25 MB)")
    _req("PUT", _k(key), value, ctype)


def put_json(key, obj):
    put(key, json.dumps(obj, ensure_ascii=False, separators=(",", ":")), "application/json")


def put_many(items: dict[str, bytes | str]):
    """Varias claves en una sola llamada (cada clave cuenta igualmente como una escritura)."""
    import base64
    payload = []
    for k, v in items.items():
        if isinstance(v, str):
            payload.append({"key": k, "value": v})
        else:
            payload.append({"key": k, "value": base64.b64encode(v).decode(), "base64": True})
    for i in range(0, len(payload), 1000):
        _req("PUT", "/bulk", json.dumps(payload[i:i + 1000]).encode(), "application/json")


def keys(prefix=""):
    out, cursor = [], None
    while True:
        q = {"limit": 1000, **({"prefix": prefix} if prefix else {}), **({"cursor": cursor} if cursor else {})}
        _, body = _req("GET", "/keys?" + urllib.parse.urlencode(q))
        r = json.loads(body)
        out += [x["name"] for x in r["result"]]
        cursor = r.get("result_info", {}).get("cursor")
        if not cursor:
            return out

# ------------------------------------------------------------------ base de datos


def pull_db(dest: Path = DB) -> bytes | None:
    """Baja y descomprime la base de datos. Devuelve el gzip descargado, o None si en KV no hay ninguna."""
    blob = get(DB_KEY)
    if blob is None:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    tmp.write_bytes(gzip.decompress(blob))
    check_db(tmp)
    for side in ("-wal", "-shm"):
        Path(str(dest) + side).unlink(missing_ok=True)
    tmp.replace(dest)
    print(f"  base de datos bajada: {len(blob) / 1e6:.1f} MB comprimida -> {dest.stat().st_size / 1e6:.1f} MB")
    return blob


def check_db(path: Path):
    con = sqlite3.connect(path)
    try:
        ok = con.execute("PRAGMA quick_check").fetchone()[0]
        n = con.execute("SELECT COUNT(*) FROM videos").fetchone()[0]
        d = con.execute("SELECT COUNT(*) FROM channel_daily").fetchone()[0]
    finally:
        con.close()
    if ok != "ok" or n == 0 or d == 0:
        raise RuntimeError(f"base de datos dañada o vacía (quick_check={ok}, vídeos={n}, días={d})")


def pack_db(src: Path = DB) -> bytes:
    """Cierra el WAL (todo dentro del archivo), comprueba la base de datos y la comprime."""
    con = sqlite3.connect(src)
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    con.execute("PRAGMA journal_mode=DELETE")
    con.close()
    check_db(src)
    with tempfile.TemporaryDirectory() as td:
        gz = Path(td) / "db.gz"
        with open(src, "rb") as f, gzip.GzipFile(gz, "wb", 9, mtime=0) as g:
            shutil.copyfileobj(f, g, 1 << 20)
        blob = gz.read_bytes()
    if len(blob) > SAFE_VALUE:
        raise RuntimeError(f"la base de datos comprimida ocupa {len(blob) / 1e6:.1f} MB: demasiado cerca del "
                           "límite de KV (25 MB). Hay que pasar a R2 o recortar tablas.")
    return blob


def push_db(src: Path = DB, blob: bytes | None = None):
    blob = blob or pack_db(src)
    put(DB_KEY, blob, "application/gzip")
    print(f"  base de datos subida: {src.stat().st_size / 1e6:.1f} MB -> {len(blob) / 1e6:.1f} MB comprimida")
    return len(blob)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "pull-db":
        if not pull_db():
            sys.exit("En KV no hay base de datos todavía.")
    elif cmd == "push-db":
        if "--force" not in sys.argv and get(DB_KEY) is not None:
            sys.exit("Ya hay una base de datos en KV (la mantiene GitHub Actions). No se pisa sin --force.")
        push_db()
    elif cmd == "list":
        for k in keys(sys.argv[2] if len(sys.argv) > 2 else ""):
            print(k)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
