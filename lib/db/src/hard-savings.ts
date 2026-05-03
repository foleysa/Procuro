import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { opportunitiesTable } from "./schema/opportunities";
import { eq, and, sql } from "drizzle-orm";

export async function computeHardSavingsTotal(
  dbInstance: NodePgDatabase<any>,
  orgId: string,
): Promise<number> {
  const [row] = await dbInstance
    .select({
      total: sql<string>`COALESCE(SUM(${opportunitiesTable.realizedSavingsUsd}::numeric), 0)`,
    })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.orgId, orgId),
        eq(opportunitiesTable.savingsClassification, "Hard"),
        eq(opportunitiesTable.canonicalStage, "Realized"),
        sql`${opportunitiesTable.classificationNeedsReview} = false`,
      ),
    );

  return Number(row?.total ?? 0);
}
