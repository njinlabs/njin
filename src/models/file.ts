import { getConfig } from "../core/config";
import { makeModel, numeric, text } from "../core/model";
import z from "zod";

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
