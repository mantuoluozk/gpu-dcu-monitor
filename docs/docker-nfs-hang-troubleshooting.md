# Docker 创建容器卡住排查教程：NFS 挂载异常案例

本文记录一次真实排查过程：在 `10.8.145.253` 上执行 `/data1/zk/docker_run.sh` 创建 Docker 容器时一直卡住，最终定位为 NFS 服务端 `10.8.145.246` 的 `/data` 数据盘没有挂载成功，导致 `/models` NFS 挂载失联，Docker 在挂载 `/models` 到容器时被拖住。

适用场景：

- 执行 `docker run`、`docker start`、容器启动脚本时长时间无响应。
- `docker ps`、`docker inspect`、`docker logs` 等命令也开始变慢或卡住。
- 容器脚本里挂载了 `/models`、`/data`、`/mnt` 等可能来自 NFS 的目录。

## 一、问题现象

在 `10.8.145.253` 上执行：

```bash
bash /data1/zk/docker_run.sh
```

脚本目标是创建并进入容器 `zk-mineru`：

```bash
CONTAINER_NAME="zk-mineru"
IMAGE_NAME="image.sourcefind.cn:5000/dcu/admin/base/pytorch:2.5.1-ubuntu22.04-dtk25.04.2-py3.10"
```

脚本里的关键挂载包括：

```bash
-v /models:/models
-v /data1/zk:/data1/zk
-v /opt/hyhal:/opt/hyhal:ro
-v /dev/infiniband:/dev/infiniband
```

现象是 Docker 创建容器卡住，后续检查发现容器曾经停在 `Created` 状态，未进入 `Running`：

```bash
docker ps -a --filter name=zk-mineru --no-trunc
docker inspect zk-mineru --format '{{json .State}}'
```

如果容器是 `Created`，说明容器创建过，但启动没完成。此时脚本后面的：

```bash
docker exec -it zk-mineru /bin/bash
```

会失败，因为容器并没有运行。

## 二、先确认 Docker 基础状态

在 Docker 机器 `10.8.145.253` 上检查：

```bash
docker version
systemctl is-active docker
docker info | sed -n '1,120p'
```

重点关注：

```text
Server Version
Docker Root Dir
Storage Driver
```

本次环境中 Docker 服务是正常运行的：

```text
Docker 版本：26.1.4
Docker 状态：active
Docker Root Dir：/data1/docker
Storage Driver：overlay2
```

再检查磁盘和 inode，排除磁盘满：

```bash
df -hT / /data1 /data1/docker
df -ih / /data1 /data1/docker
```

本次 `/data1` 空间和 inode 都正常，因此不是磁盘容量问题。

## 三、判断是不是底层挂载把 Docker 卡住

如果下面这些命令也变慢、卡住或超时：

```bash
docker ps
docker inspect zk-mineru
docker logs zk-mineru
docker start zk-mineru
```

就不要只看 Docker 参数，要马上看内核日志：

```bash
dmesg -T | tail -n 120
```

本次看到大量 NFS 报错：

```text
nfs: server 10.8.145.246 not responding, timed out
nfs: server 10.8.145.246 not responding, still trying
```

这就是关键线索：Docker 卡住可能不是 Docker 自己的问题，而是访问了一个已经失联的 NFS 挂载。

同时可以看 Docker 服务日志：

```bash
journalctl -u docker --since '2 hours ago' --no-pager | tail -n 160
```

## 四、检查脚本挂载路径

查看脚本内容：

```bash
sed -n '1,220p' /data1/zk/docker_run.sh
```

重点看所有 `-v` 参数。本次脚本有：

```bash
-v /models:/models
```

检查 `/models` 是不是 NFS：

```bash
cat /proc/mounts | grep ' /models '
findmnt /models
```

本次结果类似：

```text
10.8.145.246:/data/models /models nfs4 rw,relatime,vers=4.2,...,hard,...
```

