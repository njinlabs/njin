import { describe, expect, it } from "bun:test";
import z from "zod";
import {
  access,
  buildCatalog,
  buildRelationGraph,
  compile,
  intersectScopes,
  isOwner,
  isScope,
  minimal,
  ownerFilter,
  parseGrant,
  redactRefs,
  relationFieldsOf,
  scopeCovers,
  scopeMatches,
  validateGrants,
} from "../../../src/core/auth/access";

const link = (model: string) =>
  z.string().meta({ renderAs: "relation", model });
const links = (model: string) =>
  z.array(z.string()).meta({ renderAs: "multi_relation", model });

const schemas = {
  blog: z.object({
    title: z.string(),
    category: link("category"),
    tags: links("tag"),
    cover: z.string().meta({ renderAs: "file", model: "file" }),
  }),
  category: z.object({ name: z.string() }),
  tag: z.object({ name: z.string() }),
};

const graph = buildRelationGraph(Object.entries(schemas));

describe("parseGrant", () => {
  it("defaults the scope to all", () => {
    expect(parseGrant("blog:read")).toEqual({
      resource: "blog",
      action: "read",
      scope: "all",
    });
  });

  it("reads an explicit scope", () => {
    expect(parseGrant("blog:update:own")?.scope).toBe("own");
  });

  it.each(["blog", "", "a:b:c:d", "blog:read:mine", ":read", "blog:"])(
    "rejects %p",
    (value) => {
      expect(parseGrant(value)).toBeNull();
    },
  );
});

