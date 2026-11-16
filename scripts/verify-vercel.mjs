import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
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
assert.equal(process.env.STUDYOS_CLOUD_ACCESS, "vercel-protected");
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

// Exercise the exact compiled function with production host validation and
// storage credentials, inside this trusted build runner on loopback only.
const { default: handler } = await import("../api/server.mjs");
const localServer = createServer((req, res) => void handler(req, res));
await new Promise(resolve => localServer.listen(0, "127.0.0.1", resolve));
try {
  const host =
    process.env.STUDYOS_PUBLIC_HOSTS?.split(",")[0]?.trim() ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL;
  assert(host, "Configure the protected production hostname before deploying.");
  const address = localServer.address();
  // Node fetch intentionally discards a custom Host header. Use the HTTP
  // client so this private probe reproduces the production ingress hostname.
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: "/api/trpc/aiConnections.list",
        headers: {
          host,
          origin: `https://${host}`,
          "sec-fetch-site": "same-origin",
        },
        signal: AbortSignal.timeout(35_000),
      },
      response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(
    response.status,
    200,
    "Compiled function cannot read private AI settings with the production host configuration."
  );
  const result = JSON.parse(response.body);
  assert(Array.isArray(result.result?.data?.json?.connections));
  console.log(
    "[StudyOS verification] Compiled function HTTP, production host access, and private AI settings passed."
  );
} finally {
  localServer.closeAllConnections();
  await new Promise(resolve => localServer.close(resolve));
}

// An optional existing deployment can be checked with the project's own
// short-lived production identity. This does not create a public share link or
// change Deployment Protection / Trusted Sources rules.
if (process.env.STUDYOS_VERIFY_DEPLOYMENT) {
  const base = new URL(process.env.STUDYOS_VERIFY_DEPLOYMENT);
  const allowed = new Set([
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    ...(process.env.STUDYOS_PUBLIC_HOSTS?.split(",").map(host => host.trim()) ??
      []),
  ]);
  assert(
    base.protocol === "https:" && allowed.has(base.host),
    "Verification target must be this project's trusted HTTPS hostname."
  );
  assert.equal(base.pathname, "/");
  assert.equal(base.search, "");
  assert.equal(base.hash, "");
  const token = process.env.VERCEL_OIDC_TOKEN;
  assert(token, "Vercel production identity is unavailable.");
  const request = async path => {
    const response = await fetch(new URL(path, base), {
      headers: {
        "x-vercel-trusted-oidc-idp-token": token,
        origin: base.origin,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(
      response.status,
      200,
      `Authenticated deployment check failed for ${path.split("?")[0]} (HTTP ${response.status}); keep protection enabled.`
    );
    return response;
  };
  const input = encodeURIComponent(JSON.stringify({ json: { timestamp: 0 } }));
  const health = await (
    await request(`/api/trpc/system.health?input=${input}`)
  ).json();
  assert.equal(health.result?.data?.json?.ok, true);
  const connections = await (
    await request("/api/trpc/aiConnections.list")
  ).json();
  assert(Array.isArray(connections.result?.data?.json?.connections));
  for (const connection of connections.result.data.json.connections) {
    assert(
      !Object.hasOwn(connection, "apiKey") &&
        !Object.hasOwn(connection, "extraHeaders")
    );
  }
  for (const path of ["/", "/sessions", "/studych"]) {
    const response = await request(path);
    assert(response.headers.get("content-type")?.includes("text/html"));
    assert((await response.text()).includes('id="root"'));
  }
  console.log(
    "[StudyOS verification] Authenticated production HTTP routes, health, and private AI settings passed."
  );
}
