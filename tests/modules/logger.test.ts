import { describe, expect, it } from "bun:test";
import { loadConfig } from "../../src/core/config";
import logger from "../../src/modules/logger";

const collect = () => {
  const lines: string[] = [];
  return { lines, stream: { write: (l: string) => void lines.push(l) } };
};

describe("logger module", () => {
  it("init() builds a pino logger that fn() then returns", async () => {
    await loadConfig({});
    logger.init();

    const instance = logger();
    expect(typeof instance.error).toBe("function");
    expect(typeof instance.info).toBe("function");
  });

  it("writes to custom streams as JSON lines", async () => {
    const { lines, stream } = collect();
    await loadConfig({ logger: { console: false, streams: [{ stream }] } });
    logger.init();

    logger().info({ a: 1 }, "hello");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      a: 1,
      msg: "hello",
    });
  });

  it("applies the global level and a stricter per-stream level", async () => {
    const all = collect();
    const errors = collect();
    await loadConfig({
      logger: {
        level: "debug",
        console: false,
        streams: [
          { stream: all.stream },
          { stream: errors.stream, level: "error" },
        ],
      },
    });
    logger.init();

    logger().debug("d");
    logger().error("e");

    expect(all.lines).toHaveLength(2);
    expect(errors.lines).toHaveLength(1);
  });

  it("collects plugin streams before the project's own", async () => {
    const plugin = collect();
    const project = collect();
    await loadConfig({
      plugins: [{ logger: { streams: [{ stream: plugin.stream }] } }],
      logger: { console: false, streams: [{ stream: project.stream }] },
    });
    logger.init();

    logger().info("x");

    expect(plugin.lines).toHaveLength(1);
    expect(project.lines).toHaveLength(1);
  });
});

describe("crash handlers", () => {
  it("logs uncaught exceptions and unhandled rejections as fatal before exiting", async () => {
    const { lines, stream } = collect();
    await loadConfig({ logger: { console: false, streams: [{ stream }] } });
    logger.init();

    const realExit = process.exit;
    const exits: unknown[] = [];
    process.exit = ((code?: number) => void exits.push(code)) as never;
    try {
      process.emit("uncaughtException", new Error("boom"));
      process.emit("unhandledRejection", new Error("nope"), Promise.resolve());
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      process.exit = realExit;
    }

    const fatals = lines
      .map((l) => JSON.parse(l))
      .filter((l) => l.level === 60);
    expect(fatals.map((l) => l.msg)).toEqual([
      "Uncaught exception",
      "Unhandled promise rejection",
    ]);
    expect(exits).toEqual([1, 1]);
  });
});
