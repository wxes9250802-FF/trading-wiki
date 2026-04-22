/**
 * Guard against open-redirect attacks.
 *
 * Allows only same-origin paths:
 *   ✅  /dashboard
 *   ✅  /auth/login?next=/settings
 *   ❌  http://evil.com
 *   ❌  //evil.com          (protocol-relative)
 *   ❌  null / ""
 */
export function safeRedirect(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}
