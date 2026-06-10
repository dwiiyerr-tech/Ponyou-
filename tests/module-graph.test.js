import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { init, parse } from "es-module-lexer";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IGNORED_DIRS = new Set([".claude", ".claude-flow", ".git", "logs", "node_modules"]);
const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs"];

function toRepoPath(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function isRelativeSpecifier(specifier) {
  return specifier?.startsWith("./") || specifier?.startsWith("../");
}

function collectSourceFiles(dir = ROOT_DIR) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function resolveLocalSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map(extension => `${base}${extension}`),
    path.join(base, "index.js"),
  ];
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function parseNamedSpecifiers(block) {
  return block
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.split(/\s+as\s+/i)[0].trim())
    .filter(Boolean);
}

function importedNamesFromStatement(statement) {
  const clean = stripComments(statement).trim();
  if (!clean.startsWith("import ")) return [];
  if (/^import\s+["']/.test(clean)) return [];
  if (/^import\s+\*\s+as\s+/.test(clean)) return [];

  const names = [];
  const named = clean.match(/\{([\s\S]*?)\}\s+from\s+["']/);
  if (named) names.push(...parseNamedSpecifiers(named[1]));

  const beforeFrom = clean.slice("import ".length, clean.indexOf(" from ")).trim();
  if (beforeFrom && !beforeFrom.startsWith("{") && !beforeFrom.startsWith("*")) {
    names.push("default");
  }
  return names;
}

function reExportedNamesFromStatement(statement) {
  const clean = stripComments(statement).trim();
  if (!clean.startsWith("export ")) return [];
  if (/^export\s+\*\s+/.test(clean)) return [];

  const named = clean.match(/^export\s+\{([\s\S]*?)\}\s+from\s+["']/);
  if (!named) return [];
  return parseNamedSpecifiers(named[1]);
}

async function buildModuleGraph() {
  await init;

  const files = collectSourceFiles();
  const sourceSet = new Set(files.map(file => path.resolve(file)));
  const modules = new Map();

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    let parsed;
    try {
      parsed = parse(source);
    } catch {
      // Skip CJS or otherwise non-ESM files (e.g. stale *.cjs scripts)
      continue;
    }
    const [imports, exports] = parsed;
    const moduleInfo = {
      file: path.resolve(file),
      dependencies: [],
      exports: new Set(exports.map(entry => entry.n).filter(Boolean)),
      importChecks: [],
      starReExports: [],
      unresolved: [],
    };

    for (const edge of imports) {
      if (!isRelativeSpecifier(edge.n)) continue;

      const statement = source.slice(edge.ss, edge.se);
      const target = resolveLocalSpecifier(file, edge.n);
      if (!target) {
        moduleInfo.unresolved.push(edge.n);
        continue;
      }

      const resolvedTarget = path.resolve(target);
      if (sourceSet.has(resolvedTarget)) {
        moduleInfo.dependencies.push(resolvedTarget);
      }

      if (/^\s*export\s+\*\s+from\s+["']/.test(statement)) {
        moduleInfo.starReExports.push(resolvedTarget);
      }

      moduleInfo.importChecks.push({
        source: edge.n,
        target: resolvedTarget,
        names: [
          ...importedNamesFromStatement(statement),
          ...reExportedNamesFromStatement(statement),
        ],
      });
    }

    modules.set(moduleInfo.file, moduleInfo);
  }

  return modules;
}

function expandedExportsFor(file, modules, seen = new Set(), memo = new Map()) {
  if (memo.has(file)) return memo.get(file);

  const moduleInfo = modules.get(file);
  const exports = new Set(moduleInfo?.exports ?? []);
  if (!moduleInfo || seen.has(file)) return exports;

  seen.add(file);
  for (const target of moduleInfo.starReExports) {
    for (const exportedName of expandedExportsFor(target, modules, seen, memo)) {
      if (exportedName !== "default") exports.add(exportedName);
    }
  }
  seen.delete(file);

  memo.set(file, exports);
  return exports;
}

function findCycles(modules) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(file) {
    if (visiting.has(file)) {
      const cycleStart = stack.indexOf(file);
      cycles.push([...stack.slice(cycleStart), file]);
      return;
    }
    if (visited.has(file)) return;

    visiting.add(file);
    stack.push(file);
    for (const dependency of modules.get(file)?.dependencies ?? []) {
      if (modules.has(dependency)) visit(dependency);
    }
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }

  for (const file of modules.keys()) visit(file);

  const seen = new Set();
  return cycles.filter(cycle => {
    const key = cycle.slice(0, -1).map(toRepoPath).sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

describe("static module graph", () => {
  it("has resolvable relative imports, valid named imports, and no cycles", async () => {
    const modules = await buildModuleGraph();
    const missingPaths = [];
    const missingExports = [];
    const exportMemo = new Map();

    for (const moduleInfo of modules.values()) {
      for (const specifier of moduleInfo.unresolved) {
        missingPaths.push(`${toRepoPath(moduleInfo.file)} -> ${specifier}`);
      }

      for (const check of moduleInfo.importChecks) {
        const targetExports = expandedExportsFor(check.target, modules, new Set(), exportMemo);
        for (const importedName of check.names) {
          if (!targetExports.has(importedName)) {
            missingExports.push(
              `${toRepoPath(moduleInfo.file)} imports ${importedName} from ${toRepoPath(check.target)}`,
            );
          }
        }
      }
    }

    const cycles = findCycles(modules).map(cycle => cycle.map(toRepoPath).join(" -> "));

    expect(missingPaths).toEqual([]);
    expect(missingExports).toEqual([]);
    expect(cycles).toEqual([]);
  });
});
