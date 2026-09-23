import assert from "node:assert/strict";
import test from "node:test";
import { RhythmEngine, EngineError } from "../src/engine.js";
import { events as e } from "../src/events.js";
import { engineWithPolicy, TZ_NY, TZ_HAVANA } from "./helpers.js";

const MIN = 60;

test("跨午夜会话切到两个本地日并分别扣减", () => {
  const eng = engineWithPolicy({ now: "2026-09-22T12:00:00+08:00" });
  // 2026-09-21(周一上学日) 23:50 -> 09-22(周二) 00:20，短视频 30 分钟
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T23:50:00+08:00",
    ended_at: "2026-09-22T00:20:00+08:00",
    idempotency_key: "k1",
  }));
  const d1 = eng.allocateDay("teen", "phone", "SHORT_VIDEO", "2026-09-21");
  const d2 = eng.allocateDay("teen", "phone", "SHORT_VIDEO", "2026-09-22");
  assert.equal(d1.window_blocked_seconds, 10 * MIN); // 23:50-24:00 在静默窗内
  assert.equal(d1.regular_used_seconds, 0);
  assert.equal(d2.window_blocked_seconds, 20 * MIN); // 00:00-00:20 落静默窗
  assert.equal(d1.policy.version, 1);
});

test("预算用尽后阻断，并给出可解释的政策版本与时间片", () => {
  const eng = engineWithPolicy();
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 30 * MIN,
    idempotency_key: "used",
  }));
  const decision = eng.evaluate("teen", "phone", "SHORT_VIDEO",
    Date.parse("2026-09-21T19:31:00+08:00"), { durationSeconds: 60 });
  assert.equal(decision.outcome, "BLOCKED");
  assert.deepEqual(decision.reasons, ["BUDGET_EXHAUSTED"]);
  assert.equal(decision.explanation.policy.policy_id, "POL-MAIN");
  assert.equal(decision.explanation.policy.version, 1);
  assert.equal(decision.explanation.local_date, "2026-09-21");
  assert.equal(decision.explanation.day_type, "SCHOOL_DAY");
  assert.equal(decision.explanation.usage.used_minutes, 30);
});

test("WARN 窗产生提醒而非阻断", () => {
  const eng = engineWithPolicy({
    rules: [{ day_type: "ANY", windows: [{ start: "20:00", end: "21:00", action: "WARN" }] }],
  });
  const r = eng.evaluate("teen", "phone", "SHORT_VIDEO", Date.parse("2026-09-21T20:30:00+08:00"));
  assert.equal(r.outcome, "WARNED");
  assert.deepEqual(r.reasons, ["WINDOW_WARN"]);
});

test("重复 event_id 与重复业务键都不会二次扣减", () => {
  const eng = engineWithPolicy();
  const mk = () => e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 10 * MIN,
    idempotency_key: "dup",
  });
  assert.equal(eng.append(mk()).accepted, true);
  assert.deepEqual(eng.append(mk()), { accepted: false, duplicated: true, reason: "event_id" });
  // 设备离线重试用新 event_id 但同业务键
  const again = mk();
  again.event_id = "cons_dup_redelivered";
  assert.deepEqual(eng.append(again), { accepted: false, duplicated: true, reason: "idempotency_key" });
  const alloc = eng.allocateDay("teen", "phone", "SHORT_VIDEO", "2026-09-21");
  assert.equal(alloc.regular_used_seconds, 10 * MIN);
});

