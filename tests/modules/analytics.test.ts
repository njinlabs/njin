import { describe, expect, it } from "bun:test";
import { isSameOrigin } from "@njin/modules/analytics";

describe("isSameOrigin", () => {
  it("returns true when the referrer matches the request's origin", () => {
    expect(isSameOrigin("https://mysite.com/blog", "https://mysite.com/about")).toBe(true);
  });

  it("returns false when the referrer is a different origin", () => {
    expect(isSameOrigin("https://google.com/search", "https://mysite.com/about")).toBe(false);
  });

  it("returns false when the referrer is different only in scheme/port (different origin)", () => {
    expect(isSameOrigin("http://mysite.com/blog", "https://mysite.com/about")).toBe(false);
    expect(isSameOrigin("https://mysite.com:8080/blog", "https://mysite.com/about")).toBe(false);
  });

  it("returns false when there is no referrer", () => {
    expect(isSameOrigin(null, "https://mysite.com/about")).toBe(false);
  });

  it("returns false when the referrer is not a valid URL", () => {
    expect(isSameOrigin("not a url", "https://mysite.com/about")).toBe(false);
  });
});
