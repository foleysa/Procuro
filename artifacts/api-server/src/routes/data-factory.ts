/**
 * Data Factory API spine — authenticated reads of packaged Layer A
 * public datasets + Layer C taxonomy + usage-log metering.
 *
 * Honest beta. Does not serve tenant spend, FSA client files, or
 * invented benchmarks. See DATA-FACTORY-DAY0.md.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db, dataFactoryUsageLogTable } from "@workspace/db";
import {
  dataFactoryStatus,
  getDataFactorySource,
  layerCTaxonomyPayload,
  listDataFactoryPackages,
  listDataFactorySources,
  packageLayerADataset,
  type DataFactoryChannelUse,
  type DataFactoryDay0Tier,
  type DataFactoryFetchStatus,
  type DataFactoryLicenseClass,
  type DataFactorySourceFamily,
} from "@workspace/data-factory";
import { tenantMiddleware } from "../lib/tenant";
import { requirePermission } from "../lib/rbac";
import { NotFoundError, InvalidRequestError } from "../lib/api-errors";
import { newId } from "../lib/ids";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const SOURCE_FAMILIES = new Set([
  "procurement",
  "index",
  "freight_commodity",
  "disruption",
  "filing",
]);
const FETCH_STATUSES = new Set([
  "wired_existing_collector",
  "stub",
  "license_required",
]);
const LICENSE_CLASSES = new Set([
  "public_api",
  "free_registration",
  "paid_license_required",
]);
const DAY0_TIERS = new Set(["tier_1", "tier_2", "license_required"]);
const CHANNEL_USES = new Set(["pulse", "api", "both"]);

async function meterRead(
  req: Request,
  res: Response,
  extra: { packageId?: string; sourceId?: string },
): Promise<void> {
  try {
    await db.insert(dataFactoryUsageLogTable).values({
      id: newId("dfu"),
      orgId: req.orgId ?? null,
      actor: req.actorEmail ?? "unknown",
      route: req.path,
      packageId: extra.packageId ?? null,
      sourceId: extra.sourceId ?? null,
      statusCode: String(res.statusCode || 200),
      metadata: {
        release: "beta",
        ga: false,
        layer: "A",
      },
    });
  } catch (err) {
    logger.warn({ err, route: req.path }, "data-factory usage log write failed");
  }
}

router.get(
  "/data-factory",
  tenantMiddleware,
  requirePermission("read"),
  async (req, res) => {
    const body = {
      ...dataFactoryStatus(),
      packages: listDataFactoryPackages().map((p) => ({
        id: p.id,
        title: p.title,
        family: p.family,
        channelUse: p.channelUse,
        pulseSurface: p.pulseSurface,
      })),
    };
    res.json(body);
    await meterRead(req, res, {});
  },
);

router.get(
  "/data-factory/sources",
  tenantMiddleware,
  requirePermission("read"),
  async (req, res) => {
    const family = req.query.family;
    const fetchStatus = req.query.fetchStatus;
    const licenseClass = req.query.licenseClass;
    const day0Tier = req.query.day0Tier;
    const channelUse = req.query.channelUse;
    if (typeof family === "string" && !SOURCE_FAMILIES.has(family)) {
      throw new InvalidRequestError("Unknown source family");
    }
    if (
      typeof fetchStatus === "string" &&
      !FETCH_STATUSES.has(fetchStatus)
    ) {
      throw new InvalidRequestError("Unknown fetch status");
    }
    if (
      typeof licenseClass === "string" &&
      !LICENSE_CLASSES.has(licenseClass)
    ) {
      throw new InvalidRequestError("Unknown license class");
    }
    if (typeof day0Tier === "string" && !DAY0_TIERS.has(day0Tier)) {
      throw new InvalidRequestError("Unknown day0Tier");
    }
    if (typeof channelUse === "string" && !CHANNEL_USES.has(channelUse)) {
      throw new InvalidRequestError("Unknown channelUse");
    }
    const sources = listDataFactorySources({
      family:
        typeof family === "string"
          ? (family as DataFactorySourceFamily)
          : undefined,
      fetchStatus:
        typeof fetchStatus === "string"
          ? (fetchStatus as DataFactoryFetchStatus)
          : undefined,
      licenseClass:
        typeof licenseClass === "string"
          ? (licenseClass as DataFactoryLicenseClass)
          : undefined,
      day0Tier:
        typeof day0Tier === "string"
          ? (day0Tier as DataFactoryDay0Tier)
          : undefined,
      channelUse:
        typeof channelUse === "string"
          ? (channelUse as DataFactoryChannelUse)
          : undefined,
    });
    res.json({
      release: "beta",
      ga: false,
      layer: "A",
      count: sources.length,
      sources,
    });
    await meterRead(req, res, {});
  },
);

router.get(
  "/data-factory/sources/:sourceId",
  tenantMiddleware,
  requirePermission("read"),
  async (req, res) => {
    const source = getDataFactorySource(String(req.params.sourceId));
    if (!source) {
      throw new NotFoundError("Unknown Layer A source");
    }
    res.json({ release: "beta", ga: false, layer: "A", source });
    await meterRead(req, res, { sourceId: source.id });
  },
);

router.get(
  "/data-factory/packages",
  tenantMiddleware,
  requirePermission("read"),
  async (req, res) => {
    const channelUse = req.query.channelUse;
    if (typeof channelUse === "string" && !CHANNEL_USES.has(channelUse)) {
      throw new InvalidRequestError("Unknown channelUse");
    }
    res.json({
      release: "beta",
      ga: false,
      layer: "A",
      packages: listDataFactoryPackages({
        channelUse:
          typeof channelUse === "string"
            ? (channelUse as DataFactoryChannelUse)
            : undefined,
      }),
    });
    await meterRead(req, res, {});
  },
);

router.get(
  "/data-factory/packages/:packageId",
  tenantMiddleware,
  requirePermission("read"),
  async (req, res) => {
    const packed = packageLayerADataset(String(req.params.packageId));
    if (!packed) {
      throw new NotFoundError("Unknown Layer A package");
    }
    res.json(packed);
    await meterRead(req, res, { packageId: packed.package.id });
  },
);

router.get(
  "/data-factory/layer-c/taxonomy",
  tenantMiddleware,
  requirePermission("read"),
  async (req, res) => {
    res.json({
      release: "beta",
      ga: false,
      ...layerCTaxonomyPayload(),
    });
    await meterRead(req, res, {});
  },
);

export default router;
