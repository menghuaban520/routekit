# v0.6.0 验证记录

验证日期：2026-09-09。对应本次多客户端导出、Clash YAML 导入与本地检测参数兼容；Node 24.18.1、yaml 2.9.0、Chromium，真实 Mihomo 为本机稳定版 v1.19.25。下面区分本次验证和沿用的历史证据。

## 本次代码与浏览器验证

- TypeScript 构建、11 个文件中的 **338 项单元测试**以及 Vite 生产构建通过。受本机瞬时调度影响，单元测试用单 worker、CLI 60 秒超时执行；未修改项目的默认测试超时。
- **48 项 Python 检查通过**，新增真实跨语言路径：当前 TypeScript YAML 导入器生成七协议 URI → Python 检测器转换 → 本机 Mihomo `-t`。核对 UDP/TFO、VMess TLS 标志、VLESS Reality、Trojan WS、HTTPS SNI/ALPN 与特殊密码；未知和不安全参数仍明确拒绝。
- **26 项受影响的浏览器回归通过**：新增三项客户端流程，加上原配置、节点绑定、订阅、自动检测与真实本地 HTTP 监测器回归。
- 新流程从实际 `.yaml` 文件导入两个示例节点，绑定默认与 YouTube 节点，依次下载真实 `.yaml` / `.json` 并解析文件内容。核对特殊密码、规则目标、UDP 默认关闭的保留、Xray 的 UDP 拦截、两个回环入站的协议和端口。
- 切换客户端会同步格式、预览及导入教程；缺代理节点或小火箭专属 General 参数时阻止新格式下载。切换不会删除 General 文本，清空后恢复导出。v2rayN 方案保存、刷新和恢复后仍保持客户端选择及节点绑定，批量诊断继续可用。
- YAML 检查包含七种协议、TLS/WS/gRPC/Reality 参数、导出后回导、2 MiB / 500 节点限制，以及重复键、别名、合并、标签、原型属性、资源预算和一万层嵌套的提前拒绝。原 URI / Base64 解析与稳定节点 ID 回归保留。
- 1440px 桌面和 375px 手机检查客户端选择器、配置预览、下载和说明，无页面横向溢出。五张最终前端构建截图没有运行时错误：[Mihomo](preview-clash.png)、[Xray](preview-xray.png)、[手机客户端选择](preview-client-mobile.png)、[小火箭桌面](preview-config.png)、[小火箭手机](preview-config-mobile.png)。仅使用 example.com 示例节点，没有用户 IP、订阅或凭证。

## 内核与语义验证

- 新导出回归使用真实已安装的 **Mihomo v1.19.25**，对七协议示例配置执行 `-t`，退出码为零。GeoIP 使用该应用打包的公开 Country.mmdb；临时目录和进程已清理。此项证明解析，不代表示例节点可连接。
- 独立代码/一手资料审查发现并修复 VMess `insecure=false` 回导被误拒，以及 Xray 域名 DoH 经业务直连再次进入内建 DNS 的风险。Xray 的 DNS 使用专用标记和 AsIs 直连引导出站，避免重入业务解析路径，界面提醒其 DNS 路径。
- Xray 使用 `IPOnDemand`。逐节点 `udp=false` 通过目标规则前的同条件 UDP 拦截保留；诊断表按 TCP 意图解释，缺解析 IP 时保留不确定性。不把小火箭的 `no-resolve` 和 Xray 解析行为称为完全相同。
- 本机未找到 Xray 可执行文件。其 JSON 结构、字段和语义有源码/文档核对及单测，**未进行 Xray 内核加载或 v2rayN 目标客户端验收**。

## 发布与线上验证

- [生产站点](https://routekit.menghuaban520.workers.dev) 已部署 v0.6.0，Worker 版本 `d5b8a881-a22c-4e06-bf9d-406cbfa4070f`。前端资源为 `index-DCrqlPFN.js` / `index-CkCCliDn.css`。
- 正式 HTTPS 页面通过真实 Python HTTP 助手接口，完成两个 YAML 示例节点导入后的自动检测、取消任务，以及两种新格式的实际下载。Python 执行器调用真实节点转换函数，断言收到的 UDP=false/TFO=true 参数；7 次本地 API 响应均成功，页面运行时错误为零。
- 这项线上测试使用受控测量执行器和示例数值，证明浏览器、参数转换与本地接口的连接路径；不作为用户节点出口或速度证据。真实 Mihomo 语法检查另见上节。
- 从旧助手升级需重新下载检测模块 `routekit_probe.py` 并重启；旧模块可能不认识 YAML 导入时保留的 UDP/TFO 参数。

## 沿用的历史证据

上一版源码为 `58f5e6500e2e0ee9aae4605792229c5da2709fea`，[v0.5 验证原文](https://github.com/menghuaban520/routekit/blob/58f5e6500e2e0ee9aae4605792229c5da2709fea/docs/verification.md)。网络页面、Cloudflare IP API、本地助手 HTTP 认证/取消/清理协议和部署响应头没有改动，沿用其实际 Mihomo 外网请求、生产 HTTPS→本地 HTTP、速度流读取和网络分类验收；没有重复使用私人订阅或改动用户当前代理。新增解析参数另行验证，不能用旧验收代替。

## 适用范围与未完成边界

- 尚未在用户目标 Shadowrocket、Mihomo GUI 或 v2rayN 中实际导入并启用本次文件；没有改变用户既有连接。客户端版本、协议、传输、订阅字段或生成规则变化时，需要重验对应格式，当前结果不自动适用于未来版本。
- 新格式只导出能准确表达的参数；未知或不支持字段阻止导出。YAML 仅导入节点，不迁移原规则、策略组、DNS、TUN 或远程 providers。使用 Mihomo 格式不等于兼容停止维护的旧 Clash。
- v2rayN JSON 是 Xray 自定义配置，需按教程设置内核、保持自定义 Socks 端口未设置并手动连接应用代理；不保证自动系统代理或 TUN 接管。详见[客户端说明](clients.md)。
- 节点自动实测需要本地 Python 助手和已安装 Mihomo；网页本身不切换代理。Shadowrocket 全设备实时流量仍需在小火箭查看。
- DNS / WebRTC / IPv6 仍是对照步骤与外部入口，不宣称无泄漏。Xray DNS 的系统引导、客户端 DNS、应用自身解析都需在目标环境核对。
- 套餐用量依赖服务商快照与 CORS；实时计数不是账单。不同目标可命中不同分流，单个 IP 结果不能代表所有应用；位置与距离是近似值。
