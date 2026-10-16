import { describe, expect, it, mock } from "bun:test";
import * as realSurrealdb from "surrealdb";
import type { TableDef } from "../../../src/core/db/contract";

let createRemoteEnginesCalls = 0;
let createNodeEnginesCalls = 0;
const instances: FakeSurreal[] = [];

class FakeSurreal {
  connectArgs: unknown[] = [];
  useArgs: unknown[] = [];
  queries: string[] = [];
  params: (Record<string, unknown> | undefined)[] = [];
  // Set by a test before sync() to simulate a DB that was already migrated to this exact
  // schema in a previous boot — the recorded hash sync() reads back.
  recordedSchemaHash: string | null = null;
  closed = false;
  constructor(public opts: { engines: unknown }) {
    instances.push(this);
  }
  async connect(...args: unknown[]) {
    this.connectArgs = args;
  }
  async use(...args: unknown[]) {
    this.useArgs = args;
  }
  async query(sql: string, params?: Record<string, unknown>) {
    this.queries.push(sql);
    this.params.push(params);
    if (sql.startsWith("SELECT hash FROM njin_schema_meta")) {
      return [
        this.recordedSchemaHash ? [{ hash: this.recordedSchemaHash }] : [],
      ];
    }
    return [];
  }
  async close() {
    this.closed = true;
  }
}

mock.module("surrealdb", () => ({
  ...realSurrealdb,
  Surreal: FakeSurreal,
  createRemoteEngines: () => {
    createRemoteEnginesCalls++;
    return { remote: true };
  },
}));

mock.module("@surrealdb/node", () => ({
  createNodeEngines: () => {
    createNodeEnginesCalls++;
    return { embedded: true };
  },
}));

const { isRemotePath, surrealAdapter } = await import(
  "../../../src/core/adapters/surreal"
);

const table = (name: string, search: TableDef["search"] = []): TableDef => ({
  name,
  fields: [],
  search,
});

const remote = {
  path: "ws://localhost:8000",
  namespace: "ns",
  database: "db",
};

// Connects a fresh adapter and returns it with the FakeSurreal behind it.
const boot = async (config: Parameters<typeof surrealAdapter>[0] = remote) => {
  const adapter = surrealAdapter(config);
  await adapter.connect();
  return { adapter, instance: instances[instances.length - 1]! };
};

describe("isRemotePath", () => {
  it("recognizes remote schemes", () => {
    expect(isRemotePath("ws://localhost:8000")).toBe(true);
    expect(isRemotePath("wss://example.com")).toBe(true);
    expect(isRemotePath("http://example.com")).toBe(true);
    expect(isRemotePath("https://example.com")).toBe(true);
  });

  it("rejects embedded schemes", () => {
    expect(isRemotePath("rocksdb://data")).toBe(false);
    expect(isRemotePath("mem://")).toBe(false);
    expect(isRemotePath("surrealkv://data")).toBe(false);
  });
});

