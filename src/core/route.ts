import { Elysia } from "elysia";

// Thin factory over Elysia itself — purely for DX (autocomplete/type-checking),
// same purpose as defineConfig. Custom route files get the full Elysia API
// (schema validation, guards, groups, macros, ...) with no wrapping layer.
export const route = (config?: ConstructorParameters<typeof Elysia>[0]) => new Elysia(config);
