# Cloudflare 托管

推荐使用 Workers 托管前端与 `GET /api/connection`：接口仅返回当前请求的 Cloudflare IP / 地区元数据，不接受查询目标、订阅 URL 或配置，不需要数据库、API Key 或用户配置存储。纯静态 Pages 可使用配置、节点绑定、订阅整理、公共 DoH 查询和外部测速；当前 IP 接口需另外实现。两个可选 Python 工具都在使用者本机运行，不部署到 Cloudflare。

## 准备生产文件

在仓库根目录运行：

```sh
npm ci
npm run check
```

使用 Node.js 24。构建后应有 `dist/index.html`、`dist/assets/`、`dist/_headers`，以及供用户下载的 `dist/routekit_probe.py`、`dist/routekit_monitor.py`。Vite 会把 `public/` 中这些文件复制到输出目录。

## 方式一：Workers 静态资源

仓库中的 `wrangler.jsonc` 将 `assets.directory` 指向 `./dist`，`main` 指向 `src/worker.ts`，`run_worker_first: ["/api/*"]` 将 API 交给 Worker；其他静态资源与页面导航由资源服务处理。[Cloudflare 静态资源配置](https://developers.cloudflare.com/workers/static-assets/binding/)、[SPA 路由](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)

先修改 `wrangler.jsonc` 的 `name` 为自己的项目名称。预览托管行为：

```sh
npx wrangler dev
```

确认准备发布到自己的 Cloudflare 账号后，登录并部署：

```sh
npx wrangler login
npm run deploy
```

`deploy` 会先构建，再打包 Worker 并上传前端静态文件。以命令输出中的地址和 Cloudflare 控制台部署记录为准。[Cloudflare 静态站点部署](https://developers.cloudflare.com/workers/static-assets/get-started/)

也可在 Cloudflare Workers 中连接自己的 GitHub 仓库，使用以下构建设置：

| 设置     | 值                    |
| -------- | --------------------- |
| 根目录   | 本仓库根目录          |
| 构建命令 | `npm run build`       |
| 部署命令 | `npx wrangler deploy` |
| Node.js  | `24`                  |

此时 Cloudflare 承担发布流程，仓库里的 GitHub Actions 只执行检查。连接 Git 后，平台可能随新的提交触发部署，按需要配置分支。[Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

## 方式二：Cloudflare Pages

在 Cloudflare 控制台的 Workers & Pages 中创建 Pages 项目并导入自己的 Git 仓库：

| 设置         | 值                |
| ------------ | ----------------- |
| 根目录       | 本仓库根目录      |
| 构建命令     | `npm run build`   |
| 构建输出目录 | `dist`            |
| 环境变量     | `NODE_VERSION=24` |

Pages 使用这些构建设置；`wrangler.jsonc` 是 Workers 部署配置，不要把其中的 `assets` 字段当成 Pages 配置。Pages 同样会处理构建输出中的 `_headers`。[Pages 构建配置](https://developers.cloudflare.com/pages/configuration/build-configuration/)、[Pages 响应头](https://developers.cloudflare.com/pages/configuration/headers/)

如果只想上传一次构建结果，可在 Pages 的 Direct Upload 中上传 `dist` 文件夹或其 ZIP；后续 Git 集成能力取决于所选创建方式，创建前阅读平台说明。[Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)

## 响应头与发布验收

`public/_headers` 设置了内容安全策略、防嵌入、防 MIME 嗅探及无来源引用头。脚本只从同源加载；`connect-src 'self' https: http://127.0.0.1:8766` 允许同源、HTTPS 订阅/检测服务和固定的本机监测器端口。CSP 本身并未把 HTTPS 限定到几个服务商。应用会按用户操作请求自己的 IP 接口、用户指定的订阅源、Cloudflare Speed、Cloudflare 公共 DoH 或本地监测器；本站不提供订阅转发或任意 URL 代理。内联 SVG 图标不受影响。

跨域能否读取订阅及其用量头仍由目标站点的 CORS 控制。读取 `Subscription-Userinfo` 还需服务商使用 `Access-Control-Expose-Headers` 暴露该头；订阅下载成功不代表浏览器能读到用量，缺失时不能当作零额度。[MDN 响应头暴露说明](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers)

`_headers` 由 Cloudflare 静态资源服务应用，Vite 的 `dev` / `preview` 不会自动模拟它。现有 `/api/connection` JSON 响应在 `src/worker.ts` 中另设 `no-store`、内容类型、防嗅探与无来源引用头；增加 Worker 响应或 SSR 时也需在对应响应中自行设置适用的响应头。[Workers 自定义响应头](https://developers.cloudflare.com/workers/static-assets/headers/)

发布后用真实站点地址检查：

```sh
curl -I https://your-project.your-subdomain.workers.dev/
```

确认响应中有 `Content-Security-Policy`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff` 和 `Referrer-Policy: no-referrer`。再在浏览器用虚构节点完成导入、应用节点绑定、显式保存并重新打开本地方案、配置与配套节点下载，以及 JSON 备份导入；真实凭证不要写进截图或发布记录。检查主机查询、订阅用量与控制台中的 CSP 错误。生成的配置与配套节点仍需在目标客户端实际导入验收。

Workers 部署还应验证 `/api/connection` 返回 JSON、`Cache-Control: no-store` 和真实请求来源信息。IP 只代表访问本站时观测到的地址，不能证明到其他目标的出口一致；使用域名分流时，Cloudflare Speed 测量可能走另一条路径。网页上不同按钮的结果也可能来自不同采集时间。

## 自托管站点的本地助手

[本地助手](monitor.md)固定监听使用者电脑的 `127.0.0.1:8766`；实时监测只读取已有 Mihomo，批量实测则使用独立临时内核。这不是部署在 Cloudflare 上的服务，也不是 Shadowrocket API。网页通过 `GET /v1/capabilities` 读取能力，用 `GET /v1/snapshot` 读取流量，用 `POST /v1/probe/jobs` 创建检测任务，`GET` / `DELETE /v1/probe/jobs/<id>` 读取进度或取消；所有操作都要求会话令牌和精确 Origin。

自托管域名不在默认来源列表中。用户运行脚本时需追加自己的站点来源，不含末尾斜线和路径：

```sh
python3 routekit_monitor.py --origin https://your-site.example
```

需要把 `routekit_probe.py` 放在助手同目录；Mihomo 核心由使用者本机提供，不由网站下载安装。controller 使用 secret 时，再按[助手说明](monitor.md)传入 `--secret-file`。不要把 token 或 controller secret 放进 Cloudflare 环境变量、网站源码或公开地址。跨域预检和 CSP 允许之外，浏览器可能仍要求本地网络访问授权或限制 HTTPS 页面访问 loopback；用实际浏览器验证连接、停止和切页暂停行为。不应通过公网绑定、关闭证书验证或开放任意 Origin 解决限制。

不要给此站点启用注入脚本的 Web Analytics、Zaraz 或其他第三方统计，除非有意改变其隐私范围并更新代码、CSP 和说明。本站不依赖这些功能。

`public/.assetsignore` 会随构建复制到输出目录，按 [Cloudflare 的静态资源排除规则](https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets)阻止上传 Python 缓存和系统目录文件。测试导入 Python 模块时也关闭字节码写入，避免缓存混入构建。

## GitHub 开源发布

在自己的 GitHub 账号创建公开仓库，提交源码、锁文件、文档和 MIT 许可证。不要上传 `node_modules/`、`.env`、导出的私人 `.conf`、`.nodes.txt`、方案 JSON、检测任务或 controller secret 文件。绑定节点后，配置和本地备份也可能含连接凭证；`.gitignore` 不能替代提交前检查。

仓库公开后，可设置构建环境变量 `VITE_REPOSITORY_URL=https://github.com/你的账号/你的仓库` 并重新构建，让页头显示真实的 GitHub 链接。未设置时使用本项目的公开 GitHub 地址；分叉部署建议覆盖为自己的仓库。这是公开链接，不能填写访问令牌或带凭证的 URL。

`.github/workflows/ci.yml` 在推送与 Pull Request 时运行类型检查、单元测试、Python 检测器测试、构建和 Chromium 浏览器测试，使用只读仓库权限且不部署。发布是否成功以远端仓库、Actions 运行和 Cloudflare 部署记录为准。
