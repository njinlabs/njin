import z from "zod";
import { array, makeModel, text } from "../core/model";
import db from "../modules/db";

// A named bundle of grants ("blog:*:own", "vars.site:read", …; see core/auth/access.ts). A user holds
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

// The id of the built-in full access group, created the first time it is needed.
export const ensureFullAccessGroup = async () => {
  const { rows } = await db().list(accessGroup.def, {
    where: [{ field: "name", op: "$eq", value: FULL_ACCESS_NAME }],
    page: 1,
    limit: 1,
    populate: [],
  });

  const existing = rows[0];
  if (existing) return existing.id;

  const created = await accessGroup.create({
    name: FULL_ACCESS_NAME,
    grants: FULL_ACCESS_GRANTS,
  });
  return created.id;
};

export default accessGroup;
