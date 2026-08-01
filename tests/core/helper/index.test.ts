import { describe, expect, it } from "bun:test";
import { defineHelper } from "../../../src/core/helper";

describe("defineHelper", () => {
  it("returns a { name, fn } pair, preserving the fn's identity", () => {
    const fn = (a: number, b: number) => a + b;

    const helper = defineHelper("add", fn);

    expect(helper.name).toBe("add");
    expect(helper.fn).toBe(fn);
    expect(helper.fn(2, 3)).toBe(5);
  });
});
