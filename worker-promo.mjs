// worker-promo.mjs — 单店「推广花费」采集（运行在 ego 进程内）
// 由 run.mjs 生成的 wrapper 通过 globalThis.__JOB 传入任务
const fs = await import("node:fs/promises");

const JOB = globalThis.__JOB || {};
const t0 = Date.now();
const logLines = [];
const log = (...a) => {
  const line = "[t=" + ((Date.now() - t0) / 1000).toFixed(1) + "s] " + a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  logLines.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = (JOB.root || "D:/对账账单").replace(/\\/g, "/").replace(/\/$/, "");
const SHOP_DIR = ROOT + "/" + JOB.shop;
const PERIOD_DIR = SHOP_DIR + "/" + JOB.periodDir;
const RESULT_PATH = JOB.resultPath || PERIOD_DIR + "/promo-result.json";

function itoa2(n) { return String(n).padStart(2, "0"); }
function dateUrl(d) { return d; }

async function writeResult(obj) {
  const out = { ...obj, shop: JOB.shop, from: JOB.from, to: JOB.to, elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)) };
  if (JOB.periodDir && (obj.status === "done" || obj.status === "warn")) await fs.mkdir(PERIOD_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(RESULT_PATH, JSON.stringify(out, null, 1), "utf8").catch(() => {});
  if (JOB.logPath) await fs.writeFile(JOB.logPath, logLines.join("\n"), "utf8").catch(() => {});
  return out;
}

function promoUrl() {
  return "https://yingxiao.pinduoduo.com/goods/report/promotion/overView?beginDate=" + JOB.from + "&endDate=" + JOB.to;
}
async function gotoPromo(pg) {
  await pg.goto(promoUrl(), { timeout: 60000 }).catch(() => {});
  await pg.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
  await pg.waitForFunction(() => (document.body.innerText || "").includes("商品推广总览"), undefined, { timeout: 20000 }).catch(() => {});
  await pg.waitForTimeout(300);
}

function readShopNameFromPage(pg) {
  return pg.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
    const mall = [...document.querySelectorAll("[class*='AccountNew_mallName']")].filter(vis).map(txt).filter(Boolean);
    if (mall.length) return mall[0];
    const nav = [...document.querySelectorAll("[class*='NavHeader_options']")].filter(vis).map(txt).filter(Boolean);
    if (nav.length) return nav[0].replace(/^\d*\s*/, "").trim();
    const t = txt(document.body);
    const m = t.match(/营销书院\s+([^\s]{2,20})\s+报表/);
    if (m) return m[1];
    const m2 = t.match(/商家后台\s*[^\s]{0,10}\s*([^\s]{2,20})\s+报表/);
    return m2 ? m2[1] : "";
  }).catch(() => "");
}

async function discoverShops() {
  const spaces = await listTaskSpaces();
  const uniq = [];
  for (const s of spaces) {
    const pn = String(s.profileName || "");
    if (!pn) continue;
    if (uniq.some((u) => u.profileName === pn)) continue;
    uniq.push({ profileName: pn, id: s.id });
  }
  const found = [];
  for (const u of uniq) {
    let t = null;
    try {
      const entry = (await listTaskSpaces()).find((s) => s.id === u.id);
      if (!entry) continue;
      t = entry.ownership === "user" ? await claimTaskSpace(entry.id)
        : entry.ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(entry.id)
        : await taskSpace(entry.id);
      const pg = await t.newPage();
      await gotoPromo(pg);
      const shop = await readShopNameFromPage(pg);
      if (shop) found.push({ shop, profile: u.profileName });
    } catch (e) {
      log("discover_err", u.profileName + ": " + String((e && e.message) || e));
    } finally {
      try { if (t) await t.finish({ keep: [] }); } catch (e) {}
    }
  }
  return found;
}

