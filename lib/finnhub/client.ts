/**
 * Finnhub API client — US stocks.
 *
 * Free tier: 60 calls/min, no card required. Endpoints used:
 *   - /quote                       price + day OHLC + prev close
 *   - /stock/profile2              company name, industry, exchange
 *   - /stock/insider-transactions  Form 4 insider buys/sells (T+2 reported)
 *   - /stock/recommendation        analyst recommendation trends (monthly)
 *
 * Every public function returns null on any failure — never throws.
 */

const FINNHUB_BASE = "https://finnhub.io/api/v1";

function getApiKey(): string | null {
  const key = process.env["FINNHUB_API_KEY"];
  if (!key) {
    console.warn("[finnhub] FINNHUB_API_KEY not set");
    return null;
  }
  return key;
}

async function fetchJson<T>(path: string, label: string): Promise<T | null> {
  const key = getApiKey();
  if (!key) return null;

  const url = new URL(`${FINNHUB_BASE}${path}`);
  url.searchParams.set("token", key);

  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (res.status !== 429) console.warn(`[finnhub:${label}] HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[finnhub:${label}] fetch error: ${String(err)}`);
    return null;
  }
}

// ─── Quote ────────────────────────────────────────────────────────────────────

export interface UsLatestQuote {
  date: string;            // "YYYY-MM-DD" — Finnhub returns timestamp; we format it
  close: number;           // current price (c)
  open: number;            // session open (o)
  high: number;            // session high (h)
  low: number;             // session low (l)
  prevClose: number;       // previous close (pc)
  changeAbs: number;       // close - prevClose (d)
  changePct: number;       // % (dp)
  /** Volume isn't included in Finnhub /quote — left as 0 if unknown. */
  volume: number;
}

interface FinnhubQuoteResponse {
  c?: number;   // current price
  d?: number;   // change
  dp?: number;  // change percent
  h?: number;   // day high
  l?: number;   // day low
  o?: number;   // day open
  pc?: number;  // previous close
  t?: number;   // unix timestamp
}

export async function fetchUsQuote(symbol: string): Promise<UsLatestQuote | null> {
  const data = await fetchJson<FinnhubQuoteResponse>(
    `/quote?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    "quote"
  );
  if (!data || typeof data.c !== "number" || data.c <= 0) return null;

  const ts = typeof data.t === "number" ? data.t * 1000 : Date.now();
  const dateIso = new Date(ts).toISOString().slice(0, 10);

  return {
    date: dateIso,
    close: data.c,
    open: data.o ?? data.c,
    high: data.h ?? data.c,
    low: data.l ?? data.c,
    prevClose: data.pc ?? data.c,
    changeAbs: data.d ?? 0,
    changePct: data.dp ?? 0,
    volume: 0,
  };
}

// ─── Company profile ──────────────────────────────────────────────────────────

export interface UsCompanyProfile {
  symbol: string;
  name: string;            // "Apple Inc"
  exchange: string;        // "NASDAQ NMS - GLOBAL MARKET" etc — we normalise to NYSE/NASDAQ at insert time
  industry: string | null; // finnhub "finnhubIndustry" e.g. "Technology"
  ipo: string | null;      // "1980-12-12"
  marketCap: number | null;
  weburl: string | null;
}

interface FinnhubProfileResponse {
  name?: string;
  ticker?: string;
  exchange?: string;
  finnhubIndustry?: string;
  ipo?: string;
  marketCapitalization?: number;
  weburl?: string;
}

export async function fetchUsCompanyProfile(
  symbol: string
): Promise<UsCompanyProfile | null> {
  const data = await fetchJson<FinnhubProfileResponse>(
    `/stock/profile2?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    "profile2"
  );
  if (!data || !data.name) return null;

  return {
    symbol: data.ticker ?? symbol.toUpperCase(),
    name: data.name,
    exchange: data.exchange ?? "",
    industry: data.finnhubIndustry ?? null,
    ipo: data.ipo ?? null,
    marketCap: data.marketCapitalization ?? null,
    weburl: data.weburl ?? null,
  };
}

// ─── Insider transactions (Form 4) ────────────────────────────────────────────

export interface InsiderTransaction {
  name: string;            // person's name
  share: number;           // shares after transaction
  change: number;          // delta (+ buy, - sell)
  filingDate: string;      // "YYYY-MM-DD"
  transactionDate: string; // "YYYY-MM-DD"
  transactionPrice: number;
  transactionCode: string; // "P" purchase, "S" sale, "A" award, "M" exercise...
}

interface FinnhubInsiderResponse {
  data?: Array<{
    name?: string;
    share?: number;
    change?: number;
    filingDate?: string;
    transactionDate?: string;
    transactionPrice?: number;
    transactionCode?: string;
  }>;
  symbol?: string;
}

/**
 * Fetch the most recent insider transactions, optionally bounded to a date.
 * Returns at most `limit` entries, sorted by transactionDate desc.
 */
export async function fetchUsInsiderTransactions(
  symbol: string,
  limit: number = 10
): Promise<InsiderTransaction[] | null> {
  // Finnhub limits the date range; we ask for the last 90 days
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 90);
  const from = fromDate.toISOString().slice(0, 10);

  const data = await fetchJson<FinnhubInsiderResponse>(
    `/stock/insider-transactions?symbol=${encodeURIComponent(symbol.toUpperCase())}&from=${from}&to=${to}`,
    "insider"
  );
  if (!data || !Array.isArray(data.data)) return null;

  const rows: InsiderTransaction[] = data.data
    .filter(
      (r) =>
        typeof r.name === "string" &&
        typeof r.transactionDate === "string" &&
        typeof r.change === "number"
    )
    .map((r) => ({
      name: r.name ?? "",
      share: r.share ?? 0,
      change: r.change ?? 0,
      filingDate: r.filingDate ?? "",
      transactionDate: r.transactionDate ?? "",
      transactionPrice: r.transactionPrice ?? 0,
      transactionCode: r.transactionCode ?? "",
    }))
    .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))
    .slice(0, limit);

  return rows;
}

// ─── Analyst recommendations ──────────────────────────────────────────────────

export interface AnalystRecommendation {
  period: string;          // "YYYY-MM-DD"
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

interface FinnhubRecommendationResponse {
  period?: string;
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
  symbol?: string;
}

export async function fetchUsRecommendations(
  symbol: string
): Promise<AnalystRecommendation[] | null> {
  const data = await fetchJson<FinnhubRecommendationResponse[]>(
    `/stock/recommendation?symbol=${encodeURIComponent(symbol.toUpperCase())}`,
    "recommendation"
  );
  if (!data || !Array.isArray(data)) return null;

  return data
    .filter((r) => typeof r.period === "string")
    .map((r) => ({
      period: r.period ?? "",
      strongBuy: r.strongBuy ?? 0,
      buy: r.buy ?? 0,
      hold: r.hold ?? 0,
      sell: r.sell ?? 0,
      strongSell: r.strongSell ?? 0,
    }));
}
