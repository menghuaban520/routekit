import { expect, test, type Page } from "@playwright/test";
import type { AssistantJob, AssistantReport } from "../src/core/local-assistant";
import type { ProbeJob } from "../src/core/probe-results";

const ss = (name: string, host: string) => `ss://${Buffer.from("aes-256-gcm:workflow-fixture-only").toString("base64")}@${host}:443#${encodeURIComponent(name)}`;
const showSection = (page: Page, label: string) => page.getByRole("navigation", { name: "工具分类" }).getByRole("button", { name: label, exact: true }).click();
async function connect(page: Page) {
  await page.getByRole("button", { name: "连接本地助手", exact: true }).click();
  await page.getByLabel("本地助手会话令牌", { exact: true }).fill("workflow-fixture-token");
  await page.getByRole("button", { name: "验证并连接", exact: true }).click();
  await expect(page.locator(".subscriptions-assistant-status")).toContainText("已连接");
}

async function helperFixture(page: Page, mode: "stream" | "instant" | "hold" | "disconnect") {
  const submissions: ProbeJob[] = [];
  let current: AssistantJob | null = null;
  let deletes = 0;
  let interrupted = false;
  const results = (input: ProbeJob, count: number): AssistantReport["results"] => input.nodes.slice(0, count).map((node, index) => ({ nodeId: node.id, name: node.name, server: node.server, protocol: node.protocol, status: index === 2 ? "error" : "ok", ...(index === 2 ? { error: "fixture: 连接超时" } : { latencyMs: index === 1 ? 40 : 180, exitIp: `203.0.113.${index + 1}`, country: "JP" }) }));
  await page.route("http://127.0.0.1:8766/**", async route => {
    const request = route.request();
    expect(request.headers()["authorization"]).toBe("Bearer workflow-fixture-token");
    const path = new URL(request.url()).pathname;
    let body: unknown;
    let status = 200;
    if (path === "/v1/capabilities") body = { version: 1, source: "routekit-local-helper", monitor: true, probe: { available: true, maxNodes: 100, maxBodyBytes: 2097152, maxDownloadBytes: 5000000 }, currentJob: current };
    else if (path === "/v1/probe/jobs" && request.method() === "POST") {
      const input = request.postDataJSON() as ProbeJob; submissions.push(input);
      const terminal = mode === "instant" || (mode === "disconnect" && submissions.length > 1);
      const count = terminal ? input.nodes.length : mode === "hold" || mode === "disconnect" ? 1 : 0;
      const now = new Date().toISOString();
      current = { id: `fixture-job-${submissions.length}`, status: terminal ? "completed" : "running", createdAt: now, updatedAt: now, total: input.nodes.length, completed: count, phase: terminal ? "finished" : "checking", currentNodeId: input.nodes[count]?.id, report: { version: 1, source: "routekit-local-probe", generatedAt: now, results: results(input, count) } };
      body = current; status = 202;
    } else if (path.startsWith("/v1/probe/jobs/") && current) {
      if (mode === "disconnect" && !interrupted) {
        interrupted = true; current.completed = current.total; current.status = "completed"; current.phase = "finished";
        current.report.results = results(submissions.at(-1)!, current.completed);
        await route.abort("connectionreset"); return;
      }
      if (request.method() === "DELETE") { deletes++; current.status = "cancelled"; current.phase = "finished"; delete current.currentNodeId; status = 202; }
      else if (mode === "stream" && current.status === "running") {
        current.completed = Math.min(current.total, current.completed + 1);
        current.report.results = results(submissions.at(-1)!, current.completed);
        current.currentNodeId = submissions.at(-1)!.nodes[current.completed]?.id;
        if (current.completed === current.total) { current.status = "completed"; current.phase = "finished"; }
      }
      current.updatedAt = new Date().toISOString(); current.report.generatedAt = current.updatedAt; body = current;
    } else { body = { error: "unknown fixture endpoint" }; status = 404; }
    await route.fulfill({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
  });
  return { submissions, get deletes() { return deletes; } };
}

test("import automatically streams node results, sorts latency and routes the selected node", async ({ page }) => {
  const fixture = await helperFixture(page, "stream");
  await page.goto("/?view=nodes&tool=import");
  await expect(page.locator(".subscriptions-import")).toBeVisible();
  await expect(page.locator(".subscriptions-probe")).toBeHidden();
  await connect(page);
  await page.locator("#subscription-paste").fill([ss("Alpha", "alpha.example.com"), ss("Beta", "beta.example.com"), ss("Gamma", "gamma.example.com")].join("\n"));
  await page.getByRole("button", { name: "导入粘贴内容", exact: true }).click();
  await expect(page).toHaveURL(/tool=library/);
  await expect(page.getByRole("navigation", { name: "工具分类" }).getByRole("button", { name: "节点列表", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "工具分类" }).getByRole("button", { name: "导入订阅", exact: true })).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator(".subscriptions-batch-progress")).toContainText("1 / 3");
  await expect(page.locator(".subscriptions-table")).toContainText("203.0.113.1");
  await expect(page.locator(".subscriptions-batch-progress")).toContainText("检测完成");
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.submissions[0].options.speedTest).toBe(false);
  await expect(page.locator(".subscriptions-table tbody tr").first()).toContainText("Beta");
  await expect(page.locator(".subscriptions-table tbody tr").last()).toContainText("连接超时");
  await page.getByRole("button", { name: "将 Beta 用于分流", exact: true }).click();
  await expect(page).toHaveURL(/view=config/);
  await page.getByRole("button", { name: "完整配置", exact: true }).click();
  await expect(page.getByLabel("生成的配置内容", { exact: true })).toContainText("beta.example.com");
});

