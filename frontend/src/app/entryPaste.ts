import type { EntryPasteConflict, EntryPasteRefs, MasterOption, OrderLineForm } from "./documentModel";

export function masterRowToOption(row: Record<string, unknown>): MasterOption {
  return {
    code: String(row.code ?? ""),
    name: String(row.name ?? ""),
    spec: row.spec ? String(row.spec) : "",
    unit: row.unit ? String(row.unit) : ""
  };
}

export function mergeMasterOptions(primary: MasterOption[], fallback: MasterOption[]) {
  const byCode = new Map<string, MasterOption>();
  [...fallback, ...primary].forEach((option) => {
    if (option.code) {
      byCode.set(option.code, option);
    }
  });
  return Array.from(byCode.values());
}

export function parseEntryClipboard(
  text: string,
  refs: EntryPasteRefs,
  options: { fallbackWarehouseCode: string; defaultUnitPrice: number }
): { lines: OrderLineForm[]; conflicts: EntryPasteConflict[] } {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => row.split(/\t|,|;/).map((cell) => cell.trim()))
    .filter((cells) => cells.some(Boolean));
  if (rows.length === 0) {
    return { lines: [], conflicts: [] };
  }
  const header = detectEntryPasteHeader(rows[0]);
  const dataRows = header ? rows.slice(1) : rows;
  const lines: OrderLineForm[] = [];
  const conflicts: EntryPasteConflict[] = [];
  dataRows.forEach((cells) => {
    const parsed = parseEntryPasteRow(cells, refs, header, lines.length, options);
    if (parsed) {
      lines.push(parsed.line);
      if (parsed.conflict) {
        conflicts.push(parsed.conflict);
      }
    }
  });
  return { lines, conflicts };
}

function parseEntryPasteRow(
  cells: string[],
  refs: EntryPasteRefs,
  header: Record<string, number> | null,
  lineIndex: number,
  options: { fallbackWarehouseCode: string; defaultUnitPrice: number }
): { line: OrderLineForm; conflict?: EntryPasteConflict } | null {
  const productToken = cellByHeader(cells, header, "productCode", header ? -1 : 0);
  const productName = cellByHeader(cells, header, "productName", header ? -1 : 0);
  const productSpec = cellByHeader(cells, header, "spec", -1);
  const warehouseToken = cellByHeader(cells, header, "warehouseCode", header ? -1 : 1);
  const warehouseName = cellByHeader(cells, header, "warehouseName", -1);
  const qtyText = cellByHeader(cells, header, "qty", header ? -1 : 2);
  const priceText = cellByHeader(cells, header, "unitPrice", header ? -1 : 3);
  const productMatch = matchProduct(productToken, productName, productSpec, refs.products);
  if (!productMatch.product && !productToken && productMatch.candidates.length === 0) {
    return null;
  }
  const matchedWarehouse = matchMasterOption(warehouseToken || warehouseName, refs.warehouses);
  const line: OrderLineForm = {
    productId: productMatch.product?.id ?? "",
    productCode: productMatch.product?.code ?? productToken,
    productName: productMatch.product?.name,
    spec: productMatch.product?.spec ?? productSpec,
    warehouseCode: matchedWarehouse?.code ?? (warehouseToken || options.fallbackWarehouseCode),
    qty: normalizedPositiveNumber(qtyText, 1),
    unitPrice: normalizedPositiveNumber(priceText, options.defaultUnitPrice),
    lineRemark: ""
  };
  if (productMatch.candidates.length > 0) {
    return {
      line,
      conflict: {
        lineIndex,
        productText: [productName || productToken, productSpec].filter(Boolean).join(" / "),
        candidates: productMatch.candidates,
        activeIndex: 0
      }
    };
  }
  return { line };
}