test("设备时钟漂移经 CLOCK_SYNC 纠正后归属正确日期", () => {
  const eng = engineWithPolicy();
  // 设备慢 10 分钟：设备显示 23:55，真实已是 09-22 00:05
  eng.append(e.clockSync("phone", "teen",
    "2026-09-21T23:55:00+08:00", "2026-09-22T00:05:00+08:00",
    "2026-09-22T00:05:00+08:00"));
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    // 设备记录的时间：23:50-23:55（看似 09-21），真实应为 00:00-00:05（09-22）
    started_at: "2026-09-21T23:50:00+08:00", ended_at: "2026-09-21T23:55:00+08:00",
    idempotency_key: "drift",
  }, "2026-09-22T00:10:00+08:00"));
  const slices = eng.slicesFor("teen");
  const s = slices.find((x) => x.key.endsWith("drift"));
  assert.equal(s.local_date, "2026-09-22");
  assert.equal(new Date(s.start_ms).toISOString(), "2026-09-21T16:00:00.000Z"); // 00:00 +08
});

test("CLOCK_SYNC 晚于补传到达时，重算后归属与扣减仍一致（不重复扣减）", () => {
  const eng = engineWithPolicy();
  // 先补传（无锚点，按设备自报时间，落在 09-21 白天）
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T12:00:00+08:00", duration_seconds: 10 * MIN,
    idempotency_key: "late-sync",
  }, "2026-09-22T09:00:00+08:00"));
  assert.equal(
    eng.slicesFor("teen").find((x) => x.key.endsWith("late-sync")).local_date,
    "2026-09-21");
  // 同步点表明设备快了 12 小时：真实发生在 09-21 00:00（静默窗）
  eng.append(e.clockSync("phone", "teen",
    "2026-09-21T12:00:00+08:00", "2026-09-21T00:00:00+08:00",
    "2026-09-22T09:05:00+08:00"));
  const s = eng.slicesFor("teen").find((x) => x.key.endsWith("late-sync"));
  assert.equal(s.local_date, "2026-09-21");
  assert.equal(new Date(s.start_ms).toISOString(), "2026-09-20T16:00:00.000Z");
  const alloc = eng.allocateDay("teen", "phone", "SHORT_VIDEO", "2026-09-21");
  assert.equal(alloc.window_blocked_seconds, 10 * MIN);
  assert.equal(alloc.regular_used_seconds, 0);
  // 只有一条会话，没有因重算翻倍
  assert.equal(eng.slicesFor("teen").length, 1);
});

test("临时延长：成员申请、监护人批准后加时；范围不可被批准扩大", () => {
  const eng = engineWithPolicy();
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 30 * MIN, idempotency_key: "base",
  }));
  eng.append(e.extensionRequested("teen", {
    request_id: "X1", requested_by: "teen", extra_minutes: 20,
    valid_to: "2026-09-21T23:59:00+08:00", category: "SHORT_VIDEO", device_id: "phone",
  }, "2026-09-21T19:30:00+08:00"));
  // 待审批在重启前可见
  assert.equal(eng.pendingExtensions("teen").length, 1);
  // 监护人试图批准更多分钟 -> 拒绝
  assert.throws(() => eng.append(e.extensionApproved("teen", {
    request_id: "X1", approved_by: "mom", extra_minutes: 40,
    valid_from: "2026-09-21T19:30:00+08:00", valid_to: "2026-09-21T23:59:00+08:00",
    category: "SHORT_VIDEO", device_id: "phone",
  })), /超过申请/);
  // 正确批准 20 分钟
  eng.append(e.extensionApproved("teen", {
    request_id: "X1", approved_by: "mom", extra_minutes: 20,
    valid_from: "2026-09-21T19:30:00+08:00", valid_to: "2026-09-21T23:59:00+08:00",
    category: "SHORT_VIDEO", device_id: "phone",
  }, "2026-09-21T19:31:00+08:00"));
  assert.equal(eng.pendingExtensions("teen").length, 0);
  // 再用 15 分钟：基础已尽，走延长
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:31:00+08:00", duration_seconds: 15 * MIN, idempotency_key: "extra",
  }));
  const alloc = eng.allocateDay("teen", "phone", "SHORT_VIDEO", "2026-09-21");
  assert.equal(alloc.extension_used_seconds, 15 * MIN);
  assert.equal(alloc.overrun_seconds, 0);
  assert.equal(alloc.extension_grants[0].approved_by, "mom");
  // 第 46-50 分钟仍可用延长，第 51 分钟起超时
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:46:00+08:00", duration_seconds: 10 * MIN, idempotency_key: "over",
  }));
  const a2 = eng.allocateDay("teen", "phone", "SHORT_VIDEO", "2026-09-21");
  assert.equal(a2.extension_used_seconds, 20 * MIN);
  assert.equal(a2.overrun_seconds, 5 * MIN);
});

