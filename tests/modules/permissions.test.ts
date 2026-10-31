import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp } from "../../src/core/testing";

// The real app, end to end: who may do what to which record, over HTTP.
const app = await createTestApp({
  models: [
    () => import("../fixtures/perm_category"),
    () => import("../fixtures/perm_article"),
  ],
  vars: [() => import("../fixtures/perm_site")],
});

afterAll(() => app.close());

type Record_ = { id: string; [field: string]: unknown };
type One = { data: Record_ };
type Many = { data: Record_[]; meta: { total: number } };

const read = async <T>(res: Response) => (await res.json()) as T;

const userWith = async (name: string, ...grants: string[]) => {
  if (grants.length === 0) return app.createUser({ name, groups: [] });

  const group = await app.createGroup({ name: `${name} group`, grants });
  return app.createUser({ name, groups: [group.id] });
};

const admin = await app.createUser({ name: "Admin" });
const nobody = await userWith("Nobody");
const editor = await userWith("Editor", "article:*:own");
const otherEditor = await userWith("Other editor", "article:*:own");
const reviewer = await userWith(
  "Reviewer",
  "article:read:all",
  "article:update:all",
);
const catalogReader = await userWith(
  "Catalog reader",
  "article:read:all",
  "category:read:all",
);

const createArticle = async (as: { id: string }, body: object) => {
  const res = await app.post("/api/article", { as, body });
  expect(res.status).toBe(200);
  return (await read<One>(res)).data;
};

const category = (
  await read<One>(
    await app.post("/api/category", {
      as: admin,
      body: { name: "News", secret: "hidden" },
    }),
  )
).data;

const linked = await createArticle(editor, {
  title: "Linked",
  category: category.id,
});

const adminsArticle = await createArticle(admin, { title: "Admin's piece" });
const editorsArticle = await createArticle(editor, { title: "Editor's piece" });

