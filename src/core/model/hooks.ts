export type HookEvent =
  | "beforeCreate"
  | "afterCreate"
  | "beforeUpdate"
  | "afterUpdate"
  | "beforeDestroy"
  | "afterDestroy"
  | "beforeVarsUpdate"
  | "afterVarsUpdate";

// Minimal structural shape needed from a model instance to infer hook types —
// deliberately not importing makeModel's return type here to avoid a circular
// import with ./index.ts (which imports this file).
type AnyModel = {
  prefix: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create: (...args: any[]) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update: (...args: any[]) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  destroy: (...args: any[]) => Promise<any>;
};

type RecordOf<M extends AnyModel> = Awaited<ReturnType<M["create"]>>;
type CreateDataOf<M extends AnyModel> = Parameters<M["create"]>[0];
type UpdateDataOf<M extends AnyModel> = Parameters<M["update"]>[1];

// Minimal structural shape needed from a vars group (makeVars, ../vars/index.ts) —
// singleton settings object, no create/destroy, and update(data) takes a single
// argument (no id, unlike a model's update(id, data): there's only ever one record
// per vars group, keyed by its own prefix).
type AnyVars = {
  prefix: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update: (...args: any[]) => Promise<any>;
};

type VarsRecordOf<V extends AnyVars> = Awaited<ReturnType<V["update"]>>;
type VarsUpdateDataOf<V extends AnyVars> = Parameters<V["update"]>[0];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookHandler = (...args: any[]) => unknown;

const registry = new Map<string, Map<HookEvent, HookHandler[]>>();

const register = (event: HookEvent, prefix: string, fn: HookHandler) => {
  let byEvent = registry.get(prefix);
  if (!byEvent) {
    byEvent = new Map();
    registry.set(prefix, byEvent);
  }

  const handlers = byEvent.get(event);
  if (handlers) {
    handlers.push(fn);
  } else {
    byEvent.set(event, [fn]);
  }
};

export const beforeCreate = <M extends AnyModel>(
  model: M,
  fn: (
    data: Partial<CreateDataOf<M>>,
  ) => void | Partial<CreateDataOf<M>> | Promise<void | Partial<CreateDataOf<M>>>,
): void => register("beforeCreate", model.prefix, fn);

export const afterCreate = <M extends AnyModel>(model: M, fn: (record: RecordOf<M>) => void | Promise<void>): void =>
  register("afterCreate", model.prefix, fn);

export const beforeUpdate = <M extends AnyModel>(
  model: M,
  fn: (
    data: Partial<UpdateDataOf<M>>,
    context: { id: string },
  ) => void | Partial<UpdateDataOf<M>> | Promise<void | Partial<UpdateDataOf<M>>>,
): void => register("beforeUpdate", model.prefix, fn);

export const afterUpdate = <M extends AnyModel>(model: M, fn: (record: RecordOf<M>) => void | Promise<void>): void =>
  register("afterUpdate", model.prefix, fn);

export const beforeDestroy = <M extends AnyModel>(model: M, fn: (id: string) => void | Promise<void>): void =>
  register("beforeDestroy", model.prefix, fn);

export const afterDestroy = <M extends AnyModel>(model: M, fn: (record: RecordOf<M>) => void | Promise<void>): void =>
  register("afterDestroy", model.prefix, fn);

export const beforeVarsUpdate = <V extends AnyVars>(
  vars: V,
  fn: (
    data: Partial<VarsUpdateDataOf<V>>,
  ) => void | Partial<VarsUpdateDataOf<V>> | Promise<void | Partial<VarsUpdateDataOf<V>>>,
): void => register("beforeVarsUpdate", vars.prefix, fn);

export const afterVarsUpdate = <V extends AnyVars>(
  vars: V,
  fn: (record: VarsRecordOf<V>) => void | Promise<void>,
): void => register("afterVarsUpdate", vars.prefix, fn);

// Internal dispatch used by makeModel — runs handlers sequentially (await each),
// merges before*-handler return values into data, and lets errors propagate so a
// throwing hook aborts the operation (same contract as UniqueConstraintError).
export const runBeforeHooks = async <T extends Record<string, unknown>>(
  event: "beforeCreate" | "beforeUpdate" | "beforeVarsUpdate",
  prefix: string,
  data: Partial<T>,
  context: { id?: string },
): Promise<Partial<T>> => {
  const handlers = registry.get(prefix)?.get(event) as
    | ((data: Partial<T>, context: { id?: string }) => void | Partial<T> | Promise<void | Partial<T>>)[]
    | undefined;
  if (!handlers?.length) return data;

  let current = data;
  for (const handler of handlers) {
    const result = await handler(current, context);
    if (result) current = { ...current, ...result };
  }

  return current;
};

export const runAfterHooks = async <T>(
  event: "afterCreate" | "afterUpdate" | "afterDestroy" | "afterVarsUpdate",
  prefix: string,
  record: T,
): Promise<void> => {
  const handlers = registry.get(prefix)?.get(event) as ((record: T) => void | Promise<void>)[] | undefined;
  if (!handlers?.length) return;

  for (const handler of handlers) {
    await handler(record);
  }
};

export const runBeforeDestroyHooks = async (prefix: string, id: string): Promise<void> => {
  const handlers = registry.get(prefix)?.get("beforeDestroy") as ((id: string) => void | Promise<void>)[] | undefined;
  if (!handlers?.length) return;

  for (const handler of handlers) {
    await handler(id);
  }
};
