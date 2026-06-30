export async function loginAs(page, username = "admin", password = "admin123", expectedRole = "", accountSetCode = "BLD-TEST") {
  let loginPage = page.getByTestId("login-page");
  let visible = await loginPage.isVisible({ timeout: 1500 }).catch(() => false);
  if (!visible) {
    const active = await page.evaluate(async (expectedAccountSetCode) => {
      try {
        const response = await fetch("/api/system/session");
        if (!response.ok) return false;
        const session = await response.json();
        return Boolean(session?.authenticated && (!expectedAccountSetCode || session?.tenant?.code === expectedAccountSetCode));
      } catch {
        return false;
      }
    }, accountSetCode).catch(() => false);
    if (active) {
      return;
    }
    await page.context().clearCookies();
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    }).catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded" });
    loginPage = page.getByTestId("login-page");
    visible = await loginPage.isVisible({ timeout: 5000 }).catch(() => false);
  }
  if (!visible) {
    throw new Error("login page did not appear for stale session recovery");
  }
  const usernameInput = page.getByTestId("login-username");
  if (await usernameInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    await usernameInput.fill(username);
  }
  const accountSetSelect = page.getByTestId("login-account-set");
  if (await accountSetSelect.isVisible({ timeout: 1000 }).catch(() => false)) {
    await accountSetSelect.selectOption(accountSetCode);
  }
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("content-area").waitFor({ state: "visible", timeout: 10000 });
  if (expectedRole) {
    await page.getByTestId("session-user-role").filter({ hasText: expectedRole }).waitFor({ state: "visible", timeout: 10000 });
  }
}

export async function loginAsAdmin(page, password = "admin123", accountSetCode = "BLD-TEST", username = "admin") {
  await loginAs(page, username, password, "系统管理员", accountSetCode);
}

export async function openAccountMenu(page) {
  const accountMenu = page.getByTestId("session-account-menu");
  if (await accountMenu.isVisible({ timeout: 1000 }).catch(() => false)) {
    const expanded = await accountMenu.evaluate((node) => node.parentElement?.hasAttribute("open") ?? false).catch(() => false);
    if (!expanded) {
      await accountMenu.click();
    }
    return;
  }
  const userName = page.getByTestId("session-user-name");
  if (await userName.isVisible({ timeout: 1000 }).catch(() => false)) {
    await userName.click();
    return;
  }
  throw new Error("account menu trigger not visible");
}

export async function logout(page) {
  const logoutButton = page.getByTestId("session-logout");
  if (!(await logoutButton.isVisible({ timeout: 500 }).catch(() => false))) {
    await openAccountMenu(page);
  }
  await page.getByTestId("session-logout").click();
  await page.getByTestId("login-page").waitFor({ state: "visible", timeout: 10000 });
}

export async function openPasswordChange(page) {
  const passwordButton = page.getByTestId("session-password-change");
  if (!(await passwordButton.isVisible({ timeout: 500 }).catch(() => false))) {
    await openAccountMenu(page);
  }
  await page.getByTestId("session-password-change").click();
}

export async function loginApi(apiBase, username = "admin", password = "admin123", accountSetCode = "BLD-TEST") {
  const response = await fetch(`${apiBase}/api/system/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, accountSetCode })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`api login failed ${response.status}: ${text}`);
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  const sessionCookie = setCookie.split(";")[0];
  if (!sessionCookie) {
    throw new Error("api login did not return a session cookie");
  }
  return sessionCookie;
}

export async function installApiSession(apiBase, username = "admin", password = "admin123", accountSetCode = "BLD-TEST") {
  let sessionCookie = await loginApi(apiBase, username, password, accountSetCode);
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith(apiBase) || url.includes("/api/system/login")) {
      return originalFetch(input, init);
    }
    const headers = new Headers(init.headers ?? (typeof input === "string" ? undefined : input.headers));
    if (!headers.has("Cookie")) {
      headers.set("Cookie", sessionCookie);
    }
    const response = await originalFetch(input, { ...init, headers });
    if (response.status !== 401) {
      return response;
    }
    sessionCookie = await loginApi(apiBase, username, password, accountSetCode);
    const retryHeaders = new Headers(init.headers ?? (typeof input === "string" ? undefined : input.headers));
    retryHeaders.set("Cookie", sessionCookie);
    return originalFetch(input, { ...init, headers: retryHeaders });
  };
  return sessionCookie;
}