async function updateRegistry(found) {
  const regPath = JOB.storesConfig || ROOT + "/_stores.json";
  let reg = { version: 1, root: ROOT, stores: [] };
  try { reg = JSON.parse(await fs.readFile(regPath, "utf8")); } catch (e) {}
  if (!reg.stores) reg.stores = [];
  if (!reg.root) reg.root = ROOT;
  for (const f of found) {
    let e = reg.stores.find((s) => s.shop === f.shop);
    if (!e) { e = { shop: f.shop, profile: f.profile, enabled: true }; reg.stores.push(e); }
    else { e.profile = f.profile; if (e.enabled === undefined) e.enabled = true; }
  }
  await fs.mkdir(ROOT, { recursive: true }).catch(() => {});
  await fs.writeFile(regPath, JSON.stringify(reg, null, 2), "utf8");
  return reg;
}

let task = null;
let page = null;

async function resolveSpace() {
  const spaces = await listTaskSpaces();
  const byProfile = spaces.find((s) => String(s.profileName || "") === String(JOB.profile || ""));
  const byName = spaces.find((s) => String(s.name || "") === JOB.shop);
  const entry = byProfile || byName;
  if (!entry) throw new Error("space_not_found_for:" + (JOB.profile || JOB.shop));
  task = entry.ownership === "user" ? await claimTaskSpace(entry.id)
    : entry.ownership === "agentDelegatedToUser" ? await takeOverTaskSpace(entry.id)
    : await taskSpace(entry.id);
}

async function openShopSpace() {
  let shopName = "";
  if (JOB.profile) {
    try {
      await resolveSpace();
      page = await task.newPage();
      await gotoPromo(page);
      shopName = await readShopNameFromPage(page);
      log("profile", JOB.profile + " -> " + (shopName || "(未识别)"));
    } catch (e) {
      log("profile_unusable", String((e && e.message) || e));
      shopName = "";
    }
  }
  if (!shopName || shopName !== JOB.shop) {
    if (task) { try { await task.finish({ keep: [] }); } catch (e) {} task = null; page = null; }
    log("discover_for", JOB.shop);
    const found = await discoverShops();
    const hit = found.find((f) => f.shop === JOB.shop);
    if (hit) {
      JOB.profile = hit.profile;
      await updateRegistry([hit]);
      await resolveSpace();
      page = await task.newPage();
      await gotoPromo(page);
      shopName = await readShopNameFromPage(page);
    }
    if (!hit || shopName !== JOB.shop) throw new Error("shop_not_logged_in:" + JOB.shop);
  }
  if (!page) page = await task.newPage();
  return shopName;
}

async function waitDates() {
  let ok = false;
  try {
    await page.waitForFunction(({ begin, end }) => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const ins = [...document.querySelectorAll("input")].filter((e) => vis(e) && (e.placeholder || "").includes("开始日期"));
      if (!ins.length) return false;
      return ins.some((e) => e.value === begin) && [...document.querySelectorAll("input")].some((e) => (e.placeholder || "").includes("结束日期") && e.value === end);
    }, { begin: JOB.beginText, end: JOB.endText }, { timeout: 15000 });
    ok = true;
  } catch (e) {}
  if (!ok) {
    const actual = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const ins = [...document.querySelectorAll("input")].filter((e) => vis(e) && ((e.placeholder || "").includes("开始日期") || (e.placeholder || "").includes("结束日期")));
      return ins.map((e) => ({ ph: e.placeholder || "", v: e.value || "" }));
    }).catch(() => []);
    throw new Error("date_not_applied: expect " + JOB.beginText + " ~ " + JOB.endText + ", actual=" + JSON.stringify(actual));
  }
  await sleep(300);
}

