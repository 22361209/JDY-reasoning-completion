import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { installApiSession, loginAsAdmin } from "./helpers/regression-auth.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const verificationDir = path.join(rootDir, "verification");
const screenshotDir = path.join(verificationDir, "playwright");
const resultPath = path.join(verificationDir, "a169-list-density-alignment-regression.json");
const frontendUrl = process.env.JDY_WEB_BASE || "http://127.0.0.1:5173/";
const apiBase = process.env.JDY_API_BASE || "http://127.0.0.1:8080";
const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

const listCases = [
  {
    key: "sales",
    label: "销售订单",
    moduleTestId: "module-销售管理",
    menuTestId: "query-sales-order-form",
    rootTestId: "list-page-sales-order-form-list",
    screenshot: true
  },
  {
    key: "purchase",
    label: "采购订单",
    moduleTestId: "module-采购管理",
    menuTestId: "query-purchase-order-form",
    rootTestId: "list-page-purchase-order-form-list"
  },
  {
    key: "inventory",
    label: "其他入库单",
    moduleTestId: "module-库存管理",
    menuTestId: "query-other-in-form",
    rootTestId: "list-page-other-in-form-list"
  },
  {
    key: "production",
    label: "生产计划",
    moduleTestId: "module-生产管理",
    menuTestId: "entry-production-plan-list",
    rootTestId: "list-page-production-plan-list",
    screenshot: true
  },
  {
    key: "master-data",
    label: "物料资料",
    moduleTestId: "module-基础资料",
    menuTestId: "entry-product-master-list",
    rootTestId: "list-page-product-master-list",
    screenshot: true
  }
];

