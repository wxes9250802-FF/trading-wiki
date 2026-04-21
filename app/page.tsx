// Server Component (default in App Router — no "use client" directive)
// Renders the placeholder homepage. The timestamp is generated on the server
// and proves that SSR hydration is working correctly.

export default function HomePage() {
  const now = new Date().toISOString();

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
      <h1>Trading Intelligence Hub</h1>
      <p style={{ color: "#666", fontSize: "0.875rem" }}>
        Server render time: <time dateTime={now}>{now}</time>
      </p>
      <p style={{ color: "#999", fontSize: "0.75rem" }}>
        Scaffold is live. Business features start at T2.
      </p>
    </main>
  );
}
