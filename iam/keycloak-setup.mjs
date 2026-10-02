// Keycloak side of the dashboard, through the Keycloak admin REST API.
// Idempotent; run on every deploy before iam/register.mjs:
//   - the confidential client DASHBOARD_CLIENT_ID (= the IAM application
//     mnemonic) with a service account and no login flows of its own (users
//     sign in through IAM), its secret set to DASHBOARD_CLIENT_SECRET;
//   - its client role DASHBOARD_ROLE. IAM enables the staff-portal tile, and
//     the dashboard admits a user, only when the token carries it;
//   - that role for each existing user in GRANT_USERS (space separated).
//
// The Keycloak host and realm are discovered from the registry's IAM (see
// discover.mjs); KEYCLOAK_URL / KEYCLOAK_REALM override them.
//
// Environment:
//   IAM_URL, PUBLIC_URL, COOKIE_DOMAIN, LOGIN_PROVIDER_ID (optional)
//   KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD   master-realm admin
//   DASHBOARD_CLIENT_ID, DASHBOARD_CLIENT_SECRET, DASHBOARD_ROLE, GRANT_USERS
//   MAX_ATTEMPTS  retries per step, 5 s apart (default 40)
import { discoverSignIn } from "./discover.mjs"

const env = (name, fallback) => {
  const value = process.env[name]?.trim()
  if (value) return value
  if (fallback !== undefined) return fallback
  throw new Error(`${name} is not set`)
}
const clientId = env("DASHBOARD_CLIENT_ID")
const clientSecret = env("DASHBOARD_CLIENT_SECRET")
const role = env("DASHBOARD_ROLE", "Dashboard Viewer")
const grantUsers = env("GRANT_USERS", "").split(/\s+/).filter(Boolean)
const maxAttempts = Number(process.env.MAX_ATTEMPTS) || 40
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function retry(step, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= maxAttempts) throw new Error(`${step} failed: ${error.message}`)
      console.log(`  ${step} not ready (attempt ${attempt}): ${error.message}`)
      await sleep(5000)
    }
  }
}

let baseUrl = process.env.KEYCLOAK_URL?.trim().replace(/\/+$/, "")
let realm = process.env.KEYCLOAK_REALM?.trim()
if (!baseUrl || !realm) {
  const found = await retry("Keycloak discovery", () =>
    discoverSignIn({
      iamUrl: env("IAM_URL"),
      providerId: process.env.LOGIN_PROVIDER_ID?.trim(),
      cookieDomain: process.env.COOKIE_DOMAIN?.trim(),
      publicUrl: env("PUBLIC_URL"),
    }),
  )
  baseUrl ||= found.baseUrl
  realm ||= found.realm
  console.log(`Login provider ${found.providerId}: Keycloak ${found.baseUrl}, realm ${found.realm}`)
}

const token = await retry("admin login", async () => {
  const res = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: env("KEYCLOAK_ADMIN", "admin"),
      password: env("KEYCLOAK_ADMIN_PASSWORD"),
    }),
    signal: AbortSignal.timeout(10000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new Error(`HTTP ${res.status} ${data.error_description || data.error || ""}`.trim())
  return data.access_token
})

const admin = `${baseUrl}/admin/realms/${encodeURIComponent(realm)}`
async function api(method, path, body) {
  const res = await fetch(`${admin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  if (res.status === 404 && method === "GET") return null
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.status === 204 || res.status === 201 ? null : res.json()
}

const findClient = async () => (await api("GET", `/clients?clientId=${encodeURIComponent(clientId)}`))?.[0]
let client = await findClient()
if (!client) {
  await api("POST", "/clients", {
    clientId,
    enabled: true,
    publicClient: false,
    secret: clientSecret,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    description: "Registry dashboard: access role + IAM registration",
  })
  client = await findClient()
  console.log(`Created client ${clientId}`)
} else {
  // Keep the secret in step with the release's Secret.
  await api("PUT", `/clients/${client.id}`, { ...client, secret: clientSecret, serviceAccountsEnabled: true })
}

const rolePath = `/clients/${client.id}/roles/${encodeURIComponent(role)}`
let roleRep = await api("GET", rolePath)
if (!roleRep) {
  await api("POST", `/clients/${client.id}/roles`, {
    name: role,
    description: "Can open the registry dashboard (aggregate figures only)",
  })
  roleRep = await api("GET", rolePath)
  console.log(`Created role '${role}'`)
}

for (const username of grantUsers) {
  const user = (await api("GET", `/users?username=${encodeURIComponent(username)}&exact=true`))?.[0]
  if (!user) {
    console.log(`User ${username} not found in realm ${realm}; skipped`)
    continue
  }
  await api("POST", `/users/${user.id}/role-mappings/clients/${client.id}`, [roleRep])
  console.log(`Granted '${role}' to ${username}`)
}
console.log(`[${realm}] ${clientId}: role '${role}' ready`)
