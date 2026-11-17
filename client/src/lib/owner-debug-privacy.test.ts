import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const collector = readFileSync(
  resolve(process.cwd(), "client/public/__manus__/debug-collector.js"),
  "utf8"
);
const credentials = {
  username: "private-owner-username",
  password: "private-owner-password-long",
  setupKey: "private-owner-one-time-setup-key",
};
const windows: JSDOM[] = [];
const ownerUrls = [
  "/api/owner",
  "/api/owner/session",
  "/api/owner/setup",
  "/api/owner/login",
  "/api/owner/logout",
  "/api/owner/future/nested",
  "http://localhost:3000/api/owner/session",
  "/API/OWNER/login",
  "/api%2fowner%2flogin",
  "/api/%6fwner/setup",
  "/api%252fowner%252flogin",
  "/api/owner/login%ZZ",
  "http://[broken/api/%6fwner/login%",
];

function setup() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost:3000/",
    runScripts: "outside-only",
  });
  windows.push(dom);
  const win = dom.window;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(
    async (input: string | Request | URL, init: RequestInit = {}) => {
      const url =
        typeof input === "string"
          ? input
          : "url" in input
            ? input.url
            : input.href;
      calls.push({ url, init });
      return new Response(
        JSON.stringify(
          url === "/api/health"
            ? { message: "ordinary diagnostics" }
            : credentials
        ),
        { headers: { "content-type": "application/json" } }
      );
    }
  );
  Object.assign(win, { fetch: fetchMock, Headers, Request, Response });
  win.setInterval = vi.fn(() => 1) as typeof win.setInterval;
  for (const level of ["log", "debug", "info", "warn", "error"] as const)
    win.console[level] = vi.fn();

  class FakeXHR extends win.EventTarget {
    method = "GET";
    url = "";
    status = 200;
    statusText = "OK";
    responseText = "";
    open(method: string, url: string | URL) {
      this.method = method;
      this.url = String(url);
    }
    send(_body?: unknown) {
      this.responseText = JSON.stringify(
        this.url === "/api/health" ? { message: "ordinary XHR" } : credentials
      );
      this.dispatchEvent(new win.Event("load"));
      this.dispatchEvent(new win.Event("loadend"));
    }
    getResponseHeader(name: string) {
      return name.toLowerCase() === "content-type" ? "application/json" : null;
    }
  }
  Object.assign(win, { XMLHttpRequest: FakeXHR });
  runInContext(collector, dom.getInternalVMContext());
  const api = (
    win as unknown as {
      __MANUS_DEBUG_COLLECTOR__: {
        store: { networkRequests: Array<unknown>; uiEvents: Array<unknown> };
        forceReport: () => Promise<unknown>;
      };
    }
  ).__MANUS_DEBUG_COLLECTOR__;
  const report = async () => {
    await api.forceReport();
    return JSON.stringify(
      calls
        .filter(call => call.url === "/__manus__/logs")
        .map(call => JSON.parse(String(call.init.body)))
    );
  };
  return { win, api, calls, fetchMock, report, FakeXHR };
}

function expectNoCredentials(serialized: string) {
  for (const value of Object.values(credentials))
    expect(serialized).not.toContain(value);
}

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});

describe("owner authentication debug privacy", () => {
  it.each(ownerUrls)(
    "does not capture owner fetch request or response for %s",
    async url => {
      const { win, api, calls, report } = setup();
      const response = await win.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(credentials),
      });
      expect(await response.json()).toEqual(credentials);
      expect(calls[0].url).toBe(url);
      expect(api.store.networkRequests).toHaveLength(0);
      expect(api.store.uiEvents).toHaveLength(0);
      const serialized = await report();
      expectNoCredentials(serialized);
      expect(serialized).not.toContain("/api/owner");
    }
  );

  it("excludes Request and URL objects and rejected owner calls", async () => {
    const { win, api, fetchMock, report } = setup();
    await win.fetch(
      new Request("http://localhost:3000/api/owner/login", {
        method: "POST",
        body: JSON.stringify(credentials),
      })
    );
    await win.fetch(new URL("http://localhost:3000/api/owner/session"));
    fetchMock.mockRejectedValueOnce(new Error(credentials.username));
    await expect(
      win.fetch("/api/owner/setup", {
        method: "POST",
        body: JSON.stringify(credentials),
      })
    ).rejects.toThrow(credentials.username);
    expect(api.store.networkRequests).toHaveLength(0);
    expect(api.store.uiEvents).toHaveLength(0);
    expectNoCredentials(await report());
  });

  it("ignores owner XHR calls even when a recorded XHR object is reused", async () => {
    const { FakeXHR, api, report } = setup();
    const xhr = new FakeXHR();
    xhr.open("GET", "/api/health");
    xhr.send();
    expect(api.store.networkRequests).toHaveLength(1);
    for (const url of ownerUrls) {
      xhr.open("POST", url);
      xhr.send(JSON.stringify(credentials));
      const privateXhr = new FakeXHR();
      privateXhr.open("POST", url);
      privateXhr.send(JSON.stringify(credentials));
    }
    expect(api.store.networkRequests).toHaveLength(1);
    const serialized = await report();
    expectNoCredentials(serialized);
    expect(serialized).toContain("ordinary XHR");
  });

  it("preserves ordinary diagnostics without recording private form interactions", async () => {
    const { win, api, report } = setup();
    win.document.body.innerHTML =
      '<form data-private><input id="owner-username"><input id="owner-password" type="password"><input id="owner-setup-key" type="password"><button type="submit">Set up StudyOS</button></form>';
    for (const [id, value] of [
      ["owner-username", credentials.username],
      ["owner-password", credentials.password],
      ["owner-setup-key", credentials.setupKey],
    ]) {
      const input = win.document.getElementById(id) as HTMLInputElement;
      input.value = value;
      for (const event of ["change", "focusin", "focusout", "click"])
        input.dispatchEvent(new win.Event(event, { bubbles: true }));
    }
    win.document
      .querySelector("form")!
      .dispatchEvent(new win.Event("submit", { bubbles: true }));
    expect(api.store.uiEvents).toHaveLength(0);
    await win.fetch("/api/health");
    await vi.waitFor(() => expect(api.store.networkRequests).toHaveLength(1));
    const serialized = await report();
    expectNoCredentials(serialized);
    expect(serialized).toContain("ordinary diagnostics");
  });
});
