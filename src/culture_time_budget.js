// culture_time_budget 领域资料的基础结构。
//
// 事件信封保持向后兼容：validateEvent 只校验信封，
// 新增的 validateContractEvent 按事件种类校验最小负载字段，
// 供核心模块在追加事件时使用。

export const EVENT_KINDS = Object.freeze([
  // 基线事件
  "BUDGET_SET", // 旧版预算事件，保留以兼容历史资料
  "CONSUMPTION_RECORDED", // 一次设备上报的消费记录（可能离线补传）
  "LIMIT_REACHED", // 旧版触限事件，解释性信息以 INTERVENTION_RAISED 为准
  "EXCEPTION_REVIEWED", // 对例外的复核结论（批准/撤销/过期/拒绝）
  "PROFILE_WITHDRAWN", // 成员撤回画像（个性化）授权
  // 节律政策
  "POLICY_SET", // 带版本的政策生效（乐观并发：expected_version）
  "DAY_RESET", // 调度器在本地日期零点完成重置的标记（幂等）
  // 临时延长：成员提出、监护人批准
  "EXTENSION_REQUESTED",
  "EXTENSION_APPROVED",
  "EXTENSION_DECLINED",
  // 限期例外（紧急联系、已下载课程等）
  "EXCEPTION_GRANTED",
  // 强制执行侧：提醒 / 阻断 / 个性化建议，携带完整判定依据
  "INTERVENTION_RAISED",
  // 对外共享与留存
  "SCHOOL_SUMMARY_SHARED", // 向学校共享约定范围内的日汇总
  "RETENTION_ANNOTATED", // 撤权后为结算争议标注的最小留存记录
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export const CONTENT_CATEGORIES = Object.freeze([
  "short_video",
  "reading",
  "course",
  "learning_app",
  "game",
  "emergency",
  "other",
]);

export const DAY_KINDS = Object.freeze(["school", "non_school", "any"]);
export const ACTOR_ROLES = Object.freeze(["guardian", "member", "school_delegate", "system"]);

// 每种事件负载至少必须出现的字段。
const PAYLOAD_REQUIRED = Object.freeze({
  BUDGET_SET: [],
  LIMIT_REACHED: [],
  CONSUMPTION_RECORDED: ["record_id", "member_id", "device_id", "category", "started_at", "ended_at"],
  POLICY_SET: [
    "policy_id",
    "version",
    "expected_version",
    "scope",
    "time_zone",
    "daily_limits_seconds",
    "windows",
    "effective_from",
    "actor",
  ],
  DAY_RESET: ["member_id", "local_date", "time_zone", "at"],
  EXTENSION_REQUESTED: [
    "extension_id",
    "member_id",
    "scope",
    "extra_seconds",
    "reason",
    "requested_at",
    "applies_to_date",
    "expires_at",
  ],
  EXTENSION_APPROVED: ["extension_id", "guardian_id", "approved_at", "valid_until"],
  EXTENSION_DECLINED: ["extension_id", "guardian_id", "declined_at"],
  EXCEPTION_GRANTED: [
    "exception_id",
    "member_id",
    "kind",
    "scope",
    "requested_by",
    "granted_by",
    "granted_at",
    "expires_at",
  ],
  EXCEPTION_REVIEWED: ["exception_id", "decision", "reviewer_id", "reviewed_at"],
  INTERVENTION_RAISED: ["intervention_id", "member_id", "category", "at", "mode", "basis"],
  SCHOOL_SUMMARY_SHARED: ["school_id", "range", "buckets", "basis", "shared_at"],
  RETENTION_ANNOTATED: ["member_id", "record_ids", "reason", "retain_until", "fields_retained"],
  PROFILE_WITHDRAWN: ["member_id", "written_at", "scope"],
});

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}

function isIsoInstant(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 严格校验：信封 + 时间格式 + 该种类负载的最小字段。
// 返回问题字符串数组；空数组表示通过。
export function validateContractEvent(record) {
  const problems = validateEvent(record);
  if (problems.length > 0) return problems;

  if (typeof record.event_id !== "string" || record.event_id.length === 0) problems.push("event_id");
  if (!isIsoInstant(record.occurred_at)) problems.push("occurred_at");
  if (typeof record.subject_id !== "string" || record.subject_id.length === 0) problems.push("subject_id");
  if (!isPlainObject(record.payload)) {
    problems.push("payload");
    return problems;
  }

  const required = PAYLOAD_REQUIRED[record.kind] ?? [];
  for (const name of required) {
    if (!(name in record.payload)) problems.push(`payload.${name}`);
  }

  const p = record.payload;
  if (record.kind === "CONSUMPTION_RECORDED") {
    if (!isIsoInstant(p.started_at) || !isIsoInstant(p.ended_at)) problems.push("payload.device_window");
    if (!CONTENT_CATEGORIES.includes(p.category)) problems.push("payload.category");
    if (p.server_window) {
      if (!isIsoInstant(p.server_window.first_seen_at) || !isIsoInstant(p.server_window.last_seen_at)) {
        problems.push("payload.server_window");
      }
    }
  }

  if (record.kind === "POLICY_SET") {
    if (!Number.isInteger(p.version) || p.version < 1) problems.push("payload.version");
    if (p.expected_version !== null && (!Number.isInteger(p.expected_version) || p.expected_version < 1)) {
      problems.push("payload.expected_version");
    }
    if (!isIsoInstant(p.effective_from)) problems.push("payload.effective_from");
    if (p.effective_to != null && !isIsoInstant(p.effective_to)) problems.push("payload.effective_to");
    if (!isPlainObject(p.scope)) problems.push("payload.scope");
    if (isPlainObject(p.scope) && !DAY_KINDS.includes(p.scope.day_kind)) problems.push("payload.scope.day_kind");
    if (!isPlainObject(p.actor) || !ACTOR_ROLES.includes(p.actor.role)) problems.push("payload.actor");
    try {
      // 委托给 Intl 校验 IANA 时区名。
      new Intl.DateTimeFormat("en-US", { timeZone: p.time_zone });
    } catch {
      problems.push("payload.time_zone");
    }
  }

  if (record.kind === "EXCEPTION_REVIEWED" && !["approved", "revoked", "expired", "denied"].includes(p.decision)) {
    problems.push("payload.decision");
  }

  if (record.kind === "INTERVENTION_RAISED" && !["reminder", "block", "suggestion"].includes(p.mode)) {
    problems.push("payload.mode");
  }

  return problems;
}

let eventCounter = 0;

// 构造一条信封完整的事件（不做追加语义校验）。
export function makeEvent(kind, subjectId, payload, occurredAt = new Date().toISOString(), eventId) {
  return {
    event_id: eventId ?? `evt-${(++eventCounter).toString(36)}-${Date.now().toString(36)}`,
    kind,
    occurred_at: occurredAt,
    subject_id: subjectId,
    payload,
  };
}
