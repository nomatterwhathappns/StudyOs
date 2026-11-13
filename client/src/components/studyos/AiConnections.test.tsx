// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiConnectionsState,
  PublicAiConnection,
} from "@shared/ai-connections";

const api = vi.hoisted(() => ({
  state: { connections: [], activeId: null } as AiConnectionsState,
  save: vi.fn(),
  activate: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  models: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      aiConnections: { list: { invalidate: api.invalidate } },
    }),
    aiConnections: {
      list: {
        useQuery: () => ({ data: api.state, isLoading: false, error: null }),
      },
      save: {
        useMutation: () => ({
          mutateAsync: api.save,
          isPending: false,
          reset: vi.fn(),
        }),
      },
      activate: {
        useMutation: () => ({
          mutateAsync: api.activate,
          isPending: false,
          reset: vi.fn(),
        }),
      },
      remove: {
        useMutation: () => ({
          mutateAsync: api.remove,
          isPending: false,
          reset: vi.fn(),
        }),
      },
      test: {
        useMutation: () => ({
          mutateAsync: api.test,
          isPending: false,
          reset: vi.fn(),
        }),
      },
      models: {
        useMutation: () => ({
          mutateAsync: api.models,
          isPending: false,
          reset: vi.fn(),
        }),
      },
    },
  },
}));

import { AiConnections } from "./AiConnections";

const saved: PublicAiConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "My gateway",
  baseUrl: "https://ai.example.test/v1",
  model: "study-model",
  protocol: "openai-chat",
  authType: "bearer",
  authHeader: "x-api-key",
  stream: true,
  timeoutMs: 60000,
  maxOutputTokens: 4096,
  tokenParameter: "auto",
  jsonMode: "prompt",
  createdAt: "2026-11-13T00:00:00.000Z",
  updatedAt: "2026-11-13T00:00:00.000Z",
  hasApiKey: true,
  keySuffix: "a1b2",
  headerNames: ["x-workspace"],
};

function fillRequired() {
  fireEvent.change(screen.getByLabelText("Connection name"), {
    target: { value: "My gateway" },
  });
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://ai.example.test/v1" },
  });
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "manual-model" },
  });
}

