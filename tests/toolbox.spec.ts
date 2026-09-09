import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { Page } from "@playwright/test";

/** Test-only transport fixture. It emits actual HTTP chunks; the app still uses
 * browser fetch, ReadableStream, AbortSignal and its own monotonic timestamps.
 * These deterministic checks are not measurements of the public speed service. */
async function streamingDownload(page: Page) {
  const allowedOrigin = new URL(String(test.info().project.use.baseURL)).origin;
  const responses: ServerResponse[] = [];
  const closed = new Set<number>();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || !request.url?.startsWith("/__down?")) {
      response.writeHead(404).end();
      return;
    }
    const index = responses.length;
    responses.push(response);
    response.on("close", () => closed.add(index));
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Access-Control-Allow-Origin": allowedOrigin,
      "Cache-Control": "no-store",
      "Content-Length": "5000000",
    });
    response.flushHeaders();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await page.addInitScript((origin) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        location.href,
      );
      if (
        url.origin === "https://speed.cloudflare.com" &&
        url.pathname === "/__down"
      ) {
        return originalFetch(`${origin}${url.pathname}${url.search}`, init);
      }
      return originalFetch(input, init);
    };
  }, `http://127.0.0.1:${address.port}`);
  return {
    responses,
    closed,
    async emit(index: number, bytes: number, final = false) {
      await expect.poll(() => responses.length).toBeGreaterThan(index);
      // Separate real data windows so live-rate sampling can observe a change.
      await new Promise((resolve) => setTimeout(resolve, 160));
      if (final) responses[index].end(Buffer.alloc(bytes));
      else responses[index].write(Buffer.alloc(bytes));
    },
    async dispose() {
      for (const response of responses) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function sampleCount(page: Page) {
  return Number(
    await page.getByTestId("throughput-samples").getAttribute("data-sample-count"),
  );
}

test("network overview only measures on request and reports real response failures", async ({
  page,
}) => {
  let ipRequests = 0;
  let latencyRequests = 0;
  let downloadRequests = 0;
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
    if (Number(new URL(route.request().url()).searchParams.get("bytes")) > 0) downloadRequests++;
    else latencyRequests++;
    return route.fulfill({ status: 200, body: "" });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "网络概览", exact: true }),
  ).toBeVisible();
  expect(ipRequests).toBe(0);
  expect(latencyRequests).toBe(0);
  await expect(page.getByTestId("throughput-samples")).toBeHidden();
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await expect(page.getByText("198.51.100.23", { exact: true })).toBeVisible();
  await expect(
    page.getByText("AS64500 · Example network", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("HTTPS 连通正常", { exact: true })).toBeVisible();
  expect(latencyRequests).toBe(3);
  expect(ipRequests).toBe(1);
  expect(downloadRequests).toBe(0);
  await page.getByRole("button", { name: /^继续测下载速度/ }).click();
  await expect(page).toHaveURL(/view=network&tool=speed/);
  await expect(page.locator(".lab-ip")).toBeHidden();
  await page.route("https://speed.cloudflare.com/**", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page
    .getByRole("button", { name: "下载测速 · 5 MB", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("测速端点暂不可用");
  await expect(
    page.getByTestId("throughput-final"),
  ).toHaveText("—");
  await page.getByRole("button", { name: "泄漏检查", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /DNS 泄漏测试/ }),
  ).toHaveAttribute("href", "https://www.dnsleaktest.com/");
  await page.getByRole("button", { name: "查看当前连接", exact: true }).click();
  await expect(page).toHaveURL(/view=network&tool=overview/);
  await expect(page.getByText("198.51.100.23", { exact: true })).toBeVisible();
  await expect(page.getByTestId("latency-samples")).toHaveAttribute("data-sample-count", "3");
  expect(ipRequests).toBe(1);
});

test("host queries are explicit and show real DNS records with actionable missing-answer results", async ({ page }) => {
  const requests: string[] = [];
  await page.route("https://cloudflare-dns.com/dns-query**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: { Status: 0, AD: true, Answer: [{ name: "example.com.", type: 1, TTL: 180, data: "93.184.215.14" }] } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "主机查询", exact: true }).click();
  expect(requests).toEqual([]);
  const input = page.getByRole("textbox", { name: "公网域名或 IP", exact: true });
  await input.fill("example.com");
  await page.getByRole("button", { name: "查询主机", exact: true }).click();
  await expect(page.getByRole("cell", { name: "93.184.215.14", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "180 秒", exact: true })).toBeVisible();
  expect(new URL(requests[0]).searchParams.get("type")).toBe("A");
  await input.fill("1.1.1.1");
  await expect(page.getByRole("cell", { name: "93.184.215.14", exact: true })).toBeHidden();
  await page.route("https://cloudflare-dns.com/dns-query**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: { Status: 3 } });
  });
  await page.getByRole("button", { name: "查询主机", exact: true }).click();
  await expect(page.getByText(/此名称不存在（NXDOMAIN）/)).toBeVisible();
  expect(new URL(requests[1]).searchParams.get("type")).toBe("PTR");
  expect(new URL(requests[1]).searchParams.get("name")).toBe("1.1.1.1.in-addr.arpa");
  await input.fill("https://private.example/sub?token=secret");
  await page.getByRole("button", { name: "查询主机", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("不含协议、端口、路径或订阅链接");
  expect(requests).toHaveLength(2);
});

test("host failure and cancellation do not imply connectivity or leak success", async ({ page }) => {
  await page.route("https://cloudflare-dns.com/dns-query**", (route) => route.abort("failed"));
  await page.goto("/");
  await page.getByRole("button", { name: "主机查询", exact: true }).click();
  await page.getByRole("textbox", { name: "公网域名或 IP", exact: true }).fill("example.com");
  await page.getByRole("button", { name: "查询主机", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("无法连接 cloudflare-dns.com");
  await expect(page.getByRole("alert")).not.toContainText("Failed to fetch");
  await page.route("https://cloudflare-dns.com/dns-query**", () => new Promise(() => {}));
  await page.getByRole("button", { name: "查询主机", exact: true }).click();
  await page.getByRole("button", { name: "停止查询", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("主机查询已停止");
  await expect(page.getByRole("button", { name: "查询主机", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "泄漏检查", exact: true }).click();
  await expect(page.getByText("泄漏检查，要对照结果才算完成", { exact: true })).toBeVisible();
  await expect(page.getByText(/不会把“已打开”标记为“已通过”/)).toBeVisible();
  await expect(page.getByRole("link", { name: "WebRTC IP 暴露", exact: true })).toHaveAttribute("href", "https://browserleaks.com/webrtc");
});

for (const viewportWidth of [375, 480]) {
  test(`network categories fit ${viewportWidth}px and show only their selected tool`, async ({ page }) => {
    await page.setViewportSize({ width: viewportWidth, height: 755 });
    await page.goto("/?view=network&tool=overview");
    for (const [name, section] of [["网络概览", "overview"], ["速度测试", "speed"], ["主机查询", "host"], ["泄漏检查", "leaks"]]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.locator(`#network-${section}`)).toBeVisible();
      for (const other of ["overview", "speed", "host", "leaks"].filter(value => value !== section)) await expect(page.locator(`#network-${other}`)).toBeHidden();
      const width = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
      expect(width.content, name).toBeLessThanOrEqual(width.viewport + 1);
      const size = await page.getByRole("button", { name, exact: true }).evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
      expect(size).toBeGreaterThanOrEqual(12);
    }
  });
}

test("speed requires full bounded response before showing a value", async ({
  page,
}) => {
  await page.route("https://speed.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, body: Buffer.alloc(5_000_000) }),
  );
  await page.goto("/?view=network&tool=speed");
  await page
    .getByRole("button", { name: "下载测速 · 5 MB", exact: true })
    .click();
  await expect(
    page.getByText("5 MB 样本吞吐量，非带宽上限", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("下载连通正常", { exact: true })).toBeVisible();
  const megabits = Number(await page.getByTestId("throughput-final").textContent());
  const megabytes = Number((await page.locator(".lab-byte-rate").textContent())?.match(/[\d.]+/)?.[0]);
  expect(megabits).toBeGreaterThan(0);
  expect(Math.abs(megabytes * 8 - megabits)).toBeLessThanOrEqual(0.05);
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

test("streamed measurements update from arriving bytes, stop cleanly and restart without stale samples", async ({
  page,
}) => {
  const fixture = await streamingDownload(page);
  try {
    await page.goto("/?view=network&tool=speed");
    expect(fixture.responses).toHaveLength(0);
    const download = page.getByRole("button", {
      name: "下载测速 · 5 MB",
      exact: true,
    });
    const final = page.getByTestId("throughput-final");
    const live = page.getByTestId("throughput-live");
    const bytes = page.getByTestId("download-received");
    const phase = page.getByTestId("network-phase");
    await download.click();
    await expect(phase).toHaveAttribute("data-phase", "speed");
    await expect(download).toBeDisabled();
    await expect(final).toHaveText("—");

    await fixture.emit(0, 100_000);
    await expect(bytes).toHaveAttribute("data-bytes", "100000");
    await expect.poll(() => sampleCount(page)).toBeGreaterThan(0);
    await expect.poll(async () => Number(await live.textContent())).toBeGreaterThan(0);
    const firstCount = await sampleCount(page);
    await fixture.emit(0, 250_000);
    await expect(bytes).toHaveAttribute("data-bytes", "350000");
    await expect.poll(() => sampleCount(page)).toBeGreaterThan(firstCount);
    await expect(final).toHaveText("—");

    await page.getByRole("button", { name: "停止检测", exact: true }).click();
    await expect(phase).toHaveAttribute("data-phase", "idle");
    await expect.poll(() => fixture.closed.has(0)).toBe(true);
    await expect(live).toHaveText("—");
    await expect(final).toHaveText("—");
    const stoppedCount = await sampleCount(page);
    expect(stoppedCount).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await sampleCount(page)).toBe(stoppedCount);

    await download.click();
    await expect(phase).toHaveAttribute("data-phase", "speed");
    await expect(bytes).toHaveAttribute("data-bytes", "0");
    await expect(page.getByTestId("throughput-samples")).toHaveAttribute(
      "data-sample-count",
      "0",
    );
    await expect(final).toHaveText("—");
    await expect(live).toHaveText("—");
    await fixture.emit(1, 100_000);
    await expect(bytes).toHaveAttribute("data-bytes", "100000");
    await expect.poll(() => sampleCount(page)).toBeGreaterThan(0);
    await fixture.emit(1, 4_900_000, true);
    await expect(bytes).toHaveAttribute("data-bytes", "5000000");
    await expect(phase).toHaveAttribute("data-phase", "idle");
    await expect.poll(async () => Number(await final.textContent())).toBeGreaterThan(0);
    expect(fixture.responses).toHaveLength(2);
  } finally {
    await fixture.dispose();
  }
});

test("reduced motion disables presentation animations while streamed data still updates", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixture = await streamingDownload(page);
  try {
    await page.goto("/?view=network&tool=speed");
    expect(fixture.responses).toHaveLength(0);
    await page
      .getByRole("button", { name: "下载测速 · 5 MB", exact: true })
      .click();
    await fixture.emit(0, 100_000);
    await expect(page.getByTestId("download-received")).toHaveAttribute(
      "data-bytes",
      "100000",
    );
    await expect.poll(() => sampleCount(page)).toBeGreaterThan(0);
    const animations = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.playState === "running").length,
    );
    expect(animations).toBe(0);
    await expect(page.getByTestId("throughput-final")).toHaveText("—");
    await page.getByRole("button", { name: "停止检测", exact: true }).click();
    await expect(page.getByTestId("network-phase")).toHaveAttribute(
      "data-phase",
      "idle",
    );
  } finally {
    await fixture.dispose();
  }
});


test("switching categories and leaving the workspace abort active downloads while keeping received samples", async ({ page }) => {
  const fixture = await streamingDownload(page);
  try {
    await page.goto("/?view=network&tool=speed");
    const download = page.getByRole("button", { name: "下载测速 · 5 MB", exact: true });
    await download.click();
    await fixture.emit(0, 100_000);
    await expect(page.getByTestId("download-received")).toHaveAttribute("data-bytes", "100000");
    await page.getByRole("button", { name: "查看出口与延迟", exact: true }).click();
    await expect.poll(() => fixture.closed.has(0)).toBe(true);
    await expect(page).toHaveURL(/view=network&tool=overview/);
    await expect(page.getByTestId("throughput-samples")).toBeHidden();
    await page.getByRole("button", { name: "速度测试", exact: true }).click();
    await expect(page.getByTestId("network-phase")).toHaveAttribute("data-phase", "idle");
    await expect(page.getByTestId("download-received")).toHaveAttribute("data-bytes", "100000");
    await expect(page.getByTestId("throughput-final")).toHaveText("—");
    await download.click();
    await expect(page.getByTestId("download-received")).toHaveAttribute("data-bytes", "0");
    await fixture.emit(1, 150_000);
    await expect(page.getByTestId("download-received")).toHaveAttribute("data-bytes", "150000");
    await page.getByRole("button", { name: "订阅与节点", exact: true }).click();
    await expect.poll(() => fixture.closed.has(1)).toBe(true);
    await page.getByRole("button", { name: "网络检查", exact: true }).click();
    await page.getByRole("button", { name: "速度测试", exact: true }).click();
    await expect(page.getByTestId("download-received")).toHaveAttribute("data-bytes", "150000");
    await expect(page.getByTestId("throughput-final")).toHaveText("—");
    expect(fixture.responses).toHaveLength(2);
  } finally { await fixture.dispose(); }
});
