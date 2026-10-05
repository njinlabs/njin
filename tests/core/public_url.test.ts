import { describe, expect, it, mock } from "bun:test";
import * as realConfig from "../../src/core/config";

let publicUrl: string | undefined;

mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ publicUrl }),
}));

const { publicBase } = await import("../../src/core/public_url");

const request = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe("publicBase", () => {
  it("prefers the configured publicUrl and drops trailing slashes", () => {
    publicUrl = "https://site.example///";
    expect(publicBase(request("http://localhost:3000/mcp"))).toBe(
      "https://site.example",
    );
  });

  it("handles a very long run of trailing slashes without stalling", () => {
    publicUrl = `https://site.example${"/".repeat(100_000)}`;
    const started = performance.now();

    expect(publicBase(request("http://localhost/mcp"))).toBe(
      "https://site.example",
    );
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("falls back to the request's own origin", () => {
    publicUrl = undefined;
    expect(publicBase(request("http://localhost:3000/mcp"))).toBe(
      "http://localhost:3000",
    );
  });

  it("honours a reverse proxy's forwarded proto and host", () => {
    publicUrl = undefined;
    expect(
      publicBase(
        request("http://127.0.0.1:3000/mcp", {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "site.example",
        }),
      ),
    ).toBe("https://site.example");
  });

  it("uses only the first value of a multi-hop forwarded header", () => {
    publicUrl = undefined;
    expect(
      publicBase(
        request("http://127.0.0.1/mcp", {
          "x-forwarded-proto": "https, http",
          "x-forwarded-host": "site.example, internal",
        }),
      ),
    ).toBe("https://site.example");
  });
});
