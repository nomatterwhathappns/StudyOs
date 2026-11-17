export const OWNER_SESSION_EXPIRED_EVENT = "studyos:owner-session-expired";

const protectedRequests = new Set<AbortController>();
let protectedAccessAllowed = true;

export function notifyOwnerSessionExpired() {
  window.dispatchEvent(new Event(OWNER_SESSION_EXPIRED_EVENT));
}

export function abortProtectedRequests() {
  protectedRequests.forEach(controller => controller.abort());
  protectedRequests.clear();
}

export function suspendProtectedRequests() {
  protectedAccessAllowed = false;
  abortProtectedRequests();
}

export function resumeProtectedRequests() {
  protectedAccessAllowed = true;
}

export async function fetchProtected(
  input: RequestInfo | URL,
  init?: RequestInit
) {
  if (!protectedAccessAllowed)
    throw new DOMException("Private access is required.", "AbortError");
  const controller = new AbortController();
  const upstreamSignal = init?.signal;
  const abort = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener("abort", abort, { once: true });
  protectedRequests.add(controller);
  const cleanup = () => {
    protectedRequests.delete(controller);
    upstreamSignal?.removeEventListener("abort", abort);
  };
  try {
    const response = await globalThis.fetch(input, {
      ...init,
      signal: controller.signal,
    });
    if (response.status === 401) notifyOwnerSessionExpired();
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const result = await reader.read();
          if (result.done) {
            cleanup();
            stream.close();
          } else stream.enqueue(result.value);
        } catch (reason) {
          cleanup();
          stream.error(reason);
        }
      },
      async cancel(reason) {
        controller.abort();
        cleanup();
        await reader.cancel?.(reason);
      },
    });
    return new Response(body, {
      status: response.status || 200,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (reason) {
    cleanup();
    throw reason;
  }
}
