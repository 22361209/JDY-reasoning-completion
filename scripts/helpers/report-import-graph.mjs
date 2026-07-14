import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPORT_TYPES = "frontend/src/modules/reports/reportTypes.ts";
const REPORT_REGISTRY = "frontend/src/modules/reports/reportRegistry.ts";
const DOMAIN_CONFIGS = [
  "frontend/src/modules/reports/inventoryMovementReport.ts",
  "frontend/src/modules/reports/salesReports.ts",
  "frontend/src/modules/reports/financeReports.ts",
  "frontend/src/modules/reports/materialScrapReport.ts"
];
const REPORT_TYPE_CONSUMERS = [
  REPORT_REGISTRY,
  ...DOMAIN_CONFIGS,
  "frontend/src/components/report/useReportQuery.ts",
  "frontend/src/components/report/ReportQueryPage.vue"
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isIdentifierStart(character) {
  return /[A-Za-z_$]/.test(character ?? "");
}

function isIdentifierPart(character) {
  return /[A-Za-z0-9_$]/.test(character ?? "");
}

function canStartRegex(tokens, tokenFloor) {
  if (tokens.length <= tokenFloor) return true;
  const previous = tokens.at(-1);
  if (previous?.kind === "punctuator") {
    return new Set(["(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">"]).has(previous.value);
  }
  return previous?.kind === "identifier"
    && new Set(["return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await", "else", "do"]).has(previous.value);
}

function tokenize(source) {
  const tokens = [];
  function scanTemplate(index) {
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
        continue;
      }
      if (source[index] === "`") return index + 1;
      if (source[index] === "$" && source[index + 1] === "{") {
        index = scanCode(index + 2, true, tokens.length);
        continue;
      }
      index += 1;
    }
    return index;
  }

  function scanCode(start, stopAtTemplateBrace, tokenFloor) {
    let index = start;
    let braceDepth = 0;
    while (index < source.length) {
      const character = source[index];
      const next = source[index + 1];
      if (stopAtTemplateBrace && character === "}" && braceDepth === 0) return index + 1;
      if (/\s/.test(character)) {
        index += 1;
        continue;
      }
      if (character === "/" && next === "/") {
        index += 2;
        while (index < source.length && source[index] !== "\n") index += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        index += 2;
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
        index = Math.min(source.length, index + 2);
        continue;
      }
      if (character === "/" && canStartRegex(tokens, tokenFloor)) {
        let inCharacterClass = false;
        index += 1;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
            continue;
          }
          if (source[index] === "[") inCharacterClass = true;
          if (source[index] === "]") inCharacterClass = false;
          if (source[index] === "/" && !inCharacterClass) {
            index += 1;
            while (/[A-Za-z]/.test(source[index] ?? "")) index += 1;
            break;
          }
          index += 1;
        }
        tokens.push({ kind: "regex", value: "regex" });
        continue;
      }
      if (character === "\"" || character === "'") {
        const quote = character;
        let value = "";
        index += 1;
        while (index < source.length) {
          if (source[index] === "\\") {
            if (index + 1 < source.length) value += source[index + 1];
            index += 2;
            continue;
          }
          if (source[index] === quote) {
            index += 1;
            break;
          }
          value += source[index];
          index += 1;
        }
        tokens.push({ kind: "string", value });
        continue;
      }
      if (character === "`") {
        index = scanTemplate(index + 1);
        continue;
      }
      if (isIdentifierStart(character)) {
        const identifierStart = index;
        index += 1;
        while (index < source.length && isIdentifierPart(source[index])) index += 1;
        tokens.push({ kind: "identifier", value: source.slice(identifierStart, index) });
        continue;
      }
      if (character === "{") braceDepth += 1;
      if (character === "}" && braceDepth > 0) braceDepth -= 1;
      tokens.push({ kind: "punctuator", value: character });
      index += 1;
    }
    return index;
  }

  scanCode(0, false, 0);
  return tokens;
}

function scriptSource(source, relativePath) {
  if (!relativePath.endsWith(".vue")) return source;
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join("\n");
}

