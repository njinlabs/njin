import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveUrl } from "@njin/core/adapters/s3";

const ENV_KEYS = ["S3_ENDPOINT", "AWS_ENDPOINT", "S3_BUCKET", "AWS_BUCKET", "S3_REGION", "AWS_REGION"] as const;
let snapshot: Record<string, string | undefined>;

// resolveUrl falls back to these env vars when not passed explicitly — clear them
// around each test so results don't depend on whatever the local .env happens to have.
beforeEach(() => {
  snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
});

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

  it("falls back to env vars when options are not passed explicitly", () => {
    process.env.S3_BUCKET = "env-bucket";
    process.env.S3_REGION = "ap-southeast-1";
    expect(resolveUrl("a.png")).toBe("https://env-bucket.s3.ap-southeast-1.amazonaws.com/a.png");
  });
});
