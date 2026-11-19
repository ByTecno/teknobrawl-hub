"""Instantánea horaria con la Data API: contadores públicos del canal y de los últimos vídeos.

Guarda en KV `snapshots/hourly.json` (una escritura por ejecución):
  {"updated_at": "...Z",
   "channel": [[ts, suscriptores, visualizaciones, vídeos], ...],
   "videos": {id: {"title", "published", "duration_s", "points": [[ts, visualizaciones, me gusta, comentarios], ...]}}}

Se conservan KEEP_DAYS días de puntos; el historial completo pasa a la base de datos (tablas
snapshot_channel y snapshot_video) en cada sync de 6 h (run.py). Cuesta 3 unidades de cuota por hora.
"""
from __future__ import annotations

import datetime as dt

import kv
import yt

KEY = "snapshots/hourly.json"
LATEST = 10        # últimos vídeos subidos que se siguen siempre
RECENT_DAYS = 14   # y además cualquiera publicado en estos días
KEEP_DAYS = 14     # puntos que se conservan en KV


def take():
    data, _an, _creds = yt.services()
    ch = data.channels().list(part="statistics,contentDetails", mine=True).execute()["items"][0]
    uploads = ch["contentDetails"]["relatedPlaylists"]["uploads"]
    items = data.playlistItems().list(part="contentDetails", playlistId=uploads, maxResults=50).execute()["items"]
    now = dt.datetime.now(dt.timezone.utc)
    cutoff = (now - dt.timedelta(days=RECENT_DAYS)).isoformat()
    ids = [it["contentDetails"]["videoId"] for n, it in enumerate(items)
           if n < LATEST or it["contentDetails"].get("videoPublishedAt", "") >= cutoff]
    vids = data.videos().list(part="snippet,statistics,contentDetails", id=",".join(ids)).execute()["items"]
    st = ch["statistics"]
    return now, (int(st.get("subscriberCount", 0)), int(st.get("viewCount", 0)), int(st.get("videoCount", 0))), vids


def main():
    now, chan, vids = take()
    ts = now.strftime("%Y-%m-%dT%H:%MZ")
    keep = (now - dt.timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%dT%H:%MZ")
    snap = kv.get_json(KEY) or {"channel": [], "videos": {}}

    snap["channel"] = [p for p in snap["channel"] if p[0] >= keep and p[0] != ts] + [[ts, *chan]]
    for v in vids:
        s, stt = v["snippet"], v.get("statistics", {})
        e = snap["videos"].setdefault(v["id"], {"points": []})
        e.update(title=s["title"], published=s["publishedAt"], duration_s=yt.iso_dur(v["contentDetails"]["duration"]))
        e["points"] = [p for p in e["points"] if p[0] != ts] + [
            [ts, int(stt.get("viewCount", 0)), int(stt.get("likeCount", 0)), int(stt.get("commentCount", 0))]]
    for vid in list(snap["videos"]):
        pts = [p for p in snap["videos"][vid]["points"] if p[0] >= keep]
        if pts:
            snap["videos"][vid]["points"] = pts
        else:
            del snap["videos"][vid]
    snap["updated_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    kv.put_json(KEY, snap)
    print(f"  instantánea {ts}: {len(vids)} vídeos seguidos, {len(snap['channel'])} puntos de canal en KV")


def merge_into_db(con):
    """Copia los puntos de la instantánea a la base de datos (historial completo). Devuelve filas nuevas."""
    snap = kv.get_json(KEY)
    if not snap:
        return 0
    con.execute("CREATE TABLE IF NOT EXISTS snapshot_channel (ts PRIMARY KEY, subscribers, views, videos)")
    con.execute("CREATE TABLE IF NOT EXISTS snapshot_video (video_id, ts, views, likes, comments, PRIMARY KEY (video_id, ts))")
    before = con.total_changes
    con.executemany("INSERT OR IGNORE INTO snapshot_channel VALUES (?,?,?,?)", snap["channel"])
    con.executemany("INSERT OR IGNORE INTO snapshot_video VALUES (?,?,?,?,?)",
                    [(vid, *p) for vid, e in snap["videos"].items() for p in e["points"]])
    con.commit()
    return con.total_changes - before


if __name__ == "__main__":
    main()
