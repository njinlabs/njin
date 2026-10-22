import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp } from "../../src/core/testing";

const app = await createTestApp({
  models: [() => import("../fixtures/testing_post")],
});
const { default: post } = await import("../fixtures/testing_post");

afterAll(() => app.close());

describe("createTestApp", () => {
  it("serves the app without opening a known port", async () => {
    const res = await app.get("/api/auth/check-token");
    expect(res.status).toBe(401);
  });

  it("authenticates a request as a created user", async () => {
    const user = await app.createUser({ name: "Ada" });
    const res = await app.get("/api/auth/check-token", { as: user });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { name: string } }).data.name).toBe(
      "Ada",
    );
  });

  it("seeds through the model and reads it back over HTTP", async () => {
    const user = await app.createUser();
    await app.seed(post, { title: "Hello" });

    const res = await app.get("/api/post", { as: user });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("Hello");
  });

  it("sends JSON bodies and reports validation errors", async () => {
    const user = await app.createUser();

    const created = await app.post("/api/post", {
      as: user,
      body: { title: "Via HTTP" },
    });
    expect(created.status).toBe(200);

    const invalid = await app.post("/api/post", { as: user, body: {} });
    expect(invalid.status).toBe(422);
  });

  it("reset() empties every table", async () => {
    await app.reset();

    const user = await app.createUser();
    const res = await app.get("/api/post", { as: user });
    expect(JSON.stringify(await res.json())).not.toContain("Hello");
  });

  it("refuses a second app in the same process", async () => {
    await expect(createTestApp()).rejects.toThrow("--isolate");
  });
});
