import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const execFile = promisify(execFileCallback);
const rootDir = path.resolve(process.env.JDY_ROOT || process.cwd());
const outputDir = path.join(rootDir, "backend", "src", "main", "resources", "master-data-import");
const qaDir = path.join(rootDir, "verification", "a143-template-qa");
const templateVersion = "1";
const maxDataRows = 5000;

const colors = {
  navy: "#17324D",
  blue: "#2563A6",
  sky: "#EAF3FB",
  orange: "#D97706",
  orangeSoft: "#FFF3D6",
  ink: "#23313F",
  muted: "#5D6B78",
  grid: "#CBD5DF",
  input: "#F8FBFE",
  white: "#FFFFFF",
};

const text = (key, label, required, description, width = 18) => ({
  key, label, required, description, width, kind: "text",
});
const decimal = (key, label, description, width = 14, defaultValue = "") => ({
  key, label, required: false, description, width, kind: "decimal", defaultValue,
});
const integer = (key, label, description, width = 14, defaultValue = "0") => ({
  key, label, required: false, description, width, kind: "integer", defaultValue,
});
const option = (key, label, required, values, description, width = 16, defaultValue = "") => ({
  key, label, required, values, description, width, kind: "option", defaultValue,
});

const status = option("status", "状态", false, ["启用", "禁用"], "留空默认启用。", 12, "启用");
const yesNo = (key, label, defaultValue) => option(
  key,
  label,
  false,
  ["是", "否", "true", "false"],
  `留空默认${defaultValue}；只允许 是/否 或 true/false。`,
  12,
  defaultValue,
);

