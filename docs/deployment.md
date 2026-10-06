# Deployment

The dashboard ships as one container image and one Helm chart
(`helm/livestock-registry-dashboard`). It runs in the livestock registry's namespace
(`live`), next to that registry's dashboard-api, IAM and Keycloak, and is
reached as a tile from the registry's staff portal.

## Nothing environment-specific is configured

No URL, host name, realm or login provider of an environment is written in the
chart or the pipeline. Everything is derived from what the namespace already
runs:

| Setting | Where it comes from |
| --- | --- |
| Base domain | The IAM cookie domain: `IAM_STAFF_AUTH_COOKIE_DOMAIN` of the IAM Deployment (`iam.service`, default `commons-services-iam-staff-portal-api-pub`). The pipeline reads it with `kubectl`, and the chart can also look it up itself. |
| Public host | `<release>[-<environment>].<domain>`, for example `livestock-registry-dashboard-development.<domain>`. `environment` is set by CI per branch. A host derived from the cookie domain always lies under it, so the browser sends IAM's session cookies to the dashboard. |
| Staff-portal link | `staff-portal-<registry>[-<environment>].<domain>`, following the same rule. |
| IAM | The in-cluster Service of the same name. Only the dashboard's server calls IAM. |
| Login provider | Discovered at run time. It is the IAM login provider whose callback host lies under the cookie domain (`server/auth/login-provider.ts`, `iam/discover.mjs`). An IAM that serves a private domain and a public one has one provider per domain. |
| Keycloak host and realm | Discovered from IAM. Starting a sign-in returns Keycloak's authorization URL, which names the realm. |
| dashboard-api | The registry release's Service (`dashboardApi.service`), or any base URL (`dashboardApi.url`). |
| dashboard-api token endpoint | With `dashboardApi.auth.enabled`: discovered from IAM, like the realm. `dashboardApi.auth.tokenUrl` overrides it. |

Every value can still be overridden: `domain`, `host`, `iam.cookieDomain`,
`iam.loginProviderId`, `links.*`.

## What a release contains

| Object | Purpose |
| --- | --- |
| Deployment + Service | The Next.js server (UI and its `/api`): port 3000 behind a ClusterIP Service on port 80. It runs with a read-only root filesystem, as a non-root user, with no Kubernetes API token. |
| Gateway + VirtualService | The public host, on the release's own Istio Gateway (port 8080, HTTP2). TLS terminates at the host's nginx. An extra private host can be added on an existing gateway (`ingress.private`). |
| Secret `<release>-client` | Client secret of the Keycloak client `livestock-registry-dashboard`. Generated on first install, then kept, also across uninstalls. With `dashboardApi.auth.enabled` the server reads it too, to get its dashboard-api tokens. |
| Job `<release>-iam-setup` (post-install/upgrade hook) | Runs from the dashboard image. `iam/keycloak-setup.mjs` creates or updates the Keycloak client, its **Dashboard Viewer** role and the grants to `iamSetup.grantUsers`; with `dashboardApi.auth.enabled`, also the dashboard-api's client and role, granted to this client's service account. Then `iam/register.mjs` registers the tile, the `dashboard:view` permission and the role with IAM. |
| ECR pull secret (hook Job + CronJob) | Keeps `<release>-ecr` fresh from the node's IAM role, so the namespace needs no pull-secret setup. |

The setup job authenticates to Keycloak as its master-realm admin, using the
namespace's `commons-keycloak` Secret. It asks for the token that registers
with IAM at the discovered realm, so the token's issuer is one IAM trusts.

## Sign-in and sign-out

**Sign-in**
- A request without a session goes to `/api/auth/login`. That starts a
  sign-in at IAM for the discovered provider.
- IAM sends the browser to Keycloak, then back to the dashboard with its
  session cookies set.

**Access**
- Each request is checked with IAM (`/auth/get_user_profile`), cached for
  `sessionCacheSeconds`.
- A session without the role on `access.clientId` gets a 403 page.

**Canonical host**
- Requests for any host other than the public one are redirected to it,
  because the cookies only reach that host.
- The exception is `/api/health`, for probes that call the pod address.

**Sign-out**
- `/api/auth/logout` asks IAM to end the session. IAM ends the Keycloak
  session and returns to its login provider's landing page.
- The dashboard always clears the session cookies on its cookie domain as
  well, because IAM clears them on its own domain.
- If IAM cannot end the session (it has expired), the dashboard clears the
  cookies and lands on the staff portal. It ends the Keycloak session as well
  only when `oidc.logoutUrl` is set; that host must then be a valid post-logout
  redirect URI of IAM's Keycloak client.

## Locations

The filter bar's regions, zones, woredas and kebeles come from
`data/geo-catalog.json.br`, a snapshot of the farmer registry's Master Data
location catalog, which every registry shares. Regenerate and commit it when
the catalog changes:

