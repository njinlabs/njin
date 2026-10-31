import z from "zod";
import { array, makeModel, text } from "../core/model";

// A named bundle of grants ("blog:*:own", "vars.site:read", …; see core/access.ts). A user holds
// any number of these and gets everything they grant. Grants are checked against the models and
// settings groups the project really has when a group is saved (modules/access_group.ts), since
// that list is only known once the config is loaded.
const accessGroup = makeModel("access_group", {
  name: "Access group",
  schema: z.object({
    name: text({ label: "Name", unique: true }),
    description: text({ label: "Description" }).optional(),
    grants: array({ label: "Grants" }, z.string()),
  }),
  searchFields: ["name"],
});

// The group the first admin is put in: every action on everything.
export const FULL_ACCESS_NAME = "Full access";
export const FULL_ACCESS_GRANTS = ["*:*:all"];

export default accessGroup;