const templates = [
  {
    type: "productCategory",
    slug: "product-category",
    title: "物料类别",
    fields: [
      text("code", "类别编码", true, "当前账套内唯一，最多 80 个字符；按文本填写。", 18),
      text("name", "类别名称", true, "当前账套内唯一，最多 120 个字符。", 22),
      text("parentCode", "上级类别编码", false, "可引用当前账套已有类别或本文件中的唯一类别编码；不得自指或成环。", 20),
      integer("sortNo", "排序", "非负整数，留空默认 0。", 12),
      status,
      text("remark", "备注", false, "可选用途说明。", 30),
    ],
  },
  {
    type: "unit",
    slug: "unit",
    title: "计量单位",
    fields: [
      text("code", "单位名称/编码", true, "名称与编码使用同一个值，当前账套内唯一，最多 80 个字符。", 22),
      integer("decimalPlaces", "数量小数位", "非负整数，留空默认 0。", 16),
      integer("sortNo", "排序", "非负整数，留空默认 0。", 12),
      status,
      text("remark", "备注", false, "可选用途说明。", 30),
    ],
  },
  {
    type: "customer",
    slug: "customer",
    title: "客户",
    fields: [
      text("code", "客户编码", true, "当前账套内唯一，最多 80 个字符；按文本填写。", 18),
      text("name", "客户名称", true, "最多 200 个字符。", 28),
      text("contact", "联系人", false, "最多 120 个字符。", 18),
      text("phone", "电话", false, "按文本填写，保留前导零，最多 80 个字符。", 18),
      text("region", "地区", false, "最多 160 个字符。", 18),
      text("address", "地址", false, "最多 300 个字符。", 32),
      status,
      text("remark", "备注", false, "可选业务说明。", 30),
    ],
  },
  {
    type: "supplier",
    slug: "supplier",
    title: "供应商",
    fields: [
      text("code", "供应商编码", true, "当前账套内唯一，最多 80 个字符；按文本填写。", 18),
      text("name", "供应商名称", true, "最多 200 个字符。", 28),
      text("contact", "联系人", false, "最多 120 个字符。", 18),
      text("phone", "电话", false, "按文本填写，保留前导零，最多 80 个字符。", 18),
      text("address", "地址", false, "最多 300 个字符。", 32),
      status,
      text("remark", "备注", false, "可选业务说明。", 30),
    ],
  },
  {
    type: "warehouse",
    slug: "warehouse",
    title: "仓库",
    fields: [
      text("code", "仓库编码", true, "当前账套内唯一，最多 80 个字符；按文本填写。", 18),
      text("name", "仓库名称", true, "最多 200 个字符。", 24),
      option(
        "warehouseType",
        "仓库类型",
        false,
        ["普通仓", "成品仓", "原料仓", "半成品仓", "不良品仓", "虚拟仓"],
        "留空默认普通仓。",
        16,
        "普通仓",
      ),
      text("manager", "仓管员", false, "普通文本，最多 120 个字符；不创建员工关联。", 18),
      text("address", "仓库地址", false, "最多 300 个字符。", 32),
      status,
      text("remark", "备注", false, "可选业务说明。", 30),
    ],
  },
  {
    type: "employee",
    slug: "employee",
    title: "员工",
    fields: [
      text("code", "员工编码", true, "当前账套内唯一，最多 80 个字符；按文本填写。", 18),
      text("name", "员工姓名", true, "最多 200 个字符。", 22),
      text("position", "岗位", false, "最多 120 个字符。", 18),
      text("department", "部门", false, "普通文本，最多 160 个字符；不创建生产部门关联。", 20),
      text("phone", "手机", false, "按文本填写，保留前导零，最多 80 个字符。", 18),
      text("email", "邮箱", false, "最多 200 个字符。", 26),
      status,
      text("remark", "备注", false, "可选职责或业务说明。", 30),
    ],
  },
  {
    type: "financialAccount",
    slug: "financial-account",
    title: "账户资料",
    fields: [
      text("code", "账户编码", true, "当前账套内唯一，最多 80 个字符；按文本填写。", 18),
      text("name", "账户名称", true, "最多 200 个字符。", 24),
      option("accountType", "账户类型", true, ["CASH", "BANK", "DEPOSIT"], "只允许 CASH/BANK/DEPOSIT。", 16),
      option("currency", "币种", true, ["CNY", "USD"], "只允许 CNY/USD。", 12),
      text("bankName", "开户行", false, "BANK/DEPOSIT 必填，CASH 必须留空；最多 200 个字符。", 24),
      text("accountNo", "账号", false, "BANK/DEPOSIT 必填，CASH 必须留空；按文本填写并保留前导零，最多 120 个字符。", 24),
      text("accountHolder", "户名", false, "BANK/DEPOSIT 必填，CASH 必须留空；最多 200 个字符。", 22),
      status,
      text("remark", "备注", false, "只记录账户用途，不填写余额或汇率。", 30),
    ],
  },
  {
    type: "product",
    slug: "product",
    title: "物料",
    fields: [
      text("code", "物料编码", true, "当前账套内唯一，最多 80 个字符；按文本填写。", 18),
      text("name", "物料名称", true, "最多 200 个字符。", 24),
      text("category", "物料类别编码", true, "必须是当前账套已审核且启用的物料类别编码。", 20),
      text("spec", "规格型号", false, "最多 200 个字符。", 24),
      text("unit", "计量单位编码", true, "必须是当前账套已审核且启用的计量单位编码，且编码最多 40 个字符。", 20),
      decimal("netWeight", "净重", "非负数，最多 2 位小数。"),
      decimal("grossWeight", "毛重", "非负数，最多 2 位小数。"),
      text("surfaceTreatment", "表面处理", false, "可选文本，最多 120 个字符。", 18),
      yesNo("isSale", "可销售", "是"),
      yesNo("isPurchase", "可采购", "否"),
      yesNo("isInventory", "可库存", "是"),
      yesNo("isProduce", "可自制", "是"),
      yesNo("isSubcontract", "可委外", "否"),
      decimal("purchasePrice", "采购价", "非负数，最多 6 位小数。", 14),
      decimal("costPrice", "参考成本", "非负数，最多 6 位小数。", 14),
      decimal("minSalePrice", "最低销售价", "非负数，最多 6 位小数。", 14),
      decimal("taxRate", "税率(%)", "非负数，留空默认 13。", 12, "13"),
      decimal("minStockQty", "最低库存数量", "非负数，最多 4 位小数。", 16),
      decimal("safetyStockQty", "安全库存数量", "非负数，最多 4 位小数。", 16),
      decimal("maxStockQty", "最高库存数量", "非负数，最多 4 位小数。", 16),
      text("defaultWorkshop", "默认生产车间编码", false, "可空；非空时必须是已审核且启用的生产部门编码。", 22),
      text("defaultWarehouseCode", "默认仓库编码", false, "可空；非空时必须是已审核且启用的仓库编码。", 20),
      text("defaultSupplierCode", "默认供应商编码", false, "可空；非空时必须是已审核且启用的供应商编码。", 20),
    ],
  },
];

