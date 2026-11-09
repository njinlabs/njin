import auth from "../../modules/auth";

export type { AuthOptions, Principal } from "../../modules/auth";

// The `auth` macro for a project's or plugin's own routes. A route file is its own Elysia
// instance, so it has to `.use(authPlugin)` itself; without it `auth` is not a known option.
export const authPlugin = (await auth()).plugin;
