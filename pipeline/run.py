"""Tareas programadas del Hub (GitHub Actions). Una por frecuencia:

  python pipeline/run.py hourly   cada hora: instantánea de la Data API         → snapshots/hourly.json
  python pipeline/run.py sync     cada 6 h: sync incremental + análisis semanal → db, analisis/semana.json
  python pipeline/run.py daily    cada día: sync + Reporting API + todos los análisis + copia de seguridad

Cada tarea deja su estado en status/<tarea>.json (también si falla).
Escrituras en KV al día: hourly 2×24 = 48, sync 3×4 = 12, daily ~18 → unas 80 de las 1.000 permitidas.
Los registros de GitHub Actions son públicos: aquí solo se imprimen recuentos, nunca datos del canal.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sqlite3
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ.setdefault("TB_ROOT", str(Path.cwd() / "work"))
os.environ.setdefault("TB_ORIGIN", "github")
sys.path.insert(0, str(HERE))

import analisis  # noqa: E402
import kv  # noqa: E402
import snapshot  # noqa: E402
import yt  # noqa: E402

OUT = Path(os.environ["TB_ROOT"]) / "data" / "analisis"


def now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def data_until():
    con = sqlite3.connect(yt.DB)
    try:
        return con.execute("SELECT MAX(day) FROM channel_daily").fetchone()[0]
    finally:
        con.close()


def cloud_sync(reporting: bool, full_analysis: bool, info: dict):
    prev = kv.pull_db()
    if prev is None:
        raise RuntimeError("en KV no hay base de datos: súbela antes desde el PC (hub_setup.py push-db)")
    if full_analysis:  # copia de seguridad diaria de la versión anterior, por si una ejecución la estropea
        kv.put(kv.DB_BACKUP_KEY, prev, "application/gzip")
    yt.cmd_sync(argparse.Namespace(full=False, reporting=reporting))
    con = sqlite3.connect(yt.DB)
    info["snapshot_rows_merged"] = snapshot.merge_into_db(con)
    con.close()
    print(f"  instantáneas pasadas a la base de datos: {info['snapshot_rows_merged']} filas nuevas")

    analisis.main(["todo" if full_analysis else "semana", "--quiet"])
    files = {f"analisis/{p.name}": p.read_text(encoding="utf-8")
             for p in sorted(OUT.glob("*.json")) if full_analysis or p.name == "semana.json"}
    blob = kv.pack_db()
    kv.push_db(blob=blob)
    kv.put_many(files)
    print(f"  JSON subidos: {len(files)}")
    info.update(db_gz_bytes=len(blob), json_keys=sorted(files), data_until=data_until())


def main():
    job = sys.argv[1] if len(sys.argv) > 1 else ""
    if job not in ("hourly", "sync", "daily"):
        sys.exit(__doc__)
    t0, info, ok = time.time(), {"job": job, "started_at": now()}, False
    try:
        if job == "hourly":
            snapshot.main()
        else:
            cloud_sync(reporting=(job == "daily"), full_analysis=(job == "daily"), info=info)
        ok = True
    except Exception as e:
        info["error"] = f"{type(e).__name__}: {e}"[:500]
        traceback.print_exc()
    finally:
        info.update(ok=ok, finished_at=now(), seconds=round(time.time() - t0),
                    run_url=(f"{os.environ.get('GITHUB_SERVER_URL')}/{os.environ.get('GITHUB_REPOSITORY')}"
                             f"/actions/runs/{os.environ.get('GITHUB_RUN_ID')}") if os.environ.get("GITHUB_RUN_ID") else None)
        try:
            kv.put_json(f"status/{job}.json", info)
        except Exception as e:  # noqa: BLE001
            print(f"  ! no se pudo guardar el estado: {e}")
    print(f"{job}: {'OK' if ok else 'ERROR'} en {info['seconds']} s")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
