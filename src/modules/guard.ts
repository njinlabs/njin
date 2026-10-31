import { buildCatalog, type CatalogEntry } from "../core/access";
import { getConfig } from "../core/config";
import { createGuard, type Guard, type GuardModel } from "../core/guarded";
import { isDraftable } from "../core/model";

// The guard, built from every model that links to another (the project's, plus the built-in user
// and access group) so that "ref" access can be worked out from the relations between them.
// Built once: the models cannot change while the process runs.
let guard: Promise<Guard> | undefined;

const build = async () => {
  const { default: user } = await import("../models/user");
  const { default: accessGroup } = await import("../models/access_group");

  const models: GuardModel[] = [user, accessGroup];
  for (const factory of getConfig().models) {
    const { default: model } = await factory();
    models.push(model);
  }

  return createGuard(models);
};

export const getGuard = () => {
  guard ??= build();
  return guard;
};

// Everything a grant can name in this project: its models and settings groups, plus the built-in
// resources.
let catalog: Promise<CatalogEntry[]> | undefined;

const buildCatalogFromConfig = async () => {
  const models: { prefix: string; draftable: boolean }[] = [];
  for (const factory of getConfig().models) {
    const { default: model } = await factory();
    models.push({ prefix: model.prefix, draftable: isDraftable(model) });
  }

  const vars: string[] = [];
  for (const factory of getConfig().vars) {
    const { default: group } = await factory();
    vars.push(group.prefix);
  }

  return buildCatalog({ models, vars });
};

export const getCatalog = () => {
  catalog ??= buildCatalogFromConfig();
  return catalog;
};