async function uncheckCompare() {
  const state = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const boxes = [...document.querySelectorAll("input.anq-checkbox-input")].filter(vis);
    return boxes.map((b) => ({ checked: b.checked })).slice(0, 4);
  });
  if (state.length >= 2 && state[1].checked) {
    const ok = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const boxes = [...document.querySelectorAll("input.anq-checkbox-input")].filter(vis);
      if (!boxes[1]) return false;
      boxes[1].setAttribute("data-ego-uncheck", "1");
      return true;
    });
    if (ok) {
      await page.click('css=[data-ego-uncheck="1"]', { label: "uncheck compare" });
      await sleep(600);
    }
  }
  // 复核：指标卡不应再出现百分比（对比会带 %）
  const still = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
    for (const el of document.querySelectorAll("div")) {
      if (!vis(el)) continue;
      const t = txt(el);
      if (/成交花费/.test(t) && t.length < 90) {
        if (/%/.test(t)) return true;
      }
    }
    return false;
  });
  if (still) {
    log("compare still on, retry");
    const ok2 = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const boxes = [...document.querySelectorAll("input.anq-checkbox-input")].filter(vis);
      if (boxes[1] && boxes[1].checked) { boxes[1].click(); return true; }
      return false;
    });
    if (ok2) await sleep(600);
  }
}

function parseMoney(text, label) {
  const re = new RegExp(label + "\\s*(?:（元）|\\(元\\))?\\s*[:：]?\\s*[+\\-]?([0-9,]+(?:\\.[0-9]+)?)\\s*(万|亿)?");
  const m = text.match(re);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  if (m[2] === "万") n *= 10000;
  else if (m[2] === "亿") n *= 100000000;
  return n;
}

async function readSpend() {
  const cards = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
    const out = [];
    for (const el of document.querySelectorAll("div")) {
      if (!vis(el)) continue;
      const t = txt(el);
      if (/成交花费|总花费/.test(t) && t.length < 90) out.push(t);
    }
    return out.slice(0, 12);
  });
  const spendText = cards.find((t) => /成交花费/.test(t)) || "";
  const totalText = cards.find((t) => /总花费/.test(t)) || "";
  return {
    text: spendText,
    spend: parseMoney(spendText, "成交花费"),
    total: parseMoney(totalText, "总花费"),
    cards: cards.slice(0, 4),
  };
}

function fmt(n) {
  if (n === null || n === undefined) return "未读到";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function injectPromo(periodDir, block) {
  const file = periodDir + "/账单信息.md";
  let text = "";
  try { text = await fs.readFile(file, "utf8"); } catch (e) {}
  const re = /<!-- promo:start -->[\s\S]*?<!-- promo:end -->/;
  if (re.test(text)) text = text.replace(re, block);
  else text = (text ? text.replace(/\s*$/,"") + "\n\n" : "# 账单信息\n\n") + block;
  await fs.writeFile(file, text, "utf8");
}

const FIN_URL = "https://yingxiao.pinduoduo.com/mains/account/report";

async function switchMonthlyTab() {
  const ok = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
    const hits = [...document.querySelectorAll("div,span,li,a,button")].filter((e) => vis(e) && txt(e) === "月账单");
    if (!hits.length) return false;
    hits[0].setAttribute("data-ego-monthtab", "1");
    return true;
  });
  if (!ok) throw new Error("monthly_tab_not_found");
  await page.click('css=[data-ego-monthtab="1"]', { label: "monthly bills tab" });
  await sleep(800);
}