function columnName(number) {
  let result = "";
  let value = number;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function displayHeader(field) {
  return `${field.required ? "*" : ""}${field.label}`;
}

function formatHint(field) {
  if (field.kind === "option") {
    return `枚举：${field.values.join(" / ")}`;
  }
  if (field.kind === "integer") {
    return "非负整数";
  }
  if (field.kind === "decimal") {
    return "非负十进制数";
  }
  return "文本";
}

function applyDataValidation(sheet, field, column) {
  const range = sheet.getRange(`${column}3:${column}${maxDataRows + 2}`);
  if (field.kind === "option") {
    range.dataValidation = { rule: { type: "list", values: field.values } };
  } else if (field.kind === "integer") {
    range.dataValidation = {
      rule: { type: "whole", operator: "between", formula1: 0, formula2: 2147483647 },
    };
  } else if (field.kind === "decimal") {
    range.dataValidation = {
      rule: { type: "decimal", operator: "greaterThanOrEqual", formula1: 0 },
    };
  }
}

function buildWorkbook(definition) {
  const workbook = Workbook.create();
  const dataSheet = workbook.worksheets.add("导入数据");
  const helpSheet = workbook.worksheets.add("填写说明");
  const metaSheet = workbook.worksheets.add("__meta");
  const lastColumn = columnName(definition.fields.length);

  dataSheet.showGridLines = false;
  dataSheet.mergeCells(`A1:${lastColumn}1`);
  dataSheet.getRange("A1").values = [[
    `${definition.title}导入模板 v${templateVersion}｜仅新增｜确认后保存为草稿｜最多 ${maxDataRows.toLocaleString("zh-CN")} 行 / 10 MiB`,
  ]];
  dataSheet.getRange(`A1:${lastColumn}1`).format = {
    fill: colors.sky,
    font: { bold: true, color: colors.navy, size: 12 },
    verticalAlignment: "center",
    wrapText: true,
  };
  dataSheet.getRange(`A1:${lastColumn}1`).format.rowHeight = 34;
  dataSheet.getRange(`A2:${lastColumn}2`).values = [definition.fields.map(displayHeader)];
  dataSheet.getRange(`A2:${lastColumn}2`).format = {
    fill: colors.navy,
    font: { bold: true, color: colors.white },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: colors.grid },
  };
  dataSheet.getRange(`A2:${lastColumn}2`).format.rowHeight = 32;
  dataSheet.getRange(`A3:${lastColumn}102`).format = {
    fill: colors.input,
    font: { color: colors.ink },
    verticalAlignment: "center",
    borders: { preset: "all", style: "thin", color: colors.grid },
  };
  dataSheet.getRange(`A3:${lastColumn}102`).format.rowHeight = 22;
  dataSheet.freezePanes.freezeRows(2);

  definition.fields.forEach((field, index) => {
    const column = columnName(index + 1);
    dataSheet.getRange(`${column}1:${column}102`).format.columnWidth = field.width;
    if (field.kind === "text" || field.key === "accountNo") {
      dataSheet.getRange(`${column}3:${column}${maxDataRows + 2}`).format.numberFormat = "@";
    } else if (field.kind === "integer") {
      dataSheet.getRange(`${column}3:${column}${maxDataRows + 2}`).format.numberFormat = "0";
    } else if (field.kind === "decimal") {
      dataSheet.getRange(`${column}3:${column}${maxDataRows + 2}`).format.numberFormat = "0.######";
    }
    applyDataValidation(dataSheet, field, column);
    if (field.required) {
      dataSheet.getRange(`${column}2`).format = {
        fill: colors.orange,
        font: { bold: true, color: colors.white },
        horizontalAlignment: "center",
        verticalAlignment: "center",
        wrapText: true,
        borders: { preset: "all", style: "thin", color: colors.grid },
      };
    }
  });

  helpSheet.showGridLines = false;
  helpSheet.mergeCells("A1:F1");
  helpSheet.getRange("A1").values = [[`${definition.title}导入填写说明`]];
  helpSheet.getRange("A1:F1").format = {
    fill: colors.navy,
    font: { bold: true, color: colors.white, size: 16 },
    verticalAlignment: "center",
  };
  helpSheet.getRange("A1:F1").format.rowHeight = 38;
  helpSheet.mergeCells("A2:F2");
  helpSheet.getRange("A2").values = [[
    "请勿修改 sheet 名、表头、__meta 或模板版本。先在“导入数据”第 3 行开始填写，再上传做服务端预检；任一行有错时整批写入 0 行。",
  ]];
  helpSheet.getRange("A2:F2").format = {
    fill: colors.orangeSoft,
    font: { color: colors.ink },
    wrapText: true,
    verticalAlignment: "center",
  };
  helpSheet.getRange("A2:F2").format.rowHeight = 44;
  helpSheet.mergeCells("A3:F3");
  helpSheet.getRange("A3").values = [[
    "固定规则：仅 .xlsx；只新增、不覆盖；导入结果为 DRAFT/version=0；编码和账号按文本填写；公式、宏、外链、加密或损坏文件会被拒绝。",
  ]];
  helpSheet.getRange("A3:F3").format = {
    fill: colors.sky,
    font: { color: colors.muted },
    wrapText: true,
    verticalAlignment: "center",
  };
  helpSheet.getRange("A3:F3").format.rowHeight = 36;
  helpSheet.getRange("A5:F5").values = [["列名", "字段键", "必填", "格式", "允许值 / 默认值", "填写说明"]];
  helpSheet.getRange("A5:F5").format = {
    fill: colors.blue,
    font: { bold: true, color: colors.white },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "all", style: "thin", color: colors.grid },
  };
  const helpRows = definition.fields.map((field) => [
    field.label,
    field.key,
    field.required ? "是" : "否",
    formatHint(field),
    field.kind === "option"
      ? `${field.values.join(" / ")}${field.defaultValue ? `；默认 ${field.defaultValue}` : ""}`
      : (field.defaultValue ? `默认 ${field.defaultValue}` : "—"),
    field.description,
  ]);
  const helpEndRow = 5 + helpRows.length;
  helpSheet.getRange(`A6:F${helpEndRow}`).values = helpRows;
  helpSheet.getRange(`A6:F${helpEndRow}`).format = {
    font: { color: colors.ink },
    verticalAlignment: "top",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: colors.grid },
  };
  helpSheet.getRange(`A6:F${helpEndRow}`).format.rowHeight = 38;
  [18, 22, 10, 18, 34, 62].forEach((width, index) => {
    const column = columnName(index + 1);
    helpSheet.getRange(`${column}1:${column}${helpEndRow}`).format.columnWidth = width;
  });
  helpSheet.freezePanes.freezeRows(5);

  metaSheet.showGridLines = false;
  metaSheet.getRange("A1:B7").values = [
    ["key", "value"],
    ["contract", "A143"],
    ["type", definition.type],
    ["version", templateVersion],
    ["dataSheet", "导入数据"],
    ["headerRow", "2"],
    ["maxDataRows", String(maxDataRows)],
  ];
  metaSheet.getRange("A1:B1").format = {
    fill: colors.navy,
    font: { bold: true, color: colors.white },
  };
  metaSheet.getRange("A1:B7").format.borders = { preset: "all", style: "thin", color: colors.grid };
  metaSheet.getRange("A1:A7").format.columnWidth = 18;
  metaSheet.getRange("B1:B7").format.columnWidth = 32;

  return workbook;
}

