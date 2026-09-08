/**
 * Subscription-Userinfo is a client ecosystem convention, not a standard HTTP
 * field. Semantics checked against the implementations below; this independent
 * parser deliberately rejects lossy numbers and preserves missing data.
 */
export const SUBSCRIPTION_USAGE_SOURCES = [
  "https://github.com/MetaCubeX/mihomo/blob/Meta/adapter/provider/subscription_info.go",
  "https://github.com/MetaCubeX/metacubexd/blob/main/packages/ui/components/SubscriptionInfo.vue",
  "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers",
] as const;

export const SUBSCRIPTION_USERINFO_CORS_NOTE =
  "跨域读取订阅流量需要服务商允许本站访问，并暴露 Access-Control-Expose-Headers: Subscription-Userinfo。否则即使订阅下载成功，浏览器也可能读不到此头；读不到不能当成 0。携带凭证的请求不能仅用 * 暴露该头。";

export type SubscriptionUsage = {
  uploadBytes?: number;
  downloadBytes?: number;
  totalBytes?: number;
  usedBytes?: number;
  remainingBytes?: number;
  /** Actual ratio; may exceed 100. Clamp only when drawing a progress bar. */
  usedPercent?: number;
  overageBytes?: number;
  /** Raw expire value from the header, in Unix seconds. Zero is ambiguous. */
  expireUnixSeconds?: number;
  /** Unix milliseconds for new Date(...); undefined for absent or zero expiry. */
  expiresAt?: number;
  expired?: boolean;
  /** Rounded up for active subscriptions, zero after expiry. */
  daysRemaining?: number;
  errors: string[];
  warnings: string[];
};

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_DATE_SECONDS = 8_640_000_000_000n;
const DAY_MS = 86_400_000;
const FIELD_NAMES = ["upload", "download", "total", "expire"] as const;
type FieldName = (typeof FIELD_NAMES)[number];
const BAD_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const HEADER_LINE = /^[!#$%&'*+.^_`|~\da-z-]+\s*:/i;

function extractValue(
  input: string,
  result: SubscriptionUsage,
): string | undefined {
  if (typeof input !== "string" || input.length > 32_768) {
    result.errors.push("响应头需为不超过 32 KB 的文本。");
    return undefined;
  }
  if (BAD_CONTROL.test(input)) {
    result.errors.push("响应头包含不支持的控制字符或隐藏方向字符。");
    return undefined;
  }
  if (!input.trim()) {
    result.warnings.push(
      "未提供 Subscription-Userinfo，流量与到期时间均未知。",
    );
    return undefined;
  }
  const lines = input.split(/\r?\n/);
  const matches = lines.flatMap((line, index) => {
    const match = /^\s*subscription-userinfo\s*:(.*)$/i.exec(line);
    return match ? [{ value: match[1].trim(), index }] : [];
  });
  if (matches.length > 1) {
    result.errors.push(
      "发现多个 Subscription-Userinfo 响应头，请只保留需要检查的那一个。",
    );
    return undefined;
  }
  let value: string;
  if (matches.length) {
    const found = matches[0];
    const next = lines[found.index + 1];
    if (next && /^[ \t]+\S/.test(next) && !HEADER_LINE.test(next.trim())) {
      result.errors.push(
        "Subscription-Userinfo 被折行，请粘贴完整的单行头值。",
      );
      return undefined;
    }
    value = found.value;
  } else if (
    lines.some(
      (line) => HEADER_LINE.test(line.trim()) || /^HTTP\/\d/i.test(line.trim()),
    )
  ) {
    result.warnings.push(
      "粘贴的响应头中没有 Subscription-Userinfo；缺失信息保持未知。",
    );
    return undefined;
  } else value = input.trim();
  if (!value || value.length > 4096 || /[\r\n]/.test(value)) {
    result.errors.push("订阅流量头值需为不超过 4096 字符的单行文本。");
    return undefined;
  }
  return value;
}

function parseFields(
  value: string,
  result: SubscriptionUsage,
): Partial<Record<FieldName, number>> {
  const values: Partial<Record<FieldName, number>> = {};
  const seen = new Set<string>();
  const segments = value.split(";");
  // A single trailing semicolon is common and has no additional field.
  if (!segments.at(-1)?.trim()) segments.pop();
  if (!segments.length || segments.length > 32) {
    result.errors.push("订阅流量字段数量不正确。");
    return values;
  }
  for (const segment of segments) {
    const match = /^\s*([a-z][a-z\d_-]*)\s*=\s*([^;]*?)\s*$/i.exec(segment);
    if (!match) {
      result.errors.push(
        "字段格式应为 upload=整数; download=整数; total=整数; expire=整数。",
      );
      continue;
    }
    const name = match[1].toLowerCase();
    if (seen.has(name)) {
      result.errors.push(`字段 ${name} 重复，无法确定应使用哪个值。`);
      continue;
    }
    seen.add(name);
    if (!FIELD_NAMES.includes(name as FieldName)) {
      result.warnings.push(
        "忽略了不支持的附加字段，仅读取 upload、download、total、expire。",
      );
      continue;
    }
    const raw = match[2];
    if (!/^\d+$/.test(raw)) {
      result.errors.push(
        `字段 ${name} 必须是非负十进制整数，不接受小数、单位或科学计数法。`,
      );
      continue;
    }
    const integer = BigInt(raw);
    if (integer > MAX_SAFE) {
      result.errors.push(`字段 ${name} 超出 JavaScript 可精确表示的整数范围。`);
      continue;
    }
    if (name === "expire" && integer > MAX_DATE_SECONDS) {
      result.errors.push(
        "expire 超出可表示的日期范围，请确认使用 Unix 秒而不是其他单位。",
      );
      continue;
    }
    values[name as FieldName] = Number(integer);
  }
  return values;
}

export function parseSubscriptionUsage(
  header: string,
  nowMs = Date.now(),
): SubscriptionUsage {
  const result: SubscriptionUsage = { errors: [], warnings: [] };
  const value = extractValue(header, result);
  if (value === undefined) return result;
  const fields = parseFields(value, result);
  result.warnings = [...new Set(result.warnings)];
  // A malformed or duplicated known field invalidates the header as a whole.
  if (result.errors.length) {
    result.errors = [...new Set(result.errors)];
    return result;
  }
  result.uploadBytes = fields.upload;
  result.downloadBytes = fields.download;
  result.totalBytes = fields.total;
  result.expireUnixSeconds = fields.expire;

  if (fields.upload !== undefined && fields.download !== undefined) {
    const used = BigInt(fields.upload) + BigInt(fields.download);
    if (used > MAX_SAFE)
      result.errors.push(
        "上传与下载合计超出可精确表示的整数范围，已用、剩余与占比保持未知。",
      );
    else result.usedBytes = Number(used);
  } else
    result.warnings.push("上传或下载字段缺失，已用、剩余与占比不能完整计算。");

  if (fields.total === undefined)
    result.warnings.push("服务商未提供总额度，剩余流量与占比未知。");
  else {
    if (fields.total === 0)
      result.warnings.push(
        "服务商报告总额度为 0，不能据此视为无限流量；占比未知，请向服务商核对其含义。",
      );
    if (result.usedBytes !== undefined) {
      result.remainingBytes = Math.max(0, fields.total - result.usedBytes);
      result.overageBytes = Math.max(0, result.usedBytes - fields.total);
      if (fields.total > 0)
        result.usedPercent = (result.usedBytes / fields.total) * 100;
      if (result.overageBytes > 0)
        result.warnings.push(
          `已用流量超出所报告额度 ${formatBytes(result.overageBytes)}。`,
        );
      else if (fields.total > 0 && result.remainingBytes === 0)
        result.warnings.push("所报告的订阅流量额度已用完。");
      else if (result.usedPercent !== undefined && result.usedPercent >= 90)
        result.warnings.push(
          `订阅流量已使用 ${formatUsagePercent(result.usedPercent)}，接近所报告额度。`,
        );
    }
  }

  if (fields.expire === undefined)
    result.warnings.push("服务商未提供到期时间，不能据此认为永久有效。");
  else if (fields.expire === 0)
    result.warnings.push(
      "expire=0 的含义取决于服务商；到期时间标为未知，不视为永久有效。",
    );
  else {
    result.expiresAt = fields.expire * 1000;
    if (
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0 ||
      nowMs > Number(MAX_DATE_SECONDS) * 1000
    )
      result.errors.push("当前对比时间无效，未判断是否到期。");
    else {
      const remainingMs = result.expiresAt - nowMs;
      result.expired = remainingMs <= 0;
      result.daysRemaining = Math.max(0, Math.ceil(remainingMs / DAY_MS));
      if (result.expired)
        result.warnings.push(
          "订阅已到所报告的到期时间，请向服务商核对续期状态。",
        );
      else if (remainingMs <= DAY_MS)
        result.warnings.push("订阅将在 24 小时内到期。");
      else if (remainingMs <= 7 * DAY_MS)
        result.warnings.push(`订阅将在 ${result.daysRemaining} 天内到期。`);
    }
  }
  return result;
}

/** IEC units: 1 KiB = 1024 bytes. Invalid and missing values never become zero. */
export function formatBytes(value?: number | null): string {
  if (
    value === undefined ||
    value === null ||
    !Number.isSafeInteger(value) ||
    value < 0
  )
    return "未知";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let quantity = value,
    unit = 0;
  while (quantity >= 1024 && unit < units.length - 1) {
    quantity /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: unit ? 2 : 0 }).format(quantity)} ${units[unit]}`;
}

export function formatUsagePercent(value?: number | null): string {
  if (
    value === undefined ||
    value === null ||
    !Number.isFinite(value) ||
    value < 0
  )
    return "未知";
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value)}%`;
}

/** Render in the viewer's local time zone and include its name/offset. */
export function formatUsageExpiry(expiresAt?: number | null): string {
  if (
    expiresAt === undefined ||
    expiresAt === null ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0 ||
    expiresAt > Number(MAX_DATE_SECONDS) * 1000
  )
    return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(expiresAt));
}