// 老月份走「财务流水 → 月账单」：本月支出 = 推广花费
async function collectFromMonthlyBill(shopName) {
  const monthKey = JOB.from.slice(0, 7).replace("-", "/");
  await fs.mkdir(PERIOD_DIR, { recursive: true }).catch(() => {});
  await page.goto(FIN_URL, { timeout: 60000 });
  await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => (document.body.innerText || "").includes("财务流水"), undefined, { timeout: 20000 }).catch(() => {});
  await sleep(300);
  await switchMonthlyTab();

  let found = false;
  for (let p = 0; p < 6 && !found; p++) {
    for (let i = 0; i < 25 && !found; i++) {
      found = await page.evaluate((k) => (document.body.innerText || "").includes(k), monthKey);
      if (found) break;
      const atBottom = await page.evaluate(() => window.innerHeight + window.scrollY >= document.body.scrollHeight - 8);
      if (atBottom) break;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(450);
    }
    if (found) break;
    // 翻页：找可用的「>」下一页按钮
    const nextMarked = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
      const cands = [...document.querySelectorAll("button, li, a, span")].filter((e) => {
        if (!vis(e)) return false;
        if (e.disabled || e.getAttribute("aria-disabled") === "true") return false;
        const t = txt(e);
        const cls = String(e.className || "");
        return t === ">" || /pagination-next/.test(cls);
      });
      if (!cands.length) return false;
      cands[0].setAttribute("data-ego-nextpage", "1");
      return true;
    });
    if (!nextMarked) break;
    await page.click('css=[data-ego-nextpage="1"]', { label: "next page" }).catch(() => {});
    await sleep(700);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  const rowInfo = await page.evaluate((k) => {
    const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
    const rows = [...document.querySelectorAll("table tr")];
    const row = rows.find((r) => r.cells[0] && txt(r.cells[0]) === k);
    if (!row) return { found: false };
    row.scrollIntoView({ block: "center" });
    const cells = [...row.cells].map((c) => txt(c));
    const raw = cells[8] || "";
    const num = parseFloat(raw.replace(/,/g, "").replace(/[^\d.-]/g, ""));
    return { found: true, cells, raw, spend: Number.isFinite(num) ? num : null };
  }, monthKey);
  log("monthly", JSON.stringify(rowInfo));
  if (!rowInfo.found) throw new Error("monthly_row_not_found:" + monthKey);
  await sleep(300);
  const shot = await page.screenshot({ path: PERIOD_DIR + "/" + JOB.shotName, fullPage: true });
  log("shot", shot);

  const spend = rowInfo.spend;
  const md = [
    "# 推广花费 · " + JOB.shop + " · " + JOB.label,
    "",
    "| 项 | 值 |",
    "|---|---|",
    "| 店铺 | " + JOB.shop + " |",
    "| 期间 | " + JOB.from + " ~ " + JOB.to + " |",
    "| 成交花费（元） | " + fmt(spend) + "（取自财务流水·月账单「本月支出」） |",
    "| 总花费（元） | " + fmt(spend) + "（月账单口径） |",
    "| 截图 | `" + JOB.shotName + "` |",
    "| 来源 | 财务流水·月账单（本月支出） | " + FIN_URL + " |",
    "| 记录时间 | " + new Date().toISOString() + " |",
    "",
    "> 口径：成交花费 = 推广总花费。该月份超出商品推广总览的 180 天保留期，改用「财务流水 → 月账单」的本月支出（与总览近期数据同口径）。",
  ].join("\n");
  await fs.writeFile(PERIOD_DIR + "/推广花费.md", md, "utf8");

  const block = [
    "<!-- promo:start -->",
    "## 推广花费",
    "",
    "| 项 | 值 |",
    "|---|---|",
    "| 成交花费（元） | " + fmt(spend) + " |",
    "| 总花费（元） | " + fmt(spend) + " |",
    "| 截图 | `" + JOB.shotName + "` |",
    "| 来源 | 财务流水·月账单（本月支出） |",
    "| 采集时间 | " + new Date().toISOString() + " |",
    "<!-- promo:end -->",
  ].join("\n");
  await injectPromo(PERIOD_DIR, block);

  return {
    status: spend === null ? "warn" : "done",
    shop: shopName,
    spend,
    total: spend,
    source: "monthly_bill",
    monthlyBill: spend,
    monthlyMatched: true,
    monthlyBillStatus: "ok",
    monthKey,
    shot: PERIOD_DIR + "/" + JOB.shotName,
  };
}

