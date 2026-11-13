// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { addVocabulary, addMessage, addQuiz, keyTermCallbacks, quizCallbacks, translationCallbacks, translationRequestInputs } = vi.hoisted(() => ({
  addVocabulary: vi.fn(),
  addMessage: vi.fn(),
  addQuiz: vi.fn(),
  keyTermCallbacks: { value: undefined as undefined | { onSuccess?: (draft: { term: string; definition: string; context: string; example: string }) => void } },
  quizCallbacks: { value: undefined as undefined | { onSuccess?: (result: { questions: Array<{ prompt: string; options: string[]; answer: string }> }) => void } },
  translationCallbacks: { value: undefined as undefined | { onSuccess?: (result: { translations: { english: Array<{ id: string; content: string }>; indonesian: Array<{ id: string; content: string }> } }) => void } },
  translationRequestInputs: [] as Array<{ messages: Array<{ id: string; content: string }> }>,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    study: {
      explain: { useMutation: () => ({ mutate: vi.fn(), reset: vi.fn() }) },
      draftKeyTerm: { useMutation: () => ({ mutate: (_input: unknown, callbacks: typeof keyTermCallbacks.value) => { keyTermCallbacks.value = callbacks; }, reset: vi.fn() }) },
      draftVocabulary: { useMutation: () => ({ mutate: vi.fn(), reset: vi.fn() }) },
      quiz: { useMutation: () => ({ mutate: (_input: unknown, callbacks: typeof quizCallbacks.value) => { quizCallbacks.value = callbacks; }, reset: vi.fn() }) },
      translateChat: { useMutation: () => ({ mutate: (input: { messages: Array<{ id: string; content: string }> }, callbacks: typeof translationCallbacks.value) => { translationRequestInputs.push(input); translationCallbacks.value = callbacks; }, reset: vi.fn() }) },
    },
  },
}));

vi.mock("@/store/useStudyStore", () => {
  const state = { addVocabulary, addMessage, addQuiz, sessions: [] };
  const useStudyStore = Object.assign((selector?: (value: typeof state) => unknown) => selector ? selector(state) : state, { getState: () => state });
  return { useStudyStore };
});

import { SourceAiActivityProvider, useSourceAiActivity } from "./SourceAiActivityContext";
import { AiActivityMenu } from "@/components/studyos/AiActivityMenu";

function SourceTaskStarter({ visible }: { visible: boolean }) {
  const sourceAi = useSourceAiActivity();
  if (!visible) return null;
  return <button type="button" onClick={() => sourceAi.startKeyTerm({ sessionId: "session-a", sessionName: "Biology", materials: "Plants use light.", responseStyle: "Balanced", model: "active", selection: "Photosynthesis" })}>Start Save Terms</button>;
}

function SourceTaskStatus() {
  const sourceAi = useSourceAiActivity();
  const task = sourceAi.tasks[0];
  return <p>{task ? `${task.status}:${task.selection}` : "idle"}</p>;
}

function QuizTaskStarter({ visible }: { visible: boolean }) {
  const sourceAi = useSourceAiActivity();
  if (!visible) return null;
  return <button type="button" onClick={() => sourceAi.startQuiz({ sessionId: "session-a", sessionName: "Biology", materials: "Plants use light.", responseStyle: "Balanced", model: "active", quiz: { difficulty: "medium", questionCount: 3, optionCount: 4 } })}>Start Generate Quiz</button>;
}

function TranslationTaskStarter({ visible }: { visible: boolean }) {
  const sourceAi = useSourceAiActivity();
  if (!visible) return null;
  return <button type="button" onClick={() => sourceAi.startChatTranslation({ sessionId: "session-a", sessionName: "Biology", model: "active", target: "english", messages: [{ id: "ai-1", content: "Halo" }] })}>Start Translate</button>;
}

function TranslationTaskStatus() {
  const sourceAi = useSourceAiActivity();
  const task = sourceAi.tasks.find((item) => item.kind === "chat-translation");
  return <p>{task ? task.status : sourceAi.chatTranslationsFor("session-a").english["ai-1"] ?? "idle"}</p>;
}

