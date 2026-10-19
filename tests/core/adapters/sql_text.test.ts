import { describe, expect, it } from "bun:test";
import { toPositional } from "../../../src/core/adapters/sql/text";

describe("toPositional", () => {
  it("numbered placeholders become plain ones, in order", () => {
    expect(toPositional('select * from "t" where a = $1 and b = $2')).toBe(
      'select * from "t" where a = ? and b = ?',
    );
    expect(toPositional("values ($10, $2)")).toBe("values (?, ?)");
  });

  it("writes identifiers with backticks for MySQL and doubles embedded ones", () => {
    expect(
      toPositional('select "a"."b" as "c" from "t"', { backticks: true }),
    ).toBe("select `a`.`b` as `c` from `t`");
    expect(toPositional('select "we`ird" from "t"', { backticks: true })).toBe(
      "select `we``ird` from `t`",
    );
  });

  it("keeps a doubled quote inside an identifier", () => {
    expect(toPositional('select "a""b"')).toBe('select "a""b"');
    expect(toPositional('select "a""b"', { backticks: true })).toBe(
      'select `a"b`',
    );
  });

  it("leaves string literals alone, whatever is inside them", () => {
    expect(
      toPositional(`select 'it''s "$1"' as "x" where y like '%!_' escape '!'`, {
        backticks: true,
      }),
    ).toBe(`select 'it''s "$1"' as \`x\` where y like '%!_' escape '!'`);
  });

  it("refuses text it cannot read safely", () => {
    expect(() => toPositional("select 'open")).toThrow();
    expect(() => toPositional('select "open')).toThrow();
    // MySQL reads a backslash in a literal as an escape.
    expect(() => toPositional("select 'a'b'", { backticks: true })).toThrow();
  });
});
