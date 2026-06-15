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
  const [siteConfig, setSiteConfig] = useState({ current: DEFAULT_SITE, sites: [] });
  const [lastRefresh, setLastRefresh] = useState(null);
  const [pollIntervalMs, setPollIntervalMs] = useState(10000);
  const [assetRefreshing, setAssetRefreshing] = useState(false);
  const [assetType, setAssetType] = useState("all");
  const [assetState, setAssetState] = useState("all");
  const [assetResults, setAssetResults] = useState([]);
  const [assetTotalMatches, setAssetTotalMatches] = useState(0);
  const [assetSearching, setAssetSearching] = useState(false);
  const [assetDetailLoading, setAssetDetailLoading] = useState(false);
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
    setAssetRefreshing(Boolean(payload.assetRefreshing));
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

  const manualRefresh = useCallback(async () => {
    try {
      await requestJson("/api/refresh", { method: "POST" });
      await fetchServers();
      notify("刷新完成");
    } catch (error) {
      notify(error.message);
    }
  }, [fetchServers, notify]);

  const refreshAssets = useCallback(async () => {
    try {
      setAssetRefreshing(true);
      await requestJson("/api/assets/refresh", { method: "POST" });
      await fetchServers();
      notify("模型资产刷新完成");
    } catch (error) {
      notify(error.message);
    } finally {
      setAssetRefreshing(false);
    }
  }, [fetchServers, notify]);

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
    h(Sidebar, { siteConfig, totals, filter, setFilter, groups, groupFilter, setGroupFilter, lastRefresh }),
    h("main", { className: "command-center" },
      h(TopRail, {
        title: pageTitle,
        description: siteConfig.current.description || DEFAULT_SITE.description,
        view,
        setView,
        query,
        setQuery,
        searchLabel,
        searchPlaceholder,
        onRefresh: manualRefresh,
        onAssetRefresh: refreshAssets,
        onAdd: () => openDialog(null),
        assetRefreshing
      }),
      view === "dashboard"
        ? h(DashboardView, { totals, groups, groupFilter, setGroupFilter, servers: filteredServers, selectedId, setSelectedId, openDialog })
        : view === "assets"
          ? h(AssetView, { query, assetType, setAssetType, assetState, setAssetState, assetResults, assetTotalMatches, assetSearching, copy })
          : h(ChangelogView, { entries: changelogEntries, loading: changelogLoading, updatedAt: changelogUpdatedAt })
    ),
    h(DetailPanel, { server: selectedServer, openDialog, copy }),
    dialogOpen ? h(ServerDialog, { server: dialogServer, groups: groupNames, onClose: () => setDialogOpen(false), onSave: saveServer, onDelete: deleteServer }) : null,
    toast ? h("div", { className: "toast" }, toast) : null
  );
}

function Sidebar({ siteConfig, totals, filter, setFilter, groups, groupFilter, setGroupFilter, lastRefresh }) {
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
    h("div", { className: "section-label" }, "Groups"),
    h("div", { className: "side-groups" },
      h("button", {
        className: `side-group${groupFilter === "all" ? " active" : ""}`,
        type: "button",
        onClick: () => setGroupFilter("all")
      }, h("span", null, "全部分组"), h("strong", null, totals.servers)),
      groups.map((group) => h("button", {
        key: group.name,
        className: `side-group${groupFilter === group.name ? " active" : ""}`,
        type: "button",
        onClick: () => setGroupFilter(group.name)
      }, h("span", null, group.name), h("strong", null, group.count)))
    ),
    h("div", { className: "sidebar-note" },
      h("span", null, "Dispatch hint"),
      h("strong", null, "先看空闲卡，再看模型资产；可用机器应该在 3 秒内被定位。")
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
      h("button", {
        className: `ghost-action${props.view === "assets" ? " asset-context" : ""}`,
        type: "button",
        disabled: props.assetRefreshing,
        onClick: props.onAssetRefresh
      }, props.assetRefreshing ? "资产盘点中" : "刷新模型资产"),
      h("button", { className: "primary-action", type: "button", onClick: props.onAdd }, "添加服务器")
    )
  );
}

function DashboardView({ totals, groups, groupFilter, setGroupFilter, servers, selectedId, setSelectedId, openDialog }) {
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
        onSelect: () => setSelectedId(server.id),
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
  const assets = server.assets || {};
  const kind = getServerKind(server);
  const totalCount = status.totalCount || server.gpuCount || 0;
  const busyPercent = totalCount ? Math.round(((status.busyCount || 0) / totalCount) * 100) : 0;
  const tags = [...new Set([serverGroup(server), ...(server.tags?.length ? server.tags : [totalCount ? `${totalCount}卡` : "自动识别"])])];

  return h("article", {
    className: `server-card ${serverOccupancyClass(server)}${selected ? " selected" : ""}`,
    style: { "--busy": `${busyPercent}%` },
    tabIndex: 0,
    onClick: onSelect,
    onKeyDown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect();
      }
    }
  },
    h("div", { className: "card-topline" },
      h("div", null,
        h("h3", null, server.name),
        h("code", null, `${server.user ? `${server.user}@` : ""}${server.host}:${server.port}`)
      ),
      h("span", { className: `status-pill status-${kind}` }, kindLabel(kind))
    ),
    h("div", { className: "rack-meter" },
      h("div", { className: "donut" }, h("span", null, totalCount ? `${status.busyCount || 0}/${totalCount}` : "-")),
      h("div", null,
        h("strong", null, status.summary || "等待刷新"),
        h("span", null, status.updatedAt ? formatTime(status.updatedAt) : "未采集")
      )
    ),
    h("div", { className: "slot-grid" }, gpuSlots(status.gpus || [], totalCount, kind)),
    h("div", { className: "model-line" }, modelSummary(server)),
    h("div", { className: `asset-summary ${assets.state === "failed" ? "failed" : ""}` },
      h("span", null, `模型 ${assets.modelCount || 0}`),
      h("span", null, `镜像 ${assets.dockerCount || 0}`),
      h("em", null, assetUpdatedText(assets))
    ),
    h("div", { className: "tag-list" },
      tags.map((tag) => h("span", { className: "tag", key: tag }, tag)),
      h("button", {
        className: "icon-button edit-card",
        type: "button",
        "aria-label": "编辑服务器",
        onClick: (event) => {
          event.stopPropagation();
          onEdit();
        }
      }, "✎")
    )
  );
});

