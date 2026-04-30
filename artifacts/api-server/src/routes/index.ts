import { Router, type IRouter } from "express";
import healthRouter from "./health";
import orgsRouter from "./orgs";
import meRouter from "./me";
import spendRouter from "./spend";
import suppliersRouter from "./suppliers";
import opportunitiesRouter from "./opportunities";
import cyclesRouter from "./cycles";
import collectorsRouter from "./collectors";
import marketSignalsRouter from "./market-signals";
import jobsRouter from "./jobs";
import ingestRouter from "./ingest";
import billingRouter from "./billing";
import watchedIssuersRouter from "./watched-issuers";

const router: IRouter = Router();

router.use(healthRouter);
router.use(orgsRouter);
router.use(meRouter);
router.use(spendRouter);
router.use(suppliersRouter);
router.use(opportunitiesRouter);
router.use(cyclesRouter);
router.use(collectorsRouter);
router.use(marketSignalsRouter);
router.use(jobsRouter);
router.use(ingestRouter);
router.use(billingRouter);
router.use(watchedIssuersRouter);

export default router;
