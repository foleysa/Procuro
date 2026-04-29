import { Router, type IRouter } from "express";
import healthRouter from "./health";
import orgsRouter from "./orgs";
import agentsRouter from "./agents";
import claimsRouter from "./claims";
import ledgerRouter from "./ledger";

const router: IRouter = Router();

router.use(healthRouter);
router.use(orgsRouter);
router.use(agentsRouter);
router.use(claimsRouter);
router.use(ledgerRouter);

export default router;
