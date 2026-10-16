import { describe, expect, it } from "bun:test";
import { varsTable } from "../../../src/core/db/internal";
import { useTestDb } from "../../helpers/test_db";

// makeVars talks to the database through the db module — swap it for a real in-memory adapter.
const db = await useTestDb();

const { makeVars } = await import("../../../src/core/vars/index");
const { afterVarsUpdate, beforeVarsUpdate } = await import(
  "../../../src/core/model/hooks"
);
const { text } = await import("../../../src/core/model/data_type/text");
const { boolean } = await import("../../../src/core/model/data_type/boolean");
const z = (await import("zod")).default;

const uniquePrefix = () => `vars_${crypto.randomUUID().replace(/-/g, "")}`;

const schema = () =>
  z.object({
    siteName: text({ label: "Site Name" }, (z) => z.default("My Site")),
    maintenanceMode: boolean({ label: "Maintenance Mode" }, (z) =>
      z.default(false),
    ),
  });

describe("makeVars", () => {
  it("returns schema defaults with a null updatedAt when never saved", async () => {
    const general = makeVars(uniquePrefix(), {
      name: "General",
      schema: schema(),
    });

    const result = await general.get();

    expect(result).toEqual({
      siteName: "My Site",
      maintenanceMode: false,
      updatedAt: null,
    });
  });

  it("update() upserts the row and returns a non-null updatedAt", async () => {
    const general = makeVars(uniquePrefix(), {
      name: "General",
      schema: schema(),
    });

    const result = await general.update({ siteName: "Playground" });

    expect(result.siteName).toBe("Playground");
    expect(result.maintenanceMode).toBe(false);
    expect(result.updatedAt).not.toBeNull();
  });

  it("merges on subsequent updates instead of resetting other fields", async () => {
    const general = makeVars(uniquePrefix(), {
      name: "General",
      schema: schema(),
    });

    await general.update({ siteName: "First" });
    const second = await general.update({ maintenanceMode: true });

    expect(second.siteName).toBe("First");
    expect(second.maintenanceMode).toBe(true);
  });

  it("keeps separate groups' rows isolated by prefix", async () => {
    const general = makeVars(uniquePrefix(), {
      name: "General",
      schema: schema(),
    });
    const seo = makeVars(uniquePrefix(), { name: "SEO", schema: schema() });

    await general.update({ siteName: "General site" });
    await seo.update({ siteName: "SEO site" });

    expect((await general.get()).siteName).toBe("General site");
    expect((await seo.get()).siteName).toBe("SEO site");
  });

  it("fills in a newly-added schema field via its default for an already-stored row", async () => {
    const prefix = uniquePrefix();
    // Seed a row directly, simulating data stored before `maintenanceMode` existed.
    await db.adapter.upsert(varsTable, prefix, { siteName: "Existing" });

    const general = makeVars(prefix, { name: "General", schema: schema() });
    const result = await general.get();

    expect(result).toEqual({
      siteName: "Existing",
      maintenanceMode: false,
      updatedAt: null,
    });
  });
});

describe("makeVars hook wiring", () => {
  it("runs beforeVarsUpdate/afterVarsUpdate around update()", async () => {
    const general = makeVars(uniquePrefix(), {
      name: "General",
      schema: schema(),
    });

    const events: string[] = [];
    let updatedRecord: unknown;

    beforeVarsUpdate(general, (data) => {
      events.push("beforeVarsUpdate");
      return { siteName: `${data.siteName}!` };
    });
    afterVarsUpdate(general, (record) => {
      events.push("afterVarsUpdate");
      updatedRecord = record;
    });

    const result = await general.update({ siteName: "My Site" });

    expect(events).toEqual(["beforeVarsUpdate", "afterVarsUpdate"]);
    expect(result.siteName).toBe("My Site!");
    expect(updatedRecord).toEqual(result);
  });

  it("aborts update() when a beforeVarsUpdate hook throws", async () => {
    const general = makeVars(uniquePrefix(), {
      name: "General",
      schema: schema(),
    });

    beforeVarsUpdate(general, () => {
      throw new Error("nope");
    });

    await expect(general.update({ siteName: "My Site" })).rejects.toThrow(
      "nope",
    );
  });

  it("does not fire hooks registered for a different vars group's prefix", async () => {
    const groupA = makeVars(uniquePrefix(), {
      name: "General",
      schema: schema(),
    });
    const groupB = makeVars(uniquePrefix(), {
      name: "General",
      schema: schema(),
    });

    let calledForB = false;
    afterVarsUpdate(groupB, () => {
      calledForB = true;
    });

    await groupA.update({ siteName: "My Site" });

    expect(calledForB).toBe(false);
  });
});
