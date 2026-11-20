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
const todayIso = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
if (!/^20\d\d-\d\d-\d\d$/.test(from) || !/^20\d\d-\d\d-\d\d$/.test(to)) addIssue("range_invalid", "from/to 必须是 YYYY-MM-DD，当前 from=" + from + " to=" + to, { from, to });
else if (from > to) addIssue("range_reversed", "起始日 " + from + " 晚于结束日 " + to, { from, to });
else if (to > todayIso) addIssue("range_in_future", "结束日 " + to + " 在未来（今天 " + todayIso + "）", { to, today: todayIso });

// 根目录：非 C 盘缺省自动创建；C 盘仍默认拒绝（可 allowC:true 放行）
const rootOnC = /^[A-Za-z]:/.test(ROOT) && ROOT.slice(0, 1).toUpperCase() === "C" && !CFG.allowC;
if (!existsSync(ROOT)) {
  if (rootOnC) {
    addIssue("root_on_c_drive", "账单根目录在 C 盘：" + ROOT + "。请把 root 改到其他盘，或显式 allowC:true。", { root: ROOT, action: "change_root" });
  } else {
    try {
      await fs.mkdir(ROOT, { recursive: true });
      console.log("ROOT_AUTO_CREATED=" + ROOT);
    } catch (e) {
      addIssue("root_create_failed", "无法创建根目录：" + ROOT + "（" + String((e && e.message) || e) + "）", { root: ROOT, action: "create_root" });
    }
  }
}
if (EGO !== "ego-browser" && !existsSync(EGO)) addIssue("ego_not_found", "ego-browser 不可用：" + EGO + "。请安装 ego-browser，或在 config 里用 ego 指定路径。", { ego: EGO, action: "install_or_config_ego" });

const egoUsable = EGO === "ego-browser" ? true : existsSync(EGO);
let STORES = null;
let stores = [];
let storesFromConfig = false;
if (CFG.shops && CFG.shops.length) {
  stores = CFG.shops.map((s) => (typeof s === "string" ? { shop: s } : s)).filter((s) => s && s.shop);
  storesFromConfig = true;
} else if (existsSync(STORES_CFG)) {
  try {
    STORES = JSON.parse(await fs.readFile(STORES_CFG, "utf8"));
    const all = (STORES.stores || []).filter((s) => s.enabled !== false && s.shop);
    const only = CFG.only && CFG.only.length ? CFG.only : null;
    stores = only ? all.filter((s) => only.includes(s.shop)) : all;
    storesFromConfig = true;
  } catch (e) {
    storesFromConfig = true;
    addIssue("stores_config_invalid", "店铺清单不是合法 JSON：" + STORES_CFG + "。修好该文件后重跑（不会覆盖它）。", { path: STORES_CFG, error: String((e && e.message) || e), action: "fix_stores_config" });
  }
}

// 没有可跑店铺时，自动扫描 ego 已登录店铺并生成清单（用户/agent 不用手填映射）
if (!stores.length && !storesFromConfig && egoUsable && !issues.some((i) => i.code === "ego_not_found")) {
  console.log("STORES_DISCOVERING=1");
  let disc = await runDiscovery();
  if (!(disc && disc.ok && disc.shops && disc.shops.length)) {
    console.log("STORES_DISCOVERY_RETRY");
    await sleep(1500);
    disc = await runDiscovery();
  }
  if (disc && disc.ok && disc.shops && disc.shops.length) {
    await saveStores(disc.shops);
    stores = disc.shops.map((s) => ({ shop: s.shop, profile: s.profile }));
    console.log("STORES_DISCOVERED=" + stores.length + " -> " + STORES_CFG);
  } else {
    addIssue("stores_not_logged_in", "ego 里没有可用的已登录店铺：请先登录至少一家店（或手动提供 " + STORES_CFG + "）后重跑。", { availableProfiles: (disc && disc.shops) || [], action: "login_shop" });
  }
}
if (!stores.length && !issues.some((i) => ["stores_not_logged_in", "stores_config_invalid", "no_store_selected"].includes(i.code))) {
  addIssue("no_store_selected", "没有可跑的店（shops/only 为空或都不匹配）", { action: "check_shops" });
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
    verifyMonthly: CFG.verifyMonthly !== false,
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

// 扫描 ego profiles，自动生成/补齐 _stores.json
async function runDiscovery() {
  const resultPath = path.join(os.tmpdir(), "pdd-promo-discover-" + RUN_ID + ".json");
  const dir = RUNTIME + "/" + RUN_ID + "-discover";
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const job = { mode: "discover", root: ROOT, storesConfig: STORES_CFG, resultPath };
  const wrapper = dir + "/discover.mjs";
  await fs.writeFile(wrapper, "globalThis.__JOB = " + JSON.stringify(job) + ";\nawait import('file:///" + WORKER + "');\n", "utf8");
  const child = spawn(EGO, ["nodejs", "-e", "await import('file:///" + wrapper + "')"], { stdio: "ignore", windowsHide: true });
  const timeout = setTimeout(() => { try { child.kill(); } catch (e) {} }, Number(CFG.jobTimeoutSec || 120) * 1000);
  await new Promise((res) => child.on("exit", res));
  clearTimeout(timeout);
  try { return JSON.parse(await fs.readFile(resultPath, "utf8")); } catch (e) { return { ok: false, shops: [] }; }
}

async function saveStores(shops) {
  let reg = { version: 1, root: ROOT, stores: [] };
  try { reg = JSON.parse(await fs.readFile(STORES_CFG, "utf8")); } catch (e) {}
  if (!reg.stores) reg.stores = [];
  if (!reg.root) reg.root = ROOT;
  for (const s of shops) {
    let e = reg.stores.find((x) => x.shop === s.shop);
    if (!e) { e = { shop: s.shop, profile: s.profile, enabled: true }; reg.stores.push(e); }
    else { e.profile = s.profile; if (e.enabled === undefined) e.enabled = true; }
  }
  await fs.mkdir(path.dirname(STORES_CFG), { recursive: true }).catch(() => {});
  await fs.writeFile(STORES_CFG, JSON.stringify(reg, null, 2), "utf8");
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
    overviewSpend: c.result && c.result.overviewSpend,
    monthlyBill: c.result && c.result.monthlyBill,
    monthlyMatched: c.result && c.result.monthlyMatched,
    monthlyBillStatus: c.result && c.result.monthlyBillStatus,
    source: c.result && c.result.source,
    total: c.result && c.result.total,
    shot: c.result && c.result.shot,
    error: c.result && c.result.error,
    needs: c.result && c.result.needs,
    wallSec: c.wallSec,
  })),
};
await fs.writeFile(RUN_DIR + "/report.json", JSON.stringify(report, null, 1), "utf8");
const lines = ["run=" + RUN_ID + " from=" + from + " to=" + to];
for (const s of report.stores) lines.push([s.shop.padEnd(10), s.status.padEnd(9), "spend=" + (s.spend === undefined ? "-" : s.spend), "wall=" + s.wallSec + "s", s.error || ""].join(" "));
await fs.writeFile(RUN_DIR + "/summary.txt", lines.join("\n"), "utf8");
console.log("\n" + lines.join("\n"));
console.log("REPORT=" + RUN_DIR + "/report.json");

const needs = report.stores.filter((s) => s.needs);
if (needs.length) {
  console.log("\nNEEDS=needs_user_action");
  for (const s of needs) console.log(s.shop + " [" + s.needs.code + "] " + s.needs.question);
  process.exit(4);
}
if (report.stores.some((s) => s.status === "failed")) {
  console.log("\nFAILED=job_failed");
  process.exit(5);
}
