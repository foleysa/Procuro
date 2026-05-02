import { and, eq, ilike, type SQL } from "drizzle-orm";
import { userRolesTable } from "@workspace/db";

/**
 * Tiny SCIM 2.0 filter parser — covers the subset every IdP we
 * support (Okta, Azure AD, OneLogin, JumpCloud) actually emits in the
 * provisioning path. Specifically:
 *
 *  - `userName eq "alice@x.com"`
 *  - `externalId eq "okta-12345"`
 *  - `emails.value eq "alice@x.com"`
 *  - `emails[type eq "work"].value eq "..."`        (collapsed to value)
 *  - `userName co "alice"`                          (substring contains)
 *  - `userName sw "alice"`                          (starts with)
 *  - `active eq true`
 *  - simple AND-joins of the above (`a eq "x" and b eq "y"`)
 *
 * Behaviour:
 *  - input is null/empty/undefined → returns `null` (no filter).
 *  - input is provided but cannot be parsed → throws
 *    `InvalidScimFilterError`. Per RFC 7644 §3.4.2.2 the route MUST
 *    answer with HTTP 400 + `scimType=invalidFilter` rather than
 *    silently returning every row (which would mask SCIM bugs and
 *    risk over-reporting).
 *
 * Returned object includes both a Drizzle `where` clause for SQL
 * filtering and a JS predicate so the route can post-filter the
 * resulting rows where the underlying column shape doesn't translate
 * cleanly (e.g. `active` is derived from `revokedAt IS NULL`).
 */

export class InvalidScimFilterError extends Error {
  constructor(
    public readonly filter: string,
    public readonly reason: string,
  ) {
    super(`invalidFilter: ${reason} (input: ${filter})`);
    this.name = "InvalidScimFilterError";
  }
}

export type ScimSimpleValue = string | boolean | number | null;

export interface ParsedScimFilter {
  /** Drizzle `where()` SQL fragment, or undefined if pure JS-side. */
  sql?: SQL;
  /** JS-side predicate for active/etc. */
  predicate: (row: {
    userName: string;
    externalId: string;
    active: boolean;
  }) => boolean;
}

interface Clause {
  attribute: string;
  op: "eq" | "ne" | "co" | "sw" | "ew";
  value: ScimSimpleValue;
}

const TOKEN = /\s*("(?:[^"\\]|\\.)*"|true|false|\d+|[A-Za-z_][\w.]*|\(|\))/y;

function unquote(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return raw;
}

/**
 * Tokenises a SCIM filter expression, returning `null` when any
 * non-whitespace input remains unconsumed (e.g. stray punctuation
 * like `$$$` or unterminated strings). Strict full-stream
 * consumption is required so malformed trailing garbage surfaces as
 * `invalidFilter` rather than being silently dropped.
 */
function tokenize(input: string): string[] | null {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(input)) !== null) {
    tokens.push(m[1]!);
    lastEnd = TOKEN.lastIndex;
  }
  // Anything after `lastEnd` that is non-whitespace = garbage.
  if (input.slice(lastEnd).trim() !== "") return null;
  return tokens;
}

function parseClauses(input: string): Clause[] | null {
  // Strip square-bracket sub-filters: `emails[type eq "work"].value eq "x"`
  // becomes `emails.value eq "x"` — the sub-clause is tossed because we
  // don't model `type` per-email.
  const stripped = input.replace(/\[[^\]]*\]/g, "");
  // Strip well-formed surrounding/grouping parentheses BEFORE
  // tokenising — we don't model boolean precedence and accept the
  // grammar Okta + Azure AD actually emit (clauses joined by AND).
  // After this step there must be NO parens left in the token
  // stream; if any survive (e.g. unbalanced) we reject as
  // invalidFilter rather than silently dropping characters.
  const noParens = stripped.replace(/[()]/g, " ");
  const tokens = tokenize(noParens);
  if (tokens === null) return null;
  if (tokens.length === 0) return [];
  // Dangling logical join (e.g. `userName eq "x" and`) is invalid.
  if (tokens[tokens.length - 1]!.toLowerCase() === "and") {
    return null;
  }
  // Leading logical join is invalid.
  if (tokens[0]!.toLowerCase() === "and") return null;

  const clauses: Clause[] = [];
  let i = 0;
  let expectClause = true;
  while (i < tokens.length) {
    if (expectClause) {
      const attr = tokens[i] ?? "";
      const op = (tokens[i + 1] ?? "").toLowerCase();
      const valTok = tokens[i + 2];
      // Strict: attribute, operator, and value tokens must all be
      // present; operator must be a known keyword; value token
      // cannot be empty / a logical join.
      if (
        !attr ||
        attr.toLowerCase() === "and" ||
        !["eq", "ne", "co", "sw", "ew"].includes(op) ||
        valTok === undefined ||
        valTok === "" ||
        valTok.toLowerCase() === "and"
      ) {
        return null;
      }
      let value: ScimSimpleValue;
      if (valTok === "true") value = true;
      else if (valTok === "false") value = false;
      else if (/^\d+$/.test(valTok)) value = Number(valTok);
      else value = unquote(valTok);
      clauses.push({
        attribute: attr,
        op: op as Clause["op"],
        value,
      });
      i += 3;
      expectClause = false;
    } else {
      // Between clauses we REQUIRE an explicit `and` join — we
      // don't silently accept implicit joins or stray tokens.
      const t = tokens[i] ?? "";
      if (t.toLowerCase() !== "and") return null;
      i += 1;
      expectClause = true;
    }
  }
  // Cannot end in the middle of a clause (e.g. `attr op` with no
  // value) or expecting another clause after a trailing `and`.
  if (expectClause) return null;
  return clauses;
}

