import { expect, test, type Page, type Route } from "@playwright/test";
import { readFile } from "node:fs/promises";

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const DEFAULT_HOSTS = ["www.google.com", "www.youtube.com", "chatgpt.com", "github.com", "www.baidu.com", "www.bilibili.com"];
type ProbeRequest = { host: string; url: string; headers: Record<string, string> };

test.beforeAll(async ({ browser }) => {
  console.info(`Website-check browser: ${browser.version()}`);
});

/** Keep CI offline while exercising browser fetch, opaque responses and AbortSignal.
 * Fulfilled requests are transport fixtures, never public-network measurements. */
async function interceptProbes(page: Page, respond?: (route: Route, attempt: number) => Promise<void>) {
  const requests: ProbeRequest[] = [];
  const unexpected: string[] = [];
  const counts = new Map<string, number>();
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === "http://127.0.0.1:4178") {
      if (url.pathname.startsWith("/api/")) {
        unexpected.push(url.pathname);
        await route.abort();
      } else await route.continue();
      return;
    }
    if (!url.searchParams.has("routekit_probe")) {
      unexpected.push(url.origin + url.pathname);
      await route.abort();
      return;
    }
    requests.push({ host: url.hostname, url: url.href, headers: route.request().headers() });
    const attempt = (counts.get(url.hostname) ?? 0) + 1;
    counts.set(url.hostname, attempt);
    if (respond) await respond(route, attempt);
    else await respondWithImage(route);
  });
  return { requests, unexpected, counts };
}

async function respondWithImage(route: Route, status = 200) {
  await route.fulfill({ status, contentType: "image/png", body: PIXEL });
}

const panel = (page: Page) => page.getByRole("region", { name: "主要网站连通检测", exact: true });
const start = (page: Page) => panel(page).getByRole("button", { name: /^(开始网站检测|重新检测所选网站)$/ });

async function visit(page: Page) {
  await page.goto("/?view=network&tool=websites");
  await expect(panel(page).getByRole("heading", { name: "常用的网站，现在通吗？", exact: true })).toBeVisible();
}

async function onlyGoogle(page: Page) {
  await panel(page).locator(".website-selection > summary").click();
  await panel(page).getByRole("button", { name: "搜索资讯", exact: true }).click();
  await panel(page).getByRole("checkbox", { name: "Wikipedia", exact: true }).uncheck();
}

