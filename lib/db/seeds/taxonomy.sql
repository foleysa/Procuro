-- ============================================================================
-- Bands routing model + 4-layer category resolution (task #213) — seed.
-- ============================================================================
--
-- This file is the single bootstrap source for:
--
--   1. `lever_bands`     — every canonical lever's band assignment(s)
--   2. `category_bands`  — every canonical procurement code's band(s)
--   3. `synonym_registry` (scope = 'global') — common tenant strings →
--                          canonical category codes
--
-- Idempotency: every INSERT uses `ON CONFLICT DO NOTHING` against the
-- relevant unique key. Re-running this seed is a no-op once the rows
-- already exist.
--
-- LeverId reconciliation
-- ----------------------
-- Every `lever_id` below appears verbatim in `leverIds` in
-- `lib/db/src/schema/opportunities.ts`. Three levers are intentionally
-- assigned to two bands (see spec §"Dual-band levers"):
--
--   sku_price_benchmark              → fragmented (rank 1), indexable (rank 2)
--   payment_term_extension           → concentrated (rank 1), subscription (rank 2)
--   contract_renegotiation_trigger   → concentrated (rank 1), capital (rank 2)
--
-- Every other lever is rank 1 in exactly one band. Rank 2 surfaces are
-- reserved for v2 (the routing helper currently filters to rank 1).
--
-- Canonical category codes
-- ------------------------
-- Currently mirrors `CANONICAL_MATERIAL_CODES` and
-- `CANONICAL_CATEGORY_CODES` in
-- `artifacts/api-server/src/lib/intelligence/scope-taxonomy.ts`. Service-side
-- buckets (Professional Services, HR/Contingent, Marketing, Telecom) are
-- owned by task #2 and intentionally NOT seeded here.
-- ============================================================================

-- ── 1. Lever → band assignments ─────────────────────────────────────────────
INSERT INTO lever_bands (id, lever_id, band, fit_rank) VALUES
  -- INDEXABLE: levers that benchmark against an external price index
  ('lvb_idx_index_based_pricing',         'index_based_pricing',         'indexable',    1),
  ('lvb_idx_raw_material_hedging',        'raw_material_hedging',        'indexable',    1),
  ('lvb_idx_material_index_arbitrage',    'material_index_arbitrage',    'indexable',    1),
  ('lvb_idx_supplier_fx_exposure',        'supplier_fx_exposure',        'indexable',    1),
  ('lvb_idx_spot_vs_contract',            'spot_vs_contract',            'indexable',    1),
  ('lvb_idx_should_cost_modeling',        'should_cost_modeling',        'indexable',    1),
  ('lvb_idx_freight_mode_optimization',   'freight_mode_optimization',   'indexable',    1),
  ('lvb_idx_lane_consolidation',          'lane_consolidation',          'indexable',    1),
  ('lvb_idx_incoterms_optimization',      'incoterms_optimization',      'indexable',    1),
  ('lvb_idx_sku_price_benchmark_r2',      'sku_price_benchmark',         'indexable',    2),

  -- CONCENTRATED: few suppliers / negotiable contract levers
  ('lvb_con_supplier_consolidation',      'supplier_consolidation',      'concentrated', 1),
  ('lvb_con_contract_renegotiation',      'contract_renegotiation_trigger','concentrated',1),
  ('lvb_con_payment_term_extension',      'payment_term_extension',      'concentrated', 1),
  ('lvb_con_dual_sourcing',               'dual_sourcing',               'concentrated', 1),
  ('lvb_con_demand_aggregation',          'demand_aggregation',          'concentrated', 1),
  ('lvb_con_missed_volume_threshold',     'missed_volume_threshold',     'concentrated', 1),
  ('lvb_con_contract_leakage',            'contract_leakage',            'concentrated', 1),

  -- FRAGMENTED: many small suppliers / catalog-driven categories
  ('lvb_frg_sku_price_benchmark',         'sku_price_benchmark',         'fragmented',   1),
  ('lvb_frg_tail_spend_rationalization',  'tail_spend_rationalization',  'fragmented',   1),
  ('lvb_frg_catalog_standardization',     'catalog_standardization',     'fragmented',   1),
  ('lvb_frg_maverick_spend',              'maverick_spend',              'fragmented',   1),
  ('lvb_frg_indirect_category_strategy',  'indirect_category_strategy',  'fragmented',   1),
  ('lvb_frg_duplicate_payment',           'duplicate_payment',           'fragmented',   1),

  -- SUBSCRIPTION: SaaS / recurring contracts
  ('lvb_sub_multi_year_tco',              'multi_year_tco',              'subscription', 1),
  ('lvb_sub_payment_term_extension_r2',   'payment_term_extension',      'subscription', 2),

  -- CAPITAL: capex / heavy equipment
  ('lvb_cap_should_cost_modeling',        'should_cost_modeling',        'capital',      1),
  ('lvb_cap_multi_year_tco',              'multi_year_tco',              'capital',      1),
  ('lvb_cap_contract_renegotiation_r2',   'contract_renegotiation_trigger','capital',    2),

  -- SERVICES: professional services, contingent labor, etc.
  ('lvb_svc_services_rate_card_benchmark','services_rate_card_benchmark','services',     1),
  ('lvb_svc_sow_to_msa_conversion',       'sow_to_msa_conversion',       'services',     1),
  ('lvb_svc_outcome_based_contract',      'outcome_based_contract',      'services',     1),
  ('lvb_svc_unbundling_rebundling',       'unbundling_rebundling',       'services',     1)
ON CONFLICT (lever_id, band) DO NOTHING;

-- ── 2. Canonical category code → band assignments ───────────────────────────
INSERT INTO category_bands (id, category_code, band, confidence_weight, source) VALUES
  -- Materials → indexable (PPI-tracked raw inputs)
  ('cb_iron_steel_idx',           'IRON_STEEL',             'indexable',    1.00, 'seed'),
  ('cb_steel_mill_idx',           'STEEL_MILL_PRODUCTS',    'indexable',    1.00, 'seed'),
  ('cb_nonferrous_idx',           'NONFERROUS_METALS',      'indexable',    1.00, 'seed'),
  ('cb_chemicals_idx',            'INDUSTRIAL_CHEMICALS',   'indexable',    1.00, 'seed'),
  ('cb_resins_idx',               'PLASTIC_RESINS',         'indexable',    1.00, 'seed'),
  ('cb_lumber_idx',               'LUMBER',                 'indexable',    1.00, 'seed'),
  ('cb_pulp_paper_idx',           'PULP_PAPER',             'indexable',    1.00, 'seed'),
  ('cb_crude_petro_idx',          'CRUDE_PETROLEUM',        'indexable',    1.00, 'seed'),
  ('cb_natural_gas_idx',          'NATURAL_GAS_INDUSTRIAL', 'indexable',    1.00, 'seed'),
  ('cb_fuels_power_idx',          'FUELS_AND_POWER',        'indexable',    1.00, 'seed'),

  -- Logistics services → indexable / concentrated.
  -- Spec contract: TL routes to spot_vs_contract (DAT/spot indices
  -- track this market and the lever lives in the `indexable` band).
  -- LTL is concentrated (FedEx Freight, Old Dominion, XPO, Saia,
  -- ABF dominate national LTL → small N of negotiable suppliers).
  -- Rail freight is concentrated by class-1 railroads.
  -- Brokerage and warehousing remain fragmented.
  ('cb_truck_tl_idx',             'FREIGHT_TRUCKING_TL',    'indexable',    1.00, 'seed'),
  ('cb_truck_ltl_con',            'FREIGHT_TRUCKING_LTL',   'concentrated', 1.00, 'seed'),
  ('cb_rail_freight_con',         'RAIL_FREIGHT',           'concentrated', 1.00, 'seed'),
  ('cb_warehousing_frg',          'WAREHOUSING_STORAGE',    'fragmented',   1.00, 'seed'),
  ('cb_freight_brokerage_frg',    'FREIGHT_BROKERAGE',      'fragmented',   1.00, 'seed'),

  -- Dual-band coverage. These categories carry BOTH `indexable` (above)
  -- AND `concentrated` band membership because they have tracked PPI
  -- indices AND a small set of negotiable suppliers — steel mills,
  -- big mining majors, top chemical/resin producers. The routing
  -- model is supposed to reach both indexable levers
  -- (e.g. raw_material_hedging) AND concentrated levers
  -- (e.g. supplier_consolidation) for these categories. Lower
  -- confidence_weight on the concentrated row biases the band
  -- ordering toward the indexable lever set without making the
  -- concentrated set unreachable.
  ('cb_iron_steel_con',           'IRON_STEEL',             'concentrated', 0.80, 'seed'),
  ('cb_steel_mill_con',           'STEEL_MILL_PRODUCTS',    'concentrated', 0.80, 'seed'),
  ('cb_nonferrous_con',           'NONFERROUS_METALS',      'concentrated', 0.70, 'seed'),
  ('cb_chemicals_con',            'INDUSTRIAL_CHEMICALS',   'concentrated', 0.70, 'seed'),
  ('cb_resins_con',               'PLASTIC_RESINS',         'concentrated', 0.70, 'seed'),
  ('cb_truck_tl_con',             'FREIGHT_TRUCKING_TL',    'concentrated', 0.50, 'seed'),

  -- Subscription / recurring contracts (SaaS, IT licenses, telecom).
  -- These categories anchor the `subscription` band so multi_year_tco
  -- can actually be reached through routing. Without these rows the
  -- lever bands for `subscription` are dead code at decide time.
  ('cb_saas_sub',                 'SAAS_SUBSCRIPTIONS',     'subscription', 1.00, 'seed'),
  ('cb_it_software_sub',          'IT_SOFTWARE_LICENSES',   'subscription', 1.00, 'seed'),
  ('cb_telecom_sub',              'TELECOM_VOICE_DATA',     'subscription', 1.00, 'seed'),
  ('cb_data_subscriptions_sub',   'DATA_SUBSCRIPTIONS',     'subscription', 1.00, 'seed'),

  -- Capital / capex (heavy equipment, machinery). Anchors the
  -- `capital` band so should_cost_modeling and contract_renegotiation
  -- (rank-2 capital) become reachable.
  ('cb_heavy_equipment_cap',      'HEAVY_EQUIPMENT',        'capital',      1.00, 'seed'),
  ('cb_capex_machinery_cap',      'CAPEX_MACHINERY',        'capital',      1.00, 'seed'),
  ('cb_construction_capex_cap',   'CONSTRUCTION_CAPEX',     'capital',      1.00, 'seed'),
  ('cb_facility_buildout_cap',    'FACILITY_BUILDOUT',      'capital',      1.00, 'seed'),

  -- Services (professional services, contingent labor, marketing,
  -- legal). Anchors the `services` band so the four services-band
  -- levers (rate-card, SOW→MSA, outcome-based, unbundling) have a
  -- routable home.
  ('cb_professional_svc',         'PROFESSIONAL_SERVICES',  'services',     1.00, 'seed'),
  ('cb_contingent_labor_svc',     'CONTINGENT_LABOR',       'services',     1.00, 'seed'),
  ('cb_marketing_svc',            'MARKETING_SERVICES',     'services',     1.00, 'seed'),
  ('cb_legal_svc',                'LEGAL_SERVICES',         'services',     1.00, 'seed'),
  ('cb_consulting_svc',           'CONSULTING_SERVICES',    'services',     1.00, 'seed'),

  -- Additional fragmented categories (MRO, office supplies, indirect
  -- spend) — these are the most common Layer-A misses in real tenant
  -- ingest streams; seeding them upfront cuts queue depth dramatically.
  ('cb_mro_frg',                  'MRO_SUPPLIES',           'fragmented',   1.00, 'seed'),
  ('cb_office_supplies_frg',      'OFFICE_SUPPLIES',        'fragmented',   1.00, 'seed'),
  ('cb_indirect_other_frg',       'INDIRECT_OTHER',         'fragmented',   1.00, 'seed'),
  ('cb_packaging_frg',            'PACKAGING_GENERAL',      'fragmented',   1.00, 'seed'),

  -- ── Task #214: services taxonomy band assignments ───────────────────────
  -- Professional / advisory services → services band.
  ('cb_prof_consulting_strategy_svc', 'PROF_CONSULTING_STRATEGY', 'services',     1.00, 'seed'),
  ('cb_prof_consulting_ops_svc',      'PROF_CONSULTING_OPS',      'services',     1.00, 'seed'),
  ('cb_prof_legal_svc',               'PROF_LEGAL',               'services',     1.00, 'seed'),
  ('cb_prof_audit_tax_svc',           'PROF_AUDIT_TAX',           'services',     1.00, 'seed'),
  ('cb_prof_ma_advisory_svc',         'PROF_M_AND_A_ADVISORY',    'services',     1.00, 'seed'),

  -- IT services → services. SaaS subset → subscription.
  ('cb_it_app_dev_svc',               'IT_APP_DEV',               'services',     1.00, 'seed'),
  ('cb_it_infra_svc',                 'IT_INFRA',                 'services',     1.00, 'seed'),
  ('cb_it_cyber_svc',                 'IT_CYBER',                 'services',     1.00, 'seed'),
  ('cb_it_saas_sub',                  'IT_SAAS',                  'subscription', 1.00, 'seed'),
  ('cb_it_managed_services_svc',      'IT_MANAGED_SERVICES',      'services',     1.00, 'seed'),
  ('cb_it_help_desk_svc',             'IT_HELP_DESK',             'services',     1.00, 'seed'),

  -- HR / contingent → services. Contingent-labor also concentrated (top-N
  -- MSPs dominate the staffing network).
  ('cb_hr_contingent_svc',            'HR_CONTINGENT_LABOR',      'services',     1.00, 'seed'),
  ('cb_hr_contingent_con',            'HR_CONTINGENT_LABOR',      'concentrated', 0.60, 'seed'),
  ('cb_hr_recruiting_svc',            'HR_RECRUITING',            'services',     1.00, 'seed'),
  ('cb_hr_training_svc',              'HR_TRAINING',              'services',     1.00, 'seed'),
  ('cb_hr_payroll_benefits_svc',      'HR_PAYROLL_BENEFITS',      'services',     1.00, 'seed'),

  -- Marketing → services. Martech SaaS subset → subscription.
  ('cb_mkt_agency_creative_svc',      'MKT_AGENCY_CREATIVE',      'services',     1.00, 'seed'),
  ('cb_mkt_media_buying_svc',         'MKT_MEDIA_BUYING',         'services',     1.00, 'seed'),
  ('cb_mkt_pr_svc',                   'MKT_PR',                   'services',     1.00, 'seed'),
  ('cb_mkt_events_svc',               'MKT_EVENTS_TRADE_SHOWS',   'services',     1.00, 'seed'),
  ('cb_mkt_research_svc',             'MKT_RESEARCH',             'services',     1.00, 'seed'),
  ('cb_mkt_martech_sub',              'MKT_MARTECH_SAAS',         'subscription', 1.00, 'seed'),

  -- Facilities labor services → services. Leases → capital. Utilities are
  -- indexable AND concentrated (PPI tracked + small-N regional utilities).
  ('cb_fac_janitorial_svc',           'FAC_JANITORIAL',           'services',     1.00, 'seed'),
  ('cb_fac_security_svc',             'FAC_SECURITY',             'services',     1.00, 'seed'),
  ('cb_fac_maintenance_svc',          'FAC_MAINTENANCE',          'services',     1.00, 'seed'),
  ('cb_fac_landscaping_svc',          'FAC_LANDSCAPING',          'services',     1.00, 'seed'),
  ('cb_fac_catering_svc',             'FAC_CATERING',             'services',     1.00, 'seed'),
  ('cb_fac_leases_cap',               'FAC_LEASES',               'capital',      1.00, 'seed'),
  ('cb_fac_utilities_idx',            'FAC_UTILITIES',            'indexable',    1.00, 'seed'),
  ('cb_fac_utilities_con',            'FAC_UTILITIES',            'concentrated', 0.70, 'seed'),

  -- Logistics extensions. Ocean/air freight → indexable (BDI / Drewry).
  -- Parcel → concentrated (FedEx/UPS/USPS). Last-mile → fragmented. 3PL/
  -- customs brokerage are services.
  ('cb_log_freight_ocean_idx',        'LOG_FREIGHT_OCEAN',        'indexable',    1.00, 'seed'),
  ('cb_log_freight_air_idx',          'LOG_FREIGHT_AIR',          'indexable',    1.00, 'seed'),
  ('cb_log_last_mile_frg',            'LOG_LAST_MILE',            'fragmented',   1.00, 'seed'),
  ('cb_log_3pl_svc',                  'LOG_3PL',                  'services',     1.00, 'seed'),
  ('cb_log_3pl_frg',                  'LOG_3PL',                  'fragmented',   0.60, 'seed'),
  ('cb_log_customs_brokerage_svc',    'LOG_CUSTOMS_BROKERAGE',    'services',     1.00, 'seed'),
  ('cb_log_parcel_con',               'LOG_PARCEL',               'concentrated', 1.00, 'seed'),

  -- Telecom → subscription (recurring carrier commits). Conferencing too.
  ('cb_tel_network_sub',              'TEL_NETWORK',              'subscription', 1.00, 'seed'),
  ('cb_tel_wireless_sub',             'TEL_WIRELESS',             'subscription', 1.00, 'seed'),
  ('cb_tel_conferencing_sub',         'TEL_CONFERENCING',         'subscription', 1.00, 'seed'),

  -- Travel: TMC management → services. Air/hotel/ground → indexable
  -- (BTI / corporate travel rate indices) plus concentrated for the
  -- top-N airline / hotel / GDS suppliers.
  ('cb_trv_tmc_svc',                  'TRV_TMC',                  'services',     1.00, 'seed'),
  ('cb_trv_air_idx',                  'TRV_AIR',                  'indexable',    1.00, 'seed'),
  ('cb_trv_air_con',                  'TRV_AIR',                  'concentrated', 0.70, 'seed'),
  ('cb_trv_hotel_idx',                'TRV_HOTEL',                'indexable',    1.00, 'seed'),
  ('cb_trv_hotel_con',                'TRV_HOTEL',                'concentrated', 0.70, 'seed'),
  ('cb_trv_ground_frg',               'TRV_GROUND',               'fragmented',   1.00, 'seed'),

  -- Financial services. Banking → concentrated. Insurance → services +
  -- concentrated (top-N carriers). Treasury / external audit → services.
  ('cb_fin_banking_con',              'FIN_BANKING',              'concentrated', 1.00, 'seed'),
  ('cb_fin_insurance_svc',            'FIN_INSURANCE',            'services',     1.00, 'seed'),
  ('cb_fin_insurance_con',            'FIN_INSURANCE',            'concentrated', 0.70, 'seed'),
  ('cb_fin_treasury_svc',             'FIN_TREASURY',             'services',     1.00, 'seed'),
  ('cb_fin_audit_external_svc',       'FIN_AUDIT_EXTERNAL',       'services',     1.00, 'seed'),

  -- Engineering services → services.
  ('cb_eng_rnd_svc',                  'ENG_RND',                  'services',     1.00, 'seed'),
  ('cb_eng_design_svc',               'ENG_DESIGN',               'services',     1.00, 'seed'),
  ('cb_eng_testing_cert_svc',         'ENG_TESTING_CERT',         'services',     1.00, 'seed')
ON CONFLICT (category_code, band) DO NOTHING;

-- ── 3. Global synonym registry ──────────────────────────────────────────────
-- `normalized` is the lookup key (whitespace-collapsed, lowercased). Keep the
-- INSERT and the runtime `normalizeCategoryString` helper in lib/db/src/schema/
-- taxonomy.ts in lockstep — the seed bypasses the helper for performance, so
-- if normalization rules change BOTH must be updated.
INSERT INTO synonym_registry (id, tenant_string, normalized, canonical_code, scope, org_id, source) VALUES
  -- IRON_STEEL
  ('syn_iron_steel_1', 'Iron & Steel',                    'iron & steel',                    'IRON_STEEL',           'global', NULL, 'seed'),
  ('syn_iron_steel_2', 'Steel',                           'steel',                           'IRON_STEEL',           'global', NULL, 'seed'),
  ('syn_iron_steel_3', 'Carbon Steel',                    'carbon steel',                    'IRON_STEEL',           'global', NULL, 'seed'),
  ('syn_iron_steel_4', 'Stainless Steel',                 'stainless steel',                 'IRON_STEEL',           'global', NULL, 'seed'),
  ('syn_iron_steel_5', 'Iron Ore',                        'iron ore',                        'IRON_STEEL',           'global', NULL, 'seed'),

  -- STEEL_MILL_PRODUCTS
  ('syn_smp_1',  'Steel Mill Products',                   'steel mill products',             'STEEL_MILL_PRODUCTS',  'global', NULL, 'seed'),
  ('syn_smp_2',  'Hot Rolled Steel',                      'hot rolled steel',                'STEEL_MILL_PRODUCTS',  'global', NULL, 'seed'),
  ('syn_smp_3',  'Cold Rolled Steel',                     'cold rolled steel',               'STEEL_MILL_PRODUCTS',  'global', NULL, 'seed'),
  ('syn_smp_4',  'Steel Plate',                           'steel plate',                     'STEEL_MILL_PRODUCTS',  'global', NULL, 'seed'),
  ('syn_smp_5',  'Steel Coil',                            'steel coil',                      'STEEL_MILL_PRODUCTS',  'global', NULL, 'seed'),

  -- NONFERROUS_METALS
  ('syn_nf_1',   'Nonferrous Metals',                     'nonferrous metals',               'NONFERROUS_METALS',    'global', NULL, 'seed'),
  ('syn_nf_2',   'Aluminum',                              'aluminum',                        'NONFERROUS_METALS',    'global', NULL, 'seed'),
  ('syn_nf_3',   'Aluminium',                             'aluminium',                       'NONFERROUS_METALS',    'global', NULL, 'seed'),
  ('syn_nf_4',   'Copper',                                'copper',                          'NONFERROUS_METALS',    'global', NULL, 'seed'),
  ('syn_nf_5',   'Brass',                                 'brass',                           'NONFERROUS_METALS',    'global', NULL, 'seed'),
  ('syn_nf_6',   'Zinc',                                  'zinc',                            'NONFERROUS_METALS',    'global', NULL, 'seed'),
  ('syn_nf_7',   'Nickel',                                'nickel',                          'NONFERROUS_METALS',    'global', NULL, 'seed'),

  -- INDUSTRIAL_CHEMICALS
  ('syn_chem_1', 'Industrial Chemicals',                  'industrial chemicals',            'INDUSTRIAL_CHEMICALS', 'global', NULL, 'seed'),
  ('syn_chem_2', 'Chemicals',                             'chemicals',                       'INDUSTRIAL_CHEMICALS', 'global', NULL, 'seed'),
  ('syn_chem_3', 'Bulk Chemicals',                        'bulk chemicals',                  'INDUSTRIAL_CHEMICALS', 'global', NULL, 'seed'),
  ('syn_chem_4', 'Specialty Chemicals',                   'specialty chemicals',             'INDUSTRIAL_CHEMICALS', 'global', NULL, 'seed'),
  ('syn_chem_5', 'Solvents',                              'solvents',                        'INDUSTRIAL_CHEMICALS', 'global', NULL, 'seed'),

  -- PLASTIC_RESINS
  ('syn_res_1',  'Plastic Resins',                        'plastic resins',                  'PLASTIC_RESINS',       'global', NULL, 'seed'),
  ('syn_res_2',  'Resin',                                 'resin',                           'PLASTIC_RESINS',       'global', NULL, 'seed'),
  ('syn_res_3',  'Polyethylene',                          'polyethylene',                    'PLASTIC_RESINS',       'global', NULL, 'seed'),
  ('syn_res_4',  'Polypropylene',                         'polypropylene',                   'PLASTIC_RESINS',       'global', NULL, 'seed'),
  ('syn_res_5',  'PVC',                                   'pvc',                             'PLASTIC_RESINS',       'global', NULL, 'seed'),
  ('syn_res_6',  'PET',                                   'pet',                             'PLASTIC_RESINS',       'global', NULL, 'seed'),
  ('syn_res_7',  'HDPE',                                  'hdpe',                            'PLASTIC_RESINS',       'global', NULL, 'seed'),
  ('syn_res_8',  'LDPE',                                  'ldpe',                            'PLASTIC_RESINS',       'global', NULL, 'seed'),
  ('syn_res_9',  'Plastics',                              'plastics',                        'PLASTIC_RESINS',       'global', NULL, 'seed'),

  -- LUMBER
  ('syn_lum_1',  'Lumber',                                'lumber',                          'LUMBER',               'global', NULL, 'seed'),
  ('syn_lum_2',  'Wood',                                  'wood',                            'LUMBER',               'global', NULL, 'seed'),
  ('syn_lum_3',  'Plywood',                               'plywood',                         'LUMBER',               'global', NULL, 'seed'),
  ('syn_lum_4',  'Timber',                                'timber',                          'LUMBER',               'global', NULL, 'seed'),

  -- PULP_PAPER
  ('syn_pp_1',   'Pulp & Paper',                          'pulp & paper',                    'PULP_PAPER',           'global', NULL, 'seed'),
  ('syn_pp_2',   'Paper',                                 'paper',                           'PULP_PAPER',           'global', NULL, 'seed'),
  ('syn_pp_3',   'Corrugated',                            'corrugated',                      'PULP_PAPER',           'global', NULL, 'seed'),
  ('syn_pp_4',   'Cardboard',                             'cardboard',                       'PULP_PAPER',           'global', NULL, 'seed'),
  ('syn_pp_5',   'Pulp',                                  'pulp',                            'PULP_PAPER',           'global', NULL, 'seed'),
  ('syn_pp_6',   'Packaging - Paper',                     'packaging - paper',               'PULP_PAPER',           'global', NULL, 'seed'),

  -- CRUDE_PETROLEUM
  ('syn_petro_1', 'Crude Petroleum',                      'crude petroleum',                 'CRUDE_PETROLEUM',      'global', NULL, 'seed'),
  ('syn_petro_2', 'Crude Oil',                            'crude oil',                       'CRUDE_PETROLEUM',      'global', NULL, 'seed'),
  ('syn_petro_3', 'Petroleum',                            'petroleum',                       'CRUDE_PETROLEUM',      'global', NULL, 'seed'),

  -- NATURAL_GAS_INDUSTRIAL
  ('syn_ng_1',   'Natural Gas',                           'natural gas',                     'NATURAL_GAS_INDUSTRIAL','global', NULL, 'seed'),
  ('syn_ng_2',   'Industrial Natural Gas',                'industrial natural gas',          'NATURAL_GAS_INDUSTRIAL','global', NULL, 'seed'),
  ('syn_ng_3',   'LNG',                                   'lng',                             'NATURAL_GAS_INDUSTRIAL','global', NULL, 'seed'),

  -- FUELS_AND_POWER
  ('syn_fp_1',   'Fuels & Power',                         'fuels & power',                   'FUELS_AND_POWER',      'global', NULL, 'seed'),
  ('syn_fp_2',   'Diesel',                                'diesel',                          'FUELS_AND_POWER',      'global', NULL, 'seed'),
  ('syn_fp_3',   'Gasoline',                              'gasoline',                        'FUELS_AND_POWER',      'global', NULL, 'seed'),
  ('syn_fp_4',   'Electricity',                           'electricity',                     'FUELS_AND_POWER',      'global', NULL, 'seed'),
  ('syn_fp_5',   'Energy',                                'energy',                          'FUELS_AND_POWER',      'global', NULL, 'seed'),
  ('syn_fp_6',   'Power',                                 'power',                           'FUELS_AND_POWER',      'global', NULL, 'seed'),
  ('syn_fp_7',   'Utilities - Electric',                  'utilities - electric',            'FUELS_AND_POWER',      'global', NULL, 'seed'),
  ('syn_fp_8',   'Fuel',                                  'fuel',                            'FUELS_AND_POWER',      'global', NULL, 'seed'),

  -- FREIGHT_TRUCKING_TL
  ('syn_tl_1',   'Truckload',                             'truckload',                       'FREIGHT_TRUCKING_TL',  'global', NULL, 'seed'),
  ('syn_tl_2',   'TL',                                    'tl',                              'FREIGHT_TRUCKING_TL',  'global', NULL, 'seed'),
  ('syn_tl_3',   'Truckload Freight',                     'truckload freight',               'FREIGHT_TRUCKING_TL',  'global', NULL, 'seed'),
  ('syn_tl_4',   'Full Truckload',                        'full truckload',                  'FREIGHT_TRUCKING_TL',  'global', NULL, 'seed'),
  ('syn_tl_5',   'Over the Road',                         'over the road',                   'FREIGHT_TRUCKING_TL',  'global', NULL, 'seed'),
  ('syn_tl_6',   'OTR',                                   'otr',                             'FREIGHT_TRUCKING_TL',  'global', NULL, 'seed'),

  -- FREIGHT_TRUCKING_LTL
  ('syn_ltl_1',  'LTL',                                   'ltl',                             'FREIGHT_TRUCKING_LTL', 'global', NULL, 'seed'),
  ('syn_ltl_2',  'Less Than Truckload',                   'less than truckload',             'FREIGHT_TRUCKING_LTL', 'global', NULL, 'seed'),
  ('syn_ltl_3',  'LTL Freight',                           'ltl freight',                     'FREIGHT_TRUCKING_LTL', 'global', NULL, 'seed'),

  -- RAIL_FREIGHT
  ('syn_rail_1', 'Rail',                                  'rail',                            'RAIL_FREIGHT',         'global', NULL, 'seed'),
  ('syn_rail_2', 'Rail Freight',                          'rail freight',                    'RAIL_FREIGHT',         'global', NULL, 'seed'),
  ('syn_rail_3', 'Intermodal Rail',                       'intermodal rail',                 'RAIL_FREIGHT',         'global', NULL, 'seed'),

  -- WAREHOUSING_STORAGE
  ('syn_wh_1',   'Warehousing',                           'warehousing',                     'WAREHOUSING_STORAGE',  'global', NULL, 'seed'),
  ('syn_wh_2',   'Warehouse',                             'warehouse',                       'WAREHOUSING_STORAGE',  'global', NULL, 'seed'),
  ('syn_wh_3',   '3PL Storage',                           '3pl storage',                     'WAREHOUSING_STORAGE',  'global', NULL, 'seed'),
  ('syn_wh_4',   'Storage',                               'storage',                         'WAREHOUSING_STORAGE',  'global', NULL, 'seed'),
  ('syn_wh_5',   'Distribution Center',                   'distribution center',             'WAREHOUSING_STORAGE',  'global', NULL, 'seed'),

  -- FREIGHT_BROKERAGE
  ('syn_brk_1',  'Freight Brokerage',                     'freight brokerage',               'FREIGHT_BROKERAGE',    'global', NULL, 'seed'),
  ('syn_brk_2',  'Freight Broker',                        'freight broker',                  'FREIGHT_BROKERAGE',    'global', NULL, 'seed'),
  ('syn_brk_3',  '3PL',                                   '3pl',                             'FREIGHT_BROKERAGE',    'global', NULL, 'seed'),
  ('syn_brk_4',  'Logistics Services',                    'logistics services',              'FREIGHT_BROKERAGE',    'global', NULL, 'seed'),
  ('syn_brk_5',  'Transportation Brokerage',              'transportation brokerage',        'FREIGHT_BROKERAGE',    'global', NULL, 'seed'),

  -- SAAS_SUBSCRIPTIONS
  ('syn_saas_1', 'SaaS',                                  'saas',                            'SAAS_SUBSCRIPTIONS',   'global', NULL, 'seed'),
  ('syn_saas_2', 'SaaS Subscriptions',                    'saas subscriptions',              'SAAS_SUBSCRIPTIONS',   'global', NULL, 'seed'),
  ('syn_saas_3', 'Software as a Service',                 'software as a service',           'SAAS_SUBSCRIPTIONS',   'global', NULL, 'seed'),
  ('syn_saas_4', 'Cloud Subscriptions',                   'cloud subscriptions',             'SAAS_SUBSCRIPTIONS',   'global', NULL, 'seed'),

  -- IT_SOFTWARE_LICENSES
  ('syn_swl_1',  'Software Licenses',                     'software licenses',               'IT_SOFTWARE_LICENSES', 'global', NULL, 'seed'),
  ('syn_swl_2',  'IT Software',                           'it software',                     'IT_SOFTWARE_LICENSES', 'global', NULL, 'seed'),
  ('syn_swl_3',  'Enterprise Software',                   'enterprise software',             'IT_SOFTWARE_LICENSES', 'global', NULL, 'seed'),
  ('syn_swl_4',  'Software',                              'software',                        'IT_SOFTWARE_LICENSES', 'global', NULL, 'seed'),

  -- TELECOM_VOICE_DATA
  ('syn_tel_1',  'Telecom',                               'telecom',                         'TELECOM_VOICE_DATA',   'global', NULL, 'seed'),
  ('syn_tel_2',  'Telecommunications',                    'telecommunications',              'TELECOM_VOICE_DATA',   'global', NULL, 'seed'),
  ('syn_tel_3',  'Mobile Voice & Data',                   'mobile voice & data',             'TELECOM_VOICE_DATA',   'global', NULL, 'seed'),
  ('syn_tel_4',  'Wireless',                              'wireless',                        'TELECOM_VOICE_DATA',   'global', NULL, 'seed'),
  ('syn_tel_5',  'Internet Service',                      'internet service',                'TELECOM_VOICE_DATA',   'global', NULL, 'seed'),

  -- DATA_SUBSCRIPTIONS
  ('syn_dsub_1', 'Data Subscriptions',                    'data subscriptions',              'DATA_SUBSCRIPTIONS',   'global', NULL, 'seed'),
  ('syn_dsub_2', 'Market Data',                           'market data',                     'DATA_SUBSCRIPTIONS',   'global', NULL, 'seed'),
  ('syn_dsub_3', 'Research Subscriptions',                'research subscriptions',          'DATA_SUBSCRIPTIONS',   'global', NULL, 'seed'),

  -- HEAVY_EQUIPMENT
  ('syn_heq_1',  'Heavy Equipment',                       'heavy equipment',                 'HEAVY_EQUIPMENT',      'global', NULL, 'seed'),
  ('syn_heq_2',  'Industrial Equipment',                  'industrial equipment',            'HEAVY_EQUIPMENT',      'global', NULL, 'seed'),
  ('syn_heq_3',  'Yellow Iron',                           'yellow iron',                     'HEAVY_EQUIPMENT',      'global', NULL, 'seed'),
  ('syn_heq_4',  'Earthmoving Equipment',                 'earthmoving equipment',           'HEAVY_EQUIPMENT',      'global', NULL, 'seed'),

  -- CAPEX_MACHINERY
  ('syn_cap_1',  'Capex Machinery',                       'capex machinery',                 'CAPEX_MACHINERY',      'global', NULL, 'seed'),
  ('syn_cap_2',  'Capital Equipment',                     'capital equipment',               'CAPEX_MACHINERY',      'global', NULL, 'seed'),
  ('syn_cap_3',  'Production Machinery',                  'production machinery',            'CAPEX_MACHINERY',      'global', NULL, 'seed'),
  ('syn_cap_4',  'Machinery',                             'machinery',                       'CAPEX_MACHINERY',      'global', NULL, 'seed'),

  -- CONSTRUCTION_CAPEX
  ('syn_ccx_1',  'Construction Capex',                    'construction capex',              'CONSTRUCTION_CAPEX',   'global', NULL, 'seed'),
  ('syn_ccx_2',  'Construction',                          'construction',                    'CONSTRUCTION_CAPEX',   'global', NULL, 'seed'),
  ('syn_ccx_3',  'General Contracting',                   'general contracting',             'CONSTRUCTION_CAPEX',   'global', NULL, 'seed'),

  -- FACILITY_BUILDOUT
  ('syn_fb_1',   'Facility Buildout',                     'facility buildout',               'FACILITY_BUILDOUT',    'global', NULL, 'seed'),
  ('syn_fb_2',   'Tenant Improvement',                    'tenant improvement',              'FACILITY_BUILDOUT',    'global', NULL, 'seed'),
  ('syn_fb_3',   'Facilities Capex',                      'facilities capex',                'FACILITY_BUILDOUT',    'global', NULL, 'seed'),

  -- PROFESSIONAL_SERVICES
  ('syn_ps_1',   'Professional Services',                 'professional services',           'PROFESSIONAL_SERVICES','global', NULL, 'seed'),
  ('syn_ps_2',   'Prof Services',                         'prof services',                   'PROFESSIONAL_SERVICES','global', NULL, 'seed'),
  ('syn_ps_3',   'Professional Fees',                     'professional fees',               'PROFESSIONAL_SERVICES','global', NULL, 'seed'),

  -- CONTINGENT_LABOR
  ('syn_cl_1',   'Contingent Labor',                      'contingent labor',                'CONTINGENT_LABOR',     'global', NULL, 'seed'),
  ('syn_cl_2',   'Staff Augmentation',                    'staff augmentation',              'CONTINGENT_LABOR',     'global', NULL, 'seed'),
  ('syn_cl_3',   'Temp Labor',                            'temp labor',                      'CONTINGENT_LABOR',     'global', NULL, 'seed'),
  ('syn_cl_4',   'Contractors',                           'contractors',                     'CONTINGENT_LABOR',     'global', NULL, 'seed'),

  -- MARKETING_SERVICES
  ('syn_mkt_1',  'Marketing Services',                    'marketing services',              'MARKETING_SERVICES',   'global', NULL, 'seed'),
  ('syn_mkt_2',  'Marketing',                             'marketing',                       'MARKETING_SERVICES',   'global', NULL, 'seed'),
  ('syn_mkt_3',  'Advertising',                           'advertising',                     'MARKETING_SERVICES',   'global', NULL, 'seed'),
  ('syn_mkt_4',  'Agency Services',                       'agency services',                 'MARKETING_SERVICES',   'global', NULL, 'seed'),

  -- LEGAL_SERVICES
  ('syn_leg_1',  'Legal Services',                        'legal services',                  'LEGAL_SERVICES',       'global', NULL, 'seed'),
  ('syn_leg_2',  'Outside Counsel',                       'outside counsel',                 'LEGAL_SERVICES',       'global', NULL, 'seed'),
  ('syn_leg_3',  'Legal Fees',                            'legal fees',                      'LEGAL_SERVICES',       'global', NULL, 'seed'),

  -- CONSULTING_SERVICES
  ('syn_cons_1', 'Consulting',                            'consulting',                      'CONSULTING_SERVICES',  'global', NULL, 'seed'),
  ('syn_cons_2', 'Consulting Services',                   'consulting services',             'CONSULTING_SERVICES',  'global', NULL, 'seed'),
  ('syn_cons_3', 'Management Consulting',                 'management consulting',           'CONSULTING_SERVICES',  'global', NULL, 'seed'),
  ('syn_cons_4', 'Strategy Consulting',                   'strategy consulting',             'CONSULTING_SERVICES',  'global', NULL, 'seed'),

  -- MRO_SUPPLIES
  ('syn_mro_1',  'MRO',                                   'mro',                             'MRO_SUPPLIES',         'global', NULL, 'seed'),
  ('syn_mro_2',  'MRO Supplies',                          'mro supplies',                    'MRO_SUPPLIES',         'global', NULL, 'seed'),
  ('syn_mro_3',  'Maintenance Supplies',                  'maintenance supplies',            'MRO_SUPPLIES',         'global', NULL, 'seed'),
  ('syn_mro_4',  'Maintenance Repair Operations',         'maintenance repair operations',   'MRO_SUPPLIES',         'global', NULL, 'seed'),

  -- OFFICE_SUPPLIES
  ('syn_off_1',  'Office Supplies',                       'office supplies',                 'OFFICE_SUPPLIES',      'global', NULL, 'seed'),
  ('syn_off_2',  'Office Products',                       'office products',                 'OFFICE_SUPPLIES',      'global', NULL, 'seed'),
  ('syn_off_3',  'Stationery',                            'stationery',                      'OFFICE_SUPPLIES',      'global', NULL, 'seed'),

  -- INDIRECT_OTHER (residual catch-all)
  ('syn_ind_1',  'Indirect Spend',                        'indirect spend',                  'INDIRECT_OTHER',       'global', NULL, 'seed'),
  ('syn_ind_2',  'Indirect Other',                        'indirect other',                  'INDIRECT_OTHER',       'global', NULL, 'seed'),
  ('syn_ind_3',  'Miscellaneous',                         'miscellaneous',                   'INDIRECT_OTHER',       'global', NULL, 'seed'),

  -- PACKAGING_GENERAL (non-paper packaging — paper packaging routes to PULP_PAPER)
  ('syn_pkg_1',  'Packaging',                             'packaging',                       'PACKAGING_GENERAL',    'global', NULL, 'seed'),
  ('syn_pkg_2',  'Packaging Materials',                   'packaging materials',             'PACKAGING_GENERAL',    'global', NULL, 'seed'),
  ('syn_pkg_3',  'Flexible Packaging',                    'flexible packaging',              'PACKAGING_GENERAL',    'global', NULL, 'seed'),
  ('syn_pkg_4',  'Rigid Packaging',                       'rigid packaging',                 'PACKAGING_GENERAL',    'global', NULL, 'seed'),

  -- ── Task #214: synonyms for the services taxonomy ───────────────────────
  -- PROF_*
  ('syn_prof_cons_str_1', 'Strategy Consulting',           'strategy consulting',             'PROF_CONSULTING_STRATEGY','global', NULL, 'seed'),
  ('syn_prof_cons_str_2', 'Strategic Advisory',            'strategic advisory',              'PROF_CONSULTING_STRATEGY','global', NULL, 'seed'),
  ('syn_prof_cons_str_3', 'Top Tier Consulting',           'top tier consulting',             'PROF_CONSULTING_STRATEGY','global', NULL, 'seed'),
  ('syn_prof_cons_ops_1', 'Operations Consulting',         'operations consulting',           'PROF_CONSULTING_OPS',     'global', NULL, 'seed'),
  ('syn_prof_cons_ops_2', 'Process Consulting',            'process consulting',              'PROF_CONSULTING_OPS',     'global', NULL, 'seed'),
  ('syn_prof_cons_ops_3', 'Implementation Consulting',     'implementation consulting',       'PROF_CONSULTING_OPS',     'global', NULL, 'seed'),
  ('syn_prof_legal_1',    'Legal',                         'legal',                           'PROF_LEGAL',              'global', NULL, 'seed'),
  ('syn_prof_legal_2',    'Law Firm',                      'law firm',                        'PROF_LEGAL',              'global', NULL, 'seed'),
  ('syn_prof_legal_3',    'External Counsel',              'external counsel',                'PROF_LEGAL',              'global', NULL, 'seed'),
  ('syn_prof_audit_1',    'Audit & Tax',                   'audit & tax',                     'PROF_AUDIT_TAX',          'global', NULL, 'seed'),
  ('syn_prof_audit_2',    'Tax Advisory',                  'tax advisory',                    'PROF_AUDIT_TAX',          'global', NULL, 'seed'),
  ('syn_prof_audit_3',    'Big Four',                      'big four',                        'PROF_AUDIT_TAX',          'global', NULL, 'seed'),
  ('syn_prof_ma_1',       'M&A Advisory',                  'm&a advisory',                    'PROF_M_AND_A_ADVISORY',   'global', NULL, 'seed'),
  ('syn_prof_ma_2',       'Investment Banking',            'investment banking',              'PROF_M_AND_A_ADVISORY',   'global', NULL, 'seed'),
  ('syn_prof_ma_3',       'Transaction Advisory',          'transaction advisory',            'PROF_M_AND_A_ADVISORY',   'global', NULL, 'seed'),

  -- IT_*
  ('syn_it_dev_1',        'Application Development',       'application development',         'IT_APP_DEV',              'global', NULL, 'seed'),
  ('syn_it_dev_2',        'Software Development',          'software development',            'IT_APP_DEV',              'global', NULL, 'seed'),
  ('syn_it_dev_3',        'Custom Software',               'custom software',                 'IT_APP_DEV',              'global', NULL, 'seed'),
  ('syn_it_infra_1',      'IT Infrastructure',             'it infrastructure',               'IT_INFRA',                'global', NULL, 'seed'),
  ('syn_it_infra_2',      'Cloud Infrastructure',          'cloud infrastructure',            'IT_INFRA',                'global', NULL, 'seed'),
  ('syn_it_infra_3',      'Datacenter',                    'datacenter',                      'IT_INFRA',                'global', NULL, 'seed'),
  ('syn_it_cyber_1',      'Cybersecurity',                 'cybersecurity',                   'IT_CYBER',                'global', NULL, 'seed'),
  ('syn_it_cyber_2',      'Security Services',             'security services',               'IT_CYBER',                'global', NULL, 'seed'),
  ('syn_it_cyber_3',      'InfoSec',                       'infosec',                         'IT_CYBER',                'global', NULL, 'seed'),
  ('syn_it_saas_1',       'IT SaaS',                       'it saas',                         'IT_SAAS',                 'global', NULL, 'seed'),
  ('syn_it_saas_2',       'Cloud Software',                'cloud software',                  'IT_SAAS',                 'global', NULL, 'seed'),
  ('syn_it_msp_1',        'Managed Services',              'managed services',                'IT_MANAGED_SERVICES',     'global', NULL, 'seed'),
  ('syn_it_msp_2',        'MSP',                           'msp',                             'IT_MANAGED_SERVICES',     'global', NULL, 'seed'),
  ('syn_it_helpdesk_1',   'Help Desk',                     'help desk',                       'IT_HELP_DESK',            'global', NULL, 'seed'),
  ('syn_it_helpdesk_2',   'IT Support',                    'it support',                      'IT_HELP_DESK',            'global', NULL, 'seed'),
  ('syn_it_helpdesk_3',   'Service Desk',                  'service desk',                    'IT_HELP_DESK',            'global', NULL, 'seed'),

  -- HR_*
  ('syn_hr_cl_1',         'HR Contingent Labor',           'hr contingent labor',             'HR_CONTINGENT_LABOR',     'global', NULL, 'seed'),
  ('syn_hr_cl_2',         'Temp Staffing',                 'temp staffing',                   'HR_CONTINGENT_LABOR',     'global', NULL, 'seed'),
  ('syn_hr_cl_3',         'Staffing Agency',               'staffing agency',                 'HR_CONTINGENT_LABOR',     'global', NULL, 'seed'),
  ('syn_hr_recr_1',       'Recruiting',                    'recruiting',                      'HR_RECRUITING',           'global', NULL, 'seed'),
  ('syn_hr_recr_2',       'Executive Search',              'executive search',                'HR_RECRUITING',           'global', NULL, 'seed'),
  ('syn_hr_recr_3',       'Talent Acquisition',            'talent acquisition',              'HR_RECRUITING',           'global', NULL, 'seed'),
  ('syn_hr_train_1',      'Training & Development',        'training & development',          'HR_TRAINING',             'global', NULL, 'seed'),
  ('syn_hr_train_2',      'Learning & Development',        'learning & development',          'HR_TRAINING',             'global', NULL, 'seed'),
  ('syn_hr_train_3',      'L&D',                           'l&d',                             'HR_TRAINING',             'global', NULL, 'seed'),
  ('syn_hr_pay_1',        'Payroll',                       'payroll',                         'HR_PAYROLL_BENEFITS',     'global', NULL, 'seed'),
  ('syn_hr_pay_2',        'Benefits Administration',       'benefits administration',         'HR_PAYROLL_BENEFITS',     'global', NULL, 'seed'),
  ('syn_hr_pay_3',        'Benefits',                      'benefits',                        'HR_PAYROLL_BENEFITS',     'global', NULL, 'seed'),

  -- MKT_*
  ('syn_mkt_ag_1',        'Creative Agency',               'creative agency',                 'MKT_AGENCY_CREATIVE',     'global', NULL, 'seed'),
  ('syn_mkt_ag_2',        'Ad Agency',                     'ad agency',                       'MKT_AGENCY_CREATIVE',     'global', NULL, 'seed'),
  ('syn_mkt_ag_3',        'Brand Agency',                  'brand agency',                    'MKT_AGENCY_CREATIVE',     'global', NULL, 'seed'),
  ('syn_mkt_media_1',     'Media Buying',                  'media buying',                    'MKT_MEDIA_BUYING',        'global', NULL, 'seed'),
  ('syn_mkt_media_2',     'Media Spend',                   'media spend',                     'MKT_MEDIA_BUYING',        'global', NULL, 'seed'),
  ('syn_mkt_media_3',     'Programmatic Advertising',      'programmatic advertising',        'MKT_MEDIA_BUYING',        'global', NULL, 'seed'),
  ('syn_mkt_pr_1',        'Public Relations',              'public relations',                'MKT_PR',                  'global', NULL, 'seed'),
  ('syn_mkt_pr_2',        'PR',                            'pr',                              'MKT_PR',                  'global', NULL, 'seed'),
  ('syn_mkt_pr_3',        'Communications',                'communications',                  'MKT_PR',                  'global', NULL, 'seed'),
  ('syn_mkt_evt_1',       'Events',                        'events',                          'MKT_EVENTS_TRADE_SHOWS',  'global', NULL, 'seed'),
  ('syn_mkt_evt_2',       'Trade Shows',                   'trade shows',                     'MKT_EVENTS_TRADE_SHOWS',  'global', NULL, 'seed'),
  ('syn_mkt_evt_3',       'Conferences',                   'conferences',                     'MKT_EVENTS_TRADE_SHOWS',  'global', NULL, 'seed'),
  ('syn_mkt_res_1',       'Market Research',               'market research',                 'MKT_RESEARCH',            'global', NULL, 'seed'),
  ('syn_mkt_res_2',       'Consumer Insights',             'consumer insights',               'MKT_RESEARCH',            'global', NULL, 'seed'),
  ('syn_mkt_mt_1',        'Martech',                       'martech',                         'MKT_MARTECH_SAAS',        'global', NULL, 'seed'),
  ('syn_mkt_mt_2',        'Marketing Automation',          'marketing automation',            'MKT_MARTECH_SAAS',        'global', NULL, 'seed'),
  ('syn_mkt_mt_3',        'CDP',                           'cdp',                             'MKT_MARTECH_SAAS',        'global', NULL, 'seed'),

  -- FAC_*
  ('syn_fac_jan_1',       'Janitorial',                    'janitorial',                      'FAC_JANITORIAL',          'global', NULL, 'seed'),
  ('syn_fac_jan_2',       'Cleaning Services',             'cleaning services',               'FAC_JANITORIAL',          'global', NULL, 'seed'),
  ('syn_fac_jan_3',       'Facility Cleaning',             'facility cleaning',               'FAC_JANITORIAL',          'global', NULL, 'seed'),
  ('syn_fac_sec_1',       'Security Guards',               'security guards',                 'FAC_SECURITY',            'global', NULL, 'seed'),
  ('syn_fac_sec_2',       'Physical Security',             'physical security',               'FAC_SECURITY',            'global', NULL, 'seed'),
  ('syn_fac_maint_1',     'Building Maintenance',          'building maintenance',            'FAC_MAINTENANCE',         'global', NULL, 'seed'),
  ('syn_fac_maint_2',     'HVAC Maintenance',              'hvac maintenance',                'FAC_MAINTENANCE',         'global', NULL, 'seed'),
  ('syn_fac_land_1',      'Landscaping',                   'landscaping',                     'FAC_LANDSCAPING',         'global', NULL, 'seed'),
  ('syn_fac_land_2',      'Grounds Maintenance',           'grounds maintenance',             'FAC_LANDSCAPING',         'global', NULL, 'seed'),
  ('syn_fac_cat_1',       'Catering',                      'catering',                        'FAC_CATERING',            'global', NULL, 'seed'),
  ('syn_fac_cat_2',       'Cafeteria Services',            'cafeteria services',              'FAC_CATERING',            'global', NULL, 'seed'),
  ('syn_fac_lse_1',       'Real Estate Lease',             'real estate lease',               'FAC_LEASES',              'global', NULL, 'seed'),
  ('syn_fac_lse_2',       'Office Lease',                  'office lease',                    'FAC_LEASES',              'global', NULL, 'seed'),
  ('syn_fac_lse_3',       'Property Rent',                 'property rent',                   'FAC_LEASES',              'global', NULL, 'seed'),
  ('syn_fac_util_1',      'Utilities',                     'utilities',                       'FAC_UTILITIES',           'global', NULL, 'seed'),
  ('syn_fac_util_2',      'Water & Sewer',                 'water & sewer',                   'FAC_UTILITIES',           'global', NULL, 'seed'),
  ('syn_fac_util_3',      'Waste Disposal',                'waste disposal',                  'FAC_UTILITIES',           'global', NULL, 'seed'),

  -- LOG_*
  ('syn_log_ocean_1',     'Ocean Freight',                 'ocean freight',                   'LOG_FREIGHT_OCEAN',       'global', NULL, 'seed'),
  ('syn_log_ocean_2',     'FCL',                           'fcl',                             'LOG_FREIGHT_OCEAN',       'global', NULL, 'seed'),
  ('syn_log_ocean_3',     'LCL',                           'lcl',                             'LOG_FREIGHT_OCEAN',       'global', NULL, 'seed'),
  ('syn_log_air_1',       'Air Freight',                   'air freight',                     'LOG_FREIGHT_AIR',         'global', NULL, 'seed'),
  ('syn_log_air_2',       'Airfreight',                    'airfreight',                      'LOG_FREIGHT_AIR',         'global', NULL, 'seed'),
  ('syn_log_lm_1',        'Last Mile',                     'last mile',                       'LOG_LAST_MILE',           'global', NULL, 'seed'),
  ('syn_log_lm_2',        'Final Mile Delivery',           'final mile delivery',             'LOG_LAST_MILE',           'global', NULL, 'seed'),
  ('syn_log_3pl_1',       '3PL Services',                  '3pl services',                    'LOG_3PL',                 'global', NULL, 'seed'),
  ('syn_log_3pl_2',       'Third Party Logistics',         'third party logistics',           'LOG_3PL',                 'global', NULL, 'seed'),
  ('syn_log_cust_1',      'Customs Brokerage',             'customs brokerage',               'LOG_CUSTOMS_BROKERAGE',   'global', NULL, 'seed'),
  ('syn_log_cust_2',      'Customs Broker',                'customs broker',                  'LOG_CUSTOMS_BROKERAGE',   'global', NULL, 'seed'),
  ('syn_log_pcl_1',       'Parcel',                        'parcel',                          'LOG_PARCEL',              'global', NULL, 'seed'),
  ('syn_log_pcl_2',       'Small Parcel',                  'small parcel',                    'LOG_PARCEL',              'global', NULL, 'seed'),
  ('syn_log_pcl_3',       'Express Shipping',              'express shipping',                'LOG_PARCEL',              'global', NULL, 'seed'),

  -- TEL_*
  ('syn_tel_net_1',       'Network Services',              'network services',                'TEL_NETWORK',             'global', NULL, 'seed'),
  ('syn_tel_net_2',       'WAN',                           'wan',                             'TEL_NETWORK',             'global', NULL, 'seed'),
  ('syn_tel_net_3',       'MPLS',                          'mpls',                            'TEL_NETWORK',             'global', NULL, 'seed'),
  ('syn_tel_wls_1',       'Wireless Voice',                'wireless voice',                  'TEL_WIRELESS',            'global', NULL, 'seed'),
  ('syn_tel_wls_2',       'Cellular',                      'cellular',                        'TEL_WIRELESS',            'global', NULL, 'seed'),
  ('syn_tel_conf_1',      'Conferencing',                  'conferencing',                    'TEL_CONFERENCING',        'global', NULL, 'seed'),
  ('syn_tel_conf_2',      'Video Conferencing',            'video conferencing',              'TEL_CONFERENCING',        'global', NULL, 'seed'),
  ('syn_tel_conf_3',      'Audio Conferencing',            'audio conferencing',              'TEL_CONFERENCING',        'global', NULL, 'seed'),

  -- TRV_*
  ('syn_trv_tmc_1',       'Travel Management',             'travel management',               'TRV_TMC',                 'global', NULL, 'seed'),
  ('syn_trv_tmc_2',       'TMC',                           'tmc',                             'TRV_TMC',                 'global', NULL, 'seed'),
  ('syn_trv_air_1',       'Airfare',                       'airfare',                         'TRV_AIR',                 'global', NULL, 'seed'),
  ('syn_trv_air_2',       'Corporate Air Travel',          'corporate air travel',            'TRV_AIR',                 'global', NULL, 'seed'),
  ('syn_trv_htl_1',       'Hotels',                        'hotels',                          'TRV_HOTEL',               'global', NULL, 'seed'),
  ('syn_trv_htl_2',       'Lodging',                       'lodging',                         'TRV_HOTEL',               'global', NULL, 'seed'),
  ('syn_trv_grd_1',       'Ground Transportation',         'ground transportation',           'TRV_GROUND',              'global', NULL, 'seed'),
  ('syn_trv_grd_2',       'Car Rental',                    'car rental',                      'TRV_GROUND',              'global', NULL, 'seed'),
  ('syn_trv_grd_3',       'Rideshare',                     'rideshare',                       'TRV_GROUND',              'global', NULL, 'seed'),

  -- FIN_*
  ('syn_fin_bank_1',      'Banking Services',              'banking services',                'FIN_BANKING',             'global', NULL, 'seed'),
  ('syn_fin_bank_2',      'Bank Fees',                     'bank fees',                       'FIN_BANKING',             'global', NULL, 'seed'),
  ('syn_fin_ins_1',       'Insurance',                     'insurance',                       'FIN_INSURANCE',           'global', NULL, 'seed'),
  ('syn_fin_ins_2',       'P&C Insurance',                 'p&c insurance',                   'FIN_INSURANCE',           'global', NULL, 'seed'),
  ('syn_fin_treas_1',     'Treasury Services',             'treasury services',               'FIN_TREASURY',            'global', NULL, 'seed'),
  ('syn_fin_treas_2',     'Cash Management',               'cash management',                 'FIN_TREASURY',            'global', NULL, 'seed'),
  ('syn_fin_aud_1',       'External Audit',                'external audit',                  'FIN_AUDIT_EXTERNAL',      'global', NULL, 'seed'),
  ('syn_fin_aud_2',       'Statutory Audit',               'statutory audit',                 'FIN_AUDIT_EXTERNAL',      'global', NULL, 'seed'),

  -- ENG_*
  ('syn_eng_rnd_1',       'Research & Development',        'research & development',          'ENG_RND',                 'global', NULL, 'seed'),
  ('syn_eng_rnd_2',       'R&D Services',                  'r&d services',                    'ENG_RND',                 'global', NULL, 'seed'),
  ('syn_eng_des_1',       'Engineering Design',            'engineering design',              'ENG_DESIGN',              'global', NULL, 'seed'),
  ('syn_eng_des_2',       'Product Design',                'product design',                  'ENG_DESIGN',              'global', NULL, 'seed'),
  ('syn_eng_test_1',      'Testing & Certification',       'testing & certification',         'ENG_TESTING_CERT',        'global', NULL, 'seed'),
  ('syn_eng_test_2',      'Quality Certification',         'quality certification',           'ENG_TESTING_CERT',        'global', NULL, 'seed')
ON CONFLICT (normalized) WHERE scope = 'global' AND superseded_at IS NULL DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- Refresh the routing materialized view so the freshly-seeded
-- category × band × lever rows are visible to readers immediately.
-- The view's row trigger refreshes on writes to the truth table;
-- this final REFRESH covers cold-boot seeding when triggers may not
-- yet have fired or where seeds were applied with triggers disabled.
--
-- The view is created at API boot via `bootstrapCategoryLeverMappings`
-- (see artifacts/api-server/src/lib/intelligence/routing/materialized-view.ts)
-- which runs BEFORE workers start. On a cold DB (seed before first
-- API boot) the view will not yet exist, so we no-op the refresh
-- with a guard rather than fail the seed transaction.
-- ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_matviews WHERE matviewname = 'v_category_lever_mappings'
  ) THEN
    REFRESH MATERIALIZED VIEW v_category_lever_mappings;
  END IF;
END $$;