test("批准无对应申请的延长被拒绝", () => {
  const eng = engineWithPolicy();
  assert.throws(() => eng.append(e.extensionApproved("teen", {
    request_id: "GHOST", approved_by: "mom", extra_minutes: 10,
    valid_from: "2026-09-21T19:00:00+08:00", valid_to: "2026-09-21T20:00:00+08:00",
  })), /没有对应的申请/);
});

test("下载课程例外在凭证匹配且上限内绕过预算，超上限/课程不符不绕过", () => {
  const eng = engineWithPolicy(); // 政策未给 LESSON 预算 => 默认不限；改为显式 0 验证例外
  eng.append(e.policyDefined("teen", {
    policy_id: "P2", version: 1, timezone: "Asia/Shanghai", created_by: "mom",
    effective_from: "2026-09-01T00:00:00+08:00",
    scope: { categories: ["LESSON"] },
    rules: [{ day_type: "ANY", budgets: [{ category: "LESSON", daily_limit_minutes: 0 }] }],
  }));
  eng.append(e.exceptionGranted("teen", {
    exception_id: "EX-LE", type: "DOWNLOADED_LESSON",
    valid_from: "2026-09-21T00:00:00+08:00", valid_to: "2026-09-21T23:59:00+08:00",
    usage_cap_minutes: 30, grant_ref: "ORDER-1", lesson_id: "L99", device_id: "phone",
  }));
  // 45 分钟：30 走例外，15 计超时
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "LESSON",
    started_at: "2026-09-21T10:00:00+08:00", duration_seconds: 45 * MIN,
    downloaded: true, lesson_id: "L99", idempotency_key: "le1",
  }));
  const alloc = eng.allocateDay("teen", "phone", "LESSON", "2026-09-21");
  assert.equal(alloc.exception_used_seconds, 30 * MIN);
  assert.equal(alloc.overrun_seconds, 15 * MIN);
  // 课程 id 不符：不享例外
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "LESSON",
    started_at: "2026-09-21T11:00:00+08:00", duration_seconds: 5 * MIN,
    downloaded: true, lesson_id: "L-OTHER", idempotency_key: "le2",
  }));
  const a2 = eng.allocateDay("teen", "phone", "LESSON", "2026-09-21");
  assert.equal(a2.overrun_seconds, 20 * MIN);
});

test("紧急联系在静默时段凭凭证放行，超过当日上限部分仍阻断", () => {
  const eng = engineWithPolicy({
    rules: [{ day_type: "ANY", windows: [{ start: "22:00", end: "06:00", action: "BLOCK" }] }],
  });
  eng.append(e.exceptionGranted("teen", {
    exception_id: "EX-EM", type: "EMERGENCY_CONTACT",
    valid_from: "2026-09-21T22:00:00+08:00", valid_to: "2026-09-22T06:00:00+08:00",
    usage_cap_minutes: 10, grant_ref: "EMG-911",
  }));
  // 无凭证声明 -> 阻断
  const noClaim = eng.evaluate("teen", "phone", "EMERGENCY",
    Date.parse("2026-09-21T23:00:00+08:00"), { durationSeconds: 600 });
  assert.equal(noClaim.outcome, "BLOCKED");
  // 15 分钟请求：例外 10 分钟放行，5 分钟阻断
  const r = eng.evaluate("teen", "phone", "EMERGENCY",
    Date.parse("2026-09-21T23:00:00+08:00"),
    { durationSeconds: 900, exceptionClaim: { contact_ref: "EMG-911" } });
  assert.equal(r.outcome, "BLOCKED");
  assert.ok(r.reasons.includes("EXCEPTION_PARTIAL"));
  assert.equal(r.allowed_seconds, 600);
  assert.equal(r.blocked_seconds, 300);
  // 5 分钟请求：完全在例外内
  const ok = eng.evaluate("teen", "phone", "EMERGENCY",
    Date.parse("2026-09-21T23:00:00+08:00"),
    { durationSeconds: 300, exceptionClaim: { contact_ref: "EMG-911" } });
  assert.equal(ok.outcome, "ALLOWED");
  assert.ok(ok.reasons.includes("EXCEPTION_ALLOWED"));
});

