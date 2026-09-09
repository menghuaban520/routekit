# Mihomo 实时流量监测

`public/routekit_monitor.py` 在本机读取你已经运行的 Mihomo / Clash Meta，供 RouteKit 显示总上下行、内核报告的累计流量和实际代理链路。它不启动核心、不切换节点、不修改规则或系统代理，也不发送测速下载。

**这不是 Shadowrocket 接口。** 使用小火箭时，在小火箭客户端中查看实时流量与连接记录。逐个比较订阅节点的延迟、出口与速度，请使用独立的[节点检测器](probe.md)。

## 连接步骤

需要 Python 3.10 或更新版本，脚本只用标准库。先在自己的 Mihomo 中启用 loopback controller，例如 `external-controller: 127.0.0.1:9090`。保持原有客户端运行。

1. 在“订阅与节点 → 实时上下行”下载只读监测器。
2. 在下载目录运行：

   ```sh
   python3 routekit_monitor.py
   ```

3. 把终端打印的**会话令牌**粘贴到网页，点击“连接实时监测”。浏览器询问本地网络权限时按需允许。
4. 页面保留每次成功快照，约每轮完成后 2 秒再查询。点“停止实时监测”、切换工作区或把浏览器页面切到后台，会停止采样；再次使用需手动连接。
5. 不再需要时，在运行脚本的终端按 `Ctrl+C` 退出。

网页令牌只留在当前页面内存，不写入方案或浏览器本地存储。每次重新启动脚本都会生成新令牌；它与 Mihomo 自己的 controller secret 是两种不同凭证。

## 自定义 controller 与站点

controller 已设置 `secret` 时，把现有 secret 保存在自己的 UTF-8 文件中，再传入路径；不要把真实 secret 直接写在命令行参数或公开文档里：

```sh
python3 routekit_monitor.py \
  --controller http://127.0.0.1:9090 \
  --secret-file /path/to/mihomo-secret.txt
```

建议只让自己的账号读取该文件。脚本去除首尾空白，拒绝换行和超过 4096 字符的 secret。也可从已经设置好的 `ROUTEKIT_MIHOMO_SECRET` 环境变量读取；同时提供时，`--secret-file` 优先。

controller 只接受 loopback IP 的 HTTP(S) 地址，不接受域名、URL 用户名密码、路径或查询参数。IPv6 示例：

```sh
python3 routekit_monitor.py \
  --controller 'http://[::1]:9090' \
  --secret-file /path/to/mihomo-secret.txt
```

自托管网页需要额外允许它的精确来源：

```sh
python3 routekit_monitor.py \
  --origin https://your-site.example \
  --secret-file /path/to/mihomo-secret.txt
```

`--origin` 可重复，用于追加来源；填写协议、域名及实际端口，不包含末尾斜线或路径。内置允许演示站，以及 `http://127.0.0.1:5173`、`:5174`、`:4178`。用 `localhost`、其他端口或自己的域名访问时，也需按实际来源追加。

## 数值代表什么

| 显示 | 含义 |
| --- | --- |
| 总上传 / 下载速度 | Mihomo `/traffic` 报告的字节速率，经网页换算显示。 |
| 累计上传 / 下载 | `/connections` 的 `uploadTotal` / `downloadTotal`，以该内核的计数为准，不是订阅套餐账单。 |
| 实际代理链路 | 内核报告的 `chains` 顺序，可能同时包含策略组和多个节点；按整条链聚合，避免把每个节点重复计算。 |
| 活跃连接 | 当前仍在 `/connections` 中的连接数；结束的连接不会继续留在列表。 |
| 链路增量速率 | 只计算相邻两次均存在且计数递增的同一连接。第一次采样、新连接或计数重置时可能未知；不是完整链路带宽。 |
| 活跃连接累计下载 | 当前活跃连接的累计下载之和；连接结束后会移出，所以可能下降。 |

总速率与链路增量速率来自不同采样方法，不能要求每一刻严格相等。监测器也不推断应用身份或为 IP 生成“纯净度”评分。接口字段依据 [Mihomo 官方 API](https://wiki.metacubex.one/api/)。

## 本地访问范围

监测器固定监听 `127.0.0.1:8766`。网页只发出 `GET /v1/snapshot`，携带 `Authorization: Bearer <会话令牌>`；脚本同时检查精确 `Origin`。没有匹配的来源或令牌就拒绝读取，不接受公开转发目标。

脚本仅向所配置 controller 发送固定的 `/traffic` 与 `/connections` GET 请求，不使用系统 HTTP 代理、不跟随重定向，HTTPS 保留证书验证。它不输出访问日志、控制凭证或连接详情。状态快照直接由本机返回浏览器，响应为 `no-store`，不上传到 RouteKit。

站点 CSP 已允许固定的 `http://127.0.0.1:8766`。浏览器仍可能要求本地网络授权或限制此连接；CSP 和 CORS 允许并不保证所有浏览器可用。不要为解决连接问题把监测器或 Mihomo controller 暴露到公网。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 会话令牌不正确 / HTTP 401 | 从当前运行脚本的终端重新复制令牌；重启脚本后旧令牌失效。 |
| 网页来源未授权 / HTTP 403 | 用 `--origin` 添加地址栏对应的精确来源，留意协议、端口与末尾斜线。 |
| Mihomo 未授权 / HTTP 502 | 核对 `--secret-file` 中的 controller secret；不要把网页会话令牌填成 controller secret。 |
| 无法读取本地 Mihomo | 确认核心已运行，`external-controller` 监听地址与 `--controller` 一致；检查浏览器本地网络权限。 |
| 8766 端口已占用 | 退出此前启动的监测器后再运行；脚本当前不提供自定义监听端口。 |
| 连接列表为空 | 用该 Mihomo 客户端实际访问网页后再看；网站本身不会替你产生代理业务流量。 |
| 显示“已停止”但数值还在 | 保留的是上次成功快照，观察其时间；点“连接实时监测”才会重新采样。 |
