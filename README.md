# 数字节律家庭协商

家庭数字内容服务的"使用节律"核心：家长、青少年与学校共同约定**可解释**的使用节律，
而不是把短视频、阅读、课程粗暴算成同一种时长。

本仓库包含事件合同、事件溯源核心引擎与最小领域服务，全部为纯 JavaScript（ESM），
不含真实个人信息、生产连接或外部账号。

## 目录

- `src/culture_time_budget.js`：事件种类、枚举与负载校验（事件合同）。
- `src/events.js`：事件工厂，统一信封、时间戳与校验。
- `src/time.js`：IANA 时区下的本地日切分、夏令时安全边界、挂钟时间窗、校历。
- `src/policy.js`：版本化政策登记册（生效期选择、作用域匹配、乐观锁冲突）。
- `src/engine.js`：核心引擎（事件溯源 fold）：账本、漂移纠正、离线合并、
  延长、例外、阻断决策与解释、日结、学校汇总。
- `src/recommendations.js`：个性化建议服务，撤权硬闸门。
- `src/retention.js`：撤权后的结算争议最小留存导出。
- `data/sample.json`：基线虚构事件（旧版 `BUDGET_SET` 仍合法）。
- `tests/`：合同、夏令时/跨夜、政策并发、引擎、撤权与学校汇总测试。

## 本地核对

```bash
npm test
```

## 核心模型

### 事件是唯一事实来源

一切状态（账本、政策版本、待审批延长、例外、结账快照）都由事件流 **fold** 得到，
不接受外部直接改状态。进程重启后重放同一事件日志，结果与重启前逐字节一致；
定时日结、待审批延长、离线合并都只是同一事件流的不同投影。

事件种类：

| 类别 | 事件 |
| --- | --- |
| 基础 | `BUDGET_SET`(旧版兼容)、`CONSUMPTION_RECORDED`、`LIMIT_REACHED`、`EXCEPTION_REVIEWED`、`PROFILE_WITHDRAWN` |
| 政策 | `POLICY_DEFINED`、`POLICY_WITHDRAWN`、`CALENDAR_PUBLISHED` |
| 时钟 | `CLOCK_SYNC` |
| 延长 | `EXTENSION_REQUESTED` / `EXTENSION_APPROVED` / `EXTENSION_REJECTED` |
| 例外 | `EXCEPTION_GRANTED` / `EXCEPTION_REVOKED` |
| 结算与对外 | `DAY_CLOSED`、`SCHOOL_AGREEMENT_REGISTERED`、`SCHOOL_REPORT_DELIVERED` |

### 政策

按 **成员 + 设备 + 本地时区 + 内容类别 + 上学日类型 + 生效期** 配置：

- `scope.devices` / `scope.categories` 限定范围；同时命中多条政策时更具体者优先。
- `rules[].day_type` 区分 `SCHOOL_DAY` / `NON_SCHOOL_DAY` / `ANY`；
  校历 `CALENDAR_PUBLISHED` 显式发布上学日（含周末调休补课），未覆盖时按工作日兜底。
- 每条规则含分类预算（类别精确优先，`*` 兜底）与挂钟时间窗（`BLOCK` / `WARN`，支持跨午夜）。
- 政策不可变、版本严格递增；修订必须携带 `expected_version` 乐观锁。
  两位监护人同时编辑时，后写方收到 `VersionConflictError`，不会静默覆盖。

### 跨午夜与夏令时

所有切分在**绝对时间（UTC 毫秒）**上进行，再映射回成员政策时区的本地日：

- 跨午夜会话按日界切成时间片，分别归属与扣减。
- 春跳日 23 小时、秋回日 25 小时、甚至午夜直接跳变（哈瓦那春跳 00:00 被跳过）
  都不丢秒、不重秒——因为本地日边界只是该时区下的某个 UTC 时刻。

### 离线补传与时钟漂移

