import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  readAiPreferences,
  saveAiResponseStyle,
  type AiResponseStyle,
} from "@/lib/ai-preferences";
import { trpc } from "@/lib/trpc";
import { TRPCClientError } from "@trpc/client";
import {
  AI_PROTOCOL_LABELS,
  aiConnectionInputSchema,
  type AiConnectionDraft,
  type AiProtocol,
  type PublicAiConnection,
} from "@shared/ai-connections";
import {
  Check,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react";
import React, { useRef, useState } from "react";

function connectionError(reason: unknown, fallback: string) {
  // Only typed server errors are shown; provider response bodies never reach here.
  if (reason instanceof TRPCClientError && reason.data?.code && reason.message)
    return reason.message.slice(0, 800);
  return fallback;
}

type FormState = {
  id?: string;
  name: string;
  baseUrl: string;
  protocol: AiProtocol;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  authType: "bearer" | "header" | "none";
  authHeader: string;
  headersJson: string;
  clearHeaders: boolean;
  stream: boolean;
  timeoutSeconds: string;
  maxOutputTokens: string;
  tokenParameter: "auto" | "max_tokens" | "max_completion_tokens" | "none";
  jsonMode: "prompt" | "native";
};

const protocolDefaults: Record<
  AiProtocol,
  { baseUrl: string; authType: FormState["authType"]; authHeader: string }
> = {
  "openai-chat": {
    baseUrl: "https://api.openai.com/v1",
    authType: "bearer",
    authHeader: "x-api-key",
  },
  "openai-responses": {
    baseUrl: "https://api.openai.com/v1",
    authType: "bearer",
    authHeader: "x-api-key",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    authType: "header",
    authHeader: "x-api-key",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authType: "header",
    authHeader: "x-goog-api-key",
  },
};

function emptyForm(): FormState {
  return {
    name: "",
    ...protocolDefaults["openai-chat"],
    protocol: "openai-chat",
    model: "",
    apiKey: "",
    clearApiKey: false,
    headersJson: "",
    clearHeaders: false,
    stream: true,
    timeoutSeconds: "60",
    maxOutputTokens: "4096",
    tokenParameter: "auto",
    jsonMode: "prompt",
  };
}

const inputClass = "h-10 rounded-xl border-border bg-secondary text-sm";
const selectClass = `${inputClass} w-full min-w-0 border px-3 outline-none focus:border-primary`;

export function AiConnections() {
  const utils = trpc.useUtils();
  const list = trpc.aiConnections.list.useQuery(undefined, {
    staleTime: 30_000,
  });
  // Draft secrets stay only in this form and short-lived mutation memory.
  const save = trpc.aiConnections.save.useMutation({ gcTime: 0 });
  const activate = trpc.aiConnections.activate.useMutation();
  const remove = trpc.aiConnections.remove.useMutation();
  const test = trpc.aiConnections.test.useMutation({ gcTime: 0 });
  const fetchModels = trpc.aiConnections.models.useMutation({ gcTime: 0 });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saved, setSaved] = useState<PublicAiConnection | null>(null);
  const [models, setModels] = useState<Array<{ id: string; name?: string }>>(
    []
  );
  const [formError, setFormError] = useState("");
  const [formNotice, setFormNotice] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [responseStyle, setResponseStyle] = useState<AiResponseStyle>(
    () => readAiPreferences().responseStyle
  );
  const formVersion = useRef(0);
  const [formBusy, setFormBusy] = useState(false);
  const connections = list.data?.connections ?? [];
  const busy =
    formBusy || save.isPending || test.isPending || fetchModels.isPending;

  const resetForm = () => {
    formVersion.current += 1;
    setFormBusy(false);
    setForm(emptyForm());
    setSaved(null);
    setModels([]);
    setFormError("");
    setFormNotice("");
    save.reset();
    test.reset();
    fetchModels.reset();
  };
  const closeForm = () => {
    setOpen(false);
    resetForm();
  };
  const editConnection = (connection?: PublicAiConnection) => {
    resetForm();
    if (connection) {
      setSaved(connection);
      setForm({
        id: connection.id,
        name: connection.name,
        baseUrl: connection.baseUrl,
        protocol: connection.protocol,
        model: connection.model,
        apiKey: "",
        clearApiKey: false,
        authType: connection.authType,
        authHeader: connection.authHeader,
        headersJson: "",
        clearHeaders: false,
        stream: connection.stream,
        timeoutSeconds: String(connection.timeoutMs / 1000),
        maxOutputTokens: String(connection.maxOutputTokens),
        tokenParameter: connection.tokenParameter,
        jsonMode: connection.jsonMode,
      });
    }
    setOpen(true);
  };
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(current => ({ ...current, [key]: value }));
    setFormError("");
    setFormNotice("");
  };
  const changeProtocol = (protocol: AiProtocol) => {
    setForm(current => ({
      ...current,
      protocol,
      authType: protocolDefaults[protocol].authType,
      authHeader: protocolDefaults[protocol].authHeader,
      baseUrl:
        !current.baseUrl ||
        current.baseUrl === protocolDefaults[current.protocol].baseUrl
          ? protocolDefaults[protocol].baseUrl
          : current.baseUrl,
    }));
    setModels([]);
    setFormError("");
    setFormNotice("");
  };
  const draftInput = (
    purpose: "save" | "test" | "models"
  ): AiConnectionDraft | null => {
    let extraHeaders: Record<string, string> | undefined;
    if (form.headersJson.trim() && !form.clearHeaders) {
      try {
        const parsed: unknown = JSON.parse(form.headersJson);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.values(parsed).some(value => typeof value !== "string")
        )
          throw new Error();
        extraHeaders = parsed as Record<string, string>;
      } catch {
        setFormError(
          "Custom headers must be a JSON object with string values."
        );
        return null;
      }
    }
    const result = aiConnectionInputSchema.safeParse({
      ...(form.id ? { id: form.id } : {}),
      name: form.name.trim() || (purpose === "save" ? "" : "Connection test"),
      baseUrl: form.baseUrl.trim(),
      protocol: form.protocol,
      model: form.model.trim() || (purpose === "models" ? "model-list" : ""),
      authType: form.authType,
      authHeader: form.authHeader.trim(),
      ...(form.apiKey.trim() && !form.clearApiKey
        ? { apiKey: form.apiKey.trim() }
        : {}),
      ...(form.clearApiKey ? { clearApiKey: true } : {}),
      ...(extraHeaders ? { extraHeaders } : {}),
      ...(form.clearHeaders ? { clearHeaders: true } : {}),
      stream: form.stream,
      timeoutMs: Number(form.timeoutSeconds) * 1000,
      maxOutputTokens: Number(form.maxOutputTokens),
      tokenParameter: form.tokenParameter,
      jsonMode: form.jsonMode,
    });
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path[0];
      setFormError(
        field === "model"
          ? "Enter a model ID, or fetch the available models first."
          : field === "name"
            ? "Enter a connection name."
            : issue?.message || "Check the connection settings."
      );
      return null;
    }
    return result.data;
  };
  const refresh = () => utils.aiConnections.list.invalidate();
  const saveConnection = async () => {
    const draft = draftInput("save");
    if (!draft) return;
    const version = formVersion.current;
    setFormBusy(true);
    setFormError("");
    try {
      await save.mutateAsync(draft);
      await refresh();
      setError("");
      setNotice("Connection saved.");
      if (version === formVersion.current) closeForm();
    } catch (reason) {
      if (version === formVersion.current)
        setFormError(
          connectionError(
            reason,
            "The connection could not be saved. Check the settings and try again."
          )
        );
    } finally {
      if (version === formVersion.current) {
        setFormBusy(false);
        save.reset();
      }
    }
  };
  const probeDraft = async (kind: "test" | "models") => {
    const draft = draftInput(kind);
    if (!draft) return;
    const version = formVersion.current;
    setFormBusy(true);
    setFormError("");
    setFormNotice("");
    const payload = { ...(form.id ? { id: form.id } : {}), draft };
    try {
      if (kind === "models") {
        const result = await fetchModels.mutateAsync(payload);
        if (version !== formVersion.current) return;
        setModels(result.models);
        setFormNotice(
          result.models.length
            ? `${result.models.length} models found. Choose one below or enter a model ID.`
            : "No models were listed. You can still enter a model ID manually."
        );
      } else {
        const result = await test.mutateAsync(payload);
        if (version === formVersion.current)
          setFormNotice(`${result.message} (${result.latencyMs} ms)`);
      }
    } catch (reason) {
      if (version === formVersion.current)
        setFormError(
          connectionError(
            reason,
            kind === "models"
              ? "Models could not be fetched. Check the connection, or enter a model ID manually."
              : "Connection test failed. Check the URL, authentication, API protocol, and model."
          )
        );
    } finally {
      if (version === formVersion.current) {
        setFormBusy(false);
        test.reset();
        fetchModels.reset();
      }
    }
  };
  const useConnection = async (connection: PublicAiConnection) => {
    setError("");
    setNotice("");
    try {
      await activate.mutateAsync({ id: connection.id });
      await refresh();
      setNotice(`${connection.name} is now active.`);
    } catch (reason) {
      setError(
        connectionError(
          reason,
          "The active connection could not be changed. Try again."
        )
      );
    }
  };
  const deleteConnection = async (connection: PublicAiConnection) => {
    if (
      !window.confirm(
        `Delete ${connection.name}? Its saved key and custom headers will also be removed.`
      )
    )
      return;
    setError("");
    setNotice("");
    try {
      await remove.mutateAsync({ id: connection.id });
      await refresh();
      setNotice("Connection deleted.");
    } catch (reason) {
      setError(
        connectionError(
          reason,
          "The connection could not be deleted. Try again."
        )
      );
    }
  };
  const testSaved = async (connection: PublicAiConnection) => {
    const version = formVersion.current;
    setError("");
    setNotice("");
    try {
      const result = await test.mutateAsync({ id: connection.id });
      setNotice(
        `${connection.name}: ${result.message} (${result.latencyMs} ms)`
      );
    } catch (reason) {
      setError(
        connectionError(
          reason,
          `Could not connect using ${connection.name}. Edit its settings and test again.`
        )
      );
    } finally {
      if (version === formVersion.current) test.reset();
    }
  };

  return (
    <section
      id="ai-connections"
      data-private="true"
      aria-labelledby="ai-connections-heading"
      className="study-section-card mt-8 scroll-mt-24"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2
            id="ai-connections-heading"
            className="font-display text-2xl italic"
          >
            AI Connections
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Connect your AI provider or proxy. The active connection is used for
            chat, explanations, translation, key terms, and quizzes.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => editConnection()}
          className="shrink-0 rounded-xl"
        >
          <Plus className="size-4" />
          Add connection
        </Button>
      </div>
      {list.isLoading ? (
        <p role="status" className="mt-5 text-sm text-muted-foreground">
          Loading AI connections…
        </p>
      ) : list.isError ? (
        <div role="alert" className="mt-5 text-sm text-destructive">
          {connectionError(list.error, "AI connections could not be loaded.")}{" "}
          <button
            type="button"
            onClick={() => void list.refetch()}
            className="underline"
          >
            Try again
          </button>
        </div>
      ) : connections.length ? (
        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          {connections.map(connection => {
            const active = list.data?.activeId === connection.id;
            return (
              <article
                key={connection.id}
                className={`min-w-0 rounded-2xl border p-4 ${active ? "border-primary bg-primary/5" : "border-border bg-secondary/25"}`}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 rounded-xl border border-border p-2 text-primary">
                    <KeyRound className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="break-words font-medium">
                      {connection.name}
                    </h3>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {connection.model}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {AI_PROTOCOL_LABELS[connection.protocol]}
                    </p>
                    <p className="mt-1 break-all text-xs leading-relaxed text-muted-foreground">
                      {connection.baseUrl}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {connection.hasApiKey
                        ? `Key saved${connection.keySuffix ? ` · ending ${connection.keySuffix}` : ""}`
                        : "No API key"}
                      {connection.headerNames.length
                        ? ` · ${connection.headerNames.length} custom headers`
                        : ""}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    disabled={active || activate.isPending}
                    onClick={() => void useConnection(connection)}
                    className="rounded-lg"
                    aria-label={
                      active
                        ? `Active connection: ${connection.name}`
                        : `Use ${connection.name}`
                    }
                  >
                    {active ? (
                      <>
                        <Check className="size-3.5" />
                        Active
                      </>
                    ) : (
                      "Use connection"
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={test.isPending}
                    onClick={() => void testSaved(connection)}
                    className="rounded-lg"
                    aria-label={`Test ${connection.name}`}
                  >
                    <RefreshCw className="size-3.5" />
                    Test
                  </Button>
                  <button
                    type="button"
                    onClick={() => editConnection(connection)}
                    aria-label={`Edit ${connection.name}`}
                    className="study-icon-button"
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    type="button"
                    disabled={remove.isPending}
                    onClick={() => void deleteConnection(connection)}
                    aria-label={`Delete ${connection.name}`}
                    className="study-icon-button text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="mt-5 flex items-center gap-3 rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground">
          <Unplug className="size-5 shrink-0" />
          <p>No connections yet. Add a provider or proxy to get started.</p>
        </div>
      )}
      {notice && (
        <p
          role="status"
          className="mt-4 rounded-xl border border-primary/35 bg-primary/10 p-3 text-sm"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-destructive/35 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <Label htmlFor="ai-response-style">Response speed</Label>
        <select
          id="ai-response-style"
          value={responseStyle}
          onChange={event => {
            const value = event.target.value as AiResponseStyle;
            setResponseStyle(value);
            saveAiResponseStyle(value);
          }}
          className={`${selectClass} max-w-xs`}
        >
          <option value="Fast">Fast · quick, focused answers</option>
          <option value="Balanced">Balanced · everyday study help</option>
          <option value="Deep">Deep · thorough explanations</option>
        </select>
      </div>

      <Dialog
        open={open}
        onOpenChange={next => {
          if (!next) closeForm();
        }}
      >
        <DialogContent
          data-private="true"
          className="max-h-[90dvh] overflow-y-auto rounded-2xl border-border bg-card text-card-foreground sm:max-w-2xl"
        >
          <DialogHeader>
            <DialogTitle className="font-display text-2xl italic">
              {saved ? "Edit AI connection" : "Add AI connection"}
            </DialogTitle>
            <DialogDescription>
              Use an AI provider, an OpenAI-compatible proxy, or a local
              endpoint. Keys and custom headers are saved on the server and are
              never stored in this browser.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={event => {
              event.preventDefault();
              if (!busy) void saveConnection();
            }}
            autoComplete="off"
            className="space-y-4"
          >
            <fieldset disabled={busy} className="min-w-0 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Connection name" id="connection-name">
                  <Input
                    id="connection-name"
                    value={form.name}
                    maxLength={80}
                    onChange={event => update("name", event.target.value)}
                    placeholder="My AI provider"
                    className={inputClass}
                  />
                </Field>
                <Field label="API protocol" id="connection-protocol">
                  <select
                    id="connection-protocol"
                    value={form.protocol}
                    onChange={event =>
                      changeProtocol(event.target.value as AiProtocol)
                    }
                    className={selectClass}
                  >
                    {Object.entries(AI_PROTOCOL_LABELS).map(
                      ([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      )
                    )}
                  </select>
                </Field>
              </div>
              <Field label="Base URL" id="connection-base-url">
                <Input
                  id="connection-base-url"
                  value={form.baseUrl}
                  onChange={event => {
                    update("baseUrl", event.target.value);
                    setModels([]);
                  }}
                  placeholder="https://your-provider.example/v1"
                  type="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  className={inputClass}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Enter the API base URL supplied by your provider or proxy. Do
                  not put API keys in the URL.
                </p>
              </Field>
              <Field label="API key" id="connection-api-key">
                <Input
                  id="connection-api-key"
                  value={form.apiKey}
                  onChange={event => update("apiKey", event.target.value)}
                  disabled={form.clearApiKey}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={
                    saved?.hasApiKey
                      ? "Leave blank to keep the saved key"
                      : "Optional for endpoints without authentication"
                  }
                  className={inputClass}
                />
                {saved?.hasApiKey && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      A key is saved
                      {saved.keySuffix ? ` · ending ${saved.keySuffix}` : ""}.
                      Leave blank to keep it.
                    </p>
                    <CheckField
                      label="Remove saved key"
                      checked={form.clearApiKey}
                      onChange={checked => {
                        update("clearApiKey", checked);
                        if (checked) update("apiKey", "");
                      }}
                    />
                  </>
                )}
              </Field>
              <Field label="Model" id="connection-model">
                <Input
                  id="connection-model"
                  value={form.model}
                  onChange={event => update("model", event.target.value)}
                  placeholder="Enter a model ID"
                  maxLength={200}
                  autoCapitalize="none"
                  spellCheck={false}
                  className={inputClass}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void probeDraft("models")}
                    className="rounded-lg"
                  >
                    {fetchModels.isPending && (
                      <Loader2 className="size-3.5 animate-spin" />
                    )}
                    Fetch models
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Manual model IDs are always supported.
                  </span>
                </div>
                {models.length > 0 && (
                  <select
                    aria-label="Available models"
                    value=""
                    onChange={event => update("model", event.target.value)}
                    className={selectClass}
                  >
                    <option value="" disabled>
                      Choose a fetched model
                    </option>
                    {models.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.name ? `${model.name} · ${model.id}` : model.id}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <details className="rounded-xl border border-border p-4">
                <summary className="cursor-pointer text-sm font-medium">
                  Advanced settings
                </summary>
                <div className="mt-4 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Authentication" id="connection-auth">
                      <select
                        id="connection-auth"
                        value={form.authType}
                        onChange={event =>
                          update(
                            "authType",
                            event.target.value as FormState["authType"]
                          )
                        }
                        className={selectClass}
                      >
                        <option value="bearer">Bearer token</option>
                        <option value="header">
                          Custom authentication header
                        </option>
                        <option value="none">No authentication</option>
                      </select>
                    </Field>
                    {form.authType === "header" && (
                      <Field
                        label="Authentication header"
                        id="connection-auth-header"
                      >
                        <Input
                          id="connection-auth-header"
                          value={form.authHeader}
                          onChange={event =>
                            update("authHeader", event.target.value)
                          }
                          placeholder="x-api-key"
                          className={inputClass}
                        />
                      </Field>
                    )}
                  </div>
                  <Field label="Custom headers JSON" id="connection-headers">
                    <textarea
                      id="connection-headers"
                      value={form.headersJson}
                      onChange={event =>
                        update("headersJson", event.target.value)
                      }
                      disabled={form.clearHeaders}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={'{"x-project-id": "your-project"}'}
                      className="min-h-24 w-full rounded-xl border border-border bg-secondary px-3 py-2 font-mono text-sm outline-none focus:border-primary"
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {saved?.headerNames.length
                        ? `Saved header names: ${saved.headerNames.join(", ")}. Leave blank to keep them; entering JSON replaces them.`
                        : "Optional JSON object of header names and string values. Use Authentication for the API key."}
                    </p>
                    {!!saved?.headerNames.length && (
                      <CheckField
                        label="Remove saved headers"
                        checked={form.clearHeaders}
                        onChange={checked => {
                          update("clearHeaders", checked);
                          if (checked) update("headersJson", "");
                        }}
                      />
                    )}
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Timeout (seconds)" id="connection-timeout">
                      <Input
                        id="connection-timeout"
                        type="number"
                        min={1}
                        max={180}
                        step={1}
                        value={form.timeoutSeconds}
                        onChange={event =>
                          update("timeoutSeconds", event.target.value)
                        }
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Max output tokens" id="connection-tokens">
                      <Input
                        id="connection-tokens"
                        type="number"
                        min={64}
                        max={32768}
                        step={1}
                        value={form.maxOutputTokens}
                        onChange={event =>
                          update("maxOutputTokens", event.target.value)
                        }
                        className={inputClass}
                      />
                    </Field>
                    <Field
                      label="Token parameter"
                      id="connection-token-parameter"
                    >
                      <select
                        id="connection-token-parameter"
                        value={form.tokenParameter}
                        onChange={event =>
                          update(
                            "tokenParameter",
                            event.target.value as FormState["tokenParameter"]
                          )
                        }
                        className={selectClass}
                      >
                        <option value="auto">Automatic</option>
                        <option value="max_tokens">max_tokens</option>
                        <option value="max_completion_tokens">
                          max_completion_tokens
                        </option>
                        <option value="none">Do not send a token limit</option>
                      </select>
                    </Field>
                    <Field label="JSON output" id="connection-json">
                      <select
                        id="connection-json"
                        value={form.jsonMode}
                        onChange={event =>
                          update(
                            "jsonMode",
                            event.target.value as FormState["jsonMode"]
                          )
                        }
                        className={selectClass}
                      >
                        <option value="prompt">
                          Prompt instructions · compatible
                        </option>
                        <option value="native">Native JSON format</option>
                      </select>
                    </Field>
                  </div>
                  <CheckField
                    label="Stream responses"
                    checked={form.stream}
                    onChange={checked => update("stream", checked)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Disable streaming or choose prompt-based JSON if your proxy
                    does not support those features.
                  </p>
                </div>
              </details>
              {formError && (
                <p
                  role="alert"
                  className="rounded-xl border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive"
                >
                  {formError}
                </p>
              )}
              {formNotice && (
                <p
                  role="status"
                  className="rounded-xl border border-primary/35 bg-primary/10 p-3 text-sm"
                >
                  {formNotice}
                </p>
              )}
            </fieldset>
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void probeDraft("test")}
                className="rounded-xl"
              >
                {test.isPending && <Loader2 className="size-4 animate-spin" />}
                Test connection
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={closeForm}
                className="ml-auto rounded-xl"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy} className="rounded-xl">
                {save.isPending && <Loader2 className="size-4 animate-spin" />}
                {saved ? "Save changes" : "Save connection"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Field({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="size-4 shrink-0 accent-primary"
      />
      <span>{label}</span>
    </label>
  );
}
