const state = {
  servers: [],
  filter: "all",
  groupFilter: "all",
  query: "",
  selectedId: null,
  pollIntervalMs: 10000,
  assetRefreshing: false,
  assetDetailLoading: false,
  timer: null
};

const els = {
  grid: document.querySelector("#serverGrid"),
  empty: document.querySelector("#emptyState"),
  detail: document.querySelector("#detailPanel"),
  groupFilters: document.querySelector("#groupFilters"),
  groupOptions: document.querySelector("#groupOptions"),
  lastRefresh: document.querySelector("#lastRefresh"),
  search: document.querySelector("#searchInput"),
  toast: document.querySelector("#toast"),
  dialog: document.querySelector("#serverDialog"),
  form: document.querySelector("#serverForm"),
  dialogTitle: document.querySelector("#dialogTitle"),
  deleteBtn: document.querySelector("#deleteServerBtn"),
  fields: {
    id: document.querySelector("#serverId"),
    name: document.querySelector("#serverName"),
    host: document.querySelector("#serverHost"),
    user: document.querySelector("#serverUser"),
    port: document.querySelector("#serverPort"),
    command: document.querySelector("#serverCommand"),
    group: document.querySelector("#serverGroup"),
    tags: document.querySelector("#serverTags")
  }
};

document.querySelector("#addServerBtn").addEventListener("click", () => openDialog());
document.querySelector("#emptyAddBtn").addEventListener("click", () => openDialog());
document.querySelector("#closeDialogBtn").addEventListener("click", () => els.dialog.close());
document.querySelector("#refreshBtn").addEventListener("click", manualRefresh);
document.querySelector("#assetRefreshBtn").addEventListener("click", refreshAssets);
document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});
els.search.addEventListener("input", () => {
  state.query = els.search.value.trim().toLowerCase();
  render();
});
els.form.addEventListener("submit", saveServer);
els.deleteBtn.addEventListener("click", deleteSelectedServer);

loadServers();

async function loadServers() {
  try {
    const payload = await requestJson("/api/servers");
    state.servers = payload.servers || [];
    state.pollIntervalMs = payload.pollIntervalMs || state.pollIntervalMs;
    state.assetRefreshing = Boolean(payload.assetRefreshing);
    els.lastRefresh.textContent = payload.lastRefresh ? `更新 ${formatTime(payload.lastRefresh)}` : "等待刷新";
    if (!state.selectedId && state.servers[0]) state.selectedId = state.servers[0].id;
    if (state.selectedId && !state.servers.some((server) => server.id === state.selectedId)) {
      state.selectedId = state.servers[0]?.id || null;
    }
    render();
    loadSelectedAssets();
    scheduleNextLoad();
  } catch (error) {
    showToast(error.message);
    scheduleNextLoad();
  }
}

async function loadSelectedAssets() {
  if (!state.selectedId || state.assetDetailLoading) return;
  state.assetDetailLoading = true;
  try {
    const payload = await requestJson(`/api/servers/${encodeURIComponent(state.selectedId)}/assets`);
    const server = state.servers.find((item) => item.id === state.selectedId);
    if (server && payload.assets) {
      server.assets = payload.assets;
      renderDetail();
    }
  } catch (error) {
    console.warn(error);
  } finally {
    state.assetDetailLoading = false;
  }
}

function scheduleNextLoad() {
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(loadServers, state.pollIntervalMs);
}

