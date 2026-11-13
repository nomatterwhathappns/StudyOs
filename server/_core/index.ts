import "dotenv/config";
import express, { type Express } from "express";
import { createServer, type Server } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { registerStudyChatStream } from "../studyChatStream";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { isLocalStudyMode } from "../runtimeMode";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

export async function createApp(server?: Server): Promise<Express> {
  const app = express();
  const localStudyMode = isLocalStudyMode();

  // Configure body parser with the existing local limit. Vercel upload limits
  // are handled separately by the deployment adapter and direct storage flow.
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  if (!localStudyMode) {
    registerStorageProxy(app);
    const { registerOAuthRoutes } = await import("./oauth");
    registerOAuthRoutes(app);
  } else {
    console.log("[StudyOS] Local mode enabled: cloud OAuth, storage proxy, and analytics are disabled.");
  }

  registerStudyChatStream(app);

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  if (process.env.NODE_ENV === "development") {
    if (!server) {
      throw new Error("A development HTTP server is required for Vite middleware.");
    }
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  return app;
}

async function startServer() {
  const server = createServer();
  const app = await createApp(server);
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.on("request", app);
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

// Vercel imports the exported app from the root `server.ts` entrypoint.
// The local process still owns its HTTP listener for `pnpm dev`/`pnpm start`.
if (process.env.VERCEL !== "1") {
  startServer().catch(console.error);
}
