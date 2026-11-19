// run.mjs — 多店「推广花费」采集调度器（普通 Node，不依赖 ego 运行时）
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const CFG_PATH = process.argv[2];
if (!CFG_PATH) { console.error("用法: node run.mjs <config.json>"); process.exit(2); }
const CFG = JSON.parse(await fs.readFile(CFG_PATH, "utf8"));

const HOME = os.homedir();
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF_WORKER = path.join(SELF_DIR, "worker-promo.mjs").replace(/\\/g, "/");

function findEgo() {
  const cands = [
    path.join(HOME, ".local", "share", "ego", "active_version_dir", "ego-browser.exe"),
    path.join(HOME, ".local", "bin", "ego-browser.exe"),
  ];
  for (const c of cands) if (existsSync(c)) return c;
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, "ego-browser" + e);
      if (existsSync(p)) return p;
    }
  }
  return "ego-browser";
}

const ROOT = String(CFG.root || process.env.PDD_BILLS_ROOT || "D:/对账账单").replace(/\\/g, "/").replace(/\/$/, "");
if (/^[A-Za-z]:/.test(ROOT) && ROOT.slice(0, 1).toUpperCase() === "C" && !CFG.allowC) {
  console.error("root_on_c_drive: 账单根目录不能放 C 盘（可显式 allowC:true）");
  process.exit(3);
}
const EGO = String(CFG.ego || process.env.PDD_EGO_BROWSER || findEgo()).replace(/\\/g, "/");
const WORKER = String(CFG.worker || SELF_WORKER).replace(/\\/g, "/");
const STORES_CFG = String(CFG.storesConfig || path.join(ROOT, "_stores.json")).replace(/\\/g, "/");
const RUN_ROOT = String(CFG.runRoot || path.join(ROOT, "_runs")).replace(/\\/g, "/").replace(/\/$/, "");
const RUNTIME = String(CFG.runtimeDir || path.join(os.tmpdir(), "pdd-promo-runtime")).replace(/\\/g, "/").replace(/\/$/, "");
const RUN_ID = CFG.runId || "promo-" + stamp;
const RUN_DIR = RUN_ROOT + "/" + RUN_ID;
const RESULT_DIR = RUN_DIR + "/results";
const LOG_DIR = RUN_DIR + "/logs";
const CONCURRENCY = Math.max(1, Number(CFG.concurrency || 3));
const DOCTOR = !!CFG.doctor || CFG.mode === "doctor";
const MODE = CFG.mode || "run";

const from = String(CFG.from || "");
const to = String(CFG.to || "");
const issues = [];
const addIssue = (code, q, extra = {}) => issues.push({ code, question: q, ...extra });
const todayIso = new Date().toISOString().slice(0, 10);
if (!/^20\d\d-\d\d-\d\d$/.test(from) || !/^20\d\d-\d\d-\d\d$/.test(to)) addIssue("range_invalid", "from/to 必须是 YYYY-MM-DD，当前 from=" + from + " to=" + to, { from, to });
else if (from > to) addIssue("range_reversed", "起始日 " + from + " 晚于结束日 " + to, { from, to });
else if (to > todayIso) addIssue("range_in_future", "结束日 " + to + " 在未来（今天 " + todayIso + "）", { to, today: todayIso });
if (!existsSync(ROOT)) addIssue("root_missing", "账单根目录不存在：" + ROOT + "。是否创建？（确认后加 autoCreateRoot:true）", { root: ROOT, action: "create_root" });
if (EGO !== "ego-browser" && !existsSync(EGO)) addIssue("ego_not_found", "ego-browser 不可用：" + EGO, { ego: EGO });

let STORES = null;
let stores = [];
if (CFG.shops && CFG.shops.length) {
  stores = CFG.shops.map((s) => (typeof s === "string" ? { shop: s } : s)).filter((s) => s && s.shop);
} else if (existsSync(STORES_CFG)) {
  try {
    STORES = JSON.parse(await fs.readFile(STORES_CFG, "utf8"));
    const all = (STORES.stores || []).filter((s) => s.enabled !== false && s.shop);
    const only = CFG.only && CFG.only.length ? CFG.only : null;
    stores = only ? all.filter((s) => only.includes(s.shop)) : all;
  } catch (e) {
    addIssue("stores_config_invalid", "店铺清单不是合法 JSON：" + STORES_CFG, { path: STORES_CFG, error: String(e && e.message || e) });
  }
} else {
  addIssue("stores_config_missing", "没有店铺清单，也没有 config.shops：" + STORES_CFG, { path: STORES_CFG });
}
if (!stores.length) addIssue("no_store_selected", "没有可跑的店（shops/only 为空或都不匹配）", {});

if (CFG.autoCreateRoot && !existsSync(ROOT) && !(/^[A-Za-z]:/.test(ROOT) && ROOT.slice(0, 1).toUpperCase() === "C" && !CFG.allowC)) {
  await fs.mkdir(ROOT, { recursive: true }).catch(() => {});
  for (let i = issues.length - 1; i >= 0; i--) if (issues[i].code === "root_missing" && existsSync(ROOT)) issues.splice(i, 1);
}

if (issues.length) {
  const out = { status: "needs_user_input", runId: RUN_ID, root: ROOT, issues };
  console.log("PREFLIGHT=needs_user_input");
  console.log(JSON.stringify(out, null, 1));
  process.exit(3);
}

