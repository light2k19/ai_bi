# AI BI

An AI-driven business-intelligence system for managers. Describe the analysis you need; an AI agent
inspects your data sources, writes **read-only** queries, picks the visuals, lays out the page and can
script animations. Pages always show live data — the AI writes queries and layout, never the numbers.

**[Watch the 2-minute demo](demo/AI-BI-demo.mp4)**: a sales page is described in one sentence, built by the AI
on the demo database, explored, refined by chat, saved, questioned and exported.

- **Multi-project**: each project has its own members, roles, skills, data sources and pages.
- **Skills** are the extension point: auth, data sources (MySQL, SQL Server, Oracle, PostgreSQL, SQLite, HTTP and GraphQL APIs),
  filters, transforms, visuals (18 chart types, tables, pivots, KPIs, text, AI narrative), exports
  (PDF, Excel) and script libraries. Every built-in feature is itself a skill.
- **Any visual**: catalogue widgets, raw ECharts options, or custom React (TSX) components written by the AI.
- **Scripts and modules**: page scripts animate and choreograph pages; extra npm modules are fetched,
  vendored, hash-pinned and served to a sandboxed runtime on its own origin.
- **Two ways to customise**: the built-in AI agent edits pages directly; or export / import `.aibi`
  packages (including their modules) — also built locally with your own AI using the authoring kit,
  the `aibi` CLI, or the MCP endpoint.
- **Local pages**: open `.aibi` / `page.json` files or folders in the browser (IndexedDB), with live
  reload from disk through the File System Access API.

## Quick start

Requirements: Node 22.13+ (Node 24 recommended). Windows, macOS or Linux.

```bash
npm install
cp .env.example .env      # set AI_API_KEY (OpenRouter) or point AI_BASE_URL at a local model
npm run dev               # seeds the demo on first run; API :8787, web :5173, runtime :5174
```

Open http://localhost:5173 and sign in:

| User | Password | Role in the demo project |
|------|----------|--------------------------|
| admin@example.com | admin1234 | platform admin, project admin |
| builder@example.com | builder1234 | builder |
| viewer@example.com | viewer1234 | viewer |

The demo project "Demo Co. analytics" has a generated company database (sales orders, products,
customers, regional targets, general ledger, budget, headcount; about 14,000 orders) and a sample
"Sales performance" page. `npm run seed -- --reset` regenerates the demo database.

## AI providers

The agent uses any **OpenAI-compatible chat-completions API** with function calling.

| Provider | `.env` |
|----------|--------|
| OpenRouter | `AI_BASE_URL=https://openrouter.ai/api`, `AI_API_KEY=sk-or-…`, `AI_MODEL=google/gemini-2.5-flash` (or any OpenRouter model, e.g. an Anthropic Claude model for better page quality) |
| Ollama | `AI_BASE_URL=http://localhost:11434`, `AI_MODEL=qwen2.5:14b`, `AI_API_KEY=` |
| LM Studio / vLLM / llama.cpp | `AI_BASE_URL=http://localhost:1234/v1`, `AI_MODEL=<model>` |

Models without tool calling: set `AI_TOOL_MODE=json` (or per project in Admin → Settings); the model
returns a whole page as JSON and the server runs and checks every dataset, feeding errors back.
Projects can override the model, set monthly token or cost budgets, and allow or block the viewer-facing
AI from running new queries. Page quality depends strongly on the model: stronger models write better SQL.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | API + web + runtime with hot reload (seeds on first run) |
| `npm run seed` | Create demo users, project, data source and sample page (`-- --reset` rebuilds the database) |
| `npm run build` | Production build of the runtime and the web app |
| `npm start` | Start the API (serves `apps/web/dist`; set `RUNTIME_PORT` to serve the runtime on its own port) |
| `npm test` | Unit tests (SQL guard, page spec, transforms, server security helpers) |
| `npm run test:connectors` | MySQL / SQL Server / Oracle / PostgreSQL integration tests in Docker |
| `npm run typecheck` | Type-check packages, server and skills |
| `npx tsx tools/smoke.ts` | API smoke test against a running server |
| `node tools/browser-check.mjs <dir> [paths]` | Screenshots + console errors with the installed Edge/Chrome |
| `node tools/e2e-ui.mjs <dir>` | UI end-to-end: filters, Ask AI, export, open local file, import wizard |
| `node tools/e2e-ai.mjs <dir> "<request>"` | Build a page through the AI chat in the browser and save it |
| `npx tsx tools/ai-eval.ts` | AI evaluation set (8 manager requests, graded; costs model tokens) |
| `node tools/demo-video/record.mjs <dir>` then `build.mjs <dir> <out.mp4>` | Record the demo video against a running server (needs Edge/Chrome and ffmpeg) |

