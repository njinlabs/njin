import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteAdapter } from "../../../src/core/adapters/sqlite";
import {
  LinkTargetMissingError,
  type TableDef,
} from "../../../src/core/db/contract";
import { describeAdapter } from "./contract_suite";

// The shared contract suite against SQLite, in memory: real SQLite semantics without a server.
describeAdapter("sqlite", () => sqliteAdapter({ path: ":memory:" }));

// SQLite takes a link constraint only when a table is created, so what matters is that the
// first migration declares them and that enforcement is switched on for the connection.
describe("sqlite foreign keys", () => {
  const brand: TableDef = {
    name: "brand",
    fields: [{ kind: "scalar", name: "name", type: "string" }],
    search: [],
  };
  const shoe: TableDef = {
    name: "shoe",
    fields: [
      { kind: "one", name: "brand", target: "brand" },
      { kind: "many", name: "tags", target: "brand" },
    ],
    search: [],
  };

  it("declares the links when the tables are created and enforces them", async () => {
    const path = join(tmpdir(), `njin-fk-${crypto.randomUUID()}.db`);
    const adapter = sqliteAdapter({ path });
    await adapter.connect();
    try {
      // The target is listed after the table that links to it: SQLite allows that on create.
      await adapter.sync([shoe, brand]);

      const raw = new Database(path);
      const keys = (table: string) =>
        raw
          .query(
            `select "from", "table", on_delete from pragma_foreign_key_list('${table}')`,
          )
          .all() as { from: string; table: string; on_delete: string }[];
      expect(keys("shoe")).toEqual([
        { from: "brand", table: "brand", on_delete: "SET NULL" },
      ]);
      expect(
        keys("shoe__tags")
          .map((k) => [k.from, k.on_delete])
          .sort(),
      ).toEqual([
        ["_owner", "CASCADE"],
        ["target", "CASCADE"],
      ]);
      raw.close();

      await expect(
        adapter.insert(shoe, { brand: "nobody" }),
      ).rejects.toBeInstanceOf(LinkTargetMissingError);
    } finally {
      await adapter.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});
