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
- Codex 调试时不要只在普通沙箱命令里用 `Start-Process` 后立即结束命令会话；该子进程可能随会话退出，表现为刚返回 200、浏览器随后又 `ERR_CONNECTION_REFUSED`。
- 需要让服务持续运行供用户查看时，优先在允许的宿主 PowerShell 会话中执行以下后台启动流程：
  ```powershell
  $existing = Get-NetTCPConnection -LocalPort 3066 -State Listen -ErrorAction SilentlyContinue
  if ($existing) {
    $existing | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  }
  $proc = Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory 'C:\Users\zhengke\Documents\桌面端服务器占用监控' -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  ```
- 启动后必须同时验证首页和接口，不能只看进程是否存在：
  ```powershell
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3066/
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3066/api/servers
  ```
- 如果端口已被占用，先用 `Get-NetTCPConnection -LocalPort 3066 -State Listen` 获取 `OwningProcess`，只停止该 PID，不要模糊匹配并停止所有 Node 进程。
- 本地改完前端后无需构建；重启 `node server.js`，再刷新浏览器即可。验证时检查页面标题、服务器卡片是否渲染、浏览器控制台是否有 error。
- 后台采集默认间隔：`POLL_INTERVAL_MS=10000`
- 默认 SSH/采集超时：`SSH_TIMEOUT_MS=20000`

## 云端部署

本项目目前有三个云端实例，都是同一套代码、各自独立的真实服务器列表和站点配置：

- 昆山 / 天津实例：
  - 公共部署服务器：`10.8.145.247`
  - 登录用户：`root`
  - 服务访问地址：`http://10.8.145.247:3066`
  - 部署目录：`/opt/gpu-dcu-monitor`
  - systemd 服务名：`gpu-dcu-monitor.service`
  - Node.js：`v12.22.11`
- 太原实例：
  - 公共部署服务器：`10.20.100.12`
  - 登录用户：`root`
  - 服务访问地址：`http://10.20.100.12:3066`
  - 部署目录：`/opt/gpu-dcu-monitor`
  - systemd 服务名：`gpu-dcu-monitor.service`
  - Node.js：`v12.22.11`
  - 原太原服务器 `10.20.100.19` 已下架，不再作为部署目标。
- 郑州实例：
  - 公共部署服务器：`10.211.5.22`
  - 登录用户：`root`
  - 服务访问地址：`http://10.211.5.22:3066`
  - 部署目录：`/opt/gpu-dcu-monitor`
  - systemd 服务名：`gpu-dcu-monitor.service`
  - Node.js：`v24.18.0`（官方 Linux x64 LTS 二进制离线安装到 `/opt/node-v24.18.0-linux-x64`）

三台云端常用命令一致：

- 查看状态：`systemctl status gpu-dcu-monitor`
- 重启服务：`systemctl restart gpu-dcu-monitor`
- 查看日志：`journalctl -u gpu-dcu-monitor -f`

部署注意事项：

- 天津和太原仍使用 Node.js 12 系列，郑州使用 Node.js 24 LTS；代码要继续以 Node 12 作为最低兼容基线，避免使用过新的语法或 API。
- 部署代码时不要覆盖任何云端真实运行配置，尤其是 `/opt/gpu-dcu-monitor/data/servers.json` 和 `/opt/gpu-dcu-monitor/data/sites.json`。
- 更新云端前建议分别备份三台机器的 `data/servers.json`，必要时也备份 `data/sites.json`。
- 推荐用 `git archive --format=tar -o deploy-gpu-dcu-monitor.tar HEAD` 打包当前提交，再上传到目标机器的 `/tmp/`，最后在 `/opt/gpu-dcu-monitor` 解包并重启服务。
- 远端执行带 `$(date ...)` 的命令时，Windows PowerShell 外层要用单引号保护远端命令，避免本地 PowerShell 提前展开。
- 部署完成后至少验证三台机器的 `/`、`/api/servers` 返回 200，并确认 `systemctl is-active gpu-dcu-monitor` 为 `active`。
- 当前 Windows 主机连接天津和太原部署服务器时需要显式指定 `C:\Users\zhengke\.ssh\id_ed25519` 并使用 `-o IdentitiesOnly=yes`；仅依赖 SSH 默认密钥发现可能在天津报 `Permission denied`，也可能因 VPN 路由尚未就绪而误判太原超时。
- 郑州首次部署使用临时密码登录并建立部署机到受监控机器的公钥授权；真实密码不得写入 Git、`servers.json`、日志或部署文档。

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
- 解析 `lscpu`、`/proc/cpuinfo` 等冒号分隔输出时，只能移除第一个字段名前缀，不能直接使用 `awk -F: '{print $2}'`；CPU 型号自身可能包含 `OPN:7493`，按全部冒号切分会截断具体型号。

