import z from "zod";
import { makeModel, text } from "../../src/core/model";

export default makeModel("post", {
  name: "Post",
  schema: z.object({ title: text({ label: "Title" }) }),
  searchFields: ["title"],
});
