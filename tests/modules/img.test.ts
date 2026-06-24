import { describe, expect, it } from "bun:test";
import { extractFilename, isAllowed } from "../../src/modules/img";

describe("isAllowed", () => {
  it("always allows relative paths", () => {
    expect(isAllowed("/api/file/abc.png", "mysite.com", [])).toBe(true);
  });

  it("allows the same host as the incoming request", () => {
    expect(isAllowed("https://mysite.com/img.png", "mysite.com", [])).toBe(true);
  });

  it("ignores the port on the request host when comparing", () => {
    expect(isAllowed("http://localhost/img.png", "localhost:3000", [])).toBe(true);
  });

  it("always allows localhost and 127.0.0.1", () => {
    expect(isAllowed("http://localhost:5173/img.png", "mysite.com", [])).toBe(true);
    expect(isAllowed("http://127.0.0.1:5173/img.png", "mysite.com", [])).toBe(true);
  });

  it("allows an external host only if explicitly whitelisted", () => {
    expect(isAllowed("https://cdn.example.com/img.png", "mysite.com", ["cdn.example.com"])).toBe(true);
    expect(isAllowed("https://evil.com/img.png", "mysite.com", ["cdn.example.com"])).toBe(false);
  });

  it("rejects an unparseable URL", () => {
    expect(isAllowed("not a url", "mysite.com", [])).toBe(false);
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
