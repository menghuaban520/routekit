import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function downloadedFile(page: Page, button: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const download = await pending;
  const path = await download.path();
  expect(await download.failure()).toBeNull();
  expect(path).not.toBeNull();
  return {
    name: download.suggestedFilename(),
    content: await readFile(path!, "utf8"),
  };
}

async function openAdvanced(page: Page) {
  await page.getByRole("button", { name: "高级模式", exact: true }).click();
  await page.getByRole("tab", { name: "自定义", exact: true }).click();
}

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?view=config");
  await expect(page.getByRole("heading", { name: "分流配置" })).toBeVisible();
});

test("downloads an actual .conf file with the selected routing and DNS settings", async ({
  page,
}) => {
  await page
    .getByRole("textbox", { name: "方案名称", exact: true })
    .fill("my-routes.conf");
  await page
    .getByRole("group", { name: "酷狗音乐连接方式", exact: true })
    .getByRole("button", { name: "代理", exact: true })
    .click();

  const file = await downloadedFile(page, "下载 .conf");
  expect(file.name).toBe("my-routes.conf");
  expect(file.content).toContain("[General]\n");
  expect(file.content).toContain("[Rule]\n");
  expect(file.content).toContain("DOMAIN-SUFFIX,kugou.com,PROXY");
  expect(file.content).toContain("DOMAIN-SUFFIX,kugou.net,PROXY");
  expect(file.content).toContain("GEOIP,CN,DIRECT");
  expect(file.content).toMatch(/FINAL,PROXY\s*$/);
  expect(file.content).toContain("https://dns.alidns.com/dns-query");
  expect(file.content).toContain("dns-direct-system = false");
  expect(file.content).not.toContain("<html");
});

