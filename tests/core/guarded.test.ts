import { describe, expect, it } from "bun:test";
import z from "zod";
import type { Condition } from "../../src/core/db/contract";
import { HttpError } from "../../src/core/http_error";
import { useTestDb } from "../helpers/test_db";

const db = await useTestDb();

const { createGuard } = await import("../../src/core/guarded");
const { makeModel, relation, text } = await import("../../src/core/model");
const { default: userModel } = await import("../../src/models/user");
const { default: accessGroup } = await import("../../src/models/access_group");
const { issueToken, resolveBearer } = await import("../../src/modules/token");

const category = makeModel("category", {
  name: "Category",
  schema: z.object({
    name: text({ label: "Name" }),
    secret: text({ label: "Secret" }).optional(),
  }),
  searchFields: ["name"],
});
const article = makeModel("article", {
  name: "Article",
  schema: z.object({
    title: text({ label: "Title" }),
    category: relation({ label: "Category" }, category, (r) => r.optional()),
  }),
  searchFields: ["title"],
});
const bare = makeModel("bare", {
  name: "Bare",
  schema: z.object({ code: text({ label: "Code" }) }),
  searchFields: [],
});

await db.sync([
  userModel.def,
  accessGroup.def,
  category.def,
  article.def,
  bare.def,
]);

const guard = createGuard([category, article, bare]);

let counter = 0;
const principalWith = async (...grants: string[]) => {
  counter += 1;
  const group = await accessGroup.create({
    name: `Group ${counter}`,
    grants,
  });
  const user = await userModel.create({
    name: `User ${counter}`,
    email: `user${counter}@example.com`,
    password: "x",
    groups: [group.id],
  });
  const principal = await resolveBearer(
    (await issueToken({ user: user.id, kind: "session" })).bearer,
  );
  if (!principal) throw new Error("no principal");
  return principal;
};

const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 200;
  } catch (error) {
    if (error instanceof HttpError) return error.statusCode;
    throw error;
  }
};

