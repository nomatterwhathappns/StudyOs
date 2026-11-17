import { createCipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { BlobPreconditionFailedError } from "@vercel/blob";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mutateOwnerState, readOwnerState } from "./store";

const sdk = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@vercel/blob", () => ({
  get: sdk.get,
  put: sdk.put,
  BlobPreconditionFailedError: class extends Error {},
}));

const schema = z
  .object({
    version: z.literal(1),
    owner: z.string().nullable(),
    attempts: z.number().int().min(0),
    sessions: z.array(z.string()),
    payload: z.string(),
  })
  .strict();
type State = z.infer<typeof schema>;
const empty = (): State => ({
  version: 1,
  owner: null,
  attempts: 0,
  sessions: [],
  payload: "",
});
const reserve = (state: State) => ({
  state: { ...state, attempts: state.attempts + 1 },
  result: state.attempts + 1,
});
let directory: string;
let stored: { body: string; etag: string } | undefined;
let revision = 0;

function cloud() {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("STUDYOS_AI_STORAGE", "vercel-blob");
  vi.stubEnv("STUDYOS_AI_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-owner-private-token");
  vi.stubEnv("BLOB_STORE_ID", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
}

beforeEach(async () => {
  const root = path.resolve("tmp/owner-auth-tests");
  await fs.mkdir(root, { recursive: true });
  directory = await fs.mkdtemp(path.join(root, "store-"));
  vi.stubEnv("STUDYOS_DATA_DIR", directory);
  vi.stubEnv("STUDYOS_AI_STORAGE", "local");
  vi.stubEnv("VERCEL", "");
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
    if (stored && !options.allowOverwrite) throw new Error("Already exists");
    if (options.ifMatch && options.ifMatch !== stored?.etag)
      throw new BlobPreconditionFailedError();
    stored = { body, etag: `revision-${++revision}` };
    return { etag: stored.etag };
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("local owner authentication state", () => {
  it("leaves an empty read uninitialized and stores encrypted state with its own protected key", async () => {
    expect(await readOwnerState(schema, empty)).toEqual(empty());
    expect(await fs.readdir(directory)).toEqual([]);
    const aiKey = randomBytes(32);
    await fs.writeFile(path.join(directory, "master.key"), aiKey);
    await mutateOwnerState(schema, empty, state => ({
      state: {
        ...state,
        owner: "private-password-hash",
        sessions: ["private-session-hash"],
      },
      result: true,
    }));
    const serialized = await fs.readFile(
      path.join(directory, "owner-auth.json"),
      "utf8"
    );
    expect(serialized).not.toContain("private-password-hash");
    expect(serialized).not.toContain("private-session-hash");
    expect(await fs.readFile(path.join(directory, "master.key"))).toEqual(
      aiKey
    );
    const key = await fs.readFile(path.join(directory, "owner-auth.key"));
    expect(key).toHaveLength(32);
    expect(key).not.toEqual(aiKey);
    expect(await readOwnerState(schema, empty)).toMatchObject({
      owner: "private-password-hash",
      sessions: ["private-session-hash"],
    });
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    for (const filename of ["owner-auth.json", "owner-auth.key"]) {
      expect((await fs.stat(path.join(directory, filename))).mode & 0o777).toBe(
        0o600
      );
    }
    expect(await fs.readdir(directory)).not.toContain("owner-auth.lock");
    expect(sdk.get).not.toHaveBeenCalled();
  });

  it("serializes independent module instances without losing reserved attempts", async () => {
    vi.resetModules();
    const other = await import("./store");
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 ? other.mutateOwnerState : mutateOwnerState)(
          schema,
          empty,
          reserve
        )
      )
    );
    expect(results.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1)
    );
    expect((await readOwnerState(schema, empty)).attempts).toBe(24);
  });

  it("never regenerates a missing or damaged key for existing owner credentials", async () => {
    await mutateOwnerState(schema, empty, reserve);
    const filename = path.join(directory, "owner-auth.json");
    const original = await fs.readFile(filename, "utf8");
    await fs.unlink(path.join(directory, "owner-auth.key"));
    await expect(
      mutateOwnerState(schema, empty, reserve)
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    await expect(
      fs.stat(path.join(directory, "owner-auth.key"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(directory, "owner-auth.key"), randomBytes(32));
    await expect(readOwnerState(schema, empty)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(await fs.readFile(filename, "utf8")).toBe(original);
  });

  it("rejects corrupted state, invalid mutations, and oversized writes without replacing the old record", async () => {
    await mutateOwnerState(schema, empty, reserve);
    const filename = path.join(directory, "owner-auth.json");
    const original = await fs.readFile(filename, "utf8");
    await expect(
      mutateOwnerState(schema, empty, state => ({
        state: { ...state, attempts: -1 },
        result: null,
      }))
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    await expect(
      mutateOwnerState(schema, empty, state => ({
        state: { ...state, payload: "x".repeat(512 * 1024) },
        result: null,
      }))
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(await fs.readFile(filename, "utf8")).toBe(original);
    await fs.writeFile(filename, "corrupted ciphertext");
    await expect(readOwnerState(schema, empty)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  it("does not follow a symlinked owner key or state file", async () => {
    await mutateOwnerState(schema, empty, reserve);
    const filename = path.join(directory, "owner-auth.key");
    const target = path.join(directory, "linked-key");
    await fs.rename(filename, target);
    await fs.symlink(target, filename);
    await expect(readOwnerState(schema, empty)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(await fs.readFile(target)).toHaveLength(32);
  });

  it("does not write a callback that rejects one-time setup after another setup wins", async () => {
    const setup = (owner: string) =>
      mutateOwnerState(schema, empty, state => {
        if (state.owner)
          throw new TRPCError({
            code: "CONFLICT",
            message: "Already initialized",
          });
        return { state: { ...state, owner }, result: owner };
      });
    const outcomes = await Promise.allSettled([
      setup("first"),
      setup("second"),
    ]);
    expect(
      outcomes.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      outcomes.filter(result => result.status === "rejected")
    ).toHaveLength(1);
    expect((await readOwnerState(schema, empty)).owner).toBe("first");
  });
});

describe("cloud owner authentication state", () => {
  beforeEach(cloud);

  it("uses its own private path, fresh reads, conditional writes, and one shared deadline", async () => {
    const master = process.env.STUDYOS_AI_MASTER_KEY;
    await mutateOwnerState(schema, empty, reserve);
    await mutateOwnerState(schema, empty, reserve);
    expect((await readOwnerState(schema, empty)).attempts).toBe(2);
    expect(process.env.STUDYOS_AI_MASTER_KEY).toBe(master);
    expect(sdk.get).toHaveBeenCalledWith(
      "studyos/owner-auth-v1.json",
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
    expect(sdk.get.mock.calls[0][1].abortSignal).toBe(
      sdk.put.mock.calls[0][2].abortSignal
    );
    expect(stored?.body).not.toContain("attempts");
  });

  it("preserves simultaneous initial reservations and simultaneous subsequent updates", async () => {
    const first = await Promise.all([
      mutateOwnerState(schema, empty, reserve),
      mutateOwnerState(schema, empty, reserve),
    ]);
    expect(first.sort()).toEqual([1, 2]);
    const second = await Promise.all([
      mutateOwnerState(schema, empty, reserve),
      mutateOwnerState(schema, empty, reserve),
    ]);
    expect(second.sort()).toEqual([3, 4]);
    expect((await readOwnerState(schema, empty)).attempts).toBe(4);
  });

  it("recognizes its own committed initial write after a failed response without running setup twice", async () => {
    const original = sdk.put.getMockImplementation()!;
    sdk.put.mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("Interrupted after commit");
    });
    const operation = vi.fn((state: State) => ({
      state: { ...state, owner: "owner-hash" },
      result: "success",
    }));
    expect(await mutateOwnerState(schema, empty, operation)).toBe("success");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sdk.put).toHaveBeenCalledTimes(1);
    expect((await readOwnerState(schema, empty)).owner).toBe("owner-hash");
  });

  it("fails after five CAS attempts without an unconditional overwrite", async () => {
    await mutateOwnerState(schema, empty, reserve);
    sdk.get.mockClear();
    sdk.put.mockClear().mockRejectedValue(new BlobPreconditionFailedError());
    await expect(
      mutateOwnerState(schema, empty, reserve)
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(sdk.put).toHaveBeenCalledTimes(5);
    const signals = new Set([
      ...sdk.get.mock.calls.map(call => call[1].abortSignal),
      ...sdk.put.mock.calls.map(call => call[2].abortSignal),
    ]);
    expect(signals.size).toBe(1);
    expect(
      sdk.put.mock.calls.every(call => call[2].ifMatch === "revision-1")
    ).toBe(true);
  });

  it("rejects AI ciphertext replay, changed cloud keys, and malformed ciphertext", async () => {
    await mutateOwnerState(schema, empty, reserve);
    const body = stored!.body;
    const master = process.env.STUDYOS_AI_MASTER_KEY!;
    vi.stubEnv("STUDYOS_AI_MASTER_KEY", randomBytes(32).toString("base64"));
    await expect(readOwnerState(schema, empty)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    vi.stubEnv("STUDYOS_AI_MASTER_KEY", master);
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(master, "base64"),
      iv
    );
    cipher.setAAD(Buffer.from("studyos:ai-connections:v1"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(empty())),
      cipher.final(),
    ]);
    stored!.body = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    await expect(readOwnerState(schema, empty)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    stored!.body = body.slice(0, -10);
    await expect(
      mutateOwnerState(schema, empty, reserve)
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(sdk.put).toHaveBeenCalledTimes(1);
  });

  it("rejects metadata or streamed ciphertext larger than 512 KiB", async () => {
    const response = (size: number) => ({
      statusCode: 200,
      blob: { size, etag: "etag" },
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.alloc(512 * 1024 + 1));
          controller.close();
        },
      }),
    });
    sdk.get.mockResolvedValueOnce(response(512 * 1024 + 1));
    await expect(readOwnerState(schema, empty)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    sdk.get.mockResolvedValueOnce(response(1));
    await expect(readOwnerState(schema, empty)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(sdk.put).not.toHaveBeenCalled();
  });

  it("rejects invalid state before uploading and reports provider outages without resetting data", async () => {
    await expect(
      mutateOwnerState(schema, empty, state => ({
        state: { ...state, attempts: -1 },
        result: null,
      }))
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    await expect(
      mutateOwnerState(schema, empty, state => ({
        state: { ...state, payload: "x".repeat(512 * 1024) },
        result: null,
      }))
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    sdk.get.mockRejectedValue(new Error("internal token must not be exposed"));
    await expect(readOwnerState(schema, empty)).rejects.not.toThrow(
      "internal token"
    );
    expect(sdk.put).not.toHaveBeenCalled();
  });

  it.each(["", "local", "unknown"])(
    "never falls back to a local record on Vercel with storage mode %j",
    async mode => {
      vi.stubEnv("STUDYOS_AI_STORAGE", mode);
      await expect(readOwnerState(schema, empty)).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
      expect(sdk.get).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual([]);
    }
  );

  it.each(["", "invalid", Buffer.alloc(31).toString("base64")])(
    "requires a valid unchanged cloud master key: %j",
    async key => {
      vi.stubEnv("STUDYOS_AI_MASTER_KEY", key);
      await expect(readOwnerState(schema, empty)).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
      });
      expect(sdk.get).not.toHaveBeenCalled();
    }
  );
});
