# Cloudflare 静态托管

RouteKit 只需要托管 `dist/` 中的静态文件，不需要 Worker 业务代码、数据库、API Key 或用户配置存储。以下是部署操作说明；仓库中的配置文件不代表已有线上部署。

## 准备生产文件

在仓库根目录运行：

```sh
npm ci
npm run check
```

使用 Node.js 24。构建后应有 `dist/index.html`、`dist/assets/` 和 `dist/_headers`；Vite 会把 `public/_headers` 复制到输出目录。

## 方式一：Workers 静态资源

仓库中的 `wrangler.jsonc` 将 `assets.directory` 指向 `./dist`，无需 `main` 入口；未知页面导航由 SPA 回退处理。[Cloudflare 静态资源配置](https://developers.cloudflare.com/workers/static-assets/binding/)、[SPA 路由](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)

先修改 `wrangler.jsonc` 的 `name` 为自己的项目名称。预览托管行为：

```sh
npx wrangler dev
```

确认准备发布到自己的 Cloudflare 账号后，登录并部署：

```sh
npx wrangler login
npm run deploy
```

`deploy` 会先构建，再上传静态文件。以命令输出中的地址和 Cloudflare 控制台部署记录为准。[Cloudflare 静态站点部署](https://developers.cloudflare.com/workers/static-assets/get-started/)

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

`public/_headers` 设置了内容安全策略、防嵌入、防 MIME 嗅探及无来源引用头。脚本只从同源加载，`connect-src 'none'` 禁止页面脚本发起 Fetch / XHR / WebSocket 等连接；配置仍可通过浏览器生成并下载。内联 SVG 图标不受影响。

这些响应头由 Cloudflare 静态资源服务应用。Vite 的 `dev` / `preview` 不会自动模拟 `_headers`；若以后加入 Worker 响应或 SSR，也需在相应响应中自行设置。[Workers 自定义响应头](https://developers.cloudflare.com/workers/static-assets/headers/)

发布后用真实站点地址检查：

```sh
curl -I https://your-project.your-subdomain.workers.dev/
```

确认响应中有 `Content-Security-Policy`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff` 和 `Referrer-Policy: no-referrer`，再在浏览器完成应用选择、显式保存并重新打开本地方案、导出和备份导入。检查控制台没有阻止正常功能的 CSP 错误；下载的配置需另行在目标客户端验收。

不要给此站点启用注入脚本的 Web Analytics、Zaraz 或其他第三方统计，除非有意改变其隐私范围并更新代码、CSP 和说明。本站不依赖这些功能。

## GitHub 开源发布

在自己的 GitHub 账号创建公开仓库，提交源码、锁文件、文档和 MIT 许可证。不要上传 `node_modules/`、`.env`、导出的私人配置或认证信息。项目的 `.gitignore` 已忽略常见本地产物。

仓库公开后，可设置构建环境变量 `VITE_REPOSITORY_URL=https://github.com/你的账号/你的仓库` 并重新构建，让页头显示真实的 GitHub 链接。未设置时显示“开源说明”。这是公开链接，不能填写访问令牌或带凭证的 URL。

`.github/workflows/ci.yml` 在推送与 Pull Request 时运行类型检查、单元测试、构建和 Chromium 浏览器测试，使用只读仓库权限且不部署。发布是否成功以远端仓库、Actions 运行和 Cloudflare 部署记录为准。
