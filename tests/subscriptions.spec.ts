import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const ss = (name: string, host: string) =>
  `ss://${Buffer.from("aes-256-gcm:test-only-password").toString("base64")}@${host}:443#${encodeURIComponent(name)}`;
const sample = [
  ss("Alpha", "alpha.example.com"),
  ss("Beta", "beta.example.com"),
  ss("Gamma", "gamma.example.com"),
].join("\n");
const showSection = (page: Page, label: string) => page.getByRole("navigation", { name: "工具分类" }).getByRole("button", { name: label, exact: true }).click();
async function manualMethod(page: Page) {
  await showSection(page, "批量实测");
  const details = page.locator(".subscriptions-manual-fallback");
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator("summary").first().click();
}

test("subscription import deduplicates and real job roundtrip supports metric sorting", async ({
  page,
}) => {
  await page.goto("/?view=nodes");
  await page
    .locator("#subscription-paste")
    .fill(sample + "\n" + ss("Alpha", "alpha.example.com"));
  await page.getByRole("button", { name: "导入粘贴内容", exact: true }).click();
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(3);
  await page.getByRole("button", { name: "网络概览", exact: true }).click();
  await page.getByRole("button", { name: "订阅与节点", exact: true }).click();
  await showSection(page, "节点列表");
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(3);
  const pending = page.waitForEvent("download");
  await manualMethod(page);
  await page.getByRole("button", { name: /下载检测任务（3）/ }).click();
  const file = await pending;
  const job = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(file.suggestedFilename()).toBe("routekit-job.json");
  expect(job.options.speedTest).toBe(false);
  expect(job.nodes).toHaveLength(3);
  const results = {
    version: 1,
    source: "routekit-local-probe",
    generatedAt: new Date().toISOString(),
    results: job.nodes
      .slice(0, 2)
      .map(
        (
          node: { id: string; name: string; server: string; protocol: string },
          index: number,
        ) => ({
          nodeId: node.id,
          name: node.name,
          server: node.server,
          protocol: node.protocol,
          status: index ? "error" : "ok",
          latencyMs: index ? 30 : 120,
          speedMbps: index ? 50 : 10,
          downloadedBytes: 5_000_000,
          exitIp: index ? "203.0.113.20" : "203.0.113.10",
          country: "JP",
          latitude: 35.6762,
          longitude: 139.6503,
          ...(index ? { error: "定位服务暂不可用，延迟与测速已完成" } : {}),
        }),
      ),
  };
  await page
    .getByLabel("选择本地检测结果文件", { exact: true })
    .setInputFiles({
      name: "routekit-results.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(results)),
    });
  await expect(
    page.getByText("已关联 2 个当前节点的检测结果", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "节点排序", exact: true })
    .selectOption("latency");
  await expect(
    page.locator(".subscriptions-table tbody tr").first(),
  ).toContainText("Beta");
  await expect(
    page.locator(".subscriptions-table tbody tr").last(),
  ).toContainText("Gamma");
  await page
    .getByRole("combobox", { name: "节点排序", exact: true })
    .selectOption("speed");
  await expect(
    page.locator(".subscriptions-table tbody tr").first(),
  ).toContainText("Beta");
  await showSection(page, "批量实测");
  await page.locator("#subscription-origin").selectOption("shanghai");
  await showSection(page, "节点列表");
  await expect(
    page.locator(".subscriptions-table tbody tr").first(),
  ).toContainText("km · 地理估算");
  await page
    .getByRole("textbox", { name: "搜索节点名称、入口或出口 IP", exact: true })
    .fill("Alpha");
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(1);
  await page
    .getByRole("textbox", { name: "搜索节点名称、入口或出口 IP", exact: true })
    .fill("");
  await page.setViewportSize({ width: 375, height: 812 });
  const sizes = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(sizes.content).toBeLessThanOrEqual(sizes.viewport + 1);
});