async function report(page: Page) {
  const pending = page.waitForEvent("download");
  await panel(page).getByRole("button", { name: "导出报告", exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("routekit-website-check.json");
  return JSON.parse(await readFile((await download.path())!, "utf8"));
}

test("opening website checks sends nothing; starting samples each default website three times", async ({ page }) => {
  const traffic = await interceptProbes(page);
  await visit(page);
  await expect(panel(page).locator(".website-card")).toHaveCount(6);
  expect(traffic.requests).toHaveLength(0);
  await expect(panel(page).getByRole("button", { name: "导出报告", exact: true })).toBeDisabled();
  await start(page).click();
  await expect(panel(page).locator('.website-card[data-status="responded"]')).toHaveCount(6);
  expect(traffic.requests).toHaveLength(18);
  expect([...traffic.counts.keys()].sort()).toEqual([...DEFAULT_HOSTS].sort());
  for (const host of DEFAULT_HOSTS) expect(traffic.counts.get(host)).toBe(3);
  expect(new Set(traffic.requests.map(request => request.url)).size).toBe(18);
  expect(traffic.unexpected).toEqual([]);
});

test("opaque error-page responses remain HTTP-unknown and omit cookies and referrers", async ({ page, context }) => {
  await context.addCookies([{ name: "website-test-session", value: "fixture-only", domain: ".google.com", path: "/", secure: true, sameSite: "None" }]);
  const traffic = await interceptProbes(page, route => respondWithImage(route, 503));
  await visit(page);
  await onlyGoogle(page);
  await start(page).click();
  const google = page.getByTestId("website-google");
  await expect(google).toHaveAttribute("data-status", "responded");
  await expect(google.locator(".website-state")).toHaveText("收到响应");
  await google.locator(".website-detail > summary").click();
  await expect(google.locator(".website-detail")).toContainText("跨域隐藏 HTTP 状态");
  await expect(google.locator(".website-state")).not.toContainText("HTTP 200");
  await expect(panel(page).locator(".website-boundary")).toContainText("地区解锁需打开原站确认");
  const data = await report(page);
  expect(data.scope).toBe("browser-current-route");
  expect(data.websites[0].samples).toHaveLength(3);
  for (const sample of data.websites[0].samples) {
    expect(sample.outcome).toBe("response");
    expect(sample.visibility).toBe("opaque");
    expect(sample.httpStatus).toBeUndefined();
  }
  for (const request of traffic.requests) {
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
  }
  expect(traffic.unexpected).toEqual([]);
});

test("partial and failed sites keep unknown medians and provide an actionable next step", async ({ page }) => {
  await interceptProbes(page, async (route, attempt) => {
    if (new URL(route.request().url()).hostname === "www.google.com" && attempt === 1) await respondWithImage(route);
    else await route.abort("failed");
  });
  await visit(page);
  await start(page).click();
  const google = page.getByTestId("website-google");
  await expect(google).toHaveAttribute("data-status", "partial");
  await expect(google.locator(".website-value strong")).toHaveText("—ms");
  await expect(google.locator('.website-samples [data-outcome="response"]')).toHaveCount(1);
  await expect(google.locator(".website-card-help")).toContainText("先打开原站确认");
  await expect(page.getByTestId("website-github")).toHaveAttribute("data-status", "failed");
  await expect(page.getByTestId("website-github").locator(".website-value strong")).toHaveText("—ms");
  await expect(google.getByRole("link", { name: "打开网站", exact: true })).toHaveAttribute("href", "https://www.google.com/");
});

test("a readable Discord rate-limit response reports HTTP 429 without a success median", async ({ page }) => {
  const traffic = await interceptProbes(page, route => route.fulfill({
    status: 429,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    body: JSON.stringify({ message: "rate limited" }),
  }));
  await visit(page);
  await panel(page).locator(".website-selection > summary").click();
  await panel(page).getByRole("button", { name: "影音社交", exact: true }).click();
  for (const name of ["Telegram", "YouTube", "Netflix"]) {
    await panel(page).getByRole("checkbox", { name, exact: true }).uncheck();
  }
  await start(page).click();
  const discord = page.getByTestId("website-discord");
  await expect(discord).toHaveAttribute("data-status", "failed");
  await expect(discord.locator(".website-value strong")).toHaveText("—ms");
  await expect(discord.locator('.website-samples [data-outcome="http-error"]')).toHaveCount(3);
  await expect(discord.locator(".website-samples")).toContainText("HTTP 429");
  expect(traffic.requests).toHaveLength(3);
  expect(traffic.requests.every(request => new URL(request.url).pathname === "/api/v10/gateway")).toBe(true);
  const data = await report(page);
  for (const sample of data.websites[0].samples) {
    expect(sample).toMatchObject({ outcome: "http-error", visibility: "readable", httpStatus: 429 });
  }
});

test("stop cancels in-flight samples and never starts queued websites", async ({ page }) => {
  const held: Route[] = [];
  const traffic = await interceptProbes(page, async route => { held.push(route); });
  await visit(page);
  await start(page).click();
  await expect.poll(() => held.length).toBe(4);
  await panel(page).getByRole("button", { name: "停止网站检测", exact: true }).click();
  await expect(panel(page).getByRole("status")).toContainText("检测已停止");
  await expect(panel(page).locator('.website-card[data-status="stopped"]')).toHaveCount(6);
  await expect(panel(page).locator(".website-summary")).toContainText("0 / 6 完成");
  await Promise.all(held.map(route => respondWithImage(route).catch(() => undefined)));
  await page.waitForTimeout(200);
  expect(traffic.requests).toHaveLength(4);
  await expect(start(page)).toBeEnabled();
});

test("leaving the website category cancels work and returning does not resume requests", async ({ page }) => {
  const held: Route[] = [];
  const traffic = await interceptProbes(page, async route => { held.push(route); });
  await visit(page);
  await start(page).click();
  await expect.poll(() => held.length).toBe(4);
  const navigation = page.getByRole("navigation", { name: "工具分类", exact: true });
  await navigation.getByRole("button", { name: "主机查询", exact: true }).click();
  await expect(panel(page)).toBeHidden();
  await Promise.all(held.map(route => respondWithImage(route).catch(() => undefined)));
  await navigation.getByRole("button", { name: "网站连通", exact: true }).click();
  await expect(panel(page).getByRole("status")).toContainText("检测已停止");
  await page.waitForTimeout(200);
  expect(traffic.requests).toHaveLength(4);
  await expect(panel(page).locator('.website-card[data-status="stopped"]')).toHaveCount(6);
});

test("a baseline cannot turn missing samples in the next round into a speed improvement", async ({ page }) => {
  await interceptProbes(page, async (route, attempt) => {
    if (attempt <= 4) await respondWithImage(route);
    else await route.abort("failed");
  });
  await visit(page);
  await onlyGoogle(page);
  await panel(page).getByRole("textbox", { name: "线路备注", exact: true }).fill("线路 A");
  await start(page).click();
  const google = page.getByTestId("website-google");
  await expect(google).toHaveAttribute("data-status", "responded");
  await panel(page).getByRole("button", { name: "记为对照", exact: true }).click();
  await panel(page).getByRole("textbox", { name: "线路备注", exact: true }).fill("线路 B");
  await start(page).click();
  await expect(google).toHaveAttribute("data-status", "partial");
  await expect(google.locator(".website-delta")).toHaveAttribute("data-direction", "unknown");
  await expect(google.locator(".website-delta")).toContainText("样本不足，暂不比较耗时");
  await expect(google.locator(".website-delta")).not.toContainText(/快\s*0|耗时相同/);
  const data = await report(page);
  expect(data.label).toBe("线路 B");
  expect(data.baseline.label).toBe("线路 A");
  expect(data.websites[0].baseline.samples.every((sample: { outcome: string }) => sample.outcome === "response")).toBe(true);
});

test("single-site retry sends only that site's requests and downloads that round", async ({ page }) => {
  const traffic = await interceptProbes(page);
  await visit(page);
  await start(page).click();
  await expect(panel(page).locator('.website-card[data-status="responded"]')).toHaveCount(6);
  await page.getByRole("button", { name: "重测 GitHub", exact: true }).click();
  await expect(panel(page).locator('.website-card[data-status="responded"]')).toHaveCount(1);
  expect(traffic.requests).toHaveLength(21);
  expect(traffic.requests.slice(18).map(request => request.host)).toEqual(["github.com", "github.com", "github.com"]);
  const data = await report(page);
  expect(data.websites).toHaveLength(1);
  expect(data.websites[0]).toMatchObject({ id: "github", name: "GitHub", state: "done" });
  expect(data.websites[0].samples).toHaveLength(3);
  expect(data.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(data.meaning).toContain("not ICMP ping");
});

test("category selection narrows the actual requests and an empty selection cannot run", async ({ page }) => {
  const traffic = await interceptProbes(page);
  await visit(page);
  await panel(page).locator(".website-selection > summary").click();
  await panel(page).getByRole("button", { name: "AI 助手", exact: true }).click();
  await panel(page).getByRole("checkbox", { name: "ChatGPT", exact: true }).uncheck();
  await panel(page).getByRole("checkbox", { name: "Claude", exact: true }).uncheck();
  await expect(start(page)).toBeDisabled();
  expect(traffic.requests).toHaveLength(0);
  await panel(page).getByRole("button", { name: "AI 助手", exact: true }).click();
  await start(page).click();
  await expect(panel(page).locator('.website-card[data-status="responded"]')).toHaveCount(2);
  expect(traffic.requests).toHaveLength(6);
  expect([...traffic.counts.keys()].sort()).toEqual(["chatgpt.com", "claude.ai"]);
});

test("invalid routing edits are explained as configuration errors instead of missing IP data", async ({ page }) => {
  const traffic = await interceptProbes(page);
  await page.goto("/?view=config&tool=apps");
  await page.getByRole("button", { name: "高级模式", exact: true }).click();
  await page.getByRole("tab", { name: "自定义", exact: true }).click();
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page.getByRole("textbox", { name: "规则 1 值", exact: true }).fill("invalid domain");
  await expect(page.locator(".validation-errors")).toContainText("无效的域名");
  await page.getByRole("navigation", { name: "工具分类", exact: true }).getByRole("button", { name: "网站连通", exact: true }).click();
  const google = page.getByTestId("website-google");
  await expect(google.locator(".website-detail > summary")).toHaveText("配置预期：配置需修正");
  await google.locator(".website-detail > summary").click();
  await expect(google.locator(".website-detail")).toContainText("请先修正配置：无效的域名：invalid domain");
  await expect(google.locator(".website-detail > summary")).not.toContainText("需解析 IP");
  await expect(start(page)).toBeEnabled();
  expect(traffic.requests).toHaveLength(0);
});

test("mobile deep links fit the viewport and routing links retain edits in application routing", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const traffic = await interceptProbes(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await visit(page);
  const navigation = page.getByRole("navigation", { name: "工具分类", exact: true });
  await expect(navigation.getByRole("button", { name: "网站连通", exact: true })).toHaveAttribute("aria-current", "page");
  await panel(page).locator(".website-selection > summary").click();
  const youtube = page.getByTestId("website-youtube");
  await youtube.locator(".website-detail > summary").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await youtube.getByRole("button", { name: "去应用分流调整", exact: true }).click();
  await expect(page).toHaveURL(/view=config&tool=apps$/);
  await page.getByRole("textbox", { name: "方案名称", exact: true }).fill("保留现有分流");
  const kugouProxy = page.getByRole("group", { name: "酷狗音乐连接方式", exact: true }).getByRole("button", { name: "代理", exact: true });
  await kugouProxy.click();
  await navigation.getByRole("button", { name: "网络检查", exact: true }).click();
  await navigation.getByRole("button", { name: "网站连通", exact: true }).click();
  await youtube.getByRole("button", { name: "去应用分流调整", exact: true }).click();
  await expect(page).toHaveURL(/view=config&tool=apps$/);
  await expect(page.getByRole("tab", { name: "应用分流", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: "方案名称", exact: true })).toHaveValue("保留现有分流");
  await expect(kugouProxy).toHaveAttribute("aria-pressed", "true");
  expect(traffic.requests).toHaveLength(0);
  expect(traffic.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