describe("access", () => {
  it("answers false for a resource nothing was granted on", () => {
    expect(access(compile([]), "blog", "read")).toBe(false);
    expect(access(compile(["blog:read"]), "blog", "update")).toBe(false);
    expect(access(compile(["blog:read"]), "category", "read")).toBe(false);
  });

  it("returns the scope the grant carries", () => {
    const p = compile(["blog:read:all", "blog:update:own"]);

    expect(access(p, "blog", "read")).toBe("all");
    expect(access(p, "blog", "update")).toBe("own");
  });

  it("lets the widest of several matching grants win (union)", () => {
    const p = compile(["blog:update:own", "blog:update:all"]);
    expect(access(p, "blog", "update")).toBe("all");

    const q = compile(["blog:*:own", "blog:read:all"]);
    expect(access(q, "blog", "read")).toBe("all");
    expect(access(q, "blog", "delete")).toBe("own");
  });

  it("expands a wildcard on either half", () => {
    expect(access(compile(["*:read:all"]), "anything", "read")).toBe("all");
    expect(access(compile(["*:read:all"]), "anything", "update")).toBe(false);
    expect(access(compile(["blog:*:all"]), "blog", "publish")).toBe("all");
    expect(access(compile(["*:*:all"]), "user", "delete")).toBe("all");
  });

  it("ignores malformed grants instead of throwing", () => {
    expect(access(compile(["nonsense", "blog:read"]), "blog", "read")).toBe(
      "all",
    );
  });

  describe("vars groups", () => {
    it("only know read and write", () => {
      const p = compile(["vars.site:write"]);

      expect(access(p, "vars.site", "write")).toBe("all");
      expect(access(p, "vars.site", "read")).toBe(false);
      expect(access(compile(["vars.site:read"]), "vars.site", "write")).toBe(
        false,
      );
    });

    it("treat any wildcard action as write access", () => {
      expect(access(compile(["*:*:all"]), "vars.site", "write")).toBe("all");
      expect(access(compile(["vars.site:*"]), "vars.site", "write")).toBe(
        "all",
      );
    });

    it("never resolve to own, since a group has no owner", () => {
      expect(access(compile(["*:*:own"]), "vars.site", "write")).toBe(false);
      expect(access(compile(["*:read:own"]), "vars.site", "read")).toBe(false);
    });
  });

  describe("token scopes", () => {
    it("narrow what the user could do", () => {
      const p = compile(["*:*:all"], ["blog:read"]);

      expect(access(p, "blog", "read")).toBe("all");
      expect(access(p, "blog", "update")).toBe(false);
      expect(access(p, "category", "read")).toBe(false);
    });

    it("can never exceed the user's own grants", () => {
      const p = compile(["blog:read:own"], ["blog:read", "blog:delete"]);

      expect(access(p, "blog", "read")).toBe("own");
      expect(access(p, "blog", "delete")).toBe(false);
    });

    it("accept wildcards", () => {
      const p = compile(["*:*:all"], ["blog:*", "*:read"]);

      expect(access(p, "blog", "delete")).toBe("all");
      expect(access(p, "category", "read")).toBe("all");
      expect(access(p, "category", "update")).toBe(false);
    });

    it("grant nothing for an empty scope list", () => {
      expect(access(compile(["*:*:all"], []), "blog", "read")).toBe(false);
    });

    it("ignore malformed scopes", () => {
      const p = compile(["*:*:all"], ["blog", "blog:read:all"]);
      expect(access(p, "blog", "read")).toBe(false);
    });
  });

  describe("ref", () => {
    it.each(["read", "create", "update"])(
      "comes from %s access to a model that links there",
      (action) => {
        const p = compile([`blog:${action}:own`]);

        expect(access(p, "category", "read", graph)).toBe("ref");
        expect(access(p, "tag", "read", graph)).toBe("ref");
        expect(access(p, "file", "read", graph)).toBe("ref");
      },
    );

    it("does not come from delete or publish alone", () => {
      const p = compile(["blog:delete", "blog:publish"]);
      expect(access(p, "category", "read", graph)).toBe(false);
    });

    it("is only ever a read", () => {
      const p = compile(["blog:update"]);

      expect(access(p, "category", "update", graph)).toBe(false);
      expect(access(p, "category", "create", graph)).toBe(false);
      expect(access(p, "category", "delete", graph)).toBe(false);
    });

    it("is not given to models nothing links to", () => {
      expect(access(compile(["blog:update"]), "blog", "read", graph)).toBe(
        false,
      );
    });

    it("is not transitive", () => {
      const chain = buildRelationGraph([
        ["a", z.object({ b: link("b") })],
        ["b", z.object({ c: link("c") })],
        ["c", z.object({})],
      ]);

      expect(access(compile(["a:update"]), "b", "read", chain)).toBe("ref");
      expect(access(compile(["a:update"]), "c", "read", chain)).toBe(false);
    });

    it("yields to a real grant", () => {
      const p = compile(["blog:update", "category:read:own"]);
      expect(access(p, "category", "read", graph)).toBe("own");
    });

    it("needs the referrer to be allowed under the token's scopes", () => {
      const outside = compile(["*:*:all"], ["category:read"]);
      expect(access(outside, "tag", "read", graph)).toBe(false);

      const inside = compile(["*:*:all"], ["blog:create"]);
      expect(access(inside, "category", "read", graph)).toBe("ref");
    });

    it("is not derived without a relation graph", () => {
      expect(access(compile(["blog:update"]), "category", "read")).toBe(false);
    });

    it("does not apply to vars groups", () => {
      expect(access(compile(["blog:update"]), "vars.site", "read", graph)).toBe(
        false,
      );
    });
  });
});

describe("ownerFilter", () => {
  it("restricts an own-scoped caller to rows they created", () => {
    expect(ownerFilter("own", "u1")).toEqual([
      { field: "createdBy", op: "$eq", value: "u1" },
    ]);
  });

  it.each(["all", "ref"] as const)("adds nothing for %s", (level) => {
    expect(ownerFilter(level, "u1")).toEqual([]);
  });
});

describe("isOwner", () => {
  it("compares createdBy as a bare id or as an expanded record", () => {
    expect(isOwner({ createdBy: "u1" }, "u1")).toBe(true);
    expect(isOwner({ createdBy: { id: "u1" } }, "u1")).toBe(true);
    expect(isOwner({ createdBy: "u2" }, "u1")).toBe(false);
  });

  it("is false for a row nobody owns", () => {
    expect(isOwner({}, "u1")).toBe(false);
    expect(isOwner({ createdBy: null }, "u1")).toBe(false);
  });
});