## 前端和模型资产

- 前端已经升级为本地 React UMD 运行时，不需要构建步骤；主要文件是 `public/index.html`、`public/app.js`、`public/styles.css` 和 `public/vendor/`。
- 首页服务器卡片需要完整显示模型数、镜像数和盘点时间；不要为了压缩卡片直接删除这些信息。
- 首页 CPU 型号必须完整保留具体 OPN/部件号，允许在 CPU 色块内换行，不要用单行省略号截断；CPU 与 GPU/DCU 信息应使用不同背景色，方便快速区分主机和加速卡信息。
- 首页卡片采用固定的信息顺序：机器身份与状态、占用环/运行时间/心跳、CPU/内存/温度指标、CPU 与 GPU/DCU 硬件条、卡槽利用率、模型/镜像资产底栏。后续调整不要打乱这个扫描顺序。
- 8 卡服务器是首页卡片布局的基准场景；修改卡片高度或间距后必须同时检查 1 卡、2 卡和 8 卡机器，确保资产底栏在卡片内、卡槽信息不被裁切、三列桌面布局仍成立。
- 首页服务器卡片最新视觉基准为用户提供的 `C:\Users\zhengke\Desktop\dcu v2\`，其中 `MachineCard.tsx` 定义结构，`MachineCard.css` 定义样式，`v2.html` 用于视觉对照，`figma-design-spec.md` 是尺寸与 token 规范。后续不要再以旧 `index.html` 或历史 `.server-card` 样式作为设计源。
- 当前项目没有 TypeScript/JSX 构建步骤；集成外部 TSX 方案时应将其结构转换为 `public/app.js` 的 React UMD 写法，并把命名空间样式放入 `public/machine-card.css`。不要为了单个组件引入新的构建链或在线字体依赖。
- v2 原始卡片基准宽度为 372px、圆角 18px、GPU/DCU 设备使用 2 列完整信息卡；该结构保留在设计源和详情页语义中。
- 首页资源池当前采用 v2 紧凑总览变体：配色、圆角和动效保持 v2，CPU 与 GPU/DCU 摘要放在 Hero 右侧，设备格为 4 列 × 2 行，完整设备信息仍在机器详情页查看。桌面内容区应优先排满 3 列，避免固定 372px 导致横向留白。
- 笔记本宽度下不要恢复旧的 `max-width: 1180px` 顶部四行堆叠布局；顶部工具栏应保持单行，空间不足时最多将搜索框放到第二行。资源池与三项统计目标高度约 58px。
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
- 首页“温度”指 CPU 温度，来源为 `sensors` 或 `/sys/class/thermal`；部分主板、内核或虚拟化环境不暴露 CPU 温度，缺失不代表 GPU/DCU 温度也缺失。
- CPU 功耗属于 best-effort 数据：`powercap` 通常接近处理器封装功耗，`hwmon` 可能是整机/主板功耗，界面必须按后端返回的 `cpuPowerScope` 区分，不能统一标成 CPU 功耗。
- GPU/DCU 温度与功耗来自 `nvidia-smi` / `hy-smi`。DCU CU 数优先来自 `hy-smi -q` 或 `rocminfo`；K100_AI、BW10 等不同批次可能配置不同，驱动未返回时显示缺失原因，不得按型号盲猜。
