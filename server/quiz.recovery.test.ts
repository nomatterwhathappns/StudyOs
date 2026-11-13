import { afterEach, describe, expect, it, vi } from "vitest";
const { invokeConnection, getActiveConnection } = vi.hoisted(() => ({ invokeConnection: vi.fn(), getActiveConnection: vi.fn() }));
vi.mock("./ai/connection-store", () => ({ getActiveConnection }));
vi.mock("./ai/transport", () => ({ invokeConnection }));
import { appRouter, parseQuizQuestions } from "./routers";
import type { TrpcContext } from "./_core/context";

const connection = { id: "00000000-0000-4000-8000-000000000001", name: "Study server", model: "custom-model", timeoutMs: 90000 };
getActiveConnection.mockResolvedValue(connection);
const input = { sessionName: "Cloud basics", materials: "[Source: Cloud.md · part 1]\nCloud storage keeps files on remote servers.", translate: false, responseStyle: "Balanced" as const, model: "active" as const };
const context = (): TrpcContext => ({ user: null, req: { headers: { host: "localhost:3000" }, socket: { remoteAddress: "127.0.0.1" } } as TrpcContext["req"], res: {} as TrpcContext["res"] });
const validQuiz = (count = 5, options = ["One", "Two", "Three", "Four"]) => ({ questions: Array.from({ length: count }, (_, index) => ({ question: `Question ${index + 1}?`, options, correct: index % options.length, explanation: "A short explanation." })) });
const reply = (text: string) => ({ text, truncated: false, provider: "Study server · custom-model" });
afterEach(() => { invokeConnection.mockReset(); getActiveConnection.mockClear(); });

describe("active-connection Quiz recovery", () => {
  it.each(["D", "3"])("rejects an answer key %s that is out of range for a two-option quiz", answer => {
    const data = validQuiz(3, ["One", "Two"]);
    const questions = data.questions.map(question => ({ ...question, correct: answer }));
    expect(() => parseQuizQuestions(JSON.stringify({ questions }), { difficulty: "medium", questionCount: 3, optionCount: 2 })).toThrow();
  });
  it("repairs one malformed quiz with the same connection snapshot", async () => {
    invokeConnection.mockResolvedValueOnce(reply("Here are five questions about cloud storage:")).mockResolvedValueOnce(reply(JSON.stringify(validQuiz())));
    const result = await appRouter.createCaller(context()).study.quiz(input);
    expect(result.questions).toHaveLength(5);
    expect(invokeConnection).toHaveBeenCalledTimes(2);
    expect(getActiveConnection).toHaveBeenCalledTimes(1);
    expect(invokeConnection.mock.calls.every(call => call[0] === connection)).toBe(true);
    const repair = invokeConnection.mock.calls[1];
    expect(repair[1][0].content).toContain("Reformat the supplied Quiz candidate");
    expect(repair[1][1].content).toContain("Here are five questions");
    expect(repair[2]).toMatchObject({ json: true, timeoutMs: 90000 });
  });

  it("passes custom question count, options, and difficulty to the configured connection", async () => {
    invokeConnection.mockResolvedValueOnce(reply(JSON.stringify(validQuiz(3, ["One", "Two"]))));
    const result = await appRouter.createCaller(context()).study.quiz({ ...input, quiz: { difficulty: "hard", questionCount: 3, optionCount: 2 } });
    expect(result.questions).toHaveLength(3);
    expect(result.questions.every(question => question.options.length === 2)).toBe(true);
    const prompt = invokeConnection.mock.calls[0][1][0].content;
    expect(prompt).toContain("exactly 3 distinct");
    expect(prompt).toContain("exactly 2 plausible options");
    expect(prompt).toContain("Hard: test application");
  });

  it("does not retry beyond one repair when both quiz outputs are malformed", async () => {
    invokeConnection.mockResolvedValue(reply("not JSON"));
    await expect(appRouter.createCaller(context()).study.quiz(input)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(invokeConnection).toHaveBeenCalledTimes(2);
    expect(getActiveConnection).toHaveBeenCalledTimes(1);
  });
});