describe("surrealAdapter — remote path", () => {
  it("connects with createRemoteEngines, selects the namespace/database, and defines every table on sync()", async () => {
    const auth = { username: "root", password: "root" };
    const { adapter, instance } = await boot({ ...remote, auth });

    expect(createRemoteEnginesCalls).toBe(1);
    expect(instance.connectArgs).toEqual([
      "ws://localhost:8000",
      { authentication: auth },
    ]);
    // FakeSurreal.use() overwrites useArgs each call, so this only reflects the final
    // (namespace + database) call — the namespace-only call in between isn't visible here.
    expect(instance.useArgs).toEqual([{ namespace: "ns", database: "db" }]);

    // Namespace/database are explicitly DEFINE'd during connect() — not deferred to sync().
    expect(instance.queries).toEqual([
      "DEFINE NAMESPACE IF NOT EXISTS `ns`;",
      "DEFINE DATABASE IF NOT EXISTS `db`;",
    ]);

    await adapter.sync([
      table("user"),
      table("file"),
      table("vars"),
      table("post"),
    ]);

    const defined = instance.queries.join("\n");
    for (const name of ["user", "file", "vars", "post"]) {
      expect(defined).toContain(
        `DEFINE TABLE IF NOT EXISTS ${name} SCHEMALESS;`,
      );
    }
  });

  it("defines a search analyzer and a FULLTEXT index per search target", async () => {
    const { adapter, instance } = await boot();

    await adapter.sync([
      table("post", [
        { table: "post", field: "title" },
        { table: "post", field: "body" },
      ]),
    ]);

    const defined = instance.queries.join("\n");

    // TOKENIZERS blank (not class) — a "class" tokenizer splits on punctuation too, so
    // "Next.js" would tokenize into "next" / "." / "js" and a query for "next.js" (split
    // the same way) would never match. FULLTEXT (not SEARCH) — this SurrealDB version
    // renamed the DEFINE INDEX keyword; SEARCH ANALYZER is a parse error here.
    expect(defined).toContain(
      "DEFINE ANALYZER OVERWRITE njin_search TOKENIZERS blank FILTERS lowercase,ngram(3,10);",
    );
    expect(defined).toContain(
      "DEFINE INDEX OVERWRITE idx_search_post_title ON TABLE post FIELDS title FULLTEXT ANALYZER njin_search BM25 HIGHLIGHTS;",
    );
    expect(defined).toContain(
      "DEFINE INDEX OVERWRITE idx_search_post_body ON TABLE post FIELDS body FULLTEXT ANALYZER njin_search BM25 HIGHLIGHTS;",
    );
  });

  it("indexes a via-target on the linked table's field, not on the local relation field", async () => {
    const { adapter, instance } = await boot();

    await adapter.sync([
      table("user"),
      table("post", [{ table: "user", field: "name", via: "author" }]),
    ]);

    const defined = instance.queries.join("\n");

    expect(defined).toContain(
      "DEFINE INDEX OVERWRITE idx_search_user_name ON TABLE user FIELDS name FULLTEXT ANALYZER njin_search BM25 HIGHLIGHTS;",
    );
    expect(defined).not.toContain("idx_search_post_author");
  });

  it("dedupes a via-target's index against the target table's own flat target for the same field", async () => {
    const { adapter, instance } = await boot();

    await adapter.sync([
      table("user", [{ table: "user", field: "name" }]),
      table("post", [{ table: "user", field: "name", via: "author" }]),
    ]);

    const occurrences = instance.queries.filter((q) =>
      q.includes("idx_search_user_name"),
    ).length;

    expect(occurrences).toBe(1);
  });

  it("skips every DEFINE when the recorded schema hash matches, and re-runs them when it changes", async () => {
    // First boot: no recorded hash yet, so every DEFINE runs and the resulting hash gets
    // written back via UPSERT.
    const first = await boot();
    await first.adapter.sync([table("post")]);
    const upsertAt = first.instance.queries.findIndex((q) =>
      q.startsWith("UPSERT njin_schema_meta:current"),
    );
    expect(upsertAt).toBeGreaterThan(-1);
    const writtenHash = first.instance.params[upsertAt]?.hash as string;
    expect(writtenHash).toBeString();

    // Second boot against a DB that already recorded that exact hash (same tables) — the
    // warm-boot path (idle-evict/crash respawn hitting the same, already-migrated DB).
    const second = await boot();
    second.instance.recordedSchemaHash = writtenHash;
    await second.adapter.sync([table("post")]);

    expect(second.instance.queries).toEqual([
      "DEFINE NAMESPACE IF NOT EXISTS `ns`;",
      "DEFINE DATABASE IF NOT EXISTS `db`;",
      "DEFINE TABLE IF NOT EXISTS njin_schema_meta SCHEMALESS;",
      "SELECT hash FROM njin_schema_meta:current;",
    ]);

    // Third boot: schema changed (a new table), so the recorded hash from the first boot no
    // longer matches and every DEFINE must run again.
    const third = await boot();
    third.instance.recordedSchemaHash = writtenHash;
    await third.adapter.sync([table("post"), table("comment")]);

    expect(third.instance.queries.join("\n")).toContain(
      "DEFINE TABLE IF NOT EXISTS comment SCHEMALESS;",
    );
  });

  it("rejects a table name that isn't a plain identifier", async () => {
    const { adapter } = await boot();

    await expect(
      adapter.sync([table("post; REMOVE TABLE user")]),
    ).rejects.toThrow(/Unsafe identifier/);
  });

  it("closes the underlying connection", async () => {
    const { adapter, instance } = await boot();
    await adapter.close();
    expect(instance.closed).toBe(true);
  });
});

describe("surrealAdapter — embedded path", () => {
  it("connects with createNodeEngines for a rocksdb:// path", async () => {
    createNodeEnginesCalls = 0;

    await boot({ ...remote, path: "rocksdb://data" });

    expect(createNodeEnginesCalls).toBe(1);
  });
});

describe("surrealAdapter — unrecognized path scheme", () => {
  it("throws a descriptive error", async () => {
    await expect(boot({ ...remote, path: "postgres://data" })).rejects.toThrow(
      /Unrecognized db\.path scheme/,
    );
  });
});
