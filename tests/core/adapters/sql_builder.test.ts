import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertSingleStatement,
  sql,
} from "../../../src/core/adapters/sql/builder";

// The composer is what stands between user input and SQL text, so its guarantees are pinned
// down here: a value is always a parameter, and text only gets in through identifier/int/keyword.

const PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE post; --",
  '"; DROP TABLE post; --',
  "$1",
  "\\' OR 1=1 --",
  "$$ ; delete from post; $$",
];

describe("sql``", () => {
  it("turns every interpolated value into a numbered parameter, never into text", () => {
    for (const payload of PAYLOADS) {
      const { text, params } =
        sql`select * from t where a = ${payload} and b = ${42}`.render();

      expect(text).toBe("select * from t where a = $1 and b = $2");
      expect(params).toEqual([payload, 42]);
    }
  });

  it("numbers parameters across nested fragments, in order of appearance", () => {
    const inner = sql`b = ${"B"} and c = ${"C"}`;
    const { text, params } =
      sql`select ${"A"} where ${inner} and d = ${"D"}`.render();

    expect(text).toBe("select $1 where b = $2 and c = $3 and d = $4");
    expect(params).toEqual(["A", "B", "C", "D"]);
  });

  it("binds the same value twice as two parameters", () => {
    const { text, params } = sql`${"x"} ${"x"}`.render();
    expect(text).toBe("$1 $2");
    expect(params).toEqual(["x", "x"]);
  });

  it("treats undefined as null, and an array as one parameter, not as syntax", () => {
    expect(sql`${undefined}`.render().params).toEqual([null]);
    expect(sql`${["a", "b"]}`.render()).toEqual({
      text: "$1",
      params: [["a", "b"]],
    });
  });

  it("joins fragments with a separator", () => {
    const list = sql.join([sql`${1}`, sql`${2}`, sql`${3}`], sql`, `);
    expect(sql`in (${list})`.render()).toEqual({
      text: "in ($1, $2, $3)",
      params: [1, 2, 3],
    });
  });
});

describe("sql.identifier", () => {
  it("quotes a name, doubling any quote inside it so it can't close early", () => {
    expect(sql.identifier("post").render().text).toBe('"post"');
    for (const payload of PAYLOADS) {
      const { text, params } =
        sql`select 1 from ${sql.identifier(payload)}`.render();
      expect(params).toEqual([]);
      // Everything after the opening quote up to the final one is the name; its own quotes are doubled.
      const inner = text.slice('select 1 from "'.length, -1);
      expect(inner).toBe(payload.replaceAll('"', '""'));
      expect(inner.replaceAll('""', "")).not.toContain('"');
    }
  });

  it("refuses an empty name and one with a NUL byte", () => {
    expect(() => sql.identifier("")).toThrow(/Invalid identifier/);
    expect(() => sql.identifier("a\0b")).toThrow(/Invalid identifier/);
  });
});

describe("sql.int", () => {
  it("accepts a non-negative safe integer", () => {
    expect(sql.int(0).render().text).toBe("0");
    expect(sql.int(20).render().text).toBe("20");
  });

  it("refuses everything else instead of coercing it", () => {
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 60,
    ]) {
      expect(() => sql.int(bad)).toThrow(/non-negative integer/);
    }
    for (const bad of ["1; DROP TABLE post", "20", null, undefined, {}]) {
      expect(() => sql.int(bad as never)).toThrow(/non-negative integer/);
    }
  });
});

describe("sql.keyword", () => {
  const allowed = new Set(["text", "jsonb"]);

  it("passes a word from the allow-list and nothing else", () => {
    expect(sql.keyword("text", allowed).render().text).toBe("text");
    expect(() => sql.keyword("text; drop table post", allowed)).toThrow(
      /allowed keyword/,
    );
    expect(() => sql.keyword("TEXT", allowed)).toThrow(/allowed keyword/);
  });
});

describe("no way around it", () => {
  it("has no raw-text escape hatch", () => {
    expect(Object.keys(sql).sort()).toEqual(
      ["empty", "identifier", "int", "join", "keyword"].sort(),
    );
    expect("raw" in sql).toBe(false);
  });

  // A source-level guard: the only file allowed to hand text to a driver is the Bun client
  // wrapper, and nothing in the adapters may build SQL by string concatenation or reach for a
  // removed dependency.
  it("keeps raw driver calls and string-built SQL out of the adapters", () => {
    const root = join(import.meta.dir, "../../../src/core/adapters");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const rel = file.slice(root.length + 1).replaceAll("\\", "/");

      if (/\.unsafe\(/.test(source) && rel !== "sql/bun_client.ts") {
        offenders.push(
          `${rel}: calls .unsafe() outside the Bun client wrapper`,
        );
      }
      if (/sql\.raw\b/.test(source)) offenders.push(`${rel}: uses sql.raw`);
      if (/drizzle/i.test(source.replace(/\/\/.*$/gm, ""))) {
        offenders.push(`${rel}: references drizzle`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("assertSingleStatement", () => {
  it("accepts the statements njin sends, including quoted names holding ; -- and $", () => {
    for (const text of [
      "select 1",
      'select "a;b" from "t--x" where id = $1 and n = $2;',
      `alter table "t" alter column "data" set default '{}'::jsonb`,
      `select 'it''s; fine' as v`,
      `create table if not exists "we""ird; name" ("id" text primary key)`,
      "select count(*)::int as n from t where x = $10  ;  ",
    ]) {
      expect(() => assertSingleStatement(text)).not.toThrow();
    }
  });

  it("refuses a second command, a comment, dollar-quoting or an open quote", () => {
    for (const text of [
      "select 1; select 2",
      "select 1;delete from t",
      "select 1 -- the rest",
      "select 1 /* hidden */",
      "select $$x; drop table t$$",
      "select $tag$x$tag$",
      "select 'unterminated",
      'select "unterminated',
    ]) {
      expect(() => assertSingleStatement(text)).toThrow(/Refusing to run SQL/);
    }
  });

  it("lets every statement the builder can produce through, whatever the identifier", () => {
    for (const payload of PAYLOADS) {
      const { text } =
        sql`select 1 from ${sql.identifier(payload)} where a = ${payload}`.render();
      expect(() => assertSingleStatement(text)).not.toThrow();
    }
  });
});
