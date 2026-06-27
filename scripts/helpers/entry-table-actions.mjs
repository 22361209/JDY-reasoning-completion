export async function addEntryLineBelow(page, testPrefix = "sales", lineIndex) {
  const targetIndex = lineIndex ?? await page.getByTestId(`${testPrefix}-entry-row`).count() - 1;
  if (targetIndex < 0) {
    throw new Error(`Cannot add entry line: no ${testPrefix} entry rows found`);
  }
  const suffix = targetIndex === 0 ? "" : `-${targetIndex + 1}`;
  await page.getByTestId(`${testPrefix}-entry-row`).nth(targetIndex).hover();
  await page.getByTestId(`${testPrefix}-line-insert${suffix}`).click();
}