async function manualRefresh() {
  const button = document.querySelector("#refreshBtn");
  button.disabled = true;
  try {
    await requestJson("/api/refresh", { method: "POST" });
    await loadServers();
    showToast("刷新完成");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function refreshAssets() {
  const button = document.querySelector("#assetRefreshBtn");
  button.disabled = true;
  try {
    await requestJson("/api/assets/refresh", { method: "POST" });
    await loadServers();
    showToast("模型资产刷新完成");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function render() {
  renderStats();
  renderGroups();
  renderGrid();
  renderDetail();
}

function renderGroups() {
  const groups = groupSummaries();
  if (!groups.some((group) => group.name === state.groupFilter)) {
    state.groupFilter = "all";
  }

  if (els.groupFilters) {
    els.groupFilters.innerHTML = [
      groupButtonHtml("all", "全部分组", state.servers.length),
      ...groups.map((group) => groupButtonHtml(group.name, group.name, group.count))
    ].join("");
    els.groupFilters.querySelectorAll(".group-filter").forEach((button) => {
      button.addEventListener("click", () => {
        state.groupFilter = button.dataset.group;
        render();
      });
    });
  }

  if (els.groupOptions) {
    const defaults = ["通信中兴组", "政府联想组", "企业浪潮组", "金融华三组", "深度组", "未分组"];
    const names = [...new Set([...defaults, ...groups.map((group) => group.name)])];
    els.groupOptions.innerHTML = names.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
  }
}

function groupSummaries() {
  const byGroup = new Map();
  for (const server of state.servers) {
    const group = serverGroup(server);
    byGroup.set(group, (byGroup.get(group) || 0) + 1);
  }
  return [...byGroup.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function groupButtonHtml(value, label, count) {
  const active = state.groupFilter === value ? " active" : "";
  return `
    <button class="group-filter${active}" data-group="${escapeHtml(value)}" type="button">
      <span>${escapeHtml(label)}</span><strong>${count}</strong>
    </button>`;
}

function renderStats() {
  const totals = state.servers.reduce(
    (acc, server) => {
      const status = server.status || {};
      acc.cards += status.totalCount || server.gpuCount || 0;
      acc.busyCards += status.busyCount || 0;
      acc.freeCards += status.freeCount || 0;
      if (getServerKind(server) === "free") acc.freeServers += 1;
      if (getServerKind(server) === "busy") acc.busyServers += 1;
      if (getServerKind(server) === "offline") acc.offlineServers += 1;
      return acc;
    },
    { cards: 0, busyCards: 0, freeCards: 0, freeServers: 0, busyServers: 0, offlineServers: 0 }
  );

  setText("#statServers", state.servers.length);
  setText("#statCards", totals.cards);
  setText("#statFreeCards", totals.freeCards);
  setText("#statBusyCards", totals.busyCards);
  setText("#countAll", state.servers.length);
  setText("#countFree", totals.freeServers);
  setText("#countBusy", totals.busyServers);
  setText("#countOffline", totals.offlineServers);
  const assetButton = document.querySelector("#assetRefreshBtn");
  if (assetButton) assetButton.disabled = state.assetRefreshing;
}

function renderGrid() {
  const servers = filteredServers();
  els.grid.innerHTML = "";
  els.empty.classList.toggle("hidden", state.servers.length !== 0);
  els.grid.classList.toggle("hidden", state.servers.length === 0);

  for (const server of servers) {
    const status = server.status || {};
    const busyPercent = status.totalCount ? Math.round(((status.busyCount || 0) / status.totalCount) * 100) : 0;
    const card = document.createElement("article");
    card.className = `server-card ${serverOccupancyClass(server)} ${server.id === state.selectedId ? "selected" : ""}`;
    card.tabIndex = 0;
    card.innerHTML = serverCardHtml(server);
    card.addEventListener("click", () => {
      state.selectedId = server.id;
      render();
      loadSelectedAssets();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        state.selectedId = server.id;
        render();
        loadSelectedAssets();
      }
    });
    card.querySelector(".edit-card").addEventListener("click", (event) => {
      event.stopPropagation();
      openDialog(server);
    });
    card.style.setProperty("--busy", `${busyPercent}%`);
    els.grid.appendChild(card);
  }
}

function serverCardHtml(server) {
  const status = server.status || {};
  const assets = server.assets || {};
  const kind = getServerKind(server);
  const serverLevel = serverOccupancyClass(server);
  const totalCount = status.totalCount || server.gpuCount || 0;
  const tags = [...new Set([serverGroup(server), ...(server.tags?.length ? server.tags : [totalCount ? `${totalCount}卡` : "自动识别"])])];
  return `
    <div class="card-head">
      <div>
        <div class="server-name">${escapeHtml(server.name)}</div>
        <div class="server-host">${escapeHtml(server.user ? `${server.user}@${server.host}` : server.host)}:${server.port}</div>
        <div class="server-model">${escapeHtml(modelSummary(server))}</div>
      </div>
      <span class="status-pill status-${kind} ${serverLevel}">${kindLabel(kind)}</span>
    </div>
    <div class="gpu-ring">
      <div class="donut ${serverLevel}"><span>${totalCount ? `${status.busyCount || 0}/${totalCount}` : "识别中"}</span></div>
      <div class="summary">
        <strong>${escapeHtml(status.summary || "等待刷新")}</strong>
        <span>${status.updatedAt ? formatTime(status.updatedAt) : "未采集"}</span>
      </div>
    </div>
    <div class="gpu-grid">
      ${gpuChips(status.gpus || [], totalCount, kind)}
    </div>
    <div class="asset-summary ${assets.state === "failed" ? "failed" : ""}">
      <span>模型 ${assets.modelCount || 0}</span>
      <span>镜像 ${assets.dockerCount || 0}</span>
      <em>${assetUpdatedText(assets)}</em>
    </div>
    <div class="tag-list">
      ${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
      <button class="icon-button edit-card" type="button" aria-label="编辑服务器">✎</button>
    </div>
  `;
}

function gpuChips(gpus, count, serverKind) {
  const list = gpus.length ? gpus : Array.from({ length: count }, (_, index) => ({ index, state: "unknown" }));
  return list
    .slice(0, count)
    .map((gpu) => {
      const cls = serverKind === "offline" ? "offline" : gpu.state || "unknown";
      const chipLevel = gpuOccupancyClass(gpu);
      const compute = formatPercent(gpu.utilization);
      const vram = formatPercent(gpu.memoryUtilization);
      const computeLevel = normalizePercent(gpu.utilization);
      const vramLevel = normalizePercent(gpu.memoryUtilization);
      const computeClass = occupancyClass(gpu.utilization);
      const vramClass = occupancyClass(gpu.memoryUtilization);
      return `
        <span class="gpu-chip ${cls} ${chipLevel}">
          <b>#${escapeHtml(gpu.index)}</b>
          <span class="chip-metrics">
            <span class="chip-block memory ${vramClass}" style="--level:${vramLevel}%">
              <i></i>
              <em>显存</em>
              <strong>${escapeHtml(vram)}</strong>
            </span>
            <span class="chip-block compute ${computeClass}" style="--level:${computeLevel}%">
              <i></i>
              <em>算力</em>
              <strong>${escapeHtml(compute)}</strong>
            </span>
          </span>
        </span>`;
    })
    .join("");
}

function renderDetail() {
  const server = state.servers.find((item) => item.id === state.selectedId);
  if (!server) {
    els.detail.innerHTML = `
      <div class="detail-empty">
        <div class="detail-pulse"></div>
        <h3>选择一台服务器</h3>
        <p>查看每张 GPU/DCU 卡的占用、显存、温度和连接状态。</p>
      </div>`;
    return;
  }

  const status = server.status || {};
  const assets = server.assets || {};
  const kind = getServerKind(server);
  const totalCount = status.totalCount || server.gpuCount || 0;
  els.detail.innerHTML = `
    <div class="detail-head">
      <div>
        <p class="eyebrow">${totalCount ? `${escapeHtml(totalCount)}卡服务器` : "自动识别卡数"} · ${commandLabel(server.command)}</p>
        <h3>${escapeHtml(server.name)}</h3>
      </div>
      <button class="icon-button" id="detailEditBtn" type="button" aria-label="编辑服务器">✎</button>
    </div>
    <div class="detail-meta">
      <div class="meta-box"><span>状态</span><strong>${kindLabel(kind)}</strong></div>
      <div class="meta-box"><span>占用</span><strong>${totalCount ? `${status.busyCount || 0}/${totalCount}` : "识别中"}</strong></div>
      <div class="meta-box"><span>分组</span><strong>${escapeHtml(serverGroup(server))}</strong></div>
      <div class="meta-box"><span>地址</span><strong>${escapeHtml(server.host)}:${server.port}</strong></div>
      <div class="meta-box"><span>型号</span><strong>${escapeHtml(modelSummary(server))}</strong></div>
      <div class="meta-box"><span>延迟</span><strong>${status.latencyMs ? `${status.latencyMs}ms` : "-"}</strong></div>
    </div>
    ${status.error ? `<div class="meta-box"><span>错误</span><strong>${escapeHtml(status.error)}</strong></div>` : ""}
    <div class="gpu-list">
      ${(status.gpus || []).map(gpuRowHtml).join("")}
    </div>
    ${assetPanelHtml(assets)}
  `;
  document.querySelector("#detailEditBtn").addEventListener("click", () => openDialog(server));
}

function assetPanelHtml(assets) {
  const modelItems = assets.modelItems || [];
  const dockerImages = assets.dockerImages || [];
  const modelList = modelItems.length
    ? modelItems.slice(0, 80).map(modelItemHtml).join("")
    : assets.modelCount
      ? `<div class="asset-empty">正在加载模型详情</div>`
    : `<div class="asset-empty">未发现模型目录或文件</div>`;
  const dockerList = dockerImages.length
    ? dockerImages.slice(0, 80).map(dockerImageHtml).join("")
    : assets.dockerCount
      ? `<div class="asset-empty">正在加载镜像详情</div>`
    : `<div class="asset-empty">未发现 Docker 镜像</div>`;

  return `
    <section class="asset-panel">
      <div class="asset-head">
        <div>
          <p class="eyebrow">模型资产</p>
          <h3>模型路径与镜像</h3>
        </div>
        <span>${assetUpdatedText(assets)}</span>
      </div>
      ${assets.error ? `<div class="asset-error">${escapeHtml(assets.error)}</div>` : ""}
      <div class="asset-columns">
        <div class="asset-column">
          <div class="asset-title"><strong>挂载目录模型</strong><span>${modelItems.length}</span></div>
          <div class="asset-list">${modelList}</div>
        </div>
        <div class="asset-column">
          <div class="asset-title"><strong>Docker Images</strong><span>${dockerImages.length}</span></div>
          <div class="asset-list">${dockerList}</div>
        </div>
      </div>
    </section>`;
}

function modelItemHtml(item) {
  return `
    <div class="asset-item">
      <strong>${escapeHtml(item.name || "-")}</strong>
      <span>${escapeHtml(item.path || "-")}</span>
      <em>${escapeHtml(item.root || "-")}${item.type === "file" ? " · 文件" : " · 目录"}</em>
    </div>`;
}

function dockerImageHtml(image) {
  return `
    <div class="asset-item">
      <strong>${escapeHtml(image.repository || "-")}:${escapeHtml(image.tag || "-")}</strong>
      <span>${escapeHtml(image.imageId || "-")} · ${escapeHtml(image.size || "-")}</span>
      <em>${escapeHtml(image.created || "-")}</em>
    </div>`;
}

function gpuRowHtml(gpu) {
  const utilization = normalizePercent(gpu.utilization);
  const memoryUtilization = normalizePercent(gpu.memoryUtilization);
  const utilizationClass = occupancyClass(gpu.utilization);
  const memoryUtilizationClass = occupancyClass(gpu.memoryUtilization);
  const memory = gpu.memoryTotalMiB
    ? `${gpu.memoryUsedMiB || 0}/${gpu.memoryTotalMiB} MiB`
    : gpu.memoryUtilization !== null && gpu.memoryUtilization !== undefined
      ? `${gpu.memoryUtilization}%`
      : "-";
  return `
    <div class="gpu-row">
      <div class="gpu-row-head">
        <strong>卡 #${gpu.index}${gpu.model ? ` · ${escapeHtml(gpu.model)}` : ""}</strong>
        <span>${gpuStateLabel(gpu.state)}</span>
      </div>
      <div class="bar-stack">
        <div class="metric-line">
          <span>显存</span>
          <div class="bar memory"><i class="${memoryUtilizationClass}" style="width:${memoryUtilization}%"></i></div>
          <strong>${formatPercent(gpu.memoryUtilization)}</strong>
        </div>
        <div class="metric-line">
          <span>算力</span>
          <div class="bar compute"><i class="${utilizationClass}" style="width:${utilization}%"></i></div>
          <strong>${formatPercent(gpu.utilization)}</strong>
        </div>
      </div>
      <div class="gpu-metrics">
        <span>显存 ${escapeHtml(memory)}</span>
        <span>温度 ${gpu.temperatureC ?? "-"}℃</span>
        <span>功耗 ${gpu.powerW ?? "-"}W</span>
      </div>
    </div>`;
}

function normalizePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function formatPercent(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

function occupancyClass(value) {
  const percent = normalizePercent(value);
  if (percent >= 80) return "level-critical";
  if (percent >= 40) return "level-warning";
  if (percent >= 10) return "level-low";
  return "level-free";
}

function gpuOccupancyClass(gpu) {
  return occupancyClass(Math.max(normalizePercent(gpu.memoryUtilization), normalizePercent(gpu.utilization)));
}

function serverOccupancyClass(server) {
  const gpus = server.status?.gpus || [];
  if (!gpus.length) return "level-free";
  const max = gpus.reduce((value, gpu) => Math.max(value, normalizePercent(gpu.memoryUtilization), normalizePercent(gpu.utilization)), 0);
  return occupancyClass(max);
}

function filteredServers() {
  return state.servers.filter((server) => {
    const kind = getServerKind(server);
    const matchesFilter = state.filter === "all" || state.filter === kind;
    const matchesGroup = state.groupFilter === "all" || serverGroup(server) === state.groupFilter;
    const text = [
      server.name,
      server.host,
      server.user,
      serverGroup(server),
      modelSummary(server),
      ...(server.tags || []),
      assetSearchText(server)
    ]
      .join(" ")
      .toLowerCase();
    return matchesFilter && matchesGroup && (!state.query || text.includes(state.query));
  });
}

function assetSearchText(server) {
  const assets = server.assets || {};
  if (assets.searchText) return assets.searchText;
  const modelText = (assets.modelItems || []).flatMap((item) => [item.name, item.path, item.root]);
  const dockerText = (assets.dockerImages || []).flatMap((image) => [image.repository, image.tag, image.imageId]);
  return [...modelText, ...dockerText].filter(Boolean).join(" ");
}

function assetUpdatedText(assets) {
  if (!assets || !assets.updatedAt) return "未盘点";
  if (assets.state === "failed") return "盘点失败";
  return `盘点 ${formatTime(assets.updatedAt)}`;
}

function serverGroup(server) {
  return String(server.group || "未分组").trim() || "未分组";
}

function getServerKind(server) {
  const status = server.status || {};
  if (status.state === "offline") return "offline";
  if (status.state === "pending") return "pending";
  return (status.busyCount || 0) > 0 ? "busy" : "free";
}

function kindLabel(kind) {
  return { free: "空闲", busy: "占用", offline: "离线", pending: "刷新中" }[kind] || "未知";
}

function gpuStateLabel(kind) {
  return { free: "空闲", busy: "占用", offline: "离线", unknown: "未知" }[kind] || "未知";
}

function commandLabel(command) {
  return command === "nvidia-smi" ? "NVIDIA GPU" : "海光 DCU";
}

function modelSummary(server) {
  const models = server.status?.models?.length
    ? server.status.models
    : (server.status?.gpus || []).map((gpu) => gpu.model).filter(Boolean);
  const unique = [...new Set(models)];
  if (!unique.length) return "型号识别中";
  return unique.length === 1 ? unique[0] : unique.join(" / ");
}

function openDialog(server) {
  const editing = Boolean(server);
  els.dialogTitle.textContent = editing ? "编辑服务器" : "添加服务器";
  els.deleteBtn.classList.toggle("hidden", !editing);
  els.fields.id.value = server?.id || "";
  els.fields.name.value = server?.name || "";
  els.fields.host.value = server?.host || "";
  els.fields.user.value = server?.user || "root";
  els.fields.port.value = server?.port || 22;
  els.fields.command.value = server?.command || "hy-smi";
  els.fields.group.value = server?.group || "";
  els.fields.tags.value = (server?.tags || []).join(", ");
  els.dialog.showModal();
  els.fields.name.focus();
}

async function saveServer(event) {
  event.preventDefault();
  const id = els.fields.id.value;
  const body = {
    name: els.fields.name.value,
    host: els.fields.host.value,
    user: els.fields.user.value,
    port: Number(els.fields.port.value || 22),
    command: els.fields.command.value || "hy-smi",
    group: els.fields.group.value,
    tags: els.fields.tags.value
  };

  try {
    const payload = await requestJson(id ? `/api/servers/${encodeURIComponent(id)}` : "/api/servers", {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    state.selectedId = payload.server.id;
    els.dialog.close();
    await loadServers();
    showToast("已保存");
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteSelectedServer() {
  const id = els.fields.id.value;
  if (!id) return;
  try {
    await requestJson(`/api/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.selectedId = null;
    els.dialog.close();
    await loadServers();
    showToast("已删除");
  } catch (error) {
    showToast(error.message);
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `请求失败 ${response.status}`);
  }
  return payload;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  window.clearTimeout(els.toastTimer);
  els.toastTimer = window.setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

function setText(selector, value) {
  document.querySelector(selector).textContent = value;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
