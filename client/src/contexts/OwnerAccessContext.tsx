import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  OWNER_SESSION_EXPIRED_EVENT,
  resumeProtectedRequests,
  suspendProtectedRequests,
} from "@/lib/owner-access";
import { resetStudyMemory, resumeStudyMemory } from "@/store/useStudyStore";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, LogOut, ShieldCheck } from "lucide-react";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type OwnerSession = {
  enabled: boolean;
  authenticated: boolean;
  setupRequired: boolean;
  username?: string;
};
type LoginInput = { username: string; password: string };
type SetupInput = LoginInput & { setupKey: string };
type AccessState =
  | { status: "checking" }
  | { status: "ready"; session: OwnerSession }
  | { status: "error"; retry: "session" | "logout" };
type OwnerAccessValue = {
  state: AccessState;
  login: (input: LoginInput) => Promise<void>;
  setup: (input: SetupInput) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
};

const OwnerAccessContext = createContext<OwnerAccessValue | null>(null);

class OwnerRequestError extends Error {
  constructor(readonly status: number) {
    super("Owner access request failed.");
  }
}

function parseSession(value: unknown): OwnerSession {
  if (!value || typeof value !== "object")
    throw new Error("Invalid session response.");
  const session = value as Record<string, unknown>;
  if (
    typeof session.enabled !== "boolean" ||
    typeof session.authenticated !== "boolean" ||
    typeof session.setupRequired !== "boolean"
  )
    throw new Error("Invalid session response.");
  if (
    session.authenticated &&
    (typeof session.username !== "string" || !session.username)
  )
    throw new Error("Invalid owner identity.");
  return {
    enabled: session.enabled,
    authenticated: session.authenticated,
    setupRequired: session.setupRequired,
    ...(session.authenticated ? { username: session.username as string } : {}),
  };
}

