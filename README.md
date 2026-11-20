# pdd-promo-cost

拼多多多店铺「推广花费」采集 —— **DeepSeek Harness (DSH) skill**。

按店铺 × 期间采集多多招财的**推广花费（成交花费 = 推广总花费）**，落到 `<账单根目录>/<店铺>/<期间>/`：

- **近 180 天**：打开「商品推广总览」，关闭「对比时间」，截图并读取成交花费；再用「财务流水 → 月账单」同月「本月支出」核对，最终值取月账单精确值（总览按万显示会有几十元四舍五入）
- **更早月份**：总览已无数据，直接读「财务流水 → 月账单」的本月支出（支持翻页，可追溯 2024/01 及更早）
- 多店并发、自动找店（profile → 店铺名自动匹配/发现）
- 截图命名 `<店铺>-推广-<月>月.png`
- 写入 `推广花费.md`，并把数值写进同期 `账单信息.md`（与 `pdd-bills` 共用）
- 不含本机路径/账号/店铺名

## 安装

把本目录复制/联接到 `~/.agents/skills/pdd-promo-cost` 即可（普通 skill 目录，无需额外脚本）：

```bash
mkdir -p ~/.agents/skills
cp -r . ~/.agents/skills/pdd-promo-cost
```

> Windows 目录联接：`mklink /J C:\Users\<你>\.agents\skills\pdd-promo-cost <本仓库路径>`

版本见 [`VERSION`](VERSION)，变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 前置条件

- Windows + ego-browser（各店 profile 已登录）
- Node.js
- 账单根目录（默认 `D:/对账账单`，非 C 盘；不存在会自动创建，配置 `root` 可改）

## 用法

```bash
node <skill目录>/run.mjs <config.json>
```

最小配置：

```json
{ "from": "2026-10-01", "to": "2026-10-31", "concurrency": 2 }
```

店铺来源：配置 `shops`，或 `<root>/_stores.json`；**两者都可以不给**——首次运行会自动扫描 ego profiles 生成 `_stores.json`。

遇到条件不满足时：
- 根目录不存在（非 C 盘）→ 自动创建
- 没有店铺清单 → 自动发现店铺
- 店铺没登录/找不到 → 输出 `NEEDS=needs_user_action`（退出码 4）和要转给用户的问题
- 其它配置问题 → `PREFLIGHT=needs_user_input`（退出码 3）

示例：`examples/promo-config.example.json`、`examples/doctor-config.example.json`、`examples/stores.example.json`；交付验收/陌生人走查见 [references/acceptance.md](references/acceptance.md)。

自检（只读，不截图/不写文件）：`{ "doctor": true, "from": "...", "to": "..." }`

详细规则见 [SKILL.md](SKILL.md)；页面契约/实现/测试见 [references/](references/)。