describe("relationFieldsOf / buildRelationGraph", () => {
  it("lists link fields with their cardinality and target", () => {
    expect(relationFieldsOf(schemas.blog)).toEqual([
      { name: "category", many: false, target: "category", labelKey: null },
      { name: "tags", many: true, target: "tag", labelKey: null },
      { name: "cover", many: false, target: "file", labelKey: null },
    ]);
  });

  it("reads the field a relation is shown by, when it names a plain one", () => {
    const schema = z.object({
      author: z
        .string()
        .meta({ renderAs: "relation", model: "user", labelKey: "name" }),
      editor: z
        .string()
        .meta({ renderAs: "relation", model: "user", labelKey: "a.b" }),
      owner: z
        .string()
        .meta({ renderAs: "relation", model: "user", labelKey: 7 }),
    });

    expect(relationFieldsOf(schema).map((field) => field.labelKey)).toEqual([
      "name",
      null,
      null,
    ]);
  });

  it("indexes the models that link to a target", () => {
    expect(graph.referrersOf("category")).toEqual(["blog"]);
    expect(graph.referrersOf("blog")).toEqual([]);
  });
});

describe("redactRefs", () => {
  const fields = relationFieldsOf(schemas.blog);
  const label = (target: string) => (target === "file" ? undefined : "name");

  const row = {
    id: "b1",
    title: "Hello",
    category: { id: "c1", name: "News", secret: "x", createdBy: "u1" },
    tags: [
      { id: "t1", name: "a", secret: "x" },
      { id: "t2", name: "b", secret: "y" },
    ],
    cover: { id: "f1", name: "cover.png", url: "/u/cover.png" },
  };

  it("cuts expanded links to id and label where the target is not readable", () => {
    const out = redactRefs(row, fields, () => "ref", "u1", label);

    expect(out.category).toEqual({ id: "c1", name: "News" });
    expect(out.tags).toEqual([
      { id: "t1", name: "a" },
      { id: "t2", name: "b" },
    ]);
    expect(out.cover).toEqual({ id: "f1" });
    expect(out.title).toBe("Hello");
  });

  it("leaves a fully readable target alone", () => {
    const out = redactRefs(row, fields, () => "all", "u1", label);
    expect(out).toEqual(row);
  });

  it("keeps only the caller's own rows whole under an own grant", () => {
    const mixed = {
      ...row,
      tags: [
        { id: "t1", name: "a", secret: "x", createdBy: "u1" },
        { id: "t2", name: "b", secret: "y", createdBy: "u2" },
      ],
    };
    const out = redactRefs(mixed, fields, () => "own", "u1", label);

    expect(out.category).toEqual(row.category);
    expect(out.tags).toEqual([
      { id: "t1", name: "a", secret: "x", createdBy: "u1" },
      { id: "t2", name: "b" },
    ]);
  });

  it("redacts a target the caller has no access to at all", () => {
    const out = redactRefs(row, fields, () => false, "u1", label);
    expect(out.category).toEqual({ id: "c1", name: "News" });
  });

  it("leaves links that never expanded", () => {
    const bare = { id: "b1", category: "c1", tags: ["t1"], cover: null };
    expect(redactRefs(bare, fields, () => false, "u1", label)).toEqual(bare);
  });

  it("does not mutate its input", () => {
    const copy = structuredClone(row);
    redactRefs(row, fields, () => "ref", "u1", label);
    expect(row).toEqual(copy);
  });
});

describe("minimal", () => {
  it("keeps the id and the label field only", () => {
    expect(minimal({ id: "1", name: "A", x: 1 }, "name")).toEqual({
      id: "1",
      name: "A",
    });
  });

  it("falls back to the id when there is no label", () => {
    expect(minimal({ id: "1", name: "A" })).toEqual({ id: "1" });
    expect(minimal({ id: "1" }, "name")).toEqual({ id: "1" });
  });
});