async function ownerRequest(
  action: "session" | "setup" | "login" | "logout",
  body?: LoginInput | SetupInput | Record<string, never>,
  signal?: AbortSignal
): Promise<OwnerSession> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, 15_000);
  try {
    const response = await fetch(`/api/owner/${action}`, {
      method: action === "session" ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(action === "session" ? {} : { "Content-Type": "application/json" }),
      },
      ...(action === "session" ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new OwnerRequestError(response.status);
    return parseSession(await response.json());
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function OwnerAccessProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AccessState>({ status: "checking" });
  const currentState = useRef(state);
  currentState.current = state;
  const requestVersion = useRef(0);
  const currentRequest = useRef<AbortController | null>(null);

  const clearPrivateState = useCallback(() => {
    suspendProtectedRequests();
    void queryClient.cancelQueries();
    queryClient.clear();
    resetStudyMemory();
  }, [queryClient]);
  const acceptSession = useCallback(
    (session: OwnerSession) => {
      if (!session.enabled || session.authenticated) {
        resumeProtectedRequests();
        resumeStudyMemory();
      } else clearPrivateState();
      setState({ status: "ready", session });
    },
    [clearPrivateState]
  );
  const checkSession = useCallback(async () => {
    const version = ++requestVersion.current;
    currentRequest.current?.abort();
    const controller = new AbortController();
    currentRequest.current = controller;
    clearPrivateState();
    setState({ status: "checking" });
    try {
      const session = await ownerRequest(
        "session",
        undefined,
        controller.signal
      );
      if (version === requestVersion.current) acceptSession(session);
    } catch {
      if (version === requestVersion.current)
        setState({ status: "error", retry: "session" });
    }
  }, [acceptSession, clearPrivateState]);

  useEffect(() => {
    void checkSession();
    return () => {
      requestVersion.current += 1;
      currentRequest.current?.abort();
    };
  }, [checkSession]);
  useEffect(() => {
    const expired = () => {
      const value = currentState.current;
      if (
        value.status !== "ready" ||
        !value.session.enabled ||
        !value.session.authenticated
      )
        return;
      requestVersion.current += 1;
      currentRequest.current?.abort();
      clearPrivateState();
      acceptSession({
        enabled: true,
        authenticated: false,
        setupRequired: false,
      });
    };
    window.addEventListener(OWNER_SESSION_EXPIRED_EVENT, expired);
    return () =>
      window.removeEventListener(OWNER_SESSION_EXPIRED_EVENT, expired);
  }, [acceptSession, clearPrivateState]);

  const authenticate = async (
    action: "login" | "setup",
    input: LoginInput | SetupInput
  ) => {
    const version = ++requestVersion.current;
    currentRequest.current?.abort();
    const controller = new AbortController();
    currentRequest.current = controller;
    let result: OwnerSession;
    try {
      result = await ownerRequest(action, input, controller.signal);
    } catch (reason) {
      if (
        action === "setup" &&
        reason instanceof OwnerRequestError &&
        reason.status === 409
      ) {
        const session = await ownerRequest(
          "session",
          undefined,
          controller.signal
        );
        if (session.enabled && !session.setupRequired) {
          // A setup conflict changes the available form, never grants access.
          if (version === requestVersion.current)
            acceptSession({
              enabled: true,
              authenticated: false,
              setupRequired: false,
            });
          return;
        }
      }
      throw reason;
    }
    if (!result.enabled || !result.authenticated)
      throw new Error("The owner session was not established.");
    // Confirm that the HttpOnly cookie works before mounting private data.
    const session = await ownerRequest("session", undefined, controller.signal);
    if (!session.enabled || !session.authenticated)
      throw new Error("The owner session was not established.");
    if (version === requestVersion.current) acceptSession(session);
  };
  const logout = async () => {
    const version = ++requestVersion.current;
    currentRequest.current?.abort();
    const controller = new AbortController();
    currentRequest.current = controller;
    clearPrivateState();
    setState({ status: "checking" });
    try {
      const session = await ownerRequest("logout", {}, controller.signal);
      if (session.authenticated) throw new Error("Sign out was not confirmed.");
      if (version === requestVersion.current) acceptSession(session);
    } catch {
      if (version === requestVersion.current)
        setState({ status: "error", retry: "logout" });
    }
  };

  return (
    <OwnerAccessContext.Provider
      value={{
        state,
        login: input => authenticate("login", input),
        setup: input => authenticate("setup", input),
        logout,
        retry: () => {
          if (state.status === "error" && state.retry === "logout")
            void logout();
          else void checkSession();
        },
      }}
    >
      {children}
    </OwnerAccessContext.Provider>
  );
}

export function OwnerAccessGate({ children }: { children: React.ReactNode }) {
  const access = useContext(OwnerAccessContext);
  if (!access) throw new Error("Owner access provider is required.");
  const { state } = access;
  if (
    state.status === "ready" &&
    (!state.session.enabled || state.session.authenticated)
  )
    return <>{children}</>;
  return (
    <main
      data-private="true"
      className="flex min-h-[100dvh] items-center justify-center bg-background px-5 py-10 text-foreground"
    >
      <section className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-lg sm:p-8">
        <div className="mb-7 flex items-center gap-3">
          <span className="rounded-2xl border border-border bg-secondary p-3 text-primary">
            <ShieldCheck className="size-5" />
          </span>
          <div>
            <p className="font-display text-2xl italic">StudyOS</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Your private learning space
            </p>
          </div>
        </div>
        {state.status === "checking" ? (
          <p
            role="status"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            Checking private access…
          </p>
        ) : state.status === "error" ? (
          <div className="space-y-4">
            <h1 className="text-xl font-semibold">
              {state.retry === "logout"
                ? "Sign out is not confirmed"
                : "Private access is unavailable"}
            </h1>
            <p
              role="alert"
              className="text-sm leading-relaxed text-muted-foreground"
            >
              {state.retry === "logout"
                ? "Your learning space is locked on this browser. Try again to finish signing out of the server."
                : "StudyOS could not verify access. Your learning space stays locked until the server responds."}
            </p>
            <Button
              type="button"
              onClick={access.retry}
              className="w-full rounded-xl"
            >
              {state.retry === "logout" ? "Try signing out again" : "Try again"}
            </Button>
          </div>
        ) : (
          <OwnerAccessForm
            key={state.session.setupRequired ? "setup" : "login"}
            setupRequired={state.session.setupRequired}
          />
        )}
      </section>
    </main>
  );
}

function OwnerAccessForm({ setupRequired }: { setupRequired: boolean }) {
  const access = useContext(OwnerAccessContext)!;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setError("");
    if (setupRequired && !/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
      setError(
        "Use 3–64 letters, numbers, periods, underscores, or hyphens for the username."
      );
      return;
    }
    if (
      setupRequired &&
      (Array.from(password).length < 14 || Array.from(password).length > 128)
    ) {
      setError("Choose a password with 14–128 characters.");
      return;
    }
    if (setupRequired && password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setPending(true);
    try {
      if (setupRequired) await access.setup({ setupKey, username, password });
      else await access.login({ username, password });
      setUsername("");
    } catch (reason) {
      setError(
        reason instanceof OwnerRequestError && reason.status === 429
          ? "Too many attempts. Wait a little before trying again."
          : reason instanceof OwnerRequestError && reason.status === 401
            ? setupRequired
              ? "The setup key or account details were not accepted."
              : "The username or password is incorrect."
            : setupRequired
              ? "Owner setup could not be completed. Check the private setup key and try again."
              : "Sign in could not be completed. Check the server connection and try again."
      );
    } finally {
      setPassword("");
      setConfirmation("");
      setSetupKey("");
      setPending(false);
    }
  };
  return (
    <form
      data-private="true"
      autoComplete="off"
      onSubmit={event => void submit(event)}
      className="space-y-5"
    >
      <div>
        <h1 className="font-display text-3xl italic">
          {setupRequired ? "Set up your owner account" : "Welcome back"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {setupRequired
            ? "Create the single account that can open this StudyOS learning space."
            : "Sign in with your StudyOS owner account to continue."}
        </p>
      </div>
      {setupRequired && (
        <div className="space-y-2">
          <Label htmlFor="owner-setup-key">Private setup key</Label>
          <Input
            id="owner-setup-key"
            name="setupKey"
            type="password"
            autoComplete="off"
            value={setupKey}
            onChange={event => setSetupKey(event.target.value)}
            required
            disabled={pending}
            className="h-11 rounded-xl text-base"
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Use the private STUDYOS_OWNER_SETUP_KEY from your deployment’s
            environment settings. It is required only for this first setup.
          </p>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="owner-username">Username</Label>
        <Input
          id="owner-username"
          name="username"
          value={username}
          onChange={event => setUsername(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={64}
          required
          disabled={pending}
          className="h-11 rounded-xl text-base"
        />
        {setupRequired && (
          <p className="text-xs text-muted-foreground">
            3–64 letters, numbers, periods, underscores, or hyphens.
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="owner-password">Password</Label>
        <Input
          id="owner-password"
          name="password"
          type="password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          autoComplete={setupRequired ? "new-password" : "current-password"}
          required
          disabled={pending}
          className="h-11 rounded-xl text-base"
        />
        {setupRequired && (
          <p className="text-xs text-muted-foreground">
            Use 14–128 characters. Spaces are kept as part of your password.
          </p>
        )}
      </div>
      {setupRequired && (
        <div className="space-y-2">
          <Label htmlFor="owner-confirm-password">Confirm password</Label>
          <Input
            id="owner-confirm-password"
            name="confirmPassword"
            type="password"
            value={confirmation}
            onChange={event => setConfirmation(event.target.value)}
            autoComplete="new-password"
            required
            disabled={pending}
            className="h-11 rounded-xl text-base"
          />
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <Button
        type="submit"
        disabled={pending}
        className="h-11 w-full rounded-xl"
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <KeyRound className="size-4" />
        )}
        {pending
          ? "Please wait…"
          : setupRequired
            ? "Create owner account"
            : "Sign in"}
      </Button>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {setupRequired
          ? "This is private owner setup. Public registration is not available."
          : "This is a private workspace. Ask the owner for access if this is not your account."}
      </p>
    </form>
  );
}

export function OwnerAccountControls() {
  const access = useContext(OwnerAccessContext);
  if (
    !access ||
    access.state.status !== "ready" ||
    !access.state.session.enabled ||
    !access.state.session.authenticated
  )
    return null;
  return (
    <div
      data-private="true"
      className="mt-4 flex flex-wrap items-center gap-3 text-sm"
    >
      <p className="min-w-0 break-words text-muted-foreground">
        Signed in as{" "}
        <span className="font-medium text-foreground">
          {access.state.session.username}
        </span>
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void access.logout()}
        className="rounded-xl"
      >
        <LogOut className="size-3.5" />
        Sign out
      </Button>
    </div>
  );
}
