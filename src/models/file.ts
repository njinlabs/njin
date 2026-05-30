import adapters from "@njin/config/adapter";
import { makeModel, numeric, text } from "@njin/core/model";
import z from "zod";

const file = makeModel("file", {
  name: "File",
  schema: z.object({
    meta: adapters.file.meta,
    name: text({ label: "Filename" }),
    size: numeric({ label: "Size" }),
    type: text({ label: "Mime Type" }),
    url: text({ label: "URL" }),
  }),
  searchFields: ["name"],
});

export default file;
