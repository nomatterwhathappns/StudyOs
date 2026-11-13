import { afterEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
const { invokeConnection, getActiveConnection } = vi.hoisted(() => ({ invokeConnection: vi.fn(), getActiveConnection: vi.fn() }));
vi.mock("./ai/connection-store", () => ({ getActiveConnection }));
vi.mock("./ai/transport", () => ({ invokeConnection }));
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
const connection = { id: "00000000-0000-4000-8000-000000000001", name: "My connection", model: "custom-model" };
getActiveConnection.mockResolvedValue(connection);
const context = (): TrpcContext => ({ user: null, req: { headers: { host: "localhost:3000" }, socket: { remoteAddress: "127.0.0.1" } } as TrpcContext["req"], res: {} as TrpcContext["res"] });
const input = { sessionName: "English", materials: "", translate: false, responseStyle: "Balanced" as const, model: "active" as const, selection: "resilient" };
afterEach(() => { invokeConnection.mockReset(); getActiveConnection.mockClear(); });

describe("active-connection vocabulary recovery", () => {
  it("retries one empty response on the same connection with a simpler prompt", async () => {
    invokeConnection.mockRejectedValueOnce(new TRPCError({ code: "BAD_GATEWAY", message: "The AI service returned no visible text. Check model support and the output token limit in Profile." })).mockResolvedValueOnce({ text: '{"term":"resilient","meaning":"tangguh"}', truncated: false, provider: "My connection · custom-model" });
    await expect(appRouter.createCaller(context()).study.draftVocabulary(input)).resolves.toEqual({ term: "resilient", meaning: "tangguh" });
    expect(invokeConnection).toHaveBeenCalledTimes(2);
    expect(getActiveConnection).toHaveBeenCalledTimes(1);
    expect(invokeConnection.mock.calls.every(call => call[0] === connection)).toBe(true);
    expect(invokeConnection.mock.calls[1][2]).toMatchObject({ maxTokens: 500 });
    expect(invokeConnection.mock.calls[1][1][0].content).toContain("Translate the selected foreign word");
  });

  it("does not retry a quota or authentication failure", async () => {
    invokeConnection.mockRejectedValueOnce(new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Connection quota exhausted." }));
    await expect(appRouter.createCaller(context()).study.draftVocabulary(input)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(invokeConnection).toHaveBeenCalledTimes(1);
  });
});
