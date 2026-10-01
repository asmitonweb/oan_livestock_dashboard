// Every request passes through here (Next.js proxy, Node runtime) before it
// reaches a page or an API route. No session sends a page to the registry's
// IAM login and fails an API call with 401; a session without the dashboard
// role gets the 403 page or a 403 response.
import { NextResponse, type NextRequest } from "next/server"
import { checkSession } from "@/server/auth/session"

const PUBLIC_PATHS = ["/api/health", "/api/auth/login", "/api/auth/logout", "/forbidden"]

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  if (PUBLIC_PATHS.some(path => pathname === path)) return NextResponse.next()

  const isApi = pathname.startsWith("/api/")
  const session = await checkSession(request.cookies)

  switch (session.kind) {
    case "ok":
      return NextResponse.next()
    case "anonymous": {
      if (isApi) return NextResponse.json({ error: "Not signed in" }, { status: 401 })
      const login = new URL("/api/auth/login", request.url)
      login.searchParams.set("returnTo", `${pathname}${search}`)
      return NextResponse.redirect(login)
    }
    case "forbidden":
      if (isApi) return NextResponse.json({ error: "Dashboard access is not granted to this user" }, { status: 403 })
      return NextResponse.rewrite(new URL("/forbidden", request.url), { status: 403 })
    case "unavailable":
      console.error("[auth] session check failed:", session.message)
      return isApi
        ? NextResponse.json({ error: "Sign-in service unavailable" }, { status: 503 })
        : new NextResponse("The sign-in service is unavailable. Try again shortly.", { status: 503 })
  }
}

export const config = {
  // Everything except Next's own static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
