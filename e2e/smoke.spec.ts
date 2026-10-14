import { expect, test, type Page } from "@playwright/test";

// Records every request and CSP violation so tests can assert the app stays offline (DESIGN.md 2, 10.3).
function watch(page: Page, origin: string): { foreign: string[]; violations: string[] } {
  const foreign: string[] = [];
  const violations: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")) foreign.push(url);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy")) {
      violations.push(message.text());
    }
  });
  return { foreign, violations };
}

test("renders the app shell without network traffic or CSP violations", async ({ page, baseURL }) => {
  const seen = watch(page, new URL(baseURL ?? "").origin);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "trustchain" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Diagram canvas/ })).toBeVisible();

  const requestsAfterLoad: string[] = [];
  page.on("request", (request) => requestsAfterLoad.push(request.url()));
  await page.waitForLoadState("networkidle");
  await page.mouse.move(200, 200);
  await page.keyboard.press("Tab");

  expect(seen.foreign).toEqual([]);
  expect(seen.violations).toEqual([]);
  expect(requestsAfterLoad).toEqual([]);
});

test("ships the CSP from DESIGN.md 10.3", async ({ page }) => {
  await page.goto("/");
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).toContain("trusted-types 'none'");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
});

test("enforces Trusted Types and blocks network APIs at runtime", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(async () => {
    let htmlSinkBlocked = false;
    try {
      // eslint-disable-next-line no-restricted-syntax -- verifying the runtime block
      document.body.innerHTML = "<b>x</b>";
    } catch {
      htmlSinkBlocked = true;
    }
    let fetchBlocked = false;
    try {
      // eslint-disable-next-line no-restricted-globals -- verifying the runtime block
      await fetch("./index.html");
    } catch {
      fetchBlocked = true;
    }
    return { htmlSinkBlocked, fetchBlocked };
  });
  expect(outcome).toEqual({ htmlSinkBlocked: true, fetchBlocked: true });
});

test("refuses to render inside a frame", async ({ page, baseURL }) => {
  // The host page is about:blank, because the app's own CSP would block any child frame.
  await page.setContent(`<iframe title="embedded" src="${baseURL ?? ""}/"></iframe>`);
  const frame = page.frameLocator('iframe[title="embedded"]');
  await expect(frame.getByText("trustchain cannot run inside a frame.")).toBeVisible();
  await expect(frame.getByRole("heading", { name: "trustchain" })).toHaveCount(0);
});
