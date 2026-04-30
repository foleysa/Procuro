import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default router;
