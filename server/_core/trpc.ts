import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "@shared/const";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { authEnabled, getOwnerSession } from "../owner-auth/service";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!authEnabled()) return next();
  // A direct router caller can manufacture context fields. Only the session
  // service may establish owner identity, even if HTTP middleware was bypassed.
  const owner = await getOwnerSession(ctx.req);
  if (!owner)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in to continue.",
    });
  return next({ ctx: { ...ctx, owner, user: null } });
});

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (authEnabled() && ctx.owner) return next({ ctx });

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = publicProcedure.use(requireUser);

export const adminProcedure = publicProcedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (authEnabled() && ctx.owner) return next({ ctx });

    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  })
);
