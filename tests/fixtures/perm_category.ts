import z from "zod";
import { makeModel, text } from "../../src/core/model";

export default makeModel("category", {
  name: "Category",
  schema: z.object({
    name: text({ label: "Name" }),
    secret: text({ label: "Secret" }).optional(),
  }),
  searchFields: ["name"],
});
