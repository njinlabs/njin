// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Helper = { name: string; fn: (...args: any[]) => unknown };

// Identity function — DX/typing only, same purpose as defineConfig/definePlugin.
export const defineHelper = (name: string, fn: Helper["fn"]): Helper => ({ name, fn });
