import { readFileSync } from "node:fs";
import ts from "../frontend/node_modules/typescript/lib/typescript.js";

const REPORT_OWNER_SPECS = Object.freeze([
  Object.freeze({
    moduleName: "financeReports",
    importName: "financeReportDefinitions",
    exportName: "financeReportDefinitions",
    rootShape: "array",
    typeImports: Object.freeze(["ReportDefinition", "ReportFilterDefinition"])
  }),
  Object.freeze({
    moduleName: "inventoryMovementReport",
    importName: "inventoryMovementReport",
    exportName: "inventoryMovementReport",
    rootShape: "object",
    typeImports: Object.freeze(["ReportDefinition"])
  }),
  Object.freeze({
    moduleName: "materialScrapReport",
    importName: "materialScrapReport",
    exportName: "materialScrapReport",
    rootShape: "object",
    typeImports: Object.freeze(["ReportDefinition"])
  }),
  Object.freeze({
    moduleName: "salesReports",
    importName: "salesReportDefinitions",
    exportName: "salesReportDefinitions",
    rootShape: "array",
    typeImports: Object.freeze(["ReportDefinition", "ReportSourceDrillDefinition"])
  })
]);
const REPORT_OWNER_BY_MODULE = new Map(REPORT_OWNER_SPECS.map((spec) => [spec.moduleName, spec]));
const DEFINITIONS_ASSEMBLY = Object.freeze([
  Object.freeze({ importName: "inventoryMovementReport", spread: false }),
  Object.freeze({ importName: "salesReportDefinitions", spread: true }),
  Object.freeze({ importName: "financeReportDefinitions", spread: true }),
  Object.freeze({ importName: "materialScrapReport", spread: false })
]);

function parseTypeScript(fileName, source) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sourceFile.parseDiagnostics.length > 0) {
    const detail = sourceFile.parseDiagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
      .join(" | ");
    throw new Error(fileName + " TypeScript AST 解析失败: " + detail);
  }
  return sourceFile;
}

function locationOf(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return String(position.line + 1) + ":" + String(position.character + 1);
}

function rejectNode(sourceFile, node, label, reason) {
  throw new Error(label + " " + reason + " (" + locationOf(sourceFile, node) + ")");
}

function unwrapDataExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isConstDeclarationList(declarationList) {
  return (declarationList.flags & ts.NodeFlags.Const) !== 0;
}

function modifierKinds(node) {
  return (node.modifiers ?? []).map((modifier) => modifier.kind);
}

function hasExactModifiers(node, expected) {
  const actual = modifierKinds(node);
  return actual.length === expected.length && actual.every((kind, index) => kind === expected[index]);
}

function exactIdentifier(node, name) {
  return ts.isIdentifier(node) && node.text === name;
}

function exactPropertyAccess(expression, receiverName, propertyName) {
  const current = expression;
  return ts.isPropertyAccessExpression(current)
    && !current.questionDotToken
    && exactIdentifier(current.expression, receiverName)
    && current.name.text === propertyName;
}

function exactCall(expression, receiverName, propertyName, argumentCount) {
  return ts.isCallExpression(expression)
    && !expression.questionDotToken
    && (expression.typeArguments?.length ?? 0) === 0
    && exactPropertyAccess(expression.expression, receiverName, propertyName)
    && expression.arguments.length === argumentCount;
}

function staticPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function nodeReferencesBinding(node, bindingNames) {
  let found = false;
  function visit(current) {
    if (found) return;
    if (ts.isIdentifier(current) && bindingNames.has(current.text)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function isAssignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function assertNoProtectedMutationTargets(sourceFile, bindingNames, label) {
  function visit(node) {
    if (ts.isBinaryExpression(node)
      && isAssignmentOperator(node.operatorToken.kind)
      && nodeReferencesBinding(node.left, bindingNames)) {
      rejectNode(sourceFile, node, label, "不得 assignment 受保护 binding");
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && nodeReferencesBinding(node.operand, bindingNames)) {
      rejectNode(sourceFile, node, label, "不得 update 受保护 binding");
    }
    if (ts.isDeleteExpression(node) && nodeReferencesBinding(node.expression, bindingNames)) {
      rejectNode(sourceFile, node, label, "不得 delete 受保护 binding");
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
      && nodeReferencesBinding(node.initializer, bindingNames)) {
      rejectNode(sourceFile, node, label, "不得将受保护 binding 用作 for-in/of LHS");
    }
    if (ts.isBindingElement(node) && node.initializer) {
      rejectNode(sourceFile, node, label, "不得使用 BindingElement default");
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function assertNoDynamicImport(sourceFile, label) {
  function visit(node) {
    if ((ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      || ts.isImportTypeNode(node)) {
      rejectNode(sourceFile, node, label, "不得使用 dynamic/import type expression");
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function assertExactNamedImport(sourceFile, statement, options) {
  const {
    moduleName,
    names,
    typeOnly,
    label
  } = options;
  if (!ts.isImportDeclaration(statement)
    || !ts.isStringLiteral(statement.moduleSpecifier)
    || statement.moduleSpecifier.text !== moduleName
    || statement.attributes
    || statement.assertClause) {
    rejectNode(sourceFile, statement, label, "import module 必须精确为 " + moduleName);
  }
  const clause = statement.importClause;
  if (!clause
    || Boolean(clause.isTypeOnly) !== typeOnly
    || clause.name
    || !clause.namedBindings
    || !ts.isNamedImports(clause.namedBindings)
    || clause.namedBindings.elements.length !== names.length) {
    rejectNode(sourceFile, statement, label, "只允许精确 named " + (typeOnly ? "type " : "") + "import");
  }
  clause.namedBindings.elements.forEach((element, index) => {
    if (element.propertyName
      || element.isTypeOnly
      || element.name.text !== names[index]) {
      rejectNode(sourceFile, element, label, "import binding 必须精确为 " + names[index]);
    }
  });
}

function exactVariableStatement(sourceFile, statement, options) {
  const {
    name,
    exported,
    label
  } = options;
  const expectedModifiers = exported ? [ts.SyntaxKind.ExportKeyword] : [];
  if (!ts.isVariableStatement(statement)
    || !hasExactModifiers(statement, expectedModifiers)
    || !isConstDeclarationList(statement.declarationList)
    || statement.declarationList.declarations.length !== 1) {
    rejectNode(sourceFile, statement, label, "必须为唯一 " + (exported ? "export " : "") + "const " + name);
  }
  const declaration = statement.declarationList.declarations[0];
  if (!exactIdentifier(declaration.name, name)
    || !declaration.initializer
    || declaration.exclamationToken) {
    rejectNode(sourceFile, declaration, label, "const declaration 必须精确声明 " + name + " initializer");
  }
  return declaration;
}

function assertExactDefinitionsAssembly(sourceFile, declaration) {
  if (declaration.type?.getText(sourceFile) !== "readonly ReportDefinition[]") {
    rejectNode(sourceFile, declaration, "reportRegistry", "definitions type 必须精确为 readonly ReportDefinition[]");
  }
  const initializer = declaration.initializer;
  if (!ts.isArrayLiteralExpression(initializer)
    || initializer.elements.length !== DEFINITIONS_ASSEMBLY.length) {
    rejectNode(sourceFile, initializer, "reportRegistry", "definitions 必须精确装配四个 owner");
  }
  initializer.elements.forEach((element, index) => {
    const expected = DEFINITIONS_ASSEMBLY[index];
    if (expected.spread) {
      if (!ts.isSpreadElement(element) || !exactIdentifier(element.expression, expected.importName)) {
        rejectNode(sourceFile, element, "reportRegistry", "definitions spread 顺序或 binding 不合法");
      }
    } else if (!exactIdentifier(element, expected.importName)) {
      rejectNode(sourceFile, element, "reportRegistry", "definitions direct 顺序或 binding 不合法");
    }
  });
}

function assertExactRegistryDeclaration(sourceFile, declaration) {
  const initializer = declaration.initializer;
  if (!ts.isNewExpression(initializer)
    || !exactIdentifier(initializer.expression, "Map")
    || (initializer.arguments?.length ?? 0) !== 0
    || (initializer.typeArguments?.length ?? 0) !== 2
    || initializer.typeArguments[0].getText(sourceFile) !== "string"
    || initializer.typeArguments[1].getText(sourceFile) !== "ReportDefinition") {
    rejectNode(sourceFile, initializer, "reportRegistry", "registry 必须精确为 new Map<string, ReportDefinition>()");
  }
}

function exactDefinitionEntryId(expression) {
  return exactPropertyAccess(expression, "definition", "entryId");
}

function assertExactDuplicateGuard(sourceFile, statement) {
  if (!ts.isIfStatement(statement)
    || statement.elseStatement
    || !exactCall(statement.expression, "registry", "has", 1)
    || !exactDefinitionEntryId(statement.expression.arguments[0])
    || !ts.isBlock(statement.thenStatement)
    || statement.thenStatement.statements.length !== 1) {
    rejectNode(sourceFile, statement, "reportRegistry", "duplicate guard 必须精确为 registry.has(definition.entryId)");
  }
  const thrown = statement.thenStatement.statements[0];
  if (!ts.isThrowStatement(thrown)
    || !thrown.expression
    || !ts.isNewExpression(thrown.expression)
    || !exactIdentifier(thrown.expression.expression, "Error")
    || (thrown.expression.typeArguments?.length ?? 0) !== 0
    || (thrown.expression.arguments?.length ?? 0) !== 1) {
    rejectNode(sourceFile, thrown, "reportRegistry", "duplicate guard 必须精确 throw new Error");
  }
  const message = thrown.expression.arguments[0];
  if (!ts.isTemplateExpression(message)
    || message.head.text !== "duplicate report entry id: "
    || message.templateSpans.length !== 1
    || !exactDefinitionEntryId(message.templateSpans[0].expression)
    || message.templateSpans[0].literal.text !== "") {
    rejectNode(sourceFile, message, "reportRegistry", "duplicate error message 必须只插值 definition.entryId");
  }
}

function assertExactRegistrySet(sourceFile, statement) {
  if (!ts.isExpressionStatement(statement)
    || !exactCall(statement.expression, "registry", "set", 2)
    || !exactDefinitionEntryId(statement.expression.arguments[0])
    || !exactIdentifier(statement.expression.arguments[1], "definition")) {
    rejectNode(sourceFile, statement, "reportRegistry", "装配必须无条件精确调用 registry.set");
  }
}

function assertExactAssemblyLoop(sourceFile, statement) {
  if (!ts.isForOfStatement(statement)
    || statement.awaitModifier
    || !ts.isVariableDeclarationList(statement.initializer)
    || !isConstDeclarationList(statement.initializer)
    || statement.initializer.declarations.length !== 1
    || !exactIdentifier(statement.initializer.declarations[0].name, "definition")
    || statement.initializer.declarations[0].initializer
    || !exactIdentifier(statement.expression, "definitions")
    || !ts.isBlock(statement.statement)
    || statement.statement.statements.length !== 2) {
    rejectNode(sourceFile, statement, "reportRegistry", "必须精确无条件执行 const definition of definitions loop");
  }
  assertExactDuplicateGuard(sourceFile, statement.statement.statements[0]);
  assertExactRegistrySet(sourceFile, statement.statement.statements[1]);
}

function assertExactFunctionShell(sourceFile, statement, name, parameterType, returnType) {
  if (!ts.isFunctionDeclaration(statement)
    || !hasExactModifiers(statement, [ts.SyntaxKind.ExportKeyword])
    || !statement.name
    || statement.name.text !== name
    || statement.asteriskToken
    || statement.questionToken
    || (statement.typeParameters?.length ?? 0) !== 0
    || statement.parameters.length !== 1
    || !exactIdentifier(statement.parameters[0].name, "entryId")
    || statement.parameters[0].dotDotDotToken
    || statement.parameters[0].questionToken
    || statement.parameters[0].initializer
    || statement.parameters[0].type?.getText(sourceFile) !== parameterType
    || statement.type?.getText(sourceFile) !== returnType
    || !statement.body
    || statement.body.statements.length !== 1
    || !ts.isReturnStatement(statement.body.statements[0])
    || !statement.body.statements[0].expression) {
    rejectNode(sourceFile, statement, "reportRegistry", name + " 必须保持精确 lookup function 形状");
  }
  return statement.body.statements[0].expression;
}

function assertExactLookupFunctions(sourceFile, definitionLookup, registrationLookup) {
  const definitionReturn = assertExactFunctionShell(
    sourceFile,
    definitionLookup,
    "reportDefinitionForEntryId",
    "string",
    "ReportDefinition | null"
  );
  if (!ts.isBinaryExpression(definitionReturn)
    || definitionReturn.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
    || !exactCall(definitionReturn.left, "registry", "get", 1)
    || !exactIdentifier(definitionReturn.left.arguments[0], "entryId")
    || definitionReturn.right.kind !== ts.SyntaxKind.NullKeyword) {
    rejectNode(sourceFile, definitionReturn, "reportRegistry", "reportDefinitionForEntryId 必须精确返回 registry.get(entryId) ?? null");
  }

  const registrationReturn = assertExactFunctionShell(
    sourceFile,
    registrationLookup,
    "isRegisteredReportEntry",
    "string",
    "boolean"
  );
  if (!exactCall(registrationReturn, "registry", "has", 1)
    || !exactIdentifier(registrationReturn.arguments[0], "entryId")) {
    rejectNode(sourceFile, registrationReturn, "reportRegistry", "isRegisteredReportEntry 必须精确返回 registry.has(entryId)");
  }
}

function assertExactRegisteredIds(sourceFile, declaration) {
  if (declaration.type) {
    rejectNode(sourceFile, declaration, "reportRegistry", "registeredReportEntryIds 不得改写公开类型");
  }
  const freezeCall = declaration.initializer;
  if (!exactCall(freezeCall, "Object", "freeze", 1)) {
    rejectNode(sourceFile, freezeCall, "reportRegistry", "registeredReportEntryIds 必须精确调用 Object.freeze");
  }
  const mapCall = freezeCall.arguments[0];
  if (!exactCall(mapCall, "definitions", "map", 1)) {
    rejectNode(sourceFile, mapCall, "reportRegistry", "registeredReportEntryIds 必须由 definitions.map 派生");
  }
  const callback = mapCall.arguments[0];
  if (!ts.isArrowFunction(callback)
    || !hasExactModifiers(callback, [])
    || (callback.typeParameters?.length ?? 0) !== 0
    || callback.parameters.length !== 1
    || !exactIdentifier(callback.parameters[0].name, "definition")
    || callback.parameters[0].dotDotDotToken
    || callback.parameters[0].questionToken
    || callback.parameters[0].type
    || callback.parameters[0].initializer
    || callback.type
    || !exactDefinitionEntryId(callback.body)) {
    rejectNode(sourceFile, callback, "reportRegistry", "map callback 必须精确为 definition => definition.entryId");
  }
}

function isInsideTypeSyntax(node, sourceFile) {
  let current = node;
  while (current.parent && current.parent !== sourceFile) {
    current = current.parent;
    if (ts.isTypeNode(current) || ts.isTypeAliasDeclaration(current)) return true;
  }
  return false;
}

function isStaticPropertyKeyIdentifier(node) {
  const parent = node.parent;
  return ts.isPropertyAssignment(parent) && parent.name === node;
}

function collectOwnerReportIds(moduleSource, spec) {
  const label = spec.moduleName;
  const sourceFile = parseTypeScript(spec.moduleName + ".ts", moduleSource);
  assertNoDynamicImport(sourceFile, label);

  const expectedImportCount = 1;
  if (sourceFile.statements.length < expectedImportCount + 1) {
    rejectNode(sourceFile, sourceFile, label, "owner module 不能为空");
  }
  assertExactNamedImport(sourceFile, sourceFile.statements[0], {
    moduleName: "./reportTypes",
    names: spec.typeImports,
    typeOnly: true,
    label
  });

  const records = new Map();
  const declarationNameNodes = new Set();
  const typeAliases = [];
  for (let index = 1; index < sourceFile.statements.length; index += 1) {
    const statement = sourceFile.statements[index];
    if (ts.isVariableStatement(statement)) {
      if (!isConstDeclarationList(statement.declarationList)
        || statement.declarationList.declarations.length !== 1
        || !hasExactModifiers(statement, [])) {
        const isRootExport = hasExactModifiers(statement, [ts.SyntaxKind.ExportKeyword]);
        if (!isRootExport) {
          rejectNode(sourceFile, statement, label, "runtime 顶层只允许 non-export const 与唯一 root export const");
        }
      }
      const declarations = statement.declarationList.declarations;
      if (declarations.length !== 1) {
        rejectNode(sourceFile, statement, label, "const statement 必须只有一个 declaration");
      }
      const declaration = declarations[0];
      if (!isConstDeclarationList(statement.declarationList)
        || !ts.isIdentifier(declaration.name)
        || !declaration.initializer
        || declaration.exclamationToken) {
        rejectNode(sourceFile, declaration, label, "const graph 只允许 identifier initializer");
      }
      const name = declaration.name.text;
      const isExported = hasExactModifiers(statement, [ts.SyntaxKind.ExportKeyword]);
      if ((name === spec.exportName) !== isExported) {
        rejectNode(sourceFile, statement, label, "仅 " + spec.exportName + " 可以作为 runtime export");
      }
      if (records.has(name)) {
        rejectNode(sourceFile, declaration, label, "重复 const binding " + name);
      }
      records.set(name, { declaration, statement });
      declarationNameNodes.add(declaration.name);
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement)
      && hasExactModifiers(statement, [ts.SyntaxKind.ExportKeyword])) {
      typeAliases.push(statement);
      continue;
    }
    rejectNode(sourceFile, statement, label, "只允许 type import、const data graph 与 exported type alias");
  }

  const rootRecord = records.get(spec.exportName);
  if (!rootRecord) {
    throw new Error(label + " 缺少唯一 exported const " + spec.exportName);
  }

  const allowedReferenceNodes = new Set();
  const reachableBindings = new Set();
  const activeBindings = new Set();
  const shapeCache = new Map();

  function validateBinding(name, referenceNode) {
    if (referenceNode) allowedReferenceNodes.add(referenceNode);
    const record = records.get(name);
    if (!record) {
      rejectNode(sourceFile, referenceNode ?? sourceFile, label, "data graph 引用了非本地 const binding " + name);
    }
    reachableBindings.add(name);
    if (shapeCache.has(name)) return shapeCache.get(name);
    if (activeBindings.has(name)) {
      rejectNode(sourceFile, record.declaration, label, "data graph 存在循环引用 " + name);
    }
    activeBindings.add(name);
    const shape = validateDataExpression(record.declaration.initializer);
    activeBindings.delete(name);
    shapeCache.set(name, shape);
    return shape;
  }

  function validateDataExpression(expression) {
    const current = unwrapDataExpression(expression);
    if (ts.isStringLiteral(current)
      || ts.isNumericLiteral(current)
      || current.kind === ts.SyntaxKind.TrueKeyword
      || current.kind === ts.SyntaxKind.FalseKeyword
      || current.kind === ts.SyntaxKind.NullKeyword) {
      return "primitive";
    }
    if (ts.isPrefixUnaryExpression(current)
      && (current.operator === ts.SyntaxKind.PlusToken || current.operator === ts.SyntaxKind.MinusToken)
      && ts.isNumericLiteral(current.operand)) {
      return "primitive";
    }
    if (ts.isIdentifier(current)) {
      return validateBinding(current.text, current);
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        if (ts.isOmittedExpression(element)) {
          rejectNode(sourceFile, element, label, "data array 不得包含空槽");
        }
        if (ts.isSpreadElement(element)) {
          if (validateDataExpression(element.expression) !== "array") {
            rejectNode(sourceFile, element, label, "array spread 必须引用 data-only array");
          }
        } else {
          validateDataExpression(element);
        }
      }
      return "array";
    }
    if (ts.isObjectLiteralExpression(current)) {
      const propertyNames = new Set();
      for (const property of current.properties) {
        if (!ts.isPropertyAssignment(property)
          || ts.isComputedPropertyName(property.name)) {
          rejectNode(sourceFile, property, label, "data object 禁止 accessor/method/computed/shorthand/spread");
        }
        const propertyName = staticPropertyName(property.name);
        if (propertyName === null || propertyNames.has(propertyName)) {
          rejectNode(sourceFile, property, label, "data object property 必须静态且唯一");
        }
        propertyNames.add(propertyName);
        validateDataExpression(property.initializer);
      }
      return "object";
    }
    rejectNode(
      sourceFile,
      current,
      label,
      "data graph 禁止 " + ts.SyntaxKind[current.kind] + " runtime expression"
    );
  }

  const rootShape = validateBinding(spec.exportName, null);
  if (rootShape !== spec.rootShape) {
    rejectNode(sourceFile, rootRecord.declaration.initializer, label, "root 必须解析为 " + spec.rootShape);
  }
  const unreachable = [...records.keys()].filter((name) => !reachableBindings.has(name));
  if (unreachable.length > 0) {
    throw new Error(label + " 存在未接入 definition graph 的 runtime const: " + unreachable.join(", "));
  }

  const protectedBindings = new Set(records.keys());
  assertNoProtectedMutationTargets(sourceFile, protectedBindings, label);

  function visitProtectedReferences(node) {
    if (ts.isIdentifier(node)
      && protectedBindings.has(node.text)
      && !declarationNameNodes.has(node)
      && !allowedReferenceNodes.has(node)
      && !isInsideTypeSyntax(node, sourceFile)
      && !isStaticPropertyKeyIdentifier(node)) {
      rejectNode(sourceFile, node, label, "protected binding 只能出现在 data graph 白名单引用位置");
    }
    ts.forEachChild(node, visitProtectedReferences);
  }
  visitProtectedReferences(sourceFile);

  function collectDefinitionIds(expression, expectedShape, stack) {
    const current = unwrapDataExpression(expression);
    if (ts.isIdentifier(current)) {
      if (stack.includes(current.text)) {
        rejectNode(sourceFile, current, label, "definition root 存在循环引用");
      }
      const record = records.get(current.text);
      if (!record) {
        rejectNode(sourceFile, current, label, "definition root 引用未知 binding");
      }
      return collectDefinitionIds(record.declaration.initializer, expectedShape, [...stack, current.text]);
    }
    if (expectedShape === "array") {
      if (!ts.isArrayLiteralExpression(current)) {
        rejectNode(sourceFile, current, label, "definition-array 必须解析为 array literal");
      }
      return current.elements.flatMap((element) => {
        if (ts.isSpreadElement(element)) {
          return collectDefinitionIds(element.expression, "array", stack);
        }
        return collectDefinitionIds(element, "object", stack);
      });
    }
    if (!ts.isObjectLiteralExpression(current)) {
      rejectNode(sourceFile, current, label, "definition direct element 必须解析为 object literal");
    }
    const entryIdProperties = current.properties.filter(
      (property) => ts.isPropertyAssignment(property) && staticPropertyName(property.name) === "entryId"
    );
    if (entryIdProperties.length !== 1 || !ts.isStringLiteral(entryIdProperties[0].initializer)) {
      rejectNode(sourceFile, current, label, "每个 report definition 必须有且仅有一个静态 string entryId");
    }
    return [entryIdProperties[0].initializer.text];
  }

  return collectDefinitionIds(rootRecord.declaration.initializer, spec.rootShape, [spec.exportName]);
}


function collectRegisteredReportIds(registrySource, readModule) {
  const sourceFile = parseTypeScript("reportRegistry.ts", registrySource);
  assertNoDynamicImport(sourceFile, "reportRegistry");
  if (sourceFile.statements.length !== 11) {
    rejectNode(sourceFile, sourceFile, "reportRegistry", "顶层只允许固定 11 条 allowlist statement");
  }

  REPORT_OWNER_SPECS.forEach((spec, index) => {
    assertExactNamedImport(sourceFile, sourceFile.statements[index], {
      moduleName: "./" + spec.moduleName,
      names: [spec.importName],
      typeOnly: false,
      label: "reportRegistry"
    });
  });
  assertExactNamedImport(sourceFile, sourceFile.statements[4], {
    moduleName: "./reportTypes",
    names: ["ReportDefinition"],
    typeOnly: true,
    label: "reportRegistry"
  });

  const definitions = exactVariableStatement(sourceFile, sourceFile.statements[5], {
    name: "definitions",
    exported: false,
    label: "reportRegistry"
  });
  assertExactDefinitionsAssembly(sourceFile, definitions);

  const registry = exactVariableStatement(sourceFile, sourceFile.statements[6], {
    name: "registry",
    exported: false,
    label: "reportRegistry"
  });
  assertExactRegistryDeclaration(sourceFile, registry);
  assertExactAssemblyLoop(sourceFile, sourceFile.statements[7]);
  assertExactLookupFunctions(sourceFile, sourceFile.statements[8], sourceFile.statements[9]);

  const registered = exactVariableStatement(sourceFile, sourceFile.statements[10], {
    name: "registeredReportEntryIds",
    exported: true,
    label: "reportRegistry"
  });
  assertExactRegisteredIds(sourceFile, registered);

  const registryProtectedBindings = new Set([
    "definitions",
    "registry",
    ...REPORT_OWNER_SPECS.map((spec) => spec.importName)
  ]);
  assertNoProtectedMutationTargets(sourceFile, registryProtectedBindings, "reportRegistry");

  const ids = DEFINITIONS_ASSEMBLY.flatMap(({ importName }) => {
    const spec = REPORT_OWNER_SPECS.find((candidate) => candidate.importName === importName);
    if (!spec || REPORT_OWNER_BY_MODULE.get(spec.moduleName) !== spec) {
      throw new Error("reportRegistry owner spec drift: " + importName);
    }
    return collectOwnerReportIds(readModule(spec.moduleName), spec);
  });
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("reportRegistry runtime definition entryId 必须非空且全局唯一");
  }
  return ids;
}

function lines(...values) {
  return values.join("\n") + "\n";
}

const validRegistryFixture = lines(
  'import { financeReportDefinitions } from "./financeReports";',
  'import { inventoryMovementReport } from "./inventoryMovementReport";',
  'import { materialScrapReport } from "./materialScrapReport";',
  'import { salesReportDefinitions } from "./salesReports";',
  'import type { ReportDefinition } from "./reportTypes";',
  "const definitions: readonly ReportDefinition[] = [",
  "  inventoryMovementReport,",
  "  ...salesReportDefinitions,",
  "  ...financeReportDefinitions,",
  "  materialScrapReport",
  "];",
  "const registry = new Map<string, ReportDefinition>();",
  "for (const definition of definitions) {",
  "  if (registry.has(definition.entryId)) {",
  "    throw new Error(" + String.fromCharCode(96) + "duplicate report entry id: $" + "{definition.entryId}" + String.fromCharCode(96) + ");",
  "  }",
  "  registry.set(definition.entryId, definition);",
  "}",
  "export function reportDefinitionForEntryId(entryId: string): ReportDefinition | null {",
  "  return registry.get(entryId) ?? null;",
  "}",
  "export function isRegisteredReportEntry(entryId: string): boolean {",
  "  return registry.has(entryId);",
  "}",
  "export const registeredReportEntryIds = Object.freeze(definitions.map((definition) => definition.entryId));"
);

const validOwnerFixtures = Object.freeze({
  financeReports: lines(
    'import type { ReportDefinition, ReportFilterDefinition } from "./reportTypes";',
    'const currencyFilter: ReportFilterDefinition = { parameter: "currency", label: "Currency" };',
    'export const financeReportDefinitions = [{ entryId: "finance", filters: [currencyFilter] }] as const satisfies readonly ReportDefinition[];',
    "export type FinanceFixture = (typeof financeReportDefinitions)[number];"
  ),
  inventoryMovementReport: lines(
    'import type { ReportDefinition } from "./reportTypes";',
    'export const inventoryMovementReport: ReportDefinition = { entryId: "inventory" };'
  ),
  materialScrapReport: lines(
    'import type { ReportDefinition } from "./reportTypes";',
    'export const materialScrapReport: ReportDefinition = { entryId: "material" };'
  ),
  salesReports: lines(
    'import type { ReportDefinition, ReportSourceDrillDefinition } from "./reportTypes";',
    'const drill: ReportSourceDrillDefinition = { targetField: "target" };',
    'export const salesReportDefinitions: readonly ReportDefinition[] = [{ entryId: "sales", drill: drill }];'
  )
});

function readFixtureOwner(moduleName, overrides = {}) {
  const source = overrides[moduleName] ?? validOwnerFixtures[moduleName];
  if (!source) throw new Error("missing fixture owner " + moduleName);
  return source;
}

const registryParserSelfTest = collectRegisteredReportIds(
  validRegistryFixture,
  (moduleName) => readFixtureOwner(moduleName)
);
if (JSON.stringify(registryParserSelfTest) !== JSON.stringify(["inventory", "sales", "finance", "material"])) {
  throw new Error("reportRegistry allowlist 正例必须精确提取四个 owner entryId");
}

function assertRegistryParserRejects(label, options = {}) {
  let rejected = false;
  try {
    collectRegisteredReportIds(
      options.registrySource ?? validRegistryFixture,
      (moduleName) => readFixtureOwner(moduleName, options.ownerOverrides)
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("reportRegistry allowlist 必须拒绝 " + label);
}

function financeOwner(body, extras = []) {
  return lines(
    'import type { ReportDefinition, ReportFilterDefinition } from "./reportTypes";',
    body,
    ...extras
  );
}

for (const [label, source] of [
  [
    "NonNull mutation",
    validOwnerFixtures.financeReports + 'financeReportDefinitions![0].entryId = "changed";\n'
  ],
  [
    "conditional mutation",
    validOwnerFixtures.financeReports + '(true ? financeReportDefinitions : [])[0].entryId = "changed";\n'
  ],
  [
    "comma mutation",
    validOwnerFixtures.financeReports + '(0, financeReportDefinitions)[0].entryId = "changed";\n'
  ],
  [
    "logical mutation",
    validOwnerFixtures.financeReports + '(financeReportDefinitions || [])[0].entryId = "changed";\n'
  ],
  [
    "await mutation",
    validOwnerFixtures.financeReports + 'await (financeReportDefinitions[0].entryId = "changed");\n'
  ],
  [
    "update mutation",
    validOwnerFixtures.financeReports + "financeReportDefinitions[0].width++;\n"
  ],
  [
    "delete mutation",
    validOwnerFixtures.financeReports + "delete financeReportDefinitions[0].entryId;\n"
  ],
  [
    "for-in protected target",
    validOwnerFixtures.financeReports + "for (financeReportDefinitions[0] in {}) {}\n"
  ],
  [
    "for-of protected target",
    validOwnerFixtures.financeReports + "for (financeReportDefinitions[0] of []) {}\n"
  ],
  [
    "BindingElement default",
    validOwnerFixtures.financeReports + "const [escaped = financeReportDefinitions] = [];\n"
  ],
  [
    "tagged template",
    financeOwner('export const financeReportDefinitions = [{ entryId: "finance", note: tag' + String.fromCharCode(96) + "x" + String.fromCharCode(96) + " }];")
  ],
  [
    "template expression",
    financeOwner(
      'const suffix = "x";',
      [
        "export const financeReportDefinitions = [{ entryId: "
          + String.fromCharCode(96)
          + "finance-$"
          + "{suffix}"
          + String.fromCharCode(96)
          + " }];"
      ]
    )
  ],
  [
    "no-substitution template",
    financeOwner(
      "export const financeReportDefinitions = [{ entryId: "
        + String.fromCharCode(96)
        + "finance"
        + String.fromCharCode(96)
        + " }];"
    )
  ],
  [
    "getter",
    financeOwner('export const financeReportDefinitions = [{ get entryId() { return "finance"; } }];')
  ],
  [
    "method",
    financeOwner('export const financeReportDefinitions = [{ entryId() { return "finance"; } }];')
  ],
  [
    "bare protected read",
    validOwnerFixtures.financeReports + "financeReportDefinitions;\n"
  ],
  [
    "binary coercion",
    financeOwner('export const financeReportDefinitions = [{ entryId: "finance", width: "1" + 1 }];')
  ],
  [
    "new expression",
    financeOwner('export const financeReportDefinitions = [{ entryId: "finance", value: new Date() }];')
  ],
  [
    "call expression",
    financeOwner('export const financeReportDefinitions = [{ entryId: String("finance") }];')
  ],
  [
    "arrow function expression",
    financeOwner('export const financeReportDefinitions = [{ entryId: "finance", value: () => "escape" }];')
  ],
  [
    "class expression",
    financeOwner('export const financeReportDefinitions = [{ entryId: "finance", value: class Escape {} }];')
  ],
  [
    "await data expression",
    financeOwner('export const financeReportDefinitions = [{ entryId: "finance", value: await Promise.resolve(1) }];')
  ],
  [
    "conditional data expression",
    financeOwner('export const financeReportDefinitions = true ? [{ entryId: "finance" }] : [];')
  ],
  [
    "comma data expression",
    financeOwner('export const financeReportDefinitions = (0, [{ entryId: "finance" }]);')
  ],
  [
    "logical data expression",
    financeOwner('export const financeReportDefinitions = [] || [{ entryId: "finance" }];')
  ],
  [
    "logical and data expression",
    financeOwner('export const financeReportDefinitions = true && [{ entryId: "finance" }];')
  ],
  [
    "nullish data expression",
    financeOwner('export const financeReportDefinitions = [] ?? [{ entryId: "finance" }];')
  ],
  [
    "extra runtime export",
    validOwnerFixtures.financeReports + "export const escaped = financeReportDefinitions;\n"
  ],
  [
    "extra function",
    validOwnerFixtures.financeReports + "function escape() { return financeReportDefinitions; }\n"
  ],
  [
    "extra class",
    validOwnerFixtures.financeReports + "class Escape { value = financeReportDefinitions; }\n"
  ],
  [
    "side-effect import",
    'import "./evil";\n' + validOwnerFixtures.financeReports
  ],
  [
    "default import",
    'import Evil from "./evil";\n' + validOwnerFixtures.financeReports
  ],
  [
    "namespace import",
    'import * as Evil from "./evil";\n' + validOwnerFixtures.financeReports
  ],
  [
    "dynamic import",
    financeOwner('export const financeReportDefinitions = [{ entryId: "finance", value: import("./evil") }];')
  ],
  [
    "unreachable runtime const",
    validOwnerFixtures.financeReports + 'const decoy = { entryId: "decoy" };\n'
  ],
  [
    "non-null data root",
    financeOwner(
      'const inner = [{ entryId: "finance" }];',
      ["export const financeReportDefinitions = inner!;"]
    )
  ]
]) {
  assertRegistryParserRejects(label, {
    ownerOverrides: { financeReports: source }
  });
}

for (const [label, registrySource] of [
  ["registry side-effect import", 'import "./evil";\n' + validRegistryFixture],
  ["registry default import", 'import Evil from "./evil";\n' + validRegistryFixture],
  ["registry namespace import", 'import * as Evil from "./evil";\n' + validRegistryFixture],
  ["registry dynamic import", validRegistryFixture + 'void import("./evil");\n'],
  [
    "unassembled runtime import",
    validRegistryFixture.replace(
      'import { financeReportDefinitions } from "./financeReports";',
      'import { financeReportDefinitions, hiddenDefinitions } from "./financeReports";'
    )
  ],
  ["registry extra function", validRegistryFixture + "function escape() { return registry; }\n"],
  ["registry class escape", validRegistryFixture + "class Escape { value = registry; }\n"],
  ["registry bare read", validRegistryFixture + "definitions;\n"],
  [
    "conditional registry.set",
    validRegistryFixture.replace(
      "  registry.set(definition.entryId, definition);",
      "  if (true) registry.set(definition.entryId, definition);"
    )
  ],
  [
    "async registered ids callback",
    validRegistryFixture.replace(
      "definitions.map((definition) => definition.entryId)",
      "definitions.map(async (definition) => definition.entryId)"
    )
  ],
  [
    "registry NonNull mutation",
    validRegistryFixture + 'definitions![0].entryId = "changed";\n'
  ],
  [
    "registry for-of LHS",
    validRegistryFixture + "for (definitions[0] of []) {}\n"
  ]
]) {
  assertRegistryParserRejects(label, { registrySource });
}

const source = readFileSync("frontend/src/modules/metadata/bills/sales.ts", "utf8");
const fragments = readFileSync("frontend/src/modules/metadata/fragments.ts", "utf8");
const entryTable = [
  "frontend/src/components/EntryTable.vue",
  "frontend/src/components/entry-table/types.ts",
  "frontend/src/components/entry-table/useEntryTableColumns.ts",
  "frontend/src/components/entry-table/useEntryTableCalculations.ts",
  "frontend/src/components/entry-table/useEntryTableTestIds.ts"
].map((path) => readFileSync(path, "utf8")).join("\n");
const dataListPageComponent = readFileSync("frontend/src/components/DataListPage.vue", "utf8");
const dataListPage = [
  dataListPageComponent,
  "frontend/src/components/list/useDataListDefinition.ts",
  "frontend/src/components/list/useDataListColumnPreferences.ts",
  "frontend/src/components/list/useDataListSelection.ts",
  "frontend/src/components/list/useDataListSummary.ts"
].map((sourceOrPath) => sourceOrPath.includes("\n") ? sourceOrPath : readFileSync(sourceOrPath, "utf8")).join("\n");
const baseStyles = readFileSync("frontend/src/styles/base.css", "utf8");
const documentModule = readFileSync("frontend/src/modules/documents/useDocumentModule.ts", "utf8");
const salesOutDocument = readFileSync("frontend/src/modules/sales/sales-out/useSalesOutDocument.ts", "utf8");
const documentApi = readFileSync("frontend/src/services/documentApi.ts", "utf8");
const taxAmountsApp = readFileSync("frontend/src/app/taxAmounts.ts", "utf8");
const masterDataRegistry = readFileSync("frontend/src/modules/master-data/registry.ts", "utf8");
const fieldTypes = readFileSync("frontend/src/components/fields/types.ts", "utf8");
const fieldRenderer = readFileSync("frontend/src/components/fields/FieldRenderer.vue", "utf8");
const documentForm = readFileSync("frontend/src/components/DocumentForm.vue", "utf8");
const standardDocument = readFileSync("frontend/src/components/StandardDocument.vue", "utf8");
const documentActionRules = readFileSync("frontend/src/components/actions/documentActionRules.ts", "utf8");
const masterDataTypes = readFileSync("frontend/src/modules/master-data/types.ts", "utf8");
const masterDataRecordPage = readFileSync("frontend/src/modules/master-data/MasterDataRecordPage.vue", "utf8");
const masterDataFormDialog = readFileSync("frontend/src/modules/master-data/MasterDataFormDialog.vue", "utf8");
const productMasterFields = readFileSync("frontend/src/modules/master-data/product/fields.ts", "utf8");
const productCategoryFields = readFileSync("frontend/src/modules/master-data/product-category/fields.ts", "utf8");
const unitMasterFields = readFileSync("frontend/src/modules/master-data/unit/fields.ts", "utf8");
const customerMasterFields = readFileSync("frontend/src/modules/master-data/customer/fields.ts", "utf8");
const supplierMasterFields = readFileSync("frontend/src/modules/master-data/supplier/fields.ts", "utf8");
const warehouseMasterFields = readFileSync("frontend/src/modules/master-data/warehouse/fields.ts", "utf8");
const moduleCatalogSource = readFileSync("frontend/src/modules/catalog.ts", "utf8");
const stockAlertCatalogSource = readFileSync("frontend/src/modules/inventory/stock-alert/definition.ts", "utf8");
const dataListDefinitionSource = readFileSync("frontend/src/components/list/useDataListDefinition.ts", "utf8");
const reportRegistrySource = readFileSync("frontend/src/modules/reports/reportRegistry.ts", "utf8");
const registeredReportDefinitionIds = collectRegisteredReportIds(
  reportRegistrySource,
  (moduleName) => readFileSync(`frontend/src/modules/reports/${moduleName}.ts`, "utf8")
);
const registeredReportIds = new Set(registeredReportDefinitionIds);
const requiredFormalReportIds = new Set([
  "sales-detail", "sales-summary", "sales-order-tracking", "inventory-movement-detail",
  "material-scrap-summary", "receivable-detail", "receivable-summary", "payable-detail", "payable-summary"
]);
const listQueryContractRegistry = readFileSync("backend/src/main/java/com/jdy/erp/system/application/list/ListQueryContractRegistry.java", "utf8");
const listStubStateGuard = readFileSync("backend/src/main/java/com/jdy/erp/system/application/list/ListStubStateGuard.java", "utf8");
const stubListSeedRowsProvider = readFileSync("backend/src/main/java/com/jdy/erp/system/application/list/StubListSeedRowsProvider.java", "utf8");
const featureDeliveryStatus = JSON.parse(readFileSync("config/feature-delivery-status.json", "utf8"));
const masterDataController = readFileSync("backend/src/main/java/com/jdy/erp/masterdata/api/MasterDataController.java", "utf8");
const masterDataCreateService = readFileSync("backend/src/main/java/com/jdy/erp/masterdata/application/MasterDataCreateService.java", "utf8");
const masterDataPatchService = readFileSync("backend/src/main/java/com/jdy/erp/masterdata/application/MasterDataPatchService.java", "utf8");
const masterDataSystemNoMigration = readFileSync("backend/src/main/resources/db/migration/V67__master_data_visible_system_no.sql", "utf8");
const materialCategoryUnitMigration = readFileSync("backend/src/main/resources/db/migration/V68__material_category_unit_master_data.sql", "utf8");
const productUnitWeightSnapshotMigration = readFileSync("backend/src/main/resources/db/migration/V69__product_unit_weight_snapshots.sql", "utf8");
const productMasterReferenceMigration = readFileSync("backend/src/main/resources/db/migration/V72__product_master_reference_ids.sql", "utf8");
const factoryWorkshopSeedMigration = readFileSync("backend/src/main/resources/db/migration/V89__seed_factory_production_workshops.sql", "utf8");
const genericProductionDepartmentRetirementMigration = readFileSync("backend/src/main/resources/db/migration/V94__retire_generic_production_department.sql", "utf8");
const tenantWorkshopEnforcementMigration = readFileSync("backend/src/main/resources/db/migration/V95__enforce_factory_workshops_across_tenants.sql", "utf8");
const tenantSchemaProvisioner = readFileSync("backend/src/main/java/com/jdy/erp/system/tenant/TenantSchemaProvisioner.java", "utf8");
const masterDataReferenceIntegrationTest = readFileSync("backend/src/test/java/com/jdy/erp/masterdata/api/MasterDataReferenceIntegrationTest.java", "utf8");
const purchaseOrderForm = readFileSync("frontend/src/modules/purchase/purchase-order/PurchaseOrderForm.vue", "utf8");
const purchaseOrderDocument = readFileSync("frontend/src/modules/purchase/purchase-order/usePurchaseOrderDocument.ts", "utf8");
const listStubController = readFileSync("backend/src/main/java/com/jdy/erp/system/api/ListStubController.java", "utf8");
const listBackendSources = [
  listStubController,
  "backend/src/main/java/com/jdy/erp/system/application/list/StubListSeedRowsProvider.java",
  "backend/src/main/java/com/jdy/erp/system/application/list/SalesOrderListQueryAdapter.java",
  "backend/src/main/java/com/jdy/erp/system/application/list/MaterialScrapListQueryAdapter.java"
].map((source) => source.includes("\n") ? source : readFileSync(source, "utf8")).join("\n");
const sourceSelectorListQueryAdapter = readFileSync("backend/src/main/java/com/jdy/erp/system/application/list/SourceSelectorListQueryAdapter.java", "utf8");
const backendTaxAmountCalculator = readFileSync("backend/src/main/java/com/jdy/erp/shared/application/TaxAmountCalculator.java", "utf8");
const purchaseOrderAppService = readFileSync("backend/src/main/java/com/jdy/erp/purchase/application/PurchaseOrderAppService.java", "utf8");
const priceTaxBackfillMigration = readFileSync("backend/src/main/resources/db/migration/V63__backfill_price_tax_totals.sql", "utf8");
const purchaseOrderSupplierMaterialMigration = readFileSync("backend/src/main/resources/db/migration/V65__purchase_order_supplier_material_and_delivery_date.sql", "utf8");
const documentTaxHeaderDropMigration = readFileSync("backend/src/main/resources/db/migration/V86__drop_document_tax_inclusive_headers.sql", "utf8");
const productDisplaySnapshotMigration = readFileSync("backend/src/main/resources/db/migration/V66__product_display_snapshots.sql", "utf8");
const productSnapshotService = readFileSync("backend/src/main/java/com/jdy/erp/shared/application/ProductSnapshotService.java", "utf8");
const documentOutputController = readFileSync("backend/src/main/java/com/jdy/erp/reports/api/DocumentOutputController.java", "utf8");
const conversionService = readFileSync("backend/src/main/java/com/jdy/erp/shared/application/ConversionService.java", "utf8");
const productSnapshotWriteServices = [
  "backend/src/main/java/com/jdy/erp/sales/application/SalesQuoteAppService.java",
  "backend/src/main/java/com/jdy/erp/sales/application/SalesOrderAppService.java",
  "backend/src/main/java/com/jdy/erp/sales/application/DeliveryNoticeAppService.java",
  "backend/src/main/java/com/jdy/erp/sales/application/SalesOutAppService.java",
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseOrderAppService.java",
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseInAppService.java",
  "backend/src/main/java/com/jdy/erp/purchase/application/PurchaseReturnAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockInAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/OtherStockOutAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockTransferAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountGainAppService.java",
  "backend/src/main/java/com/jdy/erp/inventory/application/StockCountLossAppService.java",
  "backend/src/main/java/com/jdy/erp/production/application/ProductionTaskAppService.java",
  "backend/src/main/java/com/jdy/erp/production/application/MaterialIssueAppService.java",
  "backend/src/main/java/com/jdy/erp/production/application/ProductInAppService.java"
].map((path) => readFileSync(path, "utf8")).join("\n");

function assertContains(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(message);
  }
}

function assertNotContains(text, pattern, message) {
  if (pattern.test(text)) {
    throw new Error(message);
  }
}

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assertContains(
  source,
  /salesQuoteBillDefinition[\s\S]*?sourcePolicy:\s*"none"/,
  "销售报价单必须声明 sourcePolicy=none"
);
assertContains(
  source,
  /salesQuoteBillDefinition[\s\S]*?entryColumns:\s*salesQuoteEntryColumns[\s\S]*?detail:\s*salesQuoteDetailColumns[\s\S]*?toolbarActions/,
  "销售报价单必须使用不含预计交期/源单列的报价单分录与明细定义"
);
assertContains(
  source,
  /salesOrderBillDefinition[\s\S]*?sourcePolicy:\s*"salesQuote"/,
  "销售订单必须声明 sourcePolicy=salesQuote"
);
assertContains(
  source,
  /salesOrderBillDefinition[\s\S]*?detail:\s*\[[\s\S]*?\.\.\.salesOrderDetailColumns[\s\S]*?\.\.\.sourceDetailColumns/,
  "销售订单明细视图应显示源单列"
);
assertContains(
  source,
  /key:\s*"sourceSelect"[\s\S]*?sourcePolicy:\s*"salesQuote"/,
  "销售订单选源单动作必须指向销售报价单"
);
assertContains(
  source,
  /salesOrderBillDefinition[\s\S]*?header:\s*\[[\s\S]*?field:\s*"remark",\s*title:\s*"整单备注"[\s\S]*?owner/,
  "销售订单整单视图必须显示整单备注"
);
assertContains(
  source,
  /salesOrderBillDefinition[\s\S]*?header:\s*\[[\s\S]*?identityListColumns\[1\][\s\S]*?status[\s\S]*?outStatus[\s\S]*?field:\s*"qty",\s*title:\s*"数量"[\s\S]*?field:\s*"shippedQty",\s*title:\s*"已出库数量"[\s\S]*?field:\s*"remainingQty",\s*title:\s*"未出库数量"[\s\S]*?amountListColumns[\s\S]*?priceTaxTotalListColumn[\s\S]*?remark[\s\S]*?owner[\s\S]*?\]/,
  "销售订单整单视图必须显示数量/已出库数量/未出库数量/金额/含税金额，且不显示预计交期"
);
assertContains(
  fragments,
  /salesDetailBaseColumns[\s\S]*?field:\s*"customerMaterialCode",\s*title:\s*"客户物料编码"[\s\S]*?field:\s*"customerOrderNo",\s*title:\s*"客户订单号"[\s\S]*?field:\s*"unitPrice",\s*title:\s*"单价"[\s\S]*?field:\s*"taxInclusiveUnitPrice",\s*title:\s*"含税单价"[\s\S]*?field:\s*"priceTaxTotal",\s*title:\s*"含税金额"[\s\S]*?field:\s*"lineRemark",\s*title:\s*"行备注"/,
  "销售明细视图必须同时包含客户物料编码、客户订单号、单价、含税单价、含税金额、行备注"
);
assertContains(
  fragments,
  /salesEntryColumns[\s\S]*?field:\s*"customerMaterialCode",\s*title:\s*"客户物料编码"[\s\S]*?field:\s*"customerOrderNo",\s*title:\s*"客户订单号"[\s\S]*?field:\s*"unitPrice",\s*title:\s*"单价"[\s\S]*?field:\s*"taxInclusiveUnitPrice",\s*title:\s*"含税单价"[\s\S]*?field:\s*"priceTaxTotal",\s*title:\s*"含税金额"[\s\S]*?field:\s*"planDeliveryDate",\s*title:\s*"预计交期"[\s\S]*?field:\s*"lineRemark",\s*title:\s*"行备注"/,
  "销售分录列必须统一客户物料编码、客户订单号、单价、含税单价、含税金额、预计交期、行备注文案"
);
assertContains(
  fragments,
  /salesDetailBaseColumns[\s\S]*?field:\s*"unit",\s*title:\s*"单位"[\s\S]*?field:\s*"netWeight",\s*title:\s*"净重"[\s\S]*?field:\s*"grossWeight",\s*title:\s*"毛重"[\s\S]*?field:\s*"warehouse"/,
  "销售/采购明细视图基础列必须在物料信息后显示单位、净重和毛重"
);
assertContains(
  fragments,
  /salesEntryColumns[\s\S]*?field:\s*"spec",\s*title:\s*"规格型号"[\s\S]*?field:\s*"unit",\s*title:\s*"单位"[\s\S]*?field:\s*"netWeight",\s*title:\s*"净重"[\s\S]*?field:\s*"grossWeight",\s*title:\s*"毛重"[\s\S]*?field:\s*"warehouse"/,
  "单据分录列必须在规格型号后统一显示单位、净重和毛重"
);
assertContains(
  fragments,
  /salesQuoteEntryColumns[\s\S]*?filter\(\(column\)\s*=>\s*column\.field\s*!==\s*"planDeliveryDate"\)/,
  "销售报价单分录不能显示预计交期"
);
assertContains(
  entryTable,
  /showPartyCodeColumn[\s\S]*?showCustomerMaterialCodeColumn[\s\S]*?showSupplierMaterialCodeColumn[\s\S]*?showCustomerOrderNoColumn[\s\S]*?title:\s*"客户物料编码"[\s\S]*?title:\s*"供应商物料编码"[\s\S]*?title:\s*"客户订单号"[\s\S]*?title:\s*"单价"[\s\S]*?title:\s*"含税单价"/,
  "共享分录表必须支持隐藏客户编码，并区分客户物料编码/供应商物料编码/客户订单号/双单价"
);
assertContains(
  entryTable,
  /EntryColumnKey[\s\S]*?"unit"[\s\S]*?"netWeight"[\s\S]*?"grossWeight"/,
  "共享分录表列类型必须统一承载单位、净重、毛重"
);
assertContains(
  entryTable,
  /title:\s*"单位"[\s\S]*?title:\s*"净重"[\s\S]*?title:\s*"毛重"/,
  "共享分录表列定义必须统一显示单位、净重、毛重"
);
assertContains(
  entryTable,
  /column\.key === 'unit'[\s\S]*?productInfo\(line\)\.unit[\s\S]*?column\.key === 'netWeight'[\s\S]*?formatOptionalWeight\(productInfo\(line\)\.netWeight\)[\s\S]*?column\.key === 'grossWeight'[\s\S]*?formatOptionalWeight\(productInfo\(line\)\.grossWeight\)/,
  "共享分录表渲染必须从物料快照读取单位、净重、毛重"
);
assertContains(
  entryTable,
  /function formatOptionalWeight[\s\S]*?toFixed\(2\)/,
  "共享分录表必须把重量格式化到小数点后两位"
);
assertContains(
  entryTable,
  /:columns="configurableColumns"[\s\S]*?const configurableColumns = computed\(\(\) => columns\.value\.filter\(\(column\) => column\.configurable !== false && isColumnAvailable\(column\)\)\)/,
  "分录列设置只能展示当前单据真实可用列，避免勾选项和实际表格不一致"
);
assertContains(
  entryTable,
  /function advanceLineCellOnEnter[\s\S]*?editableCellOrder\(\)[\s\S]*?emit\("insertLineAfter", lineIndex\)/,
  "分录回车导航必须按可编辑列顺序完成后才新增/进入下一行"
);
assertContains(
  dataListPage,
  /listSummaryFields[\s\S]*?"qty"[\s\S]*?"shippedQty"[\s\S]*?"receivedQty"[\s\S]*?"remainingQty"[\s\S]*?"amount"[\s\S]*?"priceTaxTotal"[\s\S]*?hasListSummary/,
  "列表汇总必须是通用能力，覆盖数量/已出库/已入库/未出库或未入库/金额/含税金额"
);
assertContains(
  dataListPage,
  /listSummaryFooterValue\(column\.key\)[\s\S]*?function listSummaryFooterValue[\s\S]*?listSummaryTotals/,
  "列表汇总行必须调用通用 footer 取值函数"
);
assertContains(
  dataListPage,
  /detailColumnsForList[\s\S]*?field:\s*"unit",\s*title:\s*"单位"[\s\S]*?field:\s*"netWeight",\s*title:\s*"净重"[\s\S]*?field:\s*"grossWeight",\s*title:\s*"毛重"[\s\S]*?field:\s*"warehouse"/,
  "列表明细视图通用列必须带出物料单位、净重和毛重"
);
assertContains(
  dataListPage,
  /"purchase-order-form-list"[\s\S]*?field:\s*"qty",\s*title:\s*"数量"[\s\S]*?field:\s*"receivedQty",\s*title:\s*"已入库数量"[\s\S]*?field:\s*"remainingQty",\s*title:\s*"未入库数量"[\s\S]*?field:\s*"amount",\s*title:\s*"金额"[\s\S]*?field:\s*"priceTaxTotal",\s*title:\s*"含税金额"[\s\S]*?"purchase-return-form-list"[\s\S]*?field:\s*"qty",\s*title:\s*"退货数量"[\s\S]*?field:\s*"priceTaxTotal",\s*title:\s*"含税金额"[\s\S]*?"purchase-in-list"[\s\S]*?field:\s*"qty",\s*title:\s*"入库数量"[\s\S]*?field:\s*"amount",\s*title:\s*"金额"[\s\S]*?field:\s*"priceTaxTotal",\s*title:\s*"含税金额"/,
  "采购订单列表必须显示数量/已入库/未入库，采购入库和采购退货列表必须显示数量/金额/含税金额"
);
assertContains(
  dataListPage,
  /props\.listKey\s*===\s*"purchase-order-form-list"[\s\S]*?field:\s*"receivedQty",\s*title:\s*"已入库数量"[\s\S]*?field:\s*"remainingQty",\s*title:\s*"未入库数量"/,
  "采购订单明细视图必须显示已入库数量和未入库数量"
);
assertContains(
  dataListPage,
  /props\.listKey\s*===\s*"purchase-order-form-list"[\s\S]*?field:\s*"supplierMaterialCode",\s*title:\s*"供应商物料编码"[\s\S]*?field:\s*"planDeliveryDate",\s*title:\s*"预计交期"/,
  "采购订单明细视图必须显示供应商物料编码和预计交期"
);
assertContains(
  dataListPage,
  /function toggleDetailView\(\)[\s\S]*?saveDetailViewPreference\(\)[\s\S]*?function detailViewPreferenceKey\(\)[\s\S]*?jdy:list-view:\$\{props\.listKey\}[\s\S]*?function loadDetailViewPreference\(\)/,
  "整单/明细视图切换必须按列表入口记忆"
);
assertContains(
  `${documentModule}\n${purchaseOrderForm}\n${purchaseOrderDocument}`,
  /showSupplierMaterialCodeColumn[\s\S]*?showPlanDeliveryDateColumn[\s\S]*?purchaseOrder[\s\S]*?documentType:\s*"purchaseOrder"[\s\S]*?showSupplierMaterialCodeColumn:\s*true/,
  "采购订单表单必须开启供应商物料编码列，并支持采购订单分录预计交期"
);
assertContains(
  listBackendSources,
  /documentDetailRows[\s\S]*?sales-quote-form-list[\s\S]*?AS "priceTaxTotal"[\s\S]*?sales-order-form-list[\s\S]*?AS "priceTaxTotal"[\s\S]*?purchase-order-form-list[\s\S]*?AS "priceTaxTotal"[\s\S]*?sales-out-list[\s\S]*?AS "priceTaxTotal"[\s\S]*?delivery-notice-form-list[\s\S]*?AS "priceTaxTotal"[\s\S]*?purchase-in-list[\s\S]*?AS "priceTaxTotal"/,
  "核心单据明细列表 API 必须返回含税金额 priceTaxTotal"
);
assertContains(
  listBackendSources,
  /purchase-order-form-list[\s\S]*?AS "supplierMaterialCode"[\s\S]*?AS "taxInclusiveUnitPrice"[\s\S]*?AS "taxRate"[\s\S]*?AS "priceTaxTotal"/,
  "采购订单明细列表 API 必须返回供应商物料编码、含税单价、税率和含税金额"
);
assertContains(
  sourceSelectorListQueryAdapter,
  /"unitPrice", "taxInclusiveUnitPrice", "taxRate", "amount", "taxAmount", "priceTaxTotal"[\s\S]*?"unitPrice", "taxInclusiveUnitPrice", "taxRate", "amount", "taxAmount", "priceTaxTotal"/,
  "销售选源字段必须返回单价、含税单价、金额、税额和含税金额"
);
assertContains(
  sourceSelectorListQueryAdapter,
  /"unitPrice", "taxInclusiveUnitPrice", "taxRate", "taxAmount",[\s\S]*?"unitPrice", "taxInclusiveUnitPrice", "taxRate", "taxAmount"/,
  "采购选源字段必须返回含税单价和税额/含税金额口径"
);
assertContains(
  listBackendSources,
  /purchase-order-form-list[\s\S]*?AS qty[\s\S]*?AS "receivedQty"[\s\S]*?AS "remainingQty"[\s\S]*?AS "unitPrice"/,
  "采购订单明细列表 API 必须返回数量/已入库数量/未入库数量"
);
assertContains(
  listBackendSources,
  /purchaseOrderRows[\s\S]*?AS qty[\s\S]*?AS "receivedQty"[\s\S]*?AS "remainingQty"[\s\S]*?AS amount/,
  "采购订单整单列表 API 必须返回数量/已入库数量/未入库数量"
);
assertContains(
  listBackendSources,
  /purchaseInRows[\s\S]*?AS qty[\s\S]*?AS amount[\s\S]*?AS "priceTaxTotal"[\s\S]*?purchaseReturnRows[\s\S]*?AS qty[\s\S]*?AS amount[\s\S]*?AS "priceTaxTotal"/,
  "采购入库/采购退货整单列表 API 必须返回数量/金额/含税金额"
);
assertContains(
  listBackendSources,
  /purchaseSummaryRows[\s\S]*?order_lines[\s\S]*?in_lines[\s\S]*?return_lines[\s\S]*?"netPurchaseAmount"/,
  "采购汇总表必须聚合采购订单、采购入库和采购退货"
);
assertContains(
  dataListPage,
  /"purchase-summary-report"[\s\S]*?field:\s*"orderQty"[\s\S]*?field:\s*"inQty"[\s\S]*?field:\s*"returnQty"[\s\S]*?field:\s*"netPurchaseAmount"/,
  "采购汇总表前端必须显示订单/入库/退货/净采购金额字段"
);
assertContains(
  listBackendSources,
  /purchaseOrderRows[\s\S]*?AS "priceTaxTotal"[\s\S]*?salesQuoteRows[\s\S]*?AS "priceTaxTotal"[\s\S]*?purchaseInRows[\s\S]*?AS "priceTaxTotal"[\s\S]*?salesOutRows[\s\S]*?AS "priceTaxTotal"[\s\S]*?deliveryNoticeRows[\s\S]*?AS "priceTaxTotal"/,
  "采购、报价、入库、出库和发货整单列表 API 必须返回含税金额 priceTaxTotal"
);
assertContains(
  listBackendSources,
  /SalesOrderListQueryAdapter[\s\S]*?AS "priceTaxTotal"[\s\S]*?DETAIL_PRICE_TAX_TOTAL_TEXT[\s\S]*?l\.price_tax_total/,
  "销售订单整单列表 adapter 必须返回含税金额 priceTaxTotal"
);
assertContains(
  priceTaxBackfillMigration,
  /UPDATE sales_quote_line[\s\S]*?price_tax_total[\s\S]*?UPDATE sales_order_line[\s\S]*?price_tax_total[\s\S]*?UPDATE delivery_notice_line[\s\S]*?price_tax_total[\s\S]*?UPDATE sales_out_line[\s\S]*?price_tax_total[\s\S]*?UPDATE purchase_order_line[\s\S]*?price_tax_total[\s\S]*?UPDATE purchase_in_line[\s\S]*?price_tax_total/,
  "V63 必须回填核心单据历史分录含税金额"
);
assertContains(
  purchaseOrderSupplierMaterialMigration,
  /ALTER TABLE purchase_order_line[\s\S]*?supplier_material_code[\s\S]*?plan_delivery_date/,
  "采购订单分录必须落库供应商物料编码和预计交期"
);
assertContains(
  purchaseOrderAppService,
  /supplier_material_code[\s\S]*?"supplierMaterialCode"[\s\S]*?plan_delivery_date[\s\S]*?"planDeliveryDate"[\s\S]*?INSERT INTO purchase_order_line[\s\S]*?supplier_material_code[\s\S]*?plan_delivery_date/,
  "采购订单详情、选源和保存必须贯通供应商物料编码与预计交期"
);
assertContains(
  dataListPageComponent,
  /^    <div class="list-toolbar">\n(?:(?!^    <\/div>$)[\s\S])*?^      <div class="list-toolbar-utilities">\n(?:(?!^      <\/div>$)[\s\S])*?data-testid="list-detail-view-toggle"(?:(?!^      <\/div>$)[\s\S])*?data-testid="column-settings"(?:(?!^      <\/div>$)[\s\S])*?data-testid="list-refresh-stock"(?:(?!^      <\/div>$)[\s\S])*?^      <\/div>\n^    <\/div>$/m,
  "整单/明细视图切换、列设置、更新库存必须集中在列表右侧工具区"
);
assertContains(
  baseStyles,
  /\.list-toolbar-utilities\s*\{[^}]*margin-left:\s*auto;[^}]*\}/,
  "列表工具组必须通过自动左外边距固定在工具栏右侧"
);
assertContains(
  fieldTypes,
  /interface FieldDefinition[\s\S]*?readonly\?:\s*boolean/,
  "字段渲染协议必须支持全程只读字段"
);
assertContains(
  masterDataTypes,
  /interface MasterDataDefinition[\s\S]*?listColumns:\s*ListColumnDefinition\[\][\s\S]*?selectorColumns:\s*ListColumnDefinition\[\]/,
  "主数据定义必须集中维护列表列和选择器列"
);
assertContains(
  dataListPage,
  /masterListDefinitions[\s\S]*?Object\.entries\(masterDataDefinitions\)[\s\S]*?columns:\s*masterDefinition\.listColumns/,
  "主数据列表必须从 MasterDataDefinition 读取列定义，不能继续在 DataListPage 里散写四套列"
);
assertContains(
  masterDataRegistry,
  /"product-master-list"[\s\S]*?title:\s*"物料资料"[\s\S]*?field:\s*"systemNo",\s*title:\s*"系统编号"[\s\S]*?field:\s*"code",\s*title:\s*"物料编码"[\s\S]*?field:\s*"category",\s*title:\s*"物料类别"[\s\S]*?field:\s*"defaultSupplierCode",\s*title:\s*"默认供应商"[\s\S]*?field:\s*"minStockQty",\s*title:\s*"最低库存数量"[\s\S]*?field:\s*"isProduce",\s*title:\s*"可自制"[\s\S]*?field:\s*"surfaceTreatment",\s*title:\s*"表面处理"[\s\S]*?field:\s*"purchasePrice",\s*title:\s*"采购价"[\s\S]*?field:\s*"costPrice",\s*title:\s*"参考成本"[\s\S]*?field:\s*"minSalePrice",\s*title:\s*"最低销售价"[\s\S]*?field:\s*"drawingFileName",\s*title:\s*"图纸"[\s\S]*?field:\s*"imageFileNames",\s*title:\s*"图片"/,
  "物料资料必须按最新收敛口径包含系统编号、物料类别、默认供应商、库存预警、商品特性、关键价格和附件列"
);
assertContains(
  masterDataRegistry,
  /"product-master-list"[\s\S]*?field:\s*"unit",\s*title:\s*"库存单位"[\s\S]*?field:\s*"netWeight",\s*title:\s*"净重"[\s\S]*?field:\s*"grossWeight",\s*title:\s*"毛重"[\s\S]*?selectorColumns:[\s\S]*?field:\s*"unit",\s*title:\s*"单位"/,
  "物料资料列表和选择器必须暴露计量单位，并在列表中显示净重/毛重"
);
assertContains(
  productMasterFields,
  /name:\s*"systemNo"[\s\S]*?label:\s*"系统编号"[\s\S]*?readonly:\s*true[\s\S]*?label:\s*"物料编码"[\s\S]*?label:\s*"物料类别"[\s\S]*?label:\s*"计量单位"[\s\S]*?label:\s*"净重"[\s\S]*?label:\s*"毛重"[\s\S]*?label:\s*"表面处理"/,
  "物料建档页基本信息必须包含只读系统编号、物料编码、物料类别、计量单位、净重、毛重和表面处理"
);
assertNotContains(
  productMasterFields,
  /label:\s*"商品类型"|label:\s*"OE NO\."|label:\s*"位置"|label:\s*"默认领料仓"|label:\s*"发料方式"|label:\s*"备注"/,
  "物料建档页不得重新暴露商品类型、OE、位置、默认领料仓、发料方式和备注"
);
assertContains(
  productMasterFields,
  /label:\s*"计量单位"[\s\S]*?required:\s*true[\s\S]*?label:\s*"净重"[\s\S]*?type:\s*"number"[\s\S]*?label:\s*"毛重"[\s\S]*?type:\s*"number"/,
  "物料建档页必须把计量单位作为必录属性，并维护可空净重/毛重"
);
assertContains(
  masterDataCreateService + masterDataPatchService,
  /productValues[\s\S]*?requiredReference\(\s*"md_product_category",\s*required\(payload,\s*"category"\)[\s\S]*?requiredReference\(\s*"md_unit",\s*required\(payload,\s*"unit"\)[\s\S]*?"product"[\s\S]*?Map\.entry\("category",\s*requiredReference\("category",\s*"product_category_id",\s*"md_product_category"[\s\S]*?Map\.entry\("unit",\s*requiredReference\("unit",\s*"unit_id",\s*"md_unit"/,
  "后端物料新增和编辑必须强制校验物料类别和计量单位引用"
);
assertContains(
  masterDataController,
  /private final MasterDataCreateService masterDataCreateService[\s\S]*?public Map<String, Object> create\([\s\S]*?masterDataCreateService\.create\(type, payload\)/,
  "主数据创建接口必须委托共享 MasterDataCreateService"
);
assertNotContains(
  masterDataController,
  /\bINSERT\s+INTO\s+md_/i,
  "MasterDataController 不得重新内嵌主数据创建 INSERT"
);
assertContains(
  masterDataCreateService,
  /public ValidatedCreate validateCreate\(String type, Map<String, String> payload\)[\s\S]*?validateCreate\(type, payload, CreateOptions\.manual\(\)\)[\s\S]*?public Map<String, Object> create\(String type, Map<String, String> payload\)[\s\S]*?create\(type, payload, CreateOptions\.manual\(\)\)[\s\S]*?public Map<String, Object> create\(String type, Map<String, String> payload, CreateOptions options\)[\s\S]*?insert\(prepare\(type, payload, options, true\)\)/,
  "共享主数据创建服务必须同时提供无写入校验、人工创建和带选项创建契约"
);
assertContains(
  masterDataCreateService,
  /enum ReferenceMode\s*\{\s*CODE_OR_NAME,\s*CODE_ONLY[\s\S]*?static CreateOptions manual\(\)[\s\S]*?ReferenceMode\.CODE_OR_NAME[\s\S]*?static CreateOptions importStrict\(Map<String, String> explicitDefaults\)[\s\S]*?ReferenceMode\.CODE_ONLY/,
  "共享主数据创建服务必须区分人工编码或名称匹配与导入严格编码匹配"
);
assertContains(
  masterDataCreateService,
  /if \(referenceMode == ReferenceMode\.CODE_ONLY\)[\s\S]*?WHERE enabled = TRUE[\s\S]*?audit_status = 'AUDITED'[\s\S]*?AND code = \?[\s\S]*?else \{[\s\S]*?AND \(code = \? OR name = \?\)/,
  "物料导入引用必须仅按已审核启用编码匹配，人工创建仍允许编码或名称匹配"
);
assertContains(
  productMasterReferenceMigration,
  /ADD COLUMN IF NOT EXISTS product_category_id UUID[\s\S]*?ADD COLUMN IF NOT EXISTS unit_id UUID[\s\S]*?ADD COLUMN IF NOT EXISTS default_warehouse_id UUID[\s\S]*?ADD COLUMN IF NOT EXISTS default_supplier_id UUID[\s\S]*?ADD COLUMN IF NOT EXISTS default_workshop_id UUID[\s\S]*?FOREIGN KEY \(product_category_id\) REFERENCES md_product_category\(id\)[\s\S]*?FOREIGN KEY \(unit_id\) REFERENCES md_unit\(id\)/,
  "物料主档必须用隐藏 UUID 外键引用类别、单位、默认仓库、默认供应商和默认生产车间"
);
assertContains(
  masterDataCreateService + masterDataPatchService + masterDataController,
  /productValues[\s\S]*?requiredReference\(\s*"md_product_category"[\s\S]*?requiredReference\(\s*"md_unit"[\s\S]*?optionalReference\(\s*"md_warehouse"[\s\S]*?optionalReference\(\s*"md_supplier"[\s\S]*?optionalReference\(\s*"md_production_department"[\s\S]*?"product"[\s\S]*?requiredReference\("category",\s*"product_category_id",\s*"md_product_category"[\s\S]*?requiredReference\("unit",\s*"unit_id",\s*"md_unit"[\s\S]*?optionalReference\("default_warehouse_code",\s*"default_warehouse_id",\s*"md_warehouse"[\s\S]*?optionalReference\("default_workshop",\s*"default_workshop_id",\s*"md_production_department"[\s\S]*?optionalReference\("default_supplier_code",\s*"default_supplier_id",\s*"md_supplier"[\s\S]*?validateProductReferencesBeforeAudit[\s\S]*?assertNotReferencedByProduct/,
  "物料保存和审核必须由后端校验已审核启用主数据引用，并阻止被引用主数据随意反审核/禁用"
);
assertContains(
  masterDataReferenceIntegrationTest,
  /productStoresAuditedEnabledMasterReferencesAndProtectsReferencedMasters[\s\S]*?JOIN md_product_category[\s\S]*?JOIN md_unit[\s\S]*?updateStatus\("unit"[\s\S]*?reverseAudit\("unit"/,
  "后端必须有集成测试覆盖物料主数据 UUID 引用和被引用主数据禁用/反审核保护"
);
assertNotContains(
  masterDataController,
  /getOrDefault\("unit",\s*"只"\)/,
  "后端不得把缺失计量单位静默默认成“只”"
);
assertContains(
  productMasterFields,
  /section:\s*"商品特性"[\s\S]*?section:\s*"价格设置"[\s\S]*?section:\s*"库存预警"[\s\S]*?section:\s*"生产信息"/,
  "物料建档页必须按商品特性、价格设置、库存预警、生产信息分区"
);
assertContains(
  productMasterFields,
  /label:\s*"可销售"[\s\S]*?label:\s*"可采购"[\s\S]*?label:\s*"采购价"[\s\S]*?label:\s*"参考成本"[\s\S]*?label:\s*"最低库存数量"[\s\S]*?label:\s*"默认生产车间"/,
  "物料建档页必须保留商品特性、价格、库存预警和生产关键字段"
);
assertContains(
  factoryWorkshopSeedMigration,
  /'CY',\s*'冲压车间'[\s\S]*?'HJ',\s*'焊接车间'[\s\S]*?'JG',\s*'金工车间'[\s\S]*?'AZ',\s*'安装车间'[\s\S]*?'BZ',\s*'包装车间'/,
  "已有库补丁迁移必须补齐冲压、焊接、金工、安装、包装"
);
assertContains(
  tenantSchemaProvisioner,
  /'CY',\s*'冲压车间'[\s\S]*?'HJ',\s*'焊接车间'[\s\S]*?'JG',\s*'金工车间'[\s\S]*?'AZ',\s*'安装车间'[\s\S]*?'BZ',\s*'包装车间'/,
  "新账套初始化必须种入冲压、焊接、金工、安装、包装"
);
assertContains(
  productMasterFields,
  /冲压车间[\s\S]*?焊接车间[\s\S]*?金工车间[\s\S]*?安装车间[\s\S]*?包装车间/,
  "物料默认生产车间建议词必须包含冲压、焊接、金工、安装、包装"
);
assertContains(
  genericProductionDepartmentRetirementMigration,
  /UPDATE md_product product[\s\S]*?department\.code NOT IN \('AZ', 'BZ', 'CY', 'HJ', 'JG'\)[\s\S]*?DELETE FROM md_production_department[\s\S]*?WHERE code NOT IN \('AZ', 'BZ', 'CY', 'HJ', 'JG'\)/,
  "生产部门主数据必须只保留安装、包装、冲压、焊接、金工五个默认车间"
);
assertContains(
  tenantWorkshopEnforcementMigration,
  /FOR tenant_schema IN[\s\S]*?FROM sys_account_set[\s\S]*?INSERT INTO %1\$I\.md_production_department[\s\S]*?UPDATE %1\$I\.md_product product[\s\S]*?DELETE FROM %1\$I\.md_production_department[\s\S]*?WHERE code NOT IN \('AZ', 'BZ', 'CY', 'HJ', 'JG'\)/,
  "生产部门收敛迁移必须覆盖 public 和所有 tenant schema"
);
assertContains(
  tenantWorkshopEnforcementMigration,
  /product\.default_workshop IN \(department\.code, department\.name\)[\s\S]*?default_workshop NOT IN \('AZ', 'BZ', 'CY', 'HJ', 'JG', '安装车间', '包装车间', '冲压车间', '焊接车间', '金工车间'\)/,
  "清理孤立默认车间快照前必须保留五车间编码和名称"
);
assertContains(
  masterDataRecordPage,
  /const key = normalizeLookupText\(option\.value\)[\s\S]*?deduped\.set\(key, option\)/,
  "主数据 lookup 候选必须按值去重，避免静态建议和远程主数据重复显示同一车间"
);
assertNotContains(
  productMasterFields,
  /label:\s*"销售单位"|label:\s*"采购单位"|label:\s*"生产\/BOM单位"|label:\s*"物料属性"/,
  "物料建档页不得保留当前阶段造成重复理解的销售/采购/BOM单位和物料属性字段"
);
assertContains(
  masterDataRegistry,
  /"product-category-list"[\s\S]*?type:\s*"productCategory"[\s\S]*?title:\s*"物料类别"[\s\S]*?field:\s*"parentCode"[\s\S]*?"unit-master-list"[\s\S]*?type:\s*"unit"[\s\S]*?title:\s*"计量单位"[\s\S]*?field:\s*"decimalPlaces"/,
  "基础资料必须补齐物料类别和计量单位两个轻主数据列表"
);
assertContains(
  productCategoryFields + unitMasterFields,
  /name:\s*"parentCode"[\s\S]*?label:\s*"上级类别编码"[\s\S]*?name:\s*"decimalPlaces"[\s\S]*?label:\s*"数量小数位"/,
  "物料类别建档必须维护上级类别，计量单位建档必须维护数量小数位"
);
assertContains(
  materialCategoryUnitMigration + masterDataCreateService + masterDataController + listBackendSources,
  /CREATE TABLE IF NOT EXISTS md_product_category[\s\S]*?CREATE TABLE IF NOT EXISTS md_unit[\s\S]*?ALTER TABLE md_product[\s\S]*?ADD COLUMN IF NOT EXISTS oe_no[\s\S]*?case "productCategory"[\s\S]*?case "unit"[\s\S]*?case "product-category-list"[\s\S]*?case "unit-master-list"/,
  "后端必须落库物料类别、计量单位和云星辰物料页关键字段，并接入统一主数据接口"
);
assertContains(
  customerMasterFields + supplierMasterFields + warehouseMasterFields,
  /name:\s*"systemNo",\s*label:\s*"系统编号"[\s\S]*?name:\s*"systemNo",\s*label:\s*"系统编号"[\s\S]*?name:\s*"systemNo",\s*label:\s*"系统编号"/,
  "客户、供应商、仓库建档页也必须统一显示只读系统编号"
);
assertContains(
  masterDataRecordPage,
  /function isFieldDisabled\(field: MasterDataField\)[\s\S]*?props\.readOnly[\s\S]*?auditStatusText\.value === "已审核"[\s\S]*?field\.readonly[\s\S]*?field\.readonlyWhenEditing/,
  "主数据建档页必须让 readonly 字段全程不可编辑"
);
assertContains(
  masterDataRecordPage,
  /defineAction\("create"[\s\S]*?testId:\s*"master-record-new"[\s\S]*?defineAction\("save"[\s\S]*?testId:\s*"master-record-save"[\s\S]*?defineAction\("audit"[\s\S]*?defineAction\("reverse"[\s\S]*?defineAction\(statusText\.value === "禁用" \? "enable" : "disable"[\s\S]*?defineAction\("delete"[\s\S]*?function handleAction[\s\S]*?emit\("newRecord"\)[\s\S]*?emit\("audit"\)[\s\S]*?emit\("reverseAudit"\)[\s\S]*?emit\("toggleStatus"\)[\s\S]*?emit\("deleteRecord"\)/,
  "主数据建档页必须保留新增/保存/审核/反审核/启禁用/删除动作条"
);
assertContains(
  fieldRenderer,
  /usesLookupMenu[\s\S]*?master-lookup-menu/,
  "主数据建档页必须通过统一 FieldRenderer lookup 分支承载主数据匹配选择"
);
assertContains(
  fieldTypes + fieldRenderer,
  /testId\?:\s*string[\s\S]*?variant\?:\s*"master" \| "document"[\s\S]*?lookupKeyboardMode\?:\s*"field" \| "native"[\s\S]*?lookupButtonClick/,
  "统一 FieldRenderer 必须支持单据表头变体、原生键盘转发、test id 和整列表选择按钮"
);
assertContains(
  documentForm,
  /<FieldRenderer[\s\S]*?v-for="field in documentHeadFields"[\s\S]*?variant="document"[\s\S]*?lookup-keyboard-mode="native"[\s\S]*?@lookup-button-click="openDocumentHeadLookupDialog"[\s\S]*?const documentHeadFields = computed<FieldDefinition\[\]>/,
  "DocumentForm 表头字段必须由 FieldRenderer + 字段定义渲染，不能退回散写 label/input"
);
assertContains(
  documentForm,
  /name:\s*"partyCode"[\s\S]*?testId:\s*`\$\{props\.testPrefix\}-party-code`[\s\S]*?name:\s*"billDate"[\s\S]*?name:\s*"billNo"[\s\S]*?name:\s*"department"[\s\S]*?name:\s*"ownerName"[\s\S]*?name:\s*"remark"/,
  "DocumentForm 字段协议必须覆盖客户/供应商、业务日期、单据编号、部门、录入人和备注"
);
assertNotContains(
  documentForm + fragments,
  /name:\s*"taxMode"|label:\s*"价格口径"/,
  "单据表头字段定义不得再暴露价格口径/税价切换"
);
assertNotContains(
  `${documentForm}\n${documentApi}\n${documentModule}\n${salesOutDocument}\n${entryTable}\n${source}\n${fragments}`,
  /isTaxInclusive|showTaxMode|show-tax-mode|is-tax-inclusive|update:isTaxInclusive|name:\s*"taxMode"|label:\s*"价格口径"/,
  "前端单据表头、payload 和分录表不得再保留旧税价切换字段"
);
assertNotContains(
  `${productSnapshotWriteServices}\n${backendTaxAmountCalculator}\n${sourceSelectorListQueryAdapter}\n${listBackendSources}`,
  /Boolean isTaxInclusive|AS "isTaxInclusive"|is_tax_inclusive/,
  "后端单据请求 DTO、保存 SQL 和响应字段不得再暴露旧 isTaxInclusive 表头字段"
);
assertContains(
  documentTaxHeaderDropMigration,
  /sales_quote[\s\S]*sales_order[\s\S]*delivery_notice[\s\S]*sales_out[\s\S]*purchase_order[\s\S]*purchase_in[\s\S]*purchase_return/,
  "数据库迁移必须删除核心单据头旧 is_tax_inclusive 字段"
);
assertContains(
  backendTaxAmountCalculator,
  /calculate\(BigDecimal qty, BigDecimal unitPrice, BigDecimal taxRate\)[\s\S]*?var netLineAmount = safeQty\.multiply\(safeUnitPrice\)[\s\S]*?var priceTaxTotal = scaleMoney\(netAmount\.multiply\(BigDecimal\.ONE\.add\(rateRatio\)\)\)/,
  "后端金额计算必须统一为单价=不含税单价，金额=不含税金额，含税金额=金额+税额"
);
assertNotContains(
  backendTaxAmountCalculator,
  /taxInclusive/,
  "后端金额计算器不得再接收表头税价切换参数"
);
assertContains(
  documentModule,
  /loadByBillNo\(savedBillNo, successMessage\)/,
  "通用单据保存成功后必须按后端单号重新加载回算结果"
);
assertContains(
  salesOutDocument,
  /loadByBillNo\(savedBillNo, successMessage\)/,
  "销售出库保存成功后必须按后端单号重新加载回算结果"
);
assertContains(
  standardDocument + documentActionRules,
  /buildDocumentActions\(props\)[\s\S]*?documentLifecycleActionKeys[\s\S]*?"create"[\s\S]*?"save"[\s\S]*?"audit"[\s\S]*?"reverse"[\s\S]*?"redReverse"[\s\S]*?"close"[\s\S]*?"unclose"[\s\S]*?"freeze"[\s\S]*?"unfreeze"[\s\S]*?"void"[\s\S]*?"sourceSelect"[\s\S]*?"pushDown"[\s\S]*?"delete"[\s\S]*?"export"[\s\S]*?"print"/,
  "StandardDocument 必须通过 documentActionRules 统一生成单据生命周期动作"
);
assertContains(
  masterDataRecordPage + masterDataFormDialog,
  /sectionClasses\(section\)[\s\S]*?section-checkboxes[\s\S]*?field\.type === "checkbox"/,
  "主数据建档页必须支持 checkbox 横向布局"
);
assertContains(
  fieldRenderer,
  /"checkbox-field": props\.field\.type === "checkbox"/,
  "统一 FieldRenderer 必须给 checkbox 字段保留横向布局 class"
);
assertNotContains(
  masterDataRecordPage + masterDataFormDialog,
  /<em>\{\{ form\[field\.name\] === "true" \? "是" : "否" \}\}<\/em>/,
  "checkbox 字段不得再额外显示“是/否”文案"
);
assertContains(
  masterDataRegistry,
  /selectorColumns:\s*\[\s*\{ field:\s*"systemNo",\s*title:\s*"系统编号"[\s\S]*?visible:\s*false\s*\},\s*\{ field:\s*"code",\s*title:\s*"物料编码"/,
  "物料选择器必须隐藏系统编号，搜索显示仍以物料编码开头"
);
assertNotContains(
  masterDataRegistry,
  /selectorColumns:\s*\[[\s\S]*?\{ field:\s*"id",\s*title:\s*"系统ID"/,
  "物料选择器不得暴露 UUID 主键，搜索显示仍以物料编码/物料名称为主"
);
assertNotContains(
  masterDataRegistry + productMasterFields + customerMasterFields + supplierMasterFields + warehouseMasterFields,
  /title:\s*"系统ID"|label:\s*"系统ID"|field:\s*"id",\s*title:\s*"系统ID"/,
  "主数据页面不得把 UUID 主键作为用户可见字段"
);
assertContains(
  masterDataSystemNoMigration,
  /md_product_system_no_seq[\s\S]*?md_customer_system_no_seq[\s\S]*?md_supplier_system_no_seq[\s\S]*?md_warehouse_system_no_seq[\s\S]*?ALTER TABLE md_product ADD COLUMN IF NOT EXISTS system_no BIGINT[\s\S]*?CREATE UNIQUE INDEX IF NOT EXISTS uq_md_warehouse_system_no/,
  "物料、客户、供应商、仓库必须拥有只读可见系统编号 system_no，且 UUID 主键保持隐藏"
);
assertContains(
  masterDataCreateService + masterDataController + listBackendSources,
  /system_no::text AS "systemNo"/,
  "主数据新增、启停和列表接口必须返回 systemNo 给前端显示"
);
assertContains(
  productUnitWeightSnapshotMigration,
  /ALTER TABLE md_product[\s\S]*?net_weight NUMERIC\(18,2\)[\s\S]*?gross_weight NUMERIC\(18,2\)[\s\S]*?ADD COLUMN IF NOT EXISTS product_unit_snapshot[\s\S]*?ADD COLUMN IF NOT EXISTS net_weight_snapshot[\s\S]*?ADD COLUMN IF NOT EXISTS gross_weight_snapshot[\s\S]*?CREATE TRIGGER trg_fill_product_material_snapshot_attrs/,
  "V69 必须给物料主档和所有物料相关业务行补单位/净重/毛重快照字段与触发器"
);
for (const tableName of [
  "sales_quote_line",
  "sales_order_line",
  "delivery_notice_line",
  "sales_out_line",
  "purchase_order_line",
  "purchase_in_line",
  "purchase_return_line",
  "other_stock_in_line",
  "other_stock_out_line",
  "stock_transfer_line",
  "stock_count_line",
  "stock_count_gain_line",
  "stock_count_loss_line",
  "production_plan",
  "production_task",
  "production_task_material_snapshot",
  "production_material_issue_line",
  "production_completion_line"
]) {
  assertContains(
    productDisplaySnapshotMigration,
    new RegExp(`ALTER TABLE ${tableName}[\\s\\S]*?product_code_snapshot[\\s\\S]*?product_name_snapshot[\\s\\S]*?product_spec_snapshot[\\s\\S]*?UPDATE ${tableName}`),
    `${tableName} 必须落库并回填物料编码/名称/规格显示快照`
  );
  assertContains(
    productUnitWeightSnapshotMigration,
    new RegExp(`'${tableName}'`),
    `${tableName} 必须纳入单位/净重/毛重快照迁移`
  );
}
assertContains(
  productSnapshotService,
  /resolve\(String productId,\s*String productCode[\s\S]*?return byId\(productId\.trim\(\), label\)[\s\S]*?return byCode\(productCode\.trim\(\), label\)[\s\S]*?WHERE id = \?::uuid/,
  "ProductSnapshotService 必须优先用 UUID 解析物料快照，并兼容旧编码录入"
);
assertContains(
  productSnapshotService,
  /COALESCE\(unit,\s*''\) AS unit[\s\S]*?net_weight AS "netWeight"[\s\S]*?gross_weight AS "grossWeight"[\s\S]*?record ProductSnapshot\(String id,\s*String code,\s*String name,\s*String spec,\s*String unit,\s*BigDecimal netWeight,\s*BigDecimal grossWeight\)/,
  "ProductSnapshotService 必须解析物料单位、净重和毛重"
);
assertContains(
  documentModule,
  /documentLines:\s*\{[\s\S]*?productId\?:\s*string[\s\S]*?productId:\s*String\(line\.productId[\s\S]*?productId:\s*String\(line\.productId \?\? ""\)\.trim\(\) \|\| undefined/,
  "共享单据模块保存分录必须携带 productId，不能只传 productCode"
);
assertContains(
  documentModule,
  /line\.unit = option\.unit \?\? ""[\s\S]*?line\.netWeight = option\.netWeight \?\? ""[\s\S]*?line\.grossWeight = option\.grossWeight \?\? ""/,
  "共享单据模块选择物料后必须带出单位、净重和毛重"
);
assertContains(
  documentModule,
  /documentLines:[\s\S]*?unit:\s*line\.unit[\s\S]*?netWeight:\s*line\.netWeight[\s\S]*?grossWeight:\s*line\.grossWeight/,
  "共享单据模块保存分录必须提交单位、净重和毛重快照"
);
assertContains(
  `${listStubController}\n${documentOutputController}`,
  /COALESCE\(l\.product_code_snapshot,\s*p\.code\) AS "productCode"[\s\S]*?COALESCE\(l\.product_name_snapshot,\s*p\.name\) AS "productName"[\s\S]*?COALESCE\(l\.product_spec_snapshot,\s*p\.spec,\s*''\) AS spec/,
  "列表、详情和打印必须优先显示单据行保存时的物料快照"
);
assertContains(
  `${listStubController}\n${documentOutputController}`,
  /COALESCE\(l\.product_unit_snapshot,\s*p\.unit,\s*''\) AS unit[\s\S]*?COALESCE\(l\.net_weight_snapshot,\s*p\.net_weight\)[\s\S]*?AS "netWeight"[\s\S]*?COALESCE\(l\.gross_weight_snapshot,\s*p\.gross_weight\)[\s\S]*?AS "grossWeight"/,
  "列表、详情和打印必须优先显示单据行保存时的单位/净重/毛重快照"
);
assertContains(
  productSnapshotWriteServices,
  /ProductSnapshotService[\s\S]*?productSnapshotService\.resolve[\s\S]*?product_code_snapshot[\s\S]*?product_name_snapshot[\s\S]*?product_spec_snapshot/,
  "单据保存服务必须通过 ProductSnapshotService 写入物料显示快照"
);
for (const tableName of [
  "sales_quote_line",
  "sales_order_line",
  "delivery_notice_line",
  "sales_out_line",
  "purchase_order_line",
  "purchase_in_line",
  "purchase_return_line",
  "other_stock_in_line",
  "other_stock_out_line",
  "stock_transfer_line",
  "stock_count_line",
  "stock_count_gain_line",
  "stock_count_loss_line",
  "production_plan",
  "production_task",
  "production_task_material_snapshot",
  "production_material_issue_line",
  "production_completion_line"
]) {
  assertContains(
    productSnapshotWriteServices,
    new RegExp(`INSERT INTO ${tableName}[\\s\\S]*?product_code_snapshot[\\s\\S]*?product_name_snapshot[\\s\\S]*?product_spec_snapshot`),
    `${tableName} 新增/保存时必须写入物料显示快照`
  );
}
assertContains(
  conversionService,
  /product_code_snapshot[\s\S]*?product_name_snapshot[\s\S]*?product_spec_snapshot[\s\S]*?INSERT INTO %s[\s\S]*?product_code_snapshot[\s\S]*?product_name_snapshot[\s\S]*?product_spec_snapshot/,
  "盘点下推生成盘盈/盘亏时必须复制源盘点行物料快照"
);
assertContains(
  customerMasterFields,
  /客户编码[\s\S]*?客户名称[\s\S]*?联系人[\s\S]*?电话[\s\S]*?地区[\s\S]*?地址[\s\S]*?状态[\s\S]*?备注/,
  "客户资料本批只做轻主档字段"
);
assertNotContains(
  customerMasterFields,
  /信用额度|结算方式|税号|客户等级|负责业务员/,
  "客户资料在应收应付未深入前不能暴露信用、结算、税务等后置项"
);
assertContains(
  supplierMasterFields,
  /供应商编码[\s\S]*?供应商名称[\s\S]*?联系人[\s\S]*?电话[\s\S]*?地址[\s\S]*?状态[\s\S]*?备注/,
  "供应商资料本批只做轻主档字段"
);
assertNotContains(
  supplierMasterFields,
  /银行账号|结算方式|税号|供应商等级|采购负责人/,
  "供应商资料在应付、付款和质量准入未深入前不能暴露银行、结算、税务等后置项"
);
assertContains(
  warehouseMasterFields,
  /仓库编码[\s\S]*?仓库名称[\s\S]*?仓库类型[\s\S]*?仓管员[\s\S]*?仓库地址[\s\S]*?状态[\s\S]*?备注/,
  "仓库资料本批只做新建、状态管理和移仓引用所需字段"
);
assertNotContains(
  warehouseMasterFields,
  /库存策略|允许负库存/,
  "仓库资料暂不暴露库存策略和负库存配置"
);
assertNotContains(
  `${source}\n${fragments}\n${entryTable}`,
  /不含税单价/,
  "销售单据默认单价文案不得再使用“不含税单价”，应统一为“单价”"
);
assertNotContains(
  `${source}\n${fragments}\n${entryTable}`,
  /价税合计/,
  "销售单据金额文案不得再使用“价税合计”，应统一为“含税金额”"
);

const catalogSources = `${moduleCatalogSource}\n${stockAlertCatalogSource}`;
const catalogEntries = [...catalogSources.matchAll(/\{\s*id:\s*"([^"]+)"([^{}]*)\}/g)].map((match) => ({
  id: match[1],
  body: match[2],
  mode: match[2].match(/mode:\s*"([^"]+)"/)?.[1] ?? "",
  queryable: /queryable:\s*true/.test(match[2]),
  permission: match[2].match(/permission:\s*"([^"]+)"/)?.[1] ?? "",
  permissions: [...(match[2].match(/permissions:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)]
    .map((permissionMatch) => permissionMatch[1])
}));
const catalogIds = new Set(catalogEntries.map((entry) => entry.id));
const ownerCounts = new Map();
for (const feature of featureDeliveryStatus.features) {
  for (const catalogEntryId of feature.catalogEntryIds) {
    ownerCounts.set(catalogEntryId, (ownerCounts.get(catalogEntryId) ?? 0) + 1);
  }
}
for (const exception of featureDeliveryStatus.catalogExceptions) {
  ownerCounts.set(exception.catalogEntryId, (ownerCounts.get(exception.catalogEntryId) ?? 0) + 1);
}
for (const entryId of requiredFormalReportIds) {
  assertTrue(
    registeredReportDefinitionIds.filter((registeredEntryId) => registeredEntryId === entryId).length === 1,
    `A153 正式报表 ${entryId} 必须由 reportRegistry runtime definition 精确登记一次`
  );
}
for (const catalogEntry of catalogEntries) {
  if (!catalogEntry.queryable) continue;
  const registeredReport = catalogEntry.mode === "report" && registeredReportIds.has(catalogEntry.id);
  const requiredFormalReport = requiredFormalReportIds.has(catalogEntry.id);
  if (requiredFormalReport || registeredReport) {
    assertTrue(catalogEntry.mode === "report", `A153 正式报表 ${catalogEntry.id} 必须使用 report mode`);
    assertTrue(
      registeredReportDefinitionIds.filter((entryId) => entryId === catalogEntry.id).length === 1,
      `正式报表 catalog 入口 ${catalogEntry.id} 必须由 reportRegistry runtime import 的 definition 精确登记一次`
    );
  } else {
    const listKey = catalogEntry.mode === "form" ? `${catalogEntry.id}-list` : catalogEntry.id;
    const hasFrontendDefinition = dataListDefinitionSource.includes(`"${listKey}":`)
      || masterDataRegistry.includes(`"${listKey}":`);
    assertTrue(hasFrontendDefinition, `可查询 list/form catalog 入口 ${catalogEntry.id} 必须有精确前端 definition ${listKey}`);
    assertTrue(listQueryContractRegistry.includes(`"${listKey}"`), `可查询 list/form catalog 入口 ${catalogEntry.id} 必须有精确后端 contract ${listKey}`);
    assertTrue(
      listBackendSources.includes(`"${listKey}"`) || listKey === "operation-log-list",
      `可查询 list/form catalog 入口 ${catalogEntry.id} 必须有 provider/adapter 处置 ${listKey}`
    );
  }
  assertTrue(ownerCounts.get(catalogEntry.id) === 1, `可查询 catalog 入口 ${catalogEntry.id} 必须有唯一 delivery-status owner`);
  assertTrue(
    catalogEntry.permission || catalogEntry.permissions.length > 0 || catalogEntry.id === "bom-list",
    `可查询 catalog 入口 ${catalogEntry.id} 必须显式声明权限或登记认证用户例外`
  );
}

for (const [entryId, permissions] of [
  ["employee-master-list", ["master.data.manage", "system.role_permission.manage"]],
  ["financial-account-master-list", ["master.data.manage", "finance.settle"]]
]) {
  const entry = catalogEntries.find((candidate) => candidate.id === entryId);
  assertTrue(
    JSON.stringify(entry?.permissions ?? []) === JSON.stringify(permissions),
    `${entryId} catalog 必须保留显式 OR 权限 ${permissions.join(" OR ")}`
  );
}

for (const retiredEntryId of [
  "sales-detail-report",
  "sales-profit-report",
  "stock-flow-report",
  "scrap-report",
  "ar-summary-report",
  "coding-rule-list"
]) {
  assertTrue(!catalogIds.has(retiredEntryId), `未交付入口 ${retiredEntryId} 必须从 catalog 移除`);
  assertTrue((ownerCounts.get(retiredEntryId) ?? 0) === 0, `未交付入口 ${retiredEntryId} 不得继续作为 delivery-status catalog owner`);
}
for (const [featureId, remainingCatalogEntryIds] of [
  ["F029", ["sales-detail", "sales-summary", "sales-order-tracking"]],
  ["F042", ["inventory-movement-detail"]],
  ["F061", ["material-scrap-form", "material-scrap-summary"]],
  ["F091", ["receivable-detail", "receivable-summary", "payable-detail", "payable-summary"]],
  ["F093", ["numbering-rule-settings"]]
]) {
  const feature = featureDeliveryStatus.features.find((item) => item.id === featureId);
  assertTrue(feature, `delivery status 必须包含 ${featureId}`);
  assertTrue(JSON.stringify(feature.catalogEntryIds) === JSON.stringify(remainingCatalogEntryIds), `${featureId} catalog 归属必须与 6E 最终集合一致`);
  assertTrue(feature.state === "verified", `${featureId} 最终状态必须 verified`);
  assertTrue(feature.exposure === "published" && feature.surface === "catalog", `${featureId} 最终入口必须 published + catalog`);
  assertTrue(
    Object.values(feature.capabilityChecks ?? {}).length === 6
      && Object.values(feature.capabilityChecks).every((status) => status === "verified"),
    `${featureId} 六项 capability checks 必须全部 verified`
  );
}
assertTrue(!dataListDefinitionSource.includes("fallbackDefinition"), "列表定义不得保留 fallbackDefinition");
for (const [entryId, permission] of [
  ["purchase-summary-report", "purchase.order.audit"],
  ["task-track-report", "production.task.audit"]
]) {
  const entry = catalogEntries.find((candidate) => candidate.id === entryId);
  assertTrue(entry?.permission === permission, `${entryId} catalog 必须声明 ${permission}`);
  assertContains(listStubStateGuard, new RegExp(`"${entryId}"\\s*,\\s*"${permission}"`), `${entryId} 后端必须复用真实读权限 ${permission}`);
}
for (const [listKey, permission] of [
  ["stock-count-form-list", "inventory.stock_count.audit"],
  ["stock-count-gain-form-list", "inventory.stock_count_gain.audit"],
  ["stock-count-loss-form-list", "inventory.stock_count_loss.audit"]
]) {
  assertContains(listStubStateGuard, new RegExp(`"${listKey}"\\s*,\\s*"${permission}"`), `${listKey} 必须按精确盘点权限读取`);
}

console.log("A115 metadata definition regression passed");
