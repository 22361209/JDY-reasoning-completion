export async function loginAsAdmin(page, password = "admin123") {
  const loginPage = page.getByTestId("login-page");
  const visible = await loginPage.isVisible({ timeout: 1500 }).catch(() => false);
  if (!visible) {
    return;
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
