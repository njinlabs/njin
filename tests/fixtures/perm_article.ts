import z from "zod";
import { makeModel, relation, text } from "../../src/core/model";
import category from "./perm_category";

export default makeModel("article", {
  name: "Article",
  schema: z.object({
    title: text({ label: "Title" }),
    category: relation({ label: "Category" }, category, (r) => r.optional()),
  }),
  searchFields: ["title"],
  draftable: true,
});