async function hideAndProtectMetaSheet(filePath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jdy-a143-xlsx-"));
  try {
    await execFile("/usr/bin/unzip", ["-qq", filePath, "-d", tempDir]);
    const workbookPath = path.join(tempDir, "xl", "workbook.xml");
    const workbookXml = await fs.readFile(workbookPath, "utf8");
    const hiddenXml = workbookXml.replace(
      /(<(?:[A-Za-z_][\w.-]*:)?sheet\b[^>]*\bname="__meta"[^>]*)(\s*\/>)/,
      (match, start, end) => `${start.replace(/\sstate="[^"]*"/, "")} state="veryHidden"${end}`,
    );
    if (hiddenXml === workbookXml || !hiddenXml.includes('name="__meta"')) {
      throw new Error(`failed to hide __meta sheet in ${filePath}`);
    }
    await fs.writeFile(workbookPath, hiddenXml, "utf8");

    const metaSheetPath = path.join(tempDir, "xl", "worksheets", "sheet3.xml");
    const metaXml = await fs.readFile(metaSheetPath, "utf8");
    const protectedXml = /<(?:[A-Za-z_][\w.-]*:)?sheetProtection\b/.test(metaXml)
      ? metaXml
      : metaXml.replace(
        /<([A-Za-z_][\w.-]*:)?sheetData\b/,
        (match, prefix = "") => `<${prefix}sheetProtection sheet="1" objects="1" scenarios="1"/>${match}`,
      );
    if (protectedXml === metaXml) {
      throw new Error(`failed to protect __meta sheet in ${filePath}`);
    }
    await fs.writeFile(metaSheetPath, protectedXml, "utf8");

    await fs.rm(filePath, { force: true });
    await execFile("/usr/bin/zip", ["-q", "-r", filePath, "."], { cwd: tempDir });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function verifyAndRender(definition, filePath) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
  const sheetInspection = await workbook.inspect({
    kind: "workbook,sheet",
    maxChars: 6000,
    tableMaxRows: 8,
    tableMaxCols: 8,
    tableMaxCellChars: 100,
  });
  const formulaInspection = await workbook.inspect({
    kind: "formula",
    sheetId: "导入数据",
    range: "A1:BL5002",
    maxChars: 3000,
    options: { maxResults: 20 },
  });
  if (formulaInspection.ndjson.includes('"kind":"formula"')) {
    throw new Error(`${definition.type} template unexpectedly contains formulas`);
  }

  for (const sheetName of ["导入数据", "填写说明"]) {
    const preview = await workbook.render({
      sheetName,
      autoCrop: "all",
      scale: 0.8,
      format: "png",
    });
    const previewPath = path.join(qaDir, `${definition.slug}-${sheetName === "导入数据" ? "data" : "guide"}.png`);
    await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
  }

  return {
    type: definition.type,
    file: path.relative(rootDir, filePath),
    fields: definition.fields.map(({ key, label, required, kind }) => ({ key, label, required, kind })),
    sheetInspection: sheetInspection.ndjson,
    formulaInspection: formulaInspection.ndjson,
    formulaCount: 0,
    formulaErrorCount: 0,
    renderedSheets: ["导入数据", "填写说明"],
  };
}

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(qaDir, { recursive: true });
const inspections = [];

for (const definition of templates) {
  const workbook = buildWorkbook(definition);
  const filePath = path.join(outputDir, `${definition.slug}.xlsx`);
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(filePath);
  await fs.rm(`${filePath}.inspect.ndjson`, { force: true });
  await hideAndProtectMetaSheet(filePath);
  inspections.push(await verifyAndRender(definition, filePath));
  await fs.rm(`${filePath}.inspect.ndjson`, { force: true });
}

await fs.writeFile(
  path.join(qaDir, "template-inspection.json"),
  `${JSON.stringify({ ok: true, templateVersion, templateCount: inspections.length, inspections }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`${JSON.stringify({ ok: true, templateCount: inspections.length, outputDir, qaDir })}\n`);
