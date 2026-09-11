# 网站连通：从代理用户的实际任务出发

调研与观察日期：2026-09-11。实现版本：v0.7.0。研究范围是常用网站、代理分流和线路比较；竞品历史反馈用于识别需求，未声称当前版本仍存在同样的问题。

## 本次采用的做法

| 用户要判断的事 | 页面提供的证据与动作 |
| --- | --- |
| 只有一个网站打不开，还是整条线路异常？ | 独立“网站连通”分类，12 个固定目标，默认选择 6 个常用网站；按用途快速选择，逐站三次采样。 |
| 节点换完有没有改善？ | 一轮结果“记为对照”，在客户端切换节点，再测相同网站；仅两轮都取得完整三次响应才计算中位耗时差。 |
| 刚才很好、现在又失败，怎么判断？ | 显示本轮每一次响应、超时和失败，不保留最好一次冒充当前结果；异常优先或按完整耗时排序，支持单站重新开始检测。 |
| 网站应该交给哪个节点？ | 用现有配置诊断器匹配探测域名，展开显示配置预期、规则与缺少的信息，提供应用分流入口；配置预期与浏览器实际出口分开。 |
| AI 网页报错就说明 IP 不行吗？ | 提供原站与官方服务状态入口，提示验证页面或浏览器限制可能影响探测；不生成解锁、登录、播放或 IP 信誉结论。 |

网络检查保持五个独立工具：概览、网站连通、速度、主机查询、泄漏检查。本轮不改多客户端导出契约：Clash YAML 只导入节点，导出仍复用既有规则模型；网站卡片使用同一个诊断器，配置无效会显示“配置需修正”。Xray 尚未经过真实内核或目标 v2rayN 验收，不能用本轮网站检测覆盖这一边界。

## 研究依据与具体取舍

- [IPCheck / MyIP 连通组件](https://github.com/jason5ng32/MyIP/blob/main/frontend/components/ConnectivityTest.vue)：实际查看网站卡片、刷新与采样显示，并读其 no-cors 请求与最好耗时逻辑。采用紧凑逐站卡片、用途选择、单站重测；RouteKit 使用本轮三次完整响应的中位数，缺样时不计算完成耗时。
- [MyIP #278](https://github.com/jason5ng32/MyIP/issues/278)（2025-01-17）：用户报告 ChatGPT 实际可用但检测受验证机制影响。本版失败结果旁提供“打开网站”，AI 卡片补验证机制提示，不据探测失败断言服务封禁。
- [Sukka 分流测试](https://ip.skk.moe/split-tunnel)与 [MyIP #295](https://github.com/jason5ng32/MyIP/issues/295)（2025-08-07）：前者逐目标显示出口或未获取，后者报告不同目标观测与实际分流不一致。采用每卡显示实际探测域名；当前没有逐站出口观测，卡片不填本站 IP。
- [BrowserLeaks IP](https://browserleaks.com/ip)按 IP、WebRTC、DNS 分开检查；[MyIP #156](https://github.com/jason5ng32/MyIP/issues/156)（2024-04-09）包含对 VPN 分类误导的用户质疑。保留现有独立泄漏工具和来源说明，不加入缺乏验证的“纯净分”。
- [Fetch 标准的过滤响应](https://fetch.spec.whatwg.org/#concept-filtered-response-opaque)明确 opaque 响应不向脚本暴露真实状态、响应头与正文。本版把它记录为“收到响应”，不能解释为 HTTP 200 或服务完整可用。
- Discord 的 favicon 在本次真实浏览器检查中返回 404，未照搬该端点。改用[官方 Get Gateway 公共接口](https://docs.discord.com/developers/events/gateway#get-gateway)，本机 Chrome 实际取得 CORS 可读 HTTP 200；网页会保留可读的实际 HTTP 状态，429 等异常不算成功响应。不建立 Gateway WebSocket，也不验证消息发送。

官方状态只提供访问入口，没有自动获取状态或把链接当作已验证正常：[OpenAI](https://status.openai.com/)、[Claude](https://status.claude.com/)、[GitHub](https://www.githubstatus.com/)、[Discord](https://discordstatus.com/)、[Netflix](https://help.netflix.com/en/is-netflix-down)。

## 测量契约

- 每站固定三次，最多四站并发，每次八秒截止；仅手动开始。离开分类、隐藏页面或停止会取消请求。停止的站点不计入“完成”。
- 请求从当前浏览器直接发出，使用目录内固定 HTTPS 资源或免登录接口，省略凭证与 Referer，不传订阅、节点参数或本地配置。Cloudflare Worker 没有增加转发接口。
- 指标是从浏览器发起到取得响应的耗时，可能包含连接建立、重定向和浏览器开销；不是 ICMP Ping、带宽、TCP 丢包率或真实应用体验评分。相同网站跨轮比较更有意义。
- 未收到结果不能区分 DNS、TLS、验证、浏览器拦截、目标故障或链路异常。不同浏览器、节点、目标响应策略和时间会改变结果；必须在自己的目标设备实测。
- 选择变化用于下一轮，结果仍标注上一轮线路备注和时间；单独重测会开始只含该站的新轮。结果和对照仅保留在页面会话，导出 JSON 包含探测地址、真实样本、时间与可选备注，不含配置或节点凭证。

实现入口：`src/core/website-checks.ts`、`src/components/WebsiteConnectivityPanel.tsx`、共享导航与既有诊断器。测试和实际部署证据见[验证记录](verification.md)。
