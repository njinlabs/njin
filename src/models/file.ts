import z from "zod";
import { makeModel, numeric, text } from "../core/model";
import { getConfig } from "../core/runtime/config";

const file = makeModel("file", {
  name: "File",
  schema: z.object({
    meta: getConfig().adapters.file.meta,
    name: text({ label: "Filename" }),
    size: numeric({ label: "Size" }),
    type: text({ label: "Mime Type" }),
    url: text({ label: "URL" }),
  }),
  searchFields: ["name"],
});

export default file;
