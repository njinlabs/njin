import { getConfig } from "../core/config";
import { makeModule } from "../core/module";
import Elysia from "elysia";
import elysia from "./elysia";
import view from "./view";

export function isAllowed(imageUrl: string, requestHost: string, allowedHosts: string[] = getConfig().img.hosts): boolean {
  if (imageUrl.startsWith("/")) return true;

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return false;
  }

  const imageHostname = parsed.hostname;
  // Strip port — host header may include it (e.g. "localhost:3000")
  const requestHostname = requestHost.split(":")[0];

  // Same host as the incoming request — works across dev, staging, and production
  if (imageHostname === requestHostname) return true;

  // localhost variants — covers Vite dev server running on a different port (5173)
  if (imageHostname === "localhost" || imageHostname === "127.0.0.1") return true;

  // Truly external hosts: require explicit whitelist
  return allowedHosts.includes(imageHostname);
}

export function extractFilename(url: string): string {
  try {
    const pathname = url.startsWith("/") ? url : new URL(url).pathname;
    const last = pathname.split("/").filter(Boolean).pop() ?? "image";
    const name = last.replace(/\.[^.]+$/, "") || "image";
    return `${name}.webp`;
  } catch {
    return "image.webp";
  }
}

const img = makeModule(() => {
  const fn = () => {};

  fn.init = async () => {
    view().global("imgOptimize", (url: string, options?: { w?: number; h?: number; q?: number }) => {
      const params = new URLSearchParams({ url });
      if (options?.w != null) params.set("w", String(options.w));
      if (options?.h != null) params.set("h", String(options.h));
      if (options?.q != null) params.set("q", String(options.q));
      return `/img?${params.toString()}`;
    });

    const controller = new Elysia();

    controller.get("/img", async ({ query, request }) => {
      const { url, w, h, q = "80" } = query;

      if (!url) {
        return new Response("Missing url parameter", { status: 400 });
      }

      const width = w ? parseInt(w) : undefined;
      const height = h ? parseInt(h) : undefined;
      const quality = Math.min(100, Math.max(1, parseInt(q)));

      if (isNaN(quality)) {
        return new Response("Invalid q parameter", { status: 400 });
      }

      const requestHost = request.headers.get("host") ?? "";

      if (!isAllowed(url, requestHost)) {
        return new Response("Host not allowed", { status: 403 });
      }

      // ETag is deterministic from input params — allows 304 without fetching or processing
      const etag = `"${Bun.hash(`${url}|${w ?? ""}|${h ?? ""}|${quality}`).toString(16)}"`;
      const cacheControl = "public, max-age=31536000, immutable";

      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": cacheControl },
        });
      }

      let imageData: ArrayBuffer;

      if (url.startsWith("/")) {
        const resp = await fetch(`http://localhost:${getConfig().port}${url}`);
        if (!resp.ok) return new Response("Image not found", { status: 404 });
        imageData = await resp.arrayBuffer();
      } else {
        const resp = await fetch(url);
        if (!resp.ok) return new Response("Failed to fetch image", { status: 502 });
        imageData = await resp.arrayBuffer();
      }

      const pipeline = new Bun.Image(imageData);

      if (width) {
        // Bun.Image.resize() takes width first and derives height from aspect ratio
        // when height is omitted — there's no height-only equivalent, so width-only
        // and width+height both go through this branch unchanged.
        pipeline.resize(width, height, { fit: "inside", withoutEnlargement: true });
      } else if (height) {
        // Height-only request — derive a proportional width from the source dimensions
        // since resize() requires a width argument.
        const meta = await pipeline.metadata();
        const derivedWidth = Math.round((meta.width / meta.height) * height);
        pipeline.resize(derivedWidth, height, { fit: "inside", withoutEnlargement: true });
      }

      const output = await pipeline.webp({ quality }).buffer();
      const filename = extractFilename(url);

      return new Response(new Uint8Array(output), {
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": String(output.byteLength),
          "Content-Disposition": `inline; filename="${filename}"`,
          "Cache-Control": cacheControl,
          ETag: etag,
          Vary: "Accept",
        },
      });
    });

    elysia().use(controller);
    return {};
  };

  return fn;
});

export default img;
