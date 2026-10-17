import { afterAll, describe, expect, it, mock } from "bun:test";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realConfig from "../../src/core/config";
import * as realLoggerModule from "../../src/modules/logger";

const dir = mkdtempSync(join(tmpdir(), "njin-static-cache-"));

let edgeCache: { ban: string[]; headers: Record<string, string> } | undefined;

mock.module("../../src/core/config", () => ({
  ...realConfig,
  getConfig: () => ({ rootDir: dir, edgeCache }),
}));
mock.module("../../src/modules/logger", () => ({
  ...realLoggerModule,
  default: () => ({ error: () => {} }),
}));

const { cacheKey, getOrRenderStatic, readStatic, purgeStatic } =
  await import("../../src/core/static_cache");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const file = (...segs: string[]) =>
  join(dir, ".cache", "static", ...segs, "index.html");

describe("cacheKey", () => {
  it.each([
    ["/", "/"],
    ["/about", "/about"],
    ["/about/", "/about"],
    ["/blog/hello%20world", "/blog/hello world"],
    ["/blog/%C3%A9", "/blog/é"],
  ])("%p -> %p", (path, key) => {
    expect(cacheKey(path)).toBe(key);
  });

  it.each([
    "about",
    "//",
    "/a//b",
    "/a/./b",
    "/a/../b",
    "/a/%2e%2e/b",
    "/a/b%2Fc",
    "/a/b%5Cc",
    "/a/b%00",
    "/a/%E0%A4%A",
    `/${"x".repeat(600)}`,
  ])("refuses %p", (path) => {
    expect(cacheKey(path)).toBeNull();
  });
});

describe("cache files", () => {
  it("escapes everything but [a-z0-9_~-], so keys can't collide or escape the dir", async () => {
    const keys = ["/Blog/A", "/blog/a", "/v1.2", "/a b", "/é"];
    for (const key of keys) await getOrRenderStatic(key, async () => key);

    expect(existsSync(file("%42log", "%41"))).toBe(true);
    expect(existsSync(file("blog", "a"))).toBe(true);
    expect(existsSync(file("v1%2e2"))).toBe(true);
    expect(existsSync(file("a%20b"))).toBe(true);
    expect(existsSync(file("%c3%a9"))).toBe(true);
    for (const key of keys) expect(await readStatic(key)).toBe(key);
  });

  it("leaves no temp files behind", async () => {
    const glob = new Bun.Glob("**/*.tmp");
    const leftovers = [...glob.scanSync({ cwd: dir, dot: true })];
    expect(leftovers).toEqual([]);
  });
});

describe("purgeStatic", () => {
  it("exact path leaves siblings and children alone", async () => {
    await getOrRenderStatic("/p", async () => "p");
    await getOrRenderStatic("/p/child", async () => "child");
    await purgeStatic("/p", { warm: false });
    expect(await readStatic("/p")).toBeNull();
    expect(await readStatic("/p/child")).toBe("child");
  });

  it("'/x/*' drops the path and everything under it, but not look-alikes", async () => {
    await getOrRenderStatic("/x", async () => "x");
    await getOrRenderStatic("/x/y/z", async () => "z");
    await getOrRenderStatic("/xy", async () => "xy");
    await purgeStatic("/x/*", { warm: false });
    expect(await readStatic("/x")).toBeNull();
    expect(await readStatic("/x/y/z")).toBeNull();
    expect(await readStatic("/xy")).toBe("xy");
  });

  it("is a no-op for something that was never cached", async () => {
    await purgeStatic("/never", { warm: false });
    await purgeStatic("/never/*", { warm: false });
  });

  it("'/*' and no argument drop everything", async () => {
    await getOrRenderStatic("/k", async () => "k");
    await purgeStatic("/*", { warm: false });
    expect(await readStatic("/k")).toBeNull();
    await getOrRenderStatic("/k", async () => "k");
    await purgeStatic(undefined, { warm: false });
    expect(await readStatic("/k")).toBeNull();
  });

  it.each(["x", "/a/../b", "/a//b"])("rejects %p", async (path) => {
    await expect(purgeStatic(path)).rejects.toThrow(/Invalid purge path/);
    await expect(purgeStatic(`${path}/*`)).rejects.toThrow(
      /Invalid purge path/,
    );
  });
});

describe("getOrRenderStatic", () => {
  it("does not cache a failing render and lets the next call retry", async () => {
    await expect(
      getOrRenderStatic("/boom", async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
    expect(await readStatic("/boom")).toBeNull();
    expect((await getOrRenderStatic("/boom", async () => "ok")).state).toBe(
      "MISS",
    );
  });

  it("reports MISS, then HIT", async () => {
    expect(await getOrRenderStatic("/s", async () => "s")).toEqual({
      html: "s",
      state: "MISS",
    });
    expect(await getOrRenderStatic("/s", async () => "other")).toEqual({
      html: "s",
      state: "HIT",
    });
  });
});

describe("purgeStatic edge cache", () => {
  it("sends a BAN per purge and survives an unreachable cache", async () => {
    const seen: { method: string; path: string; ban: string | null }[] = [];
    // Raw TCP: Bun's own HTTP servers reject the BAN method.
    const server = createServer((socket) => {
      socket.once("data", (chunk) => {
        const text = chunk.toString();
        const [method = "", path = ""] = text.split(" ");
        seen.push({
          method,
          path,
          ban: /^x-ban-url: ([^\s]+)/im.exec(text)?.[1] ?? null,
        });
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    edgeCache = {
      ban: [`http://127.0.0.1:${port}`, "http://127.0.0.1:1"],
      headers: {},
    };
    try {
      await purgeStatic("/blog/hello", { warm: false });
      await purgeStatic("/blog/*", { warm: false });
      await purgeStatic(undefined, { warm: false });
    } finally {
      edgeCache = undefined;
      server.close();
    }

    expect(seen.map((s) => s.method)).toEqual(["BAN", "BAN", "BAN"]);
    expect(seen[0]).toMatchObject({
      path: "/blog/hello",
      ban: String.raw`(?i)^/blog/hello/?(\?.*)?$`,
    });
    expect(seen[1]?.ban).toBe("(?i)^/blog([/?].*)?$");
    expect(seen[2]?.ban).toBe("^/");
  });
});
