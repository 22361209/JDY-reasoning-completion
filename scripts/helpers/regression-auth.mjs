export async function loginAsAdmin(page, password = "admin123") {
  let loginPage = page.getByTestId("login-page");
  let visible = await loginPage.isVisible({ timeout: 1500 }).catch(() => false);
  if (!visible) {
    const active = await page.evaluate(async () => {
      try {
        const response = await fetch("/api/system/session");
        if (!response.ok) return false;
        const session = await response.json();
        return Boolean(session?.authenticated);
      } catch {
        return false;
      }
    }).catch(() => false);
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
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("content-area").waitFor({ state: "visible", timeout: 10000 });
}

export async function loginApi(apiBase, username = "admin", password = "admin123") {
  const response = await fetch(`${apiBase}/api/system/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
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

export async function installApiSession(apiBase, username = "admin", password = "admin123") {
  let sessionCookie = await loginApi(apiBase, username, password);
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
    sessionCookie = await loginApi(apiBase, username, password);
    const retryHeaders = new Headers(init.headers ?? (typeof input === "string" ? undefined : input.headers));
    retryHeaders.set("Cookie", sessionCookie);
    return originalFetch(input, { ...init, headers: retryHeaders });
  };
  return sessionCookie;
}
