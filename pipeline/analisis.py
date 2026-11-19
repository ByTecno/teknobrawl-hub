"""TeknoBrawl: análisis del canal a partir de data/teknobrawl.db (lo rellena yt.py sync).

Versión única para GitHub Actions y el PC (scripts/analisis.py de la carpeta del proyecto llama a este archivo).

Uso: .venv/Scripts/python scripts/analisis.py [todo|semana] [--quiet]
  todo    (por defecto) todos los análisis + semana.json
  semana  solo semana.json (últimos 7 días frente a los 7 anteriores)
  --quiet sin el resumen de consola (los registros de GitHub Actions son públicos)
Escribe TB_ROOT/data/analisis/<nombre>.json con {rows, meta} (meta incluye este código).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import statistics as st
import sys
import unicodedata
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(os.environ.get("TB_ROOT") or Path(__file__).resolve().parent.parent)
DB = ROOT / "data" / "teknobrawl.db"
OUT = ROOT / "data" / "analisis"
CODE = Path(__file__).read_text(encoding="utf-8")
LONG, SHORT, LIVE = "videoOnDemand", "shorts", "liveStream"

# ------------------------------------------------------------------ formatos

FORMATS = [  # el orden importa: gana la primera regla que encaja
    ("Mejores para maxear", r"^(?!.*TIPS).*MAXEAR"),
    ("Noticias y balance", r"BALANCE|BRAWL TALK|NOTICIAS|ACTUALIZACI|FILTRAD|NOVEDADES|NUEVO BRAWLER|NUEVA TEMPORADA|SQUAD|BRAWLER SECRETO"),
    ("Opinión y vlogs", r"ARRUINARON|PROBLEMA|DECADENCIA|YA NO ES|INUTILES|NECESARIOS|NECESITA\b|BUGS|OLVIDADAS|^HOLA|SORTEO|SUSCRIPTORES|SUBS EN|SETUP|ABRIENDO|ABRO |GASTANDO|ME TOCAN|COMPRO|CAJA MISTERIOSA|RULETA|CADA VEZ QUE|MI CUENTA|MIEMBRO|VETERANOS|SE COPIA"),
    ("Guías de eventos", r"EVENTO|PIZZA|MEGAHUCHA|BRAWL PASS|HUEVOS|SUSHI|CARAMELOS|CAJA ELEGIR"),
    ("Competitivo y mapas", r"COMPETITIVO|MAPA|RANKED|RANGO|MODO|MODIFICADOR|COPAS"),
    ("Guías y consejos", r"TIPS|CONSEJOS|ERRORES|GUIA|COMO |TRUCOS|RECURSOS|GASTAR|CONSEGUIR|PROGRESAR|MAESTRIA|PRO |PROTIPS|PALABRAS|SECRETOS|CLAVES|CODIGO"),
    ("Skins", r"SKIN"),
    ("Tops y tier lists", r"PEOR|MEJOR|TOP|TIER|HIPERCARGA|GADGET|ESTELAR|SUPERS|PODERES|LEGENDARIO|MITICO|DIFICILES|FACILES|ROTOS|FUERTES|POPULARES|TRIOS|REFUERZOS|TITULOS"),
]


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", s.upper())


def fmt_of(title: str, ctype: str) -> str:
    if ctype == SHORT:
        return "Short"
    if ctype == LIVE:
        return "Directo"
    t = norm(title)
    for name, rx in FORMATS:
        if re.search(rx, t):
            return name
    return "Otros"

# ------------------------------------------------------------------ utilidades


def q(con, sql, *a):
    cur = con.execute(sql, a)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def med(xs):
    xs = [x for x in xs if x is not None]
    return st.median(xs) if xs else None


def r2(x, n=2):
    return None if x is None else round(x, n)


def write(name, rows, title, how):
    OUT.mkdir(parents=True, exist_ok=True)
    meta = [{"label": "analisis.py", "value": CODE, "type": "code", "lang": "python"},
            {"label": "Entrada", "value": "data/teknobrawl.db (YouTube Data API + Analytics API + exportación de Studio)"},
            {"label": "Cálculo", "value": how},
            {"label": "Generado", "value": str(date.today())}]
    body = {**rows, "meta": meta} if isinstance(rows, dict) else {"rows": rows, "meta": meta}
    (OUT / f"{name}.json").write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
    print(f"  {name}.json: {len(rows)} {'apartados' if isinstance(rows, dict) else 'filas'}  ({title})")

# ------------------------------------------------------------------ análisis


def completo(con, quiet=False):
    today = date.fromisoformat(q(con, "SELECT MAX(day) d FROM channel_daily")[0]["d"])

    vids ={v["video_id"]: v for v in q(con, "SELECT * FROM videos")}
    for v in vids.values():
        v["format"] = fmt_of(v["title"], v.get("content_type") or "")
    daily = {}
    for r in q(con, "SELECT video_id, day, views, estimatedMinutesWatched m, averageViewPercentage avp, "
                    "subscribersGained-subscribersLost subs, estimatedRevenue rev, likes, comments, shares FROM video_daily"):
        daily.setdefault(r["video_id"], []).append(r)
    ctr = {r["Contenido"]: r for r in q(con, 'SELECT * FROM studio_ctr_lifetime')}
    ret = {}
    for r in q(con, "SELECT video_id, elapsedVideoTimeRatio x, audienceWatchRatio y, relativeRetentionPerformance rel FROM video_retention"):
        ret.setdefault(r["video_id"], []).append(r)

    # --- por vídeo
    rows = []
    for vid, v in vids.items():
        ds = sorted(daily.get(vid, []), key=lambda r: r["day"])
        if not ds or v["published_date"] < "2024-04-01":
            continue
        pub = date.fromisoformat(v["published_date"])
        byn = {}
        for r in ds:
            n = (date.fromisoformat(r["day"]) - pub).days
            byn[n] = r
        age = (today - pub).days
        tot = sum(r["views"] for r in ds)

        def upto(n):
            return sum(r["views"] for k, r in byn.items() if 0 <= k < n) if age >= n else None
        last90 = sum(r["views"] for r in ds if r["day"] > str(today - timedelta(days=90)))
        last28 = sum(r["views"] for r in ds if r["day"] > str(today - timedelta(days=28)))
        # semana de pico (ventana móvil de 7 días)
        series = [byn.get(k, {"views": 0})["views"] for k in range(0, age + 1)]
        best, best_k, run = -1, 0, 0
        for k, x in enumerate(series):
            run += x - (series[k - 7] if k >= 7 else 0)
            if run > best:
                best, best_k = run, max(0, k - 6)
        rev = sum(r["rev"] or 0 for r in ds)
        mins = sum(r["m"] or 0 for r in ds)
        w7 = [byn[k] for k in range(7) if k in byn]
        avp7 = (sum((r["avp"] or 0) * r["views"] for r in w7) / sum(r["views"] for r in w7)) if w7 and sum(r["views"] for r in w7) else None
        rr = sorted(ret.get(vid, []), key=lambda r: r["x"])

        def ret_at(x):
            if not rr:
                return None
            return min(rr, key=lambda r: abs(r["x"] - x))["y"]
        c = ctr.get(vid, {})
        rows.append({
            "video_id": vid, "title": v["title"], "published": v["published_date"], "type": v.get("content_type"),
            "format": v["format"], "duration_min": r2(v["duration_s"] / 60, 1), "age_days": age,
            "views": tot, "d1": upto(1), "d3": upto(3), "d7": upto(7), "d28": upto(28), "d90": upto(90),
            "last28": last28, "last90": last90,
            "share_after_d90": r2(1 - (upto(90) or tot) / tot, 3) if tot and age >= 90 else None,
            "peak_week_start_day": best_k, "peak_week_views": best,
            "hours": r2(mins / 60, 0), "avg_view_min": r2(mins / tot, 2) if tot else None,
            "avp_first_week": r2(avp7, 1),
            "ret_30s": None, "ret_10pct": r2(ret_at(0.1)), "ret_50pct": r2(ret_at(0.5)), "ret_90pct": r2(ret_at(0.9)),
            "rel_retention": r2(med([r["rel"] for r in rr])),
            "subs_net": sum(r["subs"] or 0 for r in ds), "revenue": r2(rev), "rpm": r2(1000 * rev / tot) if tot else None,
            "likes": sum(r["likes"] or 0 for r in ds), "comments": sum(r["comments"] or 0 for r in ds),
            "shares": sum(r["shares"] or 0 for r in ds),
            "impressions": int(c["Impresiones de la miniatura"]) if c.get("Impresiones de la miniatura") else None,
            "ctr": float(c["Porcentaje de clics de las miniaturas (%)"]) if c.get("Porcentaje de clics de las miniaturas (%)") else None,
        })
        if v["duration_s"] and rr:  # retención a los 30 s
            rows[-1]["ret_30s"] = r2(ret_at(min(1.0, 30 / v["duration_s"])))

    # --- comparación con su formato: mediana de d7 de los vídeos del mismo formato publicados en los 180 días previos
    rows.sort(key=lambda r: r["published"])
    for r in rows:
        prev = [p["d7"] for p in rows if p["format"] == r["format"] and p["d7"] is not None
                and r["published"] > p["published"] >= str(date.fromisoformat(r["published"]) - timedelta(days=180))]
        # antes de sep-2024 el canal crecía tan rápido que comparar con los meses previos no dice nada
        r["format_d7_benchmark"] = med(prev) if len(prev) >= 3 and r["published"] >= "2024-09-01" else None
        r["vs_format"] = r2(r["d7"] / r["format_d7_benchmark"]) if r["d7"] is not None and r["format_d7_benchmark"] else None
        r["tail_d90_vs_d7"] = r2(r["d90"] / r["d7"], 2) if r["d90"] and r["d7"] else None
        # clasificación
        tag = []
        if r["type"] == LONG and r["age_days"] >= 180 and r["views"] >= 5000 and \
                ((r["share_after_d90"] or 0) >= 0.3 or r["last90"] >= 500):
            tag.append("Evergreen")
        r["d7_share"] = r2(r["d7"] / r["views"], 3) if r["d7"] and r["views"] else None
        if r["age_days"] >= 60 and r["d7"] and (
                (r["peak_week_start_day"] >= 21 and r["peak_week_views"] >= 1.5 * r["d7"])
                or (r["views"] >= 10000 and r["d7_share"] <= 0.2)):
            tag.append("Despegue tardío")
        if r["vs_format"] is not None and r["vs_format"] < 0.5:
            tag.append("Por debajo de su formato")
        if r["vs_format"] is not None and r["vs_format"] >= 2:
            tag.append("Por encima de su formato")
        r["tags"] = ", ".join(tag)

    long_rows = [r for r in rows if r["type"] == LONG]
    short_rows = [r for r in rows if r["type"] == SHORT]
    write("videos", long_rows, "vídeos largos desde abril 2024",
          "Una fila por vídeo largo. dN = visualizaciones en los N primeros días (día 0 = día de publicación). "
          "format_d7_benchmark = mediana de d7 de los vídeos del mismo formato publicados en los 180 días previos (mín. 3). "
          "vs_format = d7 / benchmark. "
          "Evergreen: ≥180 días, ≥5.000 visualizaciones y (≥30 % de sus visualizaciones después del día 90 o ≥500 en los últimos 90 días). Despegue tardío: su mejor semana empieza el día 21 o después y supera 1,5× la primera semana, o tiene ≥10.000 visualizaciones y la primera semana fue ≤20 % del total. "
          "ret_X = audienceWatchRatio en ese punto del vídeo. ctr e impresiones: de por vida, exportación de Studio.")
    write("shorts", short_rows, "shorts", "Igual que videos.json, para shorts.")

    # --- formatos
    fr = []
    for f in sorted({r["format"] for r in rows}):
        rs = [r for r in rows if r["format"] == f]
        recent = [r for r in rs if r["published"] >= str(today - timedelta(days=365))]
        tv = sum(r["views"] for r in rs)
        fr.append({
            "format": f, "videos": len(rs), "videos_last_year": len(recent), "views": tv,
            "median_views": med([r["views"] for r in rs]), "median_d7": med([r["d7"] for r in rs]),
            "median_d28": med([r["d28"] for r in rs]),
            "median_ctr": r2(med([r["ctr"] for r in rs]), 1), "median_ret_50pct": r2(med([r["ret_50pct"] for r in rs])),
            "median_avg_view_min": r2(med([r["avg_view_min"] for r in rs]), 1),
            "revenue": r2(sum(r["revenue"] or 0 for r in rs), 0), "rpm": r2(1000 * sum(r["revenue"] or 0 for r in rs) / tv) if tv else None,
            "subs_per_1k": r2(1000 * sum(r["subs_net"] for r in rs) / tv, 1) if tv else None,
            "last90": sum(r["last90"] for r in rs),
            "median_duration_min": r2(med([r["duration_min"] for r in rs]), 1),
            "median_tail_d90_vs_d7": r2(med([r["tail_d90_vs_d7"] for r in rs]), 2),
        })
    fr.sort(key=lambda r: -(r["revenue"] or 0))
    write("formats", fr, "formatos", "Agrupado por formato (clasificación por palabras del título; ver FORMATS en el código). "
          "rpm = ingresos por cada 1.000 visualizaciones. subs_per_1k = suscriptores netos por cada 1.000 visualizaciones.")

    # --- curva de la primera semana por formato (mediana del % acumulado de d28 por día)
    fw = []
    for f in sorted({r["format"] for r in rows}):
        rs = [r for r in rows if r["format"] == f and r["d28"]]
        if len(rs) < 4:
            continue
        for n in range(28):
            vals = []
            for r in rs:
                ds = {(date.fromisoformat(x["day"]) - date.fromisoformat(r["published"])).days: x["views"] for x in daily[r["video_id"]]}
                vals.append(sum(v for k, v in ds.items() if 0 <= k <= n) / r["d28"])
            fw.append({"format": f, "day": n, "share_of_d28": r2(med(vals), 3), "videos": len(rs)})
    write("first_week_curve", fw, "curva acumulada", "Para cada formato y día n: mediana de (visualizaciones acumuladas hasta el día n) / (visualizaciones a 28 días).")

    # --- días 0-6 de cada vídeo largo (para la tabla de primera semana)
    fwd = []
    for r in long_rows[-40:]:
        ds = {(date.fromisoformat(x["day"]) - date.fromisoformat(r["published"])).days: x for x in daily[r["video_id"]]}
        for n in range(7):
            x = ds.get(n)
            fwd.append({"video_id": r["video_id"], "day": n, "views": x["views"] if x else 0,
                        "avg_view_pct": r2(x["avp"], 1) if x else None, "subs_net": x["subs"] if x else 0})
    write("first_week_days", fwd, "días 0-6", "Visualizaciones, % medio visto y suscriptores netos por día en la primera semana de los 40 últimos vídeos largos.")

    # --- curva de retención mediana por formato (vídeos largos)
    rc = []
    for f in sorted({r["format"] for r in long_rows}):
        ids = [r["video_id"] for r in long_rows if r["format"] == f and ret.get(r["video_id"])]
        if len(ids) < 4:
            continue
        for i in range(1, 101):
            x = i / 100
            ys = [next((p["y"] for p in ret[v] if abs(p["x"] - x) < 1e-6), None) for v in ids]
            rc.append({"format": f, "x": x, "watch_ratio": r2(med(ys), 3), "videos": len(ids)})
    write("retention_curve", rc, "retención", "Mediana de audienceWatchRatio (proporción de espectadores que sigue viendo) en cada 1 % del vídeo, por formato.")

    # --- canal por mes y tipo
    mt = {}
    for r in q(con, "SELECT substr(day,1,7) m, creatorContentType t, SUM(views) v, SUM(estimatedMinutesWatched) mi, "
                    "SUM(subscribersGained)-SUM(subscribersLost) s FROM channel_daily_by_type WHERE day>='2024-04-01' GROUP BY 1,2"):
        mt.setdefault(r["m"], {})[r["t"]] = r
    rev_t = {}
    for r in q(con, "SELECT substr(d.day,1,7) m, v.content_type t, SUM(d.estimatedRevenue) rev FROM video_daily d "
                    "JOIN videos v USING(video_id) WHERE d.day>='2024-04-01' GROUP BY 1,2"):
        rev_t.setdefault(r["m"], {})[r["t"]] = r["rev"] or 0
    pubs = {}
    for v in vids.values():
        pubs.setdefault(v["published_date"][:7], {}).setdefault(v.get("content_type"), 0)
        pubs[v["published_date"][:7]][v.get("content_type")] += 1
    monthly = []
    for r in q(con, "SELECT * FROM v_monthly WHERE month>='2024-04' ORDER BY month"):
        m = r["month"]
        g = lambda t, k: (mt.get(m, {}).get(t) or {}).get(k) or 0  # noqa: E731
        monthly.append({
            "month": m, "views": r["views"], "views_long": g(LONG, "v"), "views_shorts": g(SHORT, "v"),
            "views_live": g(LIVE, "v"), "hours": r["hours"], "subs_net": r["subs_net"],
            "subs_long": g(LONG, "s"), "subs_shorts": g(SHORT, "s"),
            "revenue": r["revenue"], "revenue_long": r2(rev_t.get(m, {}).get(LONG, 0)),
            "revenue_shorts": r2(rev_t.get(m, {}).get(SHORT, 0)), "ad_revenue": r["ad_revenue"],
            "premium_revenue": r["premium_revenue"],
            "other_revenue": r2((r["revenue"] or 0) - (r["ad_revenue"] or 0) - (r["premium_revenue"] or 0)),
            "published_long": pubs.get(m, {}).get(LONG, 0), "published_shorts": pubs.get(m, {}).get(SHORT, 0),
            "partial": m == str(today)[:7],
        })
    write("monthly", monthly, "mensual", "Totales del canal por mes (channel_daily). Desglose por tipo de channel_daily_by_type; "
          "ingresos por tipo sumando video_daily. other_revenue = total − anuncios − Premium (sobre todo membresías). El mes en curso va marcado como partial.")

    # --- países
    cn = q(con, "SELECT country, views, estimatedMinutesWatched mi, subscribersGained subs, estimatedRevenue rev FROM country ORDER BY views DESC")
    tv, trev = sum(r["views"] for r in cn), sum(r["rev"] or 0 for r in cn)
    by_t = {(r["country"], r["creatorContentType"]): r["views"] for r in q(con, "SELECT * FROM country_by_type")}
    names_c = {"MX": "México", "ES": "España", "AR": "Argentina", "CL": "Chile", "PE": "Perú", "CO": "Colombia", "VE": "Venezuela",
               "BO": "Bolivia", "GT": "Guatemala", "EC": "Ecuador", "US": "Estados Unidos", "UY": "Uruguay", "PY": "Paraguay",
               "HN": "Honduras", "SV": "El Salvador", "CR": "Costa Rica", "DO": "Rep. Dominicana", "NI": "Nicaragua", "PA": "Panamá",
               "PR": "Puerto Rico", "BR": "Brasil", "IT": "Italia", "FR": "Francia", "DE": "Alemania", "GB": "Reino Unido", "CU": "Cuba"}
    countries = [{"country": names_c.get(r["country"], r["country"]), "views": r["views"], "views_share": r2(r["views"] / tv, 4),
                  "rpm_long": r2(1000 * (r["rev"] or 0) / by_t[(r["country"], LONG)]) if by_t.get((r["country"], LONG)) else None,
                  "revenue": r2(r["rev"]), "revenue_share": r2((r["rev"] or 0) / trev, 4),
                  "rpm": r2(1000 * (r["rev"] or 0) / r["views"]) if r["views"] else None,
                  "views_long": by_t.get((r["country"], LONG), 0), "views_shorts": by_t.get((r["country"], SHORT), 0),
                  "hours": r2(r["mi"] / 60, 0)} for r in cn[:20]]
    write("countries", countries, "países", "Desde siempre. rpm = ingresos por 1.000 visualizaciones en ese país.")

    # --- tráfico por tipo de contenido
    names = {"SUBSCRIBER": "Inicio y recomendaciones", "SHORTS": "Feed de Shorts", "YT_SEARCH": "Búsqueda de YouTube",
             "RELATED_VIDEO": "Vídeos sugeridos", "YT_CHANNEL": "Página del canal", "YT_OTHER_PAGE": "Otras páginas de YouTube",
             "NOTIFICATION": "Notificaciones", "EXT_URL": "Webs externas", "END_SCREEN": "Pantallas finales",
             "PLAYLIST": "Listas de reproducción", "NO_LINK_OTHER": "Directo / desconocido", "SHORTS_CONTENT_LINKS": "Enlaces desde Shorts",
             "ANNOTATION": "Tarjetas", "HASHTAGS": "Hashtags", "SOUND_PAGE": "Página de sonido"}
    tr = {}
    for r in q(con, "SELECT * FROM traffic_by_type"):
        k = names.get(r["insightTrafficSourceType"], r["insightTrafficSourceType"])
        d = tr.setdefault(k, {"source": k, "views_long": 0, "views_shorts": 0, "hours_long": 0})
        if r["creatorContentType"] == LONG:
            d["views_long"] += r["views"]
            d["hours_long"] += r["estimatedMinutesWatched"] / 60
        elif r["creatorContentType"] == SHORT:
            d["views_shorts"] += r["views"]
    tl, ts = sum(d["views_long"] for d in tr.values()), sum(d["views_shorts"] for d in tr.values())
    traffic = sorted([{**d, "hours_long": round(d["hours_long"]), "share_long": r2(d["views_long"] / tl, 4),
                       "share_shorts": r2(d["views_shorts"] / ts, 4)} for d in tr.values()], key=lambda d: -d["views_long"])
    write("traffic", traffic, "tráfico", "Fuentes de tráfico desde siempre, separadas en vídeos largos y shorts (traffic_by_type).")

    # --- tráfico reciente (últimos 90 días) para ver qué mantiene vivo el canal
    tr90 = q(con, "SELECT insightTrafficSourceType s, SUM(views) v FROM traffic_daily WHERE day > ? GROUP BY 1 ORDER BY v DESC",
             str(today - timedelta(days=90)))
    t90 = sum(r["v"] for r in tr90)
    write("traffic_90d", [{"source": names.get(r["s"], r["s"]), "views": r["v"], "share": r2(r["v"] / t90, 4)} for r in tr90],
          "tráfico 90 días", "Fuentes de tráfico de los últimos 90 días, todos los formatos.")

    # --- búsquedas
    write("search_terms", [{"term": r["insightTrafficSourceDetail"], "views": r["views"]} for r in
                           q(con, "SELECT * FROM search_terms ORDER BY views DESC")], "búsquedas", "Top 25 búsquedas de YouTube que trajeron visualizaciones, desde siempre.")

    # --- audiencia: demografía, dispositivo, suscritos
    aud = [{"group": "Edad y sexo", "label": f'{r["ageGroup"].replace("age", "")} · {"Hombre" if r["gender"] == "male" else "Mujer" if r["gender"] == "female" else "Otro"}',
            "value": r2(r["viewerPercentage"] / 100, 4)} for r in q(con, "SELECT * FROM demographics ORDER BY viewerPercentage DESC") if r["viewerPercentage"] >= 0.5]
    dv = q(con, "SELECT deviceType, SUM(estimatedMinutesWatched) m FROM device GROUP BY 1 ORDER BY m DESC")
    tm = sum(r["m"] for r in dv)
    aud += [{"group": "Dispositivo (tiempo visto)", "label": {"TV": "Televisión", "MOBILE": "Móvil", "DESKTOP": "Ordenador", "TABLET": "Tablet"}.get(r["deviceType"], r["deviceType"].title()),
             "value": r2(r["m"] / tm, 4)} for r in dv]
    ss = q(con, "SELECT subscribedStatus s, creatorContentType t, views FROM subscribed_status WHERE creatorContentType IN (?,?)", LONG, SHORT)
    for t, lab in ((LONG, "vídeos largos"), (SHORT, "shorts")):
        tot = sum(r["views"] for r in ss if r["t"] == t)
        sub = sum(r["views"] for r in ss if r["t"] == t and r["s"] == "SUBSCRIBED")
        aud.append({"group": "Visualizaciones de suscriptores", "label": lab, "value": r2(sub / tot, 4)})
    write("audience", aud, "audiencia", "Desde siempre. Edad y sexo: % de espectadores con sesión iniciada (YouTube no cuenta menores de 13 ni a quien no da su edad). "
          "Dispositivo: % del tiempo de visualización. Suscriptores: % de visualizaciones hechas por suscriptores.")

    # --- KPIs de cabecera
    ch = q(con, "SELECT * FROM channel")[0]
    last28 = q(con, "SELECT SUM(views) v, SUM(estimatedRevenue) r, SUM(subscribersGained)-SUM(subscribersLost) s, SUM(estimatedMinutesWatched)/60.0 h "
                    "FROM channel_daily WHERE day > ?", str(today - timedelta(days=28)))[0]
    prev28 = q(con, "SELECT SUM(views) v, SUM(estimatedRevenue) r, SUM(subscribersGained)-SUM(subscribersLost) s, SUM(estimatedMinutesWatched)/60.0 h "
                    "FROM channel_daily WHERE day > ? AND day <= ?", str(today - timedelta(days=56)), str(today - timedelta(days=28)))[0]
    life = q(con, "SELECT SUM(views) v, SUM(estimatedRevenue) r, SUM(estimatedMinutesWatched)/60.0 h FROM channel_daily")[0]
    kpi = [{"metric": "Suscriptores", "value": ch["subscribers"], "last28": last28["s"], "prev28": prev28["s"]},
           {"metric": "Visualizaciones", "value": life["v"], "last28": last28["v"], "prev28": prev28["v"]},
           {"metric": "Horas de visualización", "value": round(life["h"]), "last28": round(last28["h"]), "prev28": round(prev28["h"])},
           {"metric": "Ingresos estimados (€)", "value": round(life["r"], 2), "last28": round(last28["r"], 2), "prev28": round(prev28["r"], 2)},
           {"metric": "Vídeos largos", "value": len([v for v in vids.values() if v.get("content_type") == LONG]), "last28": None, "prev28": None},
           {"metric": "Shorts", "value": len([v for v in vids.values() if v.get("content_type") == SHORT]), "last28": None, "prev28": None},
           {"metric": "Directos", "value": len([v for v in vids.values() if v.get("content_type") == LIVE]), "last28": None, "prev28": None}]
    write("kpis", kpi, "cabecera", f"Totales desde siempre, últimos 28 días (hasta {today}) y los 28 anteriores. Suscriptores = cifra actual de la API.")

    if quiet:
        return
    # --- resumen corto para la consola
    print("\nFORMATOS (largos+shorts):")
    for r in fr:
        print(f"  {r['format']:<22} n={r['videos']:>3} ({r['videos_last_year']:>2} último año)  medD7={r['median_d7'] or 0:>7.0f}  "
              f"medVistas={r['median_views'] or 0:>7.0f}  rpm={r['rpm'] or 0:.2f}  subs/1k={r['subs_per_1k']}  ctr={r['median_ctr']}  ret50={r['median_ret_50pct']}  €={r['revenue']}  last90={r['last90']}")
    for tag in ("Evergreen", "Despegue tardío", "Por encima de su formato", "Por debajo de su formato"):
        sel = [r for r in long_rows if tag in r["tags"]]
        key = (lambda r: -r["last90"]) if tag == "Evergreen" else (lambda r: r["published"])
        print(f"\n{tag.upper()} ({len(sel)}):")
        for r in sorted(sel, key=key)[:15]:
            print(f"  {r['published']} d7={r['d7']} vsF={r['vs_format']} last90={r['last90']} peak@{r['peak_week_start_day']} views={r['views']} | {r['title'][:60]}")

# ------------------------------------------------------------------ semana (cada 6 h en la nube)


def has_table(con, name):
    return bool(con.execute("SELECT 1 FROM sqlite_master WHERE name=?", (name,)).fetchone())


def semana(con, quiet=False):
    """Últimos 7 días con datos de Analytics frente a los 7 anteriores."""
    today = date.fromisoformat(q(con, "SELECT MAX(day) d FROM channel_daily")[0]["d"])
    a0, b0 = str(today - timedelta(days=6)), str(today)                         # semana actual
    a1, b1 = str(today - timedelta(days=13)), str(today - timedelta(days=7))    # semana anterior

    def tot(a, b):
        r = q(con, "SELECT SUM(views) views, ROUND(SUM(estimatedMinutesWatched)/60.0) hours, "
                   "SUM(subscribersGained)-SUM(subscribersLost) subs_net, SUM(subscribersGained) subs_gained, "
                   "SUM(subscribersLost) subs_lost, ROUND(SUM(estimatedRevenue),2) revenue, SUM(likes) likes, "
                   "SUM(comments) comments, SUM(shares) shares FROM channel_daily WHERE day BETWEEN ? AND ?", a, b)[0]
        for t, lab in ((LONG, "long"), (SHORT, "shorts")):
            x = q(con, "SELECT SUM(views) v, SUM(subscribersGained)-SUM(subscribersLost) s, "
                       "ROUND(SUM(estimatedMinutesWatched)/60.0) h FROM channel_daily_by_type "
                       "WHERE creatorContentType=? AND day BETWEEN ? AND ?", t, a, b)[0]
            r[f"views_{lab}"], r[f"subs_{lab}"], r[f"hours_{lab}"] = x["v"], x["s"], x["h"]
        return r

    cur, prev = tot(a0, b0), tot(a1, b1)
    kpis = [{"metric": k, "last7": cur[k], "prev7": prev[k],
             "change": r2((cur[k] - prev[k]) / prev[k], 3) if cur[k] is not None and prev[k] else None}
            for k in cur]

    by_type = {}
    for r in q(con, "SELECT day, creatorContentType t, views FROM channel_daily_by_type WHERE day BETWEEN ? AND ?", a1, b0):
        by_type.setdefault(r["day"], {})[r["t"]] = r["views"]
    daily = [{"day": r["day"], "views": r["views"], "views_long": by_type.get(r["day"], {}).get(LONG, 0),
              "views_shorts": by_type.get(r["day"], {}).get(SHORT, 0), "subs_net": r["s"], "revenue": r2(r["rev"])}
             for r in q(con, "SELECT day, views, subscribersGained-subscribersLost s, estimatedRevenue rev "
                             "FROM channel_daily WHERE day BETWEEN ? AND ? ORDER BY day", a1, b0)]

    vids = {v["video_id"]: v for v in q(con, "SELECT video_id, title, published, published_date, content_type, "
                                            "duration_s, views_total, likes_total, comments_total FROM videos")}
    win = {}
    for r in q(con, "SELECT video_id, SUM(CASE WHEN day>=? THEN views END) v0, SUM(CASE WHEN day<? THEN views END) v1, "
                    "ROUND(SUM(CASE WHEN day>=? THEN estimatedRevenue END),2) rev0, "
                    "SUM(CASE WHEN day>=? THEN subscribersGained-subscribersLost END) s0 "
                    "FROM video_daily WHERE day BETWEEN ? AND ? GROUP BY video_id", a0, a0, a0, a0, a1, b0):
        win[r["video_id"]] = r

    def vrow(vid):
        v, w = vids[vid], win.get(vid, {})
        return {"video_id": vid, "title": v["title"], "published": v["published"], "type": v["content_type"],
                "format": fmt_of(v["title"], v["content_type"] or ""), "views_total": v["views_total"],
                "likes_total": v["likes_total"], "comments_total": v["comments_total"],
                "views_7d": w.get("v0") or 0, "views_prev7d": w.get("v1") or 0,
                "revenue_7d": w.get("rev0") or 0, "subs_7d": w.get("s0") or 0}

    # publicados en la ventana o después (Analytics va 1-2 días por detrás de la Data API)
    new = [vrow(vid) for vid, v in vids.items() if v["published_date"] >= a0]
    new.sort(key=lambda r: r["published"], reverse=True)
    top = sorted((vrow(vid) for vid in win if vid in vids), key=lambda r: -r["views_7d"])[:15]

    traffic = []
    names = {"SUBSCRIBER": "Inicio y recomendaciones", "SHORTS": "Feed de Shorts", "YT_SEARCH": "Búsqueda de YouTube",
             "RELATED_VIDEO": "Vídeos sugeridos", "YT_CHANNEL": "Página del canal", "NOTIFICATION": "Notificaciones",
             "EXT_URL": "Webs externas", "END_SCREEN": "Pantallas finales", "PLAYLIST": "Listas de reproducción"}
    for r in q(con, "SELECT insightTrafficSourceType s, SUM(CASE WHEN day>=? THEN views ELSE 0 END) v0, "
                    "SUM(CASE WHEN day<? THEN views ELSE 0 END) v1 FROM traffic_daily WHERE day BETWEEN ? AND ? "
                    "GROUP BY 1 ORDER BY v0 DESC", a0, a0, a1, b0):
        traffic.append({"source": names.get(r["s"], r["s"]), "views_7d": r["v0"], "views_prev7d": r["v1"]})

    # impresiones y CTR (Reporting API; llega con 1-2 días de retraso y solo desde el 18-11-2026)
    reach = None
    if has_table(con, "rep_reach"):
        cols = {c[1] for c in con.execute("PRAGMA table_info(rep_reach)")}
        imp, clk = "video_thumbnail_impressions", "video_thumbnail_impressions_ctr"
        if {imp, clk, "date"} <= cols:
            dn = "substr(date,1,4)||'-'||substr(date,5,2)||'-'||substr(date,7,2)"  # AAAAMMDD → AAAA-MM-DD
            rr = q(con, f"SELECT {dn} day, SUM(CAST({imp} AS REAL)) imp, SUM(CAST({imp} AS REAL)*CAST({clk} AS REAL)) clicks "
                        f"FROM rep_reach GROUP BY 1 ORDER BY 1 DESC LIMIT 14")
            reach = [{"day": r["day"], "impressions": int(r["imp"] or 0),
                      "ctr": r2(r["clicks"] / r["imp"], 4) if r["imp"] else None} for r in rr]

    # últimos 90 días, día a día (pestaña Mes del Hub: últimos 28 días frente a los 28 anteriores)
    a90 = str(today - timedelta(days=89))
    t90 = {}
    for r in q(con, "SELECT day, creatorContentType t, views v, estimatedMinutesWatched mi, "
                    "subscribersGained-subscribersLost s FROM channel_daily_by_type WHERE day BETWEEN ? AND ?", a90, b0):
        t90.setdefault(r["day"], {})[r["t"]] = r
    r90 = {}
    for r in q(con, "SELECT d.day, v.content_type t, SUM(d.estimatedRevenue) rev FROM video_daily d JOIN videos v USING(video_id) "
                    "WHERE d.day BETWEEN ? AND ? GROUP BY 1,2", a90, b0):
        r90.setdefault(r["day"], {})[r["t"]] = r["rev"] or 0
    p90 = {}
    for v in vids.values():
        if a90 <= (v["published_date"] or "") <= b0:
            p90.setdefault(v["published_date"], {}).setdefault(v["content_type"], 0)
            p90[v["published_date"]][v["content_type"]] += 1
    daily90 = []
    for r in q(con, "SELECT day, views, estimatedMinutesWatched mi, subscribersGained sg, subscribersLost sl, estimatedRevenue rev "
                    "FROM channel_daily WHERE day BETWEEN ? AND ? ORDER BY day", a90, b0):
        d, g = r["day"], lambda t, k: (t90.get(r["day"], {}).get(t) or {}).get(k) or 0  # noqa: E731
        daily90.append({"day": d, "views": r["views"], "views_long": g(LONG, "v"), "views_shorts": g(SHORT, "v"),
                        "hours": r2((r["mi"] or 0) / 60, 1), "subs_net": (r["sg"] or 0) - (r["sl"] or 0),
                        "subs_gained": r["sg"], "subs_lost": r["sl"], "revenue": r2(r["rev"]),
                        "revenue_long": r2(r90.get(d, {}).get(LONG, 0)), "revenue_shorts": r2(r90.get(d, {}).get(SHORT, 0)),
                        "published_long": p90.get(d, {}).get(LONG, 0), "published_shorts": p90.get(d, {}).get(SHORT, 0)})

    obj = {"window": {"from": a0, "to": b0, "prev_from": a1, "prev_to": b1}, "kpis": kpis, "daily": daily,
           "daily90": daily90, "new_videos": new, "top_videos": top, "traffic": traffic, "reach": reach}
    write("semana", obj, "semana", "Últimos 7 días con datos de Analytics (la API va 1-2 días por detrás) frente a los 7 anteriores. "
          "kpis de channel_daily y channel_daily_by_type; change = (última − anterior) / anterior. new_videos: publicados desde el "
          "inicio de la ventana (views_total es la cifra pública actual de la Data API). top_videos: más vistos en la ventana "
          "(video_daily). reach: impresiones y CTR diarios de la Reporting API (rep_reach), si ya hay datos.")
    if not quiet:
        for k in kpis:
            print(f"  {k['metric']:<14} {k['last7']}  (antes {k['prev7']}, {k['change']})")


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    argv = sys.argv[1:] if argv is None else argv
    quiet = "--quiet" in argv
    mode = next((a for a in argv if not a.startswith("-")), "todo")
    if mode not in ("todo", "semana"):
        sys.exit(__doc__)
    con = sqlite3.connect(DB)
    if mode == "todo":
        completo(con, quiet)
    semana(con, quiet)
    con.close()


if __name__ == "__main__":
    main()
