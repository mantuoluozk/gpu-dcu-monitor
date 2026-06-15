# 项目记忆

这个文件记录后续维护本项目时需要优先参考的约定和关键信息。每次开始处理需求时，先读这里，再结合当前代码和用户最新要求行动。

## 工作习惯

- 每次功能更新、修复或部署相关变更，都要同步更新 `CHANGELOG.md`。
- `CHANGELOG.md` 使用中文记录，按日期分组，说明用户能感知到的变化和关键部署/兼容性信息。
- 后续修改流程：先只在本地修改和验证，等用户看完确认后，再进行提交远端、部署云端等下一步操作。
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
- 本机 Codex/Windows 环境里 `localhost` 可能优先走 IPv6 导致超时；如果页面打不开，优先访问 `http://127.0.0.1:3066/`。
- 默认端口：`3066`
- 启动入口：`server.js`
- 启动命令：`node server.js`
- Windows PowerShell 里直接执行 `npm start` 可能被 `npm.ps1` 执行策略拦截；需要按 README 用 `cmd.exe /c npm.cmd start`、`start-windows.bat` 或直接 `node server.js`。
- 后台采集默认间隔：`POLL_INTERVAL_MS=10000`
- 默认 SSH/采集超时：`SSH_TIMEOUT_MS=20000`

## 云端部署

本项目目前有两个云端实例，都是同一套代码、各自独立的真实服务器列表和站点配置：

- 昆山 / 天津实例：
  - 公共部署服务器：`10.8.145.247`
  - 登录用户：`root`
  - 服务访问地址：`http://10.8.145.247:3066`
  - 部署目录：`/opt/gpu-dcu-monitor`
  - systemd 服务名：`gpu-dcu-monitor.service`
  - Node.js：`v12.22.11`
- 太原实例：
  - 公共部署服务器：`10.20.100.19`
  - 登录用户：`root`
  - 服务访问地址：`http://10.20.100.19:3066`
  - 部署目录：`/opt/gpu-dcu-monitor`
  - systemd 服务名：`gpu-dcu-monitor.service`
  - Node.js：`v12.22.11`

两台云端常用命令一致：

- 查看状态：`systemctl status gpu-dcu-monitor`
- 重启服务：`systemctl restart gpu-dcu-monitor`
- 查看日志：`journalctl -u gpu-dcu-monitor -f`

部署注意事项：

- 云端 Node.js 是 Node 12 系列；代码要保持 Node 12 兼容，避免使用过新的语法或 API。
- 部署代码时不要覆盖任何云端真实运行配置，尤其是 `/opt/gpu-dcu-monitor/data/servers.json` 和 `/opt/gpu-dcu-monitor/data/sites.json`。
- 更新云端前建议分别备份两台机器的 `data/servers.json`，必要时也备份 `data/sites.json`。
- 推荐用 `git archive --format=tar -o deploy-gpu-dcu-monitor.tar HEAD` 打包当前提交，再 `scp` 到两台机器的 `/tmp/`，最后在 `/opt/gpu-dcu-monitor` 解包并重启服务。
- 远端执行带 `$(date ...)` 的命令时，Windows PowerShell 外层要用单引号保护远端命令，避免本地 PowerShell 提前展开。
- 部署完成后至少验证两台机器的 `/`、`/api/servers` 返回 200，并确认 `systemctl is-active gpu-dcu-monitor` 为 `active`。

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

## 前端和模型资产

- 前端已经升级为本地 React UMD 运行时，不需要构建步骤；主要文件是 `public/index.html`、`public/app.js`、`public/styles.css` 和 `public/vendor/`。
- 首页服务器卡片需要完整显示模型数、镜像数和盘点时间；不要为了压缩卡片直接删除这些信息。
- 顶部“刷新模型资产”手动入口已隐藏，避免误触发深目录扫描；模型资产仍会按定时任务自动盘点，也保留模型 / 镜像检索页和后端 `/api/assets/refresh` 接口。
- 模型资产默认扫描深度已从 12 层降为 6 层；需要更深扫描时优先通过部署环境变量 `ASSET_SCAN_MAX_DEPTH` 单独调整。
- 模型资产默认扫描路径已移除 `/opt`、`/tpstor`、`/glusterfs-user-data`、`/Ring-2.5-1T` 等偏固定环境目录；需要时通过 `ASSET_PATHS` 单独配置。

## 本地文件清理

- 本地运行产生的 `*.log`、临时部署包 `*.tar`、临时浏览器目录 `.tmp-edge-profile/` 都不要提交；用完可以直接清理。
- `data/servers.json`、`data/sites.json`、`data/backups/` 是本地真实运行数据或备份，保持忽略，不要提交。
- 清理前先用 `git status --short --ignored` 看一眼，确认只处理日志、打包文件、临时目录等运行产物。

## 已知机器和注意事项

- `10.17.26.107`：本地和云端都已验证可采集，属于 `hy-smi` 需要登录 Shell 环境兜底的情况。
- NVIDIA 机器的 `nvidia-smi` 偶尔响应较慢，默认超时时间已调到 20 秒。
- 多人访问公共服务时，共享同一份云端服务器列表；如果后续多人同时编辑冲突变多，需要再加编辑锁、操作审计或账号权限。
