# RouteKit 分流工坊

[在线使用](https://routekit.menghuaban520.workers.dev) · [GitHub 源码](https://github.com/menghuaban520/routekit)

在浏览器里配置应用分流、DNS 和自定义规则，预览并下载 Shadowrocket `.conf`。面向第一次接触分流的新手，也为高级用户保留可编辑的规则。

纯前端 React + TypeScript + Vite，MIT 开源许可，可部署到 Cloudflare Workers 静态资源或 Pages。

![RouteKit 桌面界面](docs/preview.png)

## 能做什么

- 新手模式：选择常用应用，设置直连、代理或拦截；例如为酷狗添加域名分流。
- 自定义应用：添加自己需要的域名，不必等待内置目录更新。
- 高级模式：编辑规则、DNS 和兜底策略，实时查看生成结果。
- 本地保存：点击“保存到本地”后保留方案，从“本地方案”重新打开；也可导出配置和可继续编辑的 JSON 方案备份。
- 下载 Shadowrocket `.conf`，再在客户端中导入并选用已有节点。

应用分流使用域名规则，不能识别设备上某个应用的所有进程流量。应用域名可能变化、遗漏或与其他服务共用，内置目录是可编辑的起点。

## 客户端范围

| 客户端 / 格式        | 当前范围                                         |
| -------------------- | ------------------------------------------------ |
| Shadowrocket `.conf` | 首版导出目标，配置分流与 DNS，使用客户端已有节点 |
| Clash / Mihomo YAML  | 后续适配方向，当前不能导出                       |
| v2rayN / Xray        | 后续适配方向，当前不能导出                       |

Shadowsocks 是代理协议；Shadowrocket、Clash 系客户端和 v2rayN 有不同的配置格式。后续适配应复用同一份规则数据，通过各自的导出器生成配置，不能只改文件扩展名。

“链式代理”页提供新手教程：分别验证前置与出口节点，在小火箭中编辑出口节点，为“代理通过 / Proxy Pass”选择前置节点，再启用分流配置并验证出口。界面名称和支持情况依客户端版本而异；网页不会建立节点链路，导出的 `.conf` 只包含分流与 DNS 设置。

## 从生成到使用

1. 选择国内 IP 与其他流量的默认去向，再为常用应用设置直连、代理或拦截。直连使用当前所在地网络，并不自动获得中国大陆出口。
2. 下载 `.conf`，在 Shadowrocket 的“配置”页导入本地文件，或通过系统文件分享菜单交给客户端。实际入口可能随版本变化。
3. 启用导入的配置，将全局路由设为“配置”，选择自己的可用节点后连接。
4. 在设备上验证应用访问、出口 IP 与 DNS；需要链式代理时按网页教程在客户端另外设置。

“保存到本地”最多保留 20 个方案，同名保存会更新原方案。编辑不会自动保存；“导出方案备份”得到可再次编辑的 JSON，导入仅支持 RouteKit JSON 备份，暂不反向解析任意 `.conf`。

## 隐私和 DNS

配置编辑和文件生成在浏览器内完成，不需要账号、后端、节点密码或订阅上传；项目不包含统计脚本。已保存的方案属于当前浏览器、当前网站地址，清除站点数据或切换部署地址后不会自动迁移，建议另存 JSON 方案备份。

加密 DNS 是配置选项，不是“已测得没有 DNS 泄漏”。实际解析路径受客户端版本、系统、节点、网络和应用影响。导入后仍需在目标设备核对连接与解析结果；本网页不执行泄漏检测，也不代理访问流量。

静态托管服务仍会接收网页资源请求等正常访问元数据。部署者若自行加入统计、第三方资源或后端，需同步更新隐私说明和响应头。

## 格式依据与核验范围

基础配置段和字段曾对照官方 Shadowrocket 2.2.92（3445）应用内置的 `default.conf` 核对，包括 `[General]`、`[Rule]`、`[Host]`、`PROXY` / `DIRECT` 与 `GEOIP` / `FINAL`。这属于语法依据；生成文件仍需在目标版本中真实导入、连接和验收。

- [Shadowrocket 官方 App Store 页面](https://apps.apple.com/us/app/shadowrocket/id932747118)：规则类型、配置导入、加密 DNS 与多级代理能力。
- [官方发布频道：2.2.62 DNS 说明](https://t.me/s/shadowrocketnews?before=890)：`dns-server` 的代理解析扩展语法。首版不会仅因启用加密 DNS 就假定解析已经通过代理。
- [官方发布频道：节点域名 DNS 说明](https://t.me/s/shadowrocketnews?after=930)：节点域名解析有独立设置，解释了为何加密 DNS 开关不能证明所有解析均无泄漏。

## 本地开发

建议使用 Node.js 24 和 npm。

```sh
npm ci
npm run dev
```

按终端显示的本地地址打开网页。

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

`check` 依次运行 TypeScript 检查、Vitest 和生产构建；浏览器测试另行运行。生成的静态站点位于 `dist/`。这些检查不能替代 Shadowrocket 真机导入、网络连通性与 DNS 验收。

## 部署与贡献

[Cloudflare 部署说明](docs/deployment.md) 提供 Workers 和 Pages 两条部署路径。仓库包含托管配置与 GitHub Actions 检查流程。官方演示站使用 Cloudflare Workers 静态资源托管；验收范围见[验证记录](docs/verification.md)。

欢迎按 [贡献指南](CONTRIBUTING.md) 补充应用域名、改进无障碍体验与实现新的客户端适配。代码使用 [MIT License](LICENSE)。
