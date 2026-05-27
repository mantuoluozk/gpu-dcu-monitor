# GPU/DCU 资源看板

一个通过 SSH 采集服务器 GPU/DCU 占用情况的 Web 看板。适合集中查看多台服务器的加速卡状态，支持海光 DCU 和 NVIDIA GPU。

看板会定时在目标服务器上执行 `hy-smi` 或 `nvidia-smi`，展示每台服务器的卡数、型号、显存占用、算力占用、温度、功耗、在线状态和分组信息。

## 界面预览

主界面：

![主界面](docs/主界面.png)

添加服务器：

![添加服务器界面](docs/添加服务器界面.png)

## 功能

- 添加、编辑、删除服务器。
- 按服务器状态和分组筛选。
- 支持海光 DCU：通过 `hy-smi` 采集占用，通过 `hy-smi --showproductname` 识别型号。
- 支持 NVIDIA GPU：通过 `nvidia-smi` 采集占用和识别型号。
- 自动识别卡数，不需要手动填写 4 卡或 8 卡。
- 同时显示显存占用和算力占用。
- 显存被 vLLM 等服务占用时，即使算力占用为 0，也会判定该卡不可用。
- 主界面用水位色块展示每张卡的显存和算力占用。
- 型号只在新增服务器和手动刷新时重新识别，日常自动刷新只采集占用数据。

## 环境准备

部署机器需要：

- Node.js：建议 18 或更高版本；当前代码兼容 Node.js 12+。
- npm：通常随 Node.js 一起安装。
- OpenSSH 客户端：需要能执行 `ssh`。
- 网络能访问被监控服务器的 SSH 端口，默认 `22`。

被监控服务器需要：

- 海光 DCU 服务器能执行 `hy-smi`。
- NVIDIA GPU 服务器能执行 `nvidia-smi`。
- 部署机器必须能免密 SSH 登录被监控服务器。

添加服务器前，先在部署机器上验证免密访问和采集命令，例如：

```bash
ssh root@10.0.0.12 hy-smi
ssh root@10.0.0.13 nvidia-smi
```

如果这里需要输入密码，网页里添加后也会采集失败。需要先把部署机器的 SSH 公钥加入目标服务器的 `authorized_keys`。

## Windows 部署

1. 安装 Node.js。

   下载并安装 Node.js LTS 版本。安装后在 PowerShell 验证：

   ```powershell
   node -v
   npm -v
   ssh -V
   ```

2. 配置免密 SSH。

   如果本机还没有 SSH key：

   ```powershell
   ssh-keygen -t ed25519
   ```

   将 `C:\Users\你的用户名\.ssh\id_ed25519.pub` 的内容追加到每台被监控服务器的 `~/.ssh/authorized_keys`。

3. 启动服务。

   在项目目录执行：

   ```powershell
   npm start
   ```

   或双击：

   ```text
   start-windows.bat
   ```

4. 打开页面。

   ```text
   http://localhost:3066
   ```

   如果要让同网段其他机器访问，需要放行 Windows 防火墙的 `3066` 端口，然后访问：

   ```text
   http://部署机器IP:3066
   ```

## Linux 部署

1. 安装 Node.js、npm 和 OpenSSH 客户端。

   RHEL/Kylin/CentOS 类系统：

   ```bash
   sudo dnf install -y nodejs npm openssh-clients
   ```

   Ubuntu/Debian 类系统：

   ```bash
   sudo apt update
   sudo apt install -y nodejs npm openssh-client
   ```

2. 配置免密 SSH。

   ```bash
   ssh-keygen -t ed25519
   ```

   将部署机器的公钥追加到每台被监控服务器的 `~/.ssh/authorized_keys`。验证：

   ```bash
   ssh root@10.0.0.12 hy-smi
   ssh root@10.0.0.13 nvidia-smi
   ```

3. 启动服务。

   ```bash
   cd gpu-dcu-monitor
   npm start
   ```

4. 后台常驻运行。

   可以使用 systemd。创建 `/etc/systemd/system/gpu-dcu-monitor.service`：

   ```ini
   [Unit]
   Description=GPU DCU Server Monitor
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   WorkingDirectory=/opt/gpu-dcu-monitor
   Environment=PORT=3066
   Environment=POLL_INTERVAL_MS=10000
   Environment=SSH_TIMEOUT_MS=20000
   ExecStart=/usr/bin/node /opt/gpu-dcu-monitor/server.js
   Restart=always
   RestartSec=3
   User=root

   [Install]
   WantedBy=multi-user.target
   ```

   启动并设置开机自启：

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now gpu-dcu-monitor
   sudo systemctl status gpu-dcu-monitor
   ```

## 添加服务器

在页面点击“添加服务器”，填写：

- 名称：看板上显示的服务器名称。
- Host / IP：服务器 IP 或主机名。
- SSH 用户：默认 `root`。
- 端口：默认 `22`。
- 分组：例如通信组、政府组、金融组、NV 环境等。
- 标签：可选，用于补充公共池、回归、临时等信息。
- 采集命令：海光选择 `hy-smi`，NVIDIA 选择 `nvidia-smi`。

保存后会立即采集一次，并自动识别卡数和型号。

## 配置文件

真实服务器配置保存在：

```text
data/servers.json
```

示例配置：

```text
data/servers.sample.json
```

服务器配置支持 `group` 分组字段。页面会根据已有服务器自动生成分组筛选入口；`tags` 用于补充额外标签。

## 环境变量

Windows PowerShell 示例：

```powershell
$env:PORT=3066
$env:POLL_INTERVAL_MS=10000
$env:SSH_TIMEOUT_MS=20000
npm start
```

Linux 示例：

```bash
PORT=3066 POLL_INTERVAL_MS=10000 SSH_TIMEOUT_MS=20000 npm start
```

常用配置：

- `PORT`：网页端口，默认 `3066`。
- `POLL_INTERVAL_MS`：自动采集间隔，默认 `10000` 毫秒。
- `SSH_TIMEOUT_MS`：单台服务器 SSH/采集命令超时，默认 `20000` 毫秒。部分 NVIDIA 机器执行 `nvidia-smi` 较慢时可以继续调大。
- `SSH_PATH`：自定义 SSH 程序路径。Windows 默认使用 `C:\Windows\System32\OpenSSH\ssh.exe`。

## 运维命令

systemd 部署时常用命令：

```bash
systemctl status gpu-dcu-monitor
systemctl restart gpu-dcu-monitor
journalctl -u gpu-dcu-monitor -f
```

检查端口：

```bash
ss -lntp | grep 3066
```

## 注意事项

- 如果页面能打开但服务器显示离线，优先在部署机器上手动执行 `ssh root@目标IP hy-smi` 或 `ssh root@目标IP nvidia-smi`。
- 如果 NVIDIA 服务器偶发超时，可以调大 `SSH_TIMEOUT_MS`。
- 如果多人共同查看，建议部署在一台固定机器上，由这台机器统一采集。
