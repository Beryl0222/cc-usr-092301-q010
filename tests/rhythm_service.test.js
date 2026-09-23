import assert from "node:assert/strict";
import test from "node:test";
import { PolicyConflictError, RhythmService } from "../src/rhythm_service.js";

const GUARDIAN = { id: "g1", role: "guardian" };

function homePolicy(svc, over = {}) {
  return svc.setPolicy({
    policyId: "home",
    scope: { member_id: "m1", ...(over.scope ?? {}) },
    timeZone: over.timeZone ?? "Asia/Shanghai",
    dailyLimits: over.limits ?? { short_video: 3600, reading: 1800 },
    windows: over.windows ?? [],
    effectiveFrom: over.effectiveFrom ?? "2026-09-01T00:00:00+08:00",
    effectiveTo: over.effectiveTo ?? null,
    schoolCalendar: over.schoolCalendar ?? null,
    actor: GUARDIAN,
    occurredAt: over.occurredAt ?? "2026-09-01T00:00:00+08:00",
  });
}

test("不同内容类别分别计额：阅读不占用短视频预算，阻断依据可解释", () => {
  const svc = new RhythmService();
  homePolicy(svc);

  svc.recordConsumption({
    recordId: "r-reading",
    memberId: "m1",
    deviceId: "phone",
    category: "reading",
    startedAt: "2026-09-21T19:00:00+08:00",
    endedAt: "2026-09-21T19:30:00+08:00",
  });
  svc.recordConsumption({
    recordId: "r-video-1",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T20:00:00+08:00",
    endedAt: "2026-09-21T20:54:00+08:00", // 3240s = 90%
  });

  const near = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T20:55:00+08:00" });
  assert.equal(near.mode, "reminder");
  assert.equal(near.basis.daily_limit_seconds, 3600);
  assert.equal(near.basis.used_seconds, 3240);
  assert.equal(near.basis.policy.version, 1);

  const interventions = svc.interventions();
  const videoReminder = interventions.find((i) => i.category === "short_video" && i.mode === "reminder");
  assert.ok(videoReminder);
  const basis = videoReminder.basis;
  assert.equal(basis.local_date, "2026-09-21");
  assert.equal(basis.day_kind, "school");
  assert.equal(basis.time_slice.duration_seconds, 3240);
  assert.deepEqual(basis.contributing_record_ids, ["r-video-1"]);

  svc.recordConsumption({
    recordId: "r-video-2",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T20:54:00+08:00",
    endedAt: "2026-09-21T21:06:00+08:00", // +720s，达到 3960s
  });
  const blocked = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T21:07:00+08:00" });
  assert.equal(blocked.mode, "block");
  assert.equal(blocked.reason, "daily_limit_exceeded");
  assert.equal(blocked.basis.used_seconds, 3960);
});

