export async function clickNewDocument(page, { confirmUnsaved = true } = {}) {
  await page.getByTestId("new-document").click();
  const dialog = page.getByTestId("new-document-unsaved-dialog");
  if (await dialog.isVisible().catch(() => false)) {
    if (!confirmUnsaved) {
      throw new Error("Unexpected unsaved-new dialog");
    }
    await page.getByTestId("new-document-unsaved-confirm").click();
    await dialog.waitFor({ state: "hidden" });
  }
}

export async function saveDocument(page, {
  buttonTestId = "save-sales-order",
  expectedText = "草稿已保存",
  timeout = 10000
} = {}) {
  await page.getByTestId(buttonTestId).click();
  if (expectedText) {
    await page.getByText(expectedText).waitFor({ state: "visible", timeout });
  }
}

export async function auditDocument(page, {
  buttonTestId = "audit-sales-order",
  expectedText = "审核成功",
  timeout = 10000
} = {}) {
  await page.getByTestId(buttonTestId).click();
  if (expectedText) {
    await page.getByText(expectedText).waitFor({ state: "visible", timeout });
  }
}

export async function saveAndAuditDocument(page, options = {}) {
  await saveDocument(page, options.save ?? {});
  await auditDocument(page, options.audit ?? {});
}

export async function openRiskyActionDialog(page, actionTestId) {
  await page.getByTestId(actionTestId).click();
  const dialog = page.getByTestId("risky-action-dialog");
  await dialog.waitFor({ state: "visible" });
  return dialog.innerText();
}

export async function cancelRiskyAction(page) {
  const dialog = page.getByTestId("risky-action-dialog");
  await page.getByTestId("risky-action-cancel").click();
  await dialog.waitFor({ state: "hidden" }).catch(() => undefined);
}

export async function confirmRiskyAction(page) {
  const dialog = page.getByTestId("risky-action-dialog");
  await page.getByTestId("risky-action-confirm").click();
  await dialog.waitFor({ state: "hidden" }).catch(() => undefined);
}

export async function openSalesOutSourceSelector(page) {
  await page.getByTestId("sales-out-open-source-selector").click();
  await page.getByTestId("sales-out-source-selector-dialog").waitFor({ state: "visible" });
}

export async function confirmSalesOutSourceSelector(page) {
  const dialog = page.getByTestId("sales-out-source-selector-dialog");
  await page.getByTestId("sales-out-source-selector-ok").click();
  await dialog.waitFor({ state: "hidden" }).catch(() => undefined);
}
