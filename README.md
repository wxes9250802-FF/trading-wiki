# Trading Intelligence Hub

AI-powered trading intelligence and analytics platform.

## Quick Start

```bash
# 1. Clone
git clone <repo-url>
cd trading-intelligence-hub

# 2. Install dependencies (requires Bun ≥ 1.3)
bun install

# 3. Configure environment
cp .env.example .env.local
# Edit .env.local — fill in DATABASE_URL and other required vars

# 4. Start dev server
bun dev
# → http://localhost:3000
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `bun dev` | Start development server (hot reload) |
| `bun build` | Build for production |
| `bun start` | Start production server |
| `bun test` | Run all tests with Vitest |
| `bun run typecheck` | TypeScript type-check (no emit) |
| `bun run lint` | ESLint |
| `bun run db:push` | Push schema changes to DB (no migration file) |
| `bun run db:generate` | Generate Drizzle migration files |
| `bun run db:studio` | Open Drizzle Studio (local DB GUI) |

## Environment Variables

See `.env.example` for the full list. Key variables:

- `DATABASE_URL` — Supabase PostgreSQL connection string (required)
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anonymous key

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Runtime**: Bun
- **Language**: TypeScript (strict)
- **ORM**: Drizzle ORM + postgres.js
- **Database**: Supabase PostgreSQL
- **Env validation**: t3-env
- **Logger**: pino + pino-pretty
- **Tests**: Vitest
