import type { UserRoleName } from "@workspace/db";

declare global {
  namespace Express {
    interface Request {
      orgId?: string;
      actorEmail?: string;
      authMode?:
        | "token"
        | "api-key"
        | "clerk"
        | "dev-header"
        | "dev-fallback";
      clerkUserId?: string;
      rbac?: {
        userId: string | null;
        email: string;
        roles: UserRoleName[];
        viaApiKey: boolean;
      };
    }
  }
}

export {};
