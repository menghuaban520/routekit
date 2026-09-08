import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatUsageExpiry,
  formatUsagePercent,
  parseSubscriptionUsage,
  SUBSCRIPTION_USERINFO_CORS_NOTE,
} from "./subscription-usage";

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const nextDays = (days: number) => Math.floor((NOW + days * 86_400_000) / 1000);

describe("Subscription-Userinfo parsing and calculations", () => {
  it("accepts a complete case-insensitive header and preserves bytes and Unix-second expiry", () => {
    const usage = parseSubscriptionUsage(
      `Subscription-Userinfo: upload=1024; download=3072; total=8192; expire=${nextDays(30)}`,
      NOW,
    );
    expect(usage.errors).toEqual([]);
    expect(usage).toMatchObject({
      uploadBytes: 1024,
      downloadBytes: 3072,
      totalBytes: 8192,
      usedBytes: 4096,
      remainingBytes: 4096,
      usedPercent: 50,
      overageBytes: 0,
      expireUnixSeconds: nextDays(30),
      expiresAt: NOW + 30 * 86_400_000,
      expired: false,
      daysRemaining: 30,
    });
  });

  it("accepts a bare value, optional whitespace, leading zeroes and a trailing semicolon", () => {
    const usage = parseSubscriptionUsage(
      " UPLOAD = 0001 ; download=0; total = 5; ",
      NOW,
    );
    expect(usage.errors).toEqual([]);
    expect(usage).toMatchObject({
      uploadBytes: 1,
      downloadBytes: 0,
      usedBytes: 1,
      remainingBytes: 4,
      usedPercent: 20,
    });
  });

  it("extracts exactly the usage field from a pasted HTTP response without retaining other headers", () => {
    const usage = parseSubscriptionUsage(
      "HTTP/2 200\r\ncontent-type: text/plain\r\nsubscription-userinfo: upload=10; download=20; total=100\r\nset-cookie: private=value\r\n",
      NOW,
    );
    expect(usage.errors).toEqual([]);
    expect(usage.usedBytes).toBe(30);
    expect(JSON.stringify(usage)).not.toContain("private");
  });

  it("keeps missing fields unknown rather than inferring zero, no quota or permanent validity", () => {
    const usage = parseSubscriptionUsage("download=1024", NOW);
    expect(usage.downloadBytes).toBe(1024);
    for (const field of [
      "uploadBytes",
      "totalBytes",
      "usedBytes",
      "remainingBytes",
      "usedPercent",
      "expiresAt",
      "expired",
    ] as const)
      expect(usage[field]).toBeUndefined();
    expect(usage.warnings.join()).toContain("未知");
    expect(parseSubscriptionUsage("", NOW).uploadBytes).toBeUndefined();
    expect(
      parseSubscriptionUsage("HTTP/2 200\ncontent-type: text/plain", NOW)
        .warnings[0],
    ).toContain("没有 Subscription-Userinfo");
  });

  it("does not turn an unknown upload into zero to compute a deceptively low used amount", () => {
    const usage = parseSubscriptionUsage("download=20;total=100", NOW);
    expect(usage.usedBytes).toBeUndefined();
    expect(usage.remainingBytes).toBeUndefined();
    expect(usage.usedPercent).toBeUndefined();
  });

  it("retains an explicitly zero quota and never calls it unlimited", () => {
    const usage = parseSubscriptionUsage(
      "upload=0;download=0;total=0;expire=0",
      NOW,
    );
    expect(usage).toMatchObject({
      totalBytes: 0,
      usedBytes: 0,
      remainingBytes: 0,
      overageBytes: 0,
      expireUnixSeconds: 0,
    });
    expect(usage.usedPercent).toBeUndefined();
    expect(usage.expiresAt).toBeUndefined();
    expect(usage.expired).toBeUndefined();
    expect(usage.warnings.join()).toContain("不能据此视为无限");
    expect(usage.warnings.join()).toContain("不视为永久有效");
  });

  it("reports overage against zero or positive quota without negative remaining amounts", () => {
    const usage = parseSubscriptionUsage(
      "upload=40;download=80;total=100",
      NOW,
    );
    expect(usage).toMatchObject({
      usedBytes: 120,
      remainingBytes: 0,
      overageBytes: 20,
      usedPercent: 120,
    });
    expect(usage.warnings.join()).toContain("超出");
    expect(
      parseSubscriptionUsage("upload=1;download=2;total=0", NOW),
    ).toMatchObject({ overageBytes: 3, remainingBytes: 0 });
  });

  it("distinguishes exhausted quota from the approaching-quota warning", () => {
    expect(
      parseSubscriptionUsage(
        "upload=0;download=100;total=100",
        NOW,
      ).warnings.join(),
    ).toContain("已用完");
    expect(
      parseSubscriptionUsage(
        "upload=0;download=90;total=100",
        NOW,
      ).warnings.join(),
    ).toContain("接近");
    expect(
      parseSubscriptionUsage(
        "upload=0;download=89;total=100",
        NOW,
      ).warnings.join(),
    ).not.toContain("接近");
  });

  it("reports current/past expiry and upcoming expiry using an explicit clock", () => {
    for (const expire of [NOW / 1000, NOW / 1000 - 1])
      expect(parseSubscriptionUsage(`expire=${expire}`, NOW)).toMatchObject({
        expired: true,
        daysRemaining: 0,
      });
    expect(
      parseSubscriptionUsage(`expire=${nextDays(1)}`, NOW).warnings.join(),
    ).toContain("24 小时");
    expect(
      parseSubscriptionUsage(`expire=${nextDays(7)}`, NOW).warnings.join(),
    ).toContain("7 天");
    expect(
      parseSubscriptionUsage(`expire=${nextDays(8)}`, NOW).warnings.join(),
    ).not.toContain("天内到期");
  });

  it.each([
    "upload=-1",
    "download=1.5",
    "total=1e6",
    "upload=+1",
    "total=Infinity",
    "total=NaN",
    "total=1 GiB",
    "expire=0x10",
    "download=１",
    "upload=",
    "upload=1;;download=2",
    "upload=1; malformed",
    "upload=1;download=2, total=10",
    "upload=1\ndownload=2",
    "upload=1\u0000",
    "upload=1\u202e",
  ])("rejects malformed, negative or lossy input: %s", (header) => {
    const usage = parseSubscriptionUsage(header, NOW);
    expect(usage.errors.length).toBeGreaterThan(0);
    expect(usage.usedBytes).toBeUndefined();
  });

  it("rejects repeated headers, fields and obsolete folded values", () => {
    for (const text of [
      "Subscription-Userinfo: upload=1\nSubscription-Userinfo: upload=1",
      "upload=1;UPLOAD=2",
      "subscription-userinfo: upload=1;\n download=2",
    ])
      expect(parseSubscriptionUsage(text, NOW).errors.length).toBeGreaterThan(
        0,
      );
  });

  it("fails closed on a malformed known field rather than returning partly valid quota", () => {
    const usage = parseSubscriptionUsage("upload=1;download=2;total=-1", NOW);
    expect(usage.uploadBytes).toBeUndefined();
    expect(usage.downloadBytes).toBeUndefined();
    expect(usage.totalBytes).toBeUndefined();
  });

  it("ignores unsupported extensions with a warning but does not echo their contents", () => {
    const usage = parseSubscriptionUsage(
      "upload=1;download=2;total=10;custom=private-token",
      NOW,
    );
    expect(usage.errors).toEqual([]);
    expect(usage.usedBytes).toBe(3);
    expect(usage.warnings.join()).toContain("附加字段");
    expect(JSON.stringify(usage)).not.toContain("private-token");
  });

  it("rejects unsafe integers before converting them to Number", () => {
    expect(
      parseSubscriptionUsage("upload=9007199254740993", NOW).errors.join(),
    ).toContain("精确表示");
    expect(
      parseSubscriptionUsage("upload=9007199254740991;download=0", NOW)
        .usedBytes,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("preserves known counters but avoids overflow in their sum and derived values", () => {
    const usage = parseSubscriptionUsage(
      "upload=9007199254740991;download=1;total=9007199254740991",
      NOW,
    );
    expect(usage.uploadBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(usage.downloadBytes).toBe(1);
    expect(usage.usedBytes).toBeUndefined();
    expect(usage.remainingBytes).toBeUndefined();
    expect(usage.usedPercent).toBeUndefined();
    expect(usage.errors.join()).toContain("合计超出");
  });

  it("rejects expiry outside Date range and invalid comparison clocks", () => {
    expect(
      parseSubscriptionUsage("expire=8640000000001", NOW).errors.join(),
    ).toContain("日期范围");
    const usage = parseSubscriptionUsage(`expire=${nextDays(1)}`, Infinity);
    expect(usage.expiresAt).toBeDefined();
    expect(usage.expired).toBeUndefined();
    expect(usage.errors.join()).toContain("对比时间");
  });

  it("bounds untrusted pasted text and field values", () => {
    expect(
      parseSubscriptionUsage("a".repeat(32_769), NOW).errors.length,
    ).toBeGreaterThan(0);
    expect(
      parseSubscriptionUsage("total=" + "1".repeat(4096), NOW).errors.length,
    ).toBeGreaterThan(0);
  });
});

describe("subscription usage formatting", () => {
  it("uses explicit IEC units and keeps zero distinct from unknown", () => {
    expect(formatBytes()).toBe("未知");
    expect(formatBytes(null)).toBe("未知");
    expect(formatBytes(-1)).toBe("未知");
    expect(formatBytes(NaN)).toBe("未知");
    expect(formatBytes(Number.MAX_SAFE_INTEGER + 1)).toBe("未知");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 ** 3)).toBe("1 GiB");
  });

  it("does not cap an over-quota percentage at 100", () => {
    expect(formatUsagePercent()).toBe("未知");
    expect(formatUsagePercent(Infinity)).toBe("未知");
    expect(formatUsagePercent(120)).toBe("120%");
    expect(formatUsagePercent(0)).toBe("0%");
  });

  it("formats a valid expiry with time information and keeps unknown dates unknown", () => {
    expect(formatUsageExpiry()).toBe("未知");
    expect(formatUsageExpiry(Infinity)).toBe("未知");
    expect(formatUsageExpiry(8_640_000_000_000_001)).toBe("未知");
    expect(formatUsageExpiry(NOW)).toContain("2026");
    expect(formatUsageExpiry(NOW)).toMatch(/\d{2}:\d{2}/);
  });

  it("documents custom-header CORS exposure separately from successful download", () => {
    expect(SUBSCRIPTION_USERINFO_CORS_NOTE).toContain(
      "Access-Control-Expose-Headers: Subscription-Userinfo",
    );
    expect(SUBSCRIPTION_USERINFO_CORS_NOTE).toContain("不能当成 0");
  });
});
