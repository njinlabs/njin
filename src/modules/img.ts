import { getConfig } from "../core/config";
import { makeModule } from "../core/module";
import Elysia from "elysia";
import elysia from "./elysia";
import view from "./view";

export function isAllowed(imageUrl: string, allowedHosts: string[] = getConfig().img.hosts): boolean {
  if (imageUrl.startsWith("/")) return true;

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return false;
  }

  const imageHostname = parsed.hostname;

  // localhost variants are only trusted outside production — covers the Vite dev
  // server running on a different port (5173). Trusting the client-supplied `Host`
  // header, or allowing loopback unconditionally, would turn this into an SSRF
  // primitive (an attacker controls both the `url` query param and their own
  // request's `Host` header), so neither is honored here.
  if (process.env.NODE_ENV !== "production" && (imageHostname === "localhost" || imageHostname === "127.0.0.1")) return true;

  // Every other host: require explicit whitelist
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

      if (!isAllowed(url)) {
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
        // A real network fetch to localhost:<port> only works when app.listen() actually bound
        // that port — under njin-supervisor's worker mode (NJIN_WORKER=1, see core/worker.ts)
        // nothing does, requests arrive via postMessage and are handled in-process instead, so
        // that socket was never listening and this always failed with a connection error.
        // Calling the same in-process Elysia instance's handle() works in both modes, and skips
        // an unnecessary self-round-trip even outside worker mode. The origin is taken from the
        // *incoming* request rather than hardcoded — routing itself only cares about
        // pathname+query, but a handler further down that inspects request.url (absolute-URL
        // generation, host-based logic, ...) should see the same scheme/host this request
        // actually arrived on, not a fake one that may not match across environments.
        const resp = await elysia().handle(new Request(`${new URL(request.url).origin}${url}`));
        if (!resp.ok) return new Response("Image not found", { status: 404 });
        imageData = await resp.arrayBuffer();
      } else {
        // `redirect: "error"` — a validated host redirecting to an unvalidated
        // (e.g. internal) one would otherwise silently defeat the isAllowed() check above.
        let resp: Response;
        try {
          resp = await fetch(url, { redirect: "error" });
        } catch {
          return new Response("Failed to fetch image", { status: 502 });
        }
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