function TranslationTaskCancel() {
  const sourceAi = useSourceAiActivity();
  const task = sourceAi.tasks.find((item) => item.kind === "chat-translation");
  return task ? <button type="button" onClick={() => sourceAi.cancelTask(task.id)}>Cancel Translate now</button> : null;
}

describe("Source AI activity provider", () => {
  afterEach(() => cleanup());

  it("keeps a Save Terms request and its draft when the Source panel unmounts", () => {
    const ui = render(<SourceAiActivityProvider><SourceTaskStarter visible /><SourceTaskStatus /></SourceAiActivityProvider>);
    fireEvent.click(ui.getByRole("button", { name: "Start Save Terms" }));
    expect(ui.getByText("pending:Photosynthesis")).toBeTruthy();

    ui.rerender(<SourceAiActivityProvider><SourceTaskStarter visible={false} /><SourceTaskStatus /></SourceAiActivityProvider>);
    act(() => keyTermCallbacks.value?.onSuccess?.({ term: "Photosynthesis", definition: "Converts light to chemical energy.", context: "Plants", example: "Leaves" }));

    expect(ui.getByText("review:Photosynthesis")).toBeTruthy();
  });

  it("keeps a Generate Quiz request when the Watch panel unmounts", () => {
    const ui = render(<SourceAiActivityProvider><QuizTaskStarter visible /><SourceTaskStatus /></SourceAiActivityProvider>);
    fireEvent.click(ui.getByRole("button", { name: "Start Generate Quiz" }));
    expect(ui.getByText("pending:undefined")).toBeTruthy();

    ui.rerender(<SourceAiActivityProvider><QuizTaskStarter visible={false} /><SourceTaskStatus /></SourceAiActivityProvider>);
    act(() => quizCallbacks.value?.onSuccess?.({ questions: [{ prompt: "What uses light?", options: ["Plants"], answer: "Plants" }] }));

    expect(addQuiz).toHaveBeenCalledWith("session-a", expect.any(Array));
    expect(ui.getByText("idle")).toBeTruthy();
  });

  it("keeps a Translate request and its result when the workspace trigger unmounts", () => {
    const ui = render(<SourceAiActivityProvider><TranslationTaskStarter visible /><TranslationTaskStatus /></SourceAiActivityProvider>);
    fireEvent.click(ui.getByRole("button", { name: "Start Translate" }));
    expect(ui.getByText("pending")).toBeTruthy();

    ui.rerender(<SourceAiActivityProvider><TranslationTaskStarter visible={false} /><TranslationTaskStatus /></SourceAiActivityProvider>);
    act(() => translationCallbacks.value?.onSuccess?.({ translations: { english: [{ id: "ai-1", content: "Hello" }], indonesian: [{ id: "ai-1", content: "Halo" }] } }));

    expect(ui.getByText("Hello")).toBeTruthy();
  });

  it("keeps running remaining Translate batches after the triggering Chat UI unmounts", () => {
    translationRequestInputs.length = 0;
    function LongTranslationStarter({ visible }: { visible: boolean }) {
      const sourceAi = useSourceAiActivity();
      if (!visible) return null;
      return <button type="button" onClick={() => sourceAi.startChatTranslation({ sessionId: "session-a", sessionName: "Biology", model: "active", target: "english", messages: Array.from({ length: 7 }, (_, index) => ({ id: `ai-${index + 1}`, content: `Halo ${index + 1}` })) })}>Start long Translate</button>;
    }
    const ui = render(<SourceAiActivityProvider><LongTranslationStarter visible /><TranslationTaskStatus /></SourceAiActivityProvider>);
    fireEvent.click(ui.getByRole("button", { name: "Start long Translate" }));
    expect(translationRequestInputs.at(-1)?.messages).toHaveLength(6);

    ui.rerender(<SourceAiActivityProvider><LongTranslationStarter visible={false} /><TranslationTaskStatus /></SourceAiActivityProvider>);
    act(() => translationCallbacks.value?.onSuccess?.({ translations: { english: Array.from({ length: 6 }, (_, index) => ({ id: `ai-${index + 1}`, content: `Hello ${index + 1}` })), indonesian: [] } }));

    expect(translationRequestInputs.at(-1)?.messages).toEqual([{ id: "ai-7", content: "Halo 7" }]);
    expect(ui.getByText("pending")).toBeTruthy();
  });

  it("does not queue another Translate batch after Cancel while the triggering UI is gone", () => {
    translationRequestInputs.length = 0;
    function LongTranslationStarter({ visible }: { visible: boolean }) {
      const sourceAi = useSourceAiActivity();
      if (!visible) return null;
      return <button type="button" onClick={() => sourceAi.startChatTranslation({ sessionId: "session-a", sessionName: "Biology", model: "active", target: "english", messages: Array.from({ length: 7 }, (_, index) => ({ id: `cancel-${index + 1}`, content: `Halo ${index + 1}` })) })}>Start cancelable Translate</button>;
    }
    const ui = render(<SourceAiActivityProvider><LongTranslationStarter visible /><TranslationTaskCancel /><TranslationTaskStatus /></SourceAiActivityProvider>);
    fireEvent.click(ui.getByRole("button", { name: "Start cancelable Translate" }));
    ui.rerender(<SourceAiActivityProvider><LongTranslationStarter visible={false} /><TranslationTaskCancel /><TranslationTaskStatus /></SourceAiActivityProvider>);
    fireEvent.click(ui.getByRole("button", { name: "Cancel Translate now" }));

    act(() => translationCallbacks.value?.onSuccess?.({ translations: { english: Array.from({ length: 6 }, (_, index) => ({ id: `cancel-${index + 1}`, content: `Late ${index + 1}` })), indonesian: [] } }));

    expect(translationRequestInputs).toHaveLength(1);
    expect(ui.getByText("idle")).toBeTruthy();
    expect(ui.queryByText("Late 1")).toBeNull();
  });

  it("removes Translate immediately and ignores a late result after Cancel", () => {
    const ui = render(<SourceAiActivityProvider><TranslationTaskStarter visible /><TranslationTaskCancel /><TranslationTaskStatus /></SourceAiActivityProvider>);
    fireEvent.click(ui.getByRole("button", { name: "Start Translate" }));
    fireEvent.click(ui.getByRole("button", { name: "Cancel Translate now" }));
    expect(ui.getByText("idle")).toBeTruthy();

    act(() => translationCallbacks.value?.onSuccess?.({ translations: { english: [{ id: "ai-1", content: "Late hello" }], indonesian: [{ id: "ai-1", content: "Halo terlambat" }] } }));
    expect(ui.getByText("idle")).toBeTruthy();
    expect(ui.queryByText("Late hello")).toBeNull();
  });

  it("shows a compact activity menu and can cancel a running AI task", () => {
    window.history.pushState({}, "", "/");
    const ui = render(<SourceAiActivityProvider><SourceTaskStarter visible /><AiActivityMenu /></SourceAiActivityProvider>);
    fireEvent.click(ui.getByRole("button", { name: "Start Save Terms" }));
    fireEvent.click(ui.getByRole("button", { name: "AI activity" }));

    expect(ui.getByRole("status", { name: "AI activities in progress" })).toBeTruthy();
    expect(ui.getByText("Save Terms")).toBeTruthy();
    fireEvent.click(ui.getByRole("button", { name: "Cancel Save Terms" }));
    expect(ui.queryByRole("button", { name: "AI activity" })).toBeNull();
  });

  it("keeps the activity indicator out of the workspace and reserves it for Profile", () => {
    window.history.pushState({}, "", "/studych");
    const ui = render(<SourceAiActivityProvider><SourceTaskStarter visible /><AiActivityMenu /></SourceAiActivityProvider>);
    fireEvent.click(ui.getByRole("button", { name: "Start Save Terms" }));

    expect(ui.queryByRole("button", { name: "AI activity" })).toBeNull();
  });
});
