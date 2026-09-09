import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { parse } from "yaml";

const fixture = `proxies:
  - name: Alpha
    type: ss
    server: alpha.example.com
    port: 443
    cipher: aes-256-gcm
    password: "fixture:with,#characters"
  - name: Beta
    type: ss
    server: beta.example.com
    port: 8443
    cipher: aes-128-gcm
    password: fixture-only
rules:
  - MATCH,DIRECT
`;
async function download(page: Page, name: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  const file = await pending;
  expect(await file.failure()).toBeNull();
  return { filename: file.suggestedFilename(), content: await readFile((await file.path())!, "utf8") };
}
async function setup(page: Page) {
  await page.goto("/?view=nodes&tool=import");
  await page.getByLabel("选择节点文本文件", { exact: true }).setInputFiles({ name: "nodes.yaml", mimeType: "application/yaml", buffer: Buffer.from(fixture) });
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "将 Alpha 用于分流", exact: true }).click();
  await page.getByLabel("方案名称", { exact: true }).fill("multi-client");
  const defaultId = await page.getByRole("combobox", { name: "默认代理节点", exact: true }).inputValue();
  const youtube = page.getByRole("combobox", { name: "YouTube代理节点", exact: true });
  await youtube.selectOption({ label: "Beta · SS" });
  return { defaultId, youtubeId: await youtube.inputValue() };
}

test("YAML import drives client-specific downloads, routing and saved-format restoration", async ({ page }) => {
  const { defaultId, youtubeId } = await setup(page);
  const client = page.getByRole("combobox", { name: "导出客户端", exact: true });
  await client.selectOption("clash");
  const yaml = await download(page, "下载 .yaml");
  expect(yaml.filename).toBe("multi-client.yaml");
  const clash = parse(yaml.content);
  expect(clash.proxies.find((node: {name: string}) => node.name === `RK_${defaultId}`).password).toBe("fixture:with,#characters");
  expect(clash.proxies.find((node: {name: string}) => node.name === `RK_${defaultId}`).udp).toBe(false);
  expect(clash.rules).toContain(`DOMAIN-SUFFIX,youtube.com,RK_${youtubeId}`);
  expect(clash.rules).toContain(`MATCH,RK_${defaultId}`);
  await expect(page.getByRole("button", { name: /下载配套节点/ })).toHaveCount(0);
  await expect(page.getByLabel("生成的配置内容")).toContainText("proxies:");
  await client.selectOption("v2rayn");
  const json = await download(page, "下载 .json");
  expect(json.filename).toBe("multi-client.json");
  const xray = JSON.parse(json.content);
  expect(xray.inbounds.map((item: {listen: string, protocol: string, port: number}) => ({listen:item.listen,protocol:item.protocol,port:item.port}))).toEqual([{listen:"127.0.0.1",protocol:"socks",port:10808},{listen:"127.0.0.1",protocol:"http",port:10809}]);
  expect(xray.outbounds.some((item: {tag: string}) => item.tag === `RK_${defaultId}`)).toBe(true);
  expect(xray.routing.rules.some((item: {domain?: string[],outboundTag: string}) => item.domain?.includes("domain:youtube.com") && item.outboundTag === `RK_${youtubeId}`)).toBe(true);
  expect(xray.routing.rules.some((item: {domain?: string[], network?: string, outboundTag: string}) => item.domain?.includes("domain:youtube.com") && item.network === "udp" && item.outboundTag === "REJECT")).toBe(true);
  await expect(page.locator(".client-import-guide")).toContainText("添加自定义配置");
  await expect(page.locator(".client-import-guide")).toContainText("10808");
  await expect(page.locator(".client-import-guide")).toContainText("保持未设置");
  await expect(page.locator(".client-import-guide")).toContainText("手动设置");
  await page.getByRole("button", { name: "保存到本地", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "本地方案", exact: true }).click();
  await page.locator(".saved-row").filter({ hasText: "multi-client" }).getByRole("button", {name: "打开", exact:true}).click();
  await expect(client).toHaveValue("v2rayn");
  const nav=page.getByRole("navigation", {name:"工具分类",exact:true});
  await nav.getByRole("button", {name:"批量检查",exact:true}).click();
  await page.locator("#diagnostics-input").fill("youtube.com,203.0.113.7,US\nwww.kugou.com,203.0.113.8,US");
  await page.getByRole("button", {name:"检查分流",exact:true}).click();
  await expect(page.locator(".diagnostics-table tbody tr").first()).toContainText("Beta");
  await expect(page.locator(".diagnostics-table tbody tr").nth(1)).toContainText("直连");
});

test("new formats explain missing nodes and preserve unsupported settings on client switch", async ({page}) => {
  await page.goto("/?view=config&tool=apps");
  const client=page.getByRole("combobox", {name:"导出客户端",exact:true});
  await client.selectOption("clash");
  await expect(page.getByRole("button", {name:"下载 .yaml",exact:true})).toBeDisabled();
  await expect(page.locator(".validation-errors")).toContainText("节点");
  await client.selectOption("shadowrocket");
  await expect(page.getByRole("button", {name:"下载 .conf",exact:true})).toBeEnabled();
  await setup(page);
  await page.getByRole("button", {name:"高级模式",exact:true}).click();
  await page.getByRole("tab", {name:"自定义",exact:true}).click();
  await page.getByLabel(/^General 扩展设置/).fill("icmp-auto-reply = true");
  await client.selectOption("clash");
  await expect(page.getByRole("button", {name:"下载 .yaml",exact:true})).toBeDisabled();
  await expect(page.getByLabel(/^General 扩展设置/)).toHaveValue("icmp-auto-reply = true");
  await page.getByLabel(/^General 扩展设置/).fill("");
  await expect(page.getByRole("button", {name:"下载 .yaml",exact:true})).toBeEnabled();
});

test("mobile format picker and download instructions remain usable without horizontal overflow", async ({page}) => {
  await page.setViewportSize({width:375,height:812});
  await setup(page);
  const client=page.getByRole("combobox", {name:"导出客户端",exact:true});
  for (const format of ["clash", "v2rayn", "shadowrocket"]) {
    await client.selectOption(format);
    await expect(client).toHaveValue(format);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await client.selectOption("clash");
  const yaml=await download(page,"下载 .yaml");
  expect(parse(yaml.content).proxies).toHaveLength(2);
});
