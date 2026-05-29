const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3066);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10000);
const SSH_TIMEOUT_MS = Number(process.env.SSH_TIMEOUT_MS || 20000);
const REFRESH_CONCURRENCY = clampInt(process.env.REFRESH_CONCURRENCY, 1, 32, 8);
const ASSET_REFRESH_INTERVAL_MS = Number(process.env.ASSET_REFRESH_INTERVAL_MS || 30 * 60 * 1000);
const ASSET_SSH_TIMEOUT_MS = Number(process.env.ASSET_SSH_TIMEOUT_MS || 30000);
const ASSET_CONCURRENCY = clampInt(process.env.ASSET_CONCURRENCY, 1, 16, 3);
const ASSET_MAX_ITEMS = clampInt(process.env.ASSET_MAX_ITEMS, 20, 1000, 160);
const ASSET_SEARCH_MAX_RESULTS = clampInt(process.env.ASSET_SEARCH_MAX_RESULTS, 20, 2000, 300);
const ASSET_PATHS = parseCsv(process.env.ASSET_PATHS || "/models,/public,/data");
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000);
const BACKUP_RETENTION = clampInt(process.env.BACKUP_RETENTION, 1, 365, 30);
const SITE_ID = String(process.env.SITE_ID || "local").trim() || "local";
const SITE_NAME = String(process.env.SITE_NAME || "本地中心").trim() || "本地中心";
const SITE_DESCRIPTION = String(process.env.SITE_DESCRIPTION || "共享测试资源").trim() || "共享测试资源";
const SITE_URL = String(process.env.SITE_URL || "/").trim() || "/";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "servers.json");
const SITE_CONFIG_PATH = path.join(DATA_DIR, "sites.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const PUBLIC_DIR = path.join(ROOT, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

let statusCache = new Map();
let assetCache = new Map();
let lastRefresh = null;
let lastAssetRefresh = null;
let refreshInFlight = null;
let refreshInFlightIncludesModels = false;
let assetRefreshInFlight = null;

function createId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return [4, 2, 2, 2, 6]
    .map((bytes) => crypto.randomBytes(bytes).toString("hex"))
    .join("-");
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, "[]\n", "utf8");
  }
}

function loadServers() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeServer).filter(Boolean) : [];
  } catch (error) {
    console.error("Failed to read server config:", error.message);
    return [];
  }
}

function saveServers(servers) {
  ensureDataFile();
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(servers, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}

function backupServerConfig(reason) {
  ensureDataFile();
  if (!fs.existsSync(CONFIG_PATH)) return;
  const stamp = compactTimestamp(new Date());
  const suffix = reason ? `.${reason}` : "";
  const target = path.join(BACKUP_DIR, `servers.${stamp}${suffix}.json`);
  try {
    fs.copyFileSync(CONFIG_PATH, target);
    pruneBackups();
  } catch (error) {
    console.warn(`Server config backup failed: ${error.message}`);
  }
}

function pruneBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const backups = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => /^servers\.\d{14}.*\.json$/.test(name))
    .map((name) => ({
      name,
      filePath: path.join(BACKUP_DIR, name),
      mtimeMs: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  backups.slice(BACKUP_RETENTION).forEach((backup) => {
    try {
      fs.unlinkSync(backup.filePath);
    } catch (error) {
      console.warn(`Failed to prune backup ${backup.name}: ${error.message}`);
    }
  });
}

function compactTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function loadSiteConfig() {
  const current = normalizeSite({
    id: SITE_ID,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    current: true
  });
  let configuredSites = [];

  const fileConfig = readSiteConfigFile();
  if (fileConfig) {
    if (fileConfig.current) {
      const fileCurrent = normalizeSite(fileConfig.current);
      if (fileCurrent) {
        current.id = fileCurrent.id || current.id;
        current.name = fileCurrent.name || current.name;
        current.description = fileCurrent.description || current.description;
        current.url = fileCurrent.url || current.url;
      }
    }
    configuredSites = Array.isArray(fileConfig.sites) ? fileConfig.sites.map(normalizeSite).filter(Boolean) : [];
  } else {
    configuredSites = parseSiteLinks(process.env.SITE_LINKS);
  }

  const sites = mergeSites(current, configuredSites);
  return { current, sites };
}

function readSiteConfigFile() {
  if (!fs.existsSync(SITE_CONFIG_PATH)) return null;
  try {
    const raw = fs.readFileSync(SITE_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { sites: parsed };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.warn(`Failed to read site config: ${error.message}`);
    return null;
  }
}

function parseSiteLinks(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text[0] === "[") {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.map(normalizeSite).filter(Boolean) : [];
    } catch (error) {
      console.warn(`SITE_LINKS JSON parse failed: ${error.message}`);
      return [];
    }
  }
  return text
    .split(";")
    .map((item, index) => {
      const parts = item.split("|").map((part) => part.trim());
      return normalizeSite({
        id: parts[0] || `site-${index + 1}`,
        name: parts[0],
        url: parts[1],
        description: parts[2]
      });
    })
    .filter(Boolean);
}

function normalizeSite(input) {
  if (!input || typeof input !== "object") return null;
  const name = String(input.name || "").trim();
  const url = String(input.url || "").trim();
  if (!name || !url) return null;
  return {
    id: String(input.id || name).trim() || name,
    name,
    url,
    description: String(input.description || "").trim(),
    current: Boolean(input.current)
  };
}

function mergeSites(current, sites) {
  const byKey = new Map();
  [current].concat(sites || []).forEach((site) => {
    if (!site) return;
    const key = site.id || site.url || site.name;
    byKey.set(key, {
      id: site.id,
      name: site.name,
      url: site.url,
      description: site.description,
      current: site.current || site.id === current.id || site.url === current.url
    });
  });
  return Array.from(byKey.values());
}

function normalizeServer(input) {
  if (!input || typeof input !== "object") return null;
  const host = String(input.host || "").trim();
  if (!host) return null;

  const name = String(input.name || host).trim();
  const user = String(input.user || "root").trim();
  const command = normalizeCommand(input.command);
  const group = normalizeGroup(input.group || input.team);
  const tags = Array.isArray(input.tags)
    ? input.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 6)
    : String(input.tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 6);

  return {
    id: String(input.id || createId()),
    name,
    host,
    port: clampInt(input.port, 1, 65535, 22),
    user,
    gpuCount: optionalInt(input.gpuCount, 0, 32),
    command,
    group,
    tags,
    models: normalizeModels(input.models),
    gpuModels: normalizeGpuModels(input.gpuModels)
  };
}

