import { describe, expect, it } from "bun:test";
import logger from "../../src/modules/logger";

describe("logger module", () => {
  it("init() builds a pino logger that fn() then returns", () => {
    logger.init();

    const instance = logger();
    expect(typeof instance.error).toBe("function");
    expect(typeof instance.info).toBe("function");
  });
});
