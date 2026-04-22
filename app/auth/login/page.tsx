"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/auth/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "sent" | "error">(
    "idle"
  );
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setErrorMsg("");

    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        // Only allow existing users to sign in — new registrations must go
        // through /auth/signup with a valid invite code.
        shouldCreateUser: false,
      },
    });

    if (error) {
      setStatus("error");
      setErrorMsg(error.message);
    } else {
      setStatus("sent");
    }
  }

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        fontFamily: "system-ui, sans-serif",
        gap: "1rem",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>登入</h1>

      {status === "sent" ? (
        <p style={{ color: "#16a34a" }}>
          Magic link 已寄送至 <strong>{email}</strong>，請查收信箱。
        </p>
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            width: "100%",
            maxWidth: "320px",
          }}
        >
          <label
            htmlFor="email"
            style={{ fontSize: "0.875rem", fontWeight: 500 }}
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            style={{
              padding: "0.5rem 0.75rem",
              border: "1px solid #d1d5db",
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
            }}
          />

          {status === "error" && (
            <p style={{ color: "#dc2626", fontSize: "0.75rem" }}>{errorMsg}</p>
          )}

          <button
            type="submit"
            disabled={status === "loading"}
            style={{
              padding: "0.5rem 1rem",
              background: "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
              cursor: status === "loading" ? "not-allowed" : "pointer",
              opacity: status === "loading" ? 0.7 : 1,
            }}
          >
            {status === "loading" ? "送出中..." : "發送 Magic Link"}
          </button>

          <p style={{ fontSize: "0.75rem", textAlign: "center", color: "#6b7280" }}>
            沒有帳號？{" "}
            <a href="/auth/signup" style={{ color: "#2563eb" }}>
              使用邀請碼註冊
            </a>
          </p>
        </form>
      )}
    </main>
  );
}
