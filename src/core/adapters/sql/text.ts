// Rewrites the statement text njin composes (PostgreSQL flavoured: "quoted" identifiers and $1,
// $2 placeholders) for drivers that want something else. It walks the text once, copying
// single-quoted string literals untouched, so a `?` or `"` inside a literal is never mistaken
// for syntax.

export type TextStyle = {
  // Write "name" as `name` (MySQL and MariaDB outside ANSI_QUOTES mode).
  backticks?: boolean;
};

export const toPositional = (text: string, style: TextStyle = {}) => {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const char = text[i] as string;

    if (char === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new Error("Unterminated string literal");
        if (style.backticks && text[j] === "\\") {
          // MySQL reads a backslash inside a literal as an escape; njin never writes one.
          throw new Error("Backslash in a string literal");
        }
        if (text[j] === "'") {
          if (text[j + 1] === "'") j += 2;
          else break;
        } else j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (char === '"') {
      let j = i + 1;
      let name = "";
      for (;;) {
        if (j >= text.length) throw new Error("Unterminated identifier");
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            name += '"';
            j += 2;
          } else break;
        } else {
          name += text[j];
          j += 1;
        }
      }
      out += style.backticks
        ? `\`${name.replaceAll("`", "``")}\``
        : `"${name.replaceAll('"', '""')}"`;
      i = j + 1;
      continue;
    }

    if (char === "$" && /[0-9]/.test(text[i + 1] ?? "")) {
      let j = i + 1;
      while (/[0-9]/.test(text[j] ?? "")) j += 1;
      out += "?";
      i = j;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
};
