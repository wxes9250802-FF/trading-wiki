import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function middleware(req: NextRequest) {
  // `response` accumulates Set-Cookie headers from session refresh.
  // We must forward these cookies on EVERY return path — including redirects.
  let response = NextResponse.next({
    request: req,
  });

  const supabase = createServerClient(
    process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            req.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  // Refresh session if expired — must be called before checking user.
  // getUser() is the safe way to check auth state; getSession() relies on
  // the potentially-stale JWT in the cookie.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  // Treat a transient Supabase error (network, 5xx) as "don't know" —
  // let the request through rather than redirect-looping.
  // "Auth session missing!" is the expected non-error code path for guests.
  if (error && error.message !== "Auth session missing!") {
    return response;
  }

  // Authenticated — pass through with any refreshed cookies
  if (user) {
    return response;
  }

  // Unauthenticated — redirect to login, copying any refreshed cookies so
  // the PKCE code verifier isn't lost.
  const loginUrl = new URL("/auth/login", req.url);
  const redirectResponse = NextResponse.redirect(loginUrl);
  response.cookies.getAll().forEach(({ name, value }) => {
    redirectResponse.cookies.set(name, value);
  });
  return redirectResponse;
}

export const config = {
  matcher: [
    /*
     * Match all paths EXCEPT:
     * - /auth  and  /auth/* (login, signup, callback, and the bare /auth path)
     * - /api/telegram/webhook (public webhook receiver)
     * - /_next/* (Next.js internals)
     * - /favicon.ico, /robots.txt, and other static assets
     *
     * Key fix: `auth(/|$)` catches both `/auth` (no trailing slash) and `/auth/*`.
     * Without the `(/|$)` a path like `/authentic` would also be excluded — we
     * use word-boundary semantics instead.
     */
    "/((?!auth(/|$)|api/telegram/webhook|_next/static|_next/image|favicon\\.ico|robots\\.txt).*)",
  ],
};
