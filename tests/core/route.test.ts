import { describe, expect, it } from "bun:test";
import { route } from "../../src/core/route";

describe("route", () => {
  it("returns a plain Elysia instance that can be chained and handled directly", async () => {
    const app = route().get("/ping", () => "pong");

    const res = await app.handle(new Request("http://localhost/ping"));

    expect(await res.text()).toBe("pong");
  });

  it("passes constructor config through to Elysia (e.g. prefix)", async () => {
    const app = route({ prefix: "/custom" }).get("/ping", () => "pong");

    const prefixed = await app.handle(new Request("http://localhost/custom/ping"));
    const unprefixed = await app.handle(new Request("http://localhost/ping"));

    expect(await prefixed.text()).toBe("pong");
    expect(unprefixed.status).toBe(404);
  });
});
