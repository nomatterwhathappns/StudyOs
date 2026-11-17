import "dotenv/config";
import express, { type Express } from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { registerStudyChatStream } from "../studyChatStream";
import { createContext } from "./context";
import { isLocalStudyMode } from "../runtimeMode";
import { TRPCError } from "@trpc/server";
import { registerOwnerAuthRoutes } from "../owner-auth/routes";
import { authEnabled, getOwnerSession } from "../owner-auth/service";

/** API only: safe to import in a function without starting a local listener. */
export async function createApp(): Promise<Express> {
  const app = express();

  // Authentication has its own small parser. Anonymous business requests must
  // be rejected before the upload parser consumes their potentially large body.
  registerOwnerAuthRoutes(app);
  app.use(["/api", "/manus-storage"], async (req, res, next) => {
    try {
      if (authEnabled()) {
        res.setHeader("cache-control", "no-store");
        const owner = await getOwnerSession(req);
        if (!owner) {
          res.status(401).json({
            error: "Sign in to continue.",
            code: "OWNER_AUTH_REQUIRED",
          });
          return;
        }
      }
      next();
    } catch (error) {
      const status =
        error instanceof TRPCError && error.code === "FORBIDDEN" ? 403 : 503;
      res.status(status).json({
        error:
          status === 403
            ? "This request is not allowed."
            : "Owner authentication is unavailable. Please try again later.",
      });
    }
  });

  // The hosting platform can impose a smaller request-body limit. Study data
  // and local uploads stay in the browser in the default study mode.
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  if (!isLocalStudyMode()) {
    registerStorageProxy(app);
    if (!authEnabled()) {
      const { registerOAuthRoutes } = await import("./oauth");
      registerOAuthRoutes(app);
    }
  }

  registerStudyChatStream(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({ router: appRouter, createContext })
  );

  // A missing API route must stay an API error, including on the local server.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  return app;
}