describe("gate.read", () => {
  it("is refused to someone with no right to read", async () => {
    const gate = guard.gate(await principalWith("article:create"), article);

    expect(await status(() => gate.read({}))).toBe(403);
  });

  it("leaves the options of someone who may read everything alone", async () => {
    const gate = guard.gate(await principalWith("article:read:all"), article);
    const options = {
      search: "x",
      sort: "title",
      filters: { title: "a" },
      where: [] as Condition[],
    };

    expect(gate.read(options)).toEqual(options);
  });

  it("confines an own-scoped reader to their records, keeping other conditions", async () => {
    const principal = await principalWith("article:read:own");
    const gate = guard.gate(principal, article);
    const extra = { field: "title", op: "$eq" as const, value: "x" };

    const confined = gate.read({
      where: [extra] as readonly Condition[],
      filters: { title: "y" },
    });

    expect(confined.where).toEqual([
      extra,
      { field: "createdBy", op: "$eq", value: principal.user.id },
    ]);
    expect(confined.filters).toEqual({ title: "y" });
  });

  it("cuts a read that is only a reference down to the label", async () => {
    const gate = guard.gate(
      await principalWith("article:update:all"),
      category,
    );

    const narrowed = gate.read({
      sort: "secret",
      select: ["secret"],
      filters: { secret: "x" },
      populate: ["anything"] as string[] | "none",
      search: "news",
    });

    expect(narrowed.select).toEqual(["name"]);
    expect(narrowed.filters).toBeUndefined();
    expect(narrowed.sort).toBeUndefined();
    expect(narrowed.populate).toBe("none");
    expect(narrowed.search).toBe("news");
  });

  it("shows a reference by the label key of the relation that points at it", async () => {
    const people = makeModel("person", {
      name: "Person",
      schema: z.object({
        name: text({ label: "Name" }),
        nickname: text({ label: "Nickname" }),
      }),
      searchFields: ["name"],
    });
    const post = makeModel("byline", {
      name: "Byline",
      schema: z.object({
        author: relation({ label: "Author", labelKey: "nickname" }, people),
      }),
      searchFields: [],
    });
    const labelled = createGuard([people, post]);
    const gate = labelled.gate(
      await principalWith("byline:update:all"),
      people,
    );

    expect(
      gate.read({ select: undefined as string[] | undefined }).select,
    ).toEqual(["nickname"]);
    expect(
      gate.shape({ id: "p1", name: "Ann", nickname: "A", secret: "x" }),
    ).toEqual({ id: "p1", nickname: "A" });
  });

  it("ignores a label key the target does not have", async () => {
    const places = makeModel("place", {
      name: "Place",
      schema: z.object({ name: text({ label: "Name" }) }),
      searchFields: ["name"],
    });
    const visit = makeModel("visit", {
      name: "Visit",
      schema: z.object({
        place: relation(
          { label: "Place", labelKey: "nonexistent" as never },
          places,
        ),
      }),
      searchFields: [],
    });
    const labelled = createGuard([places, visit]);
    const gate = labelled.gate(await principalWith("visit:update:all"), places);

    expect(
      gate.read({ select: undefined as string[] | undefined }).select,
    ).toEqual(["name"]);
  });

  it("lets a reference be sorted by its label", async () => {
    const gate = guard.gate(
      await principalWith("article:update:all"),
      category,
    );

    expect(gate.read({ sort: "name" }).sort).toBe("name");
  });

  it("asks for the id alone when the model has nothing to label it with", async () => {
    const reference = createGuard([
      makeModel("holder", {
        name: "Holder",
        schema: z.object({
          bare: relation({ label: "Bare" }, bare, (r) => r.optional()),
        }),
        searchFields: [],
      }),
      bare,
    ]);
    const gate = reference.gate(await principalWith("holder:update"), bare);

    expect(
      gate.read({ select: undefined as string[] | undefined }).select,
    ).toEqual(["id"]);
  });
});

describe("gate.seeing and gate.changing", () => {
  it("lets everyone with all access through without looking at the record", async () => {
    const gate = guard.gate(await principalWith("article:*:all"), article);

    expect(await status(() => gate.seeing("no-such-record"))).toBe(200);
    expect(await status(() => gate.changing("no-such-record", "update"))).toBe(
      200,
    );
  });

  it("answers 403 to an action nothing grants", async () => {
    const gate = guard.gate(await principalWith("article:read:all"), article);

    expect(await status(() => gate.changing("x", "update"))).toBe(403);
    expect(await status(() => gate.changing("x", "delete"))).toBe(403);
    expect(await status(() => gate.changing("x", "publish"))).toBe(403);
  });

  it("answers 404 to a record that is someone else's, or missing", async () => {
    const principal = await principalWith("article:*:own");
    // a real user: adapters that enforce foreign keys refuse an owner that does not exist
    const stranger = await principalWith("article:*:own");
    const gate = guard.gate(principal, article);

    const mine = await article.create(
      { title: "Mine" },
      { createdBy: principal.user.id },
    );
    const theirs = await article.create(
      { title: "Theirs" },
      { createdBy: stranger.user.id },
    );
    const unowned = await article.create({ title: "Unowned" });

    expect(await status(() => gate.seeing(mine.id))).toBe(200);
    expect(await status(() => gate.changing(mine.id, "delete"))).toBe(200);

    for (const id of [theirs.id, unowned.id, "missing"]) {
      expect(await status(() => gate.seeing(id))).toBe(404);
      expect(await status(() => gate.changing(id, "update"))).toBe(404);
    }
  });

  it("does not look at ownership for a reference", async () => {
    const gate = guard.gate(
      await principalWith("article:update:all"),
      category,
    );

    expect(await status(() => gate.seeing("whatever"))).toBe(200);
    expect(await status(() => gate.changing("whatever", "update"))).toBe(403);
  });
});

