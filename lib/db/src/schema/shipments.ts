import {
  pgTable,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { orgsTable } from "./orgs";
import { suppliersTable } from "./suppliers";
import { purchaseOrdersTable } from "./purchaseOrders";

export const freightModeValues = [
  "ocean",
  "air",
  "ltl",
  "tl",
  "parcel",
  "rail",
] as const;
export type FreightMode = (typeof freightModeValues)[number];

export const shipmentsTable = pgTable(
  "shipments",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    poId: text("po_id").references(() => purchaseOrdersTable.id, {
      onDelete: "set null",
    }),
    supplierId: text("supplier_id").references(() => suppliersTable.id, {
      onDelete: "set null",
    }),
    carrier: text("carrier").notNull(),
    mode: text("mode").$type<FreightMode>().notNull(),
    originCountry: text("origin_country"),
    destCountry: text("dest_country"),
    laneKey: text("lane_key").notNull(),
    weightKg: numeric("weight_kg", { precision: 14, scale: 2 }),
    freightCostUsd: numeric("freight_cost_usd", {
      precision: 14,
      scale: 2,
    }).notNull(),
    incoterms: text("incoterms"),
    shipDate: timestamp("ship_date", { withTimezone: true }).notNull(),
    sourceSystem: text("source_system").notNull().default("seed"),
    sourceExternalId: text("source_external_id"),
    sourceSyncedAt: timestamp("source_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("shipments_org_idx").on(t.orgId),
    index("shipments_lane_idx").on(t.orgId, t.laneKey),
    index("shipments_carrier_idx").on(t.orgId, t.carrier),
    index("shipments_po_fk_idx").on(t.poId),
    index("shipments_supplier_fk_idx").on(t.supplierId),
    uniqueIndex("shipments_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type ShipmentRow = typeof shipmentsTable.$inferSelect;
export type InsertShipmentRow = typeof shipmentsTable.$inferInsert;

export const rawMaterialUsageTable = pgTable(
  "raw_material_usage",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgsTable.id, { onDelete: "cascade" }),
    materialCode: text("material_code").notNull(),
    materialName: text("material_name").notNull(),
    /** e.g. LME copper -> "LME_COPPER", oil -> "BRENT", steel -> "HRC_STEEL" */
    referenceIndex: text("reference_index"),
    qty: numeric("qty", { precision: 16, scale: 4 }).notNull(),
    uom: text("uom").notNull(),
    unitCostUsd: numeric("unit_cost_usd", { precision: 14, scale: 4 }).notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    sourceSystem: text("source_system").notNull().default("seed"),
    sourceExternalId: text("source_external_id"),
    sourceSyncedAt: timestamp("source_synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("raw_material_usage_org_idx").on(t.orgId),
    index("raw_material_usage_material_idx").on(t.orgId, t.materialCode),
    uniqueIndex("raw_material_usage_source_uq").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
  ],
);

export type RawMaterialUsageRow = typeof rawMaterialUsageTable.$inferSelect;
export type InsertRawMaterialUsageRow =
  typeof rawMaterialUsageTable.$inferInsert;