- 消费只存原始设备时间；读取时用全部 `CLOCK_SYNC` 锚点线性插值纠正。
  同步点早到或晚到、补传乱序，派生出的时间片与扣减始终相同。
- 两级幂等：`event_id` 与 `(成员,设备,idempotency_key)`。设备反复重试/补传同一条
  记录不会二次扣减预算。
- 日结冻结快照后到达的该日补传不改动快照，进入迟到挂起列表供结算争议复核。

### 临时延长

成员提出（`EXTENSION_REQUESTED`）→ 监护人批准（`EXTENSION_APPROVED`）。
批准只能在申请范围内**收紧**（更少分钟、更短有效期、同类别同设备），不能借批准扩大范围。
延长是"加时"：基础额度用尽后才启用，锚定到 `valid_from` 所在本地日，跨午夜不重复计分钟。

### 明确例外（不会变成永久绕过）

`EMERGENCY_CONTACT` 凭 `contact_ref == grant_ref`、`DOWNLOADED_LESSON` 凭 `lesson_id`
且 `downloaded=true` 匹配。每次授予都必须有：有效期（`valid_from/to`）、当日用量上限
（`usage_cap_minutes`）、可审计凭证（`grant_ref`）。例外在额度内绕过预算与静默窗，
超出上限的部分回到常规判定；到期或被撤回立即失效。

分配优先级：**例外（带上限）→ 静默窗阻断 → 基础预算 → 延长 → 超时**。

### 可解释性

`evaluate()` 返回 `ALLOWED / WARNED / BLOCKED`，`explain()` 给出每次判定的依据：
政策 `policy_id` 与 `version`、本地日与日类型来源、生效的时间窗、基础/延长额度与已用量、
命中的例外（类型、编号、用量）、逐时间片的池子归属。

### 撤权与最小留存

- `PROFILE_WITHDRAWN` 是个性化建议的**硬闸门**：撤权后既不生成新建议，
  撤权前生成、撤权后才展示的建议也不可交付。政策执行与日结不受影响。
- 撤权后唯一允许的数据出口是结算争议包（`buildDisputePack`）：只含按日按类别的
  秒数与池子归属、政策版本、审批编号、例外类型/用量、结账快照与迟到补传；
  课程身份、紧急联系人、原始时钟读数、建议历史一律剔除，并有 `assertMinimal` 防回归。

### 学校汇总

学校只能取 `SCHOOL_AGREEMENT_REGISTERED` 约定范围内的成员、类别、字段与日期，
且只有按日按类别的粗粒度聚合（`DAILY_TOTALS_BY_CATEGORY` / `DAILY_LIMIT_HITS` /
`POLICY_COMPLIANCE_RATE`），优先使用结账冻结快照。任何越界字段或无协议期间直接拒绝；
实际对外交付用 `SCHOOL_REPORT_DELIVERED` 留审计痕。

## 测试与需求对应

- 夏令时：`tests/time_dst.test.js`（纽约春跳/秋回、哈瓦那午夜跳变）、
  `tests/engine.test.js`（引擎层春跳/午夜跳变会话）。
- 跨夜：`tests/time_dst.test.js`、`tests/engine.test.js`（跨午夜切分与分别扣减）。
- 漂移与离线：`tests/engine.test.js`（CLOCK_SYNC 纠正、同步点晚到不重扣、
  业务键幂等、结账后迟到补传）。
- 并发改策：`tests/policy.test.js`（乐观锁版本冲突、冲突后不被覆盖）。
- 延长与例外：`tests/engine.test.js`（申请-批准范围、到期/撤回、上限、紧急联系静默窗）。
- 撤权：`tests/privacy.test.js`（建议闸门、撤权前生成撤权后不交付、最小争议包）。
- 学校：`tests/school.test.js`（范围限制、越界拒绝、交付审计）。
- 重启一致性：`tests/engine.test.js`（完整重放账本/待审批/日结一致、日结补跑一致）。
