import { describe, expect, it } from "bun:test";
import s3Adapter, { resolveUrl } from "../../../src/core/adapters/s3";

describe("resolveUrl", () => {
  it("uses publicUrl when provided, stripping a trailing slash", () => {
    expect(resolveUrl("a.png", { publicUrl: "https://cdn.example.com/" })).toBe("https://cdn.example.com/a.png");
  });

  it("falls back to path-style URL when endpoint is given (R2/Spaces/MinIO)", () => {
    expect(resolveUrl("a.png", { endpoint: "https://r2.example.com/", bucket: "my-bucket" })).toBe(
      "https://r2.example.com/my-bucket/a.png",
    );
  });

  it("falls back to AWS virtual-hosted URL when no endpoint/publicUrl given", () => {
    expect(resolveUrl("a.png", { bucket: "my-bucket", region: "us-west-2" })).toBe(
      "https://my-bucket.s3.us-west-2.amazonaws.com/a.png",
    );
  });

  it("defaults region to us-east-1 when not given", () => {
    expect(resolveUrl("a.png", { bucket: "my-bucket" })).toBe("https://my-bucket.s3.us-east-1.amazonaws.com/a.png");
  });

  it("never reads process.env — values must come from the caller (the project's config.ts)", () => {
    process.env.S3_BUCKET = "env-bucket";
    process.env.S3_REGION = "ap-southeast-1";
    try {
      expect(resolveUrl("a.png", { bucket: "explicit-bucket" })).toBe(
        "https://explicit-bucket.s3.us-east-1.amazonaws.com/a.png",
      );
    } finally {
      delete process.env.S3_BUCKET;
      delete process.env.S3_REGION;
    }
  });
});

describe("s3Adapter", () => {
  const withStubbedS3Client = async (
    stub: { write: (...args: unknown[]) => unknown; delete: (...args: unknown[]) => unknown },
    run: () => Promise<void>,
  ) => {
    const OriginalS3Client = Bun.S3Client;
    class FakeS3Client {
      write(...args: unknown[]) {
        return stub.write(...args);
      }
      delete(...args: unknown[]) {
        return stub.delete(...args);
      }
    }
    // @ts-expect-error — intentionally stubbing the global for this test only
    Bun.S3Client = FakeS3Client;
    try {
      await run();
    } finally {
      Bun.S3Client = OriginalS3Client;
    }
  };

  it("writes a file to the bucket and returns a resolved public URL", async () => {
    const calls: unknown[] = [];
    await withStubbedS3Client(
      {
        write: (...args) => {
          calls.push(args);
          return Promise.resolve();
        },
        delete: () => Promise.resolve(),
      },
      async () => {
        const adapter = s3Adapter({ bucket: "my-bucket", region: "us-west-2" });
        const file = new File(["hello"], "myphoto.png", { type: "image/png" });

        const result = await adapter.write(file);

        expect(result.name).toMatch(/^myphoto_[a-z0-9]{10}\.png$/);
        expect(result.size).toBe(file.size);
        expect(result.type).toBe("image/png");
        expect(result.meta).toBeNull();
        expect(result.url).toBe(`https://my-bucket.s3.us-west-2.amazonaws.com/${result.name}`);

        expect(calls).toHaveLength(1);
        const [key, writtenFile, options] = calls[0] as [string, File, Record<string, unknown>];
        expect(key).toBe(result.name);
        expect(writtenFile).toBe(file);
        expect(options).toEqual({ acl: "public-read", type: "image/png" });
      },
    );
  });

  it("resolves the URL via publicUrl when given", async () => {
    await withStubbedS3Client({ write: () => Promise.resolve(), delete: () => Promise.resolve() }, async () => {
      const adapter = s3Adapter({ bucket: "my-bucket", publicUrl: "https://cdn.example.com/" });
      const file = new File(["hello"], "a.png", { type: "image/png" });

      const result = await adapter.write(file);

      expect(result.url).toBe(`https://cdn.example.com/${result.name}`);
    });
  });

  it("deletes a file from the bucket by name", async () => {
    const calls: unknown[] = [];
    await withStubbedS3Client(
      {
        write: () => Promise.resolve(),
        delete: (...args) => {
          calls.push(args);
          return Promise.resolve();
        },
      },
      async () => {
        const adapter = s3Adapter({ bucket: "my-bucket" });

        await adapter.unlink({
          name: "some-key.png",
          size: 1,
          type: "image/png",
          meta: null,
          url: "https://x/some-key.png",
          id: undefined as never,
          createdAt: "",
          updatedAt: "",
        });

        expect(calls).toEqual([["some-key.png"]]);
      },
    );
  });
});
