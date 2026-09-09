import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const ss = (name: string, server: string) =>
  `ss://${Buffer.from("aes-256-gcm:routing-test-password").toString("base64")}@${server}:443#${name}`;
const twoNodes = [
  ss("Alpha", "alpha.example.com"),
  ss("Beta", "beta.example.com"),
].join("\n");

async function downloadFile(page: Page, button: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const file = await pending;
  expect(await file.failure()).toBeNull();
  const path = await file.path();
  expect(path).not.toBeNull();
  return {
    name: file.suggestedFilename(),
    content: await readFile(path!, "utf8"),
  };
}

async function importNodes(page: Page, source: string, count: number) {
  await page.goto("/?view=nodes&tool=import");
  await expect(page.locator("#subscription-import")).toBeVisible();
  await page.locator("#subscription-paste").fill(source);
  await page.getByRole("button", { name: "导入粘贴内容", exact: true }).click();
  await expect(page).toHaveURL(/view=nodes&tool=library/);
  await expect(page.locator("#subscription-library")).toBeVisible();
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(
    count,
  );
}

async function navigate(page: Page, label: string) {
  await page.getByRole("navigation", { name: "工具分类", exact: true })
    .getByRole("button", { name: label, exact: true }).click();
}

async function importBackup(page: Page, content: string) {
  await page.getByLabel("导入 JSON 方案备份", { exact: true }).setInputFiles({
    name: "routing.routekit.json",
    mimeType: "application/json",
    buffer: Buffer.from(content),
  });
}

