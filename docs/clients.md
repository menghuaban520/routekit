# 客户端格式与导入

在“分流配置”的“导出到”选择客户端。切换会保留节点、应用绑定和高级设置，预览及下载格式随之改变；不能准确表达的字段会列出错误，修正后才能下载。三个导出器共用经校验的规则顺序，批量分流检查使用同一规则模型。Xray 的 UDP 限制通过对应目标规则前的 UDP 拦截规则表达；检查表按 TCP 去向解释，缺少解析 IP 时会标记待确认。

## Shadowrocket

下载 `.conf`，在小火箭的“配置”中导入并启用，全局路由选择“配置”。节点能够内嵌时直接写进配置；需要外部引用时，先下载并导入配套 `.nodes.txt`，保留 `RK_` 名称。没有指定代理节点时，`PROXY` 可以跟随小火箭当前节点。

## Clash / Mihomo

下载 `.yaml`，在使用 Mihomo 的客户端中导入为本地配置，启用后选择“规则”模式。节点写入 `proxies`，应用与自定义规则引用对应节点；无需配套节点文件。本轮面向 Mihomo，不承诺停止维护的旧 Clash 内核兼容。

代理流量需要绑定默认节点或应用专属节点；不会将缺少节点的代理规则改成直连。国内 IP 规则依赖 GeoIP 数据。首次启动提示 MMDB / DAT 缺失或下载超时时，请通过客户端的地理数据更新功能修复，再重试配置；不要只删除国内规则掩盖问题。[Mihomo 官方配置](https://wiki.metacubex.one/en/config/general/)、[实际缺库失败报告](https://github.com/MetaCubeX/mihomo/issues/2314)。

## v2rayN / Xray

`.json` 是可由 Xray 启动的自定义配置，不是普通节点订阅，也不是 v2rayN 应用设置备份：

1. 在 v2rayN 的服务器菜单选择添加自定义配置，导入 JSON。
2. Core 类型选择 **Xray**；编辑窗口的 **Socks 端口保持未设置**。填该字段会让 v2rayN 再启动前置分流，与单独运行此 JSON 不同。
3. 启用该配置，再在要代理的应用中手动设置 **SOCKS5 `127.0.0.1:10808`** 或 **HTTP `127.0.0.1:10809`**。仅开启 v2rayN 自动系统代理不保证端口与自定义配置一致。
4. 遇到端口占用，先停用占用同一端口的配置。国内 IP 规则需要 Xray 的 `geoip.dat`，由客户端管理其数据文件。

上述步骤依据[维护者的自定义配置说明](https://github.com/2dust/v2rayN/wiki/Description-of-some-ui)。本网页不启用 TUN、不修改系统代理；不能把 JSON 已导入当作所有应用已接管。[真实用户的自定义配置 TUN 反馈](https://github.com/2dust/v2rayN/issues/7135)说明该区别需要在目标设备实际核对。

Xray 内置 DNS 流量由专用标记优先送到直连出站，避免 DNS 请求再次依赖自身解析；DoH 主机名使用系统 DNS 引导，具体查询仍交给所选解析服务。此设置不承诺所有 DNS 都通过代理。

Xray 使用 `IPOnDemand` 处理 IP 规则，可能在匹配域名规则之前查询 DNS，与小火箭/Mihomo 逐条 `no-resolve` 不同。`UseIPv4` 限制内建 DNS 查询，不会关闭设备的 IPv6。系统 DNS、浏览器自己的 DoH 和应用解析也可能影响路径，不能由此证明无泄漏。[Xray 路由](https://xtls.github.io/en/config/routing.html)、[Xray DNS](https://xtls.github.io/en/config/dns.html)。

## Clash YAML 订阅导入

“导入订阅”支持粘贴、直接 HTTPS 读取以及 `.yaml` / `.yml` 文件。只取 `proxies` 中能准确转换的节点；原配置的规则、策略组、DNS、TUN 和其他设置不自动迁移。仅包含远程 `proxy-providers` 的文件不会触发额外下载，需要服务商提供实际节点内容。

使用 [yaml 2.9.0](https://eemeli.org/yaml/) 解析，沿用 2 MiB / 500 节点限制。语法错误、重复键、别名/合并、未知标签和不可保留的节点参数会明确报错；不采用“删掉未知字段再试”的转换方式。标准节点 URI 和 Base64 导入方式继续可用。旧版本本地助手用户应重新下载检测模块 `routekit_probe.py` 并重启助手，再运行这些节点的自动检测。

## 兼容范围与资料保管

已支持节点类型包括 SS、VMess、VLESS、Trojan、SOCKS5、HTTP / HTTPS，实际可导出的传输、安全和加密组合随客户端不同。未知参数、无法保留的设置或客户端不支持的组合会阻止对应节点导出。小火箭专属 General 参数不能直接搬到 YAML / Xray；切换格式会保留文本供你检查与清空。

配置文件和 RouteKit 方案备份可能含节点密码或密钥，请按私人文件保管。代码/语法校验只能证明给定环境中的可解析性；服务商连通、DNS 路径、系统代理与应用分流仍需在目标客户端实测。核验版本与实际证据见[验证记录](verification.md)。
