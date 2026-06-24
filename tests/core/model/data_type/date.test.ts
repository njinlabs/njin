import { describe, expect, it } from "bun:test";
import moment from "moment";
import { date } from "../../../../src/core/model/data_type/date";

describe("date", () => {
  it("normalizes a date string to full ISO", () => {
    const input = "2026-06-01T00:00:00.000Z";
    expect(date({ label: "Published At" }).parse(input)).toBe(moment(input).toISOString());
  });

  it("accepts a moment instance", () => {
    const m = moment("2026-06-01T00:00:00.000Z");
    expect(date({ label: "Published At" }).parse(m)).toBe(m.toISOString());
  });

  it("rejects missing value by default (required)", () => {
    expect(date({ label: "Published At" }).safeParse(undefined).success).toBe(false);
  });

  it("rejects non-date input (number) since preprocess returns undefined", () => {
    expect(date({ label: "Published At" }).safeParse(12345).success).toBe(false);
  });

  it("allows opting out of required via rule", () => {
    expect(date({ label: "Expires At" }, (z) => z.optional()).parse(undefined)).toBeUndefined();
  });

  it("carries renderAs: datepicker through to meta", () => {
    expect(date({ label: "Published At" }).meta()).toMatchObject({ label: "Published At", renderAs: "datepicker" });
  });
});
