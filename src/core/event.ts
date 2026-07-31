import logger from "../modules/logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler<T> = (payload: T) => void | Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<symbol, Handler<any>[]>();

export interface EventBus<T = void> {
  dispatch: (payload: T) => Promise<void>;
  listen: (handler: Handler<T>) => void;
}

// Opens a new channel on the shared event bus — no name/string key: correlation
// between dispatch() and listen() happens purely via sharing this same returned
// instance (import it from one canonical file), not via a global string registry.
// This is what makes T genuinely type-safe — dispatch and listen on one instance
// always share the same T, there's no way for two unrelated call sites to silently
// disagree on payload shape. The Symbol key routes through one shared `registry`
// Map so the whole app still runs on a single underlying bus.
export const makeEvent = <T = void>(): EventBus<T> => {
  const key = Symbol();
  registry.set(key, []);

  const listen: EventBus<T>["listen"] = (handler) => {
    registry.get(key)!.push(handler);
  };

  // Runs every listener sequentially (await each) — a throwing/rejecting listener
  // is caught and logged, NOT propagated: this is a fan-out notification, not a
  // validation/abort hook like hooks.ts, so one broken listener must never stop
  // its siblings or bubble into the dispatch() caller.
  const dispatch: EventBus<T>["dispatch"] = async (payload) => {
    const handlers = registry.get(key) ?? [];
    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (err) {
        logger().error(err, "Event listener threw");
      }
    }
  };

  return { dispatch, listen };
};
