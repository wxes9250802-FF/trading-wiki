import "server-only";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { holdings, holdingTransactions } from "@/lib/db/schema/holdings";
import { fetchCurrentPrice } from "@/lib/price/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HoldingResult {
  symbol: string;
  sharesLots: number;
  avgCost: number;
}

export interface PortfolioRow extends HoldingResult {
  currentPrice: number | null;
  marketValue: number | null;  // sharesLots * 1000 * currentPrice
  costBasis: number;           // sharesLots * 1000 * avgCost
  pnl: number | null;          // marketValue - costBasis
  pnlPct: number | null;       // pnl / costBasis * 100
}

// ─── Buy ──────────────────────────────────────────────────────────────────────

/**
 * 買入：新持股插入 row；已有同 symbol 者用加權平均更新 avg_cost 並累加 shares。
 * 一律插入一筆 holding_transactions 稽核紀錄。
 *
 * 加權平均公式：newAvg = (oldShares * oldAvg + addedShares * addedPrice) / (oldShares + addedShares)
 * 1 張 = 1000 股，但 sharesLots 欄位直接存張數，avg_cost 是每股成本。
 */
export async function buyHolding(opts: {
  userId: string;
  symbol: string;      // 已正規化後的 symbol（"2330.TW" / "6451.TWO"）
  sharesLots: number;  // 張數
  price: number;       // 每股成本
  note?: string;
}): Promise<HoldingResult> {
  const { userId, symbol, sharesLots, price, note } = opts;

  return db.transaction(async (tx) => {
    // 稽核紀錄永遠先寫
    await tx.insert(holdingTransactions).values({
      userId,
      symbol,
      action: "buy",
      sharesLots: String(sharesLots),
      price: String(price),
      note: note ?? null,
    });

    // 查詢現有持股
    const [existing] = await tx
      .select()
      .from(holdings)
      .where(and(eq(holdings.userId, userId), eq(holdings.symbol, symbol)))
      .limit(1);

    if (!existing) {
      // 全新持股 → 插入
      const [inserted] = await tx
        .insert(holdings)
        .values({
          userId,
          symbol,
          sharesLots: String(sharesLots),
          avgCost: String(price),
        })
        .returning();

      if (!inserted) throw new Error("Failed to insert holding");

      return {
        symbol,
        sharesLots,
        avgCost: price,
      };
    }

    // 已有持股 → 加權平均更新
    const oldShares = parseFloat(existing.sharesLots);
    const oldAvg = parseFloat(existing.avgCost);
    const newShares = oldShares + sharesLots;
    const newAvg = (oldShares * oldAvg + sharesLots * price) / newShares;

    await tx
      .update(holdings)
      .set({
        sharesLots: String(newShares),
        avgCost: String(newAvg),
        updatedAt: new Date(),
      })
      .where(eq(holdings.id, existing.id));

    return {
      symbol,
      sharesLots: newShares,
      avgCost: newAvg,
    };
  });
}

// ─── Sell ─────────────────────────────────────────────────────────────────────

/**
 * 賣出：從現有 shares 扣掉。
 * - 扣完變 0 → 刪掉 holdings row，回傳 null
 * - 還有剩餘 → avg_cost 不變，回傳更新後的 HoldingResult
 * - 找不到 holding 或張數不足 → throw Error（呼叫端 catch 後回使用者訊息）
 * 一律插入一筆 holding_transactions 稽核紀錄。
 */
export async function sellHolding(opts: {
  userId: string;
  symbol: string;
  sharesLots: number;
  price: number;
  note?: string;
}): Promise<HoldingResult | null> {
  const { userId, symbol, sharesLots, price, note } = opts;

  return db.transaction(async (tx) => {
    // 查詢現有持股
    const [existing] = await tx
      .select()
      .from(holdings)
      .where(and(eq(holdings.userId, userId), eq(holdings.symbol, symbol)))
      .limit(1);

    if (!existing) {
      throw new Error(`NO_HOLDING:${symbol}`);
    }

    const currentShares = parseFloat(existing.sharesLots);

    if (sharesLots > currentShares) {
      throw new Error(`INSUFFICIENT:${symbol}:${currentShares}`);
    }

    // 稽核紀錄
    await tx.insert(holdingTransactions).values({
      userId,
      symbol,
      action: "sell",
      sharesLots: String(sharesLots),
      price: String(price),
      note: note ?? null,
    });

    const remaining = currentShares - sharesLots;

    if (remaining <= 0) {
      // 全部賣出 → 刪除持股
      await tx
        .delete(holdings)
        .where(eq(holdings.id, existing.id));
      return null;
    }

    // 部分賣出 → avg_cost 不變，只更新 sharesLots
    await tx
      .update(holdings)
      .set({
        sharesLots: String(remaining),
        updatedAt: new Date(),
      })
      .where(eq(holdings.id, existing.id));

    return {
      symbol,
      sharesLots: remaining,
      avgCost: parseFloat(existing.avgCost),
    };
  });
}

// ─── List Portfolio ───────────────────────────────────────────────────────────

/**
 * 列出某使用者所有持股，並帶上目前市價與報酬率。
 * 目前市價抓不到時，currentPrice 為 null，相關計算欄位也為 null。
 * 1 張 = 1000 股，marketValue / costBasis 以股為單位計算。
 */
export async function listPortfolio(userId: string): Promise<PortfolioRow[]> {
  const rows = await db
    .select()
    .from(holdings)
    .where(eq(holdings.userId, userId));

  // 並行抓所有市價
  const results = await Promise.all(
    rows.map(async (row) => {
      const sharesLots = parseFloat(row.sharesLots);
      const avgCost = parseFloat(row.avgCost);
      const costBasis = sharesLots * 1000 * avgCost;

      const currentPrice = await fetchCurrentPrice(row.symbol);

      let marketValue: number | null = null;
      let pnl: number | null = null;
      let pnlPct: number | null = null;

      if (currentPrice !== null) {
        marketValue = sharesLots * 1000 * currentPrice;
        pnl = marketValue - costBasis;
        pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : null;
      }

      return {
        symbol: row.symbol,
        sharesLots,
        avgCost,
        currentPrice,
        marketValue,
        costBasis,
        pnl,
        pnlPct,
      };
    })
  );

  return results;
}
