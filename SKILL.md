---
name: pdd-promo-cost
description: 拼多多多店铺「推广花费」采集（多多招财 · 商品推广总览）。按店铺 × 期间，近 180 天打开 yingxiao.pinduoduo.com 的商品推广总览，关掉「对比时间」，截图并读取「成交花费」（= 推广总花费），再用财务流水月账单核对取精确值；更早月份直接读「财务流水 → 月账单」的「本月支出」。落到 <账单根目录>\<店铺>\<期间>\（`<店铺>-推广-<月>月.png` + `推广花费.md`），并把数值写进同目录 `账单信息.md`。Use when 用户要取/核对拼多多推广花费、营销费用、月账单里的推广支出，或要把多店推广花费汇总留档。
---

# pdd-promo-cost — 拼多多推广花费采集

> 本 skill 不含本机路径、账号、店铺名；真实店铺清单在用户数据目录。
>
> 实现细节 / 页面契约 / 测试见 `references/`：
> - `references/dom-contract.md` — 推广页 URL、店铺名元素、对比开关、指标卡解析、日期输入、月账单表格
> - `references/implementation.md` — 调度器 + worker 流程、数据源选择、核对、写入规则、维护指南
> - `references/testing.md` — 实测数字、交叉核对表
> - `references/pitfalls.md` — 用什么方法、怎么用、踩过的坑与排障对照表
> - `references/acceptance.md` — 交付验收清单（DoD）与陌生人走查步骤

## 前置条件

- Windows + ego-browser（各店 profile 已登录）
- Node.js
- 账单根目录：默认 `D:/对账账单`（`root` 可改；不存在会自动创建，C 盘默认拒绝、`allowC:true` 可放行）
- 店铺清单：`<root>/_stores.json`；**可以不给**——首次运行会自动扫描 ego profiles 生成（config 里给 `shops` 也行）

## 条件不满足时（agent 怎么处理）

- **根目录不存在**：非 C 盘会自动创建（输出 `ROOT_AUTO_CREATED`）；C 盘默认拒绝 → 改 `root` 或显式 `allowC:true`。
- **没有店铺清单 / 清单为空**：自动扫描 ego 已登录店铺，生成/补齐 `<root>/_stores.json`（输出 `STORES_DISCOVERED=N`）；扫描不到 → `PREFLIGHT` 里 `stores_not_logged_in`，提示用户登录店铺。
- **店铺未登录 / 找不到**：worker 返回 `needs`（`NEEDS=needs_user_action`，退出码 **4**），含 `question` 和 `availableProfiles`；agent 应把 `question` 转述给用户，让用户在 ego 登录该店后重跑，**不要自己改映射**。
- **ego 不可用**：`PREFLIGHT` 里 `ego_not_found` → 提示安装 ego 或在 config 里用 `ego` 指定路径。
- **日期不合法/未来**：`PREFLIGHT` 里 `range_invalid` / `range_reversed` / `range_in_future` → 按 issues 修正后重跑。
- 统一原则：`needs_user_input`（退出码 3）和 `needs_user_action`（退出码 4）都是“先解决再跑”，不要盲目重试。

## 用法

```bash
node <skill目录>/run.mjs <config.json>
```

最小配置：

```json
{
  "from": "2026-10-01",
  "to": "2026-10-31",
  "root": "D:/对账账单",
  "concurrency": 2,
  "shops": [
    { "shop": "<店铺A>", "profile": "<profile-A>" },
    { "shop": "<店铺B>", "profile": "<profile-B>" }
  ]
}
```

也可只给 `from/to`，从 `<root>/_stores.json` 读店铺。

可选字段：

