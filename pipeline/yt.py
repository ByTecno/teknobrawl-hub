"""TeknoBrawl: descarga de estadísticas de YouTube a una base SQLite.

Versión única: la usan GitHub Actions (pipeline/run.py) y el PC (scripts/yt.py de la carpeta del
proyecto, que solo llama a este archivo). La carpeta de trabajo es TB_ROOT (por defecto, la del
repositorio): ahí están .env, data/teknobrawl.db y secrets/.

Uso (desde la carpeta del proyecto):
    .venv/Scripts/python scripts/yt.py auth            # una sola vez: autoriza la cuenta del canal
    .venv/Scripts/python scripts/yt.py sync            # descarga/actualiza todo (incremental)
    .venv/Scripts/python scripts/yt.py sync --full     # vuelve a descargar todo el histórico
    .venv/Scripts/python scripts/yt.py q "SELECT ..."  # consulta SQL compacta sobre data/teknobrawl.db
    .venv/Scripts/python scripts/yt.py api --metrics views,likes --dimensions day --start 2026-11-01 [--filters video==ID]
                                                        # llamada directa a la Analytics API

Credenciales (YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN): variables de entorno (secretos de
GitHub) o, si no están, el .env de TB_ROOT. Solo lectura.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(os.environ.get("TB_ROOT") or Path(__file__).resolve().parent.parent)
ENV = ROOT / ".env"
DB = ROOT / "data" / "teknobrawl.db"
CLIENT_SECRET_FILE = ROOT / "secrets" / "client_secret.json"
SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
]
TODAY = dt.date.today()

# ---------------------------------------------------------------- credenciales

def load_env() -> dict:
    env = {}
    if ENV.exists():
        for line in ENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    for k in ("YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"):  # en GitHub Actions, de los secretos
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def save_env(updates: dict) -> None:
    lines = ENV.read_text(encoding="utf-8").splitlines() if ENV.exists() else []
    done = set()
    for i, line in enumerate(lines):
        k = line.split("=", 1)[0].strip()
        if k in updates:
            lines[i] = f"{k}={updates[k]}"
            done.add(k)
    lines += [f"{k}={v}" for k, v in updates.items() if k not in done]
    ENV.write_text("\n".join(lines) + "\n", encoding="utf-8")


def cmd_auth(_args) -> None:
    from google_auth_oauthlib.flow import InstalledAppFlow

    if not CLIENT_SECRET_FILE.exists():
        sys.exit(f"Falta {CLIENT_SECRET_FILE}")
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET_FILE), SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline",
                                  authorization_prompt_message="Abriendo el navegador para autorizar...")
    info = json.loads(CLIENT_SECRET_FILE.read_text())
    info = info.get("installed") or info.get("web")
    save_env({"YT_CLIENT_ID": info["client_id"], "YT_CLIENT_SECRET": info["client_secret"],
              "YT_REFRESH_TOKEN": creds.refresh_token})
    print("Autorizado. Token guardado en .env")


def services():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    env = load_env()
    for k in ("YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"):
        if k not in env:
            sys.exit(f"Falta {k} en .env: ejecuta primero 'yt.py auth'")
    creds = Credentials(None, refresh_token=env["YT_REFRESH_TOKEN"], client_id=env["YT_CLIENT_ID"],
                        client_secret=env["YT_CLIENT_SECRET"], token_uri="https://oauth2.googleapis.com/token",
                        scopes=SCOPES)
    data = build("youtube", "v3", credentials=creds, cache_discovery=False)
    analytics = build("youtubeAnalytics", "v2", credentials=creds, cache_discovery=False)
    return data, analytics, creds

# ---------------------------------------------------------------- helpers API

_creds = None


def report(start, end, metrics, dimensions=None, filters=None, sort=None, max_results=None, retries=4):
    """Una consulta a la Analytics API. Devuelve lista de dicts. Cliente por hilo (httplib2 no es thread-safe)."""
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError

    # currency=EUR: sin él la API devuelve los ingresos en dólares
    params = dict(ids="channel==MINE", startDate=str(start), endDate=str(end), metrics=metrics, currency="EUR")
    if dimensions:
        params["dimensions"] = dimensions
    if filters:
        params["filters"] = filters
    if sort:
        params["sort"] = sort
    if max_results:
        params["maxResults"] = max_results
    svc = build("youtubeAnalytics", "v2", credentials=_creds, cache_discovery=False)
    for attempt in range(retries):
        try:
            r = svc.reports().query(**params).execute()
            cols = [h["name"] for h in r.get("columnHeaders", [])]
            return [dict(zip(cols, row)) for row in r.get("rows", []) or []]
        except HttpError as e:
            if e.resp.status in (429, 500, 503) and attempt < retries - 1:
                time.sleep(2 ** attempt * 2)
                continue
            raise


def try_report(*a, **k):
    from googleapiclient.errors import HttpError
    try:
        return report(*a, **k)
    except HttpError as e:
        msg = json.loads(e.content).get("error", {}).get("message", str(e)) if e.content else str(e)
        print(f"  ! consulta fallida ({k.get('dimensions') or a[3] if len(a) > 3 else ''}): {msg[:160]}")
        return None


def iso_dur(s: str) -> int:
    import re
    m = re.match(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return 0
    d, h, mi, se = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + se

# ---------------------------------------------------------------- base de datos

def db() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute("PRAGMA journal_mode=WAL")
    return con


def replace_table(con, name, rows, key_cols=None):
    """Crea la tabla si no existe (columnas de las filas) e inserta con INSERT OR REPLACE."""
    if not rows:
        return
    cols = list({c: None for r in rows for c in r})
    existing = [r[1] for r in con.execute(f"PRAGMA table_info({name})")]
    if not existing:
        pk = f", PRIMARY KEY ({','.join(key_cols)})" if key_cols else ""
        con.execute(f"CREATE TABLE {name} ({','.join(f'\"{c}\"' for c in cols)}{pk})")
    else:
        for c in cols:
            if c not in existing:
                con.execute(f'ALTER TABLE {name} ADD COLUMN "{c}"')
    ph = ",".join("?" * len(cols))
    con.executemany(f"INSERT OR REPLACE INTO {name} ({','.join(f'\"{c}\"' for c in cols)}) VALUES ({ph})",
                    [tuple(r.get(c) for c in cols) for r in rows])
    con.commit()

# ---------------------------------------------------------------- sincronización

VIDEO_DAILY_METRICS = ("views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,"
                       "subscribersGained,subscribersLost,likes,dislikes,comments,shares,"
                       "videosAddedToPlaylists,estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,"
                       "cpm,playbackBasedCpm,monetizedPlaybacks")
CHANNEL_DAILY_METRICS = ("views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,"
                         "subscribersGained,subscribersLost,likes,comments,shares,"
                         "estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,grossRevenue,"
                         "cpm,playbackBasedCpm,monetizedPlaybacks,adImpressions")


def sync_videos(data, con):
    ch = data.channels().list(part="snippet,contentDetails,statistics", mine=True).execute()["items"][0]
    replace_table(con, "channel", [{
        "id": ch["id"], "title": ch["snippet"]["title"], "published": ch["snippet"]["publishedAt"][:10],
        "subscribers": int(ch["statistics"].get("subscriberCount", 0)),
        "views": int(ch["statistics"].get("viewCount", 0)), "videos": int(ch["statistics"].get("videoCount", 0)),
        "fetched": str(TODAY)}], ["id"])
    uploads = ch["contentDetails"]["relatedPlaylists"]["uploads"]
    ids, token = [], None
    while True:
        r = data.playlistItems().list(part="contentDetails", playlistId=uploads, maxResults=50, pageToken=token).execute()
        ids += [i["contentDetails"]["videoId"] for i in r["items"]]
        token = r.get("nextPageToken")
        if not token:
            break
    rows = []
    for i in range(0, len(ids), 50):
        r = data.videos().list(part="snippet,contentDetails,statistics,status", id=",".join(ids[i:i + 50])).execute()
        for v in r["items"]:
            s, st = v["snippet"], v.get("statistics", {})
            rows.append({
                "video_id": v["id"], "title": s["title"], "published": s["publishedAt"],
                "published_date": s["publishedAt"][:10], "duration_s": iso_dur(v["contentDetails"]["duration"]),
                "privacy": v["status"]["privacyStatus"], "views_total": int(st.get("viewCount", 0)),
                "likes_total": int(st.get("likeCount", 0)), "comments_total": int(st.get("commentCount", 0)),
                "tags": "|".join(s.get("tags", [])), "description": s.get("description", ""),
                "thumbnail": (s.get("thumbnails", {}).get("maxres") or s.get("thumbnails", {}).get("high") or {}).get("url"),
            })
    replace_table(con, "videos", rows, ["video_id"])
    print(f"  videos: {len(rows)}")
    return ch["snippet"]["publishedAt"][:10], rows


def sync_content_type(con, start, videos):
    """Marca cada vídeo como SHORTS / VIDEO_ON_DEMAND / LIVE_STREAM con la dimensión creatorContentType."""
    out = []
    ids = [v["video_id"] for v in videos]
    for i in range(0, len(ids), 200):
        chunk = ids[i:i + 200]
        rows = try_report(start, TODAY, "views", "video,creatorContentType", filters="video==" + ",".join(chunk))
        if rows is None:
            break
        out += [{"video_id": r["video"], "content_type": r["creatorContentType"]} for r in rows]
    if out:
        seen = {}
        for r in out:  # si aparece con varios tipos, nos quedamos con el primero no-UNSPECIFIED
            if r["video_id"] not in seen or seen[r["video_id"]] == "UNSPECIFIED":
                seen[r["video_id"]] = r["content_type"]
        if "content_type" not in [c[1] for c in con.execute("PRAGMA table_info(videos)")]:
            con.execute("ALTER TABLE videos ADD COLUMN content_type")
        con.executemany("UPDATE videos SET content_type=? WHERE video_id=?", [(ct, vid) for vid, ct in seen.items()])
        con.commit()
    print(f"  tipo de contenido: {len(out)} filas")


def sync_channel(con, start):
    jobs = {
        "channel_daily": (CHANNEL_DAILY_METRICS, "day", None, None, ["day"]),
        "channel_daily_by_type": ("views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,shares",
                                  "day,creatorContentType", None, None, ["day", "creatorContentType"]),
        "traffic_daily": ("views,estimatedMinutesWatched", "day,insightTrafficSourceType",
                          None, None, ["day", "insightTrafficSourceType"]),
        "traffic_by_type": ("views,estimatedMinutesWatched", "insightTrafficSourceType,creatorContentType",
                            None, None, ["insightTrafficSourceType", "creatorContentType"]),
        "country": ("views,estimatedMinutesWatched,averageViewDuration,subscribersGained,estimatedRevenue",
                    "country", None, "-views", ["country"]),
        "country_by_type": ("views,estimatedMinutesWatched", "country,creatorContentType", None, None,
                            ["country", "creatorContentType"]),
        "country_monthly": ("views,estimatedRevenue", "month,country", None, None, ["month", "country"]),
        "demographics": ("viewerPercentage", "ageGroup,gender", None, None, ["ageGroup", "gender"]),
        "device": ("views,estimatedMinutesWatched", "deviceType,operatingSystem", None, None, ["deviceType", "operatingSystem"]),
        "playback_location": ("views,estimatedMinutesWatched", "insightPlaybackLocationType", None, None,
                              ["insightPlaybackLocationType"]),
        "subscribed_status": ("views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage",
                              "subscribedStatus,creatorContentType", None, None, ["subscribedStatus", "creatorContentType"]),
        "sharing": ("shares", "sharingService", None, "-shares", ["sharingService"]),
        "search_terms": ("views,estimatedMinutesWatched", "insightTrafficSourceDetail",
                         "insightTrafficSourceType==YT_SEARCH", "-views", ["insightTrafficSourceDetail"]),
        "suggested_from": ("views,estimatedMinutesWatched", "insightTrafficSourceDetail",
                           "insightTrafficSourceType==RELATED_VIDEO", "-views", ["insightTrafficSourceDetail"]),
        "external_sources": ("views", "insightTrafficSourceDetail", "insightTrafficSourceType==EXT_URL", "-views",
                             ["insightTrafficSourceDetail"]),
        "playlists": ("views,estimatedMinutesWatched,playlistStarts,viewsPerPlaylistStart", "playlist", None, "-views",
                      ["playlist"]),
    }
    for name, (metrics, dims, filt, sort, keys) in jobs.items():
        mr = 25 if "insightTrafficSourceDetail" in dims else (200 if dims in ("playlist", "country") else None)
        s, e = start, TODAY
        if dims.startswith("month"):  # la dimensión month exige meses completos
            s = dt.date.fromisoformat(str(start)).replace(day=1)
            e = (TODAY.replace(day=1) - dt.timedelta(days=1)).replace(day=1)  # el fin también va en día 1
        rows = try_report(s, e, metrics, dims, filters=filt, sort=sort, max_results=mr)
        if rows is not None:
            con.execute(f"DROP TABLE IF EXISTS {name}")
            replace_table(con, name, rows, keys)
            print(f"  {name}: {len(rows)}")
    # términos de búsqueda por mes (últimos 12 meses), para ver tendencias
    rows = []
    m = dt.date(TODAY.year - 1, TODAY.month, 1)
    while m <= TODAY:
        nxt = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        r = try_report(m, min(nxt - dt.timedelta(days=1), TODAY), "views", "insightTrafficSourceDetail",
                       filters="insightTrafficSourceType==YT_SEARCH", sort="-views", max_results=25)
        rows += [{"month": str(m)[:7], **x} for x in (r or [])]
        m = nxt
    con.execute("DROP TABLE IF EXISTS search_terms_monthly")
    replace_table(con, "search_terms_monthly", rows, ["month", "insightTrafficSourceDetail"])


def per_video_jobs(con, videos, full):
    """Serie diaria, retención y tráfico de cada vídeo. Incremental: solo lo que puede haber cambiado."""
    have = {}
    try:
        have = dict(con.execute("SELECT video_id, MAX(day) FROM video_daily GROUP BY video_id"))
    except sqlite3.OperationalError:
        pass
    have_ret = set()
    try:
        have_ret = {r[0] for r in con.execute("SELECT DISTINCT video_id FROM video_retention")}
    except sqlite3.OperationalError:
        pass
    recent = str(TODAY - dt.timedelta(days=60))

    def work(v):
        vid, pub = v["video_id"], v["published_date"]
        out = {"daily": [], "ret": None, "traffic": None}
        start = pub if (full or vid not in have) else str(dt.date.fromisoformat(have[vid]) - dt.timedelta(days=5))
        rows = try_report(start, TODAY, VIDEO_DAILY_METRICS, "day", filters=f"video=={vid}")
        out["daily"] = [{"video_id": vid, **r} for r in (rows or [])]
        if full or vid not in have_ret or pub >= recent:
            for aud in ("ORGANIC",):
                r = try_report(pub, TODAY, "audienceWatchRatio,relativeRetentionPerformance", "elapsedVideoTimeRatio",
                               filters=f"video=={vid};audienceType=={aud}")
                if r is None:  # algunos vídeos (p. ej. shorts) no admiten relativeRetentionPerformance
                    r = try_report(pub, TODAY, "audienceWatchRatio", "elapsedVideoTimeRatio", filters=f"video=={vid}")
                out["ret"] = [{"video_id": vid, **x} for x in (r or [])]
            r = try_report(pub, TODAY, "views,estimatedMinutesWatched,averageViewDuration", "insightTrafficSourceType",
                           filters=f"video=={vid}")
            out["traffic"] = [{"video_id": vid, **x} for x in (r or [])]
        return vid, out

    todo = [v for v in videos if v["privacy"] == "public" or v["views_total"] > 0]
    n = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        for vid, out in ex.map(work, todo):
            replace_table(con, "video_daily", out["daily"], ["video_id", "day"])
            if out["ret"]:
                if vid in have_ret:
                    con.execute("DELETE FROM video_retention WHERE video_id=?", (vid,))
                replace_table(con, "video_retention", out["ret"], ["video_id", "elapsedVideoTimeRatio"])
            if out["traffic"]:
                try:
                    con.execute("DELETE FROM video_traffic WHERE video_id=?", (vid,))
                except sqlite3.OperationalError:
                    pass
                replace_table(con, "video_traffic", out["traffic"], ["video_id", "insightTrafficSourceType"])
            n += 1
            if n % 25 == 0:
                print(f"  vídeos procesados: {n}/{len(todo)}")
    print(f"  vídeos procesados: {n}/{len(todo)}")


def build_views(con):
    """Vistas SQL de resumen para consultas rápidas y baratas en tokens."""
    con.executescript("""
    DROP VIEW IF EXISTS v_video_summary;
    CREATE VIEW v_video_summary AS
    SELECT v.video_id, v.title, v.published_date, v.duration_s, v.content_type,
           CAST(julianday('now') - julianday(v.published_date) AS INT) AS age_days,
           SUM(d.views) AS views, ROUND(SUM(d.estimatedMinutesWatched)/60.0,1) AS hours,
           SUM(d.subscribersGained) - SUM(d.subscribersLost) AS subs_net,
           ROUND(SUM(d.estimatedRevenue),2) AS revenue,
           ROUND(1000.0*SUM(d.estimatedRevenue)/NULLIF(SUM(d.views),0),2) AS rpm,
           SUM(CASE WHEN d.day < date(v.published_date,'+7 day') THEN d.views END) AS views_d7,
           SUM(CASE WHEN d.day < date(v.published_date,'+28 day') THEN d.views END) AS views_d28,
           SUM(CASE WHEN d.day >= date('now','-28 day') THEN d.views END) AS views_last28,
           SUM(d.likes) AS likes, SUM(d.comments) AS comments, SUM(d.shares) AS shares
    FROM videos v LEFT JOIN video_daily d USING(video_id)
    GROUP BY v.video_id;

    DROP VIEW IF EXISTS v_first_week;
    CREATE VIEW v_first_week AS
    SELECT v.video_id, v.title, v.content_type,
           CAST(julianday(d.day) - julianday(v.published_date) AS INT) AS day_n,
           d.views, d.estimatedMinutesWatched, d.averageViewDuration, d.averageViewPercentage,
           d.subscribersGained - d.subscribersLost AS subs_net, d.estimatedRevenue
    FROM videos v JOIN video_daily d USING(video_id)
    WHERE d.day < date(v.published_date,'+7 day');

    DROP VIEW IF EXISTS v_monthly;
    CREATE VIEW v_monthly AS
    SELECT substr(day,1,7) AS month, SUM(views) views, ROUND(SUM(estimatedMinutesWatched)/60.0) hours,
           SUM(subscribersGained)-SUM(subscribersLost) subs_net, ROUND(SUM(estimatedRevenue),2) revenue,
           ROUND(SUM(estimatedAdRevenue),2) ad_revenue, ROUND(SUM(estimatedRedPartnerRevenue),2) premium_revenue
    FROM channel_daily GROUP BY month;
    """)
    con.commit()


REPORTING_JOBS = {  # informes masivos diarios (Reporting API). Aquí están las impresiones y el CTR.
    "channel_reach_basic_a1": "rep_reach",              # impresiones y CTR de miniatura por vídeo y día
    "channel_reach_combined_a1": "rep_reach_combined",  # ídem desglosado por fuente de tráfico, dispositivo, país
    "channel_end_screens_a1": "rep_end_screens",        # clics en pantallas finales
}


def sync_reporting(con):
    """Crea los trabajos si faltan y descarga los informes diarios nuevos (Google los guarda ~60 días)."""
    import csv
    import io
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseDownload

    rep = build("youtubereporting", "v1", credentials=_creds, cache_discovery=False)
    jobs = {j["reportTypeId"]: j["id"] for j in rep.jobs().list().execute().get("jobs", [])}
    for rtype in REPORTING_JOBS:
        if rtype not in jobs:
            jobs[rtype] = rep.jobs().create(body={"reportTypeId": rtype, "name": rtype}).execute()["id"]
            print(f"  trabajo creado: {rtype} (los primeros informes tardan 24-48 h)")
    con.execute("CREATE TABLE IF NOT EXISTS rep_downloaded (report_id PRIMARY KEY, type, day)")
    done = {r[0] for r in con.execute("SELECT report_id FROM rep_downloaded")}
    for rtype, table in REPORTING_JOBS.items():
        reports, token = [], None
        while True:
            r = rep.jobs().reports().list(jobId=jobs[rtype], pageToken=token).execute()
            reports += r.get("reports", [])
            token = r.get("nextPageToken")
            if not token:
                break
        new = [x for x in reports if x["id"] not in done]
        for x in sorted(new, key=lambda x: x["startTime"]):
            buf = io.BytesIO()
            req = rep.media().download_media(resourceName="")
            req.uri = x["downloadUrl"]
            dl = MediaIoBaseDownload(buf, req)
            fin = False
            while not fin:
                _, fin = dl.next_chunk()
            rows = list(csv.DictReader(io.StringIO(buf.getvalue().decode("utf-8"))))
            day = x["startTime"][:10]
            if rows:
                try:  # informes regenerados: reemplazamos ese día
                    con.execute(f"DELETE FROM {table} WHERE date=?", (rows[0].get("date"),))
                except sqlite3.OperationalError:
                    pass
                replace_table(con, table, rows, None)
            con.execute("INSERT OR REPLACE INTO rep_downloaded VALUES (?,?,?)", (x["id"], rtype, day))
            con.commit()
        print(f"  {table}: {len(new)} informes nuevos ({len(reports)} disponibles)")


def cmd_sync(args):
    global _creds
    data, _an, _creds = services()
    con = db()
    t0 = time.time()
    print("1/4 lista de vídeos")
    start, videos = sync_videos(data, con)
    print("2/4 tipo de contenido")
    sync_content_type(con, start, videos)
    print("3/4 estadísticas del canal")
    sync_channel(con, start)
    print("4/4 estadísticas por vídeo")
    per_video_jobs(con, videos, args.full)
    if getattr(args, "reporting", True):
        print("+ informes masivos (impresiones, CTR, pantallas finales)")
        try:
            sync_reporting(con)
        except Exception as e:  # que un fallo aquí no tumbe el resto
            print(f"  ! reporting: {e}")
    build_views(con)
    replace_table(con, "sync_log", [{"ts": dt.datetime.now().isoformat(timespec="seconds"), "full": int(args.full),
                                     "seconds": round(time.time() - t0),
                                     "origin": os.environ.get("TB_ORIGIN", "pc"),
                                     "reporting": int(getattr(args, "reporting", True))}], ["ts"])
    con.close()
    print(f"Listo en {round(time.time() - t0)} s -> {DB}")

# ---------------------------------------------------------------- consultas

def print_rows(cols, rows, max_width=60):
    def fmt(x):
        if isinstance(x, float):
            x = round(x, 2)
        s = "" if x is None else str(x)
        return s if len(s) <= max_width else s[:max_width - 1] + "…"
    print("\t".join(cols))
    for r in rows:
        print("\t".join(fmt(x) for x in r))


def cmd_q(args):
    con = db()
    cur = con.execute(args.sql)
    rows = cur.fetchall()
    print_rows([d[0] for d in cur.description], rows[: args.limit], args.width)
    if len(rows) > args.limit:
        print(f"... {len(rows) - args.limit} filas más")


def cmd_api(args):
    global _creds
    _d, _a, _creds = services()
    rows = report(args.start, args.end or TODAY, args.metrics, args.dimensions, args.filters, args.sort, args.max)
    if rows:
        print_rows(list(rows[0]), [list(r.values()) for r in rows])
    else:
        print("(sin filas)")


def cmd_import_studio(args):
    """Importa la 'Datos de la tabla.csv' de una exportación de Studio (zip o csv) a la tabla studio_<nombre>."""
    import csv
    import io
    import zipfile

    p = Path(args.path)
    if p.suffix.lower() in (".zip", ".tmp"):
        z = zipfile.ZipFile(p)
        name = next(n for n in z.namelist() if n.startswith("Datos de la tabla"))
        text = z.read(name).decode("utf-8-sig")
    else:
        text = p.read_text(encoding="utf-8-sig")
    rows = [r for r in csv.DictReader(io.StringIO(text)) if r.get(next(iter(r))) != "Total"]
    con = db()
    table = f"studio_{args.name}"
    con.execute(f"DROP TABLE IF EXISTS {table}")
    replace_table(con, table, [{**r, "_imported": str(TODAY)} for r in rows])
    print(f"{table}: {len(rows)} filas")


def main():
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest="cmd", required=True)
    sp.add_parser("auth").set_defaults(f=cmd_auth)
    s = sp.add_parser("sync"); s.add_argument("--full", action="store_true")
    s.add_argument("--no-reporting", dest="reporting", action="store_false",
                   help="sin la Reporting API (CTR, pantallas finales): en la nube solo va en la ejecución diaria")
    s.set_defaults(f=cmd_sync)
    q = sp.add_parser("q"); q.add_argument("sql"); q.add_argument("--limit", type=int, default=60)
    q.add_argument("--width", type=int, default=60); q.set_defaults(f=cmd_q)
    a = sp.add_parser("api")
    a.add_argument("--metrics", required=True); a.add_argument("--dimensions"); a.add_argument("--filters")
    a.add_argument("--sort"); a.add_argument("--max", type=int); a.add_argument("--start", default="2024-04-01")
    a.add_argument("--end"); a.set_defaults(f=cmd_api)
    i = sp.add_parser("import-studio"); i.add_argument("path"); i.add_argument("name"); i.set_defaults(f=cmd_import_studio)
    args = p.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args.f(args)


if __name__ == "__main__":
    main()