test("manual SS creation exports actual link and invalid imports preserve nodes", async ({
  page,
}) => {
  await page.goto("/?view=nodes");
  await page
    .getByRole("button", { name: "手动添加 SS 节点", exact: true })
    .click();
  const form = page.locator(".subscriptions-manual");
  await form
    .getByRole("textbox", { name: "节点名称", exact: true })
    .fill("我的节点");
  await form
    .getByRole("textbox", { name: "服务器地址", exact: true })
    .fill("manual.example.com");
  await form.locator('input[type="password"]').fill("example-secret");
  await form.locator('button[type="submit"]').click();
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(1);
  await expect(form.locator('input[type="password"]')).toHaveValue("");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出选中链接/ }).click();
  const file = await pending;
  const text = await readFile((await file.path())!, "utf8");
  expect(text).toContain("ss://");
  expect(text).toContain("manual.example.com");
  await showSection(page, "导入订阅");
  await page.getByRole("button", { name: "替换当前列表", exact: true }).click();
  await page.locator("#subscription-paste").fill("not a subscription");
  await page.getByRole("button", { name: "导入粘贴内容", exact: true }).click();
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(1);
  await showSection(page, "节点列表");
  await page.getByRole("button", { name: "删除选中", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "先添加你的节点", exact: true }),
  ).toBeVisible();
});

test("subscription provider usage is displayed, missing headers stay unknown, and manual data is labeled", async ({
  page,
}) => {
  await page.route("https://subscription.example.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/plain",
      headers: {
        "Subscription-Userinfo":
          "upload=1073741824; download=2147483648; total=10737418240; expire=4102444800",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Subscription-Userinfo",
      },
      body: sample,
    }),
  );
  await page.goto("/?view=nodes");
  await page
    .locator("#subscription-url")
    .fill("https://subscription.example.com/private-token");
  await page.getByRole("button", { name: "读取订阅", exact: true }).click();
  await showSection(page, "套餐用量");
  const metrics = page.locator(".subscriptions-usage-metrics");
  await expect(metrics.getByText("10 GiB", { exact: true })).toBeVisible();
  await expect(metrics.getByText("3 GiB", { exact: true })).toBeVisible();
  await expect(metrics.getByText("7 GiB", { exact: true })).toBeVisible();
  await expect(metrics.getByText("1 GiB", { exact: true })).toBeVisible();
  await expect(metrics.getByText("2 GiB", { exact: true })).toBeVisible();
  await expect(page.getByText("服务商响应头", { exact: true })).toBeVisible();
  await expect(page.locator(".subscriptions-usage-source")).not.toContainText(
    "private-token",
  );
  await page.route("https://subscription.example.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/plain",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: sample,
    }),
  );
  await showSection(page, "导入订阅");
  await page.getByRole("button", { name: "读取订阅", exact: true }).click();
  await showSection(page, "套餐用量");
  await expect(page.getByText("响应头不可见", { exact: true })).toBeVisible();
  await expect(metrics.getByText("未知", { exact: true })).toHaveCount(6);
  await page.locator(".subscriptions-manual-usage summary").click();
  await page
    .locator("#subscription-userinfo")
    .fill(
      "upload=1073741824; download=2147483648; total=10737418240; expire=4102444800",
    );
  await page
    .getByRole("button", { name: "读取手动流量数据", exact: true })
    .click();
  await expect(page.getByText("手动提供的数据", { exact: true })).toBeVisible();
  await expect(metrics.getByText("3 GiB", { exact: true })).toBeVisible();
});