export function importDeclarations(source, relativePath = "module.ts") {
  const tokens = tokenize(scriptSource(source, relativePath));
  const declarations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    if (token.kind === "identifier" && token.value === "require" && previous?.value !== ".") {
      if (tokens[index + 1]?.value === "(") {
        declarations.push({
          kind: "require",
          typeOnly: false,
          source: tokens[index + 2]?.kind === "string" ? tokens[index + 2].value : null
        });
      }
      continue;
    }
    if (token.kind === "identifier" && token.value === "export") {
      const typeOnly = tokens[index + 1]?.kind === "identifier" && tokens[index + 1].value === "type";
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const current = tokens[cursor];
        if (current.value === ";") break;
        if (current.kind === "identifier" && current.value === "from") {
          const sourceToken = tokens[cursor + 1];
          declarations.push({
            kind: "re-export",
            typeOnly,
            source: sourceToken?.kind === "string" ? sourceToken.value : null
          });
          break;
        }
      }
      continue;
    }
    if (token.kind !== "identifier" || token.value !== "import" || previous?.value === ".") continue;
    const first = tokens[index + 1];
    if (first?.value === "(") {
      declarations.push({
        kind: "dynamic",
        typeOnly: false,
        source: tokens[index + 2]?.kind === "string" ? tokens[index + 2].value : null
      });
      continue;
    }
    if (first?.kind === "string") {
      declarations.push({ kind: "side-effect", typeOnly: false, source: first.value });
      continue;
    }
    const typeOnly = first?.kind === "identifier" && first.value === "type";
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const current = tokens[cursor];
      if (current.value === ";") break;
      if (current.kind === "identifier" && current.value === "from") {
        const sourceToken = tokens[cursor + 1];
        declarations.push({
          kind: "static",
          typeOnly,
          source: sourceToken?.kind === "string" ? sourceToken.value : null
        });
        break;
      }
      if (current.value === "=" && tokens[cursor + 1]?.value === "require") {
        declarations.push({
          kind: "import-equals",
          typeOnly: false,
          source: tokens[cursor + 3]?.kind === "string" ? tokens[cursor + 3].value : null
        });
        break;
      }
    }
  }
  return declarations;
}

export function hasFunctionCall(source, functionName, relativePath = "module.ts") {
  const tokens = tokenize(scriptSource(source, relativePath));
  return tokens.some((token, index) => (
    token.kind === "identifier"
    && token.value === functionName
    && tokens[index + 1]?.value === "("
    && tokens[index - 1]?.value !== "function"
    && tokens[index - 1]?.value !== "."
  ));
}

function moduleName(source) {
  if (!source) return null;
  const clean = source.split(/[?#]/, 1)[0].replace(/\.(?:[cm]?[jt]sx?|vue)$/i, "");
  return clean.split("/").at(-1);
}

function readModule(rootDir, relativePath) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

export function assertReportImportGraph(rootDir, { allowMissing = false } = {}) {
  const absoluteReportTypes = path.join(rootDir, REPORT_TYPES);
  if (!existsSync(absoluteReportTypes)) {
    invariant(allowMissing, `${REPORT_TYPES} 不存在，无法验收 report import graph`);
    return { checked: false, checkedPaths: [], domainConfigs: [] };
  }

  const reportTypeEdges = importDeclarations(readModule(rootDir, REPORT_TYPES), REPORT_TYPES);
  invariant(reportTypeEdges.length === 0, "reportTypes.ts 必须为零 import，包含 side-effect/dynamic/require 也不允许");

  const checkedPaths = [REPORT_TYPES];
  const existingConsumers = REPORT_TYPE_CONSUMERS.filter((relativePath) => existsSync(path.join(rootDir, relativePath)));
  for (const consumerPath of existingConsumers) {
    const edges = importDeclarations(readModule(rootDir, consumerPath), consumerPath);
    invariant(
      edges.every((edge) => !["dynamic", "require", "import-equals", "re-export"].includes(edge.kind)),
      `${consumerPath} 必须使用可静态审计的 ESM import`
    );
    const reportTypeImports = edges.filter((edge) => moduleName(edge.source) === "reportTypes");
    invariant(reportTypeImports.length > 0, `${consumerPath} 必须从 reportTypes 单向导入共享类型`);
    invariant(
      reportTypeImports.every((edge) => edge.kind === "static" && edge.typeOnly),
      `${consumerPath} 只能使用 import type ... from reportTypes`
    );
    checkedPaths.push(consumerPath);
  }

  const existingDomainConfigs = DOMAIN_CONFIGS.filter((relativePath) => existsSync(path.join(rootDir, relativePath)));
  for (const domainPath of existingDomainConfigs) {
    const edges = importDeclarations(readModule(rootDir, domainPath), domainPath);
    invariant(
      edges.every((edge) => moduleName(edge.source) !== "reportRegistry"),
      `${domainPath} 不得反向 import reportRegistry`
    );
  }

  if (existsSync(path.join(rootDir, REPORT_REGISTRY))) {
    const registryEdges = importDeclarations(readModule(rootDir, REPORT_REGISTRY), REPORT_REGISTRY);
    for (const domainPath of existingDomainConfigs) {
      const expectedName = moduleName(domainPath);
      invariant(
        registryEdges.some((edge) => edge.kind === "static" && !edge.typeOnly && moduleName(edge.source) === expectedName),
        `${REPORT_REGISTRY} 必须 runtime import ${domainPath}`
      );
    }
  } else {
    invariant(allowMissing, `${REPORT_REGISTRY} 不存在，无法验收 registry 汇总方向`);
  }

  return { checked: true, checkedPaths: [...new Set(checkedPaths)], domainConfigs: existingDomainConfigs };
}
