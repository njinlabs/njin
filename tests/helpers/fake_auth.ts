import Elysia from "elysia";
import { RecordId } from "surrealdb";

// Fake replacement for src/modules/auth.ts's default export — a real Elysia plugin
// (macros can't be faked with a plain object) whose `auth` macro always resolves to a
// fixed user, so downstream modules that gate routes behind `{ auth: true }` can be
// tested without a real bearer token / DB round trip.
export const fakeUser = {
  id: new RecordId("user", "fixeduser1"),
  name: "Fixed User",
  email: "fixed@example.com",
};

export const makeFakeAuthPlugin = () =>
  new Elysia({ name: "auth" }).macro({
    auth: {
      resolve: () => ({ user: { ...fakeUser, tokenId: new RecordId("token", "fixedtoken1") } }),
    },
  });