test("例外到期或被撤回后不再放行，不会变成永久绕过", () => {
  const eng = engineWithPolicy({
    rules: [{ day_type: "ANY", windows: [{ start: "22:00", end: "06:00", action: "BLOCK" }] }],
  });
  eng.append(e.exceptionGranted("teen", {
    exception_id: "EX", type: "EMERGENCY_CONTACT",
    valid_from: "2026-09-21T22:00:00+08:00", valid_to: "2026-09-21T23:00:00+08:00",
    usage_cap_minutes: 60, grant_ref: "EMG-1",
  }));
  // 有效期内 22:30 放行
  let r = eng.evaluate("teen", "phone", "EMERGENCY", Date.parse("2026-09-21T22:30:00+08:00"),
    { durationSeconds: 60, exceptionClaim: { contact_ref: "EMG-1" } });
  assert.equal(r.outcome, "ALLOWED");
  // 23:30 已过期 -> 阻断
  r = eng.evaluate("teen", "phone", "EMERGENCY", Date.parse("2026-09-21T23:30:00+08:00"),
    { durationSeconds: 60, exceptionClaim: { contact_ref: "EMG-1" } });
  assert.equal(r.outcome, "BLOCKED");
  // 新的长期例外被撤回
  eng.append(e.exceptionGranted("teen", {
    exception_id: "EX2", type: "EMERGENCY_CONTACT",
    valid_from: "2026-09-22T22:00:00+08:00", valid_to: "2026-12-31T23:59:00+08:00",
    usage_cap_minutes: 600, grant_ref: "EMG-2",
  }));
  eng.append(e.exceptionRevoked("teen", "EX2", "mom", "2026-09-22T22:30:00+08:00", "误授权"));
  r = eng.evaluate("teen", "phone", "EMERGENCY", Date.parse("2026-09-22T22:31:00+08:00"),
    { durationSeconds: 60, exceptionClaim: { contact_ref: "EMG-2" } });
  assert.equal(r.outcome, "BLOCKED");
  assert.equal(eng.activeExceptions("teen", "phone", Date.parse("2026-09-22T22:31:00+08:00")).length, 0);
});

test("结账后迟到补传不改动冻结快照，但进入争议挂起列表", () => {
  const clock = { t: Date.parse("2026-09-22T08:00:00+08:00") };
  const eng = engineWithPolicy({ now: undefined });
  eng._now = () => clock.t;
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 30 * MIN, idempotency_key: "ontime",
  }));
  eng.closeDay("teen", "2026-09-21");
  const frozen = eng.closedDays.get("teen").get("2026-09-21").totals.SHORT_VIDEO.minutes;
  assert.equal(frozen, 30);
  // 次日离线补传前一天的 10 分钟
  clock.t = Date.parse("2026-09-22T09:00:00+08:00");
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T18:00:00+08:00", duration_seconds: 10 * MIN, idempotency_key: "late1",
  }, "2026-09-22T09:00:00+08:00"));
  // 冻结快照不变
  assert.equal(eng.closedDays.get("teen").get("2026-09-21").totals.SHORT_VIDEO.minutes, 30);
  const late = eng.lateArrivals("teen", "2026-09-21");
  assert.equal(late.length, 1);
  assert.ok(late[0].key.endsWith("late1"));
});

