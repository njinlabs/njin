import Elysia from "elysia";

// Fake replacement for src/modules/elysia.ts's default export — captures every
// controller passed to .use() instead of mounting it on a real listening app.
//
// A captured sub-app can't just be `.handle()`d directly: Elysia only applies a
// sub-app's own `{ prefix }` once it's `.use()`'d into a parent — calling `.handle()`
// on the sub-app standalone ignores the prefix entirely and 404s. `buildApp()` mounts
// every captured controller onto a fresh real `Elysia()` root (mirroring what the real
// elysia() singleton does across a whole app boot) so tests can `.handle()` against
// that root and see prefixed routes resolve correctly.
export const makeFakeElysia = () => {
  const controllers: unknown[] = [];

  const fakeApp = {
    use(controller: unknown) {
      controllers.push(controller);
      return fakeApp;
    },
  };

  const fn = () => fakeApp;

  const buildApp = () => {
    let app = new Elysia();
    for (const controller of controllers) app = app.use(controller as Elysia);
    return app;
  };

  return { fn, controllers, fakeApp, buildApp };
};
