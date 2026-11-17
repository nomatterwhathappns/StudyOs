import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { BlobPreconditionFailedError, del, get, put } from "@vercel/blob";

if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "production") {
  console.log(
    "[StudyOS verification] Cloud checks run only in Vercel production builds."
  );
  process.exit(0);
}

// Run inside an authenticated production build, never in the browser. Probe
// objects have their own namespace and do not change the owner's connections.
assert.equal(process.env.VERCEL, "1", "Run this check in Vercel.");
assert.equal(
  process.env.VERCEL_ENV,
  "production",
  "Use production credentials."
);
const key = Buffer.from(process.env.STUDYOS_AI_MASTER_KEY ?? "", "base64");
assert.equal(key.length, 32, "Cloud encryption key is not configured.");
assert.equal(process.env.STUDYOS_AI_STORAGE, "vercel-blob");
assert.equal(
  process.env.STUDYOS_OWNER_AUTH,
  "enabled",
  "Production requires owner authentication."
);
assert(
  (process.env.STUDYOS_OWNER_SESSION_SECRET ?? "").length >= 32,
  "Owner session encryption is not configured."
);
const privateValues = [
  process.env.STUDYOS_OWNER_SESSION_SECRET,
  process.env.STUDYOS_OWNER_SETUP_KEY,
  process.env.STUDYOS_AI_MASTER_KEY,
  process.env.BLOB_READ_WRITE_TOKEN,
  process.env.VERCEL_OIDC_TOKEN,
].filter(value => typeof value === "string" && value.length >= 24);
async function checkPublicAssets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkPublicAssets(filename);
    else if (/\.(?:html|css|js|mjs|json|map)$/.test(entry.name)) {
      const text = await readFile(filename, "utf8");
      assert(
        !privateValues.some(value => text.includes(value)),
        "A server secret was found in public build output."
      );
    }
  }
}
await checkPublicAssets("public");
console.log(
  "[StudyOS verification] Public build output contains no server secrets."
);
const signal = AbortSignal.timeout(45_000);
const pathname = `studyos/deployment-checks/${randomUUID()}.json`;
const encrypt = value => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
};

try {
  const initial = encrypt("StudyOS private storage check");
  await put(pathname, initial, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    abortSignal: signal,
  });
  const first = await get(pathname, {
    access: "private",
    useCache: false,
    abortSignal: signal,
  });
  assert(first && first.statusCode === 200);
  assert.equal(await new Response(first.stream).text(), initial);
  const updated = encrypt("StudyOS conditional update check");
  await put(pathname, updated, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    ifMatch: first.blob.etag,
    abortSignal: signal,
  });
  await assert.rejects(
    put(pathname, initial, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      ifMatch: first.blob.etag,
      abortSignal: signal,
    }),
    BlobPreconditionFailedError
  );
  const latest = await get(pathname, {
    access: "private",
    useCache: false,
    abortSignal: signal,
  });
  assert(latest && latest.statusCode === 200);
  assert.equal(await new Response(latest.stream).text(), updated);
  console.log(
    "[StudyOS verification] Private encrypted Blob read/write and conflict protection passed."
  );
} finally {
  await del(pathname, { abortSignal: AbortSignal.timeout(15_000) });
}

// Exercise the exact compiled function without creating the real owner's
// account. The owner chooses credentials later in the private setup form.
const { default: handler } = await import("../api/server.mjs");
const localServer = createServer((req, res) => void handler(req, res));
await new Promise(resolve => localServer.listen(0, "127.0.0.1", resolve));
const protectedPaths = [
  ["GET", "/api/trpc/aiConnections.list"],
  [
    "GET",
    "/api/trpc/system.health?input=" +
      encodeURIComponent(JSON.stringify({ json: { timestamp: 0 } })),
  ],
  ["POST", "/api/study/chat-stream"],
  ["POST", "/api/trpc/study.uploadDocument"],
  ["GET", "/manus-storage/owner-verification"],
];
const checkOwnerBoundary = async (request, label) => {
  const response = await request("GET", "/api/owner/session");
  assert.equal(response.status, 200, `${label}: session status unavailable.`);
  const state = JSON.parse(response.body);
  assert.equal(state.enabled, true);
  assert.equal(state.authenticated, false);
  assert.equal(typeof state.setupRequired, "boolean");
  assert(!Object.hasOwn(state, "username"));
  for (const [method, path] of protectedPaths) {
    const result = await request(method, path);
    assert.equal(
      result.status,
      401,
      `${label}: anonymous access to ${path} must be denied.`
    );
  }
  const forged = await request("GET", "/api/trpc/aiConnections.list", {
    cookie: "__Host-studyos_owner=forged-session",
  });
  assert.equal(forged.status, 401);
  // Invalid fields are rejected before reserving a password-attempt slot.
  // No probe can claim the owner's account or consume provider quota.
  for (const path of ["/api/owner/setup", "/api/owner/login"]) {
    const result = await request("POST", path);
    assert(
      (path.endsWith("/setup") ? [400, 403, 409] : [400]).includes(
        result.status
      ),
      `${label}: empty authentication input must be rejected.`
    );
  }
  const crossSite = await request("POST", "/api/owner/login", {
    origin: "https://untrusted.example",
  });
  assert.equal(crossSite.status, 403);
  console.log(
    `[StudyOS verification] ${label}: owner setup/login boundary, anonymous API denial, forged-cookie rejection, and origin checks passed.`
  );
};
try {
  const host =
    process.env.STUDYOS_PUBLIC_HOSTS?.split(",")[0]?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL;
  assert(host, "Configure the protected production hostname.");
  const address = localServer.address();
  const request = async (method, path, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method,
          headers: {
            host,
            origin: `https://${host}`,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            ...headers,
          },
          signal: AbortSignal.timeout(35_000),
        },
        res => {
          const chunks = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            })
          );
        }
      );
      req.on("error", reject);
      req.end(method === "POST" ? "{}" : undefined);
    });
  await checkOwnerBoundary(request, "Compiled function");
} finally {
  localServer.closeAllConnections();
  await new Promise(resolve => localServer.close(resolve));
}

// Optional release check uses the project's short-lived Vercel identity only
// to cross the platform perimeter. It must NEVER grant an application session.
if (process.env.STUDYOS_VERIFY_DEPLOYMENT) {
  const base = new URL(process.env.STUDYOS_VERIFY_DEPLOYMENT);
  const allowed = new Set([
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    ...(process.env.STUDYOS_PUBLIC_HOSTS?.split(",").map(host => host.trim()) ??
      []),
  ]);
  assert(
    base.protocol === "https:" &&
      allowed.has(base.host) &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash
  );
  const token = process.env.VERCEL_OIDC_TOKEN;
  assert(token, "Vercel production identity is unavailable.");
  const request = async (method, path, headers = {}) => {
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        origin: base.origin,
        "content-type": "application/json",
        "x-vercel-trusted-oidc-idp-token": token,
        ...headers,
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.text() };
  };
  await checkOwnerBoundary(request, "Production HTTP");
  for (const path of ["/", "/sessions", "/studych"]) {
    const page = await request("GET", path);
    assert.equal(page.status, 200);
    assert(page.body.includes('id="root"'));
    assert(!page.body.includes('id="manus-runtime"'));
  }
  console.log(
    "[StudyOS verification] Production login shell routes passed; Vercel identity alone cannot access owner data."
  );
}