| 字段 | 说明 |
|---|---|
| `shops` | 店铺数组（可只写 `shop`，profile 可省，worker 会按 profile 解析/自动发现） |
| `only` | 只跑指定店铺（配合 `_stores.json`） |
| `concurrency` | 并发数，默认 3 |
| `doctor` | `true` 只读自检：近 180 天读总览（关对比）；老月份读月账单本月支出；不截图/不写文件 |
| `verifyMonthly` | 默认 `true`：整月采集后核对月账单并取精确值；设 `false` 可省一次页面跳转（最终用总览值，状态会标「已关闭核对」） |
| `root` / `storesConfig` / `ego` / `worker` / `runtimeDir` | 覆盖默认值，一般不用填 |

## 输出

```
<root>\<店铺>\<期间>\
├─ <店铺>-推广-<月>月.png      # 截图（近180天=总览页，已关对比；更早=月账单整页目标行）
├─ 推广花费.md                 # 成交花费（月账单精确值）/总览显示/月账单核对/截图/来源
└─ 账单信息.md                 # 自动写入/更新「推广花费」块（与 pdd-bills 共用）
```

- 期间目录：整月 `YYYY-MM`，区间 `YYYY-MM-DD_YYYY-MM-DD`
- 截图名：整月 `<店铺>-推广-<M>月.png`；区间 `<店铺>-推广-<M月D日-M月D日>.png`
- 写入 `账单信息.md` 用 `<!-- promo:start --> … <!-- promo:end -->` 标记；`pdd-bills` 重写账单信息时会保留该块

## 口径与规则

- **成交花费 = 推广总花费**（用户确认的唯一口径）；近期读数取指标卡「成交花费(元)」第一个数值。**注意单位**：大额会显示成 `2.21 万`（=22,100），必须换算，不能当 2.21。
- 采集时会顺手核对同月「财务流水 → 月账单」的**本月支出**：最终数值以月账单精确值为准，总览按万显示会有几十元四舍五入，差异 ≤100 元视为一致。
- **近 180 天用「商品推广总览」**；更早月份改用「财务流水 → 月账单」的 **本月支出**（同口径，月账单可翻页查到 2024/01 甚至更早）。总览页超过 180 天会显示「暂无数据」，0.00 是占位，不是真实花费。
- 截图前**关闭「对比时间」**（否则卡片会多出环比值和百分比，容易读错）。
- 日期用 URL 参数 `beginDate/endDate` 设置（页面输入框会回读校验）；格式 `YYYY/MM/DD`。**回读不一致会直接失败 `date_not_applied`（自动重试一次），绝不带着错日期读数**。
- 店铺名从页面右上角 `AccountNew_mallName` 读取并校验，不匹配会报错，不会串店。
- 采集结果包含 `spend`（最终）、`overviewSpend`、`monthlyBill`、`monthlyMatched`；读不到时状态 `warn`，不会假报成功。
- 超出 180 天的老月份：自动走月账单；老区间（跨月/非整月）仅支持整月，否则返回 `unsupported_old_range`。

## 红线

1. 不落 C 盘（默认拒绝）。
2. 不代登录；profile 未登录时停下报错。
3. 只读不点推广操作（不新建计划、不改预算、不点下载）。
4. 总览路径截图前必须关闭对比时间；数值读不到不得报成功。
5. 截图与数值必须落到 `<root>/<店铺>/<期间>/`，一店一目录、一期一目录。

## 排障

| 现象 | 处理 |
|---|---|
| `shop_not_logged_in` | ego 里没找到该店 profile；确认登录后重跑（worker 会自动扫描 profiles） |
| `spend_not_found` | 页面改版或对比未关闭；看 `_runs/.../logs/<店>.log`，按 references 调整解析 |
| 日期不对 | URL 参数被忽略时，改用 anq 日期控件（结构见 dom-contract） |
| `date_not_applied` | 页面没把日期应用成功（会重试一次后失败）；检查是否登录失效/页面改版；不会带错日期继续 |
| 页面停在登录页 | 手动登录该 profile 后重跑 |

更完整的「现象 → 根因 → 修法」见 `references/pitfalls.md`（含万单位、180 天、月账单翻页、对比开关等坑）。

## 版本

- `VERSION` / `CHANGELOG.md`；改版维护按 `references/implementation.md` 的「维护指南」。
