# Architecture

The Livestock Registry dashboard is a self-contained service: a Next.js
application that serves the page and its own small API (a backend-for-frontend).
It shows aggregate figures only and never handles individual records.

```
 browser ── dashboard.<registry domain> ──► this service
                                             ├─ proxy.ts      session + role check (every request)
                                             ├─ /api/*        Elysia BFF: charts, filters, user
                                             └─ ChartSource   ─► livestock-registry-dashboard-api ─► reporting views
                                                  │
 registry IAM ◄── session check (get_user_profile)┘
```

## Access

Login belongs to the registry's IAM (the staff portal API). After login IAM
sets its session cookies on the registry's cookie domain; the dashboard is
served under that domain, so the browser sends those cookies with every
request. `proxy.ts` runs before every page and API route and:

1. asks IAM whether the session is valid (`GET /auth/get_user_profile`), caching
   the answer per session for `SESSION_CACHE_SECONDS`;
2. requires the client role `DASHBOARD_ROLE` (default `Dashboard Viewer`) on
   the Keycloak client `DASHBOARD_CLIENT_ID` (default
   `livestock-registry-dashboard`).

No session sends the browser to IAM login (`/api/auth/login`), which returns it
to the page it asked for. A session without the role gets a 403 page. API calls
get 401 or 403 instead of a redirect.

The same client role drives the staff-portal tile: IAM shows a tile enabled
only to users whose token has a role on the client named like the tile's
application mnemonic. Granting `Dashboard Viewer` therefore both shows the tile
and opens the dashboard; revoking it does both too.

### Registration with IAM

`iam/payload.json` is the dashboard's catalog for IAM: the tile (mnemonic, URL,
icon) plus one permission, `dashboard:view`, and one role, `Dashboard Viewer`.
`node iam/register.mjs` (shipped in the image) upserts it. It authenticates
with the dashboard client's service account and is safe to run on every deploy.

Environment setup, done once per realm before registration:

- a confidential Keycloak client `livestock-registry-dashboard` with a service
  account (for registration);
- a client role `Dashboard Viewer` on it, assigned to the users who may see the
  dashboard.

## Data

Chart rows come through `ChartSource` (`server/data/chart-source.ts`):

| Source | Status | Reads |
| --- | --- | --- |
| `http` (`http-chart-source.ts`) | in use | the registry's dashboard-api, `GET /api/v1/charts/<id>` |

`server/data/catalog.ts` is the contract: the chart IDs, the filters each
accepts, and which charts feed the filter bar. Row column names must stay
identical whatever produces them.

Responses are cached in process for `DASHBOARD_CACHE_TTL_SECONDS` (default
15 min) with stale-while-revalidate: a refresh runs in the background and the
last good rows are served if it fails. The cache is warmed at startup
(`instrumentation.ts`).

### Folding the dashboard-api into this service

The dashboard-api exists so that only it holds registry database credentials.
If that separation is no longer wanted, this service can read the reporting
views itself:

1. add `server/data/sql-chart-source.ts`, implementing `ChartSource` with the
   dashboard-api's queries (they read only the `lr_rpt_*` reporting views);
2. select it in `server/data/index.ts` with `CHART_SOURCE=sql`, plus a
   read-only database role for this service;
3. retire the dashboard-api deployment.

Nothing above `ChartSource` changes: the UI, the BFF routes and the cache are
unaffected.

## API

All routes except `/api/health` and `/api/auth/*` require a session with the
dashboard role.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | liveness, and whether the chart source answers |
| `GET /api/me` | signed-in user's name and header links |
| `GET /api/charts?charts=a,b&<filters>` | rows for several charts |
| `GET /api/filter-options` | regions (from the shared location catalog) and record statuses |
| `GET /api/locations?regionId=` / `zoneId=` / `woredaId=` | child units for the filter cascade (location catalog) |
| `GET /api/maps/<level>` | compressed boundaries for the map |
| `GET /api/auth/login?returnTo=` / `GET /api/auth/logout` | start login at IAM / sign out (IAM, or locally when the session has expired) |

Filters: `region`, `zone`, `woreda`, `kebele` (catalog codes: P-codes such as `ET04`, `ET0401`) and `recordState`.

The filter locations come from `data/geo-catalog.json.br`, a snapshot of the farmer
registry's Master Data location catalog, which every registry shares
(`scripts/build-geo-catalog.mjs`; see docs/deployment.md). The map boundaries
are older and miss units the registries record, so they draw the map only.

The dashboard serves one host, `PUBLIC_URL`: IAM's session cookies reach only
hosts under its cookie domain, so `proxy.ts` redirects any other host there
first (except `/api/health`, which probes call on the pod address).

## Exports

Image, PDF and CSV exports are built in the browser from what is on screen. CSV
contains the aggregate panels, never per-person records.
