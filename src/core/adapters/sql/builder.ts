// A minimal SQL composer shared by the SQL adapters, and the one interface they need from a
// driver.
//
// Its safety comes from what it deliberately leaves out. A template interpolation is ALWAYS a
// bound parameter (or another composed fragment) and never text, and there is no "raw" escape
// hatch: the only ways to put text into a statement are
//   - the literal parts of the template itself (written in our source),
//   - sql.identifier(): a name, quoted,
//   - sql.int(): a validated non-negative integer,
//   - sql.keyword(): a word from a fixed allow-list.
// So a value that reaches the database from a user can only ever travel as a parameter.

class Param {
  constructor(readonly value: unknown) {}
}

export class Sql {
  private constructor(private readonly chunks: readonly (string | Param)[]) {}

  static of(chunks: readonly (string | Param)[]) {
    return new Sql(chunks);
  }

  // The statement text with $1, $2, ... placeholders, and the values for them in order.
  render(placeholder: (index: number) => string = (i) => `$${i}`) {
    let text = "";
    const params: unknown[] = [];

    for (const chunk of this.chunks) {
      if (typeof chunk === "string") {
        text += chunk;
      } else {
        params.push(chunk.value);
        text += placeholder(params.length);
      }
    }

    return { text, params };
  }

  get parts() {
    return this.chunks;
  }
}

export type { Sql as SQL };

const quote = (name: string) => {
  if (name.length === 0 || name.includes("\0")) {
    throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  }
  return `"${name.replaceAll('"', '""')}"`;
};

export const sql = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]): Sql => {
    const chunks: (string | Param)[] = [];

    strings.forEach((text, i) => {
      chunks.push(text);
      if (i >= values.length) return;

      const value = values[i];
      if (value instanceof Sql) chunks.push(...value.parts);
      else chunks.push(new Param(value === undefined ? null : value));
    });

    return Sql.of(chunks);
  },
  {
    // A table, schema or column name, quoted. Safe for any string.
    identifier: (name: string) => Sql.of([quote(name)]),

    // A non-negative integer written into the statement (LIMIT, OFFSET, a prefix length), where
    // a parameter isn't accepted. Anything else is refused rather than coerced.
    int: (value: number) => {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          `Expected a non-negative integer, got ${String(value)}`,
        );
      }
      return Sql.of([String(value)]);
    },

    // One of a fixed set of words (column types). Anything outside the set is refused.
    keyword: (word: string, allowed: ReadonlySet<string>) => {
      if (!allowed.has(word))
        throw new Error(`Not an allowed keyword: ${word}`);
      return Sql.of([word]);
    },

    join: (items: readonly Sql[], separator: Sql): Sql => {
      const chunks: (string | Param)[] = [];
      items.forEach((item, i) => {
        if (i > 0) chunks.push(...separator.parts);
        chunks.push(...item.parts);
      });
      return Sql.of(chunks);
    },

    empty: Sql.of([]),
  },
);

// The one thing an SQL adapter needs from a driver. `query` runs a single statement with
// positional parameters; `transaction` runs a function atomically and, called from inside one,
// opens a savepoint instead.
export type SqlClient = {
  query(text: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
};

// Defence in depth for drivers that accept several commands in one call when no parameters are
// given (Bun's does). Every statement njin sends is one command, so anything else is refused:
// outside quoted names and string literals there may be no ';' (except a final one), no
// comments and no dollar-quoting — none of which njin's own statements use.
export const assertSingleStatement = (text: string) => {
  const fail = (why: string): never => {
    throw new Error(`Refusing to run SQL that ${why}`);
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;

    if (char === '"' || char === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) fail("has an unterminated quote");
        if (text[j] === char) {
          if (text[j + 1] === char)
            j += 2; // a doubled quote is a literal quote
          else break;
        } else j += 1;
      }
      i = j + 1;
      continue;
    }

    if (char === ";") {
      if (text.slice(i + 1).trim() !== "")
        fail("contains more than one command");
      return;
    }
    if (char === "-" && text[i + 1] === "-") fail("contains a comment");
    if (char === "/" && text[i + 1] === "*") fail("contains a comment");
    if (char === "$" && !/[0-9]/.test(text[i + 1] ?? "")) {
      fail("uses dollar-quoting");
    }

    i += 1;
  }
};

export const run = (client: SqlClient, query: Sql) => {
  const { text, params } = query.render();
  return client.query(text, params);
};