// 只读月账单某行，返回 {found, spend, raw}（用于总览值与账本核对）
async function readMonthlyRowOnly(monthKey, attempt = 1) {
  await page.goto(FIN_URL, { timeout: 60000 });
  await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => (document.body.innerText || "").includes("财务流水"), undefined, { timeout: 20000 }).catch(() => {});
  await sleep(300);
  await switchMonthlyTab();
  let found = false;
  for (let p = 0; p < 6 && !found; p++) {
    for (let i = 0; i < 25 && !found; i++) {
      found = await page.evaluate((k) => (document.body.innerText || "").includes(k), monthKey);
      if (found) break;
      const atBottom = await page.evaluate(() => window.innerHeight + window.scrollY >= document.body.scrollHeight - 8);
      if (atBottom) break;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(400);
    }
    if (found) break;
    const nextMarked = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
      const cands = [...document.querySelectorAll("button, li, a, span")].filter((e) => vis(e) && !e.disabled && (txt(e) === ">" || /pagination-next/.test(String(e.className))));
      if (!cands.length) return false;
      cands[0].setAttribute("data-ego-nextpage2", "1");
      return true;
    });
    if (!nextMarked) break;
    await page.click('css=[data-ego-nextpage2="1"]', { label: "next page" }).catch(() => {});
    await sleep(700);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  const rowInfo = await page.evaluate((k) => {
    const txt = (e) => (e ? (e.innerText || "").replace(/\s+/g, " ").trim() : "");
    const rows = [...document.querySelectorAll("table tr")];
    const row = rows.find((r) => r.cells[0] && txt(r.cells[0]) === k);
    if (!row) return { found: false };
    row.scrollIntoView({ block: "center" });
    const cells = [...row.cells].map((c) => txt(c));
    const raw = cells[8] || "";
    const num = parseFloat(raw.replace(/,/g, "").replace(/[^\d.-]/g, ""));
    return { found: true, cells, raw, spend: Number.isFinite(num) ? num : null };
  }, monthKey);
  if (!rowInfo.found && attempt < 2) {
    log("monthly_row_retry", monthKey + " attempt=" + attempt);
    await sleep(800);
    return await readMonthlyRowOnly(monthKey, attempt + 1);
  }
  return rowInfo;
}

function localTodayIso() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function retentionStartIso() {
  const d = new Date(localTodayIso() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 180);
  return d.toISOString().slice(0, 10);
}
function currentMonthKey() {
  return localTodayIso().slice(0, 7).replace("-", "/");
}
function billStatusText(s) {
  return ({
    ok: "已核对",
    not_generated: "当月账单未生成",
    not_found: "未找到该月账单行",
    no_value: "月账单该行为空",
    disabled: "已关闭核对",
    skipped_partial_month: "非整月，不核对",
  })[s] || s;
}

