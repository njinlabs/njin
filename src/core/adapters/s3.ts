import type { FileAdapter } from "../../modules/file";
import { init } from "@paralleldrive/cuid2";
import type { S3Options } from "bun";
import z from "zod";

const createId = init({
  random: Math.random,
  length: 10,
  fingerprint: "file",
});

const meta = z.null();

type ResolveUrlOptions = {
  publicUrl?: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
};

// Path-style works for AWS S3 and S3-compatible services alike (R2, Spaces, MinIO).
// No process.env fallback here on purpose — the consuming project's config.ts is the
// single place that decides whether a value comes from an env var or is hardcoded.
export const resolveUrl = (key: string, options: ResolveUrlOptions = {}): string => {
  if (options.publicUrl) return `${options.publicUrl.replace(/\/$/, "")}/${key}`;

  if (options.endpoint) return `${options.endpoint.replace(/\/$/, "")}/${options.bucket}/${key}`;

  const region = options.region ?? "us-east-1";
  return `https://${options.bucket}.s3.${region}.amazonaws.com/${key}`;
};

// `bucket` is required (unlike Bun.S3Client itself, which would otherwise fall back to
// S3_BUCKET/AWS_BUCKET env vars) — resolveUrl() needs to know it regardless, and reading
// it here directly would bypass the project's own config.ts as the single source of truth.
const s3Adapter = (options: S3Options & { bucket: string; publicUrl?: string }): FileAdapter<typeof meta> => {
  const { publicUrl, ...s3Options } = options;
  const bucket = new Bun.S3Client(s3Options);

  return {
    meta,
    write: async (file) => {
      const [fileName, ...exts] = file.name.split(".");
      const key = `${fileName}_${createId()}.${exts.join(".")}`;

      await bucket.write(key, file, { acl: "public-read", type: file.type });

      return {
        meta: null,
        name: key,
        size: file.size,
        type: file.type,
        url: resolveUrl(key, { publicUrl, endpoint: s3Options.endpoint, bucket: s3Options.bucket, region: s3Options.region }),
      };
    },
    unlink: (file) => bucket.delete(file.name),
  };
};

export default s3Adapter;
