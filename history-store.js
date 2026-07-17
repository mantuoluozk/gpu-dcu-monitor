const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DAY_MS = 24 * 60 * 60 * 1000;

class HistoryStore {
  constructor(options) {
    this.root = options.root;
    this.bucketMs = options.bucketMs || 60000;
    this.fineDays = options.fineDays || 90;
    this.maxRangeDays = options.maxRangeDays || 366;
    this.pending = new Map();
    fs.mkdirSync(this.root, { recursive: true });
  }

  record(server, status, now) {
    const timestamp = now instanceof Date ? now.getTime() : Date.now();
    const bucket = Math.floor(timestamp / this.bucketMs) * this.bucketMs;
    const existing = this.pending.get(server.id);
    if (existing && existing.t !== bucket) this.flush(server.id);
    const current = this.pending.get(server.id) || createBucket(server, bucket);
    addSample(current, status);
    this.pending.set(server.id, current);
  }

  flush(serverId) {
    const bucket = this.pending.get(serverId);
    if (!bucket) return null;
    const record = finalizeBucket(bucket);
    const file = this.minuteFile(serverId, record.t.slice(0, 10));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    this.pending.delete(serverId);
    return record;
  }

  flushAll() {
    for (const serverId of Array.from(this.pending.keys())) this.flush(serverId);
  }

  minuteFile(serverId, date) {
    return path.join(this.root, safeId(serverId), "minute", `${date}.ndjson`);
  }

  fiveMinuteFile(serverId, date) {
    return path.join(this.root, safeId(serverId), "five-minute", `${date}.ndjson.gz`);
  }

  compact(now) {
    const cutoff = startUtcDay(new Date((now || new Date()).getTime() - this.fineDays * DAY_MS));
    if (!fs.existsSync(this.root)) return { files: 0, records: 0 };
    let files = 0;
    let records = 0;
    for (const serverDir of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!serverDir.isDirectory()) continue;
      const minuteDir = path.join(this.root, serverDir.name, "minute");
      if (!fs.existsSync(minuteDir)) continue;
      for (const name of fs.readdirSync(minuteDir)) {
        const match = name.match(/^(\d{4}-\d{2}-\d{2})\.ndjson$/);
        if (!match || new Date(`${match[1]}T00:00:00.000Z`) >= cutoff) continue;
        const source = path.join(minuteDir, name);
        const rows = parseLines(fs.readFileSync(source, "utf8"));
        const compacted = aggregateRows(rows, 5 * 60 * 1000);
        const target = path.join(this.root, serverDir.name, "five-minute", `${match[1]}.ndjson.gz`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temporary = `${target}.tmp`;
        fs.writeFileSync(temporary, zlib.gzipSync(compacted.map((row) => JSON.stringify(row)).join("\n") + "\n"));
        fs.renameSync(temporary, target);
        fs.unlinkSync(source);
        files += 1;
        records += compacted.length;
      }
    }
    return { files, records };
  }

  query(serverId, options) {
    const range = normalizeRange(options, this.maxRangeDays);
    const rows = this.readRange(serverId, range.from, range.to);
    const summary = summarize(rows);
    const device = options.device === undefined || options.device === null || options.device === "" ? null : Number(options.device);
    const points = buildPoints(rows, device, 1200);
    return { from: range.from.toISOString(), to: range.to.toISOString(), device, summary, points, resolution: pointsResolution(rows, points), warnings: [] };
  }

  readRange(serverId, from, to) {
    const rows = [];
    for (const date of dateKeys(from, to)) {
      const minute = this.minuteFile(serverId, date);
      const five = this.fiveMinuteFile(serverId, date);
      try {
        if (fs.existsSync(minute)) rows.push(...parseLines(fs.readFileSync(minute, "utf8")));
        else if (fs.existsSync(five)) rows.push(...parseLines(zlib.gunzipSync(fs.readFileSync(five)).toString("utf8")));
      } catch (error) {
        console.warn(`History read failed for ${serverId}/${date}: ${error.message}`);
      }
    }
    const start = from.getTime();
    const end = to.getTime();
    return rows.filter((row) => {
      const time = new Date(row.t).getTime();
      return time >= start && time <= end;
    }).sort((a, b) => new Date(a.t) - new Date(b.t));
  }

  exportCsv(server, options) {
    const range = normalizeRange(options, this.maxRangeDays);
    const rows = this.readRange(server.id, range.from, range.to);
    const lines = ["timestamp,server_id,server_name,host,state,sample_count,cpu_utilization_avg,cpu_utilization_max,device_index,device_sample_count,utilization_avg,utilization_max,memory_utilization_avg,memory_utilization_max,memory_used_mib_avg,memory_total_mib,temperature_c_avg,temperature_c_max,power_w_avg,power_w_max,busy"];
    for (const row of rows) {
      const cpu = Array.isArray(row.c) ? row.c : [null, null];
      if (!row.d.length) lines.push(csvLine([row.t, server.id, server.name, server.host, row.s, row.n, cpu[0], cpu[1], "", "", "", "", "", "", "", "", "", "", "", "", row.b ? 1 : 0]));
      for (const device of row.d) {
        lines.push(csvLine([row.t, server.id, server.name, server.host, row.s, row.n, cpu[0], cpu[1], ...device, row.b ? 1 : 0]));
      }
    }
    return lines.join("\r\n") + "\r\n";
  }
}