async function main() {
  const shopName = await openShopSpace();
  if (!page) page = await task.newPage();

  const retentionStart = retentionStartIso();
  const fparts = JOB.from.split("-").map(Number);
  const tparts = JOB.to.split("-").map(Number);
  const monthEnd = new Date(tparts[0], tparts[1], 0).getDate();
  const isWholeMonth = fparts[1] === tparts[1] && fparts[2] === 1 && tparts[2] === monthEnd;

  if (JOB.from < retentionStart) {
    log("old_range", JOB.from + " < " + retentionStart + " → 财务流水·月账单");
    if (!isWholeMonth) {
      return { status: "unsupported_old_range", note: "超出商品推广总览 180 天保留期的区间，只能读整月的财务流水月账单" };
    }
    return await collectFromMonthlyBill(shopName);
  }

  const url = "https://yingxiao.pinduoduo.com/goods/report/promotion/overView?beginDate=" + dateUrl(JOB.from) + "&endDate=" + dateUrl(JOB.to);
  let datesOk = false;
  for (let attempt = 1; attempt <= 2 && !datesOk; attempt++) {
    await page.goto(url, { timeout: 60000 });
    await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => (document.body.innerText || "").includes("商品推广总览"), undefined, { timeout: 20000 }).catch(() => {});
    try {
      await waitDates();
      datesOk = true;
    } catch (e) {
      log("date_check_failed", "attempt=" + attempt + " " + String((e && e.message) || e));
      if (attempt === 2) throw e;
      await sleep(800);
    }
  }
  log("page", url);

  const noData = await page.evaluate(() => (document.body.innerText || "").includes("暂无数据"));
  if (noData) {
    log("no_data");
    if (isWholeMonth) return await collectFromMonthlyBill(shopName);
    return { status: "no_data", note: "平台显示暂无数据（可能超出最近180天保留期）" };
  }

  await uncheckCompare();
  const spend = await readSpend();
  log("spend", spend.text);
  if (!spend.spend && spend.spend !== 0) throw new Error("spend_not_found:" + spend.text.slice(0, 120));

  const periodDir = PERIOD_DIR;
  await fs.mkdir(periodDir, { recursive: true }).catch(() => {});
  const shot = await page.screenshot({ path: periodDir + "/" + JOB.shotName });
  log("shot", shot);

  const overviewSpend = spend.spend;
  const dateText = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const ins = [...document.querySelectorAll("input")].filter((e) => vis(e) && (e.placeholder || "").includes("开始日期"));
    return ins.map((e) => e.value).slice(0, 1)[0] || "";
  });

  // 与财务流水月账单核对（万显示会四舍五入，差异容忍 100 元）
  const monthKey = JOB.from.slice(0, 7).replace("-", "/");
  let billSpend = null;
  let monthlyBillStatus = isWholeMonth ? (JOB.verifyMonthly === false ? "disabled" : "not_generated") : "skipped_partial_month";
  if (isWholeMonth && JOB.verifyMonthly !== false) {
    const row = await readMonthlyRowOnly(monthKey);
    if (!row || !row.found) monthlyBillStatus = monthKey === currentMonthKey() ? "not_generated" : "not_found";
    else if (row.spend === null) monthlyBillStatus = "no_value";
    else { billSpend = row.spend; monthlyBillStatus = "ok"; }
    log("monthly_check", JSON.stringify({ monthKey, overviewSpend, billSpend, monthlyBillStatus }));
  }
  const diff = billSpend !== null && overviewSpend !== null ? billSpend - overviewSpend : null;
  const monthlyMatched = diff !== null ? Math.abs(diff) <= 100 : null;
  const finalSpend = billSpend !== null ? billSpend : overviewSpend;
  const billLine = monthlyBillStatus === "ok" ? fmt(billSpend) : "未核对（" + billStatusText(monthlyBillStatus) + "）";

  const md = [
    "# 推广花费 · " + JOB.shop + " · " + JOB.label,
    "",
    "| 项 | 值 |",
    "|---|---|",
    "| 店铺 | " + JOB.shop + " |",
    "| 期间 | " + JOB.from + " ~ " + JOB.to + " |",
    "| 成交花费（元） | " + fmt(finalSpend) + " |",
    "| 总览显示（元） | " + fmt(overviewSpend) + (spend.text.includes("万") ? "（页面按万四舍五入）" : "") + " |",
    "| 月账单本月支出（元） | " + billLine + " |",
    "| 与月账单核对 | " + (monthlyMatched === null ? "未核对（" + billStatusText(monthlyBillStatus) + "）" : monthlyMatched ? "一致（差 " + fmt(Math.abs(diff)) + " 元）" : "不一致（差 " + fmt(Math.abs(diff)) + " 元）") + " |",
    "| 截图 | `" + JOB.shotName + "` |",
    "| 来源 | " + url + " |",
    "| 记录时间 | " + new Date().toISOString() + " |",
    "",
    "> 口径：成交花费 = 推广总花费。截图前已关闭「对比时间」；月账单核对成功时最终数值取「本月支出」，总览按万显示会有几十元四舍五入。",
  ].join("\n");
  await fs.writeFile(periodDir + "/推广花费.md", md, "utf8");

  const block = [
    "<!-- promo:start -->",
    "## 推广花费",
    "",
    "| 项 | 值 |",
    "|---|---|",
    "| 成交花费（元） | " + fmt(finalSpend) + " |",
    "| 总览显示（元） | " + fmt(overviewSpend) + " |",
    "| 月账单核对 | " + (monthlyMatched === null ? "未核对（" + billStatusText(monthlyBillStatus) + "）" : monthlyMatched ? "一致" : "不一致（差 " + fmt(Math.abs(diff)) + " 元）") + " |",
    "| 截图 | `" + JOB.shotName + "` |",
    "| 采集时间 | " + new Date().toISOString() + " |",
    "<!-- promo:end -->",
  ].join("\n");
  await injectPromo(periodDir, block);

  return {
    status: finalSpend === null ? "warn" : monthlyMatched === false ? "warn" : "done",
    shop: shopName,
    spend: finalSpend,
    overviewSpend,
    monthlyBill: billSpend,
    monthlyMatched,
    monthlyBillStatus,
    verifyMonthly: JOB.verifyMonthly !== false,
    total: spend.total,
    shot: periodDir + "/" + JOB.shotName,
    dateText,
  };
}