function gpuSlots(gpus, count, serverKind) {
  const list = gpus.length ? gpus : Array.from({ length: count }, (_, index) => ({ index, state: "unknown" }));
  return list.slice(0, count || 0).map((gpu) => {
    const cls = serverKind === "offline" ? "offline" : gpu.state || "unknown";
    const chipLevel = gpuOccupancyClass(gpu);
    const vram = normalizePercent(gpu.memoryUtilization);
    const compute = normalizePercent(gpu.utilization);
    return h("span", { className: `slot ${cls} ${chipLevel}`, key: gpu.index, title: `#${gpu.index} 显存 ${formatPercent(gpu.memoryUtilization)} 算力 ${formatPercent(gpu.utilization)}` },
      h("b", null, `#${gpu.index}`),
      h("i", { style: { height: `${Math.max(vram, compute)}%` } }),
      h("em", null, `${Math.max(vram, compute)}%`)
    );
  });
}

function DetailPanel({ server, openDialog, copy }) {
  if (!server) {
    return h("aside", { className: "detail" },
      h("div", { className: "detail-empty" },
        h("div", { className: "detail-pulse" }),
        h("h3", null, "选择一台服务器"),
        h("p", null, "查看每张卡的占用、显存、温度、模型路径和镜像。")
      )
    );
  }

  const status = server.status || {};
  const assets = server.assets || {};
  const kind = getServerKind(server);
  const totalCount = status.totalCount || server.gpuCount || 0;
  return h("aside", { className: "detail" },
    h("div", { className: "detail-head" },
      h("div", null,
        h("p", { className: "eyebrow" }, `${totalCount ? `${totalCount}卡服务器` : "自动识别卡数"} · ${commandLabel(server.command)}`),
        h("h3", null, server.name),
        h("code", null, `${server.host}:${server.port}`)
      ),
      h("button", { className: "icon-button", type: "button", onClick: () => openDialog(server) }, "✎")
    ),
    h("div", { className: "detail-meta" },
      h(MetaBox, { label: "状态", value: kindLabel(kind), tone: kind }),
      h(MetaBox, { label: "占用", value: totalCount ? `${status.busyCount || 0}/${totalCount}` : "识别中" }),
      h(MetaBox, { label: "分组", value: serverGroup(server) }),
      h(MetaBox, { label: "延迟", value: status.latencyMs ? `${status.latencyMs}ms` : "-" })
    ),
    status.error ? h("div", { className: "asset-error" }, status.error) : null,
    h("div", { className: "gpu-list" }, (status.gpus || []).map((gpu) => h(GpuRow, { gpu, key: gpu.index }))),
    h(AssetPanel, { assets, copy })
  );
}

function MetaBox({ label, value, tone }) {
  return h("div", { className: `meta-box ${tone || ""}` }, h("span", null, label), h("strong", null, value));
}

function GpuRow({ gpu }) {
  const utilization = normalizePercent(gpu.utilization);
  const memoryUtilization = normalizePercent(gpu.memoryUtilization);
  const memory = gpu.memoryTotalMiB
    ? `${gpu.memoryUsedMiB || 0}/${gpu.memoryTotalMiB} MiB`
    : gpu.memoryUtilization !== null && gpu.memoryUtilization !== undefined ? `${gpu.memoryUtilization}%` : "-";
  return h("div", { className: "gpu-row" },
    h("div", { className: "gpu-row-head" },
      h("strong", null, `卡 #${gpu.index}${gpu.model ? ` · ${gpu.model}` : ""}`),
      h("span", null, gpuStateLabel(gpu.state))
    ),
    h(MetricLine, { label: "显存", value: formatPercent(gpu.memoryUtilization), percent: memoryUtilization, level: occupancyClass(memoryUtilization) }),
    h(MetricLine, { label: "算力", value: formatPercent(gpu.utilization), percent: utilization, level: occupancyClass(utilization) }),
    h("div", { className: "gpu-metrics" },
      h("span", null, `显存 ${memory}`),
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
          : !assetSearching ? h("div", { className: "asset-search-empty" }, h("strong", null, "没有匹配结果"), h("span", null, "可以先刷新模型资产，或换一个模型名 / 镜像 tag。")) : null
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
