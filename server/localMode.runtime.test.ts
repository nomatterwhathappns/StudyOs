import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLocalStudyMode } from "./runtimeMode";

afterEach(() => vi.unstubAllEnvs());

describe("local laptop runtime", () => {
  it("does not render an unresolved cloud analytics placeholder in the client shell", () => {
    const html = readFileSync(resolve(process.cwd(), "client/index.html"), "utf8");
    expect(html).not.toContain("VITE_ANALYTICS_ENDPOINT");
    expect(html).not.toContain("VITE_ANALYTICS_WEBSITE_ID");
  });

  it("works locally without an environment file and enables cloud mode only explicitly", () => {
    vi.stubEnv("STUDYOS_LOCAL_MODE", undefined);
    expect(isLocalStudyMode()).toBe(true);
    vi.stubEnv("STUDYOS_LOCAL_MODE", "true");
    expect(isLocalStudyMode()).toBe(true);
    vi.stubEnv("STUDYOS_LOCAL_MODE", "false");
    expect(isLocalStudyMode()).toBe(false);
  });
});
