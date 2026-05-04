import { pool } from "@workspace/db";

const TABLES_TO_TRUNCATE = [
  "time_entries",
  "rate_card_lines",
  "rate_cards",
  "sow_change_orders",
  "sow_milestones",
  "statements_of_work",
  "defense_pack_outcomes",
  "defense_packs",
  "decisions",
  "opportunity_stage_history",
  "opportunities",
  "analysis_cycles",
  "funnel_annotations",
  "funnel_snapshot_failures",
  "funnel_snapshots",
  "learned_priors",
  "contract_items",
  "contract_audit_log",
  "contracts",
  "po_lines",
  "purchase_orders",
  "payments",
  "invoices",
  "shipments",
  "raw_material_usage",
  "items",
  "watched_suppliers",
  "watched_issuers",
  "watchlist_members",
  "watchlists",
  "supplier_audit_log",
  "suppliers",
  "categories",
  "market_signals",
  "market_signal_schema_drift",
  "alert_deliveries",
  "alert_events",
  "alert_rules",
  "alert_subscriptions",
  "alert_channels",
  "alerts",
  "escalation_policies",
  "csv_ingest_metrics",
  "entity_resolution_cache",
  "erp_sync_runs",
  "erp_connections",
  "jobs",
  "data_integrity_audit_log",
  "admin_audit_log",
  "org_settings_audit_log",
  "org_api_tokens",
  "api_keys",
  "scim_group_members",
  "scim_groups",
  "user_roles",
  "users",
  "onboarding_state",
  "unmapped_category_queue",
  "collector_tenant_opt_ins",
  "collector_audit_log",
];

const PRESERVED_TABLES = [
  "lever_bands",
  "category_bands",
  "synonym_registry",
  "app_settings",
  "job_kind_settings",
  "methods_and_tools",
  "category_lever_prior_scales",
  "exclusion_rules",
  "collectors",
];

async function main(): Promise<void> {
  console.log("[clear-data] snapshotting preserved table counts…");
  const before: Record<string, number> = {};
  for (const table of PRESERVED_TABLES) {
    const res = await pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
    before[table] = res.rows[0].n;
  }

  console.log("[clear-data] truncating business-data tables…");
  const tableList = TABLES_TO_TRUNCATE.join(", ");
  await pool.query(`TRUNCATE ${tableList} CASCADE`);
  console.log(
    `[clear-data] truncated ${TABLES_TO_TRUNCATE.length} tables (CASCADE)`,
  );

  console.log("[clear-data] deleting all orgs…");
  const delResult = await pool.query(`DELETE FROM orgs`);
  console.log(
    `[clear-data] deleted ${delResult.rowCount} org(s) (ON DELETE CASCADE removes org-scoped config rows)`,
  );

  console.log("[clear-data] verifying preserved system-config tables…");
  for (const table of PRESERVED_TABLES) {
    const res = await pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
    const after = res.rows[0].n;
    const note =
      after < before[table]
        ? ` (was ${before[table]}, org-scoped rows removed by cascade)`
        : "";
    console.log(`[clear-data]   ${table}: ${after} rows${note}`);
  }

  console.log("[clear-data] done");
}

main()
  .catch((err) => {
    console.error("[clear-data] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
