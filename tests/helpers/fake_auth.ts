import Elysia from "elysia";
import { compile } from "../../src/core/access";

// Fake replacement for src/modules/auth.ts's default export — a real Elysia plugin
// (macros can't be faked with a plain object) whose `auth` macro always resolves to a
// fixed user, so downstream modules that gate routes behind `{ auth: true }` can be
// tested without a real bearer token / DB round trip.
export const fakeUser = {
  id: "fixeduser1",
  name: "Fixed User",
  email: "fixed@example.com",
};

// What the fixed user may do: everything, unless a test passes grants to try something narrower.
export const FULL_ACCESS = ["*:*:all"];

export const fakePrincipal = (grants: readonly string[] = FULL_ACCESS) => ({
  user: fakeUser,
  kind: "session" as const,
  token: { id: "fixedtoken1", name: null, clientId: null },
  permissions: compile(grants),
});

export const makeFakeAuthPlugin = (grants: readonly string[] = FULL_ACCESS) =>
  new Elysia({ name: "auth" }).macro({
    auth: {
      resolve: () => ({
        user: { ...fakeUser, tokenId: "fixedtoken1" },
        principal: fakePrincipal(grants),
      }),
    },
  });
