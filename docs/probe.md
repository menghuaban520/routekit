# 本地节点检测器

`public/routekit_probe.py` 用你电脑上已有的 mihomo 核心逐个连接节点，再从该节点发出 HTTPS 检测请求。网页可通过[本地助手](monitor.md)直接提交任务并显示进度，也可生成私人任务文件离线执行。RouteKit 服务器不接收节点密码；浏览器不能自行切换任意代理协议，真实节点检测在本机执行。

本页记录手动文件流程，网页一键检测优先使用[本地助手](monitor.md)。助手的实时流量功能只读取已有 Mihomo，批量检测功能才启动隔离核心。Shadowrocket 实时流量在小火箭客户端内查看，两个 Python 工具都不是小火箭 API。

需要 Python 3.10 或更新版本，以及可单独运行的 [mihomo 官方核心](https://github.com/MetaCubeX/mihomo/releases)。Python 脚本仅使用标准库，不安装依赖、不下载核心、不修改系统代理或 TUN。RouteKit 脚本采用 MIT；mihomo 独立发行并使用其自己的 [GPL-3.0 许可证](https://github.com/MetaCubeX/mihomo/blob/Meta/LICENSE)，本仓库不附带核心二进制。

## 手动文件方式

1. 在 RouteKit 节点页面导入节点并导出检测任务 JSON，再下载本地检测脚本。
2. 在终端运行下面的命令；将文件位置替换为你的实际路径。
3. 完成后，将结果 JSON 导入网页。中途按 `Ctrl+C` 也可以导入已经完成的节点结果。

导入结果后可按延迟或速度排序，点“用于分流”选默认代理，再为应用单独选择节点。若配置提示下载配套 `.nodes.txt`，先把它导入小火箭并保留 `RK_` 节点名称，再导入 `.conf`。检测通过只验证本次测试目标，不代表所有应用和 DNS 路径都已正确。

```sh
python3 routekit_probe.py \
  --input routekit-probe-job.json \
  --output routekit-probe-results.json \
  --core /path/to/mihomo
```

若 `mihomo` 已在 PATH 中，可以省略 `--core`。找不到核心时脚本明确退出，不会自动安装。输入和输出必须是不同文件。退出码：`0` 全部成功，`1` 至少一个节点或步骤失败，`2` 任务/环境错误，`130` 用户取消。

检测任务包含原始节点链接及凭证，应只保存在你信任的本机目录。结果文件不包含节点链接、密码或 UUID，但包含节点名称、服务器地址、入口 IP 与实际出口位置，分享前仍应检查。

## 能测到什么

| 字段 | 实际含义 |
| --- | --- |
| `server` / `serverIps` | 配置中的入口主机与本机系统 DNS 解析结果。不是出口 IP；DNS 解析最多等待 3 秒。 |
| `exitIp` | 经选定节点访问 IP 服务时，该服务实际看到的公网源地址。 |
| `latencyMs` | 经代理访问 `https://www.gstatic.com/generate_204`，从请求开始到收到预期 HTTP 204 的耗时，包含连接、代理握手和 TLS；不是 ICMP ping。 |
| `speedMbps` / `downloadedBytes` | 可选下载测试中实际收到的正文长度，以及长度除以整次请求耗时得到的 Mbps；包含握手和首字节等待，不是线路峰值带宽。 |
| 位置 / ASN / 公司 | IP 数据服务返回的出口信息。坐标是 IP 地理定位估计，不能当作机房精确地址。 |
| `ipType` | 仅映射数据服务明确给出的机房、移动网络、VPN、代理标记；否则 `unknown`。ISP 所有权不能证明是住宅 IP。 |

本工具不测 DNS 泄漏、不覆盖所有应用、不测上传速度或丢包，也不把测速快慢转换成“纯净度”评分。节点位置之间的地理距离只能作为位置估计，不能替代实测延迟。网络页的主机查询是公共 DoH 解析，不能代替节点握手；泄漏检查页提供 DNS / WebRTC / IPv6 的对照步骤，需保持目标客户端与节点连接后实际检查。

每个节点依次检测，唯一策略组 `PROBE` 切换成功并核对当前选择后才发出请求。必要检测步骤无结果时保留其他已经完成的测量，并将 `status` 标记为 `error`；未测到的字段缺省，不填零或猜测值。出口信息服务失败但备用出口检查成功时，`status` 可为 `ok`，同时在 `warnings` 明确原服务失败及缺失信息。

## 数据服务与流量

出口信息使用 [ipapi.is 官方 API](https://ipapi.is/developers.html)，不传 `q`，由服务识别请求出口。按 2026-09-08 核对的官方规则，匿名请求每个出口 IPv4 或 IPv6 `/64` 每 UTC 日最多 100 次，返回基本 IP、公司、ASN 和位置；完整类型标记需要已有 API key。共享节点上的其他用户可能消耗相同额度。脚本每次 IP 请求至少间隔 1.2 秒；遇到 HTTP 429 或 403 后，本轮不再调用该服务，不通过重试绕过限额。

已有 ipapi.is API key 时，可从环境变量读取；无需把 key 写进任务文件：

```sh
python3 routekit_probe.py \
  --input routekit-probe-job.json \
  --output routekit-probe-results.json \
  --core /path/to/mihomo \
  --ipapi-key-env ROUTEKIT_IPAPI_KEY
```

运行前须自行设置 `ROUTEKIT_IPAPI_KEY` 环境变量。key 只通过 HTTPS 发给 ipapi.is，不写进结果或控制台，不会自动申请账号或付费套餐。检测在 Python 中进行，不依赖浏览器 CORS，也不需要网站获得本地控制接口权限。

若 ipapi.is 不可用或限流，检测器额外经同一节点请求一次 `https://speed.cloudflare.com/cdn-cgi/trace`（正文上限 16 KB），使用其中通过校验的公网 IP 与两位国家代码，并在 `warnings` 注明来源。这个 [Cloudflare 诊断端点](https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/) 不提供城市、ASN 或业务类型；这些字段保持缺省或未知，不从 Cloudflare 的服务机房代号推测节点位置。备用检查不使用 API key。

下载测速默认关闭，开启后请求 [Cloudflare 官方测速端点](https://github.com/cloudflare/speedtest) `https://speed.cloudflare.com/__down?bytes=...`。每个节点只下载一个样本，正文上限 5,000,000 字节（5 MB）；协议开销和前两项检测另计。脚本不上传测速正文。外部服务会看到该节点的实际出口 IP，并可能依其自身规则记录请求。

## 支持的节点格式

| 协议 | 本工具支持范围 |
| --- | --- |
| Shadowsocks | [SIP002](https://shadowsocks.org/doc/sip002.html) 的 Base64URL 或明文百分号编码认证，以及可解析的旧版完整 Base64 链接；常见 AEAD / AEAD-2022 加密。插件明确拒绝。 |
| VMess | [v2rayN VMess v2 分享 JSON](https://github.com/2dust/v2rayN/wiki/Description-of-VMess-share-link)；普通 TCP、WS、gRPC；可选 TLS。 |
| VLESS | 标准 UUID；普通 TCP、WS、gRPC；TLS、Reality；兼容组合下的 `xtls-rprx-vision`。 |
| Trojan | TLS，普通 TCP、WS、gRPC；密码、SNI、ALPN 和已支持的客户端指纹。 |
| HTTP / HTTPS / SOCKS5 | URL 中的服务器、端口及可选用户名/密码；HTTPS 支持可选 SNI。 |

映射依据 mihomo 官方的 [SS](https://wiki.metacubex.one/en/config/proxies/ss/)、[VMess](https://wiki.metacubex.one/en/config/proxies/vmess/)、[VLESS](https://wiki.metacubex.one/en/config/proxies/vless/)、[Trojan](https://wiki.metacubex.one/en/config/proxies/trojan/)、[HTTP](https://wiki.metacubex.one/en/config/proxies/http/)、[SOCKS](https://wiki.metacubex.one/en/config/proxies/socks/) 和 [传输设置](https://wiki.metacubex.one/en/config/proxies/transport/)。mihomo 能支持的能力多于本工具能可靠转换的分享链接参数；XHTTP、KCP、HTTP 伪装、插件、未知参数及要求跳过 TLS 验证的链接均报单节点错误，不自动降级为普通 TCP。

## 隔离与接口约定

核心配置位于私有临时目录，配置文件权限 `0600`；代理端口和控制端口均绑定 `127.0.0.1` 的临时端口，分别使用随机认证密码与随机控制 secret。无外部面板、订阅下载、规则下载或直接连接兜底。每个节点先单独进行核心 `-t` 校验，避免一个无效密钥阻断其余节点。控制流程依据 [mihomo API 文档](https://wiki.metacubex.one/en/api/)，逐次 PUT 选择并 GET 核实。

检测请求显式经过本地 HTTP CONNECT，不读取系统 HTTP 代理或 `NO_PROXY`，不跟随 HTTP 重定向；HTTPS 证书与主机名验证保持开启。已有系统级 VPN/TUN 仍可能影响本机网络路径。正常结束、异常、`Ctrl+C` 或 SIGTERM 会关闭所启动的核心并删除临时配置；强制杀死进程或断电无法保证执行清理。核心日志不输出，错误文本不会回显节点 URI 或第三方响应正文。

输入（最多 100 节点、2 MB；以下凭证只是不可用的示例）：

```json
{
  "version": 1,
  "nodes": [{
    "id": "sample-1", "name": "本地示例", "protocol": "http",
    "server": "127.0.0.1", "port": 8080,
    "uri": "http://fixture:example@127.0.0.1:8080"
  }],
  "options": { "speedTest": false, "downloadBytes": 1000000, "timeoutSeconds": 8 }
}
```

`timeoutSeconds` 为每个 HTTPS 请求的 3–15 秒总时限；下载字节数为 1–5,000,000。根级别和节点结构严格校验；不允许重复节点 ID。URI 中的主机与端口须与对应元数据一致。

输出根字段固定为 `version: 1`、`generatedAt`（UTC ISO 日期）、`source: "routekit-local-probe"`、`results`。结果项包含 `nodeId/name/server/protocol/status`，以及实际测到的 `latencyMs/speedMbps/downloadedBytes/exitIp/country/region/city/asn/organization/ipType/latitude/longitude/serverIps`；说明与错误分别为 `warnings: string[]`、`error: string`。每完成一个节点就原子替换结果文件，中断时保留此前完整结果。

## 验证

```sh
python3 -m unittest discover -s tests/python -v
```

节点检测器的离线回归使用虚构节点、mock 核心与 mock HTTPS 响应，覆盖协议转换、拒绝不支持参数、输出去凭证、实际字节计速公式、TLS / CONNECT 路径、串行选择、限流停止、部分结果与清理，以及小响应读完关闭 socket 的边界。上述命令也会运行实时监测器的独立测试；以本次测试输出为准，不证明任何私人节点可用。

2026-09-08 发布验收另使用从 [官方 v1.19.30 release](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.30) 临时下载的 Darwin arm64 核心，压缩包 SHA-256 与官方 release 元数据的 `2c7f3a7904fa1cee291e124123e630e7b1ebd13765dd9bf26c0a28432004d9f4` 一致。8 类安全样本实际 `-t` 通过并成功启动隔离核心。

实际链路验收使用两个独立端口上的本地认证 HTTP CONNECT fixture：核心按顺序选择两个节点，各自完成 gstatic HTTP 204、ipapi.is 实际出口查询，以及 Cloudflare 125,000 字节下载。监听记录确认请求先经过对应的本地 fixture；两节点返回 `status: ok`。这验证了检测器完整链路与数据读取，不代表任何用户节点的速度、出口质量或 DNS 泄漏情况。验证结束已关闭所有临时监听、核心进程并删除下载的二进制和结果文件，未在系统安装核心。
