import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteClient } from "../../../src/core/adapters/sql/sqlite_client";

const open = () => {
  const connection = sqliteClient(":memory:");
  return connection;
};

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("sqliteClient", () => {
  it("runs parameterised statements", async () => {
    const { client } = open();
    await client.query('create table "t" ("a" text, "b" real)', []);
    await client.query('insert into "t" values ($1, $2)', ["x", 1.5]);
    expect(
      await client.query('select * from "t" where "a" = $1', ["x"]),
    ).toEqual([{ a: "x", b: 1.5 }]);
  });

  it("refuses more than one statement", async () => {
    const { client } = open();
    await expect(client.query("select 1; select 2", [])).rejects.toThrow(
      /more than one command/,
    );
  });

  it("commits a transaction and rolls one back", async () => {
    const { client } = open();
    await client.query('create table "t" ("a" text)', []);

    await client.transaction(async (tx) => {
      await tx.query('insert into "t" values ($1)', ["kept"]);
    });
    await expect(
      client.transaction(async (tx) => {
        await tx.query('insert into "t" values ($1)', ["lost"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await client.query('select "a" from "t"', [])).toEqual([
      { a: "kept" },
    ]);
  });

  it("rolls back a nested transaction on its own", async () => {
    const { client } = open();
    await client.query('create table "t" ("a" text primary key)', []);

    await client.transaction(async (tx) => {
      await tx.query('insert into "t" values ($1)', ["a"]);
      await tx
        .transaction(async (inner) => {
          await inner.query('insert into "t" values ($1)', ["b"]);
          await inner.query('insert into "t" values ($1)', ["a"]);
        })
        .catch(() => {});
      await tx.query('insert into "t" values ($1)', ["c"]);
    });

    expect(await client.query('select "a" from "t" order by "a"', [])).toEqual([
      { a: "a" },
      { a: "c" },
    ]);
  });

  it("makes other work wait for a transaction instead of joining it", async () => {
    const { client } = open();
    await client.query('create table "t" ("a" text)', []);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tx = client.transaction(async (inner) => {
      await inner.query('insert into "t" values ($1)', ["inside"]);
      await gate;
      throw new Error("rolled back");
    });
    // Queued behind the transaction: it must not see (or be swept into) its rows.
    const outside = client.query('select count(*) as "n" from "t"', []);
    release();

    await expect(tx).rejects.toThrow("rolled back");
    expect(await outside).toEqual([{ n: 0 }]);
  });

  it("keeps its data in a file between connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "njin-sqlite-"));
    dirs.push(dir);
    const path = join(dir, "app.db");

    const first = sqliteClient(path);
    await first.client.query('create table "t" ("a" text)', []);
    await first.client.query('insert into "t" values ($1)', ["persisted"]);
    first.close();

    const second = sqliteClient(path);
    expect(await second.client.query('select "a" from "t"', [])).toEqual([
      { a: "persisted" },
    ]);
    second.close();
  });
});
