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
  ('cb_packaging_frg',            'PACKAGING_GENERAL',      'fragmented',   1.00, 'seed')
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
  ('syn_pkg_4',  'Rigid Packaging',                       'rigid packaging',                 'PACKAGING_GENERAL',    'global', NULL, 'seed')
ON CONFLICT (normalized) WHERE scope = 'global' DO NOTHING;

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
