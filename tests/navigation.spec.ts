import { expect, test } from "@playwright/test";

test("tool links and browser history restore the selected category", async ({ page }) => {
  await page.goto("/?view=nodes#subscription-library");
  const nav = page.getByRole("navigation", { name: "工具分类", exact: true });
  await expect(nav.getByRole("button", { name: "节点列表", exact: true })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("button", { name: "主机查询", exact: true }).click();
  await expect(page).toHaveURL(/view=network&tool=host$/);
  await expect(page.locator(".subscriptions-library")).toBeHidden();
  await nav.getByRole("button", { name: "连接设置", exact: true }).click();
  await expect(page.getByRole("tab", { name: "基础设置", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(nav.getByRole("button", { name: "主机查询", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(page.getByRole("tab", { name: "基础设置", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(page.getByRole("tab", { name: "基础设置", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await nav.getByRole("button", { name: "DNS 设置", exact: true }).click();
  await expect(page.getByRole("tab", { name: "DNS 保护", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("mobile groups show just their tools while keeping configuration edits", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 755 });
  await page.goto("/?view=config&tool=basic");
  const nav = page.getByRole("navigation", { name: "工具分类", exact: true });
  const lan = page.getByRole("switch", { name: /局域网保持直连/ });
  await lan.uncheck();
  await nav.getByRole("button", { name: "订阅与节点", exact: true }).click();
  await expect(nav.getByRole("button", { name: "导入订阅", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "网络概览", exact: true })).toBeHidden();
  await nav.getByRole("button", { name: "套餐用量", exact: true }).click();
  await expect(page.locator(".subscriptions-import")).toBeHidden();
  await nav.getByRole("button", { name: "分流配置", exact: true }).click();
  await nav.getByRole("button", { name: "连接设置", exact: true }).click();
  await expect(lan).not.toBeChecked();
  await expect(lan).toHaveCSS("height", "23px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
