export async function addEntryLineBelow(page, testPrefix = "sales", lineIndex) {
  const targetIndex = lineIndex ?? await page.getByTestId(`${testPrefix}-entry-row`).count() - 1;
  if (targetIndex < 0) {
    throw new Error(`Cannot add entry line: no ${testPrefix} entry rows found`);
  }
  const suffix = targetIndex === 0 ? "" : `-${targetIndex + 1}`;
  await page.getByTestId(`${testPrefix}-entry-row`).nth(targetIndex).hover();
  await page.getByTestId(`${testPrefix}-line-insert${suffix}`).click();
}

export function entryLineTestId(testPrefix, fieldBase, lineIndex = 0) {
  const suffix = lineIndex === 0 ? "" : `-${lineIndex + 1}`;
  return `${testPrefix}-${fieldBase}${suffix}`;
}

export function entryRow(page, testPrefix, lineIndex = 0) {
  return page.getByTestId(`${testPrefix}-entry-row`).nth(lineIndex);
}

export async function entryCellText(page, testPrefix, fieldBase, lineIndex = 0) {
  const testId = entryLineTestId(testPrefix, fieldBase, lineIndex);
  return (await entryRow(page, testPrefix, lineIndex).locator(`[data-testid="${testId}"]`).last().innerText()).trim();
}

export async function entryInputValue(page, testPrefix, fieldBase, lineIndex = 0) {
  const testId = entryLineTestId(testPrefix, fieldBase, lineIndex);
  return entryRow(page, testPrefix, lineIndex).locator(`input[data-testid="${testId}"]`).inputValue();
}
