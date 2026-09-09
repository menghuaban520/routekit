import { describe, expect, it } from "vitest";
import {
  compileProfile,
  createProfile,
  parseProfile,
  serializeProfile,
} from "./index";
import { diagnoseBatch, diagnosticsToCsv } from "./diagnostics";
import {
  createSsNode,
  parseSubscription,
  proxyNodeIdentity,
  type ProxyNode,
} from "./subscriptions";
import {
  compileRoutingNodes,
  nodeRoutingSupport,
  resolveRouteNode,
  routePolicyLabel,
  routingNodeBundle,
} from "./node-routing";

const id = "11111111-1111-4111-8111-111111111111";
function ss(name = "香港一", password = "sample-password"): ProxyNode {
  return {
    ...createSsNode({
      name,
      server: name === "香港一" ? "node.example.com" : "us.example.com",
      port: 8388,
      method: "aes-256-gcm",
      password,
    }),
    id: name === "香港一" ? "hk" : "us",
  };
}
function urlNode(uri: string): ProxyNode {
  const result = parseSubscription(uri);
  expect(result.errors).toEqual([]);
  return { ...result.nodes[0], id: "external" };
}
function configured() {
  const profile = createProfile();
  profile.nodeRouting = {
    nodes: [ss(), ss("美国一")],
    defaultNodeId: "hk",
    appNodeIds: { youtube: "us" },
  };
  return profile;
}