test("a lost first-batch poll resumes the retained terminal job and all remaining queued nodes", async ({ page }) => {
  const fixture = await helperFixture(page, "disconnect");
  await page.goto("/?view=nodes&tool=import");
  await connect(page);
  await page.locator("#subscription-paste").fill(Array.from({ length: 101 }, (_, index) => ss(`Resume ${index}`, `resume${index}.example.com`)).join("\n"));
  await page.getByRole("button", { name: "导入粘贴内容", exact: true }).click();
  await expect(page.locator(".subscriptions-batch-progress")).toContainText("检测已中断");
  await expect(page.locator(".subscriptions-batch-progress")).toContainText("1 个未提交节点保留");
  expect(fixture.submissions.map(job => job.nodes.length)).toEqual([100]);
  await page.getByRole("button", { name: "重新连接并继续队列", exact: true }).click();
  await expect(page.locator(".subscriptions-batch-progress")).toContainText("101 / 101");
  await expect(page.locator(".subscriptions-batch-progress")).toContainText("检测完成");
  expect(fixture.submissions.map(job => job.nodes.length)).toEqual([100, 1]);
  await expect(page.locator(".subscriptions-library .subscriptions-card-heading")).toContainText("101 个已有结果");
});

test("automatic detection splits all 101 imported nodes into bounded sequential batches", async ({ page }) => {
  const fixture = await helperFixture(page, "instant");
  await page.goto("/?view=nodes&tool=import");
  await connect(page);
  await page.locator("#subscription-paste").fill(Array.from({ length: 101 }, (_, index) => ss(`Node ${index}`, `node${index}.example.com`)).join("\n"));
  await page.getByRole("button", { name: "导入粘贴内容", exact: true }).click();
  await expect(page.locator(".subscriptions-batch-progress")).toContainText("101 / 101");
  expect(fixture.submissions.map(job => job.nodes.length)).toEqual([100, 1]);
  expect(new Set(fixture.submissions.flatMap(job => job.nodes.map(node => node.id))).size).toBe(101);
  expect(fixture.submissions.every(job => job.options.speedTest === false)).toBe(true);
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(101);
  await expect(page.locator(".subscriptions-library .subscriptions-card-heading")).toContainText("101 个已有结果");
});

test("cancel stops unsubmitted batches, retains partial results, and reconnect exposes the retained report without rebinding", async ({ page }) => {
  const fixture = await helperFixture(page, "hold");
  await page.goto("/?view=nodes&tool=import");
  await connect(page);
  await page.locator("#subscription-paste").fill(Array.from({ length: 101 }, (_, index) => ss(`Node ${index}`, `node${index}.example.com`)).join("\n"));
  await page.getByRole("button", { name: "导入粘贴内容", exact: true }).click();
  await expect(page.locator(".subscriptions-batch-progress")).toContainText("1 / 101");
  await page.getByRole("button", { name: "取消全部检测", exact: true }).click();
  await expect(page.locator(".subscriptions-batch-progress")).toContainText("检测已取消");
  expect(fixture.deletes).toBe(1);
  expect(fixture.submissions).toHaveLength(1);
  await expect(page.locator(".subscriptions-table")).toContainText("203.0.113.1");
  await showSection(page, "批量实测");
  await page.reload();
  await connect(page);
  await expect(page.locator(".subscriptions-previous-results")).toContainText("203.0.113.1");
  await expect(page.locator(".subscriptions-table tbody tr")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("workflow-fixture");
});
