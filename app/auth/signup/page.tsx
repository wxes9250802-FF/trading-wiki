"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/auth/client";

export default function SignupPage() {
  const [inviteCode, setInviteCode] = useState("");
  const [email, setEmail] = useState("");
  const [telegramId, setTelegramId] = useState("");
  const [status, setStatus] = useState<
    "idle" | "validating" | "loading" | "sent" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("validating");
    setErrorMsg("");

    // Client-side pre-validation via the API route
    const checkRes = await fetch("/api/auth/validate-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inviteCode }),
    });
    const checkJson = (await checkRes.json()) as { valid: boolean; error?: string };

    if (!checkJson.valid) {
      setStatus("error");
      setErrorMsg(checkJson.error ?? "Invalid invite code");
      return;
    }

    setStatus("loading");

    const supabase = createSupabaseBrowserClient();
    const params = new URLSearchParams({ invite_code: inviteCode });
    if (telegramId.trim()) params.set("telegram_id", telegramId.trim());
    const redirectTo = `${window.location.origin}/auth/callback?${params.toString()}`;

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
        shouldCreateUser: true,
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
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>邀請碼註冊</h1>

      {status === "sent" ? (
        <p style={{ color: "#16a34a" }}>
          Magic link 已寄送至 <strong>{email}</strong>，請查收信箱完成註冊。
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
            htmlFor="invite-code"
            style={{ fontSize: "0.875rem", fontWeight: 500 }}
          >
            邀請碼
          </label>
          <input
            id="invite-code"
            type="text"
            required
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase().trim())}
            placeholder="XXXXXXXXXXXX"
            maxLength={12}
            style={{
              padding: "0.5rem 0.75rem",
              border: "1px solid #d1d5db",
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
              letterSpacing: "0.1em",
              fontFamily: "monospace",
            }}
          />

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

          <label
            htmlFor="telegram-id"
            style={{ fontSize: "0.875rem", fontWeight: 500 }}
          >
            Telegram User ID
          </label>
          <input
            id="telegram-id"
            type="text"
            inputMode="numeric"
            value={telegramId}
            onChange={(e) => setTelegramId(e.target.value.replace(/\D/g, ""))}
            placeholder="123456789"
            style={{
              padding: "0.5rem 0.75rem",
              border: "1px solid #d1d5db",
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
              fontFamily: "monospace",
            }}
          />
          <p style={{ fontSize: "0.7rem", color: "#6b7280", marginTop: "-0.5rem" }}>
            傳 <code>/start</code> 給 <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" style={{ color: "#2563eb" }}>@userinfobot</a> 取得你的 ID
          </p>

          {status === "error" && (
            <p style={{ color: "#dc2626", fontSize: "0.75rem" }}>{errorMsg}</p>
          )}

          <button
            type="submit"
            disabled={status === "validating" || status === "loading"}
            style={{
              padding: "0.5rem 1rem",
              background: "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
              cursor:
                status === "validating" || status === "loading"
                  ? "not-allowed"
                  : "pointer",
              opacity:
                status === "validating" || status === "loading" ? 0.7 : 1,
            }}
          >
            {status === "validating"
              ? "驗證中..."
              : status === "loading"
              ? "送出中..."
              : "發送 Magic Link"}
          </button>

          <p style={{ fontSize: "0.75rem", textAlign: "center", color: "#6b7280" }}>
            已有帳號？{" "}
            <a href="/auth/login" style={{ color: "#2563eb" }}>
              直接登入
            </a>
          </p>
        </form>
      )}
    </main>
  );
}
