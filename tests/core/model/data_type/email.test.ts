import { describe, expect, it } from "bun:test";
import { email } from "@njin/core/model/data_type/email";

describe("email", () => {
  it("accepts a valid email", () => {
    expect(email({ label: "Email" }).parse("a@b.com")).toBe("a@b.com");
  });

  it("rejects an invalid email format", () => {
    expect(email({ label: "Email" }).safeParse("not-an-email").success).toBe(false);
  });

  it("rejects missing value by default (required)", () => {
    expect(email({ label: "Email" }).safeParse(undefined).success).toBe(false);
  });

  it("treats empty string as absent via preprocess", () => {
    expect(email({ label: "Email" }).safeParse("").success).toBe(false);
  });

  it("allows opting out of required via rule", () => {
    expect(email({ label: "Email" }, (z) => z.optional()).parse(undefined)).toBeUndefined();
  });

  it("carries label/renderAs through to meta", () => {
    expect(email({ label: "Email" }).meta()).toMatchObject({ label: "Email", renderAs: "text" });
  });
});
