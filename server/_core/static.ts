import express, { type Express } from "express";
import fs from "node:fs";
import path from "node:path";

/** Local production assets; Vercel serves its public directory through CDN. */
export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(path.join(distPath, "index.html"))) {
    throw new Error(
      `Could not find the client build at ${distPath}. Run pnpm build before pnpm start.`
    );
  }

  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}
