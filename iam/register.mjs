// Registers this dashboard with the registry's IAM: the staff-portal tile plus
// its permission/role catalog (payload.json). Idempotent: IAM upserts by
// mnemonic, so it is safe to run on every deploy (e.g. as a post-install job:
// `node iam/register.mjs` in this same image).
//
// IAM shows the tile enabled only to users whose token carries a client role
// on the Keycloak client named like the application mnemonic, so that client
// and its "Dashboard Viewer" role must already exist (environment setup).
// Authenticates as that client with client_credentials (its service account).
//
// Environment:
//   IAM_REGISTER_URL  IAM base URL reachable from the job (e.g. http://iam:8000)
//   TOKEN_URL         Keycloak token endpoint of the registry's realm
//   DASHBOARD_CLIENT_ID, DASHBOARD_CLIENT_SECRET  that client
//   PUBLIC_URL        browser URL of the dashboard (the tile link)
//   APP_DESCRIPTION   tile label
//   MAX_ATTEMPTS      retries per step, 5 s apart (default 40)
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const env = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}
const iamUrl = env("IAM_REGISTER_URL").replace(/\/+$/, "")
const tokenUrl = env("TOKEN_URL")
const clientId = env("DASHBOARD_CLIENT_ID")
const clientSecret = env("DASHBOARD_CLIENT_SECRET")
const appUrl = env("PUBLIC_URL").replace(/\/+$/, "")
const description = env("APP_DESCRIPTION")
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

const template = await readFile(join(dirname(fileURLToPath(import.meta.url)), "payload.json"), "utf8")
const body = template
  .replaceAll("__APPLICATION_MNEMONIC__", clientId)
  .replaceAll("__APPLICATION_URL__", appUrl)
  .replaceAll("__APPLICATION_DESCRIPTION__", description)
JSON.parse(body) // fail early on a broken template

console.log(`Waiting for IAM at ${iamUrl}...`)
await retry("IAM ping", async () => {
  const res = await fetch(`${iamUrl}/ping`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
})

console.log(`Requesting a token for ${clientId}...`)
const token = await retry("token", async () => {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(10000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new Error(`HTTP ${res.status} ${data.error_description || data.error || ""}`.trim())
  return data.access_token
})

console.log(`Registering ${clientId} -> ${appUrl}`)
const result = await retry("registration", async () => {
  const res = await fetch(`${iamUrl}/user-access/staff_portal_applications`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
  return text
})
console.log(`Registered: ${result}`)
