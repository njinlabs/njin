import pino from "pino";
import pretty from "pino-pretty";
import { getConfig } from "../core/config";
import { makeModule } from "../core/module";

// Grace period for custom (possibly async) streams to flush the fatal entry before exiting.
const FATAL_EXIT_DELAY_MS = 100;

const logger = makeModule(() => {
  let p: pino.Logger;
  let crashHandlersInstalled = false;

  const fn = () => p;

  // Without these, an error thrown outside any request/handler (a floating promise, a timer
  // callback) is printed raw to stderr by the runtime and the process dies — never reaching
  // pino or the custom streams. Log it as fatal first, then exit like the runtime would have.
  const installCrashHandlers = () => {
    if (crashHandlersInstalled) return;
    crashHandlersInstalled = true;

    const fatal = (err: unknown, msg: string) => {
      p.fatal(err, msg);
      setTimeout(() => process.exit(1), FATAL_EXIT_DELAY_MS);
    };

    process.on("uncaughtException", (err) => fatal(err, "Uncaught exception"));
    process.on("unhandledRejection", (reason) =>
      fatal(reason, "Unhandled promise rejection"),
    );
  };

  fn.init = () => {
    const { level, console, streams } = getConfig().logger;

    // Every destination is an in-process stream (no pino.transport worker threads), so this
    // also works inside the `bun build --compile` binary and njin's own worker threads.
    const destinations: pino.StreamEntry[] = [
      ...(console
        ? [
            {
              level,
              // pino-pretty writes asynchronously by default — a crash right after a log call
              // would lose the buffered line, which is exactly the one you need.
              stream: pretty({ colorize: true, sync: true }),
            } as pino.StreamEntry,
          ]
        : []),
      ...streams.map((s) => ({
        level: s.level ?? level,
        stream: s.stream,
      })),
    ];

    p = pino({ level }, pino.multistream(destinations));
    installCrashHandlers();
    return {};
  };

  return fn;
});

export default logger;
