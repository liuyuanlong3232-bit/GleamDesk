# VPS 服务读取的上游来源

此处仅保留实际移植部分的 MIT 声明，不捆绑 Go 采集器、Prometheus、Grafana 或代理内核。

- `zbndev/3x-ui-exporter`，参考版本 `ebeac947319eb22dd98564b7d8b86e31d3778d74`：`client/client.go` 中服务器状态 GET 路径、成功封装和 Xray/netIO 字段，移植到 `src-tauri/src/vps_services.rs`。许可证原文见 `3x-ui-exporter-MIT.txt`。
  https://github.com/zbndev/3x-ui-exporter/tree/ebeac947319eb22dd98564b7d8b86e31d3778d74
- `artyfarty/singbox-exporter`，参考版本 `989f4c25eb2866ca91aefc654c69523cdab9d570`：`collector/info.go`、`collector/connections.go` 的版本/累计流量/连接数量字段，移植到同一 Rust 文件。保留其继承的 Zzde MIT 声明，见 `singbox-exporter-MIT.txt`。没有移植常驻 WebSocket、目的地址采集、自动延迟测试或日志逻辑。
  https://github.com/artyfarty/singbox-exporter/tree/989f4c25eb2866ca91aefc654c69523cdab9d570

Tailscale 仅调用用户已有程序的 `tailscale status --json`，按官方协议读取 VPS Self 和当前可见 Peer 状态，不复制 Tailscale 或 tsmetrics 实现，不捆绑其二进制。详情字段核对 `ipn/ipnstate/ipnstate.go`，连接字段含义核对官方 CLI；本地自行编写解析和界面。在线状态、活动状态和路径分别展示，静止设备的 DERP 区域不认作正在中继。不调用 ping、netcheck、up、set、serve 或 web，不打开远程监听端口。
https://tailscale.com/docs/reference/tailscale-cli#status

sing-box 详情额外参考上述 MIT 采集器 `collector/proxies.go` 的节点、分组、当前选择和历史延迟字段定义；未移植其中主动延迟请求。连接详情采用字段白名单，仅返回目标、端口、协议、入站、链路、流量和开始时间，不返回本地进程路径、源地址或完整原始响应。

sing-box 官方接口只用于核对协议：`/version` 标识、`/proxies` 和非 WebSocket `/connections` 快照；未复制 sing-box 内核源码。本次核对官方版本 `a6952ccf6907c18e18917fcb763a433e8e36937b` 的 `experimental/clashapi/proxies.go` 和 `connections.go`。只用已有历史记录，不调用 `/delay`、切换分组、断开连接或订阅日志。
https://sing-box.sagernet.org/configuration/experimental/clash-api/

后续发布含这些移植代码的安装包或便携包时，须一同提供本目录的许可证与来源说明。