describe("catalog and validation", () => {
  const catalog = buildCatalog({
    models: [{ prefix: "blog", draftable: true }, { prefix: "category" }],
    vars: ["site"],
  });

  it("only offers publish on draftable models", () => {
    const by = Object.fromEntries(catalog.map((e) => [e.resource, e]));

    expect(by.blog?.actions).toContain("publish");
    expect(by.category?.actions).not.toContain("publish");
    expect(by["vars.site"]?.actions).toEqual(["read", "write"]);
    expect(by["vars.site"]?.scoped).toBe(false);
    expect(by.file?.scoped).toBe(true);
    expect(by.analytics?.scoped).toBe(false);
  });

  it("accepts valid grants, including wildcards", () => {
    expect(
      validateGrants(
        [
          "blog:publish",
          "blog:*:own",
          "*:*:all",
          "*:read",
          "vars.site:write",
          "file:create:own",
        ],
        catalog,
      ),
    ).toEqual([]);
  });

  it("explains what is wrong with a bad grant", () => {
    const errors = validateGrants(
      [
        "nope",
        "ghost:read",
        "category:publish",
        "vars.site:update",
        "vars.site:read:own",
        "analytics:read:own",
        "*:fly",
      ],
      catalog,
    );

    expect(errors).toHaveLength(7);
    expect(errors[0]).toContain("not a valid grant");
    expect(errors[1]).toContain('unknown resource "ghost"');
    expect(errors[2]).toContain('no action "publish"');
    expect(errors[3]).toContain('no action "update"');
    expect(errors[4]).toContain("no owner");
    expect(errors[5]).toContain("no owner");
    expect(errors[6]).toContain('unknown action "fly"');
  });
});

describe("scopes", () => {
  it("are <resource>:<action> with nothing else in them", () => {
    for (const ok of ["article:read", "*:*", "vars.site:write", "*:read"]) {
      expect(isScope(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "article",
      "a:b:c",
      "a b:read",
      ":read",
      "article:",
    ]) {
      expect(isScope(bad)).toBe(false);
    }
  });

  it("match when each half is equal or a wildcard in the granted one", () => {
    expect(scopeMatches("*:*", "article:read")).toBe(true);
    expect(scopeMatches("article:*", "article:read")).toBe(true);
    expect(scopeMatches("*:read", "article:read")).toBe(true);
    expect(scopeMatches("article:read", "article:read")).toBe(true);

    expect(scopeMatches("article:read", "article:update")).toBe(false);
    expect(scopeMatches("article:*", "category:read")).toBe(false);
    expect(scopeMatches("*:read", "article:update")).toBe(false);
  });

  it("never take in a wider scope than the one granted", () => {
    expect(scopeMatches("article:read", "*:*")).toBe(false);
    expect(scopeMatches("article:*", "*:read")).toBe(false);
    expect(scopeMatches("*:read", "*:*")).toBe(false);
  });

  it("cover a list only when every one of them is taken in", () => {
    expect(scopeCovers(["*:*"], ["article:read", "user:delete"])).toBe(true);
    expect(scopeCovers(["article:read"], ["article:read"])).toBe(true);
    expect(
      scopeCovers(["article:read"], ["article:read", "article:update"]),
    ).toBe(false);
    expect(scopeCovers([], ["article:read"])).toBe(false);
    expect(scopeCovers(["article:read"], [])).toBe(true);
  });

  it("intersect to what both take in, the narrower of each pair", () => {
    expect(intersectScopes(["*:*"], ["article:read"])).toEqual([
      "article:read",
    ]);
    expect(intersectScopes(["article:read"], ["*:*"])).toEqual([
      "article:read",
    ]);
    expect(
      intersectScopes(
        ["article:*", "user:read"],
        ["article:read", "user:*"],
      ).sort(),
    ).toEqual(["article:read", "user:read"]);
    expect(intersectScopes(["article:read"], ["user:read"])).toEqual([]);
    expect(intersectScopes([], ["*:*"])).toEqual([]);
  });
});

describe("catalog with a plugin's resources", () => {
  const catalog = buildCatalog({
    models: [],
    vars: [],
    extra: [{ resource: "report", actions: ["read", "export"], scoped: false }],
  });

  it("lists them after the built-in ones", () => {
    expect(catalog.at(-1)).toEqual({
      resource: "report",
      actions: ["read", "export"],
      scoped: false,
    });
  });

  it("validates grants on them like any other", () => {
    expect(validateGrants(["report:export", "report:*"], catalog)).toEqual([]);
    expect(validateGrants(["report:delete"], catalog)).toHaveLength(1);
    expect(validateGrants(["report:read:own"], catalog)).toHaveLength(1);
  });
});