describe("without the right to", () => {
  it("answers 401 to a request with no credentials", async () => {
    expect((await app.get("/api/article")).status).toBe(401);
  });

  it("answers 403 to a user who is in no group", async () => {
    expect((await app.get("/api/article", { as: nobody })).status).toBe(403);
    expect(
      (await app.get(`/api/article/${adminsArticle.id}`, { as: nobody }))
        .status,
    ).toBe(403);
    expect(
      (await app.post("/api/article", { as: nobody, body: { title: "x" } }))
        .status,
    ).toBe(403);
    expect(
      (
        await app.put(`/api/article/${adminsArticle.id}`, {
          as: nobody,
          body: { title: "x" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.delete(`/api/article/${adminsArticle.id}`, { as: nobody }))
        .status,
    ).toBe(403);
  });

  it("answers 403 for an action the groups do not grant", async () => {
    const res = await app.post("/api/article", {
      as: reviewer,
      body: { title: "Not allowed to create" },
    });
    expect(res.status).toBe(403);

    expect(
      (await app.delete(`/api/article/${adminsArticle.id}`, { as: reviewer }))
        .status,
    ).toBe(403);
  });
});

describe("a record's creator", () => {
  it("is recorded from the caller, whatever the body says", async () => {
    const created = await createArticle(editor, {
      title: "Forged",
      createdBy: admin.id,
    });

    const shown = await read<One>(
      await app.get(`/api/article/${created.id}`, { as: admin }),
    );
    expect(shown.data.createdBy).toBe(editor.id);
  });
});

describe("own access", () => {
  it("lists only the caller's own records", async () => {
    const { data, meta } = await read<Many>(
      await app.get("/api/article", { as: editor }),
    );

    expect(data.length).toBeGreaterThan(0);
    for (const row of data) expect(row.createdBy).toBe(editor.id);
    expect(data.some((row) => row.id === adminsArticle.id)).toBe(false);
    expect(meta.total).toBe(data.length);
  });

  it("cannot be widened with a filter", async () => {
    const { data } = await read<Many>(
      await app.get("/api/article", {
        as: editor,
        query: {},
        headers: {},
      }),
    );
    const widened = await app.get(
      `/api/article?filters[createdBy]=${admin.id}`,
      { as: editor },
    );

    expect((await read<Many>(widened)).data).toEqual([]);
    expect(data.length).toBeGreaterThan(0);
  });

  it("shows, changes and deletes the caller's own record", async () => {
    const own = await createArticle(editor, { title: "Mine" });

    expect(
      (await app.get(`/api/article/${own.id}`, { as: editor })).status,
    ).toBe(200);

    const updated = await app.put(`/api/article/${own.id}`, {
      as: editor,
      body: { title: "Mine, edited" },
    });
    expect(updated.status).toBe(200);
    expect((await read<One>(updated)).data.title).toBe("Mine, edited");

    expect(
      (await app.delete(`/api/article/${own.id}`, { as: editor })).status,
    ).toBe(200);
  });

  it("treats someone else's record as not found", async () => {
    const path = `/api/article/${adminsArticle.id}`;

    expect((await app.get(path, { as: editor })).status).toBe(404);
    expect(
      (await app.put(path, { as: editor, body: { title: "Hijacked" } })).status,
    ).toBe(404);
    expect((await app.delete(path, { as: editor })).status).toBe(404);

    const still = await read<One>(await app.get(path, { as: admin }));
    expect(still.data.title).toBe("Admin's piece");
  });

  it("treats a record that does not exist the same way", async () => {
    expect(
      (await app.get("/api/article/does-not-exist", { as: editor })).status,
    ).toBe(404);
  });

  it("keeps two owners apart", async () => {
    const res = await app.get(`/api/article/${editorsArticle.id}`, {
      as: otherEditor,
    });
    expect(res.status).toBe(404);
  });
});

describe("all access", () => {
  it("sees every record and changes them, but only as far as granted", async () => {
    const { data } = await read<Many>(
      await app.get("/api/article", { as: reviewer }),
    );
    const ids = data.map((row) => row.id);
    expect(ids).toContain(adminsArticle.id);
    expect(ids).toContain(editorsArticle.id);

    const edited = await app.put(`/api/article/${adminsArticle.id}`, {
      as: reviewer,
      body: { title: "Admin's piece" },
    });
    expect(edited.status).toBe(200);
  });
});

describe("publishing", () => {
  it("is its own action", async () => {
    const draft = await createArticle(admin, { title: "To publish" });

    for (const [who, expected] of [
      [reviewer, 403],
      [editor, 404],
      [admin, 200],
    ] as const) {
      const res = await app.post(`/api/article/${draft.id}/publish`, {
        as: who,
      });
      expect(res.status).toBe(expected);
    }
  });

  it("lets the owner publish their own record", async () => {
    const own = await createArticle(editor, { title: "Mine to publish" });

    expect(
      (await app.post(`/api/article/${own.id}/publish`, { as: editor })).status,
    ).toBe(200);
  });
});

describe("linked records", () => {
  it("gives an editor of articles just enough of a category to pick one", async () => {
    const list = await read<Many>(
      await app.get("/api/category", { as: editor }),
    );

    expect(list.data.map((row) => row.id)).toContain(category.id);
    for (const row of list.data) {
      expect(row.name).toBeDefined();
      expect(row.secret).toBeUndefined();
      expect(Object.keys(row).sort()).toEqual(["id", "name"]);
    }
  });

  it("shows one category as its id and label only", async () => {
    const one = await read<One>(
      await app.get(`/api/category/${category.id}`, { as: editor }),
    );

    expect(one.data).toEqual({ id: category.id, name: "News" });
  });

  it("will not let a filter or sort on a hidden field find out about the rest", async () => {
    const res = await app.get("/api/category?filters[secret]=nope", {
      as: editor,
    });
    const hit = await read<Many>(res);
    expect(hit.data.map((row) => row.id)).toContain(category.id);

    const probe = await app.get("/api/category?select=secret&sort=secret", {
      as: editor,
    });
    for (const row of (await read<Many>(probe)).data) {
      expect(row.secret).toBeUndefined();
    }
  });

  it("is no way to change a category", async () => {
    expect(
      (
        await app.put(`/api/category/${category.id}`, {
          as: editor,
          body: { name: "Hacked" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.post("/api/category", { as: editor, body: { name: "New" } }))
        .status,
    ).toBe(403);
    expect(
      (await app.delete(`/api/category/${category.id}`, { as: editor })).status,
    ).toBe(403);
  });

  it("cuts a category expanded inside an article down to the same", async () => {
    const shown = await read<One>(
      await app.get(`/api/article/${linked.id}`, { as: editor }),
    );

    expect(shown.data.category).toEqual({ id: category.id, name: "News" });
  });

  it("shows all of it to someone who may read categories", async () => {
    const shown = await read<One>(
      await app.get(`/api/article/${linked.id}`, { as: catalogReader }),
    );
    const expanded = shown.data.category as Record_;

    expect(expanded.secret).toBe("hidden");
    expect(
      (
        await read<One>(
          await app.get(`/api/category/${category.id}`, { as: catalogReader }),
        )
      ).data.secret,
    ).toBe("hidden");
  });

  it("gives nothing to someone who cannot touch articles either", async () => {
    expect((await app.get("/api/category", { as: nobody })).status).toBe(403);
  });
});

describe("settings", () => {
  const reader = userWith("Settings reader", "vars.site:read");
  const writer = userWith("Settings writer", "vars.site:write");

  it("can be read by whoever may read them, and not written", async () => {
    const as = await reader;

    expect((await app.get("/api/vars/site", { as })).status).toBe(200);
    expect(
      (await app.put("/api/vars/site", { as, body: { title: "x" } })).status,
    ).toBe(403);
  });

  it("can be written, and published, by whoever may write them", async () => {
    const as = await writer;

    expect(
      (await app.put("/api/vars/site", { as, body: { title: "Hi" } })).status,
    ).toBe(200);
    expect((await app.post("/api/vars/site/publish", { as })).status).toBe(200);
    expect((await app.get("/api/vars/site", { as })).status).toBe(403);
  });

  it("are closed to everyone else", async () => {
    expect((await app.get("/api/vars/site", { as: nobody })).status).toBe(403);
    expect((await app.get("/api/vars/site", { as: editor })).status).toBe(403);
  });

  it("are open to full access", async () => {
    expect((await app.get("/api/vars/site", { as: admin })).status).toBe(200);
  });
});

describe("analytics", () => {
  it("needs its own grant", async () => {
    const analyst = await userWith("Analyst", "analytics:read");

    expect(
      (await app.get("/api/analytics/summary", { as: analyst })).status,
    ).toBe(200);
    expect(
      (await app.get("/api/analytics/summary", { as: editor })).status,
    ).toBe(403);
  });
});

describe("the schema a user is shown", () => {
  type Schema = { data: { prefix: string }[]; vars: { prefix: string }[] };

  it("lists what they can do something with", async () => {
    const schema = await read<Schema>(
      await app.get("/api/schema", { as: editor }),
    );
    const prefixes = schema.data.map((model) => model.prefix);

    expect(prefixes).toContain("article");
    // reachable as a choice from an article
    expect(prefixes).toContain("category");
    expect(schema.vars).toEqual([]);
  });

  it("is empty for a user who can do nothing", async () => {
    const schema = await read<Schema>(
      await app.get("/api/schema", { as: nobody }),
    );

    expect(schema.data).toEqual([]);
    expect(schema.vars).toEqual([]);
  });

  it("is complete for full access", async () => {
    const schema = await read<Schema>(
      await app.get("/api/schema", { as: admin }),
    );

    expect(schema.data.map((model) => model.prefix).sort()).toEqual([
      "article",
      "category",
    ]);
    expect(schema.vars.map((group) => group.prefix)).toEqual(["site"]);
  });
});

describe("a personal token", () => {
  const tokenFor = async (as: { id: string }, scopes: string[]) => {
    const res = await app.post("/api/token", {
      as,
      body: { name: "Script", scopes },
    });
    return (await read<{ data: { token: string } }>(res)).data.token;
  };

  it("does no more than its scopes allow", async () => {
    const token = await tokenFor(editor, ["article:read"]);

    expect((await app.get("/api/article", { as: token })).status).toBe(200);
    expect(
      (await app.post("/api/article", { as: token, body: { title: "x" } }))
        .status,
    ).toBe(403);
  });

  it("does no more than its owner could", async () => {
    const token = await tokenFor(nobody, ["*:*"]);

    expect((await app.get("/api/article", { as: token })).status).toBe(403);
  });

  it("still sees only its owner's own records", async () => {
    const token = await tokenFor(editor, ["article:*"]);
    const { data } = await read<Many>(
      await app.get("/api/article", { as: token }),
    );

    expect(data.length).toBeGreaterThan(0);
    for (const row of data) expect(row.createdBy).toBe(editor.id);
  });

  it("cannot manage users or tokens", async () => {
    const token = await tokenFor(admin, ["*:*"]);

    expect((await app.get("/api/user", { as: token })).status).toBe(401);
    expect((await app.get("/api/token", { as: token })).status).toBe(401);
  });
});

describe("managing users", () => {
  it("needs the user grants", async () => {
    expect((await app.get("/api/user", { as: editor })).status).toBe(403);
    expect((await app.get("/api/user", { as: admin })).status).toBe(200);
  });

  it("never returns a password", async () => {
    const { data } = await read<Many>(
      await app.get("/api/user", { as: admin }),
    );

    expect(data.length).toBeGreaterThan(1);
    for (const row of data) expect(row.password).toBeUndefined();
  });

  it("will not let someone who can only edit users hand out groups", async () => {
    const manager = await userWith("Manager", "user:*:all");
    const everything = await app.createGroup({
      name: "Everything",
      grants: ["*:*:all"],
    });

    const promote = await app.put(`/api/user/${manager.id}`, {
      as: manager,
      body: { groups: [everything.id] },
    });
    expect(promote.status).toBe(403);

    const rename = await app.put(`/api/user/${manager.id}`, {
      as: manager,
      body: { name: "Renamed" },
    });
    expect(rename.status).toBe(200);
  });

  it("lets someone who also manages groups do it", async () => {
    const steward = await userWith(
      "Steward",
      "user:*:all",
      "access_group:*:all",
    );
    const target = await app.createUser({ groups: [] });
    const group = await app.createGroup({
      name: "Readers of articles",
      grants: ["article:read:all"],
    });

    const res = await app.put(`/api/user/${target.id}`, {
      as: steward,
      body: { groups: [group.id] },
    });
    expect(res.status).toBe(200);
  });

  it("cannot delete oneself", async () => {
    const res = await app.delete(`/api/user/${admin.id}`, { as: admin });
    expect(res.status).toBe(400);
  });
});
