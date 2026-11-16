import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { TRPCError } from "@trpc/server";

const STORE_PATH = "studyos/ai-connections-v1.json";
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 5;

export type StoreCodec<State> = {
  empty(): State;
  decode(serialized: string, key: Buffer): State;
  encode(state: State, key: Buffer): string;
};

export function storageMode(): "local" | "vercel-blob" {
  const mode = process.env.STUDYOS_AI_STORAGE;
  if (mode === "vercel-blob") {
    configurationKey();
    return mode;
  }
  if ((mode && mode !== "local") || process.env.VERCEL === "1")
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Cloud AI connection storage is not configured. Set STUDYOS_AI_STORAGE=vercel-blob, connect a private Blob store, and configure STUDYOS_AI_MASTER_KEY before using AI settings.",
    });
  return "local";
}

function configurationKey(): Buffer {
  const value = process.env.STUDYOS_AI_MASTER_KEY ?? "";
  const key = Buffer.from(value, "base64");
  const hasCredentials =
    Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim()) ||
    Boolean(
      process.env.BLOB_STORE_ID?.trim() && process.env.VERCEL_OIDC_TOKEN?.trim()
    );
  if (
    !value ||
    key.length !== 32 ||
    key.toString("base64") !== value ||
    !hasCredentials
  )
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Cloud AI connection storage is not configured. Connect a private Blob store and set STUDYOS_AI_MASTER_KEY to a persistent base64-encoded 32-byte key. Keep this key unchanged to preserve access to saved connections.",
    });
  return key;
}

function storageError(): never {
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      "Cloud AI connection storage is unavailable. Check the private Blob store and its credentials, then try again. Saved connections have not been reset.",
  });
}

async function snapshot<State>(
  codec: StoreCodec<State>,
  key: Buffer,
  signal: AbortSignal
) {
  try {
    const result = await get(STORE_PATH, {
      access: "private",
      useCache: false,
      abortSignal: signal,
    });
    if (!result) return { state: codec.empty(), etag: undefined };
    if (
      result.statusCode !== 200 ||
      result.blob.size > MAX_STORE_BYTES ||
      !result.blob.etag
    )
      storageError();
    const reader = result.stream.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_STORE_BYTES) {
          await reader.cancel();
          storageError();
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      reader.releaseLock();
    }
    return {
      state: codec.decode(Buffer.concat(chunks).toString("utf8"), key),
      etag: result.blob.etag,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    storageError();
  }
}

export async function readBlobState<State>(codec: StoreCodec<State>) {
  const key = configurationKey();
  return (await snapshot(codec, key, AbortSignal.timeout(30_000))).state;
}

export async function mutateBlobState<State, Result>(
  codec: StoreCodec<State>,
  operation: (state: State) => { state: State; result: Result }
): Promise<Result> {
  const key = configurationKey();
  // Share one deadline across reads, writes, and retries. A busy store must not
  // multiply the request's maximum duration by the number of CAS attempts.
  const signal = AbortSignal.timeout(30_000);
  let current = await snapshot(codec, key, signal);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const next = operation(current.state);
    const serialized = codec.encode(next.state, key);
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) storageError();
    try {
      await put(STORE_PATH, serialized, {
        access: "private",
        addRandomSuffix: false,
        contentType: "application/json",
        ...(current.etag
          ? { allowOverwrite: true, ifMatch: current.etag }
          : { allowOverwrite: false }),
        abortSignal: signal,
      });
      return next.result;
    } catch (error) {
      // Creation collisions have no specialized SDK error. Only retry a failed
      // create after a fresh read proves the destination now exists. Existing
      // blobs always require a matching ETag, including all retry attempts.
      if (!current.etag || error instanceof BlobPreconditionFailedError) {
        const latest = await snapshot(codec, key, signal);
        if (latest.etag) {
          current = latest;
          continue;
        }
      }
      storageError();
    }
  }
  throw new TRPCError({
    code: "CONFLICT",
    message:
      "AI connections were updated by another request. Refresh the connection list and try again.",
  });
}
