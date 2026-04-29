import type { Request, Response, NextFunction } from "express";
import { db, orgsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      orgId: string;
    }
  }
}

const HEADER = "x-org-id";

export async function orgContext(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const headerVal = req.header(HEADER);

  let orgId = typeof headerVal === "string" ? headerVal.trim() : "";

  if (!orgId) {
    // Dev-friendly fallback: pick the first org so the dashboard works
    // before the client has stored an active org. Production callers
    // MUST send the header explicitly.
    if (process.env.NODE_ENV !== "production") {
      const [first] = await db
        .select({ id: orgsTable.id })
        .from(orgsTable)
        .limit(1);
      if (first) {
        orgId = first.id;
      }
    }
  }

  if (!orgId) {
    res
      .status(400)
      .json({ error: "Missing org context. Provide x-org-id header." });
    return;
  }

  const [exists] = await db
    .select({ id: orgsTable.id })
    .from(orgsTable)
    .where(eq(orgsTable.id, orgId))
    .limit(1);

  if (!exists) {
    res.status(403).json({ error: "Unknown or inaccessible org." });
    return;
  }

  req.orgId = orgId;
  next();
}