async function doctor() {
  const shopName = await openShopSpace();
  if (!page) page = await task.newPage();
  const retentionStart = retentionStartIso();
  const fparts = JOB.from.split("-").map(Number);
  const tparts = JOB.to.split("-").map(Number);
  const monthEnd = new Date(tparts[0], tparts[1], 0).getDate();
  const isWholeMonth = fparts[1] === tparts[1] && fparts[2] === 1 && tparts[2] === monthEnd;
  const monthKey = JOB.from.slice(0, 7).replace("-", "/");

  if (JOB.from < retentionStart) {
    if (!isWholeMonth) return { status: "doctor_no_data", shop: shopName, note: "老区间非整月，月账单无法对应" };
    const row = await readMonthlyRowOnly(monthKey);
    if (row && row.found && row.spend !== null) {
      return { status: "doctor_ok", shop: shopName, source: "monthly_bill", spend: row.spend, total: row.spend, monthlyBillStatus: "ok" };
    }
    return { status: "doctor_no_data", shop: shopName, note: "月账单未找到该月行" };
  }

  const url = "https://yingxiao.pinduoduo.com/goods/report/promotion/overView?beginDate=" + JOB.from + "&endDate=" + JOB.to;
  await page.goto(url, { timeout: 60000 });
  await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => (document.body.innerText || "").includes("商品推广总览"), undefined, { timeout: 20000 }).catch(() => {});
  await waitDates();
  const noData = await page.evaluate(() => (document.body.innerText || "").includes("暂无数据"));
  if (noData) {
    if (isWholeMonth) {
      const row = await readMonthlyRowOnly(monthKey);
      if (row && row.found && row.spend !== null) {
        return { status: "doctor_ok", shop: shopName, source: "monthly_bill", spend: row.spend, total: row.spend, monthlyBillStatus: "ok" };
      }
    }
    return { status: "doctor_no_data", shop: shopName, note: "平台显示暂无数据（可能超出180天保留期）" };
  }
  await uncheckCompare();
  const spend = await readSpend();
  return { status: "doctor_ok", shop: shopName, spend: spend.spend, total: spend.total, text: spend.text.slice(0, 120) };
}

let result;
try {
  if (JOB.mode === "discover") {
    const found = await discoverShops();
    result = { status: "discovered", shops: found };
  } else if (JOB.mode === "doctor") result = await doctor();
  else result = await main();
  await writeResult({ ok: true, ...result });
} catch (e) {
  const msg = String((e && e.message) || e);
  log("ERROR", msg);
  result = { status: "failed", error: msg };
  if (msg.includes("shop_not_logged_in") || msg.includes("space_not_found_for")) {
    let profiles = [];
    try { profiles = [...new Set((await listTaskSpaces()).map((s) => String(s.profileName || "")).filter(Boolean))]; } catch (e2) {}
    result.needs = {
      code: "shop_not_logged_in",
      question: "在 ego 的各个 profile 里没找到店铺「" + JOB.shop + "」。请登录该店铺（或把店铺加到 ego）后重跑。",
      availableProfiles: profiles,
    };
  }
  await writeResult({ ok: false, ...result });
} finally {
  try { if (task) await task.finish({ keep: [] }); } catch (e) {}
}
console.log("WORKER_RESULT=" + JSON.stringify({ shop: JOB.shop, status: result && result.status, spend: result && result.spend, elapsed: ((Date.now() - t0) / 1000).toFixed(1) }));
