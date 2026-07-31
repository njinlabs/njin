import { describe, expect, it } from "bun:test";
import { extractFilename, isAllowed } from "../../src/modules/img";

describe("isAllowed", () => {
  it("always allows relative paths", () => {
    expect(isAllowed("/api/file/abc.png", [])).toBe(true);
  });

  it("does not trust an arbitrary host just because it matches the client-supplied Host header", () => {
    // Previously isAllowed() took the incoming request's Host header and trusted any
    // image host that matched it — trivially spoofable by an attacker crafting their own
    // request, turning /img into an open SSRF proxy. That comparison has been removed.
    expect(isAllowed("https://internal-admin.local/img.png", [])).toBe(false);
  });

  it("allows localhost and 127.0.0.1 outside production (Vite dev server)", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    expect(isAllowed("http://localhost:5173/img.png", [])).toBe(true);
    expect(isAllowed("http://127.0.0.1:5173/img.png", [])).toBe(true);
    process.env.NODE_ENV = original;
  });

  it("rejects localhost and 127.0.0.1 in production", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    expect(isAllowed("http://localhost:5173/img.png", [])).toBe(false);
    expect(isAllowed("http://127.0.0.1:5173/img.png", [])).toBe(false);
    process.env.NODE_ENV = original;
  });

  it("allows an external host only if explicitly whitelisted", () => {
    expect(isAllowed("https://cdn.example.com/img.png", ["cdn.example.com"])).toBe(true);
    expect(isAllowed("https://evil.com/img.png", ["cdn.example.com"])).toBe(false);
  });

  it("rejects an unparseable URL", () => {
    expect(isAllowed("not a url", [])).toBe(false);
  });
});

describe("extractFilename", () => {
  it("derives a .webp filename from a relative path", () => {
    expect(extractFilename("/uploads/photo.png")).toBe("photo.webp");
  });

  it("derives a .webp filename from a full URL", () => {
    expect(extractFilename("https://cdn.example.com/path/to/image.jpg")).toBe("image.webp");
  });

  it("falls back to image.webp when nothing usable is found", () => {
    expect(extractFilename("not a url")).toBe("image.webp");
  });
});
