// Shared by the small server-rendered pages (OAuth sign-in, MCP file drop) — they live outside
// the site's own views on purpose, so they work regardless of what theme/templates a project uses.

export const noStore = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
};

export const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

// A consent page must never be framable (clickjacking the Allow button) or cached.
const pageHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  ...noStore,
};

export const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f7;--card:#fff;--fg:#18181b;--muted:#6b7280;--line:#d4d4d8;--accent:#18181b;--accent-fg:#fff;--danger:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--card:#18181b;--fg:#fafafa;--muted:#a1a1aa;--line:#3f3f46;--accent:#fafafa;--accent-fg:#18181b;--danger:#f87171}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 8px}
p{margin:0 0 16px;color:var(--muted)}
strong{color:var(--fg)}
label{display:block;font-size:14px;margin:12px 0 4px}
input[type=email],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
.row{display:flex;gap:8px;margin-top:20px}
button{flex:1;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.error{color:var(--danger);font-size:14px;margin:0 0 12px}
input[type=file]{width:100%;padding:32px 12px;border:2px dashed var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.ok{color:var(--fg)}
ul{margin:0 0 16px;padding-left:20px;color:var(--muted)}
.host{font-family:ui-monospace,monospace;font-size:14px;color:var(--fg)}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`,
    { status, headers: pageHeaders },
  );
