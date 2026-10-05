import { randomBytes, timingSafeEqual } from "node:crypto";
import Elysia from "elysia";
import moment from "moment";
import { RecordId, Table } from "surrealdb";
import { escapeHtml, noStore, page } from "../core/html_page";
import { makeModule } from "../core/module";
import elysia from "./elysia";
import fileModule from "./file";
import surreal from "./surreal";

// How an agent gets a file *into* the site. MCP is JSON-RPC, and a file the user dropped into
// the chat can't be passed through a tool argument (base64 floods the context and models mangle
// it), so the tool only hands out a short-lived upload URL: the agent `curl`s the file to it from
// its sandbox, or — when it has no shell/network — gives the URL to the user to open and drop
// the file on. The bytes never pass through the model either way.

const table = new Table("mcp_upload");

export const UPLOAD_TTL_MINUTES = 10;
export const MAX_FILES_PER_TICKET = 10;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Allowlist, not a denylist: /uploads/* is served from the site's own origin by file extension,
// so an uploaded .html/.svg/.js would run with the same origin as the admin panel. The declared
// MIME type is ignored (the client picks it) and replaced with the one mapped here — object
// stores that serve by stored Content-Type would otherwise be told whatever the uploader said.
export const ALLOWED_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  woff: "font/woff",
  woff2: "font/woff2",
};

type McpUpload = {
  id: RecordId;
  hash: string;
  createdBy: string | null;
  tokenId: string;
  expiresAt: string;
  remaining: number;
  files: string[];
};

type FileRecord = {
  id: RecordId;
  name: string;
  url: string;
  type: string;
  size: number;
};

const hashSecret = (plain: string) =>
  new Bun.CryptoHasher("sha256").update(plain).digest("hex");

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
};

const isPast = (iso: string) => moment().isAfter(iso);

const publicFile = ({ id, name, url, type, size }: FileRecord) => ({
  id: id.id.toString(),
  name,
  url,
  type,
  size,
});

// Called by the create_upload_url tool.
export const createUploadTicket = async (input: {
  tokenId: string;
  userId: string | null;
  base: string;
}) => {
  // Tickets are short-lived; anything an hour past expiry is only clutter (the grace period
  // lets check_upload still answer shortly after a ticket lapses).
  await surreal().query("DELETE mcp_upload WHERE expiresAt < $cutoff;", {
    cutoff: moment().subtract(1, "hour").toISOString(),
  });

  const secret = randomBytes(24).toString("base64url");
  const expiresAt = moment().add(UPLOAD_TTL_MINUTES, "minutes").toISOString();

  const [created] = await surreal()
    .create<McpUpload>(table)
    .content({
      hash: hashSecret(secret),
      createdBy: input.userId,
      tokenId: input.tokenId,
      expiresAt,
      remaining: MAX_FILES_PER_TICKET,
      files: [],
    });

  const id = created!.id.id.toString();

  return {
    upload_id: id,
    url: `${input.base}/mcp/upload/${id}.${secret}`,
    expires_at: expiresAt,
    max_files: MAX_FILES_PER_TICKET,
    max_file_bytes: MAX_FILE_BYTES,
    allowed_extensions: Object.keys(ALLOWED_TYPES),
  };
};

// Called by the check_upload tool: what has landed on a ticket so far.
export const getUploadStatus = async (uploadId: string) => {
  const ticket = await surreal().select<McpUpload>(
    new RecordId(table, uploadId),
  );
  if (!ticket) return null;

  const files = (
    await Promise.all(
      ticket.files.map((id) => fileModule().model.show(id) as Promise<unknown>),
    )
  )
    .filter(Boolean)
    .map((record) => publicFile(record as FileRecord));

  return {
    files,
    remaining: ticket.remaining,
    expired: isPast(ticket.expiresAt),
  };
};

const mcpUpload = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    const wantsHtml = (request: Request) =>
      request.headers.get("accept")?.includes("text/html") ?? false;

    const fail = (request: Request, status: number, message: string) =>
      wantsHtml(request)
        ? page(
            "Upload failed",
            `<h1>Upload failed</h1><p>${escapeHtml(message)}</p>`,
            status,
          )
        : new Response(JSON.stringify({ error: message }), {
            status,
            headers: { "Content-Type": "application/json", ...noStore },
          });

    // The URL is the credential: "<ticket id>.<secret>", the secret stored only as a hash.
    // Every failure reads the same to the caller, so a guessed id reveals nothing.
    const loadTicket = async (param: string) => {
      const dot = param.lastIndexOf(".");
      const id = param.slice(0, dot);
      const secret = param.slice(dot + 1);

      const ticket =
        dot > 0 && secret
          ? await surreal().select<McpUpload>(new RecordId(table, id))
          : null;

      if (!ticket || !safeEqual(ticket.hash, hashSecret(secret))) return null;
      if (isPast(ticket.expiresAt) || ticket.remaining <= 0) return null;

      return ticket;
    };

    const invalid = (request: Request) =>
      fail(request, 404, "This upload link is invalid, expired or used up.");

    const controller = new Elysia()
      .get("/mcp/upload/:ticket", async ({ request, params }) => {
        const ticket = await loadTicket(params.ticket);
        if (!ticket) return invalid(request);

        const maxMb = MAX_FILE_BYTES / 1024 / 1024;

        return page(
          "Upload files",
          `<h1>Upload files</h1>
<p>Choose or drop up to ${ticket.remaining} files (${maxMb} MB each). The assistant will pick them up from here.</p>
<form method="post" enctype="multipart/form-data">
<input type="file" name="file" multiple required>
<div class="row"><button type="submit" class="primary">Upload</button></div>
</form>`,
        );
      })
      .post(
        "/mcp/upload/:ticket",
        async ({ request, params }) => {
          const ticket = await loadTicket(params.ticket);
          if (!ticket) return invalid(request);

          // Checked before the body is buffered — formData() reads it all into memory.
          const declared = Number(request.headers.get("content-length") ?? 0);
          if (declared > ticket.remaining * MAX_FILE_BYTES + 64 * 1024) {
            return fail(request, 413, "That upload is too large.");
          }

          let incoming: FormDataEntryValue[];
          try {
            incoming = (await request.formData()).getAll("file");
          } catch {
            return fail(request, 400, "Send the file as multipart form data.");
          }

          const files = incoming.filter(
            (entry): entry is File => entry instanceof File,
          );
          if (files.length === 0) {
            return fail(request, 400, 'No file found in the "file" field.');
          }
          if (files.length > ticket.remaining) {
            return fail(
              request,
              400,
              `This link accepts ${ticket.remaining} more file(s).`,
            );
          }

          // Everything is validated before anything is written, so a bad file in the batch
          // doesn't leave the others half-uploaded.
          const normalized: File[] = [];
          for (const file of files) {
            const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
            const type = ALLOWED_TYPES[extension];

            if (!file.name.includes(".") || !type) {
              return fail(
                request,
                415,
                `"${file.name}": this file type is not allowed.`,
              );
            }
            if (file.size === 0 || file.size > MAX_FILE_BYTES) {
              return fail(
                request,
                413,
                `"${file.name}" must be between 1 byte and ${MAX_FILE_BYTES / 1024 / 1024} MB.`,
              );
            }

            normalized.push(new File([file], file.name, { type }));
          }

          const created: FileRecord[] = [];
          for (const file of normalized) {
            const [record] = (await fileModule().upload(file)) as FileRecord[];
            created.push(record!);
          }

          await surreal()
            .update(new RecordId(table, ticket.id.id))
            .merge({
              remaining: ticket.remaining - created.length,
              files: [
                ...ticket.files,
                ...created.map((f) => f.id.id.toString()),
              ],
            });

          if (wantsHtml(request)) {
            return page(
              "Uploaded",
              `<h1>Uploaded</h1><p>You can close this tab and go back to the chat.</p><ul>${created
                .map((f) => `<li>${escapeHtml(f.name)}</li>`)
                .join("")}</ul>`,
            );
          }

          return new Response(
            JSON.stringify({ data: created.map(publicFile) }),
            {
              headers: { "Content-Type": "application/json", ...noStore },
            },
          );
        },
        { parse: "none" },
      );

    elysia().use(controller);

    return {};
  };

  return fn;
});

export default mcpUpload;
