type EdgeRequest = Request & { cf?: Record<string, unknown> };
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
export function connectionInfo(request: EdgeRequest) {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(request.url).hostname,
  );
  const cf = local ? {} : (request.cf ?? {});
  const text = (key: string) =>
    typeof cf[key] === "string" ? String(cf[key]).slice(0, 200) : null;
  const number = (key: string) =>
    cf[key] !== null &&
    cf[key] !== undefined &&
    Number.isFinite(Number(cf[key]))
      ? Number(cf[key])
      : null;
  const ip = local ? null : request.headers.get("cf-connecting-ip");
  return {
    source: "cloudflare-request",
    local,
    ip,
    ipVersion: ip ? (ip.includes(":") ? "IPv6" : "IPv4") : null,
    country: text("country"),
    region: text("region"),
    city: text("city"),
    asn: number("asn"),
    organization: text("asOrganization"),
    latitude: number("latitude"),
    longitude: number("longitude"),
    colo: text("colo"),
    tlsVersion: text("tlsVersion"),
    timestamp: new Date().toISOString(),
  };
}
export default {
  async fetch(request: EdgeRequest): Promise<Response> {
    if (new URL(request.url).pathname !== "/api/connection")
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers,
      });
    if (request.method !== "GET")
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...headers, Allow: "GET" },
      });
    return new Response(JSON.stringify(connectionInfo(request)), { headers });
  },
};
