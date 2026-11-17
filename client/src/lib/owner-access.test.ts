// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_SESSION_EXPIRED_EVENT,
  abortProtectedRequests,
  fetchProtected,
  resumeProtectedRequests,
  suspendProtectedRequests,
} from "./owner-access";

beforeEach(() => {
  resumeProtectedRequests();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  abortProtectedRequests();
  vi.unstubAllGlobals();
});

describe("protected request lifecycle", () => {
  it("blocks late requests after logout until owner access is restored", async () => {
    suspendProtectedRequests();
    await expect(
      fetchProtected("/api/trpc/study.uploadDocument")
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    resumeProtectedRequests();
    vi.mocked(fetch).mockResolvedValue(new Response("restored"));
    await expect(
      (await fetchProtected("/api/trpc/aiConnections.list")).text()
    ).resolves.toBe("restored");
  });
  it("notifies the owner gate when a protected endpoint returns 401", async () => {
    const expired = vi.fn();
    window.addEventListener(OWNER_SESSION_EXPIRED_EVENT, expired);
    vi.mocked(fetch).mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );
    const result = await fetchProtected("/api/trpc/aiConnections.list");
    expect(result.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
    window.removeEventListener(OWNER_SESSION_EXPIRED_EVENT, expired);
    await result.text();
  });

  it("keeps cancellation connected after streaming response headers arrive", async () => {
    const upstream = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      requestSignal = init?.signal as AbortSignal;
      return new Response(new ReadableStream({ start() {} }));
    });
    const result = await fetchProtected("/api/study/chat-stream", {
      signal: upstream.signal,
    });
    expect(requestSignal?.aborted).toBe(false);
    upstream.abort();
    expect(requestSignal?.aborted).toBe(true);
    await result.body?.cancel();
  });

  it("aborts every active protected call on logout", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Response(new ReadableStream({ start() {} }));
    });
    const first = await fetchProtected("/api/trpc/study.chat");
    const second = await fetchProtected("/api/study/chat-stream");
    abortProtectedRequests();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    await first.body?.cancel();
    await second.body?.cancel();
  });
});
