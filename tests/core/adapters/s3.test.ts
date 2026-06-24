import { describe, expect, it } from "bun:test";
import { resolveUrl } from "../../../src/core/adapters/s3";

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