test("a saved probe job restores stable node IDs after refresh", async ({
  page,
}) => {
  await page.goto("/?view=nodes");
  await page
    .locator("#subscription-paste")
    .fill(ss("Restored", "restore.example.com"));
  await page.getByRole("button", { name: "导入粘贴内容", exact: true }).click();
  const pending = page.waitForEvent("download");
  await manualMethod(page);
  await page.getByRole("button", { name: /下载检测任务（1）/ }).click();
  const file = await pending;
  const jobText = await readFile((await file.path())!, "utf8");
  const job = JSON.parse(jobText),
    node = job.nodes[0];
  await page.reload();
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(0);
  await page
    .getByLabel("选择原检测任务 JSON", { exact: true })
    .setInputFiles({
      name: "routekit-job.json",
      mimeType: "application/json",
      buffer: Buffer.from(jobText),
    });
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(1);
  const results = {
    version: 1,
    source: "routekit-local-probe",
    generatedAt: new Date().toISOString(),
    results: [
      {
        nodeId: node.id,
        name: node.name,
        server: node.server,
        protocol: node.protocol,
        status: "ok",
        latencyMs: 82,
        exitIp: "203.0.113.9",
      },
    ],
  };
  await page
    .getByLabel("选择本地检测结果文件", { exact: true })
    .setInputFiles({
      name: "routekit-results.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(results)),
    });
  await expect(page.locator(".subscriptions-table tbody tr")).toContainText(
    "203.0.113.9",
  );
  await expect(page.locator(".subscriptions-table tbody tr")).toContainText(
    "82.0",
  );
});

test("refresh keeps node IDs and routing, synchronizes source changes, and preserves other nodes on errors", async ({ page }) => {
  let responseBody = [ss("Tokyo", "tokyo.example.com"), ss("Removed", "removed.example.com")].join("\n");
  let status = 200;
  let userinfo: string | undefined = "upload=1024; download=2048; total=1048576; expire=4102444800";
  await page.route("https://refresh.example.com/**", route => route.fulfill({ status, contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*", ...(userinfo ? { "Subscription-Userinfo": userinfo, "Access-Control-Expose-Headers": "Subscription-Userinfo" } : {}) }, body: responseBody }));
  await page.goto("/?view=nodes");
  await page.locator("#subscription-paste").fill(ss("Manual", "manual.example.com"));
  await page.getByRole("button", { name: "导入粘贴内容", exact: true }).click();
  await showSection(page, "导入订阅");
  await page.locator("#subscription-url").fill("https://refresh.example.com/private-session-token");
  await page.getByRole("button", { name: "读取订阅", exact: true }).click();
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(3);
  const downloadJob = async () => {
    await manualMethod(page);
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: /下载检测任务/ }).click();
    const job = JSON.parse(await readFile((await (await pending).path())!, "utf8"));
    await showSection(page, "节点列表");
    return job;
  };
  const before = await downloadJob();
  const tokyo = before.nodes.find((node: {name: string}) => node.name === "Tokyo");
  await page.getByRole("button", { name: "将 Tokyo 用于分流", exact: true }).click();
  await expect(page).toHaveURL(/view=config/);
  await page.getByRole("button", { name: "完整配置", exact: true }).click();
  await expect(page.getByLabel("生成的配置内容", { exact: true })).toContainText("tokyo.example.com");
  await page.getByRole("button", { name: "订阅与节点", exact: true }).click();
  await showSection(page, "套餐用量");
  responseBody = [ss("Tokyo renamed", "tokyo.example.com"), ss("New", "new.example.com")].join("\n");
  userinfo = undefined;
  await page.getByRole("button", { name: "刷新流量与节点", exact: true }).click();
  await expect(page.getByText("订阅已刷新 · 当前共 3 个节点", { exact: true })).toBeVisible();
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".subscriptions-table")).toContainText("Manual");
  await expect(page.locator(".subscriptions-table")).not.toContainText("Removed");
  await expect(page.locator(".subscriptions-usage-metrics").getByText("未知", { exact: true })).toHaveCount(6);
  const after = await downloadJob();
  expect(after.nodes.find((node: {name:string}) => node.name === "Tokyo renamed").id).toBe(tokyo.id);
  await showSection(page, "套餐用量");
  responseBody = ss("New", "new.example.com") + "\ninvalid subscription line";
  await page.getByRole("button", { name: "刷新流量与节点", exact: true }).click();
  await expect(page.getByText(/本次未更新节点和流量/)).toBeVisible();
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".subscriptions-table")).toContainText("Tokyo renamed");
  responseBody = [ss("Tokyo renamed", "tokyo.example.com"), ss("New", "new.example.com")].join("\n");
  status = 503;
  await page.getByRole("button", { name: "刷新流量与节点", exact: true }).click();
  await expect(page.getByText(/本次读取失败/)).toBeVisible();
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(3);
  await expect(page.locator("#subscription-url")).toHaveValue("https://refresh.example.com/private-session-token");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("private-session-token");
  status = 200;
  userinfo = "upload=2048; download=2048; total=1048576; expire=4102444800";
  await page.getByRole("button", { name: "刷新流量与节点", exact: true }).click();
  await expect(page.locator(".subscriptions-usage-metrics").getByText("4 KiB", { exact: true })).toBeVisible();
  await showSection(page, "节点列表");
  await page.getByRole("button", { name: "去配置分流", exact: true }).click();
  await expect(page.getByLabel("生成的配置内容", { exact: true })).toContainText("tokyo.example.com");
});

