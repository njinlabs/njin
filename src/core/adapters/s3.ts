import type { FileAdapter } from "@njin/modules/file";
import { init } from "@paralleldrive/cuid2";
import type { S3Options } from "bun";
import z from "zod";

const createId = init({
  random: Math.random,
  length: 10,
  fingerprint: "file",
});

const meta = z.null();

// Bun.S3Client already reads S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_ENDPOINT
// (or their AWS_* equivalents) from env when not passed explicitly — see Bun's S3Options docs.
const s3Adapter = (options: S3Options & { publicUrl?: string } = {}): FileAdapter<typeof meta> => {
  const { publicUrl, ...s3Options } = options;
  const bucket = new Bun.S3Client(s3Options);

  const resolveUrl = (key: string) => {
    if (publicUrl) return `${publicUrl.replace(/\/$/, "")}/${key}`;

    const endpoint = s3Options.endpoint ?? process.env.S3_ENDPOINT ?? process.env.AWS_ENDPOINT;
    const bucketName = s3Options.bucket ?? process.env.S3_BUCKET ?? process.env.AWS_BUCKET;

    // Path-style works for AWS S3 and S3-compatible services alike (R2, Spaces, MinIO).
    if (endpoint) return `${endpoint.replace(/\/$/, "")}/${bucketName}/${key}`;

    const region = s3Options.region ?? process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1";
    return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
  };

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
        url: resolveUrl(key),
      };
    },
    unlink: (file) => bucket.delete(file.name),
  };
};

export default s3Adapter;
