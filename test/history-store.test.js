const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { HistoryStore } = require("../history-store");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-history-test-"));
try {
  const store = new HistoryStore({ root, bucketMs: 60000, fineDays: 90, maxRangeDays: 366 });
  const server = { id: "server-a", name: "测试机器", host: "127.0.0.1", command: "nvidia-smi" };
  const online = {
    state: "online",
    system: { cpuUtilization: 20 },
    gpus: [
      { index: 0, utilization: 20, memoryUtilization: 30, memoryUsedMiB: 1024, memoryTotalMiB: 8192, temperatureC: 60, powerW: 120 },
      { index: 1, utilization: 40, memoryUtilization: 50, memoryUsedMiB: 2048, memoryTotalMiB: 8192, temperatureC: 70, powerW: 140 }
    ]
  };
  const base = new Date("2026-01-01T00:00:10.000Z");
  store.record(server, online, base);
  store.record(server, { ...online, system: { cpuUtilization: 40 } }, new Date(base.getTime() + 10000));
  store.record(server, { state: "offline", gpus: [] }, new Date(base.getTime() + 60000));
  store.flushAll();

  const result = store.query(server.id, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T00:02:00.000Z" });
  assert.strictEqual(result.summary.totalPoints, 2);
  assert.strictEqual(result.summary.onlinePoints, 1);
  assert.strictEqual(result.summary.busyMinutes, 1);
  assert.strictEqual(result.summary.utilizationAvg, 30);
  assert.strictEqual(result.summary.cpuUtilizationAvg, 30);
  assert.strictEqual(result.summary.cpuUtilizationMax, 40);
  assert.strictEqual(result.points[0].cpuUtilization, 30);
  assert.strictEqual(result.points[1].state, "offline");
  assert.strictEqual(result.points[1].cpuUtilization, null);
  const csv = store.exportCsv(server, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T00:02:00.000Z" });
  assert(csv.includes("测试机器"));
  assert(csv.includes("device_index"));
  assert(csv.includes("cpu_utilization_avg"));

  const compacted = store.compact(new Date("2026-07-01T00:00:00.000Z"));
  assert.strictEqual(compacted.files, 1);
  assert(fs.existsSync(store.fiveMinuteFile(server.id, "2026-01-01")));
  assert(!fs.existsSync(store.minuteFile(server.id, "2026-01-01")));
  const afterCompact = store.query(server.id, { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T00:02:00.000Z" });
  assert.strictEqual(afterCompact.summary.busyMinutes, 1);
  assert.strictEqual(afterCompact.summary.cpuUtilizationAvg, 30);
  assert.strictEqual(afterCompact.points[0].cpuUtilization, 30);
  console.log("history-store tests passed");
} finally {
  fs.rmdirSync(root, { recursive: true });
}
