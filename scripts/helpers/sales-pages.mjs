import { confirmSalesOutSourceSelector, openSalesOutSourceSelector } from "./document-actions.mjs";

export async function openSalesOrderListAndSelect(page, billNo) {
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("query-sales-order-form").click();
  await page.getByTestId("tab-sales-order-form-list").waitFor({ state: "visible" });
  await page.getByTestId("list-keyword").fill(billNo);
  await page.getByTestId("list-keyword").press("Enter");
  const row = page.locator(".vxe-body--row", { hasText: billNo }).first();
  await row.waitFor({ state: "visible" });
  await row.locator(".vxe-checkbox--icon").first().click();
}

export async function openNewSalesOut(page) {
  await page.getByTestId("module-销售管理").hover();
  await page.getByTestId("entry-sales-out-form").click();
  await page.getByTestId("sales-out-party-code").waitFor({ state: "visible" });
}

export async function selectSalesOutSourceLines(page, billNo, lineNos) {
  for (const lineNo of lineNos) {
    await page.getByTestId(`sales-out-source-line-${billNo}:${lineNo}`).check();
  }
}

export async function chooseSalesOutSourceLines(page, { billNo, lineNos, search = "" }) {
  await chooseSalesOutSourceSelections(page, { selections: [{ billNo, lineNos }], search });
}

export async function chooseSalesOutSourceSelections(page, { selections, search = "" }) {
  await openSalesOutSourceSelector(page);
  if (search) {
    await page.getByTestId("sales-out-source-selector-search").fill(search);
  }
  for (const selection of selections) {
    await selectSalesOutSourceLines(page, selection.billNo, selection.lineNos);
  }
  await confirmSalesOutSourceSelector(page);
  const expectedRows = selections.reduce((sum, selection) => sum + selection.lineNos.length, 0);
  if (expectedRows > 1) {
    await page.getByTestId(`sales-out-line-product-${expectedRows}`).waitFor({ state: "visible" });
  } else {
    await page.getByTestId("sales-out-line-product").waitFor({ state: "visible" });
  }
}

export async function readSalesOutLines(page, count = 2) {
  return {
    sources: await readEntryValues(count, (index) => lineSourceText(page, "sales-out", index)),
    products: await readEntryValues(count, (index) => lineInputValue(page, "sales-out-line-product", index)),
    warehouses: await readEntryValues(count, (index) => lineInputValue(page, "sales-out-line-warehouse", index)),
    qtys: await readEntryValues(count, async (index) => Number(await lineInputValue(page, "sales-out-line-qty", index))),
    prices: await readEntryValues(count, async (index) => Number(await lineInputValue(page, "sales-out-line-price", index))),
    remarks: await readEntryValues(count, (index) => lineInputValue(page, "sales-out-line-remark", index)),
    planDates: await readEntryValues(count, (index) => lineInputValue(page, "sales-out-line-plan-delivery-date", index))
  };
}

export async function lineSourceText(page, prefix, index) {
  const suffix = lineSuffix(index);
  const orderNo = (await page.getByTestId(`${prefix}-line-source-order-no${suffix}`).innerText()).trim();
  const lineNo = (await page.getByTestId(`${prefix}-line-source-line-no${suffix}`).innerText()).trim();
  return `${orderNo} / ${lineNo}`;
}

export function assertEntryArrays(name, actual, expected) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      throw new Error(`${name} ${key} expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`);
    }
  }
}

async function readEntryValues(count, reader) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    values.push(await reader(index));
  }
  return values;
}

async function lineInputValue(page, testPrefix, index) {
  return page.getByTestId(`${testPrefix}${lineSuffix(index)}`).inputValue();
}

function lineSuffix(index) {
  return index === 0 ? "" : `-${index + 1}`;
}
