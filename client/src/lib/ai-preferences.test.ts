// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAiPreferences, saveAiResponseStyle } from "./ai-preferences";

describe("AI preferences", () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it.each([
    ["Fast", "Fast"],
    ["Concise", "Fast"],
    ["Balanced", "Balanced"],
    ["Deep", "Deep"],
    ["Detailed", "Deep"],
    ["unknown", "Balanced"],
  ] as const)(
    "keeps response style %s compatible with the active connection",
    (stored, expected) => {
      localStorage.setItem("studyos_ai_style", stored);
      localStorage.setItem("studyos_ai_model", "local-9router");

      expect(readAiPreferences()).toEqual({
        model: "active",
        responseStyle: expected,
      });
    }
  );

  it("uses the active server connection when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Storage blocked");
      },
      setItem: () => {
        throw new Error("Storage blocked");
      },
      clear: vi.fn(),
    });

    expect(readAiPreferences()).toEqual({
      model: "active",
      responseStyle: "Balanced",
    });
    expect(() => saveAiResponseStyle("Deep")).not.toThrow();
  });

  it("persists response style without changing the server-selected connection", () => {
    localStorage.setItem("studyos_ai_model", "old-model");

    saveAiResponseStyle("Deep");

    expect(localStorage.getItem("studyos_ai_style")).toBe("Deep");
    expect(readAiPreferences()).toEqual({
      model: "active",
      responseStyle: "Deep",
    });
  });
});