function createBucket(server, timestamp) {
  return { t: timestamp, command: server.command, online: 0, offline: 0, cpuUtilization: createMetric(), devices: new Map() };
}

function addSample(bucket, status) {
  if (!status || status.state !== "online") {
    bucket.offline += 1;
    return;
  }
  bucket.online += 1;
  addMetric(bucket.cpuUtilization, status.system && status.system.cpuUtilization);
  for (const gpu of status.gpus || []) {
    const item = bucket.devices.get(gpu.index) || { index: gpu.index, count: 0, metrics: Array.from({ length: 6 }, createMetric) };
    item.count += 1;
    const values = [gpu.utilization, gpu.memoryUtilization, gpu.memoryUsedMiB, gpu.memoryTotalMiB, gpu.temperatureC, gpu.powerW];
    values.forEach((value, index) => addMetric(item.metrics[index], value));
    bucket.devices.set(gpu.index, item);
  }
}

function createMetric() { return { sum: 0, count: 0, max: null }; }
function addMetric(metric, value) {
  if (value === null || value === undefined || value === "") return;
  const number = Number(value);
  if (!Number.isFinite(number)) return;
  metric.sum += number;
  metric.count += 1;
  metric.max = metric.max === null ? number : Math.max(metric.max, number);
}
function avg(metric) { return metric.count ? round(metric.sum / metric.count) : null; }

function finalizeBucket(bucket) {
  const devices = Array.from(bucket.devices.values()).sort((a, b) => a.index - b.index).map((item) => {
    const m = item.metrics;
    return [item.index, item.count, avg(m[0]), roundOrNull(m[0].max), avg(m[1]), roundOrNull(m[1].max), avg(m[2]), avg(m[3]), avg(m[4]), roundOrNull(m[4].max), avg(m[5]), roundOrNull(m[5].max)];
  });
  const busy = devices.some((d) => (d[3] !== null && d[3] >= 10) || (d[5] !== null && d[5] >= 10) || (d[6] !== null && d[6] >= 512));
  return { t: new Date(bucket.t).toISOString(), s: bucket.online ? "online" : "offline", n: bucket.online + bucket.offline, o: bucket.online ? 1 : 0, b: busy ? 1 : 0, bm: busy ? 1 : 0, c: [avg(bucket.cpuUtilization), roundOrNull(bucket.cpuUtilization.max)], d: devices };
}

function aggregateRows(rows, bucketMs) {
  const groups = new Map();
  for (const row of rows) {
    const key = Math.floor(new Date(row.t).getTime() / bucketMs) * bucketMs;
    const group = groups.get(key) || { t: new Date(key).toISOString(), s: "offline", n: 0, o: 0, b: 0, bm: 0, c: createMetric(), d: new Map() };
    group.n += row.n || 0;
    if (row.s === "online") group.s = "online";
    group.o += row.o === undefined ? (row.s === "online" ? 1 : 0) : row.o;
    if (row.b) group.b = 1;
    group.bm += row.bm === undefined ? (row.b ? 1 : 0) : row.bm;
    if (Array.isArray(row.c)) {
      addMetric(group.c, row.c[0]);
      if (Number.isFinite(row.c[1])) group.c.max = group.c.max === null ? row.c[1] : Math.max(group.c.max, row.c[1]);
    }
    for (const d of row.d || []) {
      const item = group.d.get(d[0]) || { rows: 0, count: 0, values: Array(12).fill(null), sums: Array(12).fill(0) };
      item.rows += 1;
      item.count += d[1] || 0;
      [2, 4, 6, 7, 8, 10].forEach((index) => { if (Number.isFinite(d[index])) { item.sums[index] += d[index]; item.values[index] = (item.values[index] || 0) + 1; } });
      [3, 5, 9, 11].forEach((index) => { if (Number.isFinite(d[index])) item.values[index] = item.values[index] === null ? d[index] : Math.max(item.values[index], d[index]); });
      group.d.set(d[0], item);
    }
    groups.set(key, group);
  }
  return Array.from(groups.values()).map((group) => ({ ...group, c: [avg(group.c), roundOrNull(group.c.max)], d: Array.from(group.d.entries()).map(([index, item]) => [index, item.count, valueAvg(item, 2), item.values[3], valueAvg(item, 4), item.values[5], valueAvg(item, 6), valueAvg(item, 7), valueAvg(item, 8), item.values[9], valueAvg(item, 10), item.values[11]]) }));
}

function valueAvg(item, index) { return item.values[index] ? round(item.sums[index] / item.values[index]) : null; }

