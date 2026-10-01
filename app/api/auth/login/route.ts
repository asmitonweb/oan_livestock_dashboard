// Starts login at the registry's IAM, which sends the user to Keycloak and
// then back to `returnTo` on this dashboard with its session cookies set.
import { NextResponse, type NextRequest } from "next/server"
import { config } from "@/server/config"
import { safeReturnPath } from "@/server/auth/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const returnTo = `${config.publicUrl}${safeReturnPath(request.nextUrl.searchParams.get("returnTo"))}`
  const url = new URL(`${config.auth.iamUrl}/auth/start_authentication_transaction`)
  url.searchParams.set("id", config.auth.loginProviderId)
  url.searchParams.set("redirect_uri", returnTo)

  try {
    const res = await fetch(url, { method: "POST", headers: { Accept: "application/json" }, cache: "no-store" })
    const data = (await res.json().catch(() => ({}))) as { redirectUrl?: string }
    if (!res.ok || !data.redirectUrl) throw new Error(`IAM returned HTTP ${res.status}`)
    return NextResponse.redirect(data.redirectUrl)
  } catch (error) {
    console.error("[auth] could not start login:", error instanceof Error ? error.message : error)
    return new NextResponse("Could not reach the sign-in service. Try again shortly.", { status: 503 })
  }
}
