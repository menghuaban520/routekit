# 本地助手：节点实测与 Mihomo 流量监测

`public/routekit_monitor.py` 固定监听本机 `127.0.0.1:8766`，提供两个独立功能：读取已经运行的 Mihomo / Clash Meta 的实时流量；以及在网页提交任务后，复用同目录 `routekit_probe.py` 启动隔离 Mihomo 检测节点。两者都不改变系统代理、小火箭或用户正在运行的 Mihomo。

**这不是 Shadowrocket 远程控制接口。** 小火箭的实时流量和连接记录仍在小火箭客户端查看。导入的节点可以交给隔离检测内核测量，协议支持与固定检测目标沿用[节点检测器](probe.md)。

## 网页直接检测节点

需要 Python 3.10 或更新版本，以及自己安装的 Mihomo。把 [`routekit_monitor.py`](../public/routekit_monitor.py) 与 [`routekit_probe.py`](../public/routekit_probe.py) 下载到同一目录后运行：

```sh
python3 routekit_monitor.py --core /path/to/mihomo
```

未传 `--core` 时，助手只查找本机 PATH 中的 `mihomo`、常见安装路径，以及 macOS 已安装的 Clash Verge 内置稳定内核；不会下载内核或其他代码。网页不能提交可执行文件路径、命令、输出路径或任意检测 URL。缺少内核、检测脚本缺失或版本过旧时，能力接口会说明不可用，原有流量监测接口仍可使用。

连接网页助手时输入终端生成的会话令牌。网页提交已选择的节点与检测选项，任务每完成一个节点就返回结果。下载测速默认关闭；启用后每节点最多下载 5 MB，其他 HTTPS 延迟和出口请求另计。检测会经过所选代理，可能消耗订阅流量。

助手同时只运行一个任务，最多 100 个节点、2 MiB 正文。正在检测或清理时再次提交返回冲突，不能启动第二个核心。点取消后先显示 `cancelling`，当前请求结束或取消检查生效、隔离核心停止且临时目录清理后才变成 `cancelled`。已完成节点的结果保留，未完成节点不伪造成功或零延迟。

当前/最近一次任务保留在助手内存中，刷新网页后可重新连接并读取；启动新任务会替代旧记录，退出助手后清空。任务输入中的节点 URI 只留在工作线程内存以及权限为 `0600` 的隔离临时核心配置，不回传到任务状态；结果包含节点名称、入口地址与检测到的出口信息，仍应按私人网络资料保管。退出助手（Ctrl+C、SIGTERM 或终端挂断信号）会先取消任务并等待核心清理。

## 读取正在运行的 Mihomo 流量

需要 Python 3.10 或更新版本，脚本只用标准库。先在自己的 Mihomo 中启用 loopback controller，例如 `external-controller: 127.0.0.1:9090`。保持原有客户端运行。

1. 在“订阅与节点 → 实时流量”打开“连接本地助手”，下载助手；仅查看此功能时不需要检测脚本或 `--core`。
2. 在下载目录运行：

   ```sh
   python3 routekit_monitor.py
   ```

3. 把终端打印的**会话令牌**粘贴到网页，点击“验证并连接”，再点“开始实时监测”。浏览器询问本地网络权限时按需允许。
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

助手固定监听 `127.0.0.1:8766`。所有业务接口都要求 `Authorization: Bearer <会话令牌>` 与精确 `Origin`。浏览器跨域预检只允许已定义路径对应的 HTTP 方法与请求头，支持本地网络访问预检；预检自身按浏览器规范不携带令牌，但实际请求必须验证令牌。

监测功能仅向所配置的现有 controller 发送固定 `/traffic` 与 `/connections` GET 请求，不使用系统 HTTP 代理、不跟随重定向，HTTPS 保留证书验证。节点任务只控制自己启动的隔离核心，并只请求检测器已经限定的 HTTPS 目标。助手不输出访问日志、控制凭证或原始异常；响应均为 `no-store`，不上传到 RouteKit。

| 接口 | 用途 |
| --- | --- |
| `GET /v1/capabilities` | 助手能力、任务限制和 `currentJob`；无任务时为 `null`。 |
| `POST /v1/probe/jobs` | JSON 正文为原 `ProbeJob`（`version`、`nodes`、`options`），接受后返回 HTTP 202 与任务状态。 |
| `GET /v1/probe/jobs/<id>` | 读取当前任务进度及不含 URI 的 `report`。 |
| `DELETE /v1/probe/jobs/<id>` | 请求取消，返回 HTTP 202；须继续查询直至实际清理结束。 |
| `GET /v1/snapshot` | 读取已有内核快照；额外携带每次连接生成的 `X-RouteKit-Session`。 |

任务状态为 `running`、`cancelling`、`cancelled`、`completed` 或 `failed`；`phase` 为 `preparing`、`checking`、`cleanup` 或 `finished`。`total` / `completed` 表示总节点数和已完成节点数，`currentNodeId` 可省略。`report` 沿用 `{version:1,source:"routekit-local-probe",generatedAt,results}`，可继续使用原结果导入器。HTTP 409 包含当前 `job`；400、401、403、404、413、503 返回固定 `error` 说明，不回显任务正文。

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
| 显示“已停止”但数值还在 | 保留的是上次成功快照，观察其时间；点“开始实时监测”才会重新采样。 |