function normalizeGroup(group) {
  const value = String(group || "").replace(/\s+/g, " ").trim();
  return value || "未分组";
}

function normalizeModels(models) {
  if (!Array.isArray(models)) return [];
  return models.map(normalizeModelName).filter(Boolean).slice(0, 32);
}

function normalizeGpuModels(gpuModels) {
  if (!Array.isArray(gpuModels)) return [];
  return gpuModels
    .map((gpu) => {
      if (!gpu || typeof gpu !== "object") return null;
      const index = optionalInt(gpu.index, 0, 31);
      return {
        index,
        model: normalizeModelName(gpu.model),
        vendor: normalizeModelName(gpu.vendor)
      };
    })
    .filter((gpu) => gpu && (gpu.model || gpu.vendor))
    .slice(0, 32);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function optionalInt(value, min, max) {
  if (value === undefined || value === null || value === "") return 0;
  return clampInt(value, min, max, 0);
}

function publicServer(server, options = {}) {
  const cached = statusCache.get(server.id);
  const assets = assetCache.get(server.id);
  return {
    ...server,
    status: cached || createPendingStatus(server),
    assets: publicAssetStatus(assets || createPendingAssetStatus(), options.includeAssetDetails)
  };
}

function publicAssetStatus(assets, includeDetails) {
  const modelItems = assets.modelItems || [];
  const dockerImages = assets.dockerImages || [];
  const summary = {
    state: assets.state,
    updatedAt: assets.updatedAt,
    latencyMs: assets.latencyMs,
    paths: assets.paths,
    modelCount: assets.modelCount || modelItems.length,
    dockerCount: assets.dockerCount || dockerImages.length,
    searchText: assetSearchText(modelItems, dockerImages),
    error: assets.error || null
  };
  if (includeDetails) {
    summary.modelItems = modelItems;
    summary.dockerImages = dockerImages;
  } else {
    summary.modelItems = [];
    summary.dockerImages = [];
  }
  return summary;
}

function assetSearchText(modelItems, dockerImages) {
  return [
    ...modelItems.flatMap((item) => [item.name, item.path, item.root]),
    ...dockerImages.flatMap((image) => [image.repository, image.tag, image.imageId])
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 12000);
}

function createPendingAssetStatus() {
  return {
    state: "pending",
    updatedAt: null,
    latencyMs: null,
    paths: ASSET_PATHS,
    modelCount: 0,
    dockerCount: 0,
    modelItems: [],
    dockerImages: [],
    error: null
  };
}

function createPendingStatus(server) {
  const totalCount = server.gpuCount || 0;
  const gpus = applySavedModels(
    Array.from({ length: totalCount }, (_, index) => ({
      index,
      state: "unknown",
      utilization: null,
      memoryUtilization: null,
      memoryUsedMiB: null,
      memoryTotalMiB: null,
      temperatureC: null,
      powerW: null,
      raw: ""
    })),
    server
  );
  return {
    state: "pending",
    summary: "等待刷新",
    updatedAt: null,
    latencyMs: null,
    busyCount: 0,
    freeCount: totalCount,
    totalCount,
    models: server.models && server.models.length ? server.models : collectModels(gpus),
    gpus,
    error: null
  };
}

async function refreshAll(options = {}) {
  const includeModels = Boolean(options.includeModels);
  if (refreshInFlight) {
    if (!includeModels || refreshInFlightIncludesModels) return refreshInFlight;
    await refreshInFlight;
  }
  const servers = loadServers();
  refreshInFlightIncludesModels = includeModels;
  refreshInFlight = mapWithConcurrency(servers, REFRESH_CONCURRENCY, (server) => refreshServer(server, { includeModels }))
    .then((results) => {
      lastRefresh = new Date().toISOString();
      return results;
    })
    .finally(() => {
      refreshInFlight = null;
      refreshInFlightIncludesModels = false;
    });
  return refreshInFlight;
}

async function refreshAssetsAll() {
  if (assetRefreshInFlight) return assetRefreshInFlight;
  const servers = loadServers();
  assetRefreshInFlight = mapWithConcurrency(servers, ASSET_CONCURRENCY, refreshServerAssets)
    .then((results) => {
      lastAssetRefresh = new Date().toISOString();
      return results;
    })
    .finally(() => {
      assetRefreshInFlight = null;
    });
  return assetRefreshInFlight;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
}

async function refreshServer(server, options = {}) {
  const includeModels = Boolean(options.includeModels);
  const started = Date.now();
  try {
    const output = await runProbeCommand(server);
    const parsed = parseProbeOutput(output.stdout, server.gpuCount, server.command);
    let gpus = applySavedModels(parsed.gpus, server);
    let models = collectModels(gpus);
    if (includeModels) {
      try {
        const modelOutput = await runProbeCommand(server, buildModelCommand(server.command));
        const modelByIndex = parseModelOutput(modelOutput.stdout, server.command);
        gpus = mergeGpuModels(gpus, modelByIndex);
        models = collectModels(gpus);
      } catch (modelError) {
        console.warn(`Model detection failed for ${server.host}: ${modelError.message}`);
      }
    }
    const totalCount = Math.max(parsed.totalCount, gpus.length);
    const busyCount = gpus.filter((gpu) => gpu.state === "busy").length;
    const latencyMs = Date.now() - started;
    const status = {
      state: "online",
      summary: parsed.busyCount > 0 ? `${parsed.busyCount}/${parsed.totalCount} 占用` : "全部空闲",
      updatedAt: new Date().toISOString(),
      latencyMs,
      busyCount,
      freeCount: Math.max(totalCount - busyCount, 0),
      totalCount,
      models,
      gpus,
      error: null
    };
    if (busyCount > 0) {
      status.summary = `${busyCount}/${totalCount} 占用`;
    }
    statusCache.set(server.id, status);
    if (server.gpuCount !== totalCount || includeModels) {
      persistDetectedServerInfo(server.id, {
        gpuCount: totalCount,
        models: includeModels ? models : undefined,
        gpuModels: includeModels ? extractGpuModels(gpus) : undefined
      });
    }
    return { id: server.id, ok: true };
  } catch (error) {
    const pending = createPendingStatus(server);
    const status = {
      state: "offline",
      summary: "连接失败",
      updatedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      busyCount: 0,
      freeCount: 0,
      totalCount: server.gpuCount,
      models: pending.models,
      gpus: pending.gpus,
      error: error.message
    };
    statusCache.set(server.id, status);
    return { id: server.id, ok: false, error: error.message };
  }
}

async function refreshServerAssets(server) {
  const started = Date.now();
  try {
    const output = await runProbeCommand(server, buildAssetCommand(), ASSET_SSH_TIMEOUT_MS);
    const parsed = parseAssetOutput(output.stdout);
    const status = {
      state: "online",
      updatedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      paths: ASSET_PATHS,
      modelCount: parsed.modelItems.length,
      dockerCount: parsed.dockerImages.length,
      modelItems: parsed.modelItems,
      dockerImages: parsed.dockerImages,
      error: null
    };
    assetCache.set(server.id, status);
    return { id: server.id, ok: true };
  } catch (error) {
    const previous = assetCache.get(server.id) || createPendingAssetStatus();
    const status = {
      ...previous,
      state: "failed",
      updatedAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      paths: ASSET_PATHS,
      error: error.message
    };
    assetCache.set(server.id, status);
    return { id: server.id, ok: false, error: error.message };
  }
}

function runProbeCommand(server, remoteCommand = buildRemoteCommand(server.command), timeoutMs = SSH_TIMEOUT_MS) {
  const target = server.user ? `${server.user}@${server.host}` : server.host;
  const sshPath = process.env.SSH_PATH || (process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "ssh");
  const args = [
    "-p",
    String(server.port),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    target,
    remoteCommand
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(sshPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`SSH 超时 (${Math.ceil(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 ssh: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(cleanError(stderr || stdout || `ssh exit ${code}`)));
      }
    });
  });
}

function normalizeCommand(command) {
  const value = String(command || "hy-smi").trim();
  return value === "nvidia-smi" ? "nvidia-smi" : "hy-smi";
}

function buildRemoteCommand(command) {
  if (command === "nvidia-smi") {
    return [
      "nvidia-smi",
      "--query-gpu=index,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw",
      "--format=csv,noheader,nounits"
    ].join(" ");
  }
  return buildHySmiCommand("");
}

function buildModelCommand(command) {
  if (command === "nvidia-smi") {
    return [
      "nvidia-smi",
      "--query-gpu=index,name",
      "--format=csv,noheader,nounits"
    ].join(" ");
  }
  return buildHySmiCommand("--showproductname");
}

function buildAssetCommand() {
  const paths = ASSET_PATHS.length ? ASSET_PATHS : ["/models", "/public", "/data"];
  const pathList = paths.map(shellQuote).join(" ");
  const perPathLimit = Math.max(20, Math.ceil(ASSET_MAX_ITEMS / paths.length));
  const modelFilePattern = [
    "-iname '*.gguf'",
    "-o -iname '*.safetensors'",
    "-o -iname 'pytorch_model*.bin'",
    "-o -iname 'model*.bin'",
    "-o -iname '*.onnx'",
    "-o -iname '*.pt'",
    "-o -iname '*.pth'",
    "-o -iname '*.ckpt'",
    "-o -iname 'config.json'",
    "-o -iname 'tokenizer.json'",
    "-o -iname 'tokenizer.model'",
    "-o -iname 'generation_config.json'"
  ].join(" ");
  const modelNamePattern = "'*qwen*' -o -iname '*deepseek*' -o -iname '*llama*' -o -iname '*chatglm*' -o -iname '*glm*' -o -iname '*baichuan*' -o -iname '*internlm*' -o -iname '*mistral*' -o -iname '*mixtral*' -o -iname '*bert*' -o -iname '*clip*' -o -iname '*whisper*' -o -iname '*stable-diffusion*' -o -iname '*sdxl*'";
  const modelCommand = [
    `for p in ${pathList}; do`,
    `if [ -d "$p" ]; then`,
    `{`,
    `find "$p" -mindepth 1 -maxdepth 2 -type d ! -name '.*' ! -name '__pycache__' | while IFS= read -r d; do`,
    `if find "$d" -maxdepth 1 -type f \\( ${modelFilePattern} \\) -print -quit 2>/dev/null | grep -q . || find "$d" -maxdepth 0 \\( -iname ${modelNamePattern} \\) -print -quit 2>/dev/null | grep -q .; then`,
    `mt=$(date -r "$d" '+%Y-%m-%d %H:%M' 2>/dev/null || echo ''); printf 'MODEL\\t%s\\td\\t%s\\n' "$d" "$mt";`,
    `fi;`,
    `done;`,
    `find "$p" -mindepth 1 -maxdepth 1 -type f \\( ${modelFilePattern} \\) -printf 'MODEL\\t%p\\tf\\t%TY-%Tm-%Td %TH:%TM\\n' 2>/dev/null;`,
    `} | head -n ${perPathLimit};`,
    `fi;`,
    `done | head -n ${ASSET_MAX_ITEMS}`
  ].join(" ");
  const dockerCommand = [
    "docker images",
    "--format 'DOCKER\\t{{.Repository}}\\t{{.Tag}}\\t{{.ID}}\\t{{.Size}}\\t{{.CreatedSince}}'",
    `2>/dev/null | head -n ${ASSET_MAX_ITEMS}`
  ].join(" ");
  return [
    "printf '__GPU_MONITOR_MODELS__\\n';",
    modelCommand,
    "; printf '__GPU_MONITOR_DOCKER__\\n';",
    dockerCommand,
    "|| true"
  ].join(" ");
}

function buildHySmiCommand(args) {
  const command = ["hy-smi", args].filter(Boolean).join(" ");
  return `(${command} 2>/dev/null || bash -ilc ${shellQuote(command)})`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function persistDetectedServerInfo(serverId, detected) {
  const servers = loadServers();
  const index = servers.findIndex((server) => server.id === serverId);
  if (index === -1) return;
  const next = { ...servers[index] };
  let changed = false;

  if (detected.gpuCount && next.gpuCount !== detected.gpuCount) {
    next.gpuCount = detected.gpuCount;
    changed = true;
  }
  if (Array.isArray(detected.models)) {
    next.models = detected.models;
    changed = true;
  }
  if (Array.isArray(detected.gpuModels)) {
    next.gpuModels = detected.gpuModels;
    changed = true;
  }

  if (!changed) return;
  servers[index] = next;
  saveServers(servers);
}

function cleanError(message) {
  return String(message)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ")
    .slice(0, 240);
}

function parseProbeOutput(output, expectedCount, command) {
  if (command === "nvidia-smi") {
    return parseNvidiaSmi(output, expectedCount);
  }
  return parseHySmi(output, expectedCount);
}

function parseNvidiaSmi(output, expectedCount) {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const byIndex = new Map();

  for (const line of lines) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 7) continue;
    const index = Number.parseInt(parts[0], 10);
    if (!Number.isFinite(index)) continue;
    const gpu = createGpu(index);
    gpu.utilization = parseNullableNumber(parts[1]);
    gpu.memoryUtilization = parseNullableNumber(parts[2]);
    gpu.memoryUsedMiB = parseNullableNumber(parts[3]);
    gpu.memoryTotalMiB = parseNullableNumber(parts[4]);
    gpu.temperatureC = parseNullableNumber(parts[5]);
    gpu.powerW = parseNullableNumber(parts[6]);
    gpu.raw = line.slice(0, 280);
    if (gpu.memoryUtilization === null && gpu.memoryTotalMiB) {
      gpu.memoryUtilization = Math.round(((gpu.memoryUsedMiB || 0) / gpu.memoryTotalMiB) * 1000) / 10;
    }
    byIndex.set(index, gpu);
  }

  return finalizeParsedGpus(byIndex, expectedCount);
}

function parseHySmiWithProduct(output, expectedCount) {
  const [metricsOutput, productOutput = ""] = String(output || "").split("__GPU_MONITOR_PRODUCT__");
  const parsed = parseHySmi(metricsOutput, expectedCount);
  const productByIndex = parseHyProductNames(productOutput);
  if (productByIndex.size === 0) return parsed;

  const gpus = parsed.gpus.map((gpu) => ({
    ...gpu,
    ...(productByIndex.get(gpu.index) || {})
  }));
  return {
    ...parsed,
    models: collectModels(gpus),
    gpus
  };
}

function parseModelOutput(output, command) {
  if (command === "nvidia-smi") {
    return parseNvidiaModels(output);
  }
  return parseHyProductNames(output);
}

function parseAssetOutput(output) {
  const modelItems = [];
  const dockerImages = [];
  let section = "";
  const lines = String(output || "").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "__GPU_MONITOR_MODELS__") {
      section = "models";
      continue;
    }
    if (line === "__GPU_MONITOR_DOCKER__") {
      section = "docker";
      continue;
    }
    if (section === "models" && line.startsWith("MODEL\t")) {
      const parts = line.split("\t");
      const filePath = parts[1] || "";
      const type = parts[2] === "f" ? "file" : "dir";
      const modifiedAt = parts[3] || "";
      const name = path.posix.basename(filePath.replace(/\\/g, "/"));
      if (filePath && name) {
        modelItems.push({
          name: normalizeAssetName(name),
          path: filePath,
          root: assetRoot(filePath),
          type,
          modifiedAt
        });
      }
      continue;
    }
    if (section === "docker" && line.startsWith("DOCKER\t")) {
      const parts = line.split("\t");
      const repository = normalizeAssetName(parts[1]);
      if (!repository || repository === "<none>") continue;
      dockerImages.push({
        repository,
        tag: normalizeAssetName(parts[2]) || "<none>",
        imageId: normalizeAssetName(parts[3]),
        size: normalizeAssetName(parts[4]),
        created: normalizeAssetName(parts.slice(5).join(" "))
      });
    }
  }

  return {
    modelItems: dedupeBy(modelItems, (item) => `${item.path}:${item.type}`).slice(0, ASSET_MAX_ITEMS),
    dockerImages: dedupeBy(dockerImages, (item) => `${item.repository}:${item.tag}:${item.imageId}`).slice(0, ASSET_MAX_ITEMS)
  };
}

function normalizeAssetName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function assetRoot(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const root = ASSET_PATHS.find((assetPath) => normalized === assetPath || normalized.startsWith(`${assetPath}/`));
  return root || normalized.split("/").slice(0, 2).join("/") || "/";
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function searchAssetInventory(options) {
  const query = String(options.query || "").trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 8);
  const type = options.type === "model" || options.type === "docker" ? options.type : "all";
  const stateFilter = ["free", "busy", "offline", "pending"].includes(options.state) ? options.state : "all";
  const groupFilter = String(options.group || "all").trim();
  const results = [];
  let totalMatches = 0;

  if (!terms.length) {
    return { query, type, state: stateFilter, group: groupFilter, totalMatches: 0, results: [] };
  }

  for (const server of loadServers()) {
    const status = statusCache.get(server.id) || createPendingStatus(server);
    const serverState = serverKindFromStatus(status);
    const group = normalizeGroup(server.group);
    if (groupFilter !== "all" && group !== groupFilter) continue;
    if (stateFilter !== "all" && serverState !== stateFilter) continue;

    const assets = assetCache.get(server.id) || createPendingAssetStatus();
    const matches = [];
    if (type === "all" || type === "model") {
      for (const item of assets.modelItems || []) {
        const text = [item.name, item.path, item.root, item.type].filter(Boolean).join(" ").toLowerCase();
        if (matchesTerms(text, terms)) {
          matches.push({
            type: "model",
            label: item.name,
            value: item.path,
            meta: `${item.root || "-"} · ${item.type === "file" ? "文件" : "目录"}`,
            copyText: item.path
          });
        }
      }
    }
    if (type === "all" || type === "docker") {
      for (const image of assets.dockerImages || []) {
        const imageName = `${image.repository || ""}:${image.tag || ""}`;
        const text = [imageName, image.imageId, image.size, image.created].filter(Boolean).join(" ").toLowerCase();
        if (matchesTerms(text, terms)) {
          matches.push({
            type: "docker",
            label: imageName,
            value: image.imageId || "",
            meta: [image.size, image.created].filter(Boolean).join(" · "),
            copyText: imageName
          });
        }
      }
    }

    if (!matches.length) continue;
    totalMatches += matches.length;
    results.push({
      server: {
        id: server.id,
        name: server.name,
        host: server.host,
        user: server.user,
        port: server.port,
        group,
        state: serverState,
        summary: status.summary,
        busyCount: status.busyCount || 0,
        totalCount: status.totalCount || server.gpuCount || 0,
        models: status.models || server.models || []
      },
      assets: {
        updatedAt: assets.updatedAt,
        modelCount: assets.modelCount || 0,
        dockerCount: assets.dockerCount || 0,
        state: assets.state,
        error: assets.error || null
      },
      matches: matches.slice(0, 20)
    });
    if (totalMatches >= ASSET_SEARCH_MAX_RESULTS) break;
  }

  return {
    query,
    type,
    state: stateFilter,
    group: groupFilter,
    totalMatches,
    results: results.slice(0, 80)
  };
}

function matchesTerms(text, terms) {
  return terms.every((term) => text.includes(term));
}

function serverKindFromStatus(status) {
  if (status.state === "offline") return "offline";
  if (status.state === "pending") return "pending";
  return (status.busyCount || 0) > 0 ? "busy" : "free";
}

function parseNvidiaModels(output) {
  const byIndex = new Map();
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 2) continue;
    const index = Number.parseInt(parts[0], 10);
    const model = normalizeModelName(parts.slice(1).join(", "));
    if (Number.isFinite(index) && model) {
      byIndex.set(index, { model });
    }
  }

  return byIndex;
}

function parseHyProductNames(output) {
  const byIndex = new Map();
  const lines = String(output || "").split(/\r?\n/);

  for (const line of lines) {
    const series = line.match(/\b(?:HCU|DCU|GPU)\[(\d{1,2})\].*?\bCard\s+Series\s*:\s*(.+)$/i);
    if (series) {
      const index = Number.parseInt(series[1], 10);
      const existing = byIndex.get(index) || {};
      byIndex.set(index, { ...existing, model: normalizeModelName(series[2]) });
      continue;
    }

    const vendor = line.match(/\b(?:HCU|DCU|GPU)\[(\d{1,2})\].*?\bCard\s+Vendor\s*:\s*(.+)$/i);
    if (vendor) {
      const index = Number.parseInt(vendor[1], 10);
      const existing = byIndex.get(index) || {};
      byIndex.set(index, { ...existing, vendor: normalizeModelName(vendor[2]) });
    }
  }

  return byIndex;
}

function parseHySmi(output, expectedCount) {
  const lines = String(output || "").split(/\r?\n/);
  const byIndex = new Map();

  for (const line of lines) {
    const index = getGpuIndex(line);
    if (index === null || index < 0 || index > 31) continue;
    const existing = byIndex.get(index) || createGpu(index);
    const next = parseGpuLine(line, existing);
    byIndex.set(index, next);
  }

  if (byIndex.size === 0) {
    const metricLines = lines.filter((line) => /^\s*\d{1,2}\s+/.test(line) && /%|MiB|GiB|W|C/i.test(line));
    metricLines.slice(0, expectedCount).forEach((line, index) => {
      byIndex.set(index, parseGpuLine(line, createGpu(index)));
    });
  }

  return finalizeParsedGpus(byIndex, expectedCount);
}

function finalizeParsedGpus(byIndex, expectedCount) {
  const detectedCount = byIndex.size ? Math.max(...byIndex.keys()) + 1 : 0;
  const totalCount = Math.max(expectedCount || 0, detectedCount);
  const gpus = Array.from({ length: totalCount }, (_, index) => {
    const parsed = byIndex.get(index) || createGpu(index);
    const busy = isGpuBusy(parsed);
    return {
      ...parsed,
      state: busy ? "busy" : parsed.utilization === null && parsed.memoryUsedMiB === null ? "unknown" : "free"
    };
  });

  return {
    totalCount,
    busyCount: gpus.filter((gpu) => gpu.state === "busy").length,
    models: collectModels(gpus),
    gpus
  };
}

function createGpu(index) {
  return {
    index,
    state: "unknown",
    utilization: null,
    memoryUtilization: null,
    memoryUsedMiB: null,
    memoryTotalMiB: null,
    temperatureC: null,
    powerW: null,
    model: null,
    vendor: null,
    raw: ""
  };
}

function getGpuIndex(line) {
  const patterns = [
    /^\s*\|\s*(\d{1,2})\s+[^|]+?\|/,
    /^\s*(\d{1,2})\s+\d+(?:\.\d+)?C\s+/i,
    /^\s*(\d{1,2})\s+(?:DCU|GPU|card)/i,
    /\b(?:DCU|GPU|card)\s*[:#-]?\s*(\d{1,2})\b/i
  ];
  for (const pattern of patterns) {
    const match = String(line).match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return null;
}

function parseGpuLine(line, gpu) {
  const next = { ...gpu, raw: [gpu.raw, line.trim()].filter(Boolean).join(" | ").slice(0, 280) };
  const percentages = [...String(line).matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
    .map((match) => Number.parseFloat(match[1]))
    .filter((value) => value >= 0 && value <= 100);
  if (percentages.length) {
    next.utilization = percentages[percentages.length - 1];
  }

  if (/^\s*\d{1,2}\s+\d+(?:\.\d+)?C\s+/i.test(line) && percentages.length >= 2) {
    next.memoryUtilization = percentages[0];
    next.utilization = percentages[1];
  }

  const temp = String(line).match(/(\d+(?:\.\d+)?)\s*C\b/i);
  if (temp) next.temperatureC = Number.parseFloat(temp[1]);

  const power = String(line).match(/(\d+(?:\.\d+)?)\s*W\b/i);
  if (power) next.powerW = Number.parseFloat(power[1]);

  const memory = String(line).match(/(\d+(?:\.\d+)?)\s*(MiB|GiB|MB|GB)\s*\/\s*(\d+(?:\.\d+)?)\s*(MiB|GiB|MB|GB)/i);
  if (memory) {
    next.memoryUsedMiB = toMiB(Number.parseFloat(memory[1]), memory[2]);
    next.memoryTotalMiB = toMiB(Number.parseFloat(memory[3]), memory[4]);
  }

  return next;
}

function toMiB(value, unit) {
  return /g/i.test(unit) ? Math.round(value * 1024) : Math.round(value);
}

function parseNullableNumber(value) {
  const normalized = String(value || "").replace(/[^\d.-]/g, "");
  if (!normalized || normalized.toLowerCase() === "nan") return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeModelName(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[-:]+|[-:]+$/g, "")
    .trim();
  if (!text || /^N\/A$/i.test(text) || /^unknown$/i.test(text)) return null;
  return text;
}

function collectModels(gpus) {
  const models = [];
  for (const gpu of gpus) {
    if (gpu.model && !models.includes(gpu.model)) models.push(gpu.model);
  }
  return models;
}

function applySavedModels(gpus, server) {
  const savedByIndex = new Map((server.gpuModels || []).map((gpu) => [gpu.index, gpu]));
  const fallbackModel = (server.models || []).length === 1 ? server.models[0] : null;
  return gpus.map((gpu) => {
    const saved = savedByIndex.get(gpu.index) || {};
    return {
      ...gpu,
      model: gpu.model || saved.model || fallbackModel || null,
      vendor: gpu.vendor || saved.vendor || null
    };
  });
}

function mergeGpuModels(gpus, modelByIndex) {
  const detectedCount = modelByIndex.size ? Math.max(...modelByIndex.keys()) + 1 : 0;
  const totalCount = Math.max(gpus.length, detectedCount);
  return Array.from({ length: totalCount }, (_, index) => gpus[index] || createGpu(index)).map((gpu) => {
    const detected = modelByIndex.get(gpu.index) || {};
    return {
      ...gpu,
      model: detected.model || gpu.model || null,
      vendor: detected.vendor || gpu.vendor || null
    };
  });
}

function extractGpuModels(gpus) {
  return gpus
    .map((gpu) => ({
      index: gpu.index,
      model: gpu.model || null,
      vendor: gpu.vendor || null
    }))
    .filter((gpu) => gpu.model || gpu.vendor);
}

function isGpuBusy(gpu) {
  const utilBusy = typeof gpu.utilization === "number" && gpu.utilization >= 10;
  const memoryPercentBusy = typeof gpu.memoryUtilization === "number" && gpu.memoryUtilization >= 10;
  const memBusy = typeof gpu.memoryUsedMiB === "number" && gpu.memoryUsedMiB >= 512;
  return utilBusy || memoryPercentBusy || memBusy;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON 格式无效"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/site-config") {
    sendJson(res, 200, loadSiteConfig());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/servers") {
    const includeAssetDetails = url.searchParams.get("assetDetails") === "1";
    const servers = loadServers().map((server) => publicServer(server, { includeAssetDetails }));
    sendJson(res, 200, {
      servers,
      lastRefresh,
      lastAssetRefresh,
      pollIntervalMs: POLL_INTERVAL_MS,
      refreshing: Boolean(refreshInFlight),
      assetRefreshing: Boolean(assetRefreshInFlight),
      assetRefreshIntervalMs: ASSET_REFRESH_INTERVAL_MS,
      assetPaths: ASSET_PATHS
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/assets/search") {
    sendJson(res, 200, searchAssetInventory({
      query: url.searchParams.get("q") || "",
      type: url.searchParams.get("type") || "all",
      state: url.searchParams.get("state") || "all",
      group: url.searchParams.get("group") || "all"
    }));
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "servers" && parts[2] && parts[3] === "assets") {
    const servers = loadServers();
    const server = servers.find((item) => item.id === parts[2]);
    if (!server) {
      sendJson(res, 404, { error: "服务器不存在" });
      return;
    }
    sendJson(res, 200, {
      assets: publicAssetStatus(assetCache.get(server.id) || createPendingAssetStatus(), true)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/servers") {
    try {
      const body = await readJson(req);
      const server = normalizeServer(body);
      if (!server) {
        sendJson(res, 400, { error: "服务器地址不能为空" });
        return;
      }
      const servers = loadServers();
      servers.push(server);
      saveServers(servers);
      refreshServer(server, { includeModels: true }).catch((error) => console.error(error));
      sendJson(res, 201, { server: publicServer(server) });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "PATCH" && parts[0] === "api" && parts[1] === "servers" && parts[2]) {
    try {
      const body = await readJson(req);
      const servers = loadServers();
      const index = servers.findIndex((server) => server.id === parts[2]);
      if (index === -1) {
        sendJson(res, 404, { error: "服务器不存在" });
        return;
      }
      const updated = normalizeServer({ ...servers[index], ...body, id: servers[index].id });
      if (!updated) {
        sendJson(res, 400, { error: "服务器地址不能为空" });
        return;
      }
      servers[index] = updated;
      saveServers(servers);
      refreshServer(updated, { includeModels: true }).catch((error) => console.error(error));
      sendJson(res, 200, { server: publicServer(updated) });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "servers" && parts[2]) {
    const servers = loadServers();
    const nextServers = servers.filter((server) => server.id !== parts[2]);
    if (nextServers.length === servers.length) {
      sendJson(res, 404, { error: "服务器不存在" });
      return;
    }
    saveServers(nextServers);
    statusCache.delete(parts[2]);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/refresh") {
    const result = await refreshAll({ includeModels: true });
    sendJson(res, 200, { ok: true, result, lastRefresh });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/assets/refresh") {
    const result = await refreshAssetsAll();
    sendJson(res, 200, { ok: true, result, lastAssetRefresh });
    return;
  }

  sendJson(res, 404, { error: "API 不存在" });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch((error) => {
      console.error(error);
      sendJson(res, 500, { error: error.message });
    });
    return;
  }
  serveStatic(req, res);
});

ensureDataFile();
backupServerConfig("startup");
refreshAll().catch((error) => console.error(error));
setTimeout(() => {
  refreshAssetsAll().catch((error) => console.error(error));
}, 2000);
setInterval(() => {
  refreshAll().catch((error) => console.error(error));
}, POLL_INTERVAL_MS);
setInterval(() => {
  backupServerConfig("scheduled");
}, BACKUP_INTERVAL_MS);
setInterval(() => {
  refreshAssetsAll().catch((error) => console.error(error));
}, ASSET_REFRESH_INTERVAL_MS);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GPU/DCU monitor is running at http://localhost:${PORT}`);
});
