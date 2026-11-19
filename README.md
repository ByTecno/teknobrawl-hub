# TeknoBrawl Hub

Código del panel privado del canal TeknoBrawl.

- `site/`: la web (Cloudflare Pages).
- `functions/`: Pages Functions; sirven los datos desde Workers KV.
- `pipeline/`: scripts que descargan las estadísticas de YouTube y calculan los análisis (`yt.py`, `analisis.py`, `snapshot.py`), el acceso a Workers KV (`kv.py`) y el lanzador de las tareas (`run.py`).
- `.github/workflows/`: tareas programadas (`cada-hora.yml`, `cada-6h.yml`, `cada-dia.yml`) y el despliegue de la web (`deploy.yml`).

Este repositorio **no contiene datos ni credenciales**. Los datos viven en un almacenamiento privado de Cloudflare y las credenciales en los secretos cifrados de GitHub.