## Layout

```
apps/server     Fastify API: auth, projects, skills, data gateway, pages, packages, modules, AI agent, MCP
apps/web        React host app: projects, viewer, editor (AI chat + panels), import, admin, local pages
apps/runtime    Sandboxed page runtime (separate origin): grid, filters, widgets, scripts, module loader
packages/       page-spec (schema, validator, expressions), sql-guard, transforms, skill-sdk, runtime-api, cli
skills/         20 built-in skills (manifest + AI instructions + server and/or client code)
tools/          dev launcher, smoke/e2e/eval scripts, connector tests
demo/           the demo video
```

## Security model (summary)

- **Read-only data access in layers**: SELECT-only account (the connection test warns otherwise) → token-level
  SQL guard (single SELECT/WITH, banned keywords, denied schemas/tables) → read-only transaction that is
  always rolled back (MySQL, SQL Server, Oracle) → row, byte and time limits → rate limits → query log.
- **Viewers** can only run the stored datasets of pages they can see; only builders run ad-hoc SQL.
- **Secrets** are AES-256-GCM encrypted at rest, masked in the API, never sent to the browser, the AI or packages.
- **Generated code** (scripts, components, modules) runs only in the runtime iframe on its own origin with a
  strict CSP and no credentials; data flows through `postMessage`. Module files are content-addressed and
  verified against their SHA-256 before use.
- **Cookies** are HTTP-only; state-changing requests from other origins are rejected. External access keys (personal tokens) are
  scoped (`query:read`, `page:read`, `page:import`, `mcp`), project-bound, expiring and revocable.

## Upgrading and backups

Everything AI BI stores lives in the data directory (`data/` by default, `AIBI_DATA_DIR`): the metadata
database `aibi.db` (projects, pages and their versions, members, data sources, logins), the encryption key
`.secret`, uploaded skills, vendored modules, gallery packages, imports and local SQLite files. The code can be
replaced freely; the data directory must be kept.

To upgrade: stop the app, replace the code (`git pull` or unpack the new version), run `npm install` and
`npm run build`, start the app. Schema changes are numbered and only ever add tables or columns; on start the app
applies the ones the database does not have yet, after writing a copy of the database to `data/backups/`
(the ten most recent are kept). Existing projects, pages and page versions are never touched. A database created
by a newer version is refused with a clear message instead of being modified, so an accidental downgrade cannot
damage it. `npm run seed` only adds the demo project if it is missing (`--reset` regenerates the demo
*warehouse* file only).

Backup at any time, also while the app runs: `npm run backup [dir]` writes a consistent copy of the database
plus `.secret` and the data folders to `data/backups/<timestamp>/` (or `dir`). To restore: stop the app, copy
the backup's contents over the data directory (including `.secret`: without it stored logins and secrets cannot
be decrypted), start the app. If you set `AIBI_SECRET` instead of using `.secret`, keep that value safe the
same way.

## Docker

`Dockerfile` builds a production image (web app, page runtime, API, with Chromium for PDF export; add
`--build-arg WITH_PDF=0` for a smaller image without a browser);
`docker-compose.yml` runs it with the data directory in a named volume:

```bash
cp .env.example .env            # AI_API_KEY and the AIBI_*_ORIGIN values users will type in the browser
docker compose up -d --build    # http://localhost:8787 (platform) and :8788 (page runtime)
```

The first visit opens the setup screen to create the platform administrator. To update: `docker compose build
&& docker compose up -d`; the volume is kept and schema changes are applied on start after an automatic backup.
Map a host folder instead of the named volume if you want to back it up with your own tools, and run
`docker compose exec aibi node tools/backup.mjs /data/backups/manual` for a consistent copy at any time.
The platform and the page runtime must stay on different origins (hostnames or ports), also behind a reverse
proxy.

## Production notes

Serve the web app and API from one origin and the runtime from a **different** origin (`RUNTIME_PORT`,
`AIBI_RUNTIME_ORIGIN`). Set `AIBI_SECRET`, `AIBI_SECURE_COOKIES=1` behind TLS, and real public URLs in
`AIBI_WEB_ORIGIN` / `AIBI_PUBLIC_API_URL`. PDF export needs Edge, Chrome or Chromium on the server
(`AIBI_BROWSER_PATH`). Metadata is stored in SQLite (`data/aibi.db`); back up the `data/` folder.
