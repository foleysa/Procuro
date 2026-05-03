/**
 * Routing resolution tests (task #213).
 *
 * Exercises the public API of `lib/intelligence/routing` against a real
 * Postgres so the SQL syntax + index predicates are validated end to
 * end. Every fixture is namespaced per run for safe concurrent test
 * execution.
 *
 * What's covered:
 *   - normalizeCategoryString — the lookup-key contract
 *   - resolveSynonym — Layer A (tenant-scoped wins, source filter)
 *   - routeTenantCategory — Layer A→B fallthrough enqueues
 *   - enqueueUnmapped — bumps lastSeenAt + accumulates spend
 *   - resolveQueueEntry — collision detection + audit-flag forward only
 *   - leversForCategory / categoriesForLever — view ordering
 *   - determineOpportunityMappedVia — null/unrouted → unmapped_default
 *   - checkRoutingHealth — drift recovery via refresh
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  db,
  pool,
  orgsTable,
  categoriesTable,
  opportunitiesTable,
  analysisCyclesTable,
  synonymRegistryTable,
  unmappedCategoryQueueTable,
  normalizeCategoryString,
} from "@workspace/db";
import { and, eq, like, or } from "drizzle-orm";

import {
  resolveSynonym,
  routeTenantCategory,
  enqueueUnmapped,
  listOpenQueue,
  resolveQueueEntry,
  summarizeQueue,
  countOpportunitiesByMappedVia,
  leversForCategory,
  categoriesForLever,
  determineOpportunityMappedVia,
  checkRoutingHealth,
  getRoutingHealthMetadata,
  bandForCategory,
  bootstrapCategoryLeverMappings,
  bootstrapTrigramSuggestions,
  suggestCategoryMappings,
  ALL_BANDS,
  FALLBACK_BAND,
  isBand,
} from "../src/lib/intelligence/routing";

const RUN = `t213-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

function nid(prefix: string): string {
  return `${prefix}_${RUN}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

let orgA: string;
let orgB: string;

// Isolation strategy (#252 audit): two fresh orgs are minted per file
// run via `nid("org")` (RUN-suffixed UUID) and torn down in `after()`
// alongside opportunities, cycles, categories, and queue rows. All
// synonym/queue fixtures are tagged with RUN-prefixed strings so
// teardown sweeps cleanly. The `summarizeQueue` test only asserts
// `>= 0` (no aggregate-count brittleness), and every other assertion
// keys off RUN-scoped tenant strings or canonical codes the test
// just inserted, so sibling test files cannot contaminate this suite.
before(async () => {
  // Materialized view + triggers must exist before we read from it.
  await bootstrapCategoryLeverMappings();
  // Layer D suggestions need pg_trgm + GIN index on the normalized
  // columns. Idempotent like the materialized view bootstrap.
  await bootstrapTrigramSuggestions();

  orgA = nid("org");
  orgB = nid("org");
  await db.insert(orgsTable).values([
    { id: orgA, slug: `${orgA}-slug`, name: `Org A ${RUN}` },
    { id: orgB, slug: `${orgB}-slug`, name: `Org B ${RUN}` },
  ]);

  // Pre-seed an "Iron & Steel" category for orgA so the cycle.ts-style
  // mappedVia lookup has something to bind to.
  await db.insert(categoriesTable).values({
    id: nid("cat"),
    orgId: orgA,
    code: "IRON_STEEL",
    name: "Iron & Steel",
    class: "direct",
    sourceSystem: "test",
    sourceExternalId: nid("ext"),
  });
});

after(async () => {
  // Tear down everything we created. Order matters: opportunities →
  // categories → orgs (cascade handles synonym/queue rows tied to org).
  await db
    .delete(opportunitiesTable)
    .where(or(eq(opportunitiesTable.orgId, orgA), eq(opportunitiesTable.orgId, orgB)));
  await db
    .delete(analysisCyclesTable)
    .where(or(eq(analysisCyclesTable.orgId, orgA), eq(analysisCyclesTable.orgId, orgB)));
  await db
    .delete(categoriesTable)
    .where(or(eq(categoriesTable.orgId, orgA), eq(categoriesTable.orgId, orgB)));
  // Synonym rows tied to orgA cascade with the org delete; clean
  // global ones we created explicitly.
  await db.delete(synonymRegistryTable).where(like(synonymRegistryTable.id, `syn_${RUN}%`));
  await db
    .delete(unmappedCategoryQueueTable)
    .where(or(
      eq(unmappedCategoryQueueTable.orgId, orgA),
      eq(unmappedCategoryQueueTable.orgId, orgB),
    ));
  await db.delete(orgsTable).where(or(eq(orgsTable.id, orgA), eq(orgsTable.id, orgB)));
});

describe("normalizeCategoryString", () => {
  it("trims, collapses whitespace, lowercases", () => {
    assert.equal(normalizeCategoryString("  Iron & Steel  "), "iron & steel");
    assert.equal(normalizeCategoryString("HOT  ROLLED\tSTEEL"), "hot rolled steel");
    assert.equal(normalizeCategoryString("\u00A0Aluminium"), "aluminium");
  });
  it("is idempotent", () => {
    const a = normalizeCategoryString("  Multi   Spaces ");
    assert.equal(normalizeCategoryString(a), a);
  });
});

describe("bands constants", () => {
  it("FALLBACK_BAND is fragmented", () => {
    assert.equal(FALLBACK_BAND, "fragmented");
  });
  it("isBand narrows correctly", () => {
    for (const b of ALL_BANDS) assert.equal(isBand(b), true);
    assert.equal(isBand("not_a_band"), false);
  });
});

describe("resolveSynonym (Layer A)", () => {
  it("hits the global seed for 'Steel'", async () => {
    const r = await resolveSynonym(orgA, "Steel");
    assert.ok(r);
    assert.equal(r.canonicalCode, "IRON_STEEL");
    assert.equal(r.scope, "global");
    assert.equal(r.mappedVia, "synonym_global");
  });
  it("returns null for unknown strings", async () => {
    const r = await resolveSynonym(orgA, "Unobtainium-9000");
    assert.equal(r, null);
  });
  it("normalizes before lookup", async () => {
    const r = await resolveSynonym(orgA, "  STEEL ");
    assert.ok(r);
    assert.equal(r.canonicalCode, "IRON_STEEL");
  });
  it("tenant-scoped overrides global", async () => {
    // Insert a tenant-scoped synonym that maps "Steel" → LUMBER for orgA only.
    await db.insert(synonymRegistryTable).values({
      id: nid("syn"),
      tenantString: "Steel",
      normalized: "steel",
      canonicalCode: "LUMBER",
      scope: "tenant_scoped",
      orgId: orgA,
      source: "operator",
    });
    const a = await resolveSynonym(orgA, "Steel");
    assert.equal(a?.canonicalCode, "LUMBER");
    assert.equal(a?.scope, "tenant_scoped");
    assert.equal(a?.mappedVia, "synonym_tenant_scoped");
    // orgB still gets the global hit.
    const b = await resolveSynonym(orgB, "Steel");
    assert.equal(b?.canonicalCode, "IRON_STEEL");
    assert.equal(b?.scope, "global");
  });
  it("ignores source = 'auto' rows in v1", async () => {
    const tenantString = `auto-only-${RUN}`;
    await db.insert(synonymRegistryTable).values({
      id: nid("syn"),
      tenantString,
      normalized: normalizeCategoryString(tenantString),
      canonicalCode: "IRON_STEEL",
      scope: "global",
      orgId: null,
      source: "auto",
    });
    const r = await resolveSynonym(orgA, tenantString);
    assert.equal(r, null, "auto-source rows must be ignored in v1");
  });
});

describe("enqueueUnmapped + listOpenQueue", () => {
  it("inserts an open row and bumps spend on conflict", async () => {
    const tenantString = `mystery-${RUN}-A`;
    const first = await enqueueUnmapped({
      orgId: orgA,
      tenantString,
      spendUsd: 1000,
    });
    assert.equal(first.tenantString, tenantString);
    assert.equal(Number(first.spendTrailing90dUsd), 1000);

    const second = await enqueueUnmapped({
      orgId: orgA,
      tenantString,
      spendUsd: 250,
    });
    assert.equal(second.id, first.id, "should upsert open row, not insert");
    assert.equal(Number(second.spendTrailing90dUsd), 1250);

    const open = await listOpenQueue(orgA, 100);
    const found = open.find((r) => r.id === first.id);
    assert.ok(found, "open queue should include the row");
  });
});

describe("routeTenantCategory", () => {
  it("returns synonym hit + band when present", async () => {
    const r = await routeTenantCategory({
      orgId: orgA,
      tenantString: "Aluminum",
    });
    assert.equal(r.matched, true);
    assert.equal(r.canonicalCode, "NONFERROUS_METALS");
    assert.equal(r.mappedVia, "synonym_global");
    // NONFERROUS_METALS is seeded into the indexable band.
    assert.equal(r.band, "indexable");
  });
  it("falls back + enqueues on miss with FALLBACK_BAND", async () => {
    const tenantString = `Widget-cat-${RUN}`;
    const r = await routeTenantCategory({
      orgId: orgA,
      tenantString,
      spendUsd: 500,
    });
    assert.equal(r.matched, false);
    assert.equal(r.canonicalCode, null);
    assert.equal(r.mappedVia, "unmapped_default");
    // Public-API contract: misses must report the fallback band so
    // callers can branch deterministically without re-deriving it.
    assert.equal(r.band, FALLBACK_BAND);

    const open = await listOpenQueue(orgA, 200);
    assert.ok(
      open.some((e) => e.tenantString === tenantString),
      "miss should land in queue",
    );
  });
});

describe("bandForCategory", () => {
  it("returns the canonical category's primary band", async () => {
    assert.equal(await bandForCategory("IRON_STEEL"), "indexable");
    // Spec: TL routes via spot_vs_contract → indexable band.
    assert.equal(await bandForCategory("FREIGHT_TRUCKING_TL"), "indexable");
  });
  it("returns null for unrouted codes", async () => {
    assert.equal(await bandForCategory("__never_seeded__"), null);
  });
});

describe("resolveQueueEntry (Layer C)", () => {
  it("appends a registry row + marks queue resolved + audit-flags historical opps", async () => {
    const tenantString = `Mystery-${RUN}-resolve`;
    // 1. Enqueue.
    const queued = await enqueueUnmapped({
      orgId: orgA,
      tenantString,
      spendUsd: 100,
    });
    // 2. Pre-create an opportunity tagged unmapped_default for the
    // same canonical code so we can prove the audit flag fires.
    const cycleId = nid("cyc");
    await db.insert(analysisCyclesTable).values({
      id: cycleId,
      orgId: orgA,
      generation: 1,
      status: "completed",
      triggeredBy: `test-${RUN}`,
    });
    const [cat] = await db
      .select()
      .from(categoriesTable)
      .where(and(eq(categoriesTable.orgId, orgA), eq(categoriesTable.code, "IRON_STEEL")))
      .limit(1);
    const oppId = nid("opp");
    await db.insert(opportunitiesTable).values({
      id: oppId,
      orgId: orgA,
      cycleId,
      leverId: "sku_price_benchmark",
      tier: 1,
      title: "Pre-resolve fixture",
      rationale: "test",
      recommendedAction: "test",
      categoryId: cat!.id,
      rawProjectedSavingsUsd: "100",
      projectedSavingsUsd: "80",
      confidence: "0.5",
      mappedVia: "unmapped_default",
      // Audit-flag matching keys off this provenance column, NOT
      // category code — historical opps carry the unresolved tenant
      // string, not the eventually-resolved canonical code.
      sourceTenantCategoryString: tenantString,
      inputs: {},
    });

    // 3. Resolve the queue entry → IRON_STEEL global.
    const result = await resolveQueueEntry({
      queueId: queued.id,
      canonicalCode: "IRON_STEEL",
      scope: "global",
      resolvedBy: `op-${RUN}`,
      callerCanWriteGlobal: true,
    });

    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.ok(result.registryId.startsWith("syn_"));
      assert.ok(result.reCategorizedOpportunityCount >= 1);
    }

    // 4. The opportunity keeps its mappedVia (forward-only) but gets
    // the audit flag set.
    const [opp] = await db
      .select()
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, oppId))
      .limit(1);
    assert.equal(opp!.mappedVia, "unmapped_default", "mappedVia is forward-only");
    assert.equal(opp!.reCategorizedAfterPersistence, 1, "audit flag bumped");

    // 5. The synonym now resolves on subsequent calls.
    const r = await resolveSynonym(orgA, tenantString);
    assert.equal(r?.canonicalCode, "IRON_STEEL");
  });

  it("audit-flag scopes to the original tenant string — not category code", async () => {
    // Two different unmapped tenant strings, both pre-routed onto an
    // IRON_STEEL placeholder. Resolving ONE of them must flag only
    // the opp that originated from THAT string. A code-based match
    // would incorrectly flag both because both opps share the same
    // resolved canonical code.
    const stringA = `Mystery-${RUN}-scopeA`;
    const stringB = `Mystery-${RUN}-scopeB`;
    const queuedA = await enqueueUnmapped({ orgId: orgA, tenantString: stringA });
    await enqueueUnmapped({ orgId: orgA, tenantString: stringB });

    const cycleId = nid("cyc");
    await db.insert(analysisCyclesTable).values({
      id: cycleId,
      orgId: orgA,
      // Use a unique generation; the previous resolveQueueEntry test
      // already inserted gen=1 for orgA in this run.
      generation: 2,
      status: "completed",
      triggeredBy: `test-${RUN}-scope`,
    });
    const [cat] = await db
      .select()
      .from(categoriesTable)
      .where(and(eq(categoriesTable.orgId, orgA), eq(categoriesTable.code, "IRON_STEEL")))
      .limit(1);
    const oppAId = nid("opp");
    const oppBId = nid("opp");
    for (const [id, srcStr] of [
      [oppAId, stringA],
      [oppBId, stringB],
    ] as const) {
      await db.insert(opportunitiesTable).values({
        id,
        orgId: orgA,
        cycleId,
        leverId: "sku_price_benchmark",
        tier: 1,
        title: `scope-fixture-${id}`,
        rationale: "test",
        recommendedAction: "test",
        categoryId: cat!.id,
        rawProjectedSavingsUsd: "100",
        projectedSavingsUsd: "80",
        confidence: "0.5",
        mappedVia: "unmapped_default",
        sourceTenantCategoryString: srcStr,
        inputs: {},
      });
    }

    const result = await resolveQueueEntry({
      queueId: queuedA.id,
      canonicalCode: "IRON_STEEL",
      scope: "global",
      resolvedBy: `op-${RUN}`,
      callerCanWriteGlobal: true,
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(
        result.reCategorizedOpportunityCount,
        1,
        "only the opp matching stringA should be flagged",
      );
    }

    const flagged = await db
      .select()
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, oppAId))
      .limit(1);
    const unflagged = await db
      .select()
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, oppBId))
      .limit(1);
    assert.equal(flagged[0]!.reCategorizedAfterPersistence, 1);
    assert.equal(
      unflagged[0]!.reCategorizedAfterPersistence,
      0,
      "stringB-derived opp must NOT be flagged when only stringA was resolved",
    );
  });

  it("returns collision (with existing.registryId) when scope+normalized already mapped", async () => {
    // Try to resolve a fresh queue entry to a string we already mapped.
    const tenantString = `Mystery-${RUN}-collision`;
    const queued = await enqueueUnmapped({
      orgId: orgA,
      tenantString,
    });
    // Pre-insert a global synonym for the same normalized key.
    const existingRegistryId = nid("syn");
    await db.insert(synonymRegistryTable).values({
      id: existingRegistryId,
      tenantString,
      normalized: normalizeCategoryString(tenantString),
      canonicalCode: "LUMBER",
      scope: "global",
      orgId: null,
      source: "operator",
    });
    const result = await resolveQueueEntry({
      queueId: queued.id,
      canonicalCode: "IRON_STEEL",
      scope: "global",
      resolvedBy: `op-${RUN}`,
      callerCanWriteGlobal: true,
    });
    assert.equal(result.kind, "collision");
    if (result.kind === "collision") {
      assert.equal(result.existing.canonicalCode, "LUMBER");
      assert.equal(result.existing.scope, "global");
      assert.equal(result.existing.registryId, existingRegistryId);
    }
  });

  it("decision='accept_existing' closes queue without writing a new row", async () => {
    const tenantString = `Mystery-${RUN}-accept`;
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    await db.insert(synonymRegistryTable).values({
      id: nid("syn"),
      tenantString,
      normalized: normalizeCategoryString(tenantString),
      canonicalCode: "LUMBER",
      scope: "global",
      orgId: null,
      source: "operator",
    });
    const before = await db
      .select()
      .from(synonymRegistryTable)
      .where(eq(synonymRegistryTable.normalized, normalizeCategoryString(tenantString)));
    const result = await resolveQueueEntry({
      queueId: queued.id,
      canonicalCode: "IRON_STEEL",
      scope: "global",
      resolvedBy: `op-${RUN}`,
      callerCanWriteGlobal: true,
      decision: "accept_existing",
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.collisionDecision, "accept_existing");
    }
    const after = await db
      .select()
      .from(synonymRegistryTable)
      .where(eq(synonymRegistryTable.normalized, normalizeCategoryString(tenantString)));
    assert.equal(after.length, before.length, "must not append a new registry row");
    // Resolver still answers with the existing canonical code.
    const r = await resolveSynonym(orgA, tenantString);
    assert.equal(r?.canonicalCode, "LUMBER");
  });

  it("decision='force_override' is append-only: stamps superseded_at on the old row + writes a new active one", async () => {
    const tenantString = `Mystery-${RUN}-override`;
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    const oldRegistryId = nid("syn");
    await db.insert(synonymRegistryTable).values({
      id: oldRegistryId,
      tenantString,
      normalized: normalizeCategoryString(tenantString),
      canonicalCode: "LUMBER",
      scope: "global",
      orgId: null,
      source: "operator",
    });
    const result = await resolveQueueEntry({
      queueId: queued.id,
      canonicalCode: "IRON_STEEL",
      scope: "global",
      resolvedBy: `op-${RUN}`,
      callerCanWriteGlobal: true,
      decision: "force_override",
    });
    assert.equal(result.kind, "ok");
    let newRegistryId = "";
    if (result.kind === "ok") {
      assert.equal(result.collisionDecision, "force_override");
      newRegistryId = result.registryId;
      assert.notEqual(newRegistryId, oldRegistryId, "must write a new row, never UPDATE in place");
    }
    // Append-only invariant: the OLD row still exists, with the
    // original canonical_code preserved as audit trail, and is
    // marked superseded.
    const [oldRow] = await db
      .select()
      .from(synonymRegistryTable)
      .where(eq(synonymRegistryTable.id, oldRegistryId));
    assert.ok(oldRow, "old row must still exist as audit history");
    assert.equal(oldRow!.canonicalCode, "LUMBER", "old canonical_code must NOT be UPDATEd");
    assert.ok(oldRow!.supersededAt, "old row must be stamped superseded_at");
    assert.equal(
      oldRow!.supersededByRegistryId,
      newRegistryId,
      "old row must point at the row that retired it",
    );
    // The new row is active and now wins resolution.
    const r = await resolveSynonym(orgA, tenantString);
    assert.equal(r?.canonicalCode, "IRON_STEEL");
  });

  it("decision='escalate_to_global' writes a global row alongside the tenant one", async () => {
    const tenantString = `Mystery-${RUN}-escalate`;
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    // Pre-existing tenant-scoped row to collide with.
    await db.insert(synonymRegistryTable).values({
      id: nid("syn"),
      tenantString,
      normalized: normalizeCategoryString(tenantString),
      canonicalCode: "LUMBER",
      scope: "tenant_scoped",
      orgId: orgA,
      source: "operator",
    });
    const result = await resolveQueueEntry({
      queueId: queued.id,
      canonicalCode: "IRON_STEEL",
      scope: "tenant_scoped",
      resolvedBy: `op-${RUN}`,
      callerCanWriteGlobal: true,
      decision: "escalate_to_global",
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.collisionDecision, "escalate_to_global");
    }
    // Tenant-scoped wins for orgA, but orgB now sees the new global row.
    const a = await resolveSynonym(orgA, tenantString);
    assert.equal(a?.canonicalCode, "LUMBER");
    assert.equal(a?.scope, "tenant_scoped");
    const b = await resolveSynonym(orgB, tenantString);
    assert.equal(b?.canonicalCode, "IRON_STEEL");
    assert.equal(b?.scope, "global");
  });

  it("decision='narrow_to_tenant' writes a tenant row that wins for that org only", async () => {
    const tenantString = `Mystery-${RUN}-narrow`;
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    // Pre-existing global row to collide with.
    await db.insert(synonymRegistryTable).values({
      id: nid("syn"),
      tenantString,
      normalized: normalizeCategoryString(tenantString),
      canonicalCode: "LUMBER",
      scope: "global",
      orgId: null,
      source: "operator",
    });
    const result = await resolveQueueEntry({
      queueId: queued.id,
      canonicalCode: "IRON_STEEL",
      scope: "global",
      resolvedBy: `op-${RUN}`,
      callerCanWriteGlobal: true,
      decision: "narrow_to_tenant",
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.collisionDecision, "narrow_to_tenant");
    }
    // orgA now picks up the tenant override; orgB still sees the global.
    const a = await resolveSynonym(orgA, tenantString);
    assert.equal(a?.canonicalCode, "IRON_STEEL");
    assert.equal(a?.scope, "tenant_scoped");
    const b = await resolveSynonym(orgB, tenantString);
    assert.equal(b?.canonicalCode, "LUMBER");
    assert.equal(b?.scope, "global");
  });

  it("rejects scope='global' when callerCanWriteGlobal is false", async () => {
    // Round-7 security gate: an org admin (no platform_admin role)
    // must NOT be able to create a global synonym row that would
    // affect every tenant. The route layer derives this flag from
    // RBAC; the resolver must enforce it at the data layer too.
    const tenantString = `Mystery-${RUN}-org-cant-write-global`;
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    await assert.rejects(
      resolveQueueEntry({
        queueId: queued.id,
        canonicalCode: "IRON_STEEL",
        scope: "global",
        resolvedBy: `op-${RUN}`,
        callerCanWriteGlobal: false,
      }),
      /forbidden.*platform admin/,
    );
  });

  it("rejects force_override of a global row when callerCanWriteGlobal is false", async () => {
    // Even with scope='tenant_scoped' on the request, the caller
    // must not be allowed to supersede an existing GLOBAL row via
    // force_override — that would silently rewrite routing for
    // every tenant that relies on the global mapping.
    const tenantString = `Mystery-${RUN}-org-cant-override-global`;
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    await db.insert(synonymRegistryTable).values({
      id: nid("syn"),
      tenantString,
      normalized: normalizeCategoryString(tenantString),
      canonicalCode: "LUMBER",
      scope: "global",
      orgId: null,
      source: "operator",
    });
    await assert.rejects(
      resolveQueueEntry({
        queueId: queued.id,
        canonicalCode: "IRON_STEEL",
        scope: "tenant_scoped",
        resolvedBy: `op-${RUN}`,
        callerCanWriteGlobal: false,
        decision: "force_override",
      }),
      /forbidden.*platform admin/,
    );
  });

  it("decision='escalate_to_global' is rejected when the original request was global", async () => {
    const tenantString = `Mystery-${RUN}-escalate-bad`;
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    await db.insert(synonymRegistryTable).values({
      id: nid("syn"),
      tenantString,
      normalized: normalizeCategoryString(tenantString),
      canonicalCode: "LUMBER",
      scope: "global",
      orgId: null,
      source: "operator",
    });
    await assert.rejects(
      resolveQueueEntry({
        queueId: queued.id,
        canonicalCode: "IRON_STEEL",
        scope: "global",
        resolvedBy: `op-${RUN}`,
        callerCanWriteGlobal: true,
        decision: "escalate_to_global",
      }),
      /escalate_to_global/,
    );
  });
});

describe("suggestCategoryMappings (Layer D)", () => {
  it("ranks an obvious near-match against an existing global synonym at the top", async () => {
    // 'Steel' maps globally to IRON_STEEL via the seed; a queued
    // misspelling should surface IRON_STEEL as the strongest pick.
    // Use a string close enough to the seeded "steel" synonym that
    // trigram similarity clears the 0.25 floor without being an exact
    // match (which would short-circuit through Layer A and never have
    // landed in the queue in the first place).
    const tenantString = `Stainless Steel ${RUN}`;
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    const m = await suggestCategoryMappings({
      orgId: orgA,
      queueIds: [queued.id],
    });
    const list = m.get(queued.id) ?? [];
    assert.ok(list.length > 0, "should produce at least one suggestion");
    assert.equal(
      list[0]!.canonicalCode,
      "IRON_STEEL",
      "top suggestion should be the canonical code of the closest synonym",
    );
    assert.ok(
      list[0]!.confidence > 0.25 && list[0]!.confidence <= 1,
      "confidence should be in the public (minSim, 1] range",
    );
    assert.ok(list.length <= 3, "default topN must cap at 3");
  });

  it("boosts a cross-tenant operator-vouched mapping over a weaker global one", async () => {
    // Another tenant (orgB) already mapped this exact normalized
    // string to LUMBER. orgA's queue entry should see LUMBER ranked
    // ahead of any weaker code-spelling match — the operator vouch
    // from another tenant is a stronger signal than canonical-code
    // similarity alone.
    const tenantString = `Acme-Forest-Products-${RUN}`;
    await db.insert(synonymRegistryTable).values({
      id: nid("syn"),
      tenantString,
      normalized: normalizeCategoryString(tenantString),
      canonicalCode: "LUMBER",
      scope: "tenant_scoped",
      orgId: orgB,
      source: "operator",
    });
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    const m = await suggestCategoryMappings({
      orgId: orgA,
      queueIds: [queued.id],
    });
    const list = m.get(queued.id) ?? [];
    assert.ok(list.length > 0);
    assert.equal(list[0]!.canonicalCode, "LUMBER");
    assert.equal(
      list[0]!.reason,
      "cross_tenant_synonym",
      "evidence reason must surface that this came from another tenant",
    );
  });

  it("ignores source='auto' rows when ranking suggestions", async () => {
    // Auto-source rows are reserved for v2 — they must NOT propagate
    // through the operator UI as if they were already approved
    // mappings. Mirrors the Layer A resolver's filter.
    const tenantString = `Phantom-${RUN}-auto`;
    await db.insert(synonymRegistryTable).values({
      id: nid("syn"),
      tenantString,
      normalized: normalizeCategoryString(tenantString),
      canonicalCode: "LUMBER",
      scope: "global",
      orgId: null,
      source: "auto",
    });
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    const m = await suggestCategoryMappings({
      orgId: orgA,
      queueIds: [queued.id],
    });
    const list = m.get(queued.id) ?? [];
    // The auto row must not contribute LUMBER as a synonym match.
    // (LUMBER could still appear if its canonical_code spelling
    // happens to be similar to the tenant string, but the test
    // string is deliberately unrelated, so the list should be
    // either empty or contain only canonical_code_match entries —
    // none with reason='global_synonym'.)
    for (const s of list) {
      assert.notEqual(
        s.reason,
        "global_synonym",
        "auto-source synonym rows must not produce global_synonym suggestions",
      );
    }
  });

  it("returns an empty map for an empty input batch", async () => {
    const m = await suggestCategoryMappings({ orgId: orgA, queueIds: [] });
    assert.equal(m.size, 0);
  });

  it("respects topN to cap suggestions per queue entry", async () => {
    const tenantString = `Steel-${RUN}-cap`;
    const queued = await enqueueUnmapped({ orgId: orgA, tenantString });
    const m = await suggestCategoryMappings({
      orgId: orgA,
      queueIds: [queued.id],
      topN: 1,
    });
    const list = m.get(queued.id) ?? [];
    assert.ok(list.length <= 1);
  });
});

describe("leversForCategory + categoriesForLever (materialized view)", () => {
  it("returns the seeded levers for IRON_STEEL across both bands", async () => {
    // IRON_STEEL has dual-band coverage (indexable + concentrated) so
    // the materialized view legitimately returns lever rows from BOTH
    // bands. Indexable still anchors the routing because it carries
    // the higher confidence_weight.
    const rows = await leversForCategory("IRON_STEEL");
    assert.ok(rows.length > 0, "IRON_STEEL should route to applicable levers");
    const ids = rows.map((r) => r.leverId);
    assert.ok(ids.includes("index_based_pricing"));
    const bands = new Set(rows.map((r) => r.band));
    assert.ok(bands.has("indexable"), "indexable band must be present");
    assert.ok(bands.has("concentrated"), "concentrated band must be present");
  });
  it("returns rank-1 categories for index_based_pricing", async () => {
    const rows = await categoriesForLever("index_based_pricing");
    const codes = rows.map((r) => r.categoryCode);
    assert.ok(codes.includes("IRON_STEEL"));
    assert.ok(codes.includes("PLASTIC_RESINS"));
  });
  it("routes FREIGHT_TRUCKING_TL to spot_vs_contract per spec", async () => {
    // Spec done-condition: TL freight auto-routes to spot_vs_contract
    // (DAT/spot indices live in the indexable band). TL also carries
    // a concentrated-band membership so the lever set spans both
    // bands; the contract is that spot_vs_contract IS reachable in the
    // indexable band specifically.
    const rows = await leversForCategory("FREIGHT_TRUCKING_TL");
    const ids = rows.map((r) => r.leverId);
    assert.ok(
      ids.includes("spot_vs_contract"),
      "FREIGHT_TRUCKING_TL must route to spot_vs_contract",
    );
    const spot = rows.find((r) => r.leverId === "spot_vs_contract");
    assert.equal(
      spot?.band,
      "indexable",
      "spot_vs_contract must come from the indexable band",
    );
  });
});

describe("determineOpportunityMappedVia", () => {
  it("returns unmapped_default for null/empty/unknown codes", async () => {
    assert.equal(await determineOpportunityMappedVia(null), "unmapped_default");
    assert.equal(await determineOpportunityMappedVia(""), "unmapped_default");
    assert.equal(
      await determineOpportunityMappedVia("__never_seeded__"),
      "unmapped_default",
    );
  });
  it("returns synonym_global for routed canonical codes", async () => {
    assert.equal(
      await determineOpportunityMappedVia("IRON_STEEL"),
      "synonym_global",
    );
  });
});

describe("summarizeQueue + countOpportunitiesByMappedVia", () => {
  it("emits non-negative counts", async () => {
    const summary = await summarizeQueue(orgA);
    assert.ok(summary.openCount >= 0);
    assert.ok(summary.unmappedSpendUsd >= 0);
    const byVia = await countOpportunitiesByMappedVia(orgA);
    for (const v of Object.values(byVia)) assert.ok(v >= 0);
  });
});

describe("checkRoutingHealth", () => {
  it("reports ok=true and empty driftSamples when truth table and view agree", async () => {
    const report = await checkRoutingHealth();
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.expectedRowCount, report.viewRowCount);
    assert.deepEqual(report.driftSamples, []);
    assert.equal(report.consecutiveFailures, 0);
    assert.ok(report.lastSuccessAt);
    // Cross-check the metadata accessor mirrors the report.
    const meta = getRoutingHealthMetadata();
    assert.equal(meta.lastSuccessAt, report.lastSuccessAt);
    assert.equal(meta.consecutiveFailures, 0);
  });

  it("detects equal-row-count drift via row-by-row confidence_weight comparison", async () => {
    // Spec: triggers fire on INSERT/DELETE only. A `confidence_weight`
    // UPDATE on a truth-table row leaves both the joined row count
    // AND the row identity tuple identical, but the view's value is
    // now stale. A pure count-based health check can never see this.
    // The row-by-row scan must surface a `weight_mismatch` drift
    // sample, and the scheduled `refreshFirst` path must recover.
    const targetCode = "IRON_STEEL";
    const targetBand = "indexable";
    const original = 1.0;
    const drifted = 0.42;
    try {
      // Mutate truth table — UPDATEs do NOT fire the trigger, so the
      // view remains at its pre-mutation value (`original`).
      await pool.query(
        `UPDATE category_bands SET confidence_weight = $1
           WHERE category_code = $2 AND band = $3`,
        [drifted, targetCode, targetBand],
      );

      // Inspect drift WITHOUT the auto-refresh recovery so we can
      // assert the scan really sees the value mismatch.
      const stale = await checkRoutingHealth({ autoRefreshOnDrift: false });
      assert.equal(
        stale.expectedRowCount,
        stale.viewRowCount,
        "row counts should still match — only the value differs",
      );
      assert.ok(
        stale.drift > 0,
        "row-by-row scan must report drift even when counts match",
      );
      const sides = new Set(stale.driftSamples.map((s) => s.side));
      assert.ok(
        sides.has("weight_mismatch"),
        `expected weight_mismatch sample, got sides=${[...sides].join(",")}`,
      );
      const sample = stale.driftSamples.find(
        (s) =>
          s.side === "weight_mismatch" && s.categoryCode === targetCode,
      );
      assert.ok(sample, "the drifted row must appear in samples");
      // `confidence_weight` is a Postgres `real` (float4); JS reads it
      // back as a float64 with ~1e-7 precision loss. Compare with a
      // tolerance rather than strict equality.
      const close = (a: number | null, b: number) =>
        a !== null && Math.abs(a - b) < 1e-5;
      assert.ok(
        close(sample!.expectedConfidenceWeight, drifted),
        `expected ≈${drifted}, got ${sample!.expectedConfidenceWeight}`,
      );
      assert.ok(
        close(sample!.viewConfidenceWeight, original),
        `view ≈${original}, got ${sample!.viewConfidenceWeight}`,
      );

      // The scheduled handler path (`refreshFirst: true`) must recover
      // even with auto-refresh-on-drift disabled — the up-front
      // refresh absorbs the staleness.
      const recovered = await checkRoutingHealth({
        refreshFirst: true,
        autoRefreshOnDrift: false,
      });
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      assert.equal(recovered.drift, 0);
    } finally {
      // Restore truth table + view so other tests see clean fixture.
      await pool.query(
        `UPDATE category_bands SET confidence_weight = $1
           WHERE category_code = $2 AND band = $3`,
        [original, targetCode, targetBand],
      );
      await pool.query(
        "REFRESH MATERIALIZED VIEW v_category_lever_mappings",
      );
    }
  });
});
