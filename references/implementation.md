# 实现说明（pdd-promo-cost）

## 结构

```
run.mjs          普通 Node 调度器：读配置 → 预检 → 生成 job → spawn ego worker（并发池）
worker-promo.mjs 运行在 ego 进程内：解析空间/找店 → 选数据源（总览/月账单）→ 关对比 → 读数 → 核对 → 截图 → 写文件
```

## 调度器（run.mjs）

1. 读 config（argv 必填）；解析 `root`、`ego`（配置 > `PDD_EGO_BROWSER` > `~/.local/share/ego` > PATH）、`worker`（默认同目录）。
2. 预检：
   - 日期格式/倒挂/未来；`root` 在 C 盘默认拒绝（`allowC:true` 才放行）；非 C 盘缺失**自动创建**（`ROOT_AUTO_CREATED`）。
   - ego 不可用 → `ego_not_found`，退出码 3。
   - 店铺来源：config `shops` > `<root>/_stores.json` > **自动扫描 ego profiles 生成清单**（`STORES_DISCOVERED`，空结果自动重试一次）；扫描不到 → `stores_not_logged_in`。
   - 仍有问题 → `PREFLIGHT=needs_user_input` + issues JSON，退出码 3。
   - 超出 180 天**不再拒绝**，由 worker 改走财务流水月账单。
3. 期间目录/标签：整月 `YYYY-MM` / `<M>月`；区间 `from_to` / `<M月D日-M月D日>`。
4. 生成 job（含 `from/to/periodDir/label/beginText/endText/shotName/root/storesConfig/resultPath`）。
5. worker pool（`concurrency`，默认 3）；每个 job 写结果 JSON；汇总 `report.json` / `summary.txt`（含 `overviewSpend/monthlyBill/monthlyMatched/monthlyBillStatus/needs`）；若某店返回 `needs` → 打印 `NEEDS=needs_user_action` 并以退出码 **4** 结束；任一 `failed` → `FAILED=job_failed` 退出码 **5**。
6. `doctor:true` 时串行跑只读自检并输出 `DOCTOR_RESULT`，不写文件。

## worker（worker-promo.mjs）

1. **找店**：
   - 有 `profile` → `listTaskSpaces` 按 `profileName` 匹配 → `claimTaskSpace/takeOver/taskSpace`。
   - 打开推广页（带日期参数）→ 读右上角店铺名 `AccountNew_mallName`。
   - 名字不符/找不到 → `discoverShops()`：对每个唯一 profile 打开推广页读店铺名；找到目标后写回 `_stores.json` 再重开。
   - 仍找不到 → `shop_not_logged_in`（提示用户登录，不是改映射）。
2. **日期 / 数据源选择**：
   - `from < 今天−180天`（老月份）→ 直接走「财务流水 → 月账单」，读该月 `本月支出`；只支持整月。
   - 否则用总览页 URL 参数 `beginDate/endDate`；`waitDates()` 回读校验，**不一致重试一次，二次仍不一致抛 `date_not_applied`**（不继续读数）。
   - 总览页出现「暂无数据」→ 若整月则自动回退月账单，否则返回 `no_data`。
3. **月账单模式**（`collectFromMonthlyBill`）：
   - 打开 `/mains/account/report` → 点「月账单」→ 滚动/翻页找到 `YYYY/MM` 行；
   - 取第 9 列（下标 8）「本月支出」= 推广花费；截图整页（fullPage，含店铺与月份行）；
   - 写 `推广花费.md`（来源标注月账单）和 `账单信息.md` 块。
4. **关对比**：两个 `anq-checkbox-input`，第 2 个为「对比时间」；勾选则点掉；复核指标卡不含 `%`，必要时再点一次。
5. **读数（总览）**：`readSpend()` 只扫长度为 <90 的卡片 div，分别解析「成交花费」「总花费」的第一个数值；`parseMoney()` 处理 `万/亿` 单位换算（例 `2.21 万` = 22,100）；读不到返回 null（状态 `warn`）。
6. **月账单核对**（`verifyMonthly`，默认 true）：整月采集完总览后，用 `readMonthlyRowOnly()` 读同月月账单「本月支出」；**行没找到会自动重试一次**；最终 `spend` 取月账单精确值，`overviewSpend` 保留页面显示值，差异 ≤100 元视为一致（万显示四舍五入），否则状态 `warn`；并记录 `monthlyBillStatus`（`ok/not_generated/not_found/no_value/disabled/skipped_partial_month`）。
7. **截图**：`page.screenshot` 到 `<periodDir>/<shotName>`（截图在核对前完成，是总览页）。
8. **写文件**：
   - `推广花费.md`（店铺/期间/成交花费（月账单精确值）/总览显示/月账单本月支出与核对状态/截图/来源 URL/时间 + 口径说明）
   - `账单信息.md`：用 `<!-- promo:start -->…<!-- promo:end -->` 块注入/替换（不存在则创建带标题的文件）
9. 结果 JSON：`{ ok, status: done|warn|no_data|unsupported_old_range|failed, spend, overviewSpend, monthlyBill, monthlyMatched, monthlyBillStatus, source, total, shot, error? }`。

## 与 pdd-bills 的协作

- 两个 skill 共用 `<root>/<店铺>/<期间>/` 和 `账单信息.md`。
- 本 skill 只更新 `<!-- promo:start -->` 块；`pdd-bills` 重写账单信息时用 `withPromoBlock()` 读取旧文件里的 promo 块并原样保留（已验证 force 重跑后仍在）。

## 维护指南

| 变的东西 | 改哪里 |
|---|---|
| 页面 URL / 参数名 | `worker-promo.mjs` 的 `promoUrl()` |
| 店铺名元素 | `readShopNameFromPage()` 的 `AccountNew_mallName` / `NavHeader_options` |
| 对比复选框顺序/结构 | `uncheckCompare()` 的 `input.anq-checkbox-input` 下标 |
| 指标卡文案/数值格式 | `readSpend()` 与 `parseMoney()`（含 万/亿 单位） |
| 日期控件回读 | `waitDates()` 的 placeholder/格式 |
| 月账单页面/列顺序 | `FIN_URL`、`switchMonthlyTab()`、`readMonthlyRowOnly()`（本月支出=第 9 列） |
| 月账单翻页 | `readMonthlyRowOnly()` / `collectFromMonthlyBill()` 里的 `>` 下一页逻辑 |
| 截图/文件命名 | `run.mjs` 的 `periodDir`/`label`/`shotName` 与 worker 写文件段 |

改完先单店单月跑一遍，核对页面「成交花费」与 `推广花费.md` 一致，再扩多店。
