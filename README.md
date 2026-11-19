# TeknoBrawl Hub

Código del panel privado del canal TeknoBrawl.

- `site/`: la web (Cloudflare Pages).
- `functions/`: Pages Functions; sirven los datos desde Workers KV.
- `.github/workflows/`: tareas programadas que generan los datos y despliegan la web.

Este repositorio **no contiene datos ni credenciales**. Los datos viven en un almacenamiento privado de Cloudflare y las credenciales en los secretos cifrados de GitHub.
