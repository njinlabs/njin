import { getConfig } from "./config";

// The base URL clients actually reach the site on. config.publicUrl wins; otherwise it is
// derived from the request, honouring a reverse proxy's X-Forwarded-* headers — those are
// only trusted for building discovery documents, never for any access decision.
export const publicBase = (request: Request) => {
  const configured = getConfig().publicUrl;
  if (configured) return configured.replace(/\/+$/, "");

  const url = new URL(request.url);
  const first = (name: string) =>
    request.headers.get(name)?.split(",")[0]?.trim();

  const proto = first("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host =
    first("x-forwarded-host") ?? request.headers.get("host") ?? url.host;

  return `${proto}://${host}`;
};
