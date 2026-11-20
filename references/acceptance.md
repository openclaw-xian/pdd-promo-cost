# 交付验收清单（Definition of Done）

> 目标：陌生人**只读 `SKILL.md` + `references/`**（不看聊天记录/开发过程），也能独立跑通。
> 本清单同时是此 skill 的验收记录；每次发版前逐项自检。

## 1. 交付项（11 条）

| # | 项 | 位置 | 本 skill 状态 |
|---|---|---|---|
| 1 | 触发/入口：何时用、何时不用 | `SKILL.md` frontmatter + 用法 | ✅ |
| 2 | 前置条件 + doctor 自检 | `SKILL.md` / `references/implementation.md` | ✅ |
| 3 | 用法与配置示例（近期/老月份/多店/自检） | `SKILL.md`、`examples/` | ✅ |
| 4 | 页面契约（URL、选择器、单位、表格列） | `references/dom-contract.md` | ✅ |
| 5 | 完整流程与实现 | `references/implementation.md` | ✅ |
| 6 | 踩坑表（现象 → 根因 → 修法） | `references/pitfalls.md` | ✅ |
| 7 | 测试矩阵与真实数字（含交叉核对） | `references/testing.md` | ✅ |
| 8 | 校验 / 失败 / 幂等 / 重试 | `SKILL.md`、`implementation.md`、`pitfalls.md` | ✅ |
| 9 | 输出与命名规范 | `SKILL.md`「输出」 | ✅ |
| 10 | 无真实店铺名/账号/机器路径；VERSION/CHANGELOG | 全目录抽查 | ✅（示例用 `<店铺A>` 占位） |
| 11 | 陌生人走查：按下面步骤独立跑一遍 | 见 §2 | ✅（见 §4） |

## 2. 陌生人走查（约 15 分钟）

1. **安装**：把目录复制/联接到 `~/.agents/skills/pdd-promo-cost`（Windows 可用 `mklink /J`）。
2. **语法**：
   ```bash
   node --check run.mjs
   node --check worker-promo.mjs
   ```
3. **店铺清单（可以跳过）**：首次运行会自动扫描 ego profiles 生成 `<root>/_stores.json`；也可复制 `examples/stores.example.json` 手工填，或在 config 里直接写 `shops`。
4. **自检**：复制 `examples/doctor-config.example.json`，替换店铺；运行：
   ```bash
   node run.mjs doctor.json
   ```
   期望：退出码 0，`DOCTOR_RESULT` 里 `status=doctor_ok` 且有 `spend`；**不截图、不写账单目录**。
5. **近期整月**：复制 `examples/promo-config.example.json`，替换店铺/期间；也可以完全不写店铺，交给自动发现。运行后检查：
   - `<root>/<店铺>/<期间>/` 下有 `<店铺>-推广-<月>月.png`、`推广花费.md`、`账单信息.md`
   - `推广花费.md` 里有「成交花费」「总览显示」「月账单本月支出」「与月账单核对」
6. **老月份**（如 2025-09）：同样配置运行；期望自动走「财务流水 → 月账单」，`推广花费.md` 来源为月账单，截图是月账单目标行。
7. **错误路径**：
   - 不存在的店铺 → `NEEDS=needs_user_action`（退出码 **4**），含 `question` + `availableProfiles`
   - 超出 180 天的非整月区间 → `unsupported_old_range`
   - root 在 C 盘且无 `allowC` → `PREFLIGHT=needs_user_input`（退出码 3）
   - 缺 `_stores.json` 且 ego 里没有已登录店铺 → `PREFLIGHT` 的 `stores_not_logged_in`
8. **报告**：检查 `<root>/_runs/<runId>/report.json` 与 `summary.txt`（含 `needs` 字段）。
9. **抽查**：在 skill 目录 grep 真实店铺名/账号，应为 0 命中（示例占位除外）。

## 3. 状态 / 退出码

| 输出 | 含义 | 处理 |
|---|---|---|
| `ROOT_AUTO_CREATED=...` | 根目录不存在，已自动创建（非 C 盘） | 无需处理，继续 |
| `STORES_DISCOVERED=N -> ...` | 没有店铺清单，自动扫描 ego 生成 | 无需处理，继续 |
| `PREFLIGHT=needs_user_input`（exit 3） | 日期/根目录/ego/店铺清单有问题 | 按 issues 修正后重跑；不盲目重试 |
| `NEEDS=needs_user_action`（exit 4） | 店铺未登录/找不到 | 把 `question` 转给用户登录后重跑 |
| `FAILED=job_failed`（exit 5） | 有任务失败（非 needs） | 查 `_runs/.../logs`，修后重跑 |
| `status=done` | 采集成功 | 可验收 |
| `status=warn` | 读不到数值，或总览与月账单差 >100 元 | 查 `_runs/.../logs`，人工核对；report 里看 `monthlyBillStatus` |
| `status=no_data` | 总览暂无数据且无法回退月账单（非整月） | 改成整月或换期间 |
| `status=unsupported_old_range` | 超 180 天的区间非整月 | 只支持整月 |
| `shop_not_logged_in` | profile 未登录或找不到 | 让用户登录对应店铺 |
| `doctor_ok` / `doctor_no_data` | 自检结果 | 老月份现在也能 doctor（读月账单本月支出） |

## 4. 最近验收记录

- **0.4.1（2026-11-20）**：
  - 稳定性：日期回读硬校验（失败重试 1 次）、月账单行重试 1 次、店铺发现重试 1 次。
  - 3 店 2026-10 连续跑 2 次数值一致（3,217.62 / 9,243.71 / 2,570.64）；老月份 2025-09 = 3,379.03 复测一致。
- **0.4.0（2026-11-20）**：
  - `verifyMonthly` 默认核对，final spend 取月账单；`verifyMonthly:false` 时 5.3s 完成、状态标「已关闭核对」。
  - report 增加 `overviewSpend/monthlyBill/monthlyMatched/monthlyBillStatus`；失败 exit 5。
  - 老月份截图改 fullPage（含店铺与目标行）；doctor 老月份返回 `doctor_ok` + `source=monthly_bill`（2025-09=3,379.03，不写文件）。
  - `node --check` 通过；近 180 天与老月份重跑数值不变。
- **0.3.0（2026-11-20）**：
  - 自动建根目录 + 自动发现店铺：临时 root `D:/_pdd-promo-accept`、不写 `shops` → `ROOT_AUTO_CREATED` / `STORES_DISCOVERED=3`，随后 3 店 2026-10 全部 done（3,217.62 / 9,243.71 / 2,570.64）。
  - 未登录店铺：`不存在店X` → `NEEDS=needs_user_action`，含 `question` 与可用 profiles，退出码 **4**。
  - 安装 junction 路径跑 `doctor`（2026-10，店铺C）：`doctor_ok`、`spend=3,217.62`，未产生文件；`node --check` 通过。
- **近 180 天交叉核对**：店铺 A/B/C × 2026-06~10 共 15 组，全部与月账单一致（A/B 6~8 月差异 49~92 元，均来自「万」显示取整），见 `testing.md`。
- **老月份**：2025-09（3,379.03，月账单）；2024-12（51,848.08 = 现金 51,523.34 + 红包 324.74），余额恒等式自洽。
- **踩坑回归**：万/亿单位、180 天边界、月账单翻页、对比时间、店铺名未读数前缀，均在 `pitfalls.md` 有「现象→根因→修法」。