describe("AI connections", () => {
  const browserStorage = new Map<string, string>();
  const openIndexedDb = vi.fn();

  beforeEach(() => {
    browserStorage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => browserStorage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        browserStorage.set(key, value);
      },
      removeItem: (key: string) => {
        browserStorage.delete(key);
      },
      clear: () => browserStorage.clear(),
    });
    openIndexedDb.mockReset();
    vi.stubGlobal("indexedDB", { open: openIndexedDb });
    api.state = { connections: [], activeId: null };
    api.save.mockReset().mockResolvedValue(saved);
    api.activate.mockReset().mockResolvedValue({ activeId: saved.id });
    api.remove.mockReset().mockResolvedValue({ activeId: null });
    api.test
      .mockReset()
      .mockResolvedValue({
        ok: true,
        message: "Connection is ready.",
        latencyMs: 12,
      });
    api.models
      .mockReset()
      .mockResolvedValue({
        models: [{ id: "discovered-model", name: "Discovered model" }],
      });
    api.invalidate.mockReset().mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("saves a manual model and write-only credentials without putting secrets in browser storage", async () => {
    render(<AiConnections />);
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fillRequired();
    const key = screen.getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    fireEvent.change(key, { target: { value: "new-secret-key" } });
    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.change(screen.getByLabelText("Custom headers JSON"), {
      target: { value: '{"x-workspace":"secret-team-value"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "My gateway",
          model: "manual-model",
          baseUrl: "https://ai.example.test/v1",
          apiKey: "new-secret-key",
          extraHeaders: { "x-workspace": "secret-team-value" },
        })
      )
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByLabelText("Custom headers JSON")).toHaveValue("");
    expect(JSON.stringify(Array.from(browserStorage))).not.toMatch(
      /new-secret-key|secret-team-value/
    );
    expect(openIndexedDb).not.toHaveBeenCalled();
  });

  it("preserves saved secrets when editing with blank credential fields", async () => {
    api.state = { connections: [saved], activeId: saved.id };
    render(<AiConnections />);
    fireEvent.click(screen.getByRole("button", { name: "Edit My gateway" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByLabelText("Custom headers JSON")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Connection name"), {
      target: { value: "Renamed gateway" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.save).toHaveBeenCalled());
    const payload = api.save.mock.calls[0][0];
    expect(payload).toEqual(
      expect.objectContaining({ id: saved.id, name: "Renamed gateway" })
    );
    expect(payload).not.toHaveProperty("apiKey");
    expect(payload).not.toHaveProperty("extraHeaders");
  });

  it("keeps the selected protocol and advanced connection options in the saved configuration", async () => {
    render(<AiConnections />);
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fillRequired();
    fireEvent.change(screen.getByLabelText("API protocol"), {
      target: { value: "openai-responses" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "advanced-key" },
    });
    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.change(screen.getByLabelText("Authentication"), {
      target: { value: "header" },
    });
    fireEvent.change(screen.getByLabelText("Authentication header"), {
      target: { value: "x-provider-key" },
    });
    fireEvent.change(screen.getByLabelText("Timeout (seconds)"), {
      target: { value: "90" },
    });
    fireEvent.change(screen.getByLabelText("Max output tokens"), {
      target: { value: "8192" },
    });
    fireEvent.change(screen.getByLabelText("Token parameter"), {
      target: { value: "max_completion_tokens" },
    });
    fireEvent.click(screen.getByLabelText("Stream responses"));
    fireEvent.change(screen.getByLabelText("JSON output"), {
      target: { value: "native" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          protocol: "openai-responses",
          authType: "header",
          authHeader: "x-provider-key",
          timeoutMs: 90000,
          maxOutputTokens: 8192,
          tokenParameter: "max_completion_tokens",
          stream: false,
          jsonMode: "native",
        })
      )
    );
  });

  it("removes saved credentials only through explicit controls", async () => {
    api.state = { connections: [saved], activeId: saved.id };
    render(<AiConnections />);
    fireEvent.click(screen.getByRole("button", { name: "Edit My gateway" }));
    fireEvent.click(screen.getByLabelText("Remove saved key"));
    fireEvent.click(screen.getByText("Advanced settings"));
    fireEvent.click(screen.getByLabelText("Remove saved headers"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: saved.id,
          clearApiKey: true,
          clearHeaders: true,
        })
      )
    );
  });

  it("shows masked saved-key metadata and identifies the active connection", () => {
    api.state = { connections: [saved], activeId: saved.id };
    render(<AiConnections />);

    expect(screen.getByText(/a1b2/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Active connection: My gateway" })
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit My gateway" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
  });

  it("tests an unsaved connection and still permits manual models when discovery fails", async () => {
    api.models.mockRejectedValueOnce(new Error("Unsupported model listing"));
    render(<AiConnections />);
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fillRequired();
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "temporary-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    await waitFor(() =>
      expect(api.models).toHaveBeenCalledWith(
        expect.objectContaining({
          draft: expect.objectContaining({
            model: "manual-model",
            apiKey: "temporary-key",
          }),
        })
      )
    );
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "provider-manual-id" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() =>
      expect(api.test).toHaveBeenCalledWith(
        expect.objectContaining({
          draft: expect.objectContaining({
            model: "provider-manual-id",
            apiKey: "temporary-key",
          }),
        })
      )
    );
    expect(api.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
  });

  it("lets a fetched model be selected for a provider-specific API protocol", async () => {
    render(<AiConnections />);
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fillRequired();
    fireEvent.change(screen.getByLabelText("API protocol"), {
      target: { value: "google" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    const models = await screen.findByLabelText("Available models");
    fireEvent.change(models, { target: { value: "discovered-model" } });
    expect(screen.getByLabelText("Model")).toHaveValue("discovered-model");
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "discovered-model",
          protocol: "google",
          authType: "header",
          authHeader: "x-goog-api-key",
        })
      )
    );
  });

  it("activates and tests saved connections and requires confirmation before deleting them", async () => {
    api.state = { connections: [saved], activeId: null };
    render(<AiConnections />);
    fireEvent.click(screen.getByRole("button", { name: "Use My gateway" }));
    await waitFor(() =>
      expect(api.activate).toHaveBeenCalledWith({ id: saved.id })
    );
    fireEvent.click(screen.getByRole("button", { name: "Test My gateway" }));
    await waitFor(() =>
      expect(api.test).toHaveBeenCalledWith({ id: saved.id })
    );

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete My gateway" }));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete My gateway" }));
    await waitFor(() =>
      expect(api.remove).toHaveBeenCalledWith({ id: saved.id })
    );
  });

  it("prevents stale model results and old finally handlers from affecting a reopened form", async () => {
    let finishOld!: (result: { models: Array<{ id: string }> }) => void;
    let finishNew!: (result: { models: Array<{ id: string }> }) => void;
    api.models
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishOld = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishNew = resolve;
          })
      );
    render(<AiConnections />);
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    expect(screen.getByLabelText("Base URL")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    await act(async () => {
      finishOld({ models: [{ id: "stale-model" }] });
    });
    expect(screen.queryByLabelText("Available models")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toBeDisabled();
    await act(async () => {
      finishNew({ models: [{ id: "new-model" }] });
    });
    expect(
      await screen.findByRole("option", { name: "new-model" })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).not.toBeDisabled();
  });

  it("shows a sanitized typed server error instead of losing the recovery instructions", async () => {
    const failure = new TRPCClientError(
      "Saved AI connection storage is busy. Try again after the other operation finishes.",
      {
        result: {
          error: {
            message:
              "Saved AI connection storage is busy. Try again after the other operation finishes.",
            code: -32603,
            data: { code: "CONFLICT", httpStatus: 409 },
          },
        },
      }
    );
    api.save.mockRejectedValueOnce(failure);
    render(<AiConnections />);
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "storage is busy"
    );
    expect(screen.getByLabelText("Base URL")).not.toBeDisabled();
  });
});
