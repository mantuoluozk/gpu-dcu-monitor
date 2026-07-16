const { useCallback, useEffect, useMemo, useRef, useState, memo } = React;
const h = React.createElement;

const DEFAULT_SITE = { name: "GPU/DCU 资源调度台", description: "共享测试资源", url: "/" };
const DEFAULT_GROUPS = ["通信中兴组", "政府联想组", "企业浪潮组", "金融华三组", "深度组", "未分组"];
const FILTERS = [
  ["all", "全部"],
  ["free", "空闲"],
  ["busy", "占用"],
  ["offline", "离线"]
];
const VIEWS = [
  ["dashboard", "资源池"],
  ["assets", "模型检索"],
  ["changelog", "更新日志"]
];

function App() {
  const [servers, setServers] = useState([]);
  const [view, setView] = useState("dashboard");
  const [filter, setFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [siteConfig, setSiteConfig] = useState({ current: DEFAULT_SITE, sites: [] });
  const [lastRefresh, setLastRefresh] = useState(null);
  const [pollIntervalMs, setPollIntervalMs] = useState(10000);
  const [assetType, setAssetType] = useState("all");
  const [assetState, setAssetState] = useState("all");
  const [assetResults, setAssetResults] = useState([]);
  const [assetTotalMatches, setAssetTotalMatches] = useState(0);
  const [assetSearching, setAssetSearching] = useState(false);
  const [assetDetailLoading, setAssetDetailLoading] = useState(false);
  const [detailRefreshing, setDetailRefreshing] = useState(false);
  const [changelogEntries, setChangelogEntries] = useState([]);
  const [changelogUpdatedAt, setChangelogUpdatedAt] = useState(null);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const [dialogServer, setDialogServer] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState("");

  const pollRef = useRef(pollIntervalMs);
  const selectedIdRef = useRef(selectedId);
  const assetSearchSeq = useRef(0);
  const toastTimer = useRef(null);

  useEffect(() => {
    pollRef.current = pollIntervalMs;
  }, [pollIntervalMs]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const notify = useCallback((message) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  const fetchServers = useCallback(async () => {
    const payload = await requestJson("/api/servers");
    const nextServers = payload.servers || [];
    setPollIntervalMs(payload.pollIntervalMs || 10000);
    setLastRefresh(payload.lastRefresh || null);
    setServers((previous) => mergeServerAssetDetails(nextServers, previous));
    setSelectedId((current) => {
      if (current && nextServers.some((server) => server.id === current)) return current;
      return nextServers[0]?.id || null;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function loop() {
      try {
        await fetchServers();
      } catch (error) {
        notify(error.message);
      } finally {
        if (!cancelled) timer = window.setTimeout(loop, pollRef.current);
      }
    }

    loop();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fetchServers, notify]);

  useEffect(() => {
    let cancelled = false;
    requestJson("/api/site-config")
      .then((payload) => {
        if (cancelled) return;
        setSiteConfig({
          current: payload.current || DEFAULT_SITE,
          sites: payload.sites || []
        });
      })
      .catch((error) => console.warn(error));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedId || assetDetailLoading) return;
    let cancelled = false;
    setAssetDetailLoading(true);
    requestJson(`/api/servers/${encodeURIComponent(selectedId)}/assets`)
      .then((payload) => {
        if (cancelled || !payload.assets) return;
        setServers((items) => items.map((server) => (
          server.id === selectedId ? { ...server, assets: payload.assets } : server
        )));
      })
      .catch((error) => console.warn(error))
      .finally(() => {
        if (!cancelled) setAssetDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (view !== "assets") return;
    const value = query.trim();
    const seq = assetSearchSeq.current + 1;
    assetSearchSeq.current = seq;

    if (!value) {
      setAssetResults([]);
      setAssetTotalMatches(0);
      setAssetSearching(false);
      return;
    }

    setAssetSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: value, type: assetType, state: assetState, group: groupFilter });
        const payload = await requestJson(`/api/assets/search?${params.toString()}`);
        if (assetSearchSeq.current !== seq) return;
        setAssetResults(payload.results || []);
        setAssetTotalMatches(payload.totalMatches || 0);
      } catch (error) {
        notify(error.message);
      } finally {
        if (assetSearchSeq.current === seq) setAssetSearching(false);
      }
    }, 220);

    return () => window.clearTimeout(timer);
  }, [view, query, assetType, assetState, groupFilter, notify]);

  useEffect(() => {
    if (view !== "changelog" || changelogEntries.length || changelogLoading) return;
    setChangelogLoading(true);
    requestJson("/api/changelog")
      .then((payload) => {
        setChangelogEntries(payload.entries || []);
        setChangelogUpdatedAt(payload.updatedAt || null);
      })
      .catch((error) => notify(error.message))
      .finally(() => setChangelogLoading(false));
  }, [view, changelogEntries.length, changelogLoading, notify]);

  const totals = useMemo(() => summarizeServers(servers), [servers]);
  const groups = useMemo(() => groupSummaries(servers), [servers]);
  const groupNames = useMemo(() => [...new Set([...DEFAULT_GROUPS, ...groups.map((group) => group.name)])], [groups]);
  const selectedServer = useMemo(() => servers.find((server) => server.id === selectedId) || null, [servers, selectedId]);
  const deferredQuery = query.trim().toLowerCase();
  const filteredServers = useMemo(
    () => servers.filter((server) => {
      const kind = getServerKind(server);
      if (filter !== "all" && filter !== kind) return false;
      if (groupFilter !== "all" && serverGroup(server) !== groupFilter) return false;
      return matchesDashboardQuery(server, deferredQuery);
    }),
    [servers, filter, groupFilter, deferredQuery]
  );

  const pageTitle = view === "assets" ? "模型镜像检索" : view === "changelog" ? "更新日志" : "服务器占用情况";
  const searchLabel = view === "assets" ? "模型搜索" : "资源搜索";
  const searchPlaceholder = view === "assets" ? "搜索模型名、路径或镜像 tag" : "搜索服务器、IP、分组、型号";

  const openDialog = useCallback((server) => {
    setDialogServer(server || null);
    setDialogOpen(true);
  }, []);

  const changeView = useCallback((nextView) => {
    if (view === "assets" && nextView === "dashboard") {
      setQuery("");
    }
    setView(nextView);
  }, [view]);

  const manualRefresh = useCallback(async () => {
    try {
      await requestJson("/api/refresh", { method: "POST" });
      await fetchServers();
      notify("刷新完成");
    } catch (error) {
      notify(error.message);
    }
  }, [fetchServers, notify]);

  const refreshSelectedServer = useCallback(async (id) => {
    if (!id || detailRefreshing) return;
    setDetailRefreshing(true);
    try {
      const payload = await requestJson(`/api/servers/${encodeURIComponent(id)}/refresh`, { method: "POST" });
      if (payload.server) {
        setServers((items) => {
          const nextServers = items.map((server) => (
            server.id === id ? { ...server, ...payload.server } : server
          ));
          return mergeServerAssetDetails(nextServers, items);
        });
      } else {
        await fetchServers();
      }
      notify(payload.ok === false ? "刷新失败" : "当前服务器已刷新");
    } catch (error) {
      notify(error.message);
    } finally {
      setDetailRefreshing(false);
    }
  }, [detailRefreshing, fetchServers, notify]);

  const saveServer = useCallback(async (body, id) => {
    try {
      const payload = await requestJson(id ? `/api/servers/${encodeURIComponent(id)}` : "/api/servers", {
        method: id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      setSelectedId(payload.server.id);
      setDialogOpen(false);
      await fetchServers();
      notify("已保存");
    } catch (error) {
      notify(error.message);
    }
  }, [fetchServers, notify]);

  const deleteServer = useCallback(async (id) => {
    if (!id) return;
    try {
      await requestJson(`/api/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
      setSelectedId(null);
      setDialogOpen(false);
      await fetchServers();
      notify("已删除");
    } catch (error) {
      notify(error.message);
    }
  }, [fetchServers, notify]);

  const copy = useCallback(async (text, label) => {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else fallbackCopyText(text);
      notify(`${label}已复制`);
    } catch (error) {
      try {
        fallbackCopyText(text);
        notify(`${label}已复制`);
      } catch {
        notify("复制失败");
      }
    }
  }, [notify]);

  return h("div", { className: "app-shell", "data-view": view },
    h(Sidebar, { siteConfig, totals, filter, setFilter, lastRefresh }),
    h("main", { className: "command-center" },
      h(TopRail, {
        title: pageTitle,
        description: siteConfig.current.description || DEFAULT_SITE.description,
        view,
        setView: changeView,
        query,
        setQuery,
        searchLabel,
        searchPlaceholder,
        onRefresh: manualRefresh,
        onAdd: () => openDialog(null)
      }),
      view === "dashboard"
        ? h(DashboardView, {
          totals,
          groups,
          groupFilter,
          setGroupFilter,
          servers: filteredServers,
          selectedId,
          onOpenServer: (server) => {
            setSelectedId(server.id);
            setDetailOpen(true);
          },
          openDialog
        })
        : view === "assets"
          ? h(AssetView, { query, assetType, setAssetType, assetState, setAssetState, assetResults, assetTotalMatches, assetSearching, copy })
          : h(ChangelogView, { entries: changelogEntries, loading: changelogLoading, updatedAt: changelogUpdatedAt })
    ),
    detailOpen && selectedServer ? h(DetailOverlay, {
      server: selectedServer,
      openDialog,
      copy,
      refreshing: detailRefreshing,
      onRefresh: () => refreshSelectedServer(selectedServer.id),
      onClose: () => setDetailOpen(false)
    }) : null,
    dialogOpen ? h(ServerDialog, { server: dialogServer, groups: groupNames, onClose: () => setDialogOpen(false), onSave: saveServer, onDelete: deleteServer }) : null,
    toast ? h("div", { className: "toast" }, toast) : null
  );
}

function Sidebar({ siteConfig, totals, filter, setFilter, lastRefresh }) {
  const current = siteConfig.current || DEFAULT_SITE;
  return h("aside", { className: "sidebar" },
    h("div", { className: "brand" },
      h("div", { className: "brand-mark" }, "DCU"),
      h("div", null,
        h("h1", null, current.name || DEFAULT_SITE.name),
        h("p", null, lastRefresh ? `更新 ${formatTime(lastRefresh)}` : "等待刷新")
      )
    ),
    siteConfig.sites?.length ? h("nav", { className: "site-switcher", "aria-label": "站点切换" },
      h("div", { className: "section-label" }, "Sites"),
      h("div", { className: "site-link-list" }, siteConfig.sites.map((site) => h("a", {
        key: site.url || site.name,
        className: `site-link${site.current ? " active" : ""}`,
        href: site.url
      }, h("strong", null, site.name), site.description ? h("span", null, site.description) : null)))
    ) : null,
    h("div", { className: "section-label" }, "Status"),
    h("div", { className: "filters", role: "tablist", "aria-label": "服务器状态筛选" },
      FILTERS.map(([value, label]) => h("button", {
        key: value,
        className: `filter${filter === value ? " active" : ""}`,
        type: "button",
        onClick: () => setFilter(value)
      }, h("span", null, label), h("strong", null, value === "all" ? totals.servers : totals[`${value}Servers`] || 0)))
    ),
    h("div", { className: "sidebar-note" },
      h("span", null, "Dispatch"),
      h("strong", null, `当前 ${totals.freeCards}/${totals.cards || 0} 张卡空闲，点击机器查看完整详情。`)
    )
  );
}

function TopRail(props) {
  return h("section", { className: "top-rail" },
    h("div", { className: "page-title" },
      h("p", { className: "eyebrow" }, props.description),
      h("h2", null, props.title)
    ),
    h("div", { className: "view-tabs", role: "tablist", "aria-label": "视图切换" },
      VIEWS.map(([value, label]) => h("button", {
        key: value,
        className: `view-tab${props.view === value ? " active" : ""}`,
        type: "button",
        onClick: () => props.setView(value)
      }, label))
    ),
    props.view !== "changelog" ? h("label", { className: "search-box" },
      h("span", null, props.searchLabel),
      h("input", {
        value: props.query,
        type: "search",
        placeholder: props.searchPlaceholder,
        onChange: (event) => props.setQuery(event.target.value)
      })
    ) : null,
    h("div", { className: "top-actions" },
      h("button", { className: "ghost-action", type: "button", onClick: props.onRefresh }, "刷新状态"),
      h("button", { className: "primary-action", type: "button", onClick: props.onAdd }, "添加服务器")
    )
  );
}

function DashboardView({ totals, groups, groupFilter, setGroupFilter, servers, selectedId, onOpenServer, openDialog }) {
  return h("section", { className: "dashboard-view" },
    h("div", { className: "hero-board" },
      h("div", { className: "hero-main" },
        h("span", null, "RESOURCE POOL"),
        h("strong", null, `${totals.freeCards}/${totals.cards || 0}`),
        h("em", null, "空闲卡 / 总卡数")
      ),
      h("div", { className: "stat-strip" },
        h(StatTile, { label: "服务器", value: totals.servers }),
        h(StatTile, { label: "占用卡", value: totals.busyCards, tone: "warn" }),
        h(StatTile, { label: "离线", value: totals.offlineServers, tone: "danger" })
      )
    ),
    h("div", { className: "group-panel" },
      h("button", { className: `group-filter${groupFilter === "all" ? " active" : ""}`, type: "button", onClick: () => setGroupFilter("all") }, "全部分组"),
      groups.map((group) => h("button", {
        key: group.name,
        className: `group-filter${groupFilter === group.name ? " active" : ""}`,
        type: "button",
        onClick: () => setGroupFilter(group.name)
      }, `${group.name} ${group.count}`))
    ),
    servers.length
      ? h("div", { className: "server-grid" }, servers.map((server) => h(ServerCard, {
        key: server.id,
        server,
        selected: server.id === selectedId,
        onSelect: () => onOpenServer(server),
        onEdit: () => openDialog(server)
      })))
      : h(EmptyState, { onAdd: () => openDialog(null) })
  );
}

function StatTile({ label, value, tone }) {
  return h("div", { className: `stat-tile ${tone || ""}` }, h("span", null, label), h("strong", null, value));
}

const ServerCard = memo(function ServerCard({ server, selected, onSelect, onEdit }) {
  const status = server.status || {};
  const system = status.system || {};
  const assets = server.assets || {};
  const acceleratorKind = server.command === "nvidia-smi" ? "gpu" : "dcu";
  const totalCount = status.totalCount || server.gpuCount || 0;
  const busyCount = status.busyCount || 0;
  const freeCount = Math.max(totalCount - busyCount, 0);
  const busyPercent = totalCount ? Math.round((busyCount / totalCount) * 100) : 0;
  const devices = status.gpus || [];
  const machineState = cardMachineState(status, devices);
  const deviceLabel = acceleratorKind.toUpperCase();
  const statusColor = machineState === "busy" ? "#F59E0B" : machineState === "alert" ? "#EF4444" : machineState === "offline" ? "#94A3B8" : "#10B981";
  const statusBg = machineState === "busy" ? "#FED7AA" : machineState === "alert" ? "#FECACA" : machineState === "offline" ? "#CBD5E1" : "#A7F3D0";

  return h("article", {
    className: `machine-card ${machineState}${selected ? " selected" : ""}`,
    tabIndex: 0,
    onClick: onSelect,
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect();
      }
    }
  },
    h("div", { className: "card-header" },
      h("div", { className: `machine-icon ${acceleratorKind}` }, deviceLabel),
      h("div", { className: "title-block" },
        h("h2", null, server.name),
        h("div", { className: "ip" },
          h("span", { className: `ping ${machineState === "offline" ? "danger" : machineState === "busy" ? "warn" : ""}` }),
          `${server.user || "root"}@${server.host}:${server.port || 22}`
        )
      ),
      h("div", { className: "actions" },
        h("div", { className: `status-badge ${machineState}` }, machineStateLabel(machineState)),
        h("button", {
          className: "icon-btn",
          type: "button",
          title: "编辑",
          "aria-label": "编辑服务器",
          onClick: (event) => {
            event.stopPropagation();
            onEdit();
          }
        }, h(EditIcon))
      )
    ),
    h("div", { className: `hero ${machineState}` },
      h(ProgressRing, { percent: busyPercent, color: statusColor, bgColor: statusBg, main: `${busyPercent}%`, sub: deviceLabel }),
      h("div", { className: "hero-info" },
        h("div", { className: "label" }, "设备占用"),
        h("div", { className: "value" }, totalCount ? `${busyCount} / ${totalCount} 张` : "识别中"),
        h("div", { className: "sub" }, totalCount ? (busyCount ? `已分配 ${busyCount} 张 · 空闲 ${freeCount} 张` : "可立即分配资源") : status.summary || "等待采集")
      ),
      h("div", { className: "hero-hardware" },
        h("div", { className: "hero-hw cpu", title: `${formatCpuModel(bestCpuModel(system))} · ${cardCpuMeta(system)}` },
          h("span", { className: "hw-type" }, "CPU"),
          h("div", { className: "hw-copy" },
            h("strong", null, compactCpuModel(system)),
            h("em", null, cardCpuCapacity(system))
          )
        ),
        h("div", { className: `hero-hw accelerator ${machineState}`, title: `${cardAcceleratorText(server, status, acceleratorKind)} · ${cardAcceleratorMeta(server, system)}` },
          h("span", { className: "hw-type" }, deviceLabel),
          h("div", { className: "hw-copy" },
            h("strong", null, compactAcceleratorText(status, totalCount, deviceLabel)),
            h("em", null, compactSystemText(system))
          )
        )
      )
    ),
    h("div", { className: "quick-stats" },
      h(QuickStat, { label: "CPU", value: formatPercent(system.cpuUtilization), extra: cardCpuCapacity(system), percent: system.cpuUtilization, color: metricColor(system.cpuUtilization) }),
      h(QuickStat, { label: "内存", value: formatPercent(system.memoryUtilization), extra: formatMemoryCompact(system.memoryUsedMiB, system.memoryTotalMiB), percent: system.memoryUtilization, color: metricColor(system.memoryUtilization) }),
      h(QuickStat, { label: "CPU温度", value: formatTemperature(system.cpuTemperatureC), extra: cpuTemperatureCaption(system), percent: system.cpuTemperatureC, color: temperatureColor(system.cpuTemperatureC), empty: system.cpuTemperatureC === null || system.cpuTemperatureC === undefined })
    ),
    h("div", { className: "gpu-section" },
      h("div", { className: "section-header" },
        h("span", { className: "title" }, `${deviceLabel} 设备`)
      ),
      h("div", { className: "gpu-grid" }, deviceCards(devices, totalCount, machineState))
    ),
    h("div", { className: "footer" },
      h("div", { className: "footer-stats" },
        h(FooterStat, { type: "models", label: "模型数量", value: assets.modelCount || 0, icon: IconModel }),
        h(FooterStat, { type: "images", label: "镜像数量", value: assets.dockerCount || 0, icon: IconImage }),
        h(FooterStat, { type: "uptime", label: "运行时长", value: formatCompactDuration(system.uptimeSeconds), icon: IconClock })
      ),
      h("div", { className: "footer-bottom" },
        h("div", { className: "spark-wrap" }, h("span", null, "当前卡负载"), h(Sparkline, { values: devices.map((gpu) => Math.max(normalizePercent(gpu.utilization), normalizePercent(gpu.memoryUtilization))), color: machineState === "alert" ? "danger" : machineState === "busy" ? "warning" : "success" })),
        h("div", { className: `heartbeat ${machineState === "offline" ? "fail" : machineState === "alert" ? "danger" : machineState === "busy" ? "warn" : ""}` }, status.updatedAt ? formatTime(status.updatedAt) : "未采集")
      )
    )
  );
});

function ProgressRing({ percent, color, bgColor, main, sub }) {
  const size = 88;
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - normalizePercent(percent) / 100);
  return h("div", { className: "progress-ring", style: { width: `${size}px`, height: `${size}px` } },
    h("svg", { width: size, height: size, viewBox: "0 0 88 88" },
      h("circle", { cx: 44, cy: 44, r: radius, className: "ring-bg", stroke: bgColor }),
      h("circle", { cx: 44, cy: 44, r: radius, className: "ring-fg", stroke: color, strokeDasharray: circumference, strokeDashoffset: offset })
    ),
    h("div", { className: "ring-num" }, h("span", { className: "main", style: { color } }, main), h("span", { className: "sub" }, sub))
  );
}

function compactCpuModel(system) {
  const model = formatCpuModel(bestCpuModel(system));
  const opn = model.match(/\bOPN\s+([A-Z0-9-]+)/i);
  const numbered = model.match(/\b(?:C86[-\s\w]*?\s)?(\d{4})\b/);
  if (opn) return `Hygon ${opn[1]}`;
  if (numbered) return `Hygon ${numbered[1]}`;
  return model
    .replace(/\(R\)|\(TM\)/gi, "")
    .replace(/^Intel\s+/i, "")
    .replace(/\s+CPU\b/i, "")
    .replace(/\s+Processor\b/i, "")
    .replace(/\s+x\d+$/i, "")
    .replace(/\s+\d+-core\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactAcceleratorText(status, totalCount, label) {
  const cuValues = uniqueValues((status.gpus || []).map((gpu) => gpu.cuCount).filter(Boolean));
  const cu = cuValues.length === 1 ? ` · ${cuValues[0]} CU` : "";
  const missingCu = label === "DCU" && totalCount && cuValues.length === 0 ? " · CU未提供" : "";
  return `${totalCount || "-"} 张 ${label}${cu}${missingCu}`;
}

function compactSystemText(system) {
  return shortSystemName(system.osName) || (system.driverVersion ? `驱动 ${system.driverVersion}` : "系统识别中");
}

function QuickStat({ label, value, extra, percent, color, empty }) {
  return h("div", { className: "quick-stat" },
    h("div", { className: "label" }, label),
    h("div", { className: `value ${empty ? "empty" : color || ""}` }, value),
    h("div", { className: "extra" }, extra),
    !empty && percent !== null && percent !== undefined ? h("div", { className: "bar" }, h("div", { className: color || "normal", style: { width: `${normalizePercent(percent)}%` } })) : null
  );
}

function TelemetryStrip({ devices, totalCount, isDcu, offline }) {
  const total = Math.max(Number(totalCount) || 0, (devices || []).length);
  if (offline || !total) {
    return h("span", { className: "telemetry-strip" },
      h("span", { className: "telemetry-chip unavailable" }, offline ? "采集离线" : "等待采集")
    );
  }
  const metrics = [
    { key: "temperature", label: "温度", count: countDeviceMetric(devices, "temperatureC") },
    { key: "power", label: "功耗", count: countDeviceMetric(devices, "powerW") }
  ];
  if (isDcu) metrics.push({ key: "cu", label: "CU", count: countDeviceMetric(devices, "cuCount") });
  return h("span", { className: "telemetry-strip", title: "当前加速卡遥测采集完整度" },
    metrics.map((item) => h("span", {
      className: `telemetry-chip ${item.count === total ? "complete" : item.count === 0 ? "unavailable" : "partial"}`,
      key: item.key,
      title: item.count === total ? `${item.label}已完整采集` : `${item.label}仅采集到 ${item.count}/${total}；目标驱动或管理工具未返回其余数据`
    }, `${item.label} ${item.count}/${total}`))
  );
}

function countDeviceMetric(devices, key) {
  return (devices || []).filter((device) => device[key] !== null && device[key] !== undefined && device[key] !== "").length;
}

function EditIcon() {
  return h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
    h("path", { d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" }),
    h("path", { d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" })
  );
}

function deviceCards(gpus, count, machineState) {
  const list = gpus.length ? gpus : Array.from({ length: count }, (_, index) => ({ index, state: "unknown" }));
  return list.slice(0, count || 0).map((gpu) => {
    const vram = normalizePercent(gpu.memoryUtilization);
    const compute = normalizePercent(gpu.utilization);
    const peak = Math.max(vram, compute);
    const state = machineState === "offline" ? "offline" : Number(gpu.temperatureC) >= 85 ? "alert" : gpu.state === "busy" || peak >= 10 ? "busy" : "idle";
    const memoryUsed = Number(gpu.memoryUsedMiB);
    const memoryTotal = Number(gpu.memoryTotalMiB);
    const memoryPercent = Number.isFinite(memoryTotal) && memoryTotal > 0 ? normalizePercent((memoryUsed / memoryTotal) * 100) : vram;
    return h("div", { className: `gpu-card ${state === "idle" ? "" : state}`, key: gpu.index },
      h("div", { className: "gpu-row1" }, h("div", { className: "gpu-id" }, `#${gpu.index}`), h("div", { className: "gpu-util" }, `${peak}%`)),
      h("div", { className: "gpu-row2" },
        h("span", { className: "gpu-temp" }, h("span", { className: `temp-icon ${temperatureClass(gpu.temperatureC)}` }), formatTemperature(gpu.temperatureC)),
        h("span", null, state === "alert" ? "异常" : state === "busy" ? "活跃" : state === "offline" ? "离线" : "待机")
      ),
      h("div", { className: "gpu-mem" },
        h("div", { className: "mem-bar" }, h("div", { style: { width: `${memoryPercent}%` } })),
        h("span", { className: "mem-text" }, memoryText(gpu))
      )
    );
  });
}

function FooterStat({ type, label, value, icon }) {
  return h("div", { className: "footer-stat" },
    h("div", { className: `icon ${type}` }, h(icon)),
    h("div", { className: "info" }, h("div", { className: "label" }, label), h("div", { className: `value ${value === 0 ? "zero" : ""}` }, value))
  );
}

function IconModel() {
  return h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, h("path", { d: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" }));
}

function IconImage() {
  return h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, h("rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }), h("circle", { cx: "8.5", cy: "8.5", r: "1.5" }), h("polyline", { points: "21 15 16 10 5 21" }));
}

function IconClock() {
  return h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2" }, h("circle", { cx: "12", cy: "12", r: "10" }), h("polyline", { points: "12 6 12 12 16 14" }));
}

function Sparkline({ values, color }) {
  const safe = values && values.length > 1 ? values : [0, 0];
  const width = 80;
  const height = 20;
  const max = Math.max.apply(null, safe.concat([1]));
  const points = safe.map((value, index) => `${(index / Math.max(1, safe.length - 1)) * width},${height - (normalizePercent(value) / max) * 16 - 2}`).join(" ");
  const stroke = color === "danger" ? "#EF4444" : color === "warning" ? "#F59E0B" : "#10B981";
  return h("svg", { width, height, viewBox: `0 0 ${width} ${height}` }, h("polyline", { points, fill: "none", stroke, strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }));
}

function DetailOverlay({ server, openDialog, copy, refreshing, onRefresh, onClose }) {
  if (!server) {
    return null;
  }

  const status = server.status || {};
  const system = status.system || {};
  const assets = server.assets || {};
  const kind = getServerKind(server);
  const totalCount = status.totalCount || server.gpuCount || 0;
  return h("div", { className: "detail-backdrop", role: "presentation", onMouseDown: onClose },
    h("aside", { className: "detail detail-sheet detail-v3", onMouseDown: (event) => event.stopPropagation() },
    h("div", { className: "detail-nav" },
      h("div", { className: "detail-brand" },
        h("span", { className: "detail-brand-mark" }),
        h("strong", null, "GPU/DCU 资源观测台"),
        h("em", null, "Server telemetry")
      ),
      h("div", { className: "detail-actions" },
        h("button", { className: "ghost-action detail-refresh", type: "button", onClick: onRefresh, disabled: refreshing }, refreshing ? "刷新中" : "刷新数据"),
        h("button", { className: "icon-button", type: "button", onClick: () => openDialog(server), "aria-label": "编辑服务器" }, "✎"),
        h("button", { className: "icon-button", type: "button", onClick: onClose, "aria-label": "关闭详情" }, "×")
      )
    ),
    h("section", { className: "detail-hero" },
      h("div", { className: "detail-hero-copy" },
        h("span", { className: `detail-status-pill ${kind}` }, h("i"), `${kindLabel(kind)} · ${commandLabel(server.command)}`),
        h("p", { className: "detail-kicker" }, `${totalCount ? `${totalCount} 卡服务器` : "自动识别卡数"} / ${serverGroup(server)}`),
        h("h2", null, server.name),
        h("p", { className: "detail-address" }, `${server.user || "root"}@${server.host}:${server.port}`),
        h("p", { className: "detail-hero-desc" }, server.note || `集中查看这台服务器的硬件状态、${commandLabel(server.command)} 实时负载与历史使用趋势。`),
        h("div", { className: "detail-hero-tags" },
          h("span", null, bestCpuModel(system)),
          h("span", null, modelSummary(server) || `${commandLabel(server.command)} 型号识别中`)
        )
      ),
      h("div", { className: "detail-live-panel" },
        h("div", { className: "detail-live-head" },
          h("div", null, h("span", null, "LIVE STATUS"), h("strong", null, "实时遥测")),
          h("em", null, status.updatedAt ? `更新于 ${formatTime(status.updatedAt)}` : "等待首次采集")
        ),
        h("div", { className: "detail-occupancy" },
          h("div", { className: `detail-occupancy-ring ${kind}`, style: { "--detail-progress": `${totalCount ? Math.round((status.busyCount || 0) * 100 / totalCount) : 0}%` } },
            h("strong", null, totalCount ? `${status.busyCount || 0}/${totalCount}` : "-"),
            h("span", null, "设备占用")
          ),
          h("div", { className: "detail-meta" },
            h(MetaBox, { label: "CPU 使用率", value: formatPercent(system.cpuUtilization), tone: occupancyClass(system.cpuUtilization) }),
            h(MetaBox, { label: "内存使用率", value: formatPercent(system.memoryUtilization), tone: occupancyClass(system.memoryUtilization) }),
            h(MetaBox, { label: "响应延迟", value: status.latencyMs ? `${status.latencyMs} ms` : "-" }),
            h(MetaBox, { label: "运行时间", value: formatDuration(system.uptimeSeconds) })
          )
        ),
        h("div", { className: "detail-live-foot" }, h("span", null, "SSH PROBE"), h("i"), h("span", null, status.state === "online" ? "CONNECTED" : "DISCONNECTED"))
      )
    ),
    status.error ? h("div", { className: "asset-error" }, status.error) : null,
    h("div", { className: "detail-section-nav" },
      h("span", null, h("strong", null, "01"), "主机概况"),
      h("span", null, h("strong", null, "02"), "加速卡状态"),
      h("span", null, h("strong", null, "03"), "使用历史"),
      h("span", null, h("strong", null, "04"), "模型与镜像资产")
    ),
    h("div", { className: "detail-section-grid" },
      h(CpuPanel, { system }),
      h(MemoryPanel, { system }),
      h(SystemPanel, { system, command: server.command })
    ),
    h(DevicePanel, { gpus: status.gpus || [], totalCount, command: server.command }),
    h(HistoryPanel, { server, totalCount }),
    h(AssetPanel, { assets, copy })
    )
  );
}

function HistoryPanel({ server, totalCount }) {
  const [range, setRange] = useState("24h");
  const [device, setDevice] = useState("");
  const [metric, setMetric] = useState("utilization");
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const dates = historyRange(range);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ from: dates.from, to: dates.to });
    if (device !== "") params.set("device", device);
    requestJson(`/api/servers/${encodeURIComponent(server.id)}/history?${params.toString()}`)
      .then((result) => { if (!cancelled) setPayload(result); })
      .catch((requestError) => { if (!cancelled) setError(requestError.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [server.id, range, device]);
  const summary = payload?.summary || {};
  const points = payload?.points || [];
  const exportUrl = `/api/servers/${encodeURIComponent(server.id)}/history/export?${new URLSearchParams({ from: dates.from, to: dates.to }).toString()}`;
  return h("section", { className: "detail-section history-section" },
    h("div", { className: "section-head history-head" },
      h("div", null, h("p", { className: "eyebrow" }, "History"), h("h3", null, "GPU/DCU 历史使用记录")),
      h("div", { className: "history-controls" },
        h("select", { value: range, onChange: (event) => setRange(event.target.value) },
          h("option", { value: "24h" }, "最近24小时"), h("option", { value: "7d" }, "最近7天"), h("option", { value: "30d" }, "最近30天"), h("option", { value: "90d" }, "最近90天"), h("option", { value: "365d" }, "最近一年")),
        h("select", { value: device, onChange: (event) => setDevice(event.target.value) },
          h("option", { value: "" }, "整机"),
          ...Array.from({ length: totalCount || 0 }, (_, index) => h("option", { value: String(index), key: index }, `卡 #${index}`))),
        h("a", { className: "ghost-action history-export", href: exportUrl }, h("span", { "aria-hidden": "true" }, "↓"), "导出 CSV")
      )
    ),
    h("div", { className: "history-summary" },
      h(HistoryStat, { label: "繁忙占比", value: formatHistoryPercent(summary.busyPercent) }),
      h(HistoryStat, { label: "繁忙分钟", value: summary.busyMinutes === undefined ? "-" : `${summary.busyMinutes} 分钟` }),
      h(HistoryStat, { label: "平均算力", value: formatHistoryPercent(summary.utilizationAvg) }),
      h(HistoryStat, { label: "峰值算力", value: formatHistoryPercent(summary.utilizationMax) }),
      h(HistoryStat, { label: "数据完整率", value: formatHistoryPercent(summary.coveragePercent) })
    ),
    h("div", { className: "history-metric-tabs" },
      [["utilization", "算力"], ["memoryUtilization", "显存"], ["temperatureC", "温度"], ["powerW", "功耗"]].map(([key, label]) => h("button", { type: "button", key, className: metric === key ? "active" : "", onClick: () => setMetric(key) }, label))
    ),
    loading ? h("div", { className: "history-empty" }, "历史数据加载中…") : error ? h("div", { className: "asset-error" }, error) : points.length ? h(HistoryChart, { points, metric }) : h("div", { className: "history-empty" }, "历史记录将在首个完整采集分钟结束后显示"),
    h("p", { className: "history-note" }, "离线时段显示为空档且不计入 0% 使用率；近 90 天为分钟数据，更早数据为 5 分钟长期数据。")
  );
}

function HistoryStat({ label, value }) { return h("div", { className: "history-stat" }, h("span", null, label), h("strong", null, value)); }

function HistoryChart({ points, metric }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const width = 1000;
  const height = 260;
  const plot = { left: 62, right: 18, top: 18, bottom: 42 };
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const valid = points.map((point) => Number(point[metric])).filter(Number.isFinite);
  const max = historyAxisMax(valid, metric);
  const ticks = [0, .25, .5, .75, 1];
  const segments = [];
  let current = [];
  points.forEach((point, index) => {
    const value = Number(point[metric]);
    if (point.state !== "online" || !Number.isFinite(value)) { if (current.length) segments.push(current); current = []; return; }
    current.push(`${plot.left + (index / Math.max(1, points.length - 1)) * plotWidth},${plot.top + (1 - Math.min(value, max) / max) * plotHeight}`);
  });
  if (current.length) segments.push(current);
  const hovered = hoverIndex === null ? null : points[hoverIndex];
  const hoverValue = hovered ? Number(hovered[metric]) : null;
  const hoverX = hoverIndex === null ? null : plot.left + (hoverIndex / Math.max(1, points.length - 1)) * plotWidth;
  const hoverY = Number.isFinite(hoverValue) ? plot.top + (1 - Math.min(hoverValue, max) / max) * plotHeight : null;
  const unit = historyMetricUnit(metric);
  return h("div", { className: "history-chart-wrap" },
    h("div", { className: "history-chart-title" },
      h("span", { className: "history-legend-dot" }),
      h("strong", null, historyMetricLabel(metric)),
      h("em", null, deviceChartCaption(points)),
      h("span", { className: "history-chart-unit" }, `单位：${unit}`)
    ),
    h("svg", {
      className: "history-chart",
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: "none",
      onMouseMove: (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const relative = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        setHoverIndex(Math.round(relative * Math.max(0, points.length - 1)));
      },
      onMouseLeave: () => setHoverIndex(null)
    },
      h("rect", { x: plot.left, y: plot.top, width: plotWidth, height: plotHeight, className: "history-plot-bg" }),
      ticks.map((ratio) => {
        const y = plot.top + ratio * plotHeight;
        const value = max * (1 - ratio);
        return h(React.Fragment, { key: ratio },
          h("line", { x1: plot.left, x2: width - plot.right, y1: y, y2: y, className: "history-grid-line" }),
          h("text", { x: plot.left - 11, y: y + 4, textAnchor: "end", className: "history-y-label" }, formatAxisTick(value))
        );
      }),
      h("line", { x1: plot.left, x2: plot.left, y1: plot.top, y2: height - plot.bottom, className: "history-axis-line" }),
      h("line", { x1: plot.left, x2: width - plot.right, y1: height - plot.bottom, y2: height - plot.bottom, className: "history-axis-line" }),
      segments.map((segment, index) => h("polyline", { key: index, points: segment.join(" "), className: "history-line", fill: "none" }))
      ,hoverX !== null ? h("line", { x1: hoverX, x2: hoverX, y1: plot.top, y2: height - plot.bottom, className: "history-hover-line" }) : null
      ,hoverX !== null && hoverY !== null ? h("circle", { cx: hoverX, cy: hoverY, r: 5, className: "history-hover-dot" }) : null
    ),
    h("div", { className: "history-axis" }, h("span", null, formatHistoryTime(points[0]?.t)), h("span", null, formatHistoryTime(points[Math.floor(points.length / 2)]?.t)), h("span", null, formatHistoryTime(points[points.length - 1]?.t))),
    hovered ? h("div", { className: "history-tooltip", style: { left: `${Math.min(82, Math.max(8, (hoverIndex / Math.max(1, points.length - 1)) * 100))}%` } },
      h("strong", null, hovered.state === "online" && Number.isFinite(hoverValue) ? formatHistoryMetric(hoverValue, metric) : "离线 / 无数据"),
      h("span", null, formatHistoryTimeFull(hovered.t))
    ) : null
  );
}

function historyRange(value) {
  const amount = value === "7d" ? 7 : value === "30d" ? 30 : value === "90d" ? 90 : value === "365d" ? 365 : 1;
  const to = new Date();
  return { from: new Date(to.getTime() - amount * 86400000).toISOString(), to: to.toISOString() };
}
function formatHistoryPercent(value) { return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : "-"; }
function formatHistoryTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-"; }
function formatHistoryMetric(value, metric) { if (!Number.isFinite(Number(value))) return "-"; return metric === "temperatureC" ? `${Math.round(value)}℃` : metric === "powerW" ? `${Math.round(value)}W` : `${Math.round(value)}%`; }
function formatHistoryTimeFull(value) { return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-"; }
function historyMetricLabel(metric) { return metric === "memoryUtilization" ? "显存使用率" : metric === "temperatureC" ? "设备温度" : metric === "powerW" ? "设备功耗" : "算力使用率"; }
function historyMetricUnit(metric) { return metric === "temperatureC" ? "℃" : metric === "powerW" ? "W" : "%"; }
function historyAxisMax(values, metric) {
  if (metric === "utilization" || metric === "memoryUtilization") return 100;
  const peak = values.length ? Math.max(...values) : 1;
  const step = metric === "temperatureC" ? 20 : peak <= 200 ? 50 : 100;
  return Math.max(step, Math.ceil(peak / step) * step);
}
function formatAxisTick(value) { return value >= 100 ? Math.round(value) : Number(value.toFixed(1)); }
function deviceChartCaption(points) { return `${points.length} 个趋势点 · 离线自动断线`; }

function MetaBox({ label, value, tone }) {
  return h("div", { className: `meta-box ${tone || ""}` }, h("span", null, label), h("strong", null, value));
}

function DetailSection({ eyebrow, title, meta, children, className }) {
  return h("section", { className: `detail-section ${className || ""}` },
    h("div", { className: "section-head" },
      h("div", null, h("p", { className: "eyebrow" }, eyebrow), h("h3", null, title)),
      meta ? h("span", null, meta) : null
    ),
    children
  );
}

function CpuPanel({ system }) {
  const modelText = bestCpuModel(system);
  const cpuDetails = cpuPages(system);
  const [page, setPage] = useState(0);
  const safePage = Math.min(page, Math.max(cpuDetails.length - 1, 0));
  const current = cpuDetails[safePage] || null;
  return h(DetailSection, { eyebrow: "CPU", title: "处理器", meta: formatPercent(system.cpuUtilization), className: "cpu-section" },
    h("div", { className: "metric-stack" },
      h(MetricLine, { label: "利用率", value: formatPercent(system.cpuUtilization), percent: normalizePercent(system.cpuUtilization), level: occupancyClass(system.cpuUtilization) }),
      current ? h("div", { className: "cpu-pager" },
        h("div", { className: "cpu-pager-head" },
          h("strong", null, current.title),
          h("span", null, `${safePage + 1}/${cpuDetails.length}`)
        ),
        h("div", { className: "cpu-pager-body" },
          h(InfoCell, { label: "具体型号", value: current.model, wide: true }),
          h(InfoCell, { label: "部件号", value: current.partNumber || "-" }),
          h(InfoCell, { label: "核心/线程", value: current.coreThread || "-" }),
          h(InfoCell, { label: "当前频率", value: current.currentSpeed || "-" }),
          h(InfoCell, { label: "最高频率", value: current.maxSpeed || "-" })
        ),
        cpuDetails.length > 1 ? h("div", { className: "cpu-pager-actions" },
          h("button", { type: "button", className: "mini-copy", onClick: () => setPage((value) => Math.max(0, value - 1)), disabled: safePage <= 0 }, "上一颗"),
          h("button", { type: "button", className: "mini-copy", onClick: () => setPage((value) => Math.min(cpuDetails.length - 1, value + 1)), disabled: safePage >= cpuDetails.length - 1 }, "下一颗")
        ) : null
      ) : null,
      h("div", { className: "detail-kv-list" },
        h(InfoCell, { label: "CPU型号", value: modelText, wide: true }),
        h(InfoCell, { label: "物理CPU", value: system.cpuSockets ? `${system.cpuSockets} 颗` : "-" }),
        h(InfoCell, { label: "逻辑核心", value: system.cpuCores ? `${system.cpuCores} 核` : "-" }),
        h(InfoCell, { label: "CPU温度", value: formatCpuTemperatureDetail(system) }),
        h(InfoCell, { label: cpuPowerLabel(system), value: formatCpuPowerDetail(system) }),
        h(InfoCell, { label: "负载", value: formatLoadAverage(system.loadAverage) })
      )
    )
  );
}

function MemoryPanel({ system }) {
  return h(DetailSection, { eyebrow: "Memory", title: "内存", meta: formatPercent(system.memoryUtilization), className: "memory-section" },
    h("div", { className: "metric-stack" },
      h(MetricLine, { label: "使用率", value: formatPercent(system.memoryUtilization), percent: normalizePercent(system.memoryUtilization), level: occupancyClass(system.memoryUtilization) }),
      h("div", { className: "detail-kv-list" },
        h(InfoCell, { label: "已用/总量", value: formatMemory(system.memoryUsedMiB, system.memoryTotalMiB), wide: true }),
        h(InfoCell, { label: "已用", value: formatGiB(system.memoryUsedMiB) }),
        h(InfoCell, { label: "总量", value: formatGiB(system.memoryTotalMiB) })
      )
    )
  );
}

function SystemPanel({ system, command }) {
  return h(DetailSection, {
    eyebrow: "System",
    title: "系统版本",
    meta: system.error ? "系统探针失败" : null,
    className: `system-section ${system.error ? "has-error" : ""}`
  },
    system.error ? h("div", { className: "asset-error" }, system.error) : null,
    h("div", { className: "detail-kv-list" },
      h(InfoCell, { label: "系统", value: system.osName || "-", wide: true }),
      h(InfoCell, { label: "内核", value: [system.kernel, system.arch].filter(Boolean).join(" / ") || "-", wide: true }),
      h(InfoCell, { label: `${commandLabel(command)} 驱动`, value: system.driverVersion || "-", wide: true }),
      h(InfoCell, { label: "主机名", value: system.hostname || "-" }),
      h(InfoCell, { label: "运行时间", value: formatDuration(system.uptimeSeconds) })
    )
  );
}

function DevicePanel({ gpus, totalCount, command }) {
  const label = command === "nvidia-smi" ? "GPU" : "DCU";
  return h(DetailSection, { eyebrow: label, title: `${label} 卡状态`, meta: totalCount ? `${gpus.filter((gpu) => gpu.state === "busy").length}/${totalCount} 占用` : "识别中", className: "device-section" },
    h("div", { className: "detail-telemetry" },
      h(TelemetryStrip, { devices: gpus, totalCount, isDcu: command !== "nvidia-smi", offline: false }),
      h("span", null, command === "nvidia-smi" ? "CU 不适用于 NVIDIA GPU" : "缺失项表示驱动工具未返回，未按型号猜测")
    ),
    h("div", { className: "gpu-list" }, (gpus || []).map((gpu) => h(GpuRow, { gpu, label, key: gpu.index })))
  );
}

function InfoCell({ label, value, wide }) {
  return h("div", { className: `info-cell ${wide ? "wide" : ""}` },
    h("span", null, label),
    h("strong", null, value)
  );
}

function bestCpuModel(system) {
  const candidates = [system.cpuLscpuModel, system.cpuModelDetail, system.cpuModels, system.cpuModel].filter(Boolean);
  return candidates.find((value) => /\bOPN\s*[:：]?\s*[A-Z0-9-]{3,}/i.test(value))
    || candidates.find((value) => /\bOPN\b/i.test(value))
    || candidates[0]
    || "-";
}

function formatCpuModel(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text === "-") return "型号识别中";
  return text
    .replace(/\s*\(\s*OPN\s*[:：]\s*([^)]+)\)/i, " · OPN $1")
    .replace(/\bOPN\s*[:：]\s*/i, "OPN ");
}

function cardCpuMeta(system) {
  const parts = [];
  if (system.cpuCores) parts.push(`${system.cpuCores} 核`);
  if (system.cpuSockets) parts.push(`${system.cpuSockets} 路 CPU`);
  return parts.join(" · ") || "核心与路数识别中";
}

function cardCpuCapacity(system) {
  if (!system.cpuCores && !system.cpuSockets) return "核心识别中";
  return [system.cpuSockets ? `${system.cpuSockets} 路` : "", system.cpuCores ? `${system.cpuCores} 核` : ""].filter(Boolean).join(" / ");
}

function cardAcceleratorText(server, status, kind) {
  const label = kind === "nvidia" || kind === "gpu" ? "GPU" : kind === "dcu" ? "DCU" : "加速卡";
  const count = status.totalCount || server.gpuCount || 0;
  const cuValues = uniqueValues((status.gpus || []).map((gpu) => gpu.cuCount).filter((value) => value));
  const cuText = cuValues.length === 1 ? ` · ${cuValues[0]} CU` : cuValues.length > 1 ? ` · ${cuValues.join("/")} CU` : "";
  return count ? `${label} ${count} 张${cuText}` : `${label} 识别中`;
}

function cardMachineState(status, devices) {
  if (status.state === "offline") return "offline";
  if ((devices || []).some((gpu) => Number(gpu.temperatureC) >= 85)) return "alert";
  if ((status.busyCount || 0) > 0) return "busy";
  return "idle";
}

function machineStateLabel(state) {
  return state === "busy" ? "占用中" : state === "alert" ? "告警" : state === "offline" ? "离线" : "空闲";
}

function deviceLegends(devices, machineState) {
  if (machineState === "offline") return [{ key: "offline", label: "离线" }];
  const hasAlert = (devices || []).some((gpu) => Number(gpu.temperatureC) >= 85);
  const hasBusy = (devices || []).some((gpu) => gpu.state === "busy" || Math.max(normalizePercent(gpu.utilization), normalizePercent(gpu.memoryUtilization)) >= 10);
  if (!hasAlert && !hasBusy) return [{ key: "idle", label: "空闲" }];
  return [hasBusy ? { key: "busy", label: "运行" } : null, hasAlert ? { key: "alert", label: "异常" } : null].filter(Boolean);
}

function metricColor(value) {
  const percent = normalizePercent(value);
  if (percent >= 80) return "danger";
  if (percent >= 60) return "warning";
  if (percent <= 20) return "success";
  return "normal";
}

function temperatureColor(value) {
  const temperature = Number(value);
  if (!Number.isFinite(temperature)) return "";
  if (temperature >= 85) return "danger";
  if (temperature >= 70) return "warning";
  return "success";
}

function temperatureClass(value) {
  const temperature = Number(value);
  if (!Number.isFinite(temperature)) return "";
  if (temperature >= 85) return "hot";
  if (temperature >= 70) return "warm";
  return "";
}

function cpuTemperatureCaption(system) {
  if (system.cpuTemperatureC === null || system.cpuTemperatureC === undefined) return "传感器未暴露";
  return system.cpuTemperatureSource === "thermal_zone" ? "内核温区" : "CPU 传感器";
}

function formatCpuTemperatureDetail(system) {
  if (system.cpuTemperatureC === null || system.cpuTemperatureC === undefined) return "传感器未暴露";
  const source = system.cpuTemperatureSource === "thermal_zone" ? "内核温区" : system.cpuTemperatureSource === "sensors" ? "sensors" : "";
  return [formatTemperature(system.cpuTemperatureC), source].filter(Boolean).join(" · ");
}

function cpuPowerLabel(system) {
  return system.cpuPowerScope === "host" ? "主机功耗" : "CPU功耗";
}

function formatCpuPowerDetail(system) {
  if (system.cpuPowerW === null || system.cpuPowerW === undefined) return "功耗计未暴露";
  const scope = system.cpuPowerScope === "host" ? "整机读数" : system.cpuPowerScope === "package" ? "处理器封装" : "传感器读数";
  return `${formatPower(system.cpuPowerW)} · ${scope}`;
}

function formatMemoryCompact(usedMiB, totalMiB) {
  const used = Number(usedMiB);
  const total = Number(totalMiB);
  if (!Number.isFinite(total) || total <= 0) return "未接入";
  return `${Math.round(used / 1024)} / ${Math.round(total / 1024)} GB`;
}

function memoryText(gpu) {
  const used = Number(gpu.memoryUsedMiB);
  const total = Number(gpu.memoryTotalMiB);
  if (!Number.isFinite(total) || total <= 0) return formatPower(gpu.powerW);
  return `${Math.round((Number.isFinite(used) ? used : 0) / 1024)}/${Math.round(total / 1024)}G`;
}

function cardSystemText(system, command) {
  const os = shortSystemName(system.osName);
  const driver = system.driverVersion ? `${commandLabel(command)} ${system.driverVersion}` : "";
  const text = [os, driver].filter(Boolean).join(" · ");
  return text || "系统/驱动识别中";
}

function cardAcceleratorMeta(server, system) {
  return [modelSummary(server), cardSystemText(system, server.command)].filter(Boolean).join(" · ");
}

function shortSystemName(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text
    .replace(/Linux Advanced Server/i, "LAS")
    .replace(/\(.*?\)/g, "")
    .trim();
}

function uniqueValues(values) {
  return Array.from(new Set(values));
}

function cpuPages(system) {
  const details = Array.isArray(system.cpuSocketDetails) ? system.cpuSocketDetails : [];
  if (details.length && hasDistinctCpuDetails(details)) {
    return details.map((item, index) => ({
      title: item.socket || `CPU ${index + 1}`,
      model: item.version || bestCpuModel(system),
      partNumber: item.partNumber || null,
      coreThread: [item.coreCount ? `${item.coreCount} 核` : "", item.threadCount ? `${item.threadCount} 线程` : ""].filter(Boolean).join(" / "),
      currentSpeed: item.currentSpeed || null,
      maxSpeed: item.maxSpeed || null
    }));
  }
  return [];
}

function hasDistinctCpuDetails(details) {
  const signatures = new Set(details.map((item) => [
    item.version || "",
    item.partNumber || "",
    item.coreCount || "",
    item.threadCount || "",
    item.maxSpeed || "",
    item.currentSpeed || ""
  ].join("|")));
  return signatures.size > 1;
}

function GpuRow({ gpu, label }) {
  const utilization = normalizePercent(gpu.utilization);
  const memoryUtilization = normalizePercent(gpu.memoryUtilization);
  const memory = gpu.memoryTotalMiB
    ? `${gpu.memoryUsedMiB || 0}/${gpu.memoryTotalMiB} MiB`
    : gpu.memoryUtilization !== null && gpu.memoryUtilization !== undefined ? `${gpu.memoryUtilization}%` : "-";
  return h("div", { className: "gpu-row" },
    h("div", { className: "gpu-row-head" },
      h("strong", null, `${label || "卡"} #${gpu.index}${gpu.model ? ` · ${gpu.model}` : ""}`),
      h("span", null, gpuStateLabel(gpu.state))
    ),
    h(MetricLine, { label: "显存", value: formatPercent(gpu.memoryUtilization), percent: memoryUtilization, level: occupancyClass(memoryUtilization) }),
    h(MetricLine, { label: "算力", value: formatPercent(gpu.utilization), percent: utilization, level: occupancyClass(utilization) }),
    h("div", { className: "gpu-metrics" },
      h("span", null, `显存 ${memory}`),
      h("span", null, `CU ${gpu.cuCount ?? "-"}`),
      h("span", null, `温度 ${gpu.temperatureC ?? "-"}℃`),
      h("span", null, `功耗 ${gpu.powerW ?? "-"}W`)
    )
  );
}

function MetricLine({ label, value, percent, level }) {
  return h("div", { className: "metric-line" },
    h("span", null, label),
    h("div", { className: "bar" }, h("i", { className: level, style: { width: `${percent}%` } })),
    h("strong", null, value)
  );
}

function AssetPanel({ assets, copy }) {
  const modelItems = assets.modelItems || [];
  const dockerImages = assets.dockerImages || [];
  return h("section", { className: "asset-panel" },
    h("div", { className: "asset-head" },
      h("div", null, h("p", { className: "eyebrow" }, "Assets"), h("h3", null, "模型路径与镜像")),
      h("span", null, assetUpdatedText(assets))
    ),
    assets.error ? h("div", { className: "asset-error" }, assets.error) : null,
    h("div", { className: "asset-columns" },
      h("div", { className: "asset-column" },
        h("div", { className: "asset-title" }, h("strong", null, "挂载目录模型"), h("span", null, modelItems.length)),
        h("div", { className: "asset-list" },
          modelItems.length ? modelItems.slice(0, 80).map((item) => h("button", {
            className: "asset-item",
            key: item.path,
            type: "button",
            onClick: () => copy(item.path, "模型路径")
          }, h("strong", null, item.name || "-"), h("span", null, item.path || "-"), h("em", null, `${item.root || "-"} · 目录`)))
            : h("div", { className: "asset-empty" }, assets.modelCount ? "正在加载模型详情" : "未发现模型目录或文件")
        )
      ),
      h("div", { className: "asset-column" },
        h("div", { className: "asset-title" }, h("strong", null, "Docker Images"), h("span", null, dockerImages.length)),
        h("div", { className: "asset-list" },
          dockerImages.length ? dockerImages.slice(0, 80).map((image) => h("button", {
            className: "asset-item",
            key: `${image.repository}:${image.tag}:${image.imageId}`,
            type: "button",
            onClick: () => copy(`${image.repository}:${image.tag}`, "镜像")
          }, h("strong", null, `${image.repository || "-"}:${image.tag || "-"}`), h("span", null, `${image.imageId || "-"} · ${image.size || "-"}`), h("em", null, image.created || "-")))
            : h("div", { className: "asset-empty" }, assets.dockerCount ? "正在加载镜像详情" : "未发现 Docker 镜像")
        )
      )
    )
  );
}

function AssetView({ query, assetType, setAssetType, assetState, setAssetState, assetResults, assetTotalMatches, assetSearching, copy }) {
  const summary = !query.trim()
    ? "输入模型名、路径或镜像名称开始查找。"
    : assetSearching
      ? `正在查找“${query.trim()}”...`
      : assetResults.length
        ? `找到 ${assetTotalMatches} 条匹配，分布在 ${assetResults.length} 台服务器。`
        : `没有找到“${query.trim()}”相关的模型或镜像。`;
  return h("section", { className: "asset-workbench" },
    h("div", { className: "asset-toolbar" },
      h(FilterGroup, { items: [["all", "全部"], ["model", "模型"], ["docker", "镜像"]], value: assetType, onChange: setAssetType }),
      h(FilterGroup, { items: [["all", "全部机器"], ["free", "空闲机器"], ["busy", "占用机器"]], value: assetState, onChange: setAssetState })
    ),
    h("div", { className: "asset-search-summary" }, summary),
    h("div", { className: "asset-result-list" },
      !query.trim()
        ? h("div", { className: "asset-search-empty" }, h("strong", null, "搜索 Qwen、DeepSeek、镜像 tag 或完整路径"), h("span", null, "结果会按服务器聚合，并显示当前卡占用状态。"))
        : assetResults.length
          ? assetResults.map((group) => h(AssetResultCard, { group, query, copy, key: group.server?.id || group.server?.host }))
          : !assetSearching ? h("div", { className: "asset-search-empty" }, h("strong", null, "没有匹配结果"), h("span", null, "可以换一个模型名、路径或镜像 tag。")) : null
    )
  );
}

function FilterGroup({ items, value, onChange }) {
  return h("div", { className: "asset-filter-group" }, items.map(([itemValue, label]) => h("button", {
    key: itemValue,
    className: `asset-filter${value === itemValue ? " active" : ""}`,
    type: "button",
    onClick: () => onChange(itemValue)
  }, label)));
}

function AssetResultCard({ group, query, copy }) {
  const server = group.server || {};
  const sshCommand = `ssh ${server.user || "root"}@${server.host}`;
  return h("article", { className: "asset-result-card" },
    h("div", { className: "asset-result-head" },
      h("div", null,
        h("div", { className: "asset-server-title" }, server.name || server.host),
        h("div", { className: "asset-server-meta" }, [server.group || "未分组", `${server.host}:${server.port || 22}`, server.summary || "-"].map((item) => h("span", { key: item }, item)))
      ),
      h("span", { className: `status-pill status-${server.state || "pending"}` }, kindLabel(server.state))
    ),
    h("div", { className: "asset-copy-row" },
      h("button", { className: "mini-copy", type: "button", onClick: () => copy(server.host, "IP") }, "复制 IP"),
      h("button", { className: "mini-copy", type: "button", onClick: () => copy(sshCommand, "SSH 命令") }, "复制 SSH")
    ),
    h("div", { className: "asset-match-list" }, (group.matches || []).map((match, index) => h(AssetMatch, { match, query, copy, key: `${match.type}:${match.value}:${index}` })))
  );
}

function AssetMatch({ match, query, copy }) {
  const label = match.type === "docker" ? "镜像" : "模型";
  return h("div", { className: `asset-match ${match.type}` },
    h("span", { className: "asset-kind" }, label),
    h("div", { className: "asset-match-main" },
      h(Highlight, { value: match.label || "-", query }),
      h(Highlight, { value: match.value || "-", query, tag: "span" }),
      h("em", null, match.meta || "")
    ),
    h("button", { className: "mini-copy", type: "button", onClick: () => copy(match.copyText || match.value || "", label) }, "复制")
  );
}

function Highlight({ value, query, tag }) {
  const parts = splitHighlight(value, query);
  return h(tag || "strong", null, parts.map((part, index) => (
    part.hit ? h("mark", { key: index }, part.text) : part.text
  )));
}

function ChangelogView({ entries, loading, updatedAt }) {
  return h("section", { className: "changelog-panel" },
    h("div", { className: "changelog-head" },
      h("div", null, h("p", { className: "eyebrow" }, "Versions"), h("h3", null, "最近更新")),
      h("span", null, updatedAt ? `同步 ${formatTime(updatedAt)}` : "读取中")
    ),
    h("div", { className: "changelog-list" },
      loading && !entries.length ? h("div", { className: "changelog-empty" }, "正在读取更新日志...")
        : entries.length ? entries.map((entry) => h("article", { className: "changelog-entry", key: entry.title },
          h("div", { className: "changelog-date" }, entry.title || ""),
          h("ul", null, (entry.items || []).map((item, index) => h("li", { key: index }, item)))
        )) : h("div", { className: "changelog-empty" }, "暂无更新记录")
    )
  );
}

function EmptyState({ onAdd }) {
  return h("section", { className: "empty-state" }, h("div", { className: "empty-icon" }, "+"), h("h3", null, "添加第一台服务器"), h("p", null, "配置 SSH 登录信息后，看板会定时采集显存和算力占用。"), h("button", { className: "primary-action", type: "button", onClick: onAdd }, "添加服务器"));
}

function ServerDialog({ server, groups, onClose, onSave, onDelete }) {
  const [form, setForm] = useState(() => ({
    id: server?.id || "",
    name: server?.name || "",
    host: server?.host || "",
    user: server?.user || "root",
    port: server?.port || 22,
    command: server?.command || "hy-smi",
    group: server?.group || "",
    tags: (server?.tags || []).join(", ")
  }));
  const editing = Boolean(server);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  return h("div", { className: "dialog-backdrop", role: "presentation", onMouseDown: onClose },
    h("form", {
      className: "server-dialog",
      onMouseDown: (event) => event.stopPropagation(),
      onSubmit: (event) => {
        event.preventDefault();
        onSave({
          name: form.name,
          host: form.host,
          user: form.user,
          port: Number(form.port || 22),
          command: form.command || "hy-smi",
          group: form.group,
          tags: form.tags
        }, form.id);
      }
    },
      h("div", { className: "dialog-head" }, h("div", null, h("p", { className: "eyebrow" }, "服务器配置"), h("h3", null, editing ? "编辑服务器" : "添加服务器")), h("button", { className: "icon-button", type: "button", onClick: onClose }, "×")),
      h(Field, { label: "名称", value: form.name, onChange: (value) => set("name", value), required: true, placeholder: "例如：算法公共机 A" }),
      h(Field, { label: "Host / IP", value: form.host, onChange: (value) => set("host", value), required: true, placeholder: "10.0.0.12" }),
      h("div", { className: "field-row" },
        h(Field, { label: "SSH 用户", value: form.user, onChange: (value) => set("user", value), placeholder: "root" }),
        h(Field, { label: "端口", value: form.port, type: "number", onChange: (value) => set("port", value), min: 1, max: 65535 })
      ),
      h("label", null, h("span", null, "分组"), h("input", { value: form.group, list: "groupOptions", onChange: (event) => set("group", event.target.value), placeholder: "通信中兴组" }), h("datalist", { id: "groupOptions" }, groups.map((group) => h("option", { value: group, key: group })))),
      h(Field, { label: "标签", value: form.tags, onChange: (value) => set("tags", value), placeholder: "公共池, 回归" }),
      h("label", null, h("span", null, "采集命令"), h("select", { value: form.command, onChange: (event) => set("command", event.target.value) }, h("option", { value: "hy-smi" }, "hy-smi（海光 DCU）"), h("option", { value: "nvidia-smi" }, "nvidia-smi（NVIDIA GPU）"))),
      h("div", { className: "dialog-actions" },
        editing ? h("button", { className: "ghost-action", type: "button", onClick: () => onDelete(form.id) }, "删除") : h("span"),
        h("button", { className: "primary-action", type: "submit" }, "保存")
      )
    )
  );
}

function Field({ label, value, onChange, type, required, placeholder, min, max }) {
  return h("label", null,
    h("span", null, label),
    h("input", { value, type: type || "text", required, placeholder, min, max, onChange: (event) => onChange(event.target.value) })
  );
}

function mergeServerAssetDetails(nextServers, previousServers) {
  const previousById = new Map((previousServers || []).map((server) => [server.id, server]));
  return nextServers.map((server) => {
    const previous = previousById.get(server.id);
    if (!previous?.assets || !server.assets) return server;
    const hasModelDetails = (server.assets.modelItems || []).length > 0;
    const hasDockerDetails = (server.assets.dockerImages || []).length > 0;
    const hadModelDetails = (previous.assets.modelItems || []).length > 0;
    const hadDockerDetails = (previous.assets.dockerImages || []).length > 0;
    if ((!hadModelDetails || hasModelDetails) && (!hadDockerDetails || hasDockerDetails)) return server;
    return {
      ...server,
      assets: {
        ...previous.assets,
        ...server.assets,
        modelItems: hasModelDetails ? server.assets.modelItems : previous.assets.modelItems,
        dockerImages: hasDockerDetails ? server.assets.dockerImages : previous.assets.dockerImages
      }
    };
  });
}

function summarizeServers(servers) {
  const totals = { servers: servers.length, cards: 0, busyCards: 0, freeCards: 0, freeServers: 0, busyServers: 0, offlineServers: 0 };
  for (const server of servers) {
    const status = server.status || {};
    const kind = getServerKind(server);
    totals.cards += status.totalCount || server.gpuCount || 0;
    totals.busyCards += status.busyCount || 0;
    totals.freeCards += status.freeCount || 0;
    if (kind === "free") totals.freeServers += 1;
    if (kind === "busy") totals.busyServers += 1;
    if (kind === "offline") totals.offlineServers += 1;
  }
  return totals;
}

function groupSummaries(servers) {
  const byGroup = new Map();
  for (const server of servers) {
    const group = serverGroup(server);
    byGroup.set(group, (byGroup.get(group) || 0) + 1);
  }
  return Array.from(byGroup.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function matchesDashboardQuery(server, query) {
  const terms = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const fields = [server.name, server.host, server.user, serverGroup(server), modelSummary(server), ...(server.tags || [])].map((value) => String(value || "").toLowerCase());
  const text = fields.join(" ");
  const tokens = fields.flatMap((field) => field.match(/[a-z0-9]+/g) || []);
  return terms.every((term) => {
    if (term.includes(".") || /[\u4e00-\u9fff]/.test(term)) return text.includes(term);
    if (/^[a-z0-9]+$/.test(term)) return tokens.some((token) => token === term || (term.length <= 4 && token.startsWith(term)));
    return text.includes(term);
  });
}

function splitHighlight(value, query) {
  const text = String(value ?? "");
  const firstTerm = String(query || "").trim().split(/\s+/).filter(Boolean)[0];
  if (!firstTerm) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const term = firstTerm.toLowerCase();
  const index = lower.indexOf(term);
  if (index < 0) return [{ text, hit: false }];
  return [
    { text: text.slice(0, index), hit: false },
    { text: text.slice(index, index + firstTerm.length), hit: true },
    { text: text.slice(index + firstTerm.length), hit: false }
  ].filter((part) => part.text);
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

function formatTemperature(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${Number.isInteger(number) ? number : number.toFixed(1)}℃`;
}

function formatPower(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return `${Number.isInteger(number) ? number : number.toFixed(1)}W`;
}

function formatMemory(usedMiB, totalMiB) {
  const used = Number(usedMiB);
  const total = Number(totalMiB);
  if (!Number.isFinite(total) || total <= 0) return "-";
  return `${formatGiB(used)}/${formatGiB(total)}`;
}

function formatGiB(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const gib = number / 1024;
  return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1)} GiB`;
}

function formatDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return "-";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时`;
  return `${Math.max(1, Math.floor(total / 60))}分钟`;
}

function formatCompactDuration(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return "-";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function formatLoadAverage(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return value || "-";
  return `1m ${parts[0]} / 5m ${parts[1]} / 15m ${parts[2]}`;
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
  let max = 0;
  for (const gpu of gpus) max = Math.max(max, normalizePercent(gpu.memoryUtilization), normalizePercent(gpu.utilization));
  return occupancyClass(max);
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
  const models = server.status?.models?.length ? server.status.models : (server.status?.gpus || []).map((gpu) => gpu.model).filter(Boolean);
  const unique = [...new Set(models)];
  if (!unique.length) return "型号识别中";
  return unique.length === 1 ? unique[0] : unique.join(" / ");
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 ${response.status}`);
  return payload;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function fallbackCopyText(text) {
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  document.body.removeChild(input);
}

ReactDOM.createRoot(document.querySelector("#root")).render(h(App));
