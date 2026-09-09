# RouteKit 网络与分流工具

[在线使用](https://routekit.menghuaban520.workers.dev) · [GitHub 源码](https://github.com/menghuaban520/routekit)

面向 Shadowrocket 用户的开源网页工具：导入订阅，把应用交给合适的节点，下载 `.conf`，再检查连接与分流结果。蓝白界面提供新手步骤与高级编辑，配置在本地生成。

React + TypeScript + Vite，搭配一个只返回当前请求 IP 信息的 Cloudflare Worker。MIT 开源；推荐 Workers 部署，也可自托管静态页面。

![RouteKit 桌面界面](docs/preview.png)

## 第一次使用

1. **导入节点。** 在“订阅与节点”填写服务商提供的 HTTPS 订阅地址；若浏览器无法读取，改为粘贴节点内容或导入 `.txt`。订阅链接是私人凭证，不要发送给公共转换站。
2. **给应用选去向。** 点节点的“用于分流”选择默认代理，再到“分流配置”为应用选择直连、代理或拦截。代理应用可以单独指定节点，也可跟随默认代理。
3. **补充自己的应用。** 点“自定义应用”，填写名称与域名，例如 `kugou.com`；不填 `https://`、路径或端口。规则按访问域名匹配，不会自动识别设备上的应用进程。
4. **下载并导入。** 如果出现“下载配套节点”，先把 `.nodes.txt` 导入小火箭并保留 `RK_` 开头的节点名，再导入 `.conf`。只有配置下载按钮时，所选的可内嵌节点已写入配置；未指定节点则使用客户端当前节点。
5. **连接并验证。** 在小火箭选用导入的配置、将全局路由设为“配置”后连接。返回“网络检查”确认出口与连通性，再按泄漏检查教程核对 DNS、WebRTC 和 IPv6；到“批量检查”核对域名的规则与目标节点。

直连使用当前所在地网络，并不自动获得中国大陆出口。内置应用域名是可编辑的起点，可能随服务变化，也可能与其他应用共用。客户端的导入入口依版本而异，可使用配置页的文件导入或系统分享菜单。

## 工具范围

| 工作区 | 可以做什么 |
| --- | --- |
| 网络检查 | 按需查询当前浏览器出口 IP、粗略位置与 ASN；三次 HTTPS 延迟检查、5 MB 流式下载测速；查看实际采样、错误与下一步。 |
| 主机查询 | 向 Cloudflare 公共 DoH 查询 A、AAAA、CNAME、MX、NS、TXT；公网 IP 自动查询 PTR。显示实际答复、TTL、DNSSEC 标记与查询时间。 |
| 泄漏检查 | 提供 DNSLeakTest、BrowserLeaks DNS / WebRTC、Test IPv6 的入口和对照步骤；结果需在外部检测页核对。 |
| 订阅与节点 | URI / Base64 列表导入、手动添加 SS、去重、搜索、筛选、节点导出，以及将节点用于应用分流。当前不解析 Clash YAML。 |
| 订阅用量 | 读取 `Subscription-Userinfo` 中的上传、下载、额度、剩余与到期快照；可刷新最近成功读取的订阅与节点，或手动导入服务商的头信息。 |
| 节点实测 | 使用自己的 Mihomo 核心批量检测，导回结果后查看出口、IP 属性、延迟、下载与估算距离，并按实测值排序。[检测器说明](docs/probe.md) |
| 实时上下行 | 可选本地只读监测器读取已经运行的 Mihomo，展示总速度、累计计数与活跃代理链路。[监测器说明](docs/monitor.md) |
| 分流配置 / 批量检查 | 编辑应用规则、默认代理、DNS、连接选项、Hosts 与高级规则；预览导出，按规则匹配域名和 IPv4 / IPv6，支持 CSV。 |

**Shadowrocket 的实时流量与连接记录在小火箭客户端内查看。** Mihomo 实时监测是另一个客户端的可选能力，不是小火箭 API，也不会自动切换小火箭节点。网页 HTTPS 请求耗时与 DoH 查询耗时都不是 ICMP Ping。

## 节点、配置与本地方案

基础 SS（支持的 AEAD 参数）以及可安全表达的 HTTP / HTTPS / SOCKS5 节点可写入 `.conf` 的 `[Proxy]` 段。含高级传输、额外参数、IPv6 地址或不能安全内嵌的凭证时，网页保留原节点 URI 的连接参数，生成配套 `.nodes.txt`；VMess 只改分享名称，其他协议只改备注。不要修改配套节点的 `RK_` 名称，分流配置使用它引用节点。具体协议和传输仍须由目标客户端支持。

未指定具体节点的 `PROXY` 策略跟随客户端当前节点。已绑定的应用会使用自己的节点；其余代理规则可跟随默认代理。规则预览和批量匹配说明配置会选择什么，不证明该节点已连通。

“保存到本地”最多保留 20 个方案，同名保存会更新原方案；编辑不会自动保存。“导出方案备份”生成可继续编辑的 RouteKit JSON；目前不能反向导入任意 `.conf`。清除站点数据或切换网站地址不会自动迁移方案。

**绑定节点后，本地方案、JSON 备份、配置和配套节点文件可能包含连接凭证。** 它们不是加密备份，应保存在自己的可信设备，分享前检查内容。未保存的订阅地址、用量与未绑定节点列表仅在当前页面会话中；已绑定节点可以随方案显式保存。

| 客户端 / 格式 | 当前范围 |
| --- | --- |
| Shadowrocket `.conf` | 完整配置导出目标，包含分流、DNS、连接设置及节点绑定；部分节点需配套 URI 文件。 |
| Clash / Mihomo YAML | 可用其核心做本地检测与实时监测；目前不导出此格式。 |
| v2rayN / Xray | 可导入已支持的节点分享 URI；目前不导出客户端完整配置。 |

Shadowsocks 是协议，Shadowrocket、Clash 系客户端与 v2rayN 是不同客户端。客户端适配需要各自的导出器，不能只改文件扩展名。“代理链路”页提供客户端设置步骤；网页不会建立代理链，需在小火箭中为出口节点设置“代理通过 / Proxy Pass”并实际验证。

## 数据与测量说明

配置编辑、订阅解析和文件生成在浏览器内完成，无账号或统计脚本。RouteKit 后端不接收订阅 URL、节点密码或配置。订阅读取直接请求你指定的 HTTPS 服务；不允许 CORS 时使用粘贴或文件导入，不经公共转换服务。用量来自服务商快照，缺失字段显示未知；网页不能改动套餐额度，也不把实时上下行累计当成服务商账单。

查看 IP 请求本网站的 Cloudflare API；延迟与下载请求 Cloudflare Speed。主机查询仅把你填写的公网域名或 IP 交给 Cloudflare 公共 DNS，不请求该目标主机。外部服务会看到访问它们的 IP。不同目标可能匹配不同分流规则，IP 结果不能代表所有应用的出口；IP 地理信息是粗略估计，ASN 不能单独证明住宅属性或信誉。

下载测速每次最多接收 5 MB 样本，完整接收才生成平均值；可停止，没有自动后台测速。经代理的检测会消耗套餐流量。DNS 加密配置、解析成功或打开外部检查页都不等于“没有泄漏”；按页面说明在同一个目标设备、浏览器与节点下对照结果。

两个 Python 工具均为可选：[节点检测器](docs/probe.md)启动隔离 Mihomo，逐个发出真实请求；[实时监测器](docs/monitor.md)仅读取现有 Mihomo 的本地接口。它们不经 RouteKit 服务器传输结果，不提供公网代理服务。

## 格式依据与核验范围

基础配置曾对照 Shadowrocket 2.2.92（3445）应用内置 `default.conf` 的 `[General]`、`[Rule]`、`[Host]`、`PROXY` / `DIRECT`、`GEOIP` / `FINAL` 核对。节点别名与 `[Proxy]` 编排参考[维护中的 Shadowrocket 配置](https://github.com/LOWERTOP/Shadowrocket/blob/main/lazy_group.conf)。这些是格式依据，生成文件仍需在目标客户端版本实际导入、连接和验证；实际检查范围见[验证记录](docs/verification.md)。

- [Shadowrocket 官方 App Store 页面](https://apps.apple.com/us/app/shadowrocket/id932747118)：配置导入、规则、加密 DNS 与多级代理。
- [官方发布频道的节点域名 DNS 说明](https://t.me/s/shadowrocketnews?after=930)：节点域名解析有独立设置。
- [Cloudflare DoH JSON 字段](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)：查询类型、TTL 与 DNSSEC 标记。
- [Mihomo 订阅用量解析](https://github.com/MetaCubeX/mihomo/blob/Meta/adapter/provider/subscription_info.go)：`Subscription-Userinfo` 是通用约定，并非标准 HTTP 字段；浏览器读取还需要服务商[暴露响应头](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers)。

## 本地开发与部署

使用 Node.js 24 和 npm：

```sh
npm ci
npm run dev
```

执行检查：

```sh
npm run check
npx playwright install chromium
npm run test:e2e
python3 -m unittest discover -s tests/python
```

`check` 包含 TypeScript、Vitest 与构建，浏览器和 Python 检查另行运行。静态文件位于 `dist/`，Worker 入口是 `src/worker.ts`。Vite 本地预览不提供真实 Cloudflare 出口信息；它也不模拟生产 `_headers`。

[Cloudflare 部署说明](docs/deployment.md)提供 Workers 和 Pages 路径；[贡献指南](CONTRIBUTING.md)说明如何补充域名与适配客户端。GitHub Actions 只做检查，源码与文档变更不代表演示站已完成对应版本发布。许可证为 [MIT](LICENSE)。
