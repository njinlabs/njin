import { describe, expect, it } from "bun:test";
import { HttpError } from "../../src/core/http_error";

describe("HttpError", () => {
  it("uses the default message for a known status code", () => {
    const err = new HttpError(404);
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Not Found");
    expect(err.name).toBe("HttpError");
  });

  it("uses a custom message when provided", () => {
    const err = new HttpError(400, "Custom message");
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("Custom message");
  });

  it.each([
    [400, "Bad Request"],
    [401, "Unauthorized"],
    [403, "Forbidden"],
    [404, "Not Found"],
    [422, "Unprocessable Entity"],
    [500, "Internal Server Error"],
  ])("maps status %d to %s", (code, message) => {
    expect(new HttpError(code).message).toBe(message);
  });

  it("falls back to a generic message for an unknown status code", () => {
    expect(new HttpError(418).message).toBe("HTTP Error 418");
  });

  it("is an instance of Error", () => {
    expect(new HttpError(500)).toBeInstanceOf(Error);
  });
});