await installApiSession(apiBase);
await mkdir(screenshotDir, { recursive: true });

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? "" : `: ${JSON.stringify(details)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function within(value, expected, tolerance = 0.75) {
  return Math.abs(value - expected) <= tolerance;
}

function allWithin(values, expected, tolerance = 0.75) {
  return values.length > 0 && values.every((value) => within(value, expected, tolerance));
}

async function openList(page, listCase) {
  await page.getByTestId(listCase.moduleTestId).hover();
  await page.getByTestId(listCase.menuTestId).click();
  const root = page.getByTestId(listCase.rootTestId);
  await root.waitFor({ state: "visible", timeout: 10000 });
  const frame = root.getByTestId("vxe-list-table");
  await frame.locator(".vxe-body--row").first().waitFor({ state: "visible", timeout: 10000 });
  return { root, frame };
}

async function measureEntryBaseline(page) {
  const frame = page.getByTestId("production-plan-entry-table-core");
  const row = page.locator('[data-testid="production-plan-entry-row"][data-line-no="1"]');
  await row.waitFor({ state: "visible", timeout: 10000 });
  return frame.evaluate((node) => {
    const rowNode = node.querySelector('[data-testid="production-plan-entry-row"][data-line-no="1"]');
    const cell = rowNode?.querySelector("td");
    const input = node.querySelector('[data-testid="production-plan-product-code-1"]');
    if (!(rowNode instanceof HTMLTableRowElement)
      || !(cell instanceof HTMLTableCellElement)
      || !(input instanceof HTMLInputElement)) {
      return { missing: true };
    }
    const rowRect = rowNode.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const cellStyle = getComputedStyle(cell);
    const inputStyle = getComputedStyle(input);
    return {
      rowHeight: rowRect.height,
      cellHeight: cellRect.height,
      inputHeight: inputRect.height,
      fontSize: cellStyle.fontSize,
      lineHeight: cellStyle.lineHeight,
      inputFontSize: inputStyle.fontSize,
      inputLineHeight: inputStyle.lineHeight,
      rowHeightVariable: getComputedStyle(node).getPropertyValue("--table-core-row-height").trim()
    };
  });
}

async function measureList(frame) {
  return frame.evaluate((node) => {
    const visibleRows = Array.from(node.querySelectorAll(".vxe-body--row"))
      .filter((row) => {
        const rect = row.getBoundingClientRect();
        const style = getComputedStyle(row);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      })
      .slice(0, 5);
    const firstRow = visibleRows[0];
    const firstCells = firstRow ? Array.from(firstRow.querySelectorAll(".vxe-body--column")) : [];
    const firstCell = firstCells[0];
    const firstContent = firstRow?.querySelector(".vxe-cell");
    const fixedCell = firstRow?.querySelector(".col--fixed");
    const checkboxCell = firstRow?.querySelector(".list-checkbox-column");
    const checkboxIcon = checkboxCell?.querySelector(".vxe-checkbox--icon");
    const headerRow = node.querySelector(".vxe-header--row");
    const body = node.querySelector(".vxe-table--body-wrapper");
    const footerCells = Array.from(node.querySelectorAll(".vxe-footer--row .vxe-footer--column"));
    const rect = (element) => element?.getBoundingClientRect();
    const frameStyle = getComputedStyle(node);
    const bodyStyle = body ? getComputedStyle(body) : null;
    const firstCellStyle = firstCell ? getComputedStyle(firstCell) : null;
    const firstContentStyle = firstContent ? getComputedStyle(firstContent) : null;
    const checkboxCellRect = rect(checkboxCell);
    const checkboxIconRect = rect(checkboxIcon);
    return {
      rowHeights: visibleRows.map((row) => rect(row)?.height ?? 0),
      cellHeights: firstCells.map((cell) => rect(cell)?.height ?? 0),
      fontSize: firstCellStyle?.fontSize ?? "",
      lineHeight: firstContentStyle?.lineHeight ?? "",
      bodyRowHeightVariable: bodyStyle?.getPropertyValue("--table-core-row-height").trim() ?? "",
      headerHeight: rect(headerRow)?.height ?? 0,
      fixedCellHeight: rect(fixedCell)?.height ?? 0,
      fixedCellPosition: fixedCell ? getComputedStyle(fixedCell).position : "",
      checkboxCellHeight: checkboxCellRect?.height ?? 0,
      checkboxIconWidth: checkboxIconRect?.width ?? 0,
      checkboxIconHeight: checkboxIconRect?.height ?? 0,
      checkboxCenterDelta: checkboxCellRect && checkboxIconRect
        ? Math.abs(
          (checkboxCellRect.top + checkboxCellRect.height / 2)
          - (checkboxIconRect.top + checkboxIconRect.height / 2)
        )
        : null,
      footerCellHeights: footerCells.map((cell) => rect(cell)?.height ?? 0),
      frameOverflowX: frameStyle.overflowX,
      frameOverflowY: frameStyle.overflowY,
      bodyOverflowX: bodyStyle?.overflowX ?? "",
      bodyOverflowY: bodyStyle?.overflowY ?? "",
      bodyBackgroundImage: bodyStyle?.backgroundImage ?? ""
    };
  });
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1803, height: 900 } });
const screenshots = [];

try {
  await page.goto(frontendUrl, { waitUntil: "networkidle" });
  await loginAsAdmin(page);

  await page.getByTestId("module-生产管理").hover();
  await page.getByTestId("entry-production-plan-list").click();
  await page.getByTestId("list-page-production-plan-list").waitFor({ state: "visible", timeout: 10000 });
  await page.getByTestId("list-create").click();
  await page.getByTestId("production-plan-form").waitFor({ state: "visible", timeout: 10000 });
  const entryBaseline = await measureEntryBaseline(page);
  assert(!entryBaseline.missing, "production-plan entry baseline should be measurable", entryBaseline);
  assert(entryBaseline.rowHeightVariable === "32px", "entry baseline should keep its 32px row variable", entryBaseline);
  assert(entryBaseline.cellHeight >= 30 && entryBaseline.cellHeight <= 33, "entry cell should remain around 32px", entryBaseline);
  assert(entryBaseline.inputHeight >= 28, "entry input should remain at least 28px high", entryBaseline);
  assert(entryBaseline.fontSize === entryBaseline.inputFontSize, "entry cell and input should share the same font size", entryBaseline);
  assert(entryBaseline.lineHeight === entryBaseline.inputLineHeight, "entry cell and input should share the same line height", entryBaseline);

  const lists = {};
  for (const listCase of listCases) {
    const { root, frame } = await openList(page, listCase);
    const metrics = await measureList(frame);
    assert(metrics.rowHeights.length > 0, `${listCase.label} should render visible rows`, metrics);
    assert(allWithin(metrics.rowHeights, entryBaseline.cellHeight), `${listCase.label} rows should match the entry-row height`, metrics);
    assert(allWithin(metrics.cellHeights, entryBaseline.cellHeight), `${listCase.label} cells should align within each 32px row`, metrics);
    assert(metrics.fontSize === entryBaseline.fontSize, `${listCase.label} font size should match the entry table`, metrics);
    assert(metrics.lineHeight === entryBaseline.lineHeight, `${listCase.label} line height should match the entry table`, metrics);
    assert(metrics.bodyRowHeightVariable === "32px", `${listCase.label} body should consume the 32px list-row variable`, metrics);
    assert(metrics.headerHeight >= 27 && metrics.headerHeight <= 29, `${listCase.label} header should remain around 28px`, metrics);
    assert(metrics.fixedCellPosition === "sticky", `${listCase.label} fixed checkbox column should remain sticky`, metrics);
    assert(within(metrics.fixedCellHeight, entryBaseline.cellHeight), `${listCase.label} fixed column should match body-row height`, metrics);
    assert(within(metrics.checkboxCellHeight, entryBaseline.cellHeight), `${listCase.label} checkbox cell should match body-row height`, metrics);
    assert(within(metrics.checkboxIconWidth, 14, 0.25) && within(metrics.checkboxIconHeight, 14, 0.25), `${listCase.label} checkbox icon should remain 14px`, metrics);
    assert(metrics.checkboxCenterDelta !== null && metrics.checkboxCenterDelta <= 2, `${listCase.label} checkbox should remain vertically centered`, metrics);
    assert(metrics.footerCellHeights.length === 0 || Math.max(...metrics.footerCellHeights) - Math.min(...metrics.footerCellHeights) <= 0.5, `${listCase.label} footer cells should stay aligned`, metrics);
    assert(metrics.frameOverflowX === "scroll" && metrics.frameOverflowY === "hidden", `${listCase.label} frame should keep the shared horizontal-scroll boundary`, metrics);
    assert(metrics.bodyOverflowX === "hidden" && ["auto", "scroll"].includes(metrics.bodyOverflowY), `${listCase.label} body should keep the shared vertical-scroll boundary`, metrics);
    assert(
      listCase.key === "master-data" || metrics.bodyBackgroundImage.includes("repeating-linear-gradient"),
      `${listCase.label} blank-row grid should remain tied to row density`,
      metrics
    );
    lists[listCase.key] = metrics;

    if (listCase.screenshot) {
      const screenshotName = `a169-${listCase.key}-list-${batch}.png`;
      await root.screenshot({ path: path.join(screenshotDir, screenshotName) });
      screenshots.push(`verification/playwright/${screenshotName}`);
    }
  }

  const result = {
    batch,
    generatedAt: new Date().toISOString(),
    frontendUrl,
    apiBase,
    ok: true,
    entryBaseline,
    lists,
    screenshots
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
