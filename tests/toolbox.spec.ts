import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("network overview only measures on request and reports real response failures", async ({
  page,
}) => {
  let ipRequests = 0;
  let latencyRequests = 0;
  await page.route("**/api/connection", (route) => {
    ipRequests++;
    return route.fulfill({
      json: {
        source: "cloudflare-request",
        local: false,
        ip: "198.51.100.23",
        ipVersion: "IPv4",
        country: "US",
        region: "California",
        city: "Los Angeles",
        asn: 64500,
        organization: "Example network",
        colo: "LAX",
        tlsVersion: "TLSv1.3",
        timestamp: new Date().toISOString(),
      },
    });
  });
  await page.route("https://speed.cloudflare.com/**", (route) => {
    latencyRequests++;
    return route.fulfill({ status: 200, body: "" });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "你的网络，清楚一点。" }),
  ).toBeVisible();
  expect(ipRequests).toBe(0);
  expect(latencyRequests).toBe(0);
  await page.getByRole("button", { name: "查看当前 IP", exact: true }).click();
  await expect(page.getByText("198.51.100.23", { exact: true })).toBeVisible();
  await expect(
    page.getByText("AS64500 · Example network", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "测延迟与连通", exact: true }).click();
  await expect(page.getByText("HTTPS 连通正常", { exact: true })).toBeVisible();
  expect(latencyRequests).toBe(3);
  await page.route("https://speed.cloudflare.com/**", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page
    .getByRole("button", { name: "下载测速 · 5 MB", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("测速端点暂不可用");
  await expect(
    page.locator(".metric-strip").getByText("—", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /DNS 泄漏测试/ }),
  ).toHaveAttribute("href", "https://www.dnsleaktest.com/");
});

test("speed requires full bounded response before showing a value", async ({
  page,
}) => {
  await page.route("https://speed.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, body: Buffer.alloc(5_000_000) }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "下载测速 · 5 MB", exact: true })
    .click();
  await expect(
    page.getByText("5 MB 样本吞吐量，非带宽上限", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("下载连通正常", { exact: true })).toBeVisible();
  await page.route("https://speed.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, body: "partial" }),
  );
  await page
    .getByRole("button", { name: "下载测速 · 5 MB", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("未完整下载");
  await expect(
    page.getByText("5 MB 样本吞吐量，非带宽上限", { exact: true }),
  ).toBeHidden();
});

test("batch routing uses current config and stale results cannot be exported", async ({
  page,
}) => {
  await page.goto("/?view=diagnostics");
  await page
    .locator("#diagnostics-input")
    .fill("www.kugou.com\n192.168.1.20\n8.8.8.8,US\n8.8.4.4");
  await page.getByRole("button", { name: "检查分流", exact: true }).click();
  await expect(
    page.locator(".diagnostics-table tbody tr").nth(0),
  ).toContainText("直连");
  await expect(
    page.locator(".diagnostics-table tbody tr").nth(1),
  ).toContainText("直连");
  await expect(
    page.locator(".diagnostics-table tbody tr").nth(2),
  ).toContainText("代理");
  await expect(
    page.locator(".diagnostics-table tbody tr").nth(3),
  ).toContainText("未确定");
  const downloadPending = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 CSV", exact: true }).click();
  const download = await downloadPending;
  expect(await readFile((await download.path())!, "utf8")).toContain(
    "www.kugou.com",
  );
  await page.getByRole("button", { name: "分流配置", exact: true }).click();
  await page
    .getByRole("group", { name: "酷狗音乐连接方式", exact: true })
    .getByRole("button", { name: "代理", exact: true })
    .click();
  await page.getByRole("button", { name: "批量检查", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "下载 CSV", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "检查分流", exact: true }).click();
  await expect(
    page.locator(".diagnostics-table tbody tr").first(),
  ).toContainText("代理");
});

test("all tool workspaces fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  for (const name of ["网络概览", "订阅与节点", "分流配置", "批量检查"]) {
    await page.getByRole("button", { name, exact: true }).click();
    const width = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(width.content, name).toBeLessThanOrEqual(width.viewport + 1);
  }
});