test("imported nodes drive app routing, real downloads, diagnostics and saved profile restoration", async ({
  page,
}) => {
  await importNodes(page, twoNodes, 2);
  await page
    .getByRole("button", { name: "将 Alpha 用于分流", exact: true })
    .click();
  await expect(page).toHaveURL(/view=config&tool=apps/);
  const defaultNode = page.getByRole("combobox", {
    name: "默认代理节点",
    exact: true,
  });
  await expect(defaultNode.locator("option:checked")).toHaveText("Alpha · SS");
  const alphaId = await defaultNode.inputValue();
  expect(alphaId).not.toBe("");
  const youtube = page.getByRole("combobox", {
    name: "YouTube代理节点",
    exact: true,
  });
  const [betaId] = await youtube.selectOption({ label: "Beta · SS" });
  expect(betaId).not.toBe(alphaId);
  await expect(
    page.locator(".route-examples > div").filter({ hasText: "YouTube" }),
  ).toContainText("Beta");
  await expect(
    page.locator(".route-examples > div").filter({ hasText: "Telegram" }),
  ).toContainText("Alpha");
  await expect(page.locator(".node-export-guide")).toContainText(
    "包含节点凭证",
  );
  await page
    .getByRole("textbox", { name: "方案名称", exact: true })
    .fill("assigned-routes");

  const originalConfig = await downloadFile(page, "下载 .conf");
  expect(originalConfig.name).toBe("assigned-routes.conf");
  expect(originalConfig.content).toContain(
    `RK_${alphaId} = ss, alpha.example.com, 443`,
  );
  expect(originalConfig.content).toContain(
    `RK_${betaId} = ss, beta.example.com, 443`,
  );
  expect(originalConfig.content).toContain(
    `DOMAIN-SUFFIX,youtube.com,RK_${betaId}`,
  );
  expect(originalConfig.content).toContain(
    `DOMAIN-SUFFIX,telegram.org,RK_${alphaId}`,
  );
  expect(originalConfig.content).toContain(`FINAL,RK_${alphaId}`);
  expect(originalConfig.content).toContain("DOMAIN-SUFFIX,kugou.com,DIRECT");
  const backup = await downloadFile(page, "导出方案备份");
  const snapshot = JSON.parse(backup.content);
  expect(snapshot.nodeRouting.defaultNodeId).toBe(alphaId);
  expect(snapshot.nodeRouting.appNodeIds.youtube).toBe(betaId);
  expect(snapshot.nodeRouting.nodes).toHaveLength(2);

  await navigate(page, "批量检查");
  await expect(page).toHaveURL(/view=diagnostics&tool=rules/);
  await page
    .locator("#diagnostics-input")
    .fill("youtube.com\ntelegram.org\nwww.kugou.com");
  await page.getByRole("button", { name: "检查分流", exact: true }).click();
  const rows = page.locator(".diagnostics-table tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Beta");
  await expect(rows.nth(0)).toContainText(
    `DOMAIN-SUFFIX,youtube.com,RK_${betaId}`,
  );
  await expect(rows.nth(1)).toContainText("Alpha");
  await expect(rows.nth(2)).toContainText("直连");

  await navigate(page, "分流配置");
  await expect(page).toHaveURL(/view=config&tool=apps/);
  await page.getByRole("button", { name: "保存到本地", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已保存到此浏览器");
  await page.reload();
  await page.getByRole("button", { name: "本地方案", exact: true }).click();
  await page
    .locator(".saved-row")
    .filter({ hasText: "assigned-routes" })
    .getByRole("button", { name: "打开", exact: true })
    .click();
  await expect(defaultNode).toHaveValue(alphaId);
  await expect(youtube).toHaveValue(betaId);
  expect((await downloadFile(page, "下载 .conf")).content).toBe(
    originalConfig.content,
  );

  await page
    .getByRole("group", { name: "YouTube连接方式", exact: true })
    .getByRole("button", { name: "直连", exact: true })
    .click();
  await expect(youtube).toHaveCount(0);
  const directConfig = await downloadFile(page, "下载 .conf");
  expect(directConfig.content).toContain("DOMAIN-SUFFIX,youtube.com,DIRECT");
  expect(directConfig.content).not.toContain(`RK_${betaId}`);
  await page.getByRole("button", { name: "移除 YouTube", exact: true }).click();
  const removedConfig = await downloadFile(page, "下载 .conf");
  expect(removedConfig.content).not.toContain("DOMAIN-SUFFIX,youtube.com,");
  expect(removedConfig.content).not.toContain(`RK_${betaId}`);
  expect(removedConfig.content).toContain(`FINAL,RK_${alphaId}`);

  // The downloaded backup must independently restore both credentials and routes.
  await importBackup(page, backup.content);
  await expect(youtube).toHaveValue(betaId);
  expect((await downloadFile(page, "下载 .conf")).content).toBe(
    originalConfig.content,
  );
});

test("advanced URI routing exports an explicit companion file without dropping connection parameters", async ({
  page,
}) => {
  const originalUri =
    "trojan://secret%2Cwith%3Dequals@tokyo.example.com:443?security=tls&type=ws&sni=tls.example.com&host=ws.example.com&path=%2Fsocket%3Fed%3D2048&allowInsecure=0#Tokyo-WS";
  await importNodes(page, originalUri, 1);
  await page
    .getByRole("button", { name: "将 Tokyo-WS 用于分流", exact: true })
    .click();
  const selectedId = await page
    .getByRole("combobox", { name: "默认代理节点", exact: true })
    .inputValue();
  expect(selectedId).not.toBe("");
  const guide = page.locator(".node-export-guide");
  await expect(guide).toContainText("先导入配套节点，再导入配置");
  await expect(guide).toContainText("包含节点凭证");
  await expect(guide).toContainText("RK_");

  const companion = await downloadFile(page, "下载配套节点（含凭证）");
  expect(companion.name).toMatch(/\.nodes\.txt$/);
  const original = new URL(originalUri),
    exported = new URL(companion.content.trim());
  expect(exported.protocol).toBe(original.protocol);
  expect(exported.username).toBe(original.username);
  expect(exported.hostname).toBe(original.hostname);
  expect(exported.port).toBe(original.port);
  expect([...exported.searchParams].sort()).toEqual(
    [...original.searchParams].sort(),
  );
  expect(decodeURIComponent(exported.hash.slice(1))).toBe(`RK_${selectedId}`);

  const config = await downloadFile(page, "下载 .conf");
  expect(config.content).toContain(
    "# REQUIRED: import the companion node URI file",
  );
  expect(config.content).toContain(`FINAL,RK_${selectedId}`);
  expect(config.content).not.toContain("[Proxy]");
  expect(config.content).not.toContain("secret");
  await navigate(page, "批量检查");
  await expect(page).toHaveURL(/view=diagnostics&tool=rules/);
  await page.locator("#diagnostics-input").fill("youtube.com");
  await page.getByRole("button", { name: "检查分流", exact: true }).click();
  await expect(page.locator(".diagnostics-table tbody tr")).toContainText(
    "Tokyo-WS",
  );
});

test("existing rule-only JSON profiles remain usable without imported nodes", async ({
  page,
}) => {
  const legacy = {
    version: 1,
    name: "legacy-rules",
    client: "shadowrocket",
    domesticPolicy: "DIRECT",
    finalPolicy: "PROXY",
    bypassLan: true,
    dns: { mode: "encrypted", servers: "", ipv6: false },
    apps: [
      {
        id: "legacy",
        name: "旧方案应用",
        domains: ["legacy.example.com"],
        policy: "PROXY",
        color: "#3184FF",
        symbol: "旧",
        custom: true,
      },
    ],
    rules: [],
    hosts: "",
    general: "",
  };
  await page.goto("/?view=config&tool=apps");
  await importBackup(page, JSON.stringify(legacy));
  await expect(
    page.getByRole("textbox", { name: "方案名称", exact: true }),
  ).toHaveValue("legacy-rules");
  await expect(
    page.getByRole("combobox", { name: "默认代理节点", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "旧方案应用代理节点", exact: true }),
  ).toHaveValue("");
  const config = await downloadFile(page, "下载 .conf");
  expect(config.name).toBe("legacy-rules.conf");
  expect(config.content).toContain("DOMAIN-SUFFIX,legacy.example.com,PROXY");
  expect(config.content).toMatch(/FINAL,PROXY\s*$/);
  expect(config.content).not.toContain("[Proxy]");
  expect(config.content).not.toContain("RK_");
  await expect(
    page.getByRole("button", { name: "下载配套节点（含凭证）", exact: true }),
  ).toHaveCount(0);
});
