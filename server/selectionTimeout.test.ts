import { afterEach, describe, expect, it, vi } from "vitest";
const { invokeConnection, getActiveConnection } = vi.hoisted(() => ({ invokeConnection: vi.fn(), getActiveConnection: vi.fn() }));
vi.mock("./ai/connection-store", () => ({ getActiveConnection }));
vi.mock("./ai/transport", () => ({ invokeConnection }));
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
getActiveConnection.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000001", name: "Any provider", model: "any-model", timeoutMs: 90000 });
const context = (): TrpcContext => ({ user: null, req: { headers: { host: "localhost:3000" }, socket: { remoteAddress: "127.0.0.1" } } as TrpcContext["req"], res: {} as TrpcContext["res"] });
const input = { sessionName: "Cloud", materials: "", translate: false, responseStyle: "Balanced" as const, model: "active" as const, selection: "cloud" };
afterEach(() => invokeConnection.mockReset());

describe("selection action timeout", () => {
  it("uses the configured timeout for Explain, Key Terms and vocabulary", async () => {
    invokeConnection.mockResolvedValueOnce({ text: "Cloud means remote computing.", truncated: false, provider: "Any provider" });
    await appRouter.createCaller(context()).study.explain(input);
    invokeConnection.mockResolvedValueOnce({ text: JSON.stringify({ term: "cloud", definition: "Remote computing.", context: "", example: "" }), truncated: false, provider: "Any provider" });
    await appRouter.createCaller(context()).study.draftKeyTerm(input);
    invokeConnection.mockResolvedValueOnce({ text: JSON.stringify({ term: "cloud", meaning: "awan" }), truncated: false, provider: "Any provider" });
    await appRouter.createCaller(context()).study.draftVocabulary(input);
    expect(invokeConnection).toHaveBeenCalledTimes(3);
    expect(invokeConnection.mock.calls.every(call => call[2].timeoutMs === 90000)).toBe(true);
  });
});
