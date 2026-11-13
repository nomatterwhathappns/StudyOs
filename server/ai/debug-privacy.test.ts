import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

const collector = readFileSync(
  resolve(process.cwd(), "client/public/__manus__/debug-collector.js"),
  "utf8"
);
const secret = "collector-test-secret-key-keep-private";
const headerSecret = "collector-test-custom-header-value";
const windows: JSDOM[] = [];

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
          url.includes("aiConnections")
            ? { echoedSecret: secret, arbitraryValue: headerSecret }
            : { ok: true, content: "normal response" }
        ),
        {
          headers: {
            "content-type": "application/json",
            "x-custom-auth": headerSecret,
          },
        }
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
        this.url.includes("aiConnections")
          ? { arbitraryValue: headerSecret, echoedSecret: secret }
          : { content: "ordinary XHR" }
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
        store: { networkRequests: Array<any>; uiEvents: Array<any> };
        forceReport: () => Promise<unknown>;
      };
    }
  ).__MANUS_DEBUG_COLLECTOR__;
  const report = async () => {
    await api.forceReport();
    return calls
      .filter(call => call.url === "/__manus__/logs")
      .map(call => JSON.parse(String(call.init.body)));
  };
  return { dom, win, calls, fetchMock, api, report, FakeXHR };
}

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});

describe("development collector credential privacy", () => {
  it.each([
    "/api/trpc/aiConnections.save",
    "/api/trpc/study.chat,aiConnections.save?batch=1",
    "/api/trpc/study.chat%2CaiConnections%2Esave?batch=1",
    "http://localhost:3000/api/trpc/aiConnections.models?input=private-query",
  ])("excludes all data for the managed connection request %s", async url => {
    const { win, api, report, calls } = setup();
    const response = await win.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-any-auth": headerSecret,
      },
      body: JSON.stringify({
        apiKey: secret,
        extraHeaders: { "x-unusual": headerSecret },
      }),
    });
    expect(await response.json()).toHaveProperty("echoedSecret", secret);
    expect(api.store.networkRequests).toHaveLength(0);
    const serialized = JSON.stringify(await report());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(headerSecret);
    expect(serialized).not.toContain("aiConnections");
    expect(calls[0].url).toBe(url);
  });

  it("excludes Request and URL objects, including rejected private requests", async () => {
    const { win, fetchMock, api, report } = setup();
    await win.fetch(
      new Request("http://localhost:3000/api/trpc/aiConnections.save", {
        method: "POST",
        body: secret,
      })
    );
    await win.fetch(
      new URL("http://localhost:3000/api/trpc/aiConnections.test")
    );
    fetchMock.mockRejectedValueOnce(new Error(secret));
    await expect(win.fetch("/api/trpc/aiConnections.save")).rejects.toThrow(
      secret
    );
    expect(api.store.networkRequests).toHaveLength(0);
    expect(api.store.uiEvents).toHaveLength(0);
    expect(JSON.stringify(await report())).not.toContain(secret);
  });

  it("keeps ordinary fetch diagnostics while redacting arbitrary authentication headers", async () => {
    const { win, api, report } = setup();
    await win.fetch("/api/trpc/study.fetchSource", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "x-arbitrary-auth": headerSecret,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.org/lesson",
        extraHeaders: { "x-arbitrary-auth": headerSecret },
      }),
    });
    await vi.waitFor(() => expect(api.store.networkRequests).toHaveLength(1));
    const request = api.store.networkRequests[0];
    expect(request.request.headers).toMatchObject({
      authorization: "[REDACTED]",
      "x-arbitrary-auth": "[REDACTED]",
      "content-type": "application/json",
    });
    expect(request.response.headers["x-custom-auth"]).toBe("[REDACTED]");
    expect(request.request.body).toMatchObject({
      url: "https://example.org/lesson",
      extraHeaders: "[REDACTED]",
    });
    expect(request.response.body).toMatchObject({ content: "normal response" });
    const serialized = JSON.stringify(await report());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(headerSecret);
    expect(serialized).toContain("normal response");
  });

  it("ignores private UI subtrees and masks a custom-header textarea independently", async () => {
    const { win, api, report } = setup();
    win.document.body.innerHTML =
      '<section data-private><form><textarea id="private-settings"></textarea><button type="submit">Save connection</button></form></section><textarea id="connection-headers"></textarea><input id="learning-query">';
    const privateInput = win.document.getElementById(
      "private-settings"
    ) as HTMLTextAreaElement;
    privateInput.value = secret;
    privateInput.textContent = secret;
    for (const event of ["change", "focusin", "focusout", "click"])
      privateInput.dispatchEvent(new win.Event(event, { bubbles: true }));
    privateInput.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    privateInput
      .closest("form")!
      .dispatchEvent(new win.Event("submit", { bubbles: true }));
    expect(api.store.uiEvents).toHaveLength(0);

    const headerInput = win.document.getElementById(
      "connection-headers"
    ) as HTMLTextAreaElement;
    headerInput.value = JSON.stringify({ "x-unusual": headerSecret });
    headerInput.textContent = headerSecret;
    headerInput.dispatchEvent(new win.Event("change", { bubbles: true }));
    const normalInput = win.document.getElementById(
      "learning-query"
    ) as HTMLInputElement;
    normalInput.value = "mitochondria";
    normalInput.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(api.store.uiEvents).toHaveLength(2);
    expect(api.store.uiEvents[0].payload).toMatchObject({
      target: { text: "[REDACTED]" },
      value: { masked: true },
    });
    expect(api.store.uiEvents[1].payload.value).toBe("mitochondria");
    const serialized = JSON.stringify(await report());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(headerSecret);
    expect(serialized).toContain("mitochondria");
  });

  it("excludes private XHR bodies/responses, including a reused previously recorded XHR", async () => {
    const { FakeXHR, api, report } = setup();
    const xhr = new FakeXHR();
    xhr.open("POST", "/api/trpc/study.fetchSource");
    xhr.send(JSON.stringify({ url: "https://example.org/lesson" }));
    expect(api.store.networkRequests).toHaveLength(1);
    xhr.open("POST", "/api/trpc/study.chat%2CaiConnections%2Esave?batch=1");
    xhr.send(
      JSON.stringify({
        apiKey: secret,
        extraHeaders: { unusual: headerSecret },
      })
    );
    expect(api.store.networkRequests).toHaveLength(1);
    const other = new FakeXHR();
    other.open("POST", "http://localhost:3000/api/trpc/aiConnections.test");
    other.send(headerSecret);
    expect(api.store.networkRequests).toHaveLength(1);
    const serialized = JSON.stringify(await report());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(headerSecret);
    expect(serialized).toContain("ordinary XHR");
  });
});
