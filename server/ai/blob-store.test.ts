import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobPreconditionFailedError } from "@vercel/blob";
import {
  activateConnection,
  deleteConnection,
  getActiveConnection,
  getConnection,
  listConnections,
  saveConnection,
} from "./connection-store";

const sdk = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@vercel/blob", () => ({
  get: sdk.get,
  put: sdk.put,
  BlobPreconditionFailedError: class extends Error {},
}));

let stored: { body: string; etag: string } | undefined;
let revision = 0;
const draft = (name: string) => ({
  name,
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "private-api-secret-1234",
  extraHeaders: { "x-secret": "private-header-secret" },
});

beforeEach(() => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("STUDYOS_AI_STORAGE", "vercel-blob");
  vi.stubEnv("STUDYOS_AI_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-private-blob-token");
  vi.stubEnv("BLOB_STORE_ID", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  stored = undefined;
  revision = 0;
  sdk.get.mockReset().mockImplementation(async () => {
    if (!stored) return null;
    const { body, etag } = stored;
    return {
      statusCode: 200,
      blob: { etag, size: Buffer.byteLength(body) },
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(body));
          controller.close();
        },
      }),
    };
  });
  sdk.put.mockReset().mockImplementation(async (_path, body, options) => {
    if (stored && !options.allowOverwrite)
      throw new Error("Blob already exists");
    if (options.ifMatch && options.ifMatch !== stored?.etag)
      throw new BlobPreconditionFailedError();
    stored = { body, etag: `revision-${++revision}` };
    return { etag: stored.etag };
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("private Blob AI connection storage", () => {
  it("encrypts credentials and preserves all Profile operations across fresh reads", async () => {
    expect(await listConnections()).toEqual({
      connections: [],
      activeId: null,
    });
    const first = await saveConnection(draft("First"));
    const second = await saveConnection(draft("Second"));
    expect(stored?.body).not.toContain("private-api-secret");
    expect(stored?.body).not.toContain("private-header-secret");
    expect(first).not.toHaveProperty("apiKey");
    await activateConnection(first.id);
    expect(await getActiveConnection()).toMatchObject({
      id: first.id,
      apiKey: "private-api-secret-1234",
    });
    await saveConnection({
      ...draft("Renamed"),
      id: first.id,
      apiKey: "",
      extraHeaders: undefined,
    });
    expect(await getConnection(first.id)).toMatchObject({
      name: "Renamed",
      apiKey: "private-api-secret-1234",
      extraHeaders: { "x-secret": "private-header-secret" },
    });
    expect(await deleteConnection(first.id)).toEqual({ activeId: null });
    expect(await listConnections()).toEqual({
      activeId: null,
      connections: [second],
    });
    expect(sdk.get).toHaveBeenCalledWith(
      "studyos/ai-connections-v1.json",
      expect.objectContaining({ access: "private", useCache: false })
    );
    expect(sdk.put.mock.calls[0][2]).toMatchObject({
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(sdk.put.mock.calls[1][2]).toMatchObject({
      allowOverwrite: true,
      ifMatch: "revision-1",
    });
  });

  it("merges simultaneous initial creations without overwriting either connection", async () => {
    const created = await Promise.all([
      saveConnection(draft("First")),
      saveConnection(draft("Second")),
    ]);
    const listed = await listConnections();
    expect(listed.connections.map(connection => connection.id).sort()).toEqual(
      created.map(connection => connection.id).sort()
    );
    expect(sdk.put).toHaveBeenCalledTimes(3);
    expect(sdk.put.mock.calls[2][2]).toMatchObject({
      allowOverwrite: true,
      ifMatch: "revision-1",
    });
  });

  it("reapplies updates against fresh state after an ETag conflict", async () => {
    const first = await saveConnection(draft("First"));
    const second = await saveConnection(draft("Second"));
    await Promise.all([
      saveConnection({ ...draft("Updated first"), id: first.id }),
      saveConnection({ ...draft("Updated second"), id: second.id }),
    ]);
    expect(
      (await listConnections()).connections.map(item => item.name)
    ).toEqual(["Updated first", "Updated second"]);
    expect(sdk.put).toHaveBeenCalledTimes(5);
    expect(sdk.put.mock.calls.at(-1)?.[2]).toMatchObject({
      ifMatch: "revision-3",
    });
  });

  it("keeps the same creation identity after an interrupted successful first write", async () => {
    const original = sdk.put.getMockImplementation()!;
    sdk.put.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("Connection closed after commit");
    });
    const saved = await saveConnection(draft("Single connection"));
    expect((await listConnections()).connections).toEqual([saved]);
  });

  it("returns a bounded conflict without unsafe writes under continuous contention", async () => {
    await saveConnection(draft("Existing"));
    const previous = stored?.body;
    sdk.put.mockClear().mockRejectedValue(new BlobPreconditionFailedError());
    await expect(saveConnection(draft("Another"))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(sdk.put).toHaveBeenCalledTimes(5);
    expect(stored?.body).toBe(previous);
    expect(
      sdk.put.mock.calls.every(call => call[2].ifMatch === "revision-1")
    ).toBe(true);
  });

  it("rejects wrong keys and damaged ciphertext without replacing saved data", async () => {
    await saveConnection(draft("Existing"));
    const original = stored!.body;
    const key = process.env.STUDYOS_AI_MASTER_KEY!;
    vi.stubEnv("STUDYOS_AI_MASTER_KEY", randomBytes(32).toString("base64"));
    await expect(saveConnection(draft("Do not replace"))).rejects.toMatchObject(
      {
        code: "INTERNAL_SERVER_ERROR",
      }
    );
    expect(stored?.body).toBe(original);
    vi.stubEnv("STUDYOS_AI_MASTER_KEY", key);
    stored!.body = "damaged encrypted envelope";
    await expect(listConnections()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(sdk.put).toHaveBeenCalledTimes(1);
  });

  it.each(["", "local", "unknown"])(
    "never falls back to local storage on Vercel when mode is %j",
    async mode => {
      vi.stubEnv("STUDYOS_AI_STORAGE", mode);
      await expect(listConnections()).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
      expect(sdk.get).not.toHaveBeenCalled();
      expect(sdk.put).not.toHaveBeenCalled();
    }
  );

  it.each(["", "invalid", Buffer.alloc(31).toString("base64")])(
    "rejects missing or invalid persistent encryption keys: %j",
    async key => {
      vi.stubEnv("STUDYOS_AI_MASTER_KEY", key);
      await expect(listConnections()).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
      expect(sdk.get).not.toHaveBeenCalled();
    }
  );

  it("requires Blob credentials and reports outages without resetting connections", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    await expect(listConnections()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(sdk.get).not.toHaveBeenCalled();
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-private-blob-token");
    sdk.get.mockRejectedValue(new Error("Blob unavailable"));
    await expect(listConnections()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(sdk.put).not.toHaveBeenCalled();
  });
});
