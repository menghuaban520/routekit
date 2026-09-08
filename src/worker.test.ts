import { expect, test } from "vitest";
import worker, { connectionInfo } from "./worker";
test("returns the current request address and bounded Cloudflare metadata without accepting a target IP", async () => {
  const request = Object.assign(
    new Request("https://example.com/api/connection?ip=1.1.1.1", {
      headers: { "cf-connecting-ip": "203.0.113.8" },
    }),
    {
      cf: {
        country: "US",
        asn: 13335,
        city: "Example",
        latitude: "32.5",
        longitude: "-110.3",
        asOrganization: "Test Network",
      },
    },
  );
  const response = await worker.fetch(request);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    ip: "203.0.113.8",
    ipVersion: "IPv4",
    country: "US",
    asn: 13335,
    latitude: 32.5,
    organization: "Test Network",
  });
});
test("does not present local emulator location as real network data", () => {
  expect(
    connectionInfo(
      Object.assign(new Request("http://127.0.0.1/api/connection"), {
        cf: { country: "GB" },
      }),
    ),
  ).toMatchObject({ local: true, ip: null, country: null });
});
test("rejects methods and unrelated API paths", async () => {
  expect(
    (
      await worker.fetch(
        new Request("https://example.com/api/connection", {
          method: "POST",
          body: "secret",
        }),
      )
    ).status,
  ).toBe(405);
  expect(
    (await worker.fetch(new Request("https://example.com/api/other"))).status,
  ).toBe(404);
});
test("does not leak any request cookies or authorization to the response", () => {
  const result = JSON.stringify(
    connectionInfo(
      new Request("https://example.com/api/connection", {
        headers: { cookie: "private-cookie", authorization: "secret" },
      }),
    ),
  );
  expect(result).not.toContain("private-cookie");
  expect(result).not.toContain("secret");
});