function detectEntryPasteHeader(cells: string[]) {
  const header: Record<string, number> = {};
  cells.forEach((cell, index) => {
    const field = headerFieldName(cell);
    if (field && header[field] === undefined) {
      header[field] = index;
    }
  });
  return Object.keys(header).length >= 2 && (header.productCode !== undefined || header.productName !== undefined) ? header : null;
}

function headerFieldName(cell: string) {
  const aliases: Record<string, string> = {
    productcode: "productCode",
    productno: "productCode",
    product: "productCode",
    code: "productCode",
    商品编码: "productCode",
    商品代码: "productCode",
    商品编号: "productCode",
    物料编码: "productCode",
    编码: "productCode",
    商品名称: "productName",
    商品名: "productName",
    名称: "productName",
    物料名称: "productName",
    规格型号: "spec",
    规格: "spec",
    型号: "spec",
    spec: "spec",
    仓库编码: "warehouseCode",
    仓库代码: "warehouseCode",
    仓库编号: "warehouseCode",
    warehousecode: "warehouseCode",
    仓库: "warehouseName",
    仓库名称: "warehouseName",
    数量: "qty",
    qty: "qty",
    quantity: "qty",
    单价: "unitPrice",
    价格: "unitPrice",
    unitprice: "unitPrice",
    price: "unitPrice"
  };
  return aliases[normalizePasteText(cell)] ?? "";
}

function cellByHeader(cells: string[], header: Record<string, number> | null, field: string, fallbackIndex: number) {
  if (header && header[field] !== undefined) {
    return cells[header[field]]?.trim() ?? "";
  }
  return fallbackIndex >= 0 ? cells[fallbackIndex]?.trim() ?? "" : "";
}

function matchProduct(productToken: string, productName: string, productSpec: string, products: MasterOption[]): { product?: MasterOption; candidates: MasterOption[] } {
  const exactByCode = matchMasterOptionCode(productToken, products);
  if (exactByCode) {
    return { product: exactByCode, candidates: [] };
  }
  const normalizedName = normalizePasteText(productName || productToken);
  const normalizedSpec = normalizePasteText(productSpec);
  if (!normalizedName) {
    return { candidates: [] };
  }
  const sameName = products.filter((option) => normalizePasteText(option.name) === normalizedName);
  const exactNameAndSpec = sameName.filter((option) => normalizePasteText(option.spec ?? "") === normalizedSpec);
  if (normalizedSpec && exactNameAndSpec.length === 1) {
    return { product: exactNameAndSpec[0], candidates: [] };
  }
  if (sameName.length === 1 && (!normalizedSpec || exactNameAndSpec.length === 1)) {
    return { product: sameName[0], candidates: [] };
  }
  if (sameName.length > 1) {
    return { candidates: exactNameAndSpec.length > 1 ? exactNameAndSpec : sameName };
  }
  const joinedText = normalizePasteText(`${productName || productToken}${productSpec}`);
  const joinedMatches = products.filter((option) => normalizePasteText(`${option.name}${option.spec ?? ""}`) === joinedText);
  if (joinedMatches.length === 1) {
    return { product: joinedMatches[0], candidates: [] };
  }
  return joinedMatches.length > 1 ? { candidates: joinedMatches } : { candidates: [] };
}

function matchMasterOption(token: string, options: MasterOption[]) {
  const normalized = normalizePasteText(token);
  if (!normalized) {
    return undefined;
  }
  return matchMasterOptionCode(token, options)
    ?? options.find((option) => normalizePasteText(option.name) === normalized);
}

function matchMasterOptionCode(token: string, options: MasterOption[]) {
  const normalized = normalizePasteText(token);
  if (!normalized) {
    return undefined;
  }
  return options.find((option) => normalizePasteText(option.code) === normalized);
}

function normalizePasteText(value: string | undefined) {
  return String(value ?? "")
    .replace(/原材料/g, "原料")
    .replace(/\s+/g, "")
    .replace(/[（）()【】[\]]/g, "")
    .replace(/[/_.-]/g, "")
    .toLowerCase();
}

function normalizedPositiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
