import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { TRPCError } from "@trpc/server";
import {
  clearOwnerCookie,
  getOwnerStatus,
  loginOwner,
  logoutOwner,
  OwnerRateLimitError,
  setOwnerCookie,
  setupOwner,
} from "./service";

function failure(res: Response, error: unknown) {
  const statuses: Record<string, number> = {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    CONFLICT: 409,
    TOO_MANY_REQUESTS: 429,
  };
  if (error instanceof OwnerRateLimitError)
    res.setHeader("retry-after", String(error.retryAfterSeconds));
  const status =
    error instanceof TRPCError ? (statuses[error.code] ?? 503) : 503;
  const message =
    error instanceof TRPCError && status !== 503
      ? error.message
      : "Owner authentication is unavailable. Please try again later.";
  res.status(status).json({ error: message });
}

export function registerOwnerAuthRoutes(app: Express) {
  app.use(
    "/api/owner",
    express.json({ limit: "8kb", strict: true }),
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.setHeader("cache-control", "no-store");
      const tooLarge =
        (error as { type?: string } | null)?.type === "entity.too.large";
      res.status(tooLarge ? 413 : 400).json({
        error: tooLarge
          ? "The sign-in request is too large."
          : "Use a valid JSON sign-in request.",
      });
    }
  );
  const route =
    (operation: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("pragma", "no-cache");
      try {
        await operation(req, res);
      } catch (error) {
        failure(res, error);
      }
    };

  app.get(
    "/api/owner/session",
    route(async (req, res) => {
      res.json(await getOwnerStatus(req));
    })
  );
  app.post(
    "/api/owner/setup",
    route(async (req, res) => {
      const result = await setupOwner(req, req.body);
      setOwnerCookie(req, res, result.sealedCookie);
      res.json(result.status);
    })
  );
  app.post(
    "/api/owner/login",
    route(async (req, res) => {
      const result = await loginOwner(req, req.body);
      setOwnerCookie(req, res, result.sealedCookie);
      res.json(result.status);
    })
  );
  app.post(
    "/api/owner/logout",
    route(async (req, res) => {
      const status = await logoutOwner(req);
      clearOwnerCookie(req, res);
      res.json(status);
    })
  );
}
