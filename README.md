# GPU/DCU 资源看板

一个面向测试团队共享使用的 GPU/DCU 服务器占用看板。它通过 SSH 定时在服务器上执行 `hy-smi` 或 `nvidia-smi`，集中展示每台机器的卡数、型号、显存占用、算力占用、温度、功耗、空闲/占用/离线状态。

## 推荐使用方式

最推荐的方式是：**在一台能免密 SSH 登录所有服务器的电脑或跳板机上部署一次，然后把网页地址共享给大家。**

这样每个同事不用单独安装，也不用每个人都配置服务器 SSH 密钥。大家只需要访问：

```text
http://部署机器IP:3066
```

## 快速启动

Windows 用户可以双击：

```text
start-windows.bat
```

或者手动启动：

```powershell
npm start
```

默认地址：

```text
http://localhost:3066
```

如果要给同网段同事访问，在部署机器的防火墙放行 `3066` 端口后，让大家访问：

```text
http://你的电脑IP:3066
```

## 使用前提

- 部署机器需要安装 Node.js 18 或更高版本。
- 部署机器需要能通过 SSH 免密登录目标服务器。
- 海光服务器上需要能执行 `hy-smi`。
- NVIDIA 服务器上需要能执行 `nvidia-smi`。

建议先在部署机器上验证：

```powershell
ssh root@10.0.0.12 hy-smi
ssh root@10.0.0.13 nvidia-smi
```

## 功能

- 网页端添加、编辑、删除服务器。
- 自动识别卡数。
- 自动识别显卡型号：
  - 海光：通过 `hy-smi --showproductname` 识别，例如 `BW100`、`BW150`，未来新型号也会按输出自动提取。
  - NVIDIA：通过 `nvidia-smi --query-gpu=name` 识别。
- 同时展示显存占用和算力占用。
- 显存泄漏或 vLLM 服务未释放显存时，即使算力为 0，也会判定该卡不可用。
- 主界面水位色块按占用率从下往上填充。
- 占用颜色分级：绿色、黄绿色、橘色、红色。
- 默认每 10 秒自动采集一次，也可以点“手动刷新”立即刷新。

## 配置说明

网页里点击“添加服务器”即可写入配置。真实配置保存在：

```text
data/servers.json
```

该文件已被 `.gitignore` 忽略，避免把真实服务器地址提交到仓库。示例配置见：

```text
data/servers.sample.json
```

服务器支持 `group` 分组字段，适合公共部署时按项目或客户线管理，例如“通信中兴组”“政府联想组”“企业浪潮组”“金融华三组”“深度组”。页面会自动生成分组筛选入口；`tags` 仍然可以用于补充“8卡”“回归”“临时”等标签。

## 环境变量

```powershell
$env:PORT=3066
$env:POLL_INTERVAL_MS=10000
$env:SSH_TIMEOUT_MS=8000
npm start
```

常用配置：

- `PORT`：网页端口，默认 `3066`。
- `POLL_INTERVAL_MS`：自动采集间隔，默认 `10000` 毫秒。
- `SSH_TIMEOUT_MS`：单台服务器 SSH 超时，默认 `8000` 毫秒。
- `SSH_PATH`：自定义 SSH 程序路径。Windows 默认使用 `C:\Windows\System32\OpenSSH\ssh.exe`。

## 上传到 GitHub

首次上传：

```powershell
git init
git add .
git commit -m "Initial GPU DCU monitor"
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

后续更新：

```powershell
git add .
git commit -m "Update dashboard"
git push
```

## 给同事一键使用

最简单的方式：

1. 在 GitHub 页面点击 `Code` -> `Download ZIP`。
2. 解压 ZIP。
3. 双击 `start-windows.bat`。
4. 打开或分享 `http://localhost:3066` / `http://部署机器IP:3066`。

更推荐的团队方式：

1. 由你在一台固定机器上运行 `start-windows.bat`。
2. 你在网页里添加所有服务器。
3. 同事只访问 `http://部署机器IP:3066`。

如果你想做到真正的“无需安装 Node.js，双击一个 exe 就能运行”，后续可以再做 Windows 打包版。常见路线是 Electron、pkg/nexe 或 Inno Setup，但会比当前轻量 Web 版复杂一些。

## 注意事项

- 不要把 `data/servers.json` 提交到 GitHub，里面可能包含内部服务器 IP。
- 不要把 SSH 私钥提交到 GitHub。
- 如果同事访问不了网页，优先检查部署机器防火墙是否放行了 `3066` 端口。
