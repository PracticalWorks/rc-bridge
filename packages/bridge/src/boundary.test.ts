// The package's import boundary, enforced. Every file under src/ — tests
// included — may import only node built-ins, other src/ files and the few
// packages named below. In particular nothing from a deployment's private
// packages, its database driver or its plugin code reaches the public relay.
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const CORE = path.dirname(fileURLToPath(import.meta.url));

/** Third-party packages any core file may import: the connector's runtime deps. */
const RUNTIME_PACKAGES = new Set([
  "@practicalworks/rc-client", // the Rocket.Chat client, this repo's other package
  "unpdf", // attachments.ts, loaded lazily for PDF text
]);
/** …and the ones a test file may import on top of those. */
const TEST_PACKAGES = new Set(["vitest", "typescript"]);

/** Every static, type-only, re-export, dynamic, `import("x").T` and require
 * specifier in one file, with its line. A non-literal dynamic import is
 * reported as `<non-literal>`: what it loads cannot be checked, so it is refused. */
function importsIn(fileName: string, text: string): Array<{ spec: string; line: number }> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: Array<{ spec: string; line: number }> = [];
  const add = (node: ts.Node, spec: ts.Node | undefined) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push({ spec: spec && ts.isStringLiteralLike(spec) ? spec.text : "<non-literal>", line });
  };
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      add(node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Why `spec`, imported from `file`, is not allowed; undefined when it is. */
function violation(file: string, spec: string): string | undefined {
  const isTest = file.endsWith(".test.ts");
  if (spec.startsWith(".")) {
    const resolved = path.resolve(path.dirname(file), spec);
    return resolved === CORE || resolved.startsWith(CORE + path.sep) ? undefined : "resolves outside src/";
  }
  if (spec.startsWith("node:") || builtinModules.includes(spec)) return undefined;
  const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  if (RUNTIME_PACKAGES.has(pkg) || (isTest && TEST_PACKAGES.has(pkg))) return undefined;
  if (pkg.startsWith("@practicalworks/")) return "a factory package";
  if (pkg === "pg") return "the factory's database driver";
  return "not on the core allowlist";
}

function coreFiles(dir = CORE): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return coreFiles(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

describe("the core import boundary", () => {
  it("core imports only node, other core files and its declared packages", () => {
    const found: string[] = [];
    for (const file of coreFiles()) {
      for (const { spec, line } of importsIn(file, readFileSync(file, "utf8"))) {
        const why = violation(file, spec);
        if (why) found.push(`${path.relative(CORE, file)}:${line} imports "${spec}" — ${why}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("sees every form of import, so a clean run means something", () => {
    const probe = path.join(CORE, "probe.ts");
    const kinds = [
      'import { a } from "@practicalworks/some-private-package";',
      'import type { B } from "pg";',
      'export { c } from "../plugins/voice.js";',
      "const d = await import(\"../server.js\");",
      "type E = import(\"@practicalworks/another-private-package\").X;",
      "const f = await import(name);",
      'import "./turn.js";',
    ];
    const specs = kinds.map((line) => {
      const [first] = importsIn(probe, line);
      return first ? violation(probe, first.spec) : "missed";
    });
    expect(specs).toEqual([
      "a factory package",
      "the factory's database driver",
      "resolves outside src/",
      "resolves outside src/",
      "a factory package",
      "not on the core allowlist",
      undefined,
    ]);
  });
});