// 期间目录 / 标签 / 截图名
const f = from.split("-").map(Number);
const t = to.split("-").map(Number);
const monthEnd = new Date(t[0], t[1], 0).getDate();
const isWholeMonth = f[1] === t[1] && f[2] === 1 && t[2] === monthEnd;
const periodDir = isWholeMonth ? from.slice(0, 7) : from + "_" + to;
const label = isWholeMonth ? t[1] + "月" : f[1] + "月" + f[2] + "日-" + t[1] + "月" + t[2] + "日";
const pad = (s) => String(s).padStart(2, "0");
const beginText = from.slice(0, 4) + "/" + from.slice(5, 7) + "/" + from.slice(8, 10);
const endText = to.slice(0, 4) + "/" + to.slice(5, 7) + "/" + to.slice(8, 10);

await fs.mkdir(RESULT_DIR, { recursive: true });
await fs.mkdir(LOG_DIR, { recursive: true });
await fs.mkdir(RUNTIME + "/" + RUN_ID, { recursive: true });

function mkJob(store, i, mode) {
  return {
    shop: store.shop,
    profile: store.profile || null,
    from, to,
    periodDir,
    label,
    beginText,
    endText,
    root: ROOT,
    storesConfig: STORES_CFG,
    shotName: store.shop + "-推广-" + label + ".png",
    resultPath: RESULT_DIR + "/" + store.shop + ".json",
    logPath: LOG_DIR + "/" + store.shop + ".log",
    mode: mode || "run",
  };
}

async function runOne(store, i, mode) {
  const job = mkJob(store, i, mode);
  if (mode === "doctor") {
    job.resultPath = path.join(os.tmpdir(), "pdd-promo-doctor-" + RUN_ID + "-" + i + ".json");
    delete job.logPath;
  }
  const dir = RUNTIME + "/" + RUN_ID + (mode === "doctor" ? "-doctor" : "");
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const wrapper = dir + "/job-" + i + ".mjs";
  await fs.writeFile(wrapper, "globalThis.__JOB = " + JSON.stringify(job) + ";\nawait import('file:///" + WORKER + "');\n", "utf8");
  const started = Date.now();
  const child = spawn(EGO, ["nodejs", "-e", "await import('file:///" + wrapper + "')"], { stdio: "ignore", windowsHide: true });
  const timeout = setTimeout(() => { try { child.kill(); } catch (e) {} }, Number(CFG.jobTimeoutSec || 120) * 1000);
  await new Promise((res) => child.on("exit", res));
  clearTimeout(timeout);
  let result = null;
  for (let k = 0; k < 10 && !result; k++) {
    try { result = JSON.parse(await fs.readFile(job.resultPath, "utf8")); } catch (e) { await sleep(300); }
  }
  if (!result) result = { ok: false, status: "failed", error: "no_result_file" };
  return { shop: store.shop, result, wallSec: Number(((Date.now() - started) / 1000).toFixed(1)) };
}

if (DOCTOR) {
  const rs = [];
  for (let i = 0; i < stores.length; i++) {
    const r = await runOne(stores[i], i, "doctor");
    rs.push(r);
    console.log("DOCTOR " + r.shop + " " + (r.result.status || "?") + " spend=" + (r.result.spend === undefined ? "-" : r.result.spend) + " wall=" + r.wallSec + "s");
  }
  const ok = rs.every((r) => r.result && r.result.ok);
  console.log("\nDOCTOR_RESULT=" + JSON.stringify({ ok, from, to, stores: rs }, null, 1));
  process.exit(ok ? 0 : 1);
}

const completed = [];
let next = 0;
async function loop() {
  while (true) {
    const idx = next++;
    if (idx >= stores.length) return;
    const r = await runOne(stores[idx], idx, "run");
    completed.push(r);
    const s = r.result || {};
    console.log("DONE " + r.shop + " status=" + (s.status || "?") + " spend=" + (s.spend === undefined ? "-" : s.spend) + " wall=" + r.wallSec + "s" + (s.error ? " err=" + s.error : ""));
  }
}
const loops = [];
for (let k = 0; k < Math.min(CONCURRENCY, stores.length); k++) loops.push(loop());
await Promise.all(loops);

completed.sort((a, b) => a.shop.localeCompare(b.shop));
const report = {
  runId: RUN_ID,
  from,
  to,
  periodDir,
  label,
  createdAt: new Date().toISOString(),
  stores: completed.map((c) => ({
    shop: c.shop,
    status: (c.result && c.result.status) || "failed",
    ok: !!(c.result && c.result.ok),
    spend: c.result && c.result.spend,
    total: c.result && c.result.total,
    shot: c.result && c.result.shot,
    error: c.result && c.result.error,
    wallSec: c.wallSec,
  })),
};
await fs.writeFile(RUN_DIR + "/report.json", JSON.stringify(report, null, 1), "utf8");
const lines = ["run=" + RUN_ID + " from=" + from + " to=" + to];
for (const s of report.stores) lines.push([s.shop.padEnd(10), s.status.padEnd(9), "spend=" + (s.spend === undefined ? "-" : s.spend), "wall=" + s.wallSec + "s", s.error || ""].join(" "));
await fs.writeFile(RUN_DIR + "/summary.txt", lines.join("\n"), "utf8");
console.log("\n" + lines.join("\n"));
console.log("REPORT=" + RUN_DIR + "/report.json");
