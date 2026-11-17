// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React, { useEffect } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resetStudyMemory, resumeStudyMemory } = vi.hoisted(() => ({
  resetStudyMemory: vi.fn(),
  resumeStudyMemory: vi.fn(),
}));
vi.mock("@/store/useStudyStore", () => ({
  resetStudyMemory,
  resumeStudyMemory,
}));

import {
  OwnerAccessGate,
  OwnerAccessProvider,
  OwnerAccountControls,
} from "./OwnerAccessContext";
import { notifyOwnerSessionExpired } from "@/lib/owner-access";

const signedOut = { enabled: true, authenticated: false, setupRequired: false };
const authenticated = {
  enabled: true,
  authenticated: true,
  setupRequired: false,
  username: "study.owner",
};
const response = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;
const mountProtected = vi.fn();
function PrivateWorkspace() {
  useEffect(() => {
    mountProtected();
  }, []);
  return (
    <>
      <p>Private learning data</p>
      <OwnerAccountControls />
    </>
  );
}
function renderAccess(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  const ui = render(
    <QueryClientProvider client={client}>
      <OwnerAccessProvider>
        <OwnerAccessGate>
          <PrivateWorkspace />
        </OwnerAccessGate>
      </OwnerAccessProvider>
    </QueryClientProvider>
  );
  return { ...ui, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("private owner access", () => {
  it("never mounts protected data while the initial session check is pending", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise(done => {
        resolve = done;
      })
    );
    renderAccess();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking private access"
    );
    expect(mountProtected).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "/api/owner/session",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        method: "GET",
      })
    );
    await act(async () => resolve(response(signedOut)));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(mountProtected).not.toHaveBeenCalled();
  });

  it.each(["network", "malformed", "unconfigured production"])(
    "keeps the gate closed on %s and lets the owner retry",
    async failure => {
      if (failure === "network")
        vi.mocked(fetch).mockRejectedValueOnce(new Error("Offline"));
      else
        vi.mocked(fetch).mockResolvedValueOnce(
          response(
            failure === "malformed"
              ? { authenticated: true }
              : { error: "Unavailable" },
            failure === "malformed" ? 200 : 503
          )
        );
      vi.mocked(fetch).mockResolvedValueOnce(response(signedOut));
      renderAccess();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "stays locked"
      );
      expect(mountProtected).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(
        await screen.findByRole("button", { name: "Sign in" })
      ).toBeVisible();
      expect(mountProtected).not.toHaveBeenCalled();
    }
  );

  it("allows the explicit local legacy mode without showing owner controls", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response({ enabled: false, authenticated: false, setupRequired: false })
    );
    renderAccess();
    expect(await screen.findByText("Private learning data")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(resumeStudyMemory).toHaveBeenCalled();
  });

  it("posts login credentials privately and confirms the cookie before mounting data", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(signedOut))
      .mockResolvedValueOnce(response(authenticated))
      .mockResolvedValueOnce(response(authenticated));
    renderAccess();
    await screen.findByRole("button", { name: "Sign in" });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "study.owner" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "  exact password value  " },
    });
    expect(
      screen.getByLabelText("Username").closest("[data-private]")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Private learning data")).toBeVisible();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/owner/login",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          username: "study.owner",
          password: "  exact password value  ",
        }),
      })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/api/owner/session",
      expect.objectContaining({ method: "GET" })
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(screen.getByText("study.owner")).toBeVisible();
  });

  it("clears a rejected password and keeps all private data unmounted", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(signedOut))
      .mockResolvedValueOnce(response({ error: "Invalid credentials" }, 401));
    renderAccess();
    await screen.findByRole("button", { name: "Sign in" });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "study.owner" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "username or password is incorrect"
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(mountProtected).not.toHaveBeenCalled();
  });

  it("requires the private setup key and matching strong password for the single owner", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ ...signedOut, setupRequired: true }))
      .mockResolvedValueOnce(response(authenticated))
      .mockResolvedValueOnce(response(authenticated));
    renderAccess();
    await screen.findByRole("button", { name: "Create owner account" });
    fireEvent.change(screen.getByLabelText("Private setup key"), {
      target: { value: "private-setup-key" },
    });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "study.owner" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "  long password value  " },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "not matching" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create owner account" })
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "passwords do not match"
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "  long password value  " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create owner account" })
    );
    expect(await screen.findByText("Private learning data")).toBeVisible();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/owner/setup",
      expect.objectContaining({
        body: JSON.stringify({
          setupKey: "private-setup-key",
          username: "study.owner",
          password: "  long password value  ",
        }),
      })
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("switches stale setup to sign in when another tab has already configured the owner", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ ...signedOut, setupRequired: true }))
      .mockResolvedValueOnce(
        response({ error: "Owner already configured" }, 409)
      )
      .mockResolvedValueOnce(response(signedOut));
    renderAccess();
    await screen.findByRole("button", { name: "Create owner account" });
    fireEvent.change(screen.getByLabelText("Private setup key"), {
      target: { value: "private-setup-key" },
    });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "study.owner" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "long private password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "long private password" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create owner account" })
    );

    expect(
      await screen.findByRole("heading", { name: "Welcome back" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(screen.queryByLabelText("Private setup key")).toBeNull();
    expect(screen.getByLabelText("Username")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(mountProtected).not.toHaveBeenCalled();
    expect(resumeStudyMemory).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/api/owner/session",
      expect.objectContaining({ method: "GET" })
    );
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("keeps an invalid setup key on the setup form and clears the submitted secrets", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ ...signedOut, setupRequired: true }))
      .mockResolvedValueOnce(response({ error: "Invalid setup key" }, 403));
    renderAccess();
    await screen.findByRole("button", { name: "Create owner account" });
    fireEvent.change(screen.getByLabelText("Private setup key"), {
      target: { value: "wrong-setup-key" },
    });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "study.owner" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "long private password" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "long private password" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create owner account" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Check the private setup key"
    );
    expect(
      screen.getByRole("button", { name: "Create owner account" })
    ).toBeVisible();
    expect(screen.getByLabelText("Private setup key")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Confirm password")).toHaveValue("");
    expect(mountProtected).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses to mount private data if the browser does not accept the login cookie", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(signedOut))
      .mockResolvedValueOnce(response(authenticated))
      .mockResolvedValueOnce(response(signedOut));
    renderAccess();
    await screen.findByRole("button", { name: "Sign in" });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "study.owner" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "private password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("alert");
    expect(mountProtected).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("immediately locks on logout and clears private React Query cache", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(authenticated))
      .mockResolvedValueOnce(response(signedOut));
    const { client } = renderAccess();
    await screen.findByRole("button", { name: "Sign out" });
    client.setQueryData(["private-connections"], { name: "private gateway" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.queryByText("Private learning data")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Sign in" })
    ).toBeVisible();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(resetStudyMemory).toHaveBeenCalled();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/owner/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: "{}",
      })
    );
  });

  it("keeps the workspace locked when server logout fails and provides a logout retry", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(authenticated))
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(response(signedOut));
    renderAccess();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByRole("button", { name: "Try signing out again" })
    ).toBeVisible();
    expect(screen.queryByText("Private learning data")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Try signing out again" })
    );
    expect(
      await screen.findByRole("button", { name: "Sign in" })
    ).toBeVisible();
  });

  it("locks an expired owner session and clears private cached data without redirects", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(authenticated));
    const { client } = renderAccess();
    await screen.findByText("Private learning data");
    client.setQueryData(["private"], "sensitive state");
    act(() => notifyOwnerSessionExpired());
    expect(
      await screen.findByRole("button", { name: "Sign in" })
    ).toBeVisible();
    expect(screen.queryByText("Private learning data")).toBeNull();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