describe("node routing and client exports", () => {
  it("embeds only actually used nodes with deterministic aliases and keeps non-proxy semantics", () => {
    const profile = configured();
    const compiled = compileProfile(profile);
    expect(compiled.errors).toEqual([]);
    expect(compiled.content).toContain(
      "RK_hk = ss, node.example.com, 8388, password=sample-password, method=aes-256-gcm",
    );
    expect(compiled.content).toContain("DOMAIN-SUFFIX,youtube.com,RK_us");
    expect(compiled.content).toContain("DOMAIN-SUFFIX,telegram.org,RK_hk");
    expect(compiled.content).toContain("DOMAIN-SUFFIX,kugou.com,DIRECT");
    expect(compiled.content).toContain("FINAL,RK_hk");
    expect(routingNodeBundle(profile).count).toBe(0);
    expect(routePolicyLabel(profile, "PROXY", { appId: "youtube" })).toBe(
      "美国一",
    );
    expect(
      resolveRouteNode(profile, "REJECT", { appId: "youtube" }),
    ).toBeUndefined();
    profile.apps.find((app) => app.id === "youtube")!.policy = "DIRECT";
    expect(compileRoutingNodes(profile).map((node) => node.node.id)).toEqual([
      "hk",
    ]);
    expect(compileProfile(profile).content).not.toContain("RK_us");
  });

  it("round-trips selected node snapshots through existing JSON backup APIs", () => {
    const profile = configured();
    const restored = parseProfile(serializeProfile(profile));
    expect(restored).toEqual(profile);
    expect(compileProfile(restored).content).toBe(
      compileProfile(profile).content,
    );
    expect(
      parseProfile(serializeProfile(createProfile())).nodeRouting,
    ).toBeUndefined();
  });

  it("honors explicit rule binding before app binding and reports the real node", () => {
    const profile = configured();
    profile.rules.push({
      id: "special",
      type: "DOMAIN",
      value: "www.youtube.com",
      policy: "PROXY",
    });
    profile.nodeRouting!.ruleNodeIds = { special: "hk" };
    const result = diagnoseBatch(
      profile,
      "www.youtube.com\nvideo.youtube.com\nwww.kugou.com",
    );
    expect(result.errors).toEqual([]);
    expect(
      result.results.map((row) => [row.policy, row.nodeName, row.nodeId]),
    ).toEqual([
      ["PROXY", "香港一", "hk"],
      ["PROXY", "美国一", "us"],
      ["DIRECT", undefined, undefined],
    ]);
    expect(result.results[0].nodeMode).toBe("embedded");
    expect(diagnosticsToCsv(result.results)).toContain(
      '"绑定节点","节点配置方式"',
    );
    expect(
      compileProfile(profile).warnings.some((warning) =>
        warning.includes("范围重叠且策略不同"),
      ),
    ).toBe(true);
  });

  it("does not report a concrete node when an earlier country match can choose a different node", () => {
    const profile = configured();
    profile.apps = [];
    profile.domesticPolicy = "DIRECT";
    const unknown = diagnoseBatch(profile, "8.8.8.8").results[0];
    expect(unknown.status).toBe("needs-country");
    expect(unknown.nodeName).toBeUndefined();
    const known = diagnoseBatch(profile, "8.8.8.8,US").results[0];
    expect(known.nodeName).toBe("香港一");
  });

  it.each([
    `vless://${id}@node.example.com:443?security=reality&type=tcp&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=abcd&flow=xtls-rprx-vision#日本`,
    "trojan://password@node.example.com:443?sni=sni.example.com&type=ws&path=%2Fhello&host=host.example.com#日本",
    `vmess://${Buffer.from(JSON.stringify({ v: "2", ps: "日本", add: "node.example.com", port: "443", id, net: "ws", tls: "tls", path: "/sample", unknownOption: "preserved" })).toString("base64")}`,
    "ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@node.example.com:8388/?plugin=v2ray-plugin%3Btls%3Bhost%3Dexample.com#日本",
  ])(
    "preserves every URI connection field for the explicit two-file workflow: %s",
    (uri) => {
      const node = urlNode(uri);
      expect(nodeRoutingSupport(node)).toMatchObject({
        supported: true,
        mode: "reference",
      });
      const profile = createProfile();
      profile.nodeRouting = { nodes: [node], defaultNodeId: node.id };
      const compiled = compileProfile(profile),
        bundle = routingNodeBundle(profile);
      expect(compiled.errors).toEqual([]);
      expect(compiled.content).toContain(
        "# REQUIRED: import the companion node URI file",
      );
      expect(compiled.content).toContain("FINAL,RK_external");
      expect(compiled.content).not.toContain("[Proxy]");
      expect(
        compiled.warnings.some((text) => text.includes("仅下载 .conf")),
      ).toBe(true);
      expect(bundle).toMatchObject({ count: 1, referenceCount: 1, errors: [] });
      const imported = parseSubscription(bundle.content);
      expect(imported.errors).toEqual([]);
      expect(imported.nodes[0].name).toBe("RK_external");
      expect(proxyNodeIdentity(imported.nodes[0])).toBe(
        proxyNodeIdentity(node),
      );
      expect(
        diagnoseBatch(profile, "www.youtube.com").results[0],
      ).toMatchObject({
        policy: "PROXY",
        nodeName: "日本",
        nodeMode: "reference",
      });
    },
  );

  it.each(["http", "https", "socks5"])(
    "embeds supported %s credentials positionally",
    (protocol) => {
      const node = urlNode(
        `${protocol}://user:pass@node.example.com:8080#test`,
      );
      const profile = createProfile();
      profile.nodeRouting = { nodes: [node], defaultNodeId: node.id };
      expect(compileProfile(profile).content).toContain(
        `RK_external = ${protocol}, node.example.com, 8080, user, pass`,
      );
    },
  );

  it.each([
    "x,password=evil",
    "x[Rule]",
    "with whitespace",
    'quote"here',
    "base64==",
  ])(
    "preserves delimiter-bearing credentials only in separate URI import: %s",
    (password) => {
      const node = ss("香港一", password);
      expect(nodeRoutingSupport(node)).toMatchObject({
        supported: true,
        mode: "reference",
      });
      const profile = createProfile();
      profile.nodeRouting = { nodes: [node], defaultNodeId: node.id };
      const result = compileProfile(profile);
      expect(result.content).not.toContain(password);
      expect(result.content.match(/^\[Rule\]$/gm)).toHaveLength(1);
      expect(
        proxyNodeIdentity(
          parseSubscription(routingNodeBundle(profile).content).nodes[0],
        ),
      ).toBe(proxyNodeIdentity(node));
    },
  );

  it("rejects malformed snapshots, missing references and unsafe identifiers without credentials in errors", () => {
    for (const corrupt of [
      { ...ss(), id: "x,REJECT" },
      { ...ss(), uri: "ss://secrets\n[Rule]" },
      { ...ss(), server: "different.example.com" },
      { ...ss(), extra: "arbitrary" },
    ]) {
      const profile = createProfile();
      profile.nodeRouting = { nodes: [corrupt], defaultNodeId: corrupt.id };
      const result = compileProfile(profile);
      expect(result.content).toBe("");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.join("")).not.toContain("secrets");
      expect(nodeRoutingSupport(corrupt).supported).toBe(false);
    }
    const profile = configured();
    profile.nodeRouting!.defaultNodeId = "missing";
    expect(compileProfile(profile).errors[0]).toContain("不存在");
    expect(() => serializeProfile(profile)).toThrow("不存在");
    profile.nodeRouting!.defaultNodeId = "hk";
    profile.nodeRouting!.nodes.push(ss());
    expect(compileProfile(profile).errors[0]).toContain("不能重复");
  });

  it("keeps identically named nodes separate, and flags different destinations for duplicate rules", () => {
    const profile = configured();
    profile.nodeRouting!.nodes[1].name = "香港一";
    profile.rules.push({
      id: "duplicate",
      type: "DOMAIN-SUFFIX",
      value: "youtube.com",
      policy: "PROXY",
    });
    profile.nodeRouting!.ruleNodeIds = { duplicate: "hk" };
    const result = compileProfile(profile);
    expect(result.content).toContain("DOMAIN-SUFFIX,youtube.com,RK_hk");
    expect(result.content).not.toContain("DOMAIN-SUFFIX,youtube.com,RK_us");
    expect(
      result.warnings.some((warning) => warning.includes("存在不同策略")),
    ).toBe(true);
  });
});