再测试访问 `/models` 会不会卡：

```bash
timeout 10s stat -f -c '%T %s %a' /models
timeout 10s ls -ld /models
```

如果这些命令超时，基本可以确认 Docker 是被 `/models` 这个挂载拖住了。

注意：NFS 如果使用 `hard` 挂载，服务端不响应时，访问这个目录的进程可能进入不可中断等待。普通 `timeout` 不一定能立刻杀掉底层等待，所以表现会很像“Docker 卡死”。

## 五、检查 NFS 服务端网络和端口

从 `10.8.145.253` 测 `10.8.145.246`：

```bash
ping -c 3 -W 2 10.8.145.246
timeout 5s bash -c '</dev/tcp/10.8.145.246/2049' && echo NFS_PORT_OK || echo NFS_PORT_FAIL
timeout 8s showmount -e 10.8.145.246
```

本次现象：

```text
ping 正常
2049/NFS 端口拒绝连接
showmount 超时
```

这说明基础网络通，但 `10.8.145.246` 上 NFS 服务不正常。

## 六、登录 NFS 服务端检查

登录 `10.8.145.246`：

```bash
ssh root@10.8.145.246
```

查看 NFS 状态：

```bash
systemctl is-active nfs-server
systemctl status nfs-server --no-pager -l
journalctl -u nfs-server --since '2 days ago' --no-pager | tail -n 160
```

本次看到：

```text
nfs-server inactive
Dependency failed for NFS server and services
```

查看导出配置：

```bash
cat /etc/exports
```

本次导出配置：

```bash
/data/models *(rw,sync,no_subtree_check,no_root_squash,insecure)
```

继续检查导出目录是否存在：

```bash
df -hT /data /data/models
ls -ld /data /data/models
findmnt /data
```

本次发现：

```text
/data/models 不存在
/data 没有挂载到真正的数据盘
```

## 七、定位数据盘挂载失败

检查 `/etc/fstab`：

```bash
cat /etc/fstab
grep '/dev/vg_data/lv_data' /etc/fstab
```

本次错误配置是：

```text
/dev/vg_data/lv_data  /data  xfs  defaults,_netdev  0  0
```

再检查块设备实际文件系统：

```bash
lsblk -f
blkid /dev/vg_data/lv_data
file -sL /dev/vg_data/lv_data
```

实际结果是：

```text
/dev/vg_data/lv_data: TYPE="ext4"
```

这就定位到根因：`/etc/fstab` 里把 `/data` 的文件系统类型写成了 `xfs`，但真实数据盘是 `ext4`。机器重启后，系统按 XFS 去挂 ext4 盘，挂载失败，导致 `/data/models` 不存在，进而导致 NFS 服务启动失败。

## 八、修复 NFS 服务端

先备份 `/etc/fstab`：

```bash
cp -a /etc/fstab /etc/fstab.bak.$(date +%Y%m%d%H%M%S)
```

把 `/data` 那一行从 `xfs` 改成 `ext4`：

```bash
perl -0pi -e 's#/dev/vg_data/lv_data\s+/data\s+xfs#/dev/vg_data/lv_data  /data  ext4#' /etc/fstab
```

确认修改结果：

```bash
grep '/dev/vg_data/lv_data' /etc/fstab
```

应该变成：

```text
/dev/vg_data/lv_data  /data  ext4  defaults,_netdev  0  0
```

如果 NFS 服务端上 Docker 也使用 `/data/docker`，先检查有没有运行容器：

```bash
docker info --format '{{.DockerRootDir}}'
docker ps
docker ps -a
```

如果没有运行容器，可以停 Docker 后挂载 `/data`：

```bash
systemctl stop docker
mount /data
systemctl start docker
systemctl start nfs-server
```

验证：

```bash
systemctl is-active docker
systemctl is-active nfs-server
findmnt /data
exportfs -v
df -hT /data
ls -ld /data/models
```

