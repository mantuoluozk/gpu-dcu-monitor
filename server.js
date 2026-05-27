const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3066);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 10000);
const SSH_TIMEOUT_MS = Number(process.env.SSH_TIMEOUT_MS || 8000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "servers.json");
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
let lastRefresh = null;
let refreshInFlight = null;
let refreshInFlightIncludesModels = false;

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
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
    id: String(input.id || randomUUID()),
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

function publicServer(server) {
  const cached = statusCache.get(server.id);
  return {
    ...server,
    status: cached || createPendingStatus(server)
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
  refreshInFlight = Promise.all(servers.map((server) => refreshServer(server, { includeModels })))
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

function runProbeCommand(server, remoteCommand = buildRemoteCommand(server.command)) {
  const target = server.user ? `${server.user}@${server.host}` : server.host;
  const sshPath = process.env.SSH_PATH || (process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "ssh");
  const args = [
    "-p",
    String(server.port),
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.ceil(SSH_TIMEOUT_MS / 1000)}`,
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
      reject(new Error(`SSH 超时 (${Math.ceil(SSH_TIMEOUT_MS / 1000)}s)`));
    }, SSH_TIMEOUT_MS);

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
  return "hy-smi";
}

function buildModelCommand(command) {
  if (command === "nvidia-smi") {
    return [
      "nvidia-smi",
      "--query-gpu=index,name",
      "--format=csv,noheader,nounits"
    ].join(" ");
  }
  return "hy-smi --showproductname";
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

  if (req.method === "GET" && url.pathname === "/api/servers") {
    const servers = loadServers().map(publicServer);
    sendJson(res, 200, {
      servers,
      lastRefresh,
      pollIntervalMs: POLL_INTERVAL_MS,
      refreshing: Boolean(refreshInFlight)
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
refreshAll().catch((error) => console.error(error));
setInterval(() => {
  refreshAll().catch((error) => console.error(error));
}, POLL_INTERVAL_MS);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GPU/DCU monitor is running at http://localhost:${PORT}`);
});
