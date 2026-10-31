import z from "zod";
import { makeVars, text } from "../../src/core/model";

export default makeVars("site", {
  name: "Site",
  schema: z.object({ title: text({ label: "Title" }).optional() }),
  draftable: true,
});
