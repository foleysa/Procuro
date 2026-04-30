import { db, usersTable, type UserRow } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { newId } from "./ids";

/**
 * Look up a user by `(orgId, email)`, creating the row if absent.
 *
 * The Replit/dev shell only carries an `actorEmail` header (no signup
 * flow), so the very first time a user touches an endpoint that needs a
 * stable `users.id` (alert subscriptions, watchlists) we lazily
 * provision the row. The name defaults to the email's local-part.
 */
export async function getOrCreateUserByEmail(
  orgId: string,
  email: string,
): Promise<UserRow> {
  const normalised = email.trim().toLowerCase();
  const existing = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.orgId, orgId), eq(usersTable.email, normalised)))
    .limit(1);
  if (existing[0]) return existing[0];

  const localPart = normalised.split("@")[0] ?? normalised;
  const [created] = await db
    .insert(usersTable)
    .values({
      id: newId("usr"),
      orgId,
      email: normalised,
      name: localPart,
      role: "buyer",
    })
    .returning();
  if (!created) {
    // Race: another request inserted the row between SELECT and INSERT.
    // Re-read so the caller still gets a valid row instead of throwing.
    const [reread] = await db
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.orgId, orgId), eq(usersTable.email, normalised)))
      .limit(1);
    if (!reread) {
      throw new Error(
        `Failed to upsert user for ${normalised} in org ${orgId}`,
      );
    }
    return reread;
  }
  return created;
}