```bash
node scripts/build-geo-catalog.mjs ../farmer-registry/docker/db-seed/seed-data/geo/geo_level_values.json
```

## CI/CD

`Jenkinsfile` runs as a multibranch job.

**Every branch**
- **Verify:** lint and type-check in a Node 24 container.

**`develop` only**
1. **ECR Login:** creates the ECR repository
   `openg2p/livestock-registry-dashboard` on the first build.
2. **Build & Push:** builds the image and pushes it, tagged with the commit
   (12 characters) and `develop`.
3. **Deploy (dev):** runs on `vpn-agent2` with `gen2-dev-livestock-kubeconfig`:
   - reads the IAM cookie domain from the cluster;
   - renders the chart with `environment=development`;
   - runs `helm upgrade --install --wait` into `live`;
   - waits for the rollout;
   - checks `/api/health` through the Service, which fails unless the
     dashboard reaches its dashboard-api;
   - prints the public URL.

Staging is not wired yet. Its stages are commented out in the Jenkinsfile, so
that nothing missing on staging can fail a development build.

`.github/workflows/ci.yml` runs lint, type-check and build on pull requests,
plus `helm lint`/`helm template` and a Docker build.

## Before the first deployment

These steps are one-time and outside the pipeline:

1. **Repository and Jenkins.**
   - The repository must live in the GitHub organisation the Jenkins
     organisation folders scan.
   - Add its name to a folder's repository filter.
2. **Public host.** Add a DNS record, a host nginx site that forwards to the
   Istio gateway (NodePort 30080), and a certificate for the derived host
   (`livestock-registry-dashboard-development.<domain>` on dev).
   - The release creates the Istio Gateway and route itself.
   - Until the host resolves, the deploy still succeeds and the smoke test
     still passes, because the smoke test calls the Service directly.
3. **Access for further users.** Grant the role in Keycloak: client
   `livestock-registry-dashboard` → Roles → Dashboard Viewer → Users in role.
   Alternatively, add the users to `iamSetup.grantUsers`.

## Authenticating to the dashboard-api

Off by default, so an existing release behaves as before. To turn it on:

1. Deploy the dashboard with `dashboardApi.auth.enabled=true`. Its setup job
   creates the client `livestock-registry-dashboard-api` with the role
   `charts:read` and grants it to the dashboard's service account; the server
   starts sending tokens.
2. Set `AUTH_IAM_URL` on the dashboard-api to the registry's IAM Service in
   the same namespace (in the livestock registry chart:
   `dashboardApi.env.AUTH_IAM_URL`). It then trusts every realm IAM signs staff
   in with, including the one this dashboard gets its tokens from (logged as
   `dashboard-api tokens from <url>`), so no realm URL is configured.

The development pipeline passes `dashboardApi.auth.enabled=true`, so step 1 is
done on every dev deploy.

Until step 2 the dashboard-api ignores the tokens. Done the other way round,
chart refreshes fail with `401` and the dashboard keeps serving its cached
rows. See the dashboard-api's `docs/security.md` for what it checks.

On the first release with authentication on, the new pods start, and warm
their cache, before the setup job (a post-upgrade hook) has granted the role.
That warm-up logs `401` for every chart. It needs no action: a `401` drops the
token, and the next request fetches one that carries the role.

## Running it in another namespace or on another server

Where the pod runs does not matter to sign-in; what matters is:

| Requirement | Why | What to set |
| --- | --- | --- |
| The public host lies under IAM's cookie domain | The browser sends IAM's session cookies only to hosts under it. Under another domain, sign-in loops | `host` (or `domain`) under that domain, with DNS, TLS and a route to the pod |
| The server reaches IAM | Sign-in start, session check and sign-out are server-to-server calls | `iam.service`: `<service>.<namespace>` from another namespace; `iam.url` (IAM's private or public URL) from another cluster or server |
| The cookie domain is known | The chart reads it from the IAM Deployment in its own namespace | `iam.cookieDomain` |
| Keycloak setup can run | The job needs the Keycloak admin Secret in its namespace and a route to Keycloak | `iamSetup.keycloakAdmin.secret`, or `iamSetup.enabled=false` with the setup done once from the registry's namespace |
| The dashboard-api is reachable, and only by this dashboard | Its Service is cluster-internal, and it must never be public | `dashboardApi.url`: `http://<service>.<namespace>` from another namespace; from another cluster or server, a private route (VPN, private load balancer, internal gateway behind an allowlist) over TLS, **with `dashboardApi.auth.enabled`** and the dashboard-api's authentication on (`AUTH_IAM_URL` or `AUTH_ISSUER`) |

## Running it locally

`npm run dev`, with `.env.example` copied to `.env.local`. The OpenG2P local
workspace runs it in Docker next to the registry: `openg2p.sh up livestock`
serves it at `http://dashboard.livestock.localtest.me:3201`.
