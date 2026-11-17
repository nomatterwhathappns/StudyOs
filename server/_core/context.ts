import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { isLocalStudyMode } from "../runtimeMode";
import {
  authEnabled,
  getOwnerSession,
  type OwnerSession,
} from "../owner-auth/service";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  owner?: OwnerSession | null;
};

export async function createContext(
  opts: Pick<CreateExpressContextOptions, "req" | "res">
): Promise<TrpcContext> {
  let user: User | null = null;
  const ownerMode = authEnabled();
  const owner = ownerMode ? await getOwnerSession(opts.req) : undefined;

  if (!ownerMode && !isLocalStudyMode()) {
    try {
      const { sdk } = await import("./sdk");
      user = await sdk.authenticateRequest(opts.req);
    } catch (error) {
      // Authentication is optional for public procedures.
      user = null;
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    ...(ownerMode ? { owner } : {}),
  };
}
