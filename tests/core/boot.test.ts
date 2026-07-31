import { describe, expect, it, mock } from "bun:test";

const calls: string[] = [];

const fakeModules = [
  { spin: async () => { calls.push("a"); } },
  {},
  { spin: () => { calls.push("b"); } },
];

mock.module("../../src/config/module", () => ({
  default: fakeModules,
}));

const { boot } = await import("../../src/core/boot");

describe("boot", () => {
  it("calls spin() on every module that defines one, in array order, skipping the rest", async () => {
    await boot();

    expect(calls).toEqual(["a", "b"]);
  });
});