本次修复后状态：

```text
docker active
nfs-server active
/data 挂载到 /dev/mapper/vg_data-lv_data
/data/models 已正常 export
```

## 九、回到 Docker 机器验证恢复

在 `10.8.145.253` 上查看内核日志：

```bash
dmesg -T | grep '10.8.145.246' | tail -n 50
```

NFS 恢复时会看到：

```text
nfs: server 10.8.145.246 OK
```

再验证 `/models`：

```bash
stat -f -c '%T %s %a' /models
ls -ld /models
```

正常结果类似：

```text
nfs ...
drwxr-xr-x ... /models
```

确认 Docker API 不再卡：

```bash
docker ps
docker ps -a --filter name=zk-mineru --no-trunc
```

## 十、重新创建容器

如果之前留下异常容器，先查看：

```bash
docker ps -a --filter name=zk-mineru --no-trunc
```

如果确认是异常残留，可以删除：

```bash
docker rm zk-mineru
```

然后重新执行脚本：

```bash
bash /data1/zk/docker_run.sh
```

如果只想验证创建和启动，不想进入交互 shell，可以拆开执行：

```bash
docker create \
  --network=host \
  --name=zk-mineru \
  --privileged \
  --device=/dev/kfd \
  --device=/dev/dri \
  --device=/dev/mkfd \
  --ipc=host \
  --shm-size=256G \
  --group-add video \
  --cap-add=SYS_PTRACE \
  --security-opt seccomp=unconfined \
  -u root \
  --ulimit stack=-1:-1 \
  --ulimit memlock=-1:-1 \
  -v /dev/infiniband:/dev/infiniband \
  -v /opt/hyhal:/opt/hyhal:ro \
  -v /models:/models \
  -v /data1/zk:/data1/zk \
  image.sourcefind.cn:5000/dcu/admin/base/pytorch:2.5.1-ubuntu22.04-dtk25.04.2-py3.10

docker start zk-mineru
docker exec -it zk-mineru /bin/bash
```

## 十一、排查口诀

Docker 创建容器卡住时，按这个顺序排：

```text
1. docker ps / inspect / logs 是否也卡
2. dmesg 看有没有 nfs、io error、hung task
3. 看 docker run 脚本里挂载了哪些宿主机路径
4. 对每个挂载路径做 stat / ls 测试
5. 如果是 NFS，检查服务端 2049、nfs-server、/etc/exports
6. 检查服务端导出目录所在磁盘有没有挂载成功
7. 修复挂载和 NFS 后，再回 Docker 机器重试
```

本次最关键的命令：

```bash
dmesg -T | tail -n 120
cat /proc/mounts | grep ' /models '
timeout 10s stat -f -c '%T %s %a' /models
timeout 5s bash -c '</dev/tcp/10.8.145.246/2049' && echo OK || echo FAIL
systemctl status nfs-server --no-pager -l
grep '/dev/vg_data/lv_data' /etc/fstab
blkid /dev/vg_data/lv_data
findmnt /data
```

## 十二、本次根因总结

本次问题不是 Docker 镜像问题，也不是容器参数本身的问题。根因链路是：

```text
10.8.145.246 的 /etc/fstab 写错文件系统类型
        ↓
/dev/vg_data/lv_data 实际是 ext4，但 fstab 写成 xfs
        ↓
重启后 /data 没有挂载成功
        ↓
/data/models 不存在
        ↓
nfs-server 启动失败
        ↓
10.8.145.253 上的 /models NFS 挂载失联
        ↓
Docker 创建容器时挂载 /models，被 NFS hard mount 拖住
        ↓
表现为 docker run / docker start / docker inspect 卡住
```

修复方式：

```text
修正 10.8.145.246 的 /etc/fstab
挂载 /data
启动 nfs-server
确认 10.8.145.253 上 /models 恢复
重新运行 Docker 创建脚本
```