test("format example is explicitly non-connectable and never populates the node library", async ({ page }) => {
  await page.goto("/?view=nodes&tool=library");
  await page.locator(".subscriptions-example summary").click();
  await expect(page.locator(".subscriptions-example")).toContainText("不能连接网络");
  await expect(page.locator(".subscriptions-example code")).toContainText("node.example.com");
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "去配置分流", exact: true })).toBeDisabled();
});

test("real loopback monitor enforces authentication, renders live samples, and stops on navigation", async ({ page }) => {
  const bridge = spawn("python3", ["-B", "tests/python/test_monitor.py", "--serve-fixture"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Monitor fixture did not start")), 8000);
      let text = "";
      bridge.stdout.on("data", chunk => { text += chunk.toString(); if (text.includes("fixture-ready")) { clearTimeout(timeout); resolve(); } });
      bridge.once("error", error => { clearTimeout(timeout); reject(error); });
      bridge.once("exit", code => { clearTimeout(timeout); reject(new Error(`Monitor fixture exited ${code}`)); });
    });
    let requests = 0;
    page.on("request", request => { if (request.url() === "http://127.0.0.1:8766/v1/snapshot" && request.method() === "GET") requests++; });
    await page.goto("/?view=nodes&tool=live");
    await page.getByRole("button", { name: "连接本地助手", exact: true }).click();
    await page.getByLabel("本地助手会话令牌", { exact: true }).fill("wrong-token");
    await page.getByRole("button", { name: "验证并连接", exact: true }).click();
    await expect(page.getByRole("alert").filter({hasText: "会话令牌不正确"})).toBeVisible();
    await page.getByLabel("本地助手会话令牌", { exact: true }).fill("fixture-only-monitor-token");
    await page.getByRole("button", { name: "验证并连接", exact: true }).click();
    await page.getByRole("button", { name: "开始实时监测", exact: true }).click();
    await expect(page.locator(".subscriptions-live-metrics")).toContainText("4 KiB/s");
    await expect(page.locator(".subscriptions-live-table")).toContainText("测试 Tokyo → PROXY");
    await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".subscriptions-live-table")).not.toContainText("等待下次采样");
    await page.getByRole("button", { name: "停止实时监测", exact: true }).click();
    const stoppedAt = requests;
    await page.waitForTimeout(2500);
    expect(requests).toBe(stoppedAt);
    await page.getByRole("button", { name: "开始实时监测", exact: true }).click();
    await expect(page.locator(".subscriptions-live-metrics")).toBeVisible();
    await expect(page.locator(".subscriptions-live-table")).toContainText("等待下次采样");
    await page.getByRole("button", { name: "网络概览", exact: true }).click();
    const leftAt = requests;
    await page.waitForTimeout(2500);
    expect(requests).toBe(leftAt);
    await page.getByRole("button", { name: "订阅与节点", exact: true }).click();
    await showSection(page, "实时流量");
    await expect(page.getByRole("button", { name: "开始实时监测", exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("fixture-only-monitor-token");
  } finally { bridge.kill("SIGTERM"); await new Promise<void>(resolve => bridge.exitCode !== null ? resolve() : bridge.once("exit", () => resolve())); }
});
