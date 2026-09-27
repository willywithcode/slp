// Write sets and owned paths are simple globs: `**` any depth, `*` within one
// path segment, `?` one character. Paths use forward slashes.

export function normalizePath(path: string): string {
  return path.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function globToRegExp(glob: string): RegExp {
  const g = normalizePath(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      // "**/" matches zero or more directories; a trailing "**" anything.
      if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matches(globs: readonly string[], path: string): boolean {
  const p = normalizePath(path);
  return globs.some((g) => globToRegExp(g).test(p) || globToRegExp(`${normalizePath(g)}/**`).test(p));
}

/** The literal directory prefix of a glob, before its first wildcard. */
function literalPrefix(glob: string): string {
  const g = normalizePath(glob);
  const cut = g.search(/[*?]/);
  const lit = cut === -1 ? g : g.slice(0, cut);
  return cut === -1 ? lit : lit.slice(0, lit.lastIndexOf("/") + 1);
}

/**
 * Whether two glob sets could name the same file. Conservative: globs whose
 * literal prefixes are nested (one is a prefix of the other) overlap.
 */
export function overlaps(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      const px = literalPrefix(x);
      const py = literalPrefix(y);
      if (px.startsWith(py) || py.startsWith(px)) {
        // Two exact files with a shared prefix only overlap if equal.
        if (!/[*?]/.test(x) && !/[*?]/.test(y)) { if (normalizePath(x) === normalizePath(y)) return true; continue; }
        if (!/[*?]/.test(x) && matches([y], x)) return true;
        if (!/[*?]/.test(y) && matches([x], y)) return true;
        if (/[*?]/.test(x) && /[*?]/.test(y)) return true;
      }
    }
  }
  return false;
}

/** A glob that names (nearly) everything: refused as a write set. */
export function isCatchAll(glob: string): boolean {
  const g = normalizePath(glob);
  return g === "" || g === "*" || g === "**" || /^\*\*\/\*(\.[a-z0-9]+)?$/i.test(g) || /^\*\.[a-z0-9]+$/i.test(g);
}