test("跨午夜会话切到正确本地日期，两日本身的预算互不挤占", () => {
  const svc = new RhythmService();
  homePolicy(svc, { limits: { short_video: 1200 } });

  svc.recordConsumption({
    recordId: "r-night",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T23:50:00+08:00",
    endedAt: "2026-09-22T00:10:00+08:00",
  });
  // 9-21（周一）与 9-22（周二）各 600s，均未触限。
  assert.equal(svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T23:59:00+08:00" }).mode, "allow");
  assert.equal(svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-22T00:09:00+08:00" }).mode, "allow");
  assert.deepEqual(Object.keys(svc.ledgerView("m1", "2026-09-21")), ["short_video"]);
  assert.equal(svc.ledgerView("m1", "2026-09-21").short_video.used_seconds, 600);
  assert.equal(svc.ledgerView("m1", "2026-09-22").short_video.used_seconds, 600);
});

test("离线补传：设备时钟快两小时，由服务器首见时刻夹回，不会记到未来日期", () => {
  const svc = new RhythmService();
  homePolicy(svc);

  // 设备声称 22:00-22:30（本地），实际发生在 20:00-20:30；20:31 上线补传。
  const result = svc.recordConsumption({
    recordId: "offline-1",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T22:00:00+08:00",
    endedAt: "2026-09-21T22:30:00+08:00",
    serverWindow: {
      first_seen_at: "2026-09-21T20:31:00+08:00",
      last_seen_at: "2026-09-21T20:31:00+08:00",
      max_skew_seconds: 7200,
    },
  });
  assert.equal(result.duplicate, false);
  const slice = result.decision.slices[0];
  assert.equal(slice.local_date, "2026-09-21");
  assert.ok(Date.parse(slice.end_at) <= Date.parse("2026-09-21T20:31:00+08:00"));
  // 夹取后的时长不超过真实 30 分钟（±漂移窗口与首见交集的上界）。
  assert.ok(slice.duration_seconds <= 1860);
});

test("同一条补传记录重传与重叠区间都不会反复扣减预算", () => {
  const svc = new RhythmService();
  homePolicy(svc, { limits: { short_video: 3600 } });

  const args = {
    recordId: "dup-1",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T10:00:00+08:00",
    endedAt: "2026-09-21T10:30:00+08:00",
  };
  svc.recordConsumption(args);
  const again = svc.recordConsumption(args);
  assert.equal(again.duplicate, true);
  assert.equal(svc.ledgerView("m1", "2026-09-21").short_video.used_seconds, 1800);

  // 另一条记录与前一条有 10 分钟重叠，重叠部分不二次扣减。
  svc.recordConsumption({
    recordId: "dup-2",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T10:20:00+08:00",
    endedAt: "2026-09-21T10:50:00+08:00",
  });
  assert.equal(svc.ledgerView("m1", "2026-09-21").short_video.used_seconds, 3000); // 30 + 20 分钟

  // 时钟纠偏后重报同一使用段（不同 record_id 但同设备区间重叠），同样不重复扣减。
  svc.recordConsumption({
    recordId: "dup-3",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T10:20:05+08:00",
    endedAt: "2026-09-21T10:49:55+08:00",
  });
  assert.equal(svc.ledgerView("m1", "2026-09-21").short_video.used_seconds, 3000);
});

test("不同设备独立计额", () => {
  const svc = new RhythmService();
  homePolicy(svc, { limits: { short_video: 1200 } });
  for (const device of ["phone", "tablet"]) {
    svc.recordConsumption({
      recordId: `r-${device}`,
      memberId: "m1",
      deviceId: device,
      category: "short_video",
      startedAt: "2026-09-21T18:00:00+08:00",
      endedAt: "2026-09-21T18:25:00+08:00",
    });
  }
  // 注：预算按成员-日期-类别桶汇总（设备独立并集，跨设备不合并重叠），
  // 两条无重叠区间合计 3000s 触发阻断，各自设备评估都能看到政策版本依据。
  assert.equal(svc.ledgerView("m1", "2026-09-21").short_video.used_seconds, 3000);
  assert.equal(svc.evaluateAt("m1", { deviceId: "tablet", category: "short_video", at: "2026-09-21T18:30:00+08:00" }).mode, "block");
});

test("临时延长：成员提出、监护人批准并收窄范围；批准不得超出申请", () => {
  const svc = new RhythmService();
  homePolicy(svc, { limits: { short_video: 600 } });
  svc.recordConsumption({
    recordId: "use-1",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T20:00:00+08:00",
    endedAt: "2026-09-21T20:10:00+08:00",
  });
  assert.equal(svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T20:11:00+08:00" }).mode, "block");

  svc.requestExtension({
    extensionId: "ext-1",
    memberId: "m1",
    scope: { category: "short_video" },
    extraSeconds: 1800,
    reason: "今晚家庭纪录片共赏",
    requestedAt: "2026-09-21T20:12:00+08:00",
    appliesToDate: "2026-09-21",
    expiresAt: "2026-09-21T22:00:00+08:00",
  });
  // 待审批期间预算不变。
  assert.equal(svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T20:13:00+08:00" }).mode, "block");
  assert.equal(svc.pendingExtensions().length, 1);

  assert.throws(
    () =>
      svc.approveExtension("ext-1", "g1", {
        approvedAt: "2026-09-21T20:14:00+08:00",
        validUntil: "2026-09-21T23:00:00+08:00", // 超过申请到期
      }),
    /exceeds request expires_at/,
  );
  assert.throws(
    () =>
      svc.approveExtension("ext-1", "g1", {
        approvedAt: "2026-09-21T20:14:00+08:00",
        validUntil: "2026-09-21T21:30:00+08:00",
        extraSeconds: 3600, // 比申请更多
      }),
    /within request/,
  );

  svc.approveExtension("ext-1", "g1", {
    approvedAt: "2026-09-21T20:14:00+08:00",
    validUntil: "2026-09-21T21:30:00+08:00",
    extraSeconds: 1200, // 监护人只批 20 分钟
  });
  const allowed = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T20:15:00+08:00" });
  assert.equal(allowed.mode, "allow");
  assert.equal(allowed.basis.extra_seconds, 1200);
  assert.deepEqual(allowed.basis.extension_ids, ["ext-1"]);

  // 批准窗口过后延长失效，预算回到 600s。
  assert.equal(svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T21:31:00+08:00" }).mode, "block");
  // 延长只适用于申请的那一天。
  assert.equal(svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-22T19:00:00+08:00" }).mode, "allow");
});

test("紧急联系与已下载课程例外：需显式用途、有硬性到期、可撤销", () => {
  const svc = new RhythmService();
  homePolicy(svc, { limits: { short_video: 600, course: 600 } });

  svc.grantException({
    exceptionId: "ex-sos",
    memberId: "m1",
    kind: "emergency_contact",
    scope: { category: "short_video" },
    requestedBy: "m1",
    grantedBy: "g1",
    grantedAt: "2026-09-21T17:00:00+08:00",
    expiresAt: "2026-09-21T19:00:00+08:00",
  });
  // 必须显式声明紧急用途才豁免；普通短视频不会被顺带放过。
  assert.equal(svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T17:30:00+08:00" }).reason, "within_limits");
  const emergency = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", usageKind: "emergency_contact", at: "2026-09-21T18:00:00+08:00" });
  assert.equal(emergency.mode, "allow");
  assert.equal(emergency.basis.exception.kind, "emergency_contact");

  // 紧急使用入账但不消耗预算。
  svc.recordConsumption({
    recordId: "sos-1",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    usageKind: "emergency_contact",
    startedAt: "2026-09-21T18:00:00+08:00",
    endedAt: "2026-09-21T18:20:00+08:00",
  });
  assert.equal(svc.ledgerView("m1", "2026-09-21").short_video.used_seconds, 0);
  assert.equal(svc.ledgerView("m1", "2026-09-21").short_video.exempt_seconds, 1200);

  // 到期后立即失去豁免（即便调度器尚未运行）。
  const expired = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", usageKind: "emergency_contact", at: "2026-09-21T19:00:00+08:00" });
  assert.equal(expired.basis.exception, null);

  // 调度器补记系统过期事件，再跑一次幂等。
  svc.runScheduler("2026-09-21T20:00:00+08:00");
  svc.runScheduler("2026-09-21T20:00:00+08:00");
  assert.equal(svc.events.filter((e) => e.kind === "EXCEPTION_REVIEWED" && e.payload.decision === "expired").length, 1);

  // 已下载课程：撤销即时生效，例外不会变成永久绕过。
  svc.grantException({
    exceptionId: "ex-course",
    memberId: "m1",
    kind: "downloaded_course",
    scope: { category: "course" },
    requestedBy: "m1",
    grantedBy: "g1",
    grantedAt: "2026-09-22T18:00:00+08:00",
    expiresAt: "2026-12-31T23:59:59+08:00",
  });
  assert.equal(svc.evaluateAt("m1", { deviceId: "tablet", category: "course", usageKind: "downloaded_course", at: "2026-09-22T19:00:00+08:00" }).mode, "allow");
  svc.reviewException("ex-course", "revoked", "g1", "2026-09-22T19:30:00+08:00");
  // 撤销后同类使用不再豁免：11 分钟课程正常计入 600s 预算并触发阻断。
  assert.equal(svc.evaluateAt("m1", { deviceId: "tablet", category: "course", usageKind: "downloaded_course", at: "2026-09-22T19:31:00+08:00" }).basis.exception, null);
  svc.recordConsumption({
    recordId: "course-1",
    memberId: "m1",
    deviceId: "tablet",
    category: "course",
    usageKind: "downloaded_course",
    startedAt: "2026-09-22T19:31:00+08:00",
    endedAt: "2026-09-22T19:42:00+08:00",
  });
  assert.equal(svc.ledgerView("m1", "2026-09-22").course.used_seconds, 660);
  assert.equal(svc.evaluateAt("m1", { deviceId: "tablet", category: "course", usageKind: "downloaded_course", at: "2026-09-22T19:43:00+08:00" }).mode, "block");

  // 不能授予无期限例外。
  assert.throws(
    () =>
      svc.grantException({
        exceptionId: "ex-forever",
        memberId: "m1",
        kind: "downloaded_course",
        requestedBy: "m1",
        grantedBy: "g1",
        grantedAt: "2026-09-22T19:00:00+08:00",
        expiresAt: "2026-09-22T19:00:00+08:00",
      }),
    /finite positive lifetime/,
  );
});

test("两位监护人并发改策：后写者基于旧版本必须收到冲突，重读后才能提交", () => {
  const svc = new RhythmService();
  homePolicy(svc);
  assert.equal(svc.policyVersion("home"), 1);

  // 监护人 B 先成功改到 v2。
  svc.revisePolicy(
    "home",
    1,
    { daily_limits_seconds: { short_video: 1800, reading: 1800 }, actor: { id: "g2", role: "guardian" } },
    "2026-09-10T09:00:00+08:00",
  );
  assert.equal(svc.policyVersion("home"), 2);

  // 监护人 A 仍基于 v1 提交 -> 冲突。
  assert.throws(
    () =>
      svc.revisePolicy(
        "home",
        1,
        { daily_limits_seconds: { short_video: 900, reading: 900 }, actor: { id: "g1", role: "guardian" } },
        "2026-09-10T09:05:00+08:00",
      ),
    PolicyConflictError,
  );

  // A 重读当前版本 2，合并后提交成功为 v3。
  svc.revisePolicy(
    "home",
    2,
    { daily_limits_seconds: { short_video: 900, reading: 1800 }, actor: { id: "g1", role: "guardian" } },
    "2026-09-10T09:10:00+08:00",
  );
  assert.equal(svc.policyVersion("home"), 3);
  const limit = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T20:00:00+08:00" });
  assert.equal(limit.basis.daily_limit_seconds, 900);
  assert.equal(limit.basis.policy.version, 3);
});

test("撤权后停止个性化建议，并仅保留结算争议所需最少记录", () => {
  const svc = new RhythmService();
  homePolicy(svc);
  svc.recordConsumption({
    recordId: "bill-1",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-15T20:00:00+08:00",
    endedAt: "2026-09-15T20:30:00+08:00",
  });
  svc.recordConsumption({
    recordId: "priv-1",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-16T20:00:00+08:00",
    endedAt: "2026-09-16T20:30:00+08:00",
  });

  const before = svc.recommendation("m1", { deviceId: "phone", category: "short_video", at: "2026-09-16T21:00:00+08:00" });
  assert.equal(before.suppressed, false);

  svc.annotateRetention(
    "m1",
    {
      recordIds: ["bill-1"],
      reason: "billing_dispute",
      retainUntil: "2027-03-15T00:00:00+08:00",
      fieldsRetained: ["started_at", "ended_at", "category"],
    },
    "2026-09-17T09:00:00+08:00",
  );
  svc.withdrawProfile("m1", "2026-09-17T10:00:00+08:00");

  const after = svc.recommendation("m1", { deviceId: "phone", category: "short_video", at: "2026-09-17T10:01:00+08:00" });
  assert.equal(after.suppressed, true);
  assert.equal(after.reason, "profile_withdrawn");

  const exported = svc.prunedExport("m1");
  const byRecord = Object.fromEntries(
    exported.filter((e) => e.kind === "CONSUMPTION_RECORDED").map((e) => [e.payload.record_id, e.payload]),
  );
  // 争议账单：只保留声明字段与最小标识，设备等明细消失。
  assert.deepEqual(Object.keys(byRecord["bill-1"]).sort(), ["category", "ended_at", "member_id", "record_id", "started_at"]);
  assert.equal("device_id" in byRecord["bill-1"], false);
  // 无关记录：明细整体脱敏。
  assert.deepEqual(byRecord["priv-1"], { record_id: "priv-1", member_id: "m1", redacted: true });

  // 撤权不破坏既有政策执行：阻断判定仍可用。
  assert.equal(svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T20:00:00+08:00" }).basis.policy.version, 1);
});

test("学校只收到约定范围内的按日按类别分钟汇总", () => {
  const svc = new RhythmService();
  homePolicy(svc);
  svc.setPolicy({
    policyId: "home2",
    scope: { member_id: "m2" },
    timeZone: "Asia/Shanghai",
    dailyLimits: { short_video: 3600 },
    windows: [],
    effectiveFrom: "2026-09-01T00:00:00+08:00",
    actor: GUARDIAN,
    occurredAt: "2026-09-01T00:00:00+08:00",
  });

  svc.recordConsumption({
    recordId: "m1-v",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T19:00:00+08:00",
    endedAt: "2026-09-21T19:30:00+08:00",
  });
  svc.recordConsumption({
    recordId: "m1-r",
    memberId: "m1",
    deviceId: "phone",
    category: "reading",
    startedAt: "2026-09-21T20:00:00+08:00",
    endedAt: "2026-09-21T20:40:00+08:00",
  });
  svc.recordConsumption({
    recordId: "m2-v",
    memberId: "m2",
    deviceId: "pad",
    category: "short_video",
    startedAt: "2026-09-21T19:00:00+08:00",
    endedAt: "2026-09-21T19:15:00+08:00",
  });

  const event = svc.shareSchoolSummary({
    schoolId: "sch-1",
    memberIds: ["m1"], // 协议只覆盖 m1
    range: { from: "2026-09-21", to: "2026-09-21" },
    allowedCategories: ["short_video"], // 协议只共享短视频
    agreementId: "agr-7",
    sharedAt: "2026-09-22T08:00:00+08:00",
  });
  const p = event.payload;
  assert.deepEqual(p.buckets, [{ member_id: "m1", local_date: "2026-09-21", category: "short_video", used_minutes: 30 }]);
  assert.equal(p.basis.granularity, "day_category_minutes");
  assert.deepEqual(p.basis.allowed_categories, ["short_video"]);
  // 汇总里不含设备、记录标识等明细。
  assert.equal(JSON.stringify(p).includes("phone"), false);
  assert.equal(JSON.stringify(p).includes("m1-v"), false);
});

test("重启重放：账本、待审批延长、干预与调度结果完全一致", () => {
  const svc = new RhythmService();
  homePolicy(svc);
  svc.recordConsumption({
    recordId: "a",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T20:00:00+08:00",
    endedAt: "2026-09-21T20:55:00+08:00",
  });
  svc.requestExtension({
    extensionId: "ext-pending",
    memberId: "m1",
    scope: { category: "short_video" },
    extraSeconds: 600,
    reason: "等校车",
    requestedAt: "2026-09-21T21:00:00+08:00",
    appliesToDate: "2026-09-21",
    expiresAt: "2026-09-21T22:00:00+08:00",
  });
  svc.runScheduler("2026-09-22T00:05:00+08:00");

  const rebooted = RhythmService.replay(svc.events);
  assert.equal(rebooted.events.length, svc.events.length);
  assert.deepEqual(rebooted.ledgerView("m1", "2026-09-21"), svc.ledgerView("m1", "2026-09-21"));
  assert.equal(rebooted.pendingExtensions().length, 1);
  assert.equal(rebooted.pendingExtensions()[0].extension_id, "ext-pending");
  assert.equal(rebooted.interventions().length, svc.interventions().length);
  assert.deepEqual(
    rebooted.interventions().map((i) => i.intervention_id),
    svc.interventions().map((i) => i.intervention_id),
  );

  // 再跑一次调度器不产生重复事件；重启后旧记录重传依旧幂等。
  const before = rebooted.events.length;
  rebooted.runScheduler("2026-09-22T00:05:00+08:00");
  assert.equal(rebooted.events.length, before);
  const dup = rebooted.recordConsumption({
    recordId: "a",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T20:00:00+08:00",
    endedAt: "2026-09-21T20:55:00+08:00",
  });
  assert.equal(dup.duplicate, true);
  assert.equal(rebooted.ledgerView("m1", "2026-09-21").short_video.used_seconds, 3300);

  // 待审批延长在重启后仍可被批准。
  rebooted.approveExtension("ext-pending", "g1", {
    approvedAt: "2026-09-21T21:05:00+08:00",
    validUntil: "2026-09-21T21:40:00+08:00",
  });
  assert.equal(rebooted.pendingExtensions().length, 0);
});

test("上学日与非上学日适用不同政策：周一按上学日限额，周六按周末限额", () => {
  const svc = new RhythmService();
  svc.setPolicy({
    policyId: "weekday",
    scope: { member_id: "m1", day_kind: "school" },
    timeZone: "Asia/Shanghai",
    dailyLimits: { short_video: 600 },
    windows: [],
    effectiveFrom: "2026-09-01T00:00:00+08:00",
    actor: GUARDIAN,
    occurredAt: "2026-09-01T00:00:00+08:00",
  });
  svc.setPolicy({
    policyId: "weekend",
    scope: { member_id: "m1", day_kind: "non_school" },
    timeZone: "Asia/Shanghai",
    dailyLimits: { short_video: 3600 },
    windows: [],
    effectiveFrom: "2026-09-01T00:00:00+08:00",
    actor: GUARDIAN,
    occurredAt: "2026-09-01T00:00:00+08:00",
  });

  // 2026-09-21 周一（上学日）：12 分钟即超限。
  svc.recordConsumption({
    recordId: "mon",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-21T20:00:00+08:00",
    endedAt: "2026-09-21T20:12:00+08:00",
  });
  const monday = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T20:13:00+08:00" });
  assert.equal(monday.basis.day_kind, "school");
  assert.equal(monday.basis.policy.policy_id, "weekday");
  assert.equal(monday.basis.daily_limit_seconds, 600);
  assert.equal(monday.mode, "block");

  // 2026-09-19 周六（非上学日）：同样 12 分钟远未触限。
  svc.recordConsumption({
    recordId: "sat",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-09-19T20:00:00+08:00",
    endedAt: "2026-09-19T20:12:00+08:00",
  });
  const saturday = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-19T20:13:00+08:00" });
  assert.equal(saturday.basis.day_kind, "non_school");
  assert.equal(saturday.basis.policy.policy_id, "weekend");
  assert.equal(saturday.mode, "allow");
});

test("时间窗策略：窗口外直接阻断，依据含窗口与政策版本", () => {
  const svc = new RhythmService();
  homePolicy(svc, { windows: [{ start: "19:00", end: "21:00" }] });
  const out = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T18:59:00+08:00" });
  assert.equal(out.mode, "block");
  assert.equal(out.reason, "outside_allowed_window");
  assert.deepEqual(out.basis.window, [{ start: "19:00", end: "21:00" }]);
  assert.equal(svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-21T20:00:00+08:00" }).mode, "allow");
});

test("生效期：新版本生效前仍按旧版，生效后按新版", () => {
  const svc = new RhythmService();
  homePolicy(svc, { limits: { short_video: 3600 } });
  svc.revisePolicy(
    "home",
    1,
    {
      daily_limits_seconds: { short_video: 600 },
      effective_from: "2026-10-01T00:00:00+08:00",
      actor: GUARDIAN,
    },
    "2026-09-20T10:00:00+08:00",
  );
  const sept = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-09-30T20:00:00+08:00" });
  assert.equal(sept.basis.daily_limit_seconds, 3600);
  assert.equal(sept.basis.policy.version, 1);
  const oct = svc.evaluateAt("m1", { deviceId: "phone", category: "short_video", at: "2026-10-01T20:00:00+08:00" });
  assert.equal(oct.basis.daily_limit_seconds, 600);
  assert.equal(oct.basis.policy.version, 2);
});

test("核心服务在夏令时变化日仍按正确日期与秒数计账", () => {
  const svc = new RhythmService();
  svc.setPolicy({
    policyId: "ny",
    scope: { member_id: "m1" },
    timeZone: "America/New_York",
    dailyLimits: { short_video: 7200 },
    windows: [],
    effectiveFrom: "2026-09-01T00:00:00-04:00",
    actor: GUARDIAN,
    occurredAt: "2026-09-01T00:00:00-04:00",
  });
  // 春令时当夜：本地 03-08 01:30 到 03-09 01:30（23 小时日内跨午夜）。
  svc.recordConsumption({
    recordId: "dst-spring",
    memberId: "m1",
    deviceId: "phone",
    category: "short_video",
    startedAt: "2026-03-08T01:30:00-05:00",
    endedAt: "2026-03-09T01:30:00-04:00",
  });
  const d1 = svc.ledgerView("m1", "2026-03-08").short_video;
  const d2 = svc.ledgerView("m1", "2026-03-09").short_video;
  assert.equal(d1.used_seconds + d2.used_seconds, 23 * 3600);
  assert.equal(d1.used_seconds, 21 * 3600 + 30 * 60); // 01:30 到当地 23 小时日的午夜
  assert.equal(d2.used_seconds, 1 * 3600 + 30 * 60);
});
