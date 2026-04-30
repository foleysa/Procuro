declare global {
  namespace Express {
    interface Request {
      orgId?: string;
      actorEmail?: string;
      authMode?: "token" | "dev-header" | "dev-fallback";
    }
  }
}

export {};