describe("gate.creating", () => {
  it("names the caller as the creator", async () => {
    const principal = await principalWith("article:create");

    expect(guard.gate(principal, article).creating()).toEqual({
      createdBy: principal.user.id,
    });
  });

  it("is refused without the right to create", async () => {
    const gate = guard.gate(await principalWith("article:read:all"), article);

    expect(await status(() => gate.creating())).toBe(403);
  });
});

describe("gate.shape and gate.echo", () => {
  const linked = {
    id: "a1",
    title: "T",
    createdBy: "somebody",
    category: { id: "c1", name: "News", secret: "hidden" },
  };

  it("cuts a linked record down where the caller may not read it", async () => {
    const gate = guard.gate(await principalWith("article:read:all"), article);

    expect(gate.shape(linked).category).toEqual({ id: "c1", name: "News" });
  });

  it("leaves a linked record whole where the caller may read it", async () => {
    const gate = guard.gate(
      await principalWith("article:read:all", "category:read:all"),
      article,
    );

    expect(gate.shape(linked).category).toEqual(linked.category);
  });

  it("reduces a record to its label when the caller only holds a reference to it", async () => {
    const gate = guard.gate(
      await principalWith("article:update:all"),
      category,
    );

    expect(gate.shape({ id: "c1", name: "News", secret: "hidden" })).toEqual({
      id: "c1",
      name: "News",
    });
  });

  it("echoes a written record whole to someone who could read it", async () => {
    const gate = guard.gate(await principalWith("article:*:all"), article);

    expect(gate.echo(linked).title).toBe("T");
  });

  it("echoes only the label to someone who could not", async () => {
    const gate = guard.gate(await principalWith("article:create"), article);

    expect(gate.echo(linked)).toEqual({ id: "a1", title: "T" });
  });

  it("echoes an own-scoped caller's record whole and another's by its label", async () => {
    const principal = await principalWith(
      "article:*:own",
      "article:update:all",
    );
    const gate = guard.gate(principal, article);

    expect(gate.echo({ ...linked, createdBy: principal.user.id }).title).toBe(
      "T",
    );
    expect(gate.echo({ ...linked, createdBy: "another" })).toEqual({
      id: "a1",
      title: "T",
    });
  });

  it("shapes a list", async () => {
    const gate = guard.gate(await principalWith("article:read:all"), article);

    expect(gate.shapeAll([linked, linked]).map((row) => row.category)).toEqual([
      { id: "c1", name: "News" },
      { id: "c1", name: "News" },
    ]);
  });
});

describe("guard.vars", () => {
  it("passes whoever holds the grant and refuses the rest", async () => {
    const reader = await principalWith("vars.site:read");
    const writer = await principalWith("vars.site:write");

    expect(await status(() => guard.vars(reader, "site")("read"))).toBe(200);
    expect(await status(() => guard.vars(reader, "site")("write"))).toBe(403);
    expect(await status(() => guard.vars(writer, "site")("write"))).toBe(200);
    expect(await status(() => guard.vars(writer, "site")("read"))).toBe(403);
    expect(await status(() => guard.vars(reader, "other")("read"))).toBe(403);
  });
});

describe("guard.can", () => {
  it("counts a reference as a way to read", async () => {
    const principal = await principalWith("article:update:all");

    expect(guard.can(principal, "category", "read")).toBe("ref");
    expect(guard.can(principal, "category", "update")).toBe(false);
    expect(guard.can(principal, "bare", "read")).toBe(false);
  });

  it("knows a file may be shown by its name", async () => {
    const files = createGuard([
      makeModel("gallery", {
        name: "Gallery",
        schema: z.object({
          cover: z.string().meta({ renderAs: "file", model: "file" }),
        }),
        searchFields: [],
      }),
    ]);
    const principal = await principalWith("gallery:update");

    expect(files.can(principal, "file", "read")).toBe("ref");
  });
});
