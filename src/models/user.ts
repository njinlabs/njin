import { email, makeModel, text } from "@njin/core/model";
import z from "zod";

const user = makeModel("user", {
  name: "Pengguna",
  schema: z.object({
    name: text({ label: "Name" }),
    email: email({ label: "Email" }),
    password: text({ label: "Password" }, (z) =>
      z.transform((value) => {
        return Bun.password.hashSync(value);
      }),
    ),
  }),
  searchFields: ["name", "email"],
});

export default user;
