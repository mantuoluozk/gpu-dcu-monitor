# 项目记忆

这个文件记录后续维护本项目时需要优先参考的约定和关键信息。每次开始处理需求时，先读这里，再结合当前代码和用户最新要求行动。

## 工作习惯

- 每次功能更新、修复或部署相关变更，都要同步更新 `CHANGELOG.md`。
- `CHANGELOG.md` 使用中文记录，按日期分组，说明用户能感知到的变化和关键部署/兼容性信息。
- 用户要求“用 git 保存每步修改”，因此代码或文档变更完成后应及时提交；需要同步远端时推送到 GitHub 和 GitLab。
- 不要提交本地真实服务器配置、日志、打包文件等运行数据。
- 修改前先确认工作区状态，避免覆盖用户在本地新增的服务器或代码改动。

## 仓库和远端

- 本地工作区：`C:\Users\zhengke\Documents\桌面端服务器占用监控`
- GitHub：`https://github.com/mantuoluozk/gpu-dcu-monitor.git`
- GitLab：`https://developer.sourcefind.cn/codes/zhengke/gpu-dcu-monitor`
- 主分支：`main`

## 本地服务

- 默认访问地址：`http://localhost:3066`
- 默认端口：`3066`
- 启动入口：`server.js`
- 启动命令：`node server.js`
- 后台采集默认间隔：`POLL_INTERVAL_MS=10000`
- 默认 SSH/采集超时：`SSH_TIMEOUT_MS=20000`

## 云端部署

- 公共部署服务器：`10.8.145.247`
- 登录用户：`root`
- 服务访问地址：`http://10.8.145.247:3066`
- 部署目录：`/opt/gpu-dcu-monitor`
- systemd 服务名：`gpu-dcu-monitor.service`
- 常用命令：
  - 查看状态：`systemctl status gpu-dcu-monitor`
  - 重启服务：`systemctl restart gpu-dcu-monitor`
  - 查看日志：`journalctl -u gpu-dcu-monitor -f`
- 云端 Node.js 版本较旧，已知是 Node 12 系列；代码要保持 Node 12 兼容，避免使用过新的语法或 API。
- 部署代码时不要覆盖云端 `/opt/gpu-dcu-monitor/data/servers.json`，该文件保存公共服务上的真实服务器列表。
- 更新云端前建议先备份云端 `data/servers.json`。

## 服务器配置和采集

- 服务器列表文件：`data/servers.json`，本地真实配置被 `.gitignore` 忽略。
- 示例配置文件：`data/servers.sample.json`。
- 添加服务器前，需要让当前运行服务的机器可以免密 SSH 到被监控机器。
- SSH 用户默认是 `root`。
- 支持采集命令：
  - 海光 DCU：`hy-smi`
  - NVIDIA GPU：`nvidia-smi`
- DCU/GPU 数量由后端采集结果自动识别，不需要用户手动选择。
- 型号信息在添加、编辑或手动刷新时采集；普通定时刷新只采集占用状态，避免额外开销。
- `hy-smi` 已加入登录 Shell 兜底：当非交互 SSH 找不到 `hy-smi` 时，会尝试通过 `bash -ilc` 加载环境后再采集。

## 已知机器和注意事项

- `10.17.26.107`：本地和云端都已验证可采集，属于 `hy-smi` 需要登录 Shell 环境兜底的情况。
- NVIDIA 机器的 `nvidia-smi` 偶尔响应较慢，默认超时时间已调到 20 秒。
- 多人访问公共服务时，共享同一份云端服务器列表；如果后续多人同时编辑冲突变多，需要再加编辑锁、操作审计或账号权限。
