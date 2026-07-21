// Output rendering (cli.mdx §4.3/§4.4). Paths go to STDOUT; headers ride stdout with them (they
// are the grouped-output contract); counts and diagnostics go to STDERR so `lfb files … | wc -l`
// counts only file paths. Two blank lines between category blocks — exactly two (dictated).
import path from "node:path";
import type { FilesListCategory } from "./client";

export function renderFlat(categories: FilesListCategory[], bare: boolean): void {
  categories.forEach((cat, i) => {
    if (i > 0) process.stdout.write("\n\n"); // exactly two blank lines between blocks (cli.mdx §4.4)
    if (!bare) process.stdout.write(`${cat.title}:\n`);
    for (const p of cat.paths) process.stdout.write(`${p}\n`);
    process.stderr.write(`— ${cat.paths.length} file${cat.paths.length === 1 ? "" : "s"} (${cat.key})\n`);
  });
}

// ── --tree: a `tree`-style hierarchy of ONLY the matching set (cli.mdx §4.3) ─────────────────────
// One tree per category. Directories with no matches are pruned by construction (only matching
// paths are inserted); single-child directory chains collapse into one "a/b/c" segment so deep
// lone paths stay readable, mirroring `tree --prune` sensibilities.

interface Node {
  children: Map<string, Node>;
  isFile: boolean;
}

function insert(root: Node, parts: string[]): void {
  let cur = root;
  parts.forEach((part, i) => {
    let next = cur.children.get(part);
    if (!next) {
      next = { children: new Map(), isFile: false };
      cur.children.set(part, next);
    }
    if (i === parts.length - 1) next.isFile = true;
    cur = next;
  });
}

/** Collapse single-child pure-directory chains: a→b→c(file) prints as "a/b" then "c". */
function collapsed(name: string, node: Node): { name: string; node: Node } {
  while (!node.isFile && node.children.size === 1) {
    const [childName, child] = [...node.children.entries()][0];
    name = `${name}/${childName}`;
    node = child;
  }
  return { name, node };
}

function renderNode(node: Node, prefix: string, out: string[]): void {
  const entries = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b));
  entries.forEach(([rawName, rawChild], i) => {
    const last = i === entries.length - 1;
    const { name, node: child } = collapsed(rawName, rawChild);
    out.push(`${prefix}${last ? "└── " : "├── "}${name}`);
    renderNode(child, prefix + (last ? "    " : "│   "), out);
  });
}

export function renderTree(categories: FilesListCategory[], bare: boolean): void {
  categories.forEach((cat, i) => {
    if (i > 0) process.stdout.write("\n\n");
    if (!bare) process.stdout.write(`${cat.title}:\n`);
    // Root the tree at the deepest common ancestor so the interesting structure leads.
    const split = cat.paths.map((p) => p.split(path.sep).filter(Boolean));
    let common = split[0] ?? [];
    for (const parts of split) {
      let n = 0;
      while (n < common.length && n < parts.length && common[n] === parts[n]) n++;
      common = common.slice(0, n);
    }
    // A single path's common prefix is the file itself — root at its parent directory instead.
    if (cat.paths.length === 1 && common.length) common = common.slice(0, -1);
    const root: Node = { children: new Map(), isFile: false };
    for (const parts of split) insert(root, parts.slice(common.length));
    const out: string[] = [path.sep + common.join(path.sep)];
    renderNode(root, "", out);
    process.stdout.write(out.join("\n") + "\n");
    process.stderr.write(`— ${cat.paths.length} file${cat.paths.length === 1 ? "" : "s"} (${cat.key})\n`);
  });
}