function summarize(rows) {
  const online = rows.filter((row) => row.s === "online");
  const busy = online.reduce((sum, row) => sum + (row.bm === undefined ? (row.b ? 1 : 0) : row.bm), 0);
  const onlineMinutes = online.reduce((sum, row) => sum + (row.o === undefined ? 1 : row.o), 0);
  const utilAvg = online.map(machineAverageUtil).filter(Number.isFinite);
  const utilMax = online.flatMap((row) => row.d.map((d) => d[3])).filter(Number.isFinite);
  const memoryAvg = online.map(machineAverageMemory).filter(Number.isFinite);
  const cpuAvg = online.map((row) => Array.isArray(row.c) ? row.c[0] : null).filter(Number.isFinite);
  const cpuMax = online.map((row) => Array.isArray(row.c) ? row.c[1] : null).filter(Number.isFinite);
  return {
    totalPoints: rows.length,
    onlinePoints: online.length,
    offlinePoints: rows.length - online.length,
    coveragePercent: rows.length ? round(online.length * 100 / rows.length) : null,
    busyMinutes: busy,
    busyPercent: onlineMinutes ? round(busy * 100 / onlineMinutes) : null,
    utilizationAvg: average(utilAvg),
    utilizationMax: utilMax.length ? Math.max(...utilMax) : null,
    memoryUtilizationAvg: average(memoryAvg),
    cpuUtilizationAvg: average(cpuAvg),
    cpuUtilizationMax: cpuMax.length ? Math.max(...cpuMax) : null
  };
}

function buildPoints(rows, device, maxPoints) {
  let points = rows.map((row) => pointFromRow(row, device));
  if (points.length <= maxPoints) return points;
  const size = Math.ceil(points.length / maxPoints);
  const reduced = [];
  for (let i = 0; i < points.length; i += size) reduced.push(mergePoints(points.slice(i, i + size)));
  return reduced;
}

function pointFromRow(row, device) {
  const devices = device === null ? row.d : row.d.filter((d) => d[0] === device);
  return { t: row.t, state: row.s, cpuUtilization: Array.isArray(row.c) ? row.c[0] : null, cpuUtilizationMax: Array.isArray(row.c) ? row.c[1] : null, utilization: average(devices.map((d) => d[2]).filter(Number.isFinite)), utilizationMax: maximum(devices.map((d) => d[3])), memoryUtilization: average(devices.map((d) => d[4]).filter(Number.isFinite)), temperatureC: average(devices.map((d) => d[8]).filter(Number.isFinite)), powerW: sumOrNull(devices.map((d) => d[10]).filter(Number.isFinite)), busy: row.b };
}

function mergePoints(points) {
  const online = points.filter((p) => p.state === "online");
  return { t: points[0].t, state: online.length ? "online" : "offline", cpuUtilization: average(online.map((p) => p.cpuUtilization).filter(Number.isFinite)), cpuUtilizationMax: maximum(online.map((p) => p.cpuUtilizationMax)), utilization: average(online.map((p) => p.utilization).filter(Number.isFinite)), utilizationMax: maximum(online.map((p) => p.utilizationMax)), memoryUtilization: average(online.map((p) => p.memoryUtilization).filter(Number.isFinite)), temperatureC: average(online.map((p) => p.temperatureC).filter(Number.isFinite)), powerW: average(online.map((p) => p.powerW).filter(Number.isFinite)), busy: online.some((p) => p.busy) ? 1 : 0 };
}

function machineAverageUtil(row) { return average(row.d.map((d) => d[2]).filter(Number.isFinite)); }
function machineAverageMemory(row) { return average(row.d.map((d) => d[4]).filter(Number.isFinite)); }
function average(values) { return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null; }
function maximum(values) { const valid = values.filter(Number.isFinite); return valid.length ? Math.max(...valid) : null; }
function sumOrNull(values) { return values.length ? round(values.reduce((a, b) => a + b, 0)) : null; }
function round(value) { return Math.round(value * 100) / 100; }
function roundOrNull(value) { return Number.isFinite(value) ? round(value) : null; }

function normalizeRange(options, maxDays) {
  const to = options.to ? new Date(options.to) : new Date();
  const from = options.from ? new Date(options.from) : new Date(to.getTime() - DAY_MS);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error("历史时间范围无效");
  if (to.getTime() - from.getTime() > maxDays * DAY_MS) throw new Error(`单次最多查询 ${maxDays} 天`);
  return { from, to };
}

function dateKeys(from, to) {
  const result = [];
  const current = startUtcDay(from);
  const end = startUtcDay(to);
  while (current <= end) { result.push(current.toISOString().slice(0, 10)); current.setUTCDate(current.getUTCDate() + 1); }
  return result;
}
function startUtcDay(date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); }
function parseLines(text) { return String(text || "").split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean); }
function safeId(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, "_"); }
function csvLine(values) { return values.map((value) => `"${String(value === null || value === undefined ? "" : value).replace(/"/g, '""')}"`).join(","); }
function pointsResolution(rows, points) { return rows.length > points.length ? "downsampled" : rows.some((row, index) => index && new Date(row.t) - new Date(rows[index - 1].t) >= 5 * 60 * 1000) ? "five-minute" : "minute"; }

module.exports = { HistoryStore, aggregateRows, finalizeBucket };
