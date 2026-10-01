# Deployment

The dashboard ships as one container image and one Helm chart
(`helm/livestock-registry-dashboard`). It runs in the livestock registry's namespace
(`live`), next to the registry's own dashboard-api, IAM and Keycloak, and it is
reached as a tile from the registry's staff portal.

## What a release contains

| Object | Purpose |
| --- | --- |
| Deployment + Service | The Next.js server (UI and its `/api`), port 3000 behind a ClusterIP Service on port 80. Read-only root filesystem, non-root user, no Kubernetes API token. |
| Gateway + VirtualService | Hostname routing through the Istio ingress gateway (`ingress.public`), or a VirtualService on an existing gateway (`ingress.private`). TLS terminates at the host's nginx. |
| Secret `<release>-client` | Client secret of the Keycloak client `livestock-registry-dashboard`. Generated on first install, then kept (also across uninstall). |
| Job `<release>-keycloak-setup` (post-install/upgrade hook) | Creates or updates that Keycloak client (confidential, service account, no login flows), its client role **Dashboard Viewer**, and grants the role to `keycloakSetup.grantUsers`. |
| Job `<release>-iam-register` (post-install/upgrade hook) | Registers the dashboard with the registry's IAM: the staff-portal tile, the `dashboard:view` permission and the **Dashboard Viewer** role (`iam/payload.json`). |
| ECR pull secret (hook Job + CronJob) | Keeps `<release>-ecr` fresh from the node's IAM role, so the namespace needs no manual pull-secret setup. |

## Configuration

Every environment difference is a chart value; `values.yaml` documents each
one, and `values-dev.yaml` holds the dev cluster's.

| Value | Meaning |
| --- | --- |
| `publicUrl` | The dashboard's public origin. It is the only host the dashboard serves (any other host is redirected to it) and where login returns. |
| `iam.url` | The registry's IAM. Only the dashboard server calls it, so the in-cluster Service is used. |
| `iam.cookieDomain` | The IAM's `AUTH_COOKIE_DOMAIN`. **`publicUrl` must be a host under it**, or the browser never sends the session cookies and every visit restarts the login. |
| `oidc.logoutUrl`, `oidc.clientId` | Keycloak's end-session endpoint (browser-facing) and IAM's client id, used to end the Keycloak session when IAM cannot (an expired session). |
| `dashboardApiUrl` | The registry's dashboard-api Service. |
| `keycloakSetup.*` | Keycloak admin endpoint, realm and admin Secret used by the setup hook. |
| `access.clientId`, `access.role` | The Keycloak client and client role that gate the dashboard and its tile. |

## Sign-in and sign-out

- **Sign-in.** A request without a session is sent to `/api/auth/login`, which
  starts a login transaction at IAM; IAM sends the browser to Keycloak and back
  to `publicUrl` with its session cookies set.
- **Access.** Each request is checked against IAM (`/auth/get_user_profile`,
  cached for `sessionCacheSeconds`). A session without the role on
  `access.clientId` gets a 403 page.
- **Sign-out.** `/api/auth/logout` asks IAM to end the session. IAM clears the
  cookies and sends the browser through Keycloak's end-session endpoint to its
  login provider's landing page (the staff portal). When IAM cannot end the
  session itself, the dashboard clears the cookies on `iam.cookieDomain` and
  ends the Keycloak session through `oidc.logoutUrl`. In both cases the user
  lands on the staff portal.
- **Keycloak.** The IAM client must allow the dashboard's origin as a redirect
  URI and the staff portal as a post-logout redirect URI.

## Locations

The filter bar's regions, zones, woredas and kebeles come from
`data/geo-catalog.json.br`, a snapshot of the farmer registry's Master Data
location catalog, which every registry shares. Codes are the catalog ids
without their level prefix (`ET04`, `ET0401`, …), the codes the dashboard-api
filters on. After the catalog changes, regenerate and commit the snapshot:

```bash
node scripts/build-geo-catalog.mjs ../farmer-registry/docker/db-seed/seed-data/geo/geo_level_values.json
```

## CI/CD

`Jenkinsfile` runs as a multibranch job:

1. **Verify:** lint and type-check in a Node 20 container.
2. **Build & Push:** builds the image and pushes it to ECR
   `openg2p/livestock-registry-dashboard`. The tag is the commit (12 characters),
   and `develop`/`staging` also move a tag of their own name.
3. **Deploy (dev):** `develop` only, on the `vpn-agent2` node with the
   `gen2-dev-livestock-kubeconfig` credential:
   - `helm upgrade --install` into `live` with `values-dev.yaml`;
   - waits for the rollout;
   - checks `/api/health` through the Service, which fails unless the
     dashboard reaches its dashboard-api.

The other branches build and push only.

`.github/workflows/ci.yml` runs the same checks on pull requests: lint,
type-check, build, `helm lint`/`helm template`, and a Docker build.

## First deployment to an environment

These steps are one-time and outside CI:

1. **ECR.** Create the repository `openg2p/livestock-registry-dashboard` in
   `ap-south-1`. The pipeline checks it exists and does not create it.
2. **Jenkins.** Add the repository to the GitHub organization folder, or create
   a multibranch job for it.
3. **Public host.** For `ingress.public`, add:
   - a DNS record;
   - a host nginx site that forwards to the Istio gateway (NodePort 30080);
   - a certificate.

   The host must sit under the IAM's cookie domain.
4. **Keycloak redirects.** Add `https://<dashboard host>/*` to the IAM client's
   valid redirect URIs. The staff portal must be a valid post-logout redirect URI.
5. **Keycloak admin Secret.** `keycloakSetup.adminSecret` must exist in the
   namespace. It is the same Secret the registry's own Keycloak setup uses.

After that, every merge to `develop` deploys. Granting the role to further
users is done in the Keycloak admin console (client `livestock-registry-dashboard`
→ Roles → Dashboard Viewer → Users in role), or through
`keycloakSetup.grantUsers`.

## Running it locally

`npm run dev` with `.env.example` copied to `.env.local`. The OpenG2P local
workspace runs it in Docker next to the registry: `openg2p.sh up livestock`
serves it at `http://dashboard.livestock.localtest.me:3201`.