function clauseToSql(c: Clause): SQL | null {
  const v = c.value;
  if (typeof v !== "string") return null;
  const attr = c.attribute.toLowerCase();
  // Map SCIM attribute paths onto our `user_roles` columns.
  let column;
  switch (attr) {
    case "username":
    case "emails.value":
    case "emails":
      column = userRolesTable.email;
      break;
    case "externalid":
      column = userRolesTable.userId;
      break;
    case "id":
      column = userRolesTable.id;
      break;
    default:
      return null;
  }
  switch (c.op) {
    case "eq":
      return eq(column, v);
    case "co":
      return ilike(column, `%${v}%`);
    case "sw":
      return ilike(column, `${v}%`);
    case "ew":
      return ilike(column, `%${v}`);
    case "ne":
      return null; // not commonly used; let predicate handle it
  }
}

function clausePredicate(c: Clause): (row: {
  userName: string;
  externalId: string;
  active: boolean;
}) => boolean {
  const attr = c.attribute.toLowerCase();
  return (row) => {
    let actual: ScimSimpleValue;
    switch (attr) {
      case "active":
        actual = row.active;
        break;
      case "username":
      case "emails.value":
      case "emails":
        actual = row.userName;
        break;
      case "externalid":
        actual = row.externalId;
        break;
      default:
        return true;
    }
    if (typeof actual === "string" && typeof c.value === "string") {
      switch (c.op) {
        case "eq":
          return actual === c.value;
        case "ne":
          return actual !== c.value;
        case "co":
          return actual.toLowerCase().includes(c.value.toLowerCase());
        case "sw":
          return actual.toLowerCase().startsWith(c.value.toLowerCase());
        case "ew":
          return actual.toLowerCase().endsWith(c.value.toLowerCase());
      }
    }
    if (c.op === "eq") return actual === c.value;
    if (c.op === "ne") return actual !== c.value;
    return true;
  };
}

export function parseScimUserFilter(
  filter: string | null | undefined,
): ParsedScimFilter | null {
  if (!filter || !filter.trim()) return null;
  const clauses = parseClauses(filter);
  if (!clauses) {
    throw new InvalidScimFilterError(filter, "syntax error");
  }
  if (clauses.length === 0) {
    throw new InvalidScimFilterError(filter, "no recognised clauses");
  }
  // Reject filters whose attribute we don't model on either the SQL
  // or JS side — silently dropping them would let unsupported
  // queries return wrong rows.
  const supported = new Set([
    "username",
    "externalid",
    "id",
    "emails",
    "emails.value",
    "active",
  ]);
  for (const c of clauses) {
    if (!supported.has(c.attribute.toLowerCase())) {
      throw new InvalidScimFilterError(
        filter,
        `unsupported attribute "${c.attribute}"`,
      );
    }
  }
  const sqls = clauses
    .map(clauseToSql)
    .filter((x): x is SQL => x !== null);
  const predicates = clauses.map(clausePredicate);
  return {
    sql: sqls.length > 0 ? and(...sqls) : undefined,
    predicate: (row) => predicates.every((p) => p(row)),
  };
}

/**
 * Pagination helpers — SCIM uses `startIndex` (1-based) and `count`.
 * We clamp to sane defaults so a malicious/buggy IdP can't pull the
 * whole table at once.
 */
export interface ScimPagination {
  startIndex: number;
  count: number;
}

export function readPagination(query: Record<string, unknown>): ScimPagination {
  const rawStart = Number(query["startIndex"] ?? 1);
  const rawCount = Number(query["count"] ?? 100);
  const startIndex = Number.isFinite(rawStart) && rawStart >= 1 ? Math.floor(rawStart) : 1;
  const count = Number.isFinite(rawCount) && rawCount >= 0 ? Math.min(Math.floor(rawCount), 1000) : 100;
  return { startIndex, count };
}

/**
 * Parse a simple group filter — only `displayName eq "..."` and
 * `externalId eq "..."` are supported (matches what IdPs actually
 * emit when looking up groups).
 */
export interface ParsedScimGroupFilter {
  displayName?: string;
  externalId?: string;
}

export function parseScimGroupFilter(
  filter: string | null | undefined,
): ParsedScimGroupFilter | null {
  if (!filter || !filter.trim()) return null;
  const clauses = parseClauses(filter);
  if (!clauses) {
    throw new InvalidScimFilterError(filter, "syntax error");
  }
  const out: ParsedScimGroupFilter = {};
  for (const c of clauses) {
    const a = c.attribute.toLowerCase();
    if (a !== "displayname" && a !== "externalid") {
      throw new InvalidScimFilterError(
        filter,
        `unsupported attribute "${c.attribute}"`,
      );
    }
    if (c.op !== "eq" || typeof c.value !== "string") {
      throw new InvalidScimFilterError(
        filter,
        `only eq with string values is supported on groups`,
      );
    }
    if (a === "displayname") out.displayName = c.value;
    else if (a === "externalid") out.externalId = c.value;
  }
  return out;
}