test("定时日结在重启后补跑结果一致", () => {
  function buildAndClose(at) {
    const eng = engineWithPolicy({ now: at });
    eng.append(e.consumption("teen", {
      device_id: "phone", category: "SHORT_VIDEO",
      started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 20 * MIN, idempotency_key: "k",
    }));
    eng.closeDueDays("teen", Date.parse(at));
    return eng;
  }
  const a = buildAndClose("2026-09-22T08:00:00+08:00");
  // 模拟重启：新引擎重放事件日志后再补跑日结
  const b = new RhythmEngine({ now: () => Date.parse("2026-09-22T08:00:00+08:00") });
  b.replay(a.eventLog.filter((ev) => ev.kind !== "DAY_CLOSED"));
  b.closeDueDays("teen", Date.parse("2026-09-22T08:00:00+08:00"));
  assert.deepEqual(
    b.dailyTotals("teen", "2026-09-21"),
    a.dailyTotals("teen", "2026-09-21"),
  );
  assert.ok(b.closedDays.get("teen").has("2026-09-21"));
});

test("重启重放完整事件日志：账本、待审批延长、日结全部一致", () => {
  const eng = engineWithPolicy();
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 25 * MIN, idempotency_key: "k",
  }));
  eng.append(e.extensionRequested("teen", {
    request_id: "PEND1", requested_by: "teen", extra_minutes: 15,
    valid_to: "2026-09-22T23:59:00+08:00", category: "SHORT_VIDEO",
  }, "2026-09-22T10:00:00+08:00"));
  eng.closeDay("teen", "2026-09-21");

  const rebuilt = new RhythmEngine();
  rebuilt.replay(eng.eventLog);
  assert.deepEqual(rebuilt.dailyTotals("teen", "2026-09-21"), eng.dailyTotals("teen", "2026-09-21"));
  assert.equal(rebuilt.pendingExtensions("teen").length, 1);
  assert.equal(rebuilt.pendingExtensions("teen")[0].request_id, "PEND1");
  assert.ok(rebuilt.closedDays.get("teen").has("2026-09-21"));
  assert.equal(rebuilt.eventLog.length, eng.eventLog.length);
});

test("春跳日整日时长为 23 小时，跨春跳会话秒数守恒", () => {
  const eng = engineWithPolicy({ timezone: TZ_NY, effectiveFrom: "2026-03-01T00:00:00-05:00" });
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-03-08T01:30:00-05:00", ended_at: "2026-03-08T04:30:00-04:00",
    idempotency_key: "spring",
  }));
  const s = eng.slicesFor("teen");
  assert.equal(s.length, 1);
  assert.equal(s[0].local_date, "2026-03-08");
  assert.equal(s[0].seconds, 7200); // 实际经过 2 小时，不因少了一个挂钟小时而变 3 小时
});

test("午夜跳变时区（哈瓦那春跳）跨夜会话正确归属", () => {
  const eng = engineWithPolicy({ timezone: TZ_HAVANA, effectiveFrom: "2026-03-01T00:00:00-05:00" });
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-03-07T23:30:00-05:00", ended_at: "2026-03-08T02:30:00-04:00",
    idempotency_key: "havana",
  }));
  const dates = eng.slicesFor("teen").map((x) => [x.local_date, x.seconds]);
  assert.deepEqual(dates, [["2026-03-07", 1800], ["2026-03-08", 5400]]);
});

test("没有适用政策时消费被拒绝入帐而非计入默认桶", () => {
  const eng = new RhythmEngine();
  assert.throws(() => eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 60, idempotency_key: "orphan",
  })), /没有适用政策/);
});
