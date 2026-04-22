import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Supabase client with the service_role key.
 * Bypasses RLS — NEVER expose to the browser or return from API routes.
 * Use exclusively in Route Handlers and Server Actions.
 */
export function createSupabaseAdminClient() {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required for admin operations but is not set"
    );
  }
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
