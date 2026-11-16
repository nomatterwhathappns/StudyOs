import { existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import handler from "./vercel";

const projectRoot = resolve(import.meta.dirname, "..");

function readProjectFile(relativePath: string) {
  return readFileSync(resolve(projectRoot, relativePath), "utf8");
}

describe("Vercel deployment adapter", () => {
  it("targets a real API function rather than an unrecognized root file", () => {
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const vercelConfig = JSON.parse(readProjectFile("vercel.json")) as {
      buildCommand?: string;
      outputDirectory?: string;
      functions?: Record<string, { runtime?: string; maxDuration?: number }>;
      rewrites?: Array<{ source: string; destination: string }>;
    };

    for (const filename of Object.keys(vercelConfig.functions ?? {})) {
      expect(filename).toMatch(/^api\/.+\.mjs$/);
      expect(existsSync(resolve(projectRoot, filename))).toBe(true);
    }
    expect(packageJson.scripts?.["build:vercel"]).toContain(
      "VITE_DEPLOY_TARGET=vercel"
    );
    expect(packageJson.scripts?.["build:vercel"]).toContain(
      "cp -R dist/public public"
    );
    expect(vercelConfig.buildCommand).toBe("pnpm build:vercel");
    expect(vercelConfig.outputDirectory).toBe("public");
    expect(packageJson.scripts?.["build:vercel"]).toMatch(/^pnpm check &&/);
    expect(packageJson.scripts?.["build:vercel"]).toContain(
      "esbuild server/vercel.ts"
    );
    expect(packageJson.scripts?.["build:vercel"]).toContain(
      "--outfile=dist/serverless.js"
    );
    expect(readProjectFile("api/server.mjs")).toContain(
      'export { default } from "../dist/serverless.js"'
    );
    expect(vercelConfig.functions?.["api/server.mjs"]?.runtime).toBeUndefined();
    expect(vercelConfig.functions?.["api/server.mjs"]?.maxDuration).toBe(300);
    expect(vercelConfig.rewrites).toEqual(
      expect.arrayContaining([
        { source: "/api/:path*", destination: "/api/server" },
        { source: "/manus-storage/:path*", destination: "/api/server" },
        { source: "/studych", destination: "/index.html" },
        { source: "/sessions", destination: "/index.html" },
      ])
    );
  });

  it("does not put the beta token or upstream API key in deployment config", () => {
    const trackedDeploymentFiles = [
      "api/server.mjs",
      "server/vercel.ts",
      "vercel.json",
      "package.json",
      "server/_core/app.ts",
    ]
      .map(readProjectFile)
      .join("\n");

    expect(trackedDeploymentFiles).not.toMatch(
      /STUDYOS_PUBLIC_TOKEN|NINE_ROUTER_API_KEY|sk-[A-Za-z0-9_-]{12,}/
    );
  });
});

describe("Vercel API handler over HTTP", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handler(
        req as Parameters<typeof handler>[0],
        res as Parameters<typeof handler>[1]
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  });

  it("serves tRPC through the function without starting a separate listener", async () => {
    const input = encodeURIComponent(
      JSON.stringify({ json: { timestamp: 0 } })
    );
    const response = await fetch(
      `${baseUrl}/api/trpc/system.health?input=${input}`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      result: { data: { json: { ok: true } } },
    });
  });

  it("returns JSON for unknown API routes instead of leaking the SPA fallback", async () => {
    const response = await fetch(`${baseUrl}/api/unknown`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "API route not found" });
  });
});
