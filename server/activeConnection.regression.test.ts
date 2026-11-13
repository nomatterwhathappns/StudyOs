import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
const { invokeConnection, getActiveConnection } = vi.hoisted(() => ({ invokeConnection: vi.fn(), getActiveConnection: vi.fn() }));
vi.mock("./ai/connection-store", () => ({ getActiveConnection }));
vi.mock("./ai/transport", () => ({ invokeConnection }));
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

const connection = { id: "00000000-0000-4000-8000-000000000001", name: "Configured gateway", model: "owner-selected-model" };
const context = (local = true): TrpcContext => ({ user: null, req: { headers: { host: local ? "localhost:3000" : "study.example.com" }, socket: { remoteAddress: local ? "127.0.0.1" : "203.0.113.5" } } as TrpcContext["req"], res: {} as TrpcContext["res"] });
const input = { sessionName: "Cloud", materials: "[Source: Cloud.md · part 1]\nCloud stores files remotely.", translate: false, responseStyle: "Balanced" as const, model: "active" as const };
const reply = (text: string) => ({ text, truncated: false, provider: "Configured gateway · owner-selected-model" });
beforeEach(() => { invokeConnection.mockReset(); getActiveConnection.mockReset().mockResolvedValue(connection); });

describe("active-connection study pipeline", () => {
  it("uses the server-selected connection and returns its actual provider with citations", async () => {
    invokeConnection.mockResolvedValueOnce(reply("Cloud stores files remotely. [Source: Cloud.md · part 1]"));
    await expect(appRouter.createCaller(context()).study.chat({ ...input, history: [{ role: "user", content: "What is cloud storage?" }] })).resolves.toEqual({ text: "Cloud stores files remotely.", citations: [{ title: "Cloud.md", ordinal: 1 }], truncated: false, provider: "Configured gateway · owner-selected-model" });
    expect(getActiveConnection).toHaveBeenCalledTimes(1);
    expect(invokeConnection.mock.calls[0][0]).toBe(connection);
    expect(invokeConnection.mock.calls[0][2]).toMatchObject({ maxTokens: 2400 });
  });

  it("preserves a missing-connection error instead of misreporting an exhausted quota", async () => {
    getActiveConnection.mockRejectedValueOnce(new TRPCError({ code: "PRECONDITION_FAILED", message: "Choose an active connection in AI Settings." }));
    await expect(appRouter.createCaller(context()).study.chat({ ...input, history: [{ role: "user", content: "Hello" }] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "Choose an active connection in AI Settings." });
    expect(invokeConnection).not.toHaveBeenCalled();
  });

  it("preserves provider errors and never switches to a hidden fallback", async () => {
    invokeConnection.mockRejectedValueOnce(new TRPCError({ code: "TOO_MANY_REQUESTS", message: "The configured connection is rate limited." }));
    await expect(appRouter.createCaller(context()).study.chat({ ...input, history: [{ role: "user", content: "Hello" }] })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(getActiveConnection).toHaveBeenCalledTimes(1);
    expect(invokeConnection).toHaveBeenCalledTimes(1);
  });

  it("keeps one connection snapshot across translation batches", async () => {
    const messages = [{ id: "first", content: "A".repeat(3500) }, { id: "second", content: "B".repeat(3500) }];
    invokeConnection.mockResolvedValueOnce(reply(JSON.stringify({ translations: [{ id: "first", content: "Terjemahan pertama" }] }))).mockResolvedValueOnce(reply(JSON.stringify({ translations: [{ id: "second", content: "Terjemahan kedua" }] })));
    const result = await appRouter.createCaller(context()).study.translateChat({ model: "active", target: "indonesian", messages });
    expect(result.translations.indonesian.map(item => item.id)).toEqual(["first", "second"]);
    expect(result.translations.english).toEqual(messages);
    expect(getActiveConnection).toHaveBeenCalledTimes(1);
    expect(invokeConnection).toHaveBeenCalledTimes(2);
    expect(invokeConnection.mock.calls.every(call => call[0] === connection)).toBe(true);
  });

  it("does not retry a truncated translation batch", async () => {
    invokeConnection.mockResolvedValueOnce({ text: '{"translations":[', truncated: true, provider: "Configured gateway" });
    await expect(appRouter.createCaller(context()).study.translateChat({ model: "active", target: "english", messages: [{ id: "hello", content: "Halo" }] })).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    expect(invokeConnection).toHaveBeenCalledTimes(1);
  });

  it("rejects a second unchanged wrong-language translation instead of reporting success", async () => {
    const message = { id: "original", content: "Saya belajar dengan kamu dan ini adalah materi saya." };
    invokeConnection.mockResolvedValue(reply(JSON.stringify({ translations: [message] })));
    await expect(appRouter.createCaller(context()).study.translateChat({ model: "active", target: "english", messages: [message] })).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    expect(invokeConnection).toHaveBeenCalledTimes(2);
    expect(getActiveConnection).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["chat", { ...input, history: [{ role: "user", content: "Hello" }] }],
    ["continue", { ...input, history: [{ role: "assistant", content: "A partial answer" }] }],
    ["translateChat", { model: "active", target: "english", messages: [{ id: "hello", content: "Halo" }] }],
    ["explain", { ...input, selection: "Cloud" }],
    ["draftKeyTerm", { ...input, selection: "Cloud" }],
    ["draftVocabulary", { ...input, selection: "cloud" }],
    ["quiz", input],
  ])("rejects remote unauthenticated %s before reading managed credentials", async (route, payload) => {
    const study = appRouter.createCaller(context(false)).study as unknown as Record<string, (value: unknown) => Promise<unknown>>;
    await expect(study[String(route)](payload)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getActiveConnection).not.toHaveBeenCalled();
    expect(invokeConnection).not.toHaveBeenCalled();
  });
});
