// 撤权后的最小留存：只为结算争议保留必要账本，不保留画像与内容细节。
//
// 原则（数据最小化）：
//  - 保留：按日本地日的类别秒数、池子归属（基础/延长/例外/超时/窗阻）、
//    所依据的政策版本、延长审批编号、例外类型与用量、结账快照、迟到补传。
//  - 不保留、不导出：具体内容标题、课程名称、紧急联系人与号码、
//    设备时钟原始读数、个性化建议历史、任何用于刻画偏好的字段。
// 争议包的字段集合固定，调用方无法通过它取回已撤权的画像数据。

const RETAINED_CATEGORIES = new Set([
  "subject_id",
  "local_date",
  "day_type",
  "device_id",
  "category",
  "seconds",
  "allocation",
  "policy_id",
  "policy_version",
]);

const FORBIDDEN_FIELDS = [
  "lesson_id",
  "contact_ref",
  "grant_ref",
  "downloaded",
  "device_clock_at",
  "reason",
  "requested_by",
];

export class RetentionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RetentionError";
    this.code = code;
  }
}

/**
 * 导出某成员在争议期间内的最小账本。
 * 不要求撤权才能导出（撤权前也有结算争议），但撤权后这是唯一允许的数据出口：
 * 个性化建议、明细内容均不在包内。
 */
export function buildDisputePack(engine, subjectId, { period_from, period_to, dispute_ref, purpose = "BILLING_DISPUTE" }) {
  if (!period_from || !period_to || period_to < period_from) {
    throw new RetentionError("争议期间非法", "RETENTION_BAD_PERIOD");
  }
  if (!dispute_ref) throw new RetentionError("必须提供争议工单号", "RETENTION_NO_REF");

  const days = enumerateDates(period_from, period_to);
  const daily = [];
  const closure = [];
  const late = [];

  for (const date of days) {
    // 设备×类别粒度的最小分配行（不含任何内容标识）。
    const devices = new Map();
    for (const s of engine._daySlices(subjectId, date)) {
      if (!devices.has(s.device_id)) devices.set(s.device_id, new Set());
      devices.get(s.device_id).add(s.category);
    }
    for (const [deviceId, categories] of devices) {
      for (const category of categories) {
        const alloc = engine.allocateDay(subjectId, deviceId, category, date);
        if (!alloc) continue;
        const seconds =
          alloc.regular_used_seconds +
          alloc.overrun_seconds +
          alloc.window_blocked_seconds +
          alloc.exception_used_seconds;
        daily.push({
          local_date: date,
          day_type: alloc.day_type.day_type,
          device_id: deviceId,
          category,
          seconds,
          allocation: {
            base_seconds: alloc.base_used_seconds,
            extension_seconds: alloc.extension_used_seconds,
            exception_seconds: alloc.exception_used_seconds,
            overrun_seconds: alloc.overrun_seconds,
            window_blocked_seconds: alloc.window_blocked_seconds,
          },
          policy_id: alloc.policy.policy_id,
          policy_version: alloc.policy.version,
          // 例外只暴露类型，不暴露凭证/课程/联系人。
          exceptions: alloc.exception_caps
            .filter((e) => e.used_seconds > 0)
            .map((e) => {
              const rec = engine.exceptions.get(subjectId)?.get(e.exception_id);
              return { type: rec?.type ?? null, used_seconds: e.used_seconds, cap_seconds: e.cap_seconds };
            }),
          // 延长只暴露审批编号与批准人（结算追责需要），不暴露申请人理由。
          extensions: alloc.extension_grants.map((g) => ({
            request_id: g.request_id,
            approved_by: g.approved_by,
            extra_minutes: g.extra_minutes,
          })),
        });
      }
    }

    const closed = engine.closedDays.get(subjectId)?.get(date);
    if (closed) {
      closure.push({
        local_date: date,
        closed_at: new Date(closed.at_ms).toISOString(),
        totals: closed.totals,
      });
    }
    for (const rec of engine.lateArrivals(subjectId, date)) {
      late.push({
        local_date: date,
        device_id: rec.device_id,
        category: rec.category,
        seconds: rec.seconds,
        arrived_at: new Date(rec.arrived_at).toISOString(),
      });
    }
  }

  return {
    format: "DISPUTE_PACK",
    purpose,
    dispute_ref,
    subject_id: subjectId,
    period_from,
    period_to,
    profile_withdrawn: engine.isProfileWithdrawn(subjectId, engine._now()),
    retained: {
      daily,
      closure,
      late_arrivals: late,
    },
    suppressed: [
      "CONTENT_DETAIL",
      "LESSON_IDENTITY",
      "EMERGENCY_CONTACT_IDENTITY",
      "RECOMMENDATION_HISTORY",
      "RAW_CLOCK_READINGS",
    ],
    privacy_notice: "仅包含结算争议所必需的最小聚合记录，不得用于重建画像或个性化。",
  };
}

/** 审计断言：争议包内不得出现任何被抑制字段（防回归）。 */
export function assertMinimal(pack) {
  const text = JSON.stringify(pack);
  for (const f of FORBIDDEN_FIELDS) {
    if (text.includes(`"${f}"`)) {
      throw new RetentionError(`争议包包含被抑制字段：${f}`, "RETENTION_LEAK");
    }
  }
  for (const row of pack.retained.daily) {
    for (const key of Object.keys(row)) {
      if (!RETAINED_CATEGORIES.has(key) && key !== "exceptions" && key !== "extensions" && key !== "allocation") {
        throw new RetentionError(`争议包出现未登记字段：${key}`, "RETENTION_LEAK");
      }
    }
  }
  return true;
}

function enumerateDates(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    out.push(cur);
    const [y, m, d] = cur.split("-").map(Number);
    cur = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }
  return out;
}
