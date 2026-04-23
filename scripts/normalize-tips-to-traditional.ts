#!/usr/bin/env bun
/**
 * One-shot: run every tip's AI-generated text fields through OpenCC's
 * Simplified → Taiwan-Traditional converter so any simplified characters
 * that slipped through earlier versions get normalised.
 *
 * Fields touched:
 *   - tips.summary
 *   - tips.company_description
 *   - tips.sector_position
 *
 * Only rows where the converted value differs from the current value are
 * updated (skips no-ops).
 *
 * Env:
 *   DATABASE_URL     — required
 *   DRY_RUN=true     — print diffs without updating
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { tips } from "@/lib/db/schema/tips";
import { toTraditionalOrNull } from "@/lib/util/chinese";

const DRY_RUN = (process.env["DRY_RUN"] ?? "").toLowerCase() === "true";

async function main() {
  console.log(`[normalize] mode = ${DRY_RUN ? "DRY_RUN" : "EXECUTE"}\n`);

  const rows = await db
    .select({
      id: tips.id,
      summary: tips.summary,
      company_description: tips.companyDescription,
      sector_position: tips.sectorPosition,
    })
    .from(tips);

  console.log(`[normalize] loaded ${rows.length} tips\n`);

  let changed = 0;
  for (const row of rows) {
    const newSummary = toTraditionalOrNull(row.summary);
    const newCompany = toTraditionalOrNull(row.company_description);
    const newSector = toTraditionalOrNull(row.sector_position);

    const summaryChanged = newSummary !== row.summary;
    const companyChanged = newCompany !== row.company_description;
    const sectorChanged = newSector !== row.sector_position;

    if (!summaryChanged && !companyChanged && !sectorChanged) continue;

    changed++;
    console.log(`── tip ${row.id.slice(0, 8)}… ──`);
    if (summaryChanged) {
      console.log(`  summary:`);
      console.log(`    - ${row.summary}`);
      console.log(`    + ${newSummary}`);
    }
    if (companyChanged) {
      console.log(`  company_description:`);
      console.log(`    - ${row.company_description}`);
      console.log(`    + ${newCompany}`);
    }
    if (sectorChanged) {
      console.log(`  sector_position:`);
      console.log(`    - ${row.sector_position}`);
      console.log(`    + ${newSector}`);
    }

    if (!DRY_RUN) {
      await db
        .update(tips)
        .set({
          summary: newSummary,
          companyDescription: newCompany,
          sectorPosition: newSector,
          updatedAt: new Date(),
        })
        .where(eq(tips.id, row.id));
    }
  }

  console.log("━".repeat(50));
  console.log(
    `${DRY_RUN ? "DRY RUN" : "EXECUTED"}: ${changed} row(s) ${DRY_RUN ? "would be" : "were"} normalised (out of ${rows.length})`
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("[normalize] fatal:", err);
  process.exit(1);
});
