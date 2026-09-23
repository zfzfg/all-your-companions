import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

/** Resolve the spawned ESM tree against the artifact, including package entries. */
export function checkEsmPackageGraph(root, packedFiles, entries) {
  const packed = new Set(packedFiles);
  const visited = new Set();
  const problems = [];
  const builtins = new Set(builtinModules);
  const selectExport = value => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return undefined;
    for (const [condition, target] of Object.entries(value)) {
      if (["import", "node", "default"].includes(condition)) {
        const selected = selectExport(target);
        if (selected) return selected;
      }
    }
    return undefined;
  };
  const visit = file => {
    if (visited.has(file)) return;
    visited.add(file);
    if (!packed.has(file)) { problems.push(`${file}: ESM runtime file is NOT packed`); return; }
    let source;
    try { source = readFileSync(path.join(root, file), "utf8"); }
    catch { problems.push(`${file}: ESM runtime file missing on disk`); return; }
    if (!/\.[cm]?js$/.test(file)) return;
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const specs = [];
    const walk = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
          && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) specs.push(node.arguments[0].text);
        else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) problems.push(`${file}: cannot verify computed ESM import`);
      }
      ts.forEachChild(node, walk);
    };
    walk(tree);
    for (const spec of specs) {
      if (spec.startsWith("node:") || builtins.has(spec)) continue;
      if (spec.startsWith(".")) { visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))); continue; }
      const parts = spec.split("/");
      const name = parts.splice(0, spec.startsWith("@") ? 2 : 1).join("/");
      let directory = path.posix.dirname(file);
      let manifest;
      while (true) {
        const candidate = path.posix.join(directory, "node_modules", name, "package.json");
        if (packed.has(candidate)) { manifest = candidate; break; }
        if (directory === ".") break;
        directory = path.posix.dirname(directory);
      }
      if (!manifest) { problems.push(`${file}: ${spec} package.json is NOT packed`); continue; }
      const pkg = JSON.parse(readFileSync(path.join(root, manifest), "utf8"));
      const subpath = parts.length ? `./${parts.join("/")}` : ".";
      const exports = pkg.exports;
      const target = exports === undefined
        ? (parts.length ? parts.join("/") : pkg.main || "index.js")
        : selectExport(typeof exports === "string" || !Object.keys(exports).some(key => key.startsWith("."))
          ? (subpath === "." ? exports : undefined) : exports[subpath]);
      if (!target) { problems.push(`${file}: cannot resolve ESM export ${spec}`); continue; }
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(manifest), target)));
    }
  };
  entries.forEach(visit);
  return problems;
}
