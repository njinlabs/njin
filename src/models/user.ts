import z from "zod";
import { email, makeModel, text } from "../core/model";
import surreal from "../modules/surreal";

const user = makeModel("user", {
  name: "Pengguna",
  schema: z.object({
    name: text({ label: "Name" }),
    email: email({ label: "Email", unique: true }),
    password: text({ label: "Password" }, (z) =>
      z.transform((value) => {
        return Bun.password.hashSync(value);
      }),
    ),
  }),
  searchFields: ["name", "email"],
});

// Verified against when an email is unknown, so "no such account" and "wrong password" cost
// the same and login timing can't be used to enumerate accounts.
export const DUMMY_HASH = Bun.password.hashSync("njin-dummy-password");

// Emails are compared case-insensitively (Admin@Example.com and admin@example.com are the same
// mailbox), including accounts created before emails were normalised.
export const findUserByEmail = async <T = Record<string, any>>(
  value: string,
) => {
  const [rows] = await surreal().query<[T[]]>(
    `SELECT * FROM ${user.prefix} WHERE string::lowercase(email) = $email LIMIT 1`,
    { email: value.trim().toLowerCase() },
  );
  return rows?.[0];
};

export default user;
