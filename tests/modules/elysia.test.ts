import { describe, expect, it } from "bun:test";
import { injectBracketQuery } from "../../src/modules/elysia";

describe("injectBracketQuery", () => {
  it("parses a simple bracket key into a nested object", () => {
    const query: Record<string, unknown> = {};
    injectBracketQuery({ query, request: new Request("http://x/api/playground?filters[slug]=tests") });
    expect(query.filters).toEqual({ slug: "tests" });
  });

  it("parses a nested operator key", () => {
    const query: Record<string, unknown> = {};
    injectBracketQuery({ query, request: new Request("http://x/api/playground?filters[price][$gte]=100") });
    expect(query.filters).toEqual({ price: { $gte: "100" } });
  });

  it("merges multiple keys under the same root", () => {
    const query: Record<string, unknown> = {};
    injectBracketQuery({
      query,
      request: new Request("http://x/api/playground?filters[slug]=tests&filters[price][$gte]=100"),
    });
    expect(query.filters).toEqual({ slug: "tests", price: { $gte: "100" } });
  });

  it("supports multiple distinct root fields", () => {
    const query: Record<string, unknown> = {};
    injectBracketQuery({ query, request: new Request("http://x/api/x?filters[a]=1&other[b]=2") });
    expect(query.filters).toEqual({ a: "1" });
    expect(query.other).toEqual({ b: "2" });
  });

  it("ignores keys without bracket notation", () => {
    const query: Record<string, unknown> = { page: "1" };
    injectBracketQuery({ query, request: new Request("http://x/api/x?page=1&limit=10") });
    expect(query).toEqual({ page: "1" });
  });

  it("does nothing when there are no bracket-notation keys", () => {
    const query: Record<string, unknown> = {};
    injectBracketQuery({ query, request: new Request("http://x/api/x") });
    expect(query).toEqual({});
  });
});
