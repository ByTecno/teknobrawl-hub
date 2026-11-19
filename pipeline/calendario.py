"""Calendario de producción del canal (fase 4 del Hub).

Cada hora (pipeline/run.py hourly, después de la instantánea):
  1. Lee los planes personales de Google Calendar (solo lectura) de los próximos días.
  2. Genera el calendario de producción con la configuración de pipeline/temporada.json: cada vídeo largo
     tiene sus fases (guion, gameplays, voz, edición, miniatura, subida) con día y hora asignados, sin caer
     encima de los planes personales, dentro del horario del creador y con un día libre el fin de semana.
  3. Escribe en KV calendar/plan.json (lo lee la pestaña Calendario) y añade/actualiza las tareas
     source="calendario" en tasks/list.json (sin tocar las manuales ni los checks ya marcados).
  4. Sincroniza el calendario de Google «TeknoBrawl» (lo crea la propia app: permiso calendar.app.created,
     que no deja escribir en ningún otro calendario).

Solo escribe en KV y en Google cuando algo cambia. Los registros de GitHub Actions son públicos: aquí solo
se imprimen recuentos, nunca títulos ni eventos.

Autorizar (una vez, desde el PC, con la cuenta de Google donde están los planes personales):
  .venv/Scripts/python scripts/calendario.py auth      → guarda CAL_REFRESH_TOKEN en .env
  .venv/Scripts/python scripts/calendario.py run       → ejecuta lo mismo que la tarea horaria
  .venv/Scripts/python scripts/calendario.py preview   → genera el plan sin escribir nada (resumen en pantalla)
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("TB_ROOT") or HERE.parent)
ENV = ROOT / ".env"
CLIENT_SECRET_FILE = ROOT / "secrets" / "client_secret.json"
CONFIG = HERE / "temporada.json"
TZ = ZoneInfo("Europe/Madrid")
CAL_NAME = "TeknoBrawl"
CAL_MARK = "tb-hub"           # extendedProperties.private.app de cada evento creado por el Hub
SCOPES = [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",  # ver la lista de calendarios
    "https://www.googleapis.com/auth/calendar.events.readonly",        # leer los eventos (planes personales)
    "https://www.googleapis.com/auth/calendar.app.created",            # crear «TeknoBrawl» y escribir solo en él
]
KEY_PLAN, KEY_TASKS, KEY_STATE = "calendar/plan.json", "tasks/list.json", "calendar/state.json"
SKIP_CAL = ("#holiday@", "#contacts@", "#weeknum@", "addressbook#")
DAYS_ES = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
# Colores de Google Calendar (colorId): 9 arándano, 7 pavo real, 5 plátano, 11 tomate, 2 salvia, 3 uva, 6 mandarina
COLOR = {"balance": "1", "guion": "9", "gameplays": "7", "voz": "3", "montaje": "6", "repaso": "6", "miniatura": "5",
         "subida": "2", "short": "11", "publicar": "10"}


# ---------------------------------------------------------------- credenciales

def load_env() -> dict:
    env = {}
    if ENV.exists():
        for line in ENV.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    for k in ("YT_CLIENT_ID", "YT_CLIENT_SECRET", "CAL_REFRESH_TOKEN"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def cmd_auth() -> None:
    from google_auth_oauthlib.flow import InstalledAppFlow
    sys.path.insert(0, str(HERE))
    import yt

    if not CLIENT_SECRET_FILE.exists():
        sys.exit(f"Falta {CLIENT_SECRET_FILE}")
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET_FILE), SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline",
                                  authorization_prompt_message="Abriendo el navegador para autorizar el calendario...")
    granted = set(creds.granted_scopes or [])
    missing = [s.rsplit("/", 1)[1] for s in SCOPES if granted and s not in granted]
    yt.save_env({"CAL_REFRESH_TOKEN": creds.refresh_token})
    print("Autorizado. Token guardado en .env como CAL_REFRESH_TOKEN"
          + (f" (ojo: faltan permisos: {', '.join(missing)})" if missing else ""))


def service():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    env = load_env()
    if not env.get("CAL_REFRESH_TOKEN"):
        return None
    creds = Credentials(None, refresh_token=env["CAL_REFRESH_TOKEN"], client_id=env["YT_CLIENT_ID"],
                        client_secret=env["YT_CLIENT_SECRET"], token_uri="https://oauth2.googleapis.com/token",
                        scopes=SCOPES)
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


# ---------------------------------------------------------------- utilidades de tiempo

def hm(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def fmt_hm(mins: int) -> str:
    return f"{mins // 60:02d}:{mins % 60:02d}"


def day_label(d: dt.date) -> str:
    return f"{DAYS_ES[d.weekday()]} {d.day} {MONTHS_ES[d.month - 1]}"


def local_dt(d: dt.date, mins: int) -> dt.datetime:
    return dt.datetime.combine(d, dt.time()).replace(tzinfo=TZ) + dt.timedelta(minutes=mins)


def subtract(windows: list[tuple[int, int]], busy: list[tuple[int, int]]) -> list[tuple[int, int]]:
    out = []
    for a, b in windows:
        segs = [(a, b)]
        for x, y in busy:
            nxt = []
            for s, e in segs:
                if y <= s or x >= e:
                    nxt.append((s, e))
                else:
                    if x > s:
                        nxt.append((s, x))
                    if y < e:
                        nxt.append((y, e))
            segs = nxt
        out += [(s, e) for s, e in segs if e - s >= 30]
    return out


# ---------------------------------------------------------------- planes personales

def read_personal(svc, start: dt.date, end: dt.date, own_cal_id: str | None) -> list[dict]:
    """Eventos de los calendarios visibles (sin festivos ni cumpleaños ni el propio «TeknoBrawl»)."""
    cals, token = [], None
    while True:
        r = svc.calendarList().list(pageToken=token, showHidden=False).execute()
        cals += r.get("items", [])
        token = r.get("nextPageToken")
        if not token:
            break
    t_min = local_dt(start, 0).isoformat()
    t_max = local_dt(end + dt.timedelta(days=1), 0).isoformat()
    out = []
    for c in cals:
        cid = c["id"]
        if cid == own_cal_id or c.get("summary") == CAL_NAME or c.get("deleted") or not c.get("selected", False):
            continue
        if any(s in cid for s in SKIP_CAL):
            continue
        token = None
        while True:
            r = svc.events().list(calendarId=cid, timeMin=t_min, timeMax=t_max, singleEvents=True,
                                  orderBy="startTime", maxResults=500, pageToken=token).execute()
            for e in r.get("items", []):
                if e.get("status") == "cancelled" or e.get("eventType") in ("workingLocation", "birthday"):
                    continue
                if any(a.get("self") and a.get("responseStatus") == "declined" for a in e.get("attendees", [])):
                    continue
                s, f = e.get("start", {}), e.get("end", {})
                title = (e.get("summary") or "Ocupado")[:80]
                if "date" in s:  # todo el día (la fecha final es exclusiva)
                    out.append({"all_day": True, "start": s["date"], "end": f.get("date", s["date"]), "title": title})
                elif "dateTime" in s:
                    if e.get("transparency") == "transparent":  # marcado como «Disponible»
                        continue
                    a = dt.datetime.fromisoformat(s["dateTime"]).astimezone(TZ)
                    b = dt.datetime.fromisoformat(f["dateTime"]).astimezone(TZ)
                    out.append({"all_day": False, "start": a.isoformat(timespec="minutes"),
                                "end": b.isoformat(timespec="minutes"), "title": title})
            token = r.get("nextPageToken")
            if not token:
                break
    out.sort(key=lambda x: x["start"])
    return out


def busy_by_day(personal: list[dict]) -> tuple[dict, set]:
    """{fecha: [(ini, fin) en minutos]} y el conjunto de días ocupados enteros."""
    busy, full = {}, set()
    for p in personal:
        if p["all_day"]:
            d, e = dt.date.fromisoformat(p["start"]), dt.date.fromisoformat(p["end"])
            e = max(e, d + dt.timedelta(days=1))
            while d < e:
                full.add(d)
                d += dt.timedelta(days=1)
            continue
        a, b = dt.datetime.fromisoformat(p["start"]), dt.datetime.fromisoformat(p["end"])
        d = a.date()
        while d <= b.date():
            s = (a.hour * 60 + a.minute) if d == a.date() else 0
            f = (b.hour * 60 + b.minute) if d == b.date() else 24 * 60
            if f > s:
                busy.setdefault(d, []).append((s, f))
            d += dt.timedelta(days=1)
    return busy, full


# ---------------------------------------------------------------- generación del plan

def season_for(cfg, d: dt.date):
    """Temporada a la que pertenece una fecha de publicación: cuenta desde `dias_tras_inicio_temporada`
    días después de su inicio (por defecto 1: el «Mejores para maxear» sale al día siguiente)."""
    cur, lag = None, cfg.get("dias_tras_inicio_temporada", 1)
    for s in cfg["temporadas"]:
        if dt.date.fromisoformat(s["inicio"]) + dt.timedelta(days=lag) <= d:
            cur = s
    return cur


def build_videos(cfg, first: dt.date, last: dt.date) -> list[dict]:
    pub = cfg["publicacion"]
    long_days, short_days = set(pub["largos"]["dias"]), set(pub["shorts"]["dias"])
    ideas = list(cfg["ideas_largos"])
    short_ideas = list(cfg["ideas_shorts"])
    rot_index: dict[str, int] = {}
    special = {e["fecha"]: e for e in cfg.get("especiales", [])}
    videos, last_long = [], None
    d = first
    while d <= last:
        if d.weekday() in long_days or d.isoformat() in special:
            season = season_for(cfg, d) or {"nombre": "", "inicio": first.isoformat()}
            if d.isoformat() in special:  # vídeo puntual en lugar del de la rotación
                entry = special[d.isoformat()]
            else:
                i = rot_index.get(season["nombre"], 0)
                rot_index[season["nombre"]] = i + 1
                entry = cfg["rotacion"][i % len(cfg["rotacion"])]
                if entry.get("idea") and ideas:
                    entry = ideas.pop(0)
                elif entry.get("idea"):
                    entry = cfg["rotacion"][1]
            tema = f" ({season['tema']})" if season.get("tema") else ""
            v = {"id": f"L{d.isoformat()}", "kind": "largo", "publish": d.isoformat(), "time": pub["largos"]["hora"],
                 "title": entry["titulo"].replace("{temporada}", (season["nombre"] + tema).upper() if "MAXEAR" in entry["titulo"] else season["nombre"]),
                 "format": entry.get("formato", ""), "season": season["nombre"],
                 "season_start": season["inicio"], "phases": entry.get("fases"),
                 "days_before": entry.get("dias_antes_max"), "short_hint": entry.get("short")}
            if entry.get("hora"):
                v["time"] = entry["hora"]
            videos.append(v)
            if not entry.get("sin_short"):  # el short derivado sale del último largo que lo admita
                last_long = v
        if d.weekday() in short_days:
            derived = d.weekday() == pub["shorts"].get("derivado_dia") and last_long and last_long["publish"] < d.isoformat()
            if derived:
                title = last_long.get("short_hint") or f"Del vídeo «{last_long['title']}»"
                videos.append({"id": f"S{d.isoformat()}", "kind": "short", "sub": "derivado", "publish": d.isoformat(),
                               "time": pub["shorts"]["hora"], "title": title, "format": "Short", "from": last_long["id"]})
            else:
                title = short_ideas.pop(0) if short_ideas else "Curiosidad con gancho (elige tema)"
                videos.append({"id": f"S{d.isoformat()}", "kind": "short", "sub": "curiosidad", "publish": d.isoformat(),
                               "time": pub["shorts"]["hora"], "title": title, "format": "Short"})
        d += dt.timedelta(days=1)
    return videos


def build_tasks(cfg, videos) -> list[dict]:
    tasks = []
    by_id = {v["id"]: v for v in videos}
    for v in videos:
        P = dt.date.fromisoformat(v["publish"])
        if v["kind"] == "largo":
            for i, f in enumerate(v.get("phases") or cfg["fases_largo"]):
                earliest = P - dt.timedelta(days=v.get("days_before") or f.get("dias_antes_max", 10))
                if f.get("desde_inicio_temporada") is not None and v.get("season_start"):
                    # p. ej. revisar los cambios de balance: no antes de que salgan (unos 2 días antes de la temporada)
                    earliest = max(earliest, dt.date.fromisoformat(v["season_start"])
                                   + dt.timedelta(days=f["desde_inicio_temporada"]))
                tasks.append({"id": f"cal-{v['id']}-{f['fase']}", "video": v["id"], "phase": f["fase"], "order": i,
                              "label": f["titulo"], "mins": round(f["horas"] * 60), "earliest": earliest,
                              "deadline": P, "after": [f"cal-{v['id']}-{x}" for x in f["tras"]]})
        else:
            f = cfg["fases_short"][v["sub"]]
            after, earliest = [], P - dt.timedelta(days=f.get("dias_antes_max", 6))
            if v["sub"] == "derivado":
                after = [f"cal-{v['from']}-{f['tras_fase']}"]
                earliest = dt.date.fromisoformat(by_id[v["from"]]["publish"]) - dt.timedelta(days=7)
            tasks.append({"id": f"cal-{v['id']}-short", "video": v["id"], "phase": "short", "order": 0,
                          "label": f["titulo"], "mins": round(f["horas"] * 60), "earliest": earliest,
                          "deadline": P, "after": after})
    return tasks


def schedule(cfg, videos, tasks, personal, done: dict, today: dt.date, last: dt.date):
    """Reparte las tareas día a día (la que vence antes, primero). Las tareas ya hechas se quedan en su día."""
    h = cfg["horario"]
    busy, full = busy_by_day(personal)
    placed: dict[str, dict] = {}
    # las hechas ocupan su sitio y no se mueven
    for t in tasks:
        if t["id"] in done:
            placed[t["id"]] = {"day": done[t["id"]], "start": None, "end": None, "done": True}

    # día libre del fin de semana: el que tenga más planes (si empatan, el domingo)
    def busy_minutes(d):
        return 24 * 60 if d in full else sum(b - a for a, b in busy.get(d, []))
    free_days = set()
    d = today - dt.timedelta(days=today.weekday())
    while d <= last:
        sat, sun = d + dt.timedelta(days=5), d + dt.timedelta(days=6)
        mode = h.get("dia_libre", "auto")
        free_days.add(sat if mode == "sabado" else sun if mode == "domingo" else
                      (sat if busy_minutes(sat) > busy_minutes(sun) else sun))
        d += dt.timedelta(days=7)

    pending = [t for t in tasks if t["id"] not in placed]
    pub_order = {v["id"]: v["publish"] for v in videos}
    d = today
    while d <= last and pending:
        weekend = d.weekday() >= 5
        if d in full or d in free_days:
            d += dt.timedelta(days=1)
            continue
        wins = [(hm(a), hm(b)) for a, b in (h["fin_de_semana"] if weekend else h["entre_semana"])]
        wins = subtract(wins, busy.get(d, []))
        cap = h["max_horas"]["fin_de_semana" if weekend else "entre_semana"] * 60
        cap -= sum(t["mins"] for t in tasks if placed.get(t["id"], {}).get("day") == d and placed[t["id"]].get("done"))
        cursor = [w[0] for w in wins]
        used = 0
        progress = True
        while progress:
            progress = False
            ready = [t for t in pending if t["earliest"] <= d and
                     all(a in placed and (placed[a]["day"] < d or (placed[a]["day"] == d and placed[a]["start"] is not None))
                         for a in t["after"])]
            ready.sort(key=lambda t: (t["deadline"], pub_order[t["video"]], t["order"]))
            for t in ready:
                if used + t["mins"] > cap:
                    continue
                # empieza después de que acaben sus dependencias de hoy
                min_start = max([placed[a]["end"] for a in t["after"] if placed[a]["day"] == d and placed[a]["end"]] or [0])
                for i, (a, b) in enumerate(wins):
                    s = max(cursor[i], min_start)
                    if s + t["mins"] <= b:
                        placed[t["id"]] = {"day": d, "start": s, "end": s + t["mins"], "done": False}
                        cursor[i] = s + t["mins"]
                        used += t["mins"]
                        pending.remove(t)
                        progress = True
                        break
                if progress:
                    break
        d += dt.timedelta(days=1)
    return placed, free_days, pending


def make_plan(cfg, personal, done, today: dt.date) -> dict:
    first = max(dt.date.fromisoformat(cfg["primer_video"]), today)
    last = today + dt.timedelta(days=cfg.get("horizonte_dias", 42))
    # vídeos con publicación desde primer_video (incluidos los ya pasados cuyas tareas sigan abiertas)
    start_videos = dt.date.fromisoformat(cfg["primer_video"])
    videos = build_videos(cfg, start_videos, last + dt.timedelta(days=7))
    videos = [v for v in videos if dt.date.fromisoformat(v["publish"]) >= today - dt.timedelta(days=7)]
    tasks = build_tasks(cfg, videos)
    sched_start = today
    placed, free_days, unplaced = schedule(cfg, videos, tasks, personal, done, sched_start, last + dt.timedelta(days=7))
    vids = {v["id"]: v for v in videos}
    items = []
    for t in tasks:
        p = placed.get(t["id"])
        if not p:
            continue
        v = vids[t["video"]]
        late = p["day"] >= dt.date.fromisoformat(v["publish"])
        items.append({"id": t["id"], "type": "task", "phase": t["phase"], "video": v["id"], "label": t["label"],
                      "title": f"{t['label']} · {v['title']}" if v["kind"] == "largo" else f"{t['label']}: {v['title']}",
                      "day": p["day"].isoformat(), "start": fmt_hm(p["start"]) if p["start"] is not None else None,
                      "end": fmt_hm(p["end"]) if p["end"] is not None else None, "mins": t["mins"],
                      "done": p["done"], **({"late": True} if late and not p["done"] else {})})
    for v in videos:
        items.append({"id": f"pub-{v['id']}", "type": "publish", "phase": "publicar", "video": v["id"],
                      "label": "Sale" if v["kind"] == "largo" else "Sale el short",
                      "title": v["title"], "day": v["publish"], "start": v["time"],
                      "end": fmt_hm(hm(v["time"]) + 15), "kind": v["kind"]})
    items.sort(key=lambda i: (i["day"], i["start"] or "", i["id"]))
    shown_until = today + dt.timedelta(days=cfg.get("horizonte_dias", 42))
    return {
        "today": today.isoformat(), "until": shown_until.isoformat(), "first_video": cfg["primer_video"],
        "tz": "Europe/Madrid", "aviso": cfg.get("aviso"), "editor": cfg.get("editor", False),
        "publish_days": cfg["publicacion"], "free_days": sorted(d.isoformat() for d in free_days),
        "videos": [{k: v[k] for k in ("id", "kind", "publish", "time", "title", "format") if k in v} for v in videos],
        "items": [i for i in items if i["day"] <= shown_until.isoformat()],
        "unplaced": [t["id"] for t in unplaced],
        "personal": personal,
    }


# ---------------------------------------------------------------- tareas de Hoy (tasks/list.json)

def merge_tasks(doc: dict | None, plan: dict, today: dt.date) -> tuple[dict, bool]:
    doc = doc or {"updated_at": "", "tasks": []}
    old = doc.get("tasks", [])
    old_by_id = {t["id"]: t for t in old}
    keep = [t for t in old if t.get("source") != "calendario"]
    new_cal = []
    gen_ids = set()
    for i in plan["items"]:
        if i["type"] != "task":
            continue
        gen_ids.add(i["id"])
        prev = old_by_id.get(i["id"], {})
        detail = (f"{i['start']}–{i['end']}" if i["start"] else "") + \
                 (" · Va con retraso respecto a la publicación" if i.get("late") else "")
        t = {"id": i["id"], "title": i["title"][:300], "day": i["day"] if not prev.get("done") else prev["day"],
             "done": bool(prev.get("done")), "source": "calendario"}
        if prev.get("done_at"):
            t["done_at"] = prev["done_at"]
        if detail:
            t["detail"] = detail
        new_cal.append(t)
    # tareas del calendario que ya no existen en el plan: se conservan solo si están hechas (historial)
    for t in old:
        if t.get("source") == "calendario" and t["id"] not in gen_ids and t.get("done"):
            new_cal.append(t)
    tasks = keep + new_cal
    sig = lambda ts: json.dumps(sorted(ts, key=lambda t: t["id"]), ensure_ascii=False, sort_keys=True)
    changed = sig(tasks) != sig(old)
    if changed:
        doc = {"updated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
               "tasks": tasks}
    return doc, changed


def done_from_tasks(doc: dict | None) -> dict:
    out = {}
    for t in (doc or {}).get("tasks", []):
        if t.get("source") == "calendario" and t.get("done"):
            out[t["id"]] = dt.date.fromisoformat(t["day"])
    return out


# ---------------------------------------------------------------- calendario de Google «TeknoBrawl»

def ensure_calendar(svc, state: dict) -> str:
    cid = state.get("calendar_id")
    if cid:
        try:
            svc.calendars().get(calendarId=cid).execute()
            return cid
        except Exception:  # noqa: BLE001  (borrado a mano: se vuelve a crear)
            pass
    cal = svc.calendars().insert(body={"summary": CAL_NAME, "timeZone": "Europe/Madrid",
                                       "description": "Calendario de producción del canal (lo genera el Hub de TeknoBrawl)."}).execute()
    try:
        svc.calendarList().patch(calendarId=cal["id"], body={"colorId": "11"}).execute()
    except Exception:  # noqa: BLE001  (el permiso puede no cubrir el color: no importa)
        pass
    state["calendar_id"] = cal["id"]
    state["created_at"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    return cal["id"]


def desired_events(plan: dict, aviso: str | None) -> dict:
    """{tb_id: cuerpo del evento} para las tareas sin hacer y las publicaciones de hoy en adelante."""
    out = {}
    first_of_day = {}
    for i in plan["items"]:
        if i["type"] == "task" and i["start"] and not i["done"] and i["day"] >= plan["today"]:
            first_of_day.setdefault(i["day"], i["id"])
    day_lists = {}
    for i in plan["items"]:
        if i["type"] == "task" and not i["done"]:
            day_lists.setdefault(i["day"], []).append(i)
    for i in plan["items"]:
        if i["day"] < plan["today"] or (i["type"] == "task" and (i["done"] or not i["start"])):
            continue
        d = dt.date.fromisoformat(i["day"])
        start, end = local_dt(d, hm(i["start"])), local_dt(d, hm(i["end"]))
        if i["type"] == "publish":
            summary = ("▶ " if i["kind"] == "largo" else "▶ Short: ") + i["title"]
            desc = "Publicación programada."
        else:
            summary = i["title"]
            desc = "Tarea del calendario de producción (Hub de TeknoBrawl). Márcala como hecha en la pestaña Hoy."
            if i.get("late"):
                desc += "\n\nVa con retraso respecto a la publicación."
        reminders = {"useDefault": False, "overrides": []}
        if aviso and first_of_day.get(i["day"]) == i["id"]:
            mins = int((start - local_dt(d, hm(aviso))).total_seconds() // 60)
            if mins <= 0:  # la tarea empieza antes del aviso (fin de semana): aviso a esa hora del día anterior
                mins += 24 * 60
            reminders["overrides"] = [{"method": "popup", "minutes": mins}]
            lines = [f"{x['start']}–{x['end']}  {x['title']}" for x in day_lists.get(i["day"], []) if x["start"]]
            desc = "Hoy toca:\n" + "\n".join(lines) + "\n\n" + desc
        out[i["id"]] = {
            "summary": summary[:250], "description": desc,
            "start": {"dateTime": start.isoformat(), "timeZone": "Europe/Madrid"},
            "end": {"dateTime": end.isoformat(), "timeZone": "Europe/Madrid"},
            "colorId": COLOR.get(i["phase"], "8"), "reminders": reminders, "transparency": "opaque",
            "extendedProperties": {"private": {"app": CAL_MARK, "tb_id": i["id"]}},
        }
    return out


def _same(cur: dict, body: dict) -> bool:
    def t(x):
        return dt.datetime.fromisoformat(x["dateTime"]).astimezone(dt.timezone.utc) if x and x.get("dateTime") else None
    rem = cur.get("reminders", {})
    return (cur.get("summary") == body["summary"] and cur.get("description", "") == body["description"]
            and t(cur.get("start")) == t(body["start"]) and t(cur.get("end")) == t(body["end"])
            and cur.get("colorId") == body["colorId"]
            and bool(rem.get("useDefault")) == body["reminders"]["useDefault"]
            and sorted((o["method"], o["minutes"]) for o in rem.get("overrides", []))
            == sorted((o["method"], o["minutes"]) for o in body["reminders"]["overrides"]))


def sync_google(svc, cid: str, plan: dict) -> dict:
    want = desired_events(plan, plan.get("aviso"))
    time_min = local_dt(dt.date.fromisoformat(plan["today"]), 0).isoformat()
    have, token = {}, None
    while True:
        r = svc.events().list(calendarId=cid, timeMin=time_min, privateExtendedProperty=f"app={CAL_MARK}",
                              singleEvents=True, maxResults=2500, pageToken=token, showDeleted=False).execute()
        for e in r.get("items", []):
            tid = e.get("extendedProperties", {}).get("private", {}).get("tb_id")
            if tid in have:  # duplicado: se borra
                svc.events().delete(calendarId=cid, eventId=e["id"]).execute()
            elif tid:
                have[tid] = e
        token = r.get("nextPageToken")
        if not token:
            break
    n = {"insert": 0, "update": 0, "delete": 0}
    for tid, body in want.items():
        cur = have.pop(tid, None)
        if cur is None:
            svc.events().insert(calendarId=cid, body=body).execute()
            n["insert"] += 1
        elif not _same(cur, body):
            svc.events().update(calendarId=cid, eventId=cur["id"], body=body).execute()
            n["update"] += 1
    for e in have.values():  # sobra (tarea hecha, movida a otro plan o retirada)
        svc.events().delete(calendarId=cid, eventId=e["id"]).execute()
        n["delete"] += 1
    return n


# ---------------------------------------------------------------- tarea horaria

def run(write: bool = True) -> dict:
    sys.path.insert(0, str(HERE))
    import kv

    info = {"ok": False}
    svc = service()
    if svc is None:
        info.update(ok=True, skipped="sin CAL_REFRESH_TOKEN (falta autorizar el calendario)")
        print("  calendario: sin autorizar, se omite")
        return info
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    today = dt.datetime.now(TZ).date()
    state = kv.get_json(KEY_STATE, {}) or {}
    tasks_doc = kv.get_json(KEY_TASKS)
    personal_from = today
    personal_to = today + dt.timedelta(days=cfg.get("horizonte_dias", 42) + 7)
    personal = read_personal(svc, personal_from, personal_to, state.get("calendar_id"))
    plan = make_plan(cfg, personal, done_from_tasks(tasks_doc), today)

    info.update(personal_events=len(personal), tasks=sum(1 for i in plan["items"] if i["type"] == "task"),
                unplaced=len(plan["unplaced"]), late=sum(1 for i in plan["items"] if i.get("late")))
    if not write:
        info["ok"] = True
        info["plan"] = plan
        return info

    cid_before = state.get("calendar_id")
    cid = ensure_calendar(svc, state)
    if cid != cid_before:
        kv.put_json(KEY_STATE, state)
    info["google"] = sync_google(svc, cid, plan)

    body = {k: v for k, v in plan.items()}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
    prev = kv.get_json(KEY_PLAN, {}) or {}
    writes = 0
    if prev.get("digest") != digest:
        plan_doc = {**body, "digest": digest,
                    "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")}
        kv.put_json(KEY_PLAN, plan_doc)
        writes += 1
    new_doc, changed = merge_tasks(tasks_doc, plan, today)
    if changed:
        kv.put_json(KEY_TASKS, new_doc)
        writes += 1
    info.update(ok=True, kv_writes=writes)
    print(f"  calendario: {len(personal)} planes personales, {info['tasks']} tareas, "
          f"{info['late']} con retraso, {info['unplaced']} sin hueco; Google {info['google']}; KV {writes} escrituras")
    return info


def cmd_preview():
    info = run(write=False)
    plan = info.get("plan")
    if not plan:
        print(info)
        return
    print(f"Planes personales: {info['personal_events']} · días libres: {', '.join(plan['free_days'][:8])}")
    cur = None
    for i in plan["items"]:
        if i["day"] != cur:
            cur = i["day"]
            print(f"\n{day_label(dt.date.fromisoformat(cur))}")
        mark = "✓" if i.get("done") else ("!" if i.get("late") else "·")
        t = f"{i['start']}–{i['end']}" if i.get("start") else "     ?     "
        print(f"  {mark} {t}  {i['title'] if i['type'] == 'task' else '▶ ' + i['title']}")
    if plan["unplaced"]:
        print(f"\nSin hueco: {len(plan['unplaced'])} tareas")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "auth":
        cmd_auth()
    elif cmd == "run":
        print(json.dumps({k: v for k, v in run().items() if k != "plan"}, ensure_ascii=False))
    elif cmd == "preview":
        cmd_preview()
    else:
        sys.exit(__doc__)