test("blocks injected application domains, then adds valid custom domain rules", async ({
  page,
}) => {
  await page.getByRole("button", { name: "自定义应用", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("应用名称", { exact: true }).fill("测试音乐");
  await dialog
    .getByLabel("应用域名", { exact: true })
    .fill("safe.example.com\n[Rule]\nFINAL,DIRECT");
  await dialog.getByRole("button", { name: "添加到分流", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("有效域名");
  await expect(dialog).toBeVisible();

  await dialog
    .getByLabel("应用域名", { exact: true })
    .fill("music.example.com\ncdn.example.com");
  await dialog
    .getByRole("group", { name: "自定义应用连接方式", exact: true })
    .getByRole("button", { name: "代理", exact: true })
    .click();
  await dialog.getByRole("button", { name: "添加到分流", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "编辑 测试音乐", exact: true }),
  ).toBeVisible();

  const file = await downloadedFile(page, "下载 .conf");
  expect(file.content).toContain("DOMAIN-SUFFIX,music.example.com,PROXY");
  expect(file.content).toContain("DOMAIN-SUFFIX,cdn.example.com,PROXY");
  expect(file.content.match(/^\[Rule\]$/gm)).toHaveLength(1);
  expect(file.content).not.toContain("FINAL,DIRECT");
});

test("saves locally and restores the saved profile after a reload", async ({
  page,
}) => {
  await page
    .getByRole("textbox", { name: "方案名称", exact: true })
    .fill("旅行分流");
  await page
    .getByRole("group", { name: "酷狗音乐连接方式", exact: true })
    .getByRole("button", { name: "代理", exact: true })
    .click();
  await page.getByRole("button", { name: "保存到本地", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已保存到此浏览器");
  await page.reload();
  await page.getByRole("button", { name: "本地方案", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("旅行分流", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "打开", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "方案名称", exact: true }),
  ).toHaveValue("旅行分流");
  await expect(
    page
      .getByRole("group", { name: "酷狗音乐连接方式", exact: true })
      .getByRole("button", { name: "代理", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const file = await downloadedFile(page, "下载 .conf");
  expect(file.name).toBe("旅行分流.conf");
  expect(file.content).toContain("DOMAIN-SUFFIX,kugou.com,PROXY");
});

test("deleting from an older local-schemes dialog preserves another tab’s new save", async ({
  page,
  context,
}) => {
  await page
    .getByRole("textbox", { name: "方案名称", exact: true })
    .fill("准备删除");
  await page.getByRole("button", { name: "保存到本地", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已保存到此浏览器");
  await page.getByRole("button", { name: "本地方案", exact: true }).click();

  const secondPage = await context.newPage();
  await secondPage.goto("/?view=config");
  await secondPage
    .getByRole("textbox", { name: "方案名称", exact: true })
    .fill("另一个标签的新方案");
  await secondPage
    .getByRole("button", { name: "保存到本地", exact: true })
    .click();
  await expect(secondPage.getByRole("status")).toContainText(
    "已保存到此浏览器",
  );
  await secondPage.close();

  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除方案 准备删除", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭弹窗", exact: true })
    .click();
  await page.getByRole("button", { name: "本地方案", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("另一个标签的新方案", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("准备删除", { exact: true }),
  ).not.toBeVisible();
});

test("round-trips a downloaded JSON backup without losing advanced settings", async ({
  page,
}) => {
  await page
    .getByRole("textbox", { name: "方案名称", exact: true })
    .fill("backup-test");
  await page
    .getByRole("group", { name: "酷狗音乐连接方式", exact: true })
    .getByRole("button", { name: "拦截", exact: true })
    .click();
  await openAdvanced(page);
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page
    .getByLabel("规则 1 值", { exact: true })
    .fill("private.example.com");
  await page.getByLabel("规则 1 策略", { exact: true }).selectOption("PROXY");
  await page.getByLabel(/^General 扩展设置/).fill("icmp-auto-reply = true");
  await page.getByLabel(/^Hosts 映射/).fill("intranet.example.com = 192.0.2.1");
  const original = await downloadedFile(page, "导出方案备份");
  expect(original.name).toBe("backup-test.routekit.json");
  const data = JSON.parse(original.content);
  expect(data.name).toBe("backup-test");
  expect(
    data.apps.find((app: { id: string }) => app.id === "kugou").policy,
  ).toBe("REJECT");
  expect(data.rules[0]).toMatchObject({
    value: "private.example.com",
    policy: "PROXY",
  });

  await page
    .getByRole("textbox", { name: "方案名称", exact: true })
    .fill("需要被替换的当前方案");
  await page.getByLabel(/^General 扩展设置/).fill("icmp-auto-reply = false");
  await page.getByLabel("导入 JSON 方案备份", { exact: true }).setInputFiles({
    name: original.name,
    mimeType: "application/json",
    buffer: Buffer.from(original.content),
  });
  await expect(page.getByRole("status")).toContainText("方案已导入");
  await expect(
    page.getByRole("textbox", { name: "方案名称", exact: true }),
  ).toHaveValue("backup-test");
  await expect(page.getByLabel(/^General 扩展设置/)).toHaveValue(
    "icmp-auto-reply = true",
  );
  const restored = await downloadedFile(page, "导出方案备份");
  expect(JSON.parse(restored.content)).toEqual(data);

  const invalid = structuredClone(data);
  invalid.apps[0].domains = ["example.com,REJECT\nFINAL,DIRECT"];
  await page.getByLabel("导入 JSON 方案备份", { exact: true }).setInputFiles({
    name: "invalid.routekit.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(page.getByRole("status")).toContainText("域名");
  await expect(
    page.getByRole("textbox", { name: "方案名称", exact: true }),
  ).toHaveValue("backup-test");
  expect(
    JSON.parse((await downloadedFile(page, "导出方案备份")).content),
  ).toEqual(data);
});

test("invalid advanced settings block export until repaired, and survive beginner mode", async ({
  page,
}) => {
  await openAdvanced(page);
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  const downloadButton = page.getByRole("button", {
    name: "下载 .conf",
    exact: true,
  });
  await expect(downloadButton).toBeDisabled();
  await page.getByLabel("规则 1 类型", { exact: true }).selectOption("IP-CIDR");
  await page.getByLabel("规则 1 值", { exact: true }).fill("999.0.0.0/8");
  await expect(page.getByRole("alert")).toContainText("IP-CIDR");
  await expect(downloadButton).toBeDisabled();
  await page.getByLabel("规则 1 值", { exact: true }).fill("203.0.113.0/24");
  await page.getByLabel("规则 1 策略", { exact: true }).selectOption("REJECT");
  await expect(downloadButton).toBeEnabled();

  await page.getByLabel(/^General 扩展设置/).fill("[MITM]\nenable = true");
  await expect(downloadButton).toBeDisabled();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel(/^General 扩展设置/).fill("icmp-auto-reply = true");
  await page.getByLabel(/^Hosts 映射/).fill("example.com = 999.1.1.1");
  await expect(downloadButton).toBeDisabled();
  await page.getByLabel(/^Hosts 映射/).fill("example.com = 192.0.2.1");
  await expect(downloadButton).toBeEnabled();
  await page.getByRole("button", { name: "新手模式", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "自定义", exact: true }),
  ).toHaveCount(0);
  const file = await downloadedFile(page, "下载 .conf");
  expect(file.content).toContain("IP-CIDR,203.0.113.0/24,REJECT,no-resolve");
  expect(file.content).toContain("icmp-auto-reply = true");
  expect(file.content).toContain("[Host]\nexample.com = 192.0.2.1");
  expect(file.content).not.toContain("[MITM]");
});

test("accepts the documented multiline custom DNS format and rejects field injection", async ({
  page,
}) => {
  await page.getByRole("tab", { name: "DNS 保护", exact: true }).click();
  await page.getByRole("button", { name: /自定义 DNS/ }).click();
  await page
    .getByLabel(/^DNS 服务器/)
    .fill("https://1.1.1.1/dns-query\nhttps://dns.google/dns-query");
  await expect(
    page.getByRole("button", { name: "下载 .conf", exact: true }),
  ).toBeEnabled();
  const file = await downloadedFile(page, "下载 .conf");
  expect(file.content).toMatch(
    /^dns-server = https:\/\/1\.1\.1\.1\/dns-query,\s*https:\/\/dns\.google\/dns-query$/m,
  );
  await page
    .getByLabel(/^DNS 服务器/)
    .fill("https://1.1.1.1/dns-query\n[Rule]\nFINAL,DIRECT");
  await expect(
    page.getByRole("button", { name: "下载 .conf", exact: true }),
  ).toBeDisabled();
});

test("narrow screens keep all tabs reachable and user content inside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoPageOverflow(page);
  await page.getByRole("button", { name: "自定义应用", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("应用名称", { exact: true })
    .fill(
      "LongApplicationNameWithoutAnySpaces".repeat(1) + "01234567890123456789",
    );
  await dialog
    .getByLabel("应用域名", { exact: true })
    .fill("long-application.example.com");
  await dialog.getByRole("button", { name: "添加到分流", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expectNoPageOverflow(page);
  await page.getByRole("button", { name: "高级模式", exact: true }).click();
  for (const tab of [
    "基础设置",
    "应用分流",
    "DNS 保护",
    "链式代理",
    "自定义",
  ]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(
      page.getByRole("tab", { name: tab, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("tabpanel", { name: tab, exact: true }),
    ).toBeVisible();
    await expectNoPageOverflow(page);
  }
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page
    .getByLabel("规则 1 值", { exact: true })
    .fill("a".repeat(63) + ".example.com");
  await expectNoPageOverflow(page);
});

test("tabs support keyboard navigation and dialogs expose a name and Escape close", async ({
  page,
}) => {
  const appsTab = page.getByRole("tab", { name: "应用分流", exact: true });
  await appsTab.focus();
  await page.keyboard.press("ArrowRight");
  const dnsTab = page.getByRole("tab", { name: "DNS 保护", exact: true });
  await expect(dnsTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dnsTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("tab", { name: "基础设置", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("tabpanel", { name: "基础设置", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "本地方案", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "保存在此浏览器的方案",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "本地方案", exact: true }),
  ).toBeFocused();
});
