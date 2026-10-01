// Logout is IAM's: it clears the session cookies and ends the Keycloak session.
import { NextResponse } from "next/server"
import { config } from "@/server/config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function GET() {
  return NextResponse.redirect(`${config.auth.iamUrl}/auth/logout`)
}
