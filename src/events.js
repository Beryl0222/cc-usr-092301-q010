// 事件工厂：统一信封、时间戳与负载形状，供模块代码与测试使用。
import { validateEvent } from "./culture_time_budget.js";

let seq = 0;

/** 生成带前缀的确定性事件 id（同毫秒内也不重复）。 */
export function newEventId(prefix = "evt") {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** 把 Date 或字符串归一化为 ISO 字符串。 */
export function iso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return value;
}

/**
 * 构造并校验事件；校验失败时抛出带问题清单的错误，避免坏事件进日志。
 */
export function makeEvent(kind, subjectId, payload, { eventId, occurredAt } = {}) {
  const event = {
    event_id: eventId ?? newEventId(kind.toLowerCase()),
    kind,
    occurred_at: iso(occurredAt ?? new Date()),
    subject_id: subjectId,
    payload,
  };
  const problems = validateEvent(event);
  if (problems.length > 0) {
    const err = new Error(`事件 ${event.event_id} (${kind}) 校验失败：${problems.join(", ")}`);
    err.code = "EVENT_INVALID";
    err.problems = problems;
    throw err;
  }
  return event;
}

// ---------------------------------------------------------------------------
// 语义化快捷构造器
// ---------------------------------------------------------------------------

export const events = {
  policyDefined(subjectId, policy, at) {
    const {
      policy_id,
      version,
      timezone,
      rules,
      scope,
      effective_from,
      effective_to,
      created_by,
      expected_version,
    } = policy;
    const payload = {
      subject_id: subjectId,
      policy_id,
      version,
      timezone,
      rules,
      effective_from: iso(effective_from),
      created_by,
    };
    if (scope) payload.scope = scope;
    if (effective_to) payload.effective_to = iso(effective_to);
    if (expected_version !== undefined) payload.expected_version = expected_version;
    return makeEvent("POLICY_DEFINED", subjectId, payload, { occurredAt: at });
  },

  policyWithdrawn(subjectId, policyId, by, at, reason) {
    const payload = { policy_id: policyId, withdrawn_by: by };
    if (reason) payload.reason = reason;
    return makeEvent("POLICY_WITHDRAWN", subjectId, payload, { occurredAt: at });
  },

  calendarPublished(subjectId, schoolDays, { source = "SCHOOL", effective_from, at } = {}) {
    const payload = { subject_id: subjectId, school_days: [...schoolDays].sort(), source };
    if (effective_from) payload.effective_from = effective_from;
    return makeEvent("CALENDAR_PUBLISHED", subjectId, payload, { occurredAt: at });
  },

  consumption(subjectId, fields, at) {
    const {
      device_id,
      category,
      started_at,
      ended_at,
      duration_seconds,
      device_clock_at,
      idempotency_key,
      downloaded,
      lesson_id,
      contact_ref,
    } = fields;
    const payload = {
      subject_id: subjectId,
      device_id,
      category,
      started_at: iso(started_at),
      idempotency_key,
    };
    if (ended_at) payload.ended_at = iso(ended_at);
    if (duration_seconds !== undefined) payload.duration_seconds = duration_seconds;
    if (device_clock_at) payload.device_clock_at = iso(device_clock_at);
    if (downloaded !== undefined) payload.downloaded = downloaded;
    if (lesson_id) payload.lesson_id = lesson_id;
    if (contact_ref) payload.contact_ref = contact_ref;
    return makeEvent("CONSUMPTION_RECORDED", subjectId, payload, {
      eventId: `cons_${idempotency_key}`,
      occurredAt: at ?? ended_at ?? new Date(Date.parse(iso(started_at)) + (duration_seconds ?? 0) * 1000),
    });
  },

  clockSync(deviceId, subjectId, deviceTime, serverTime, at) {
    return makeEvent(
      "CLOCK_SYNC",
      subjectId,
      {
        device_id: deviceId,
        device_time: iso(deviceTime),
        server_time: iso(serverTime),
      },
      { occurredAt: at ?? serverTime },
    );
  },

  extensionRequested(subjectId, fields, at) {
    const { request_id, requested_by, extra_minutes, valid_to, category, device_id, reason } = fields;
    const payload = {
      subject_id: subjectId,
      request_id,
      requested_by,
      extra_minutes,
      valid_to: iso(valid_to),
    };
    if (category) payload.category = category;
    if (device_id) payload.device_id = device_id;
    if (reason) payload.reason = reason;
    return makeEvent("EXTENSION_REQUESTED", subjectId, payload, { occurredAt: at });
  },

  extensionApproved(subjectId, fields, at) {
    const { request_id, approved_by, extra_minutes, valid_from, valid_to, category, device_id } = fields;
    const payload = {
      subject_id: subjectId,
      request_id,
      approved_by,
      extra_minutes,
      valid_from: iso(valid_from),
      valid_to: iso(valid_to),
    };
    if (category) payload.category = category;
    if (device_id) payload.device_id = device_id;
    return makeEvent("EXTENSION_APPROVED", subjectId, payload, { occurredAt: at ?? valid_from });
  },

  extensionRejected(subjectId, fields, at) {
    const { request_id, reviewer_id, reason } = fields;
    const payload = { subject_id: subjectId, request_id, reviewer_id };
    if (reason) payload.reason = reason;
    return makeEvent("EXTENSION_REJECTED", subjectId, payload, { occurredAt: at });
  },

  exceptionGranted(subjectId, fields, at) {
    const {
      exception_id,
      type,
      valid_from,
      valid_to,
      usage_cap_minutes,
      grant_ref,
      device_id,
      lesson_id,
    } = fields;
    const payload = {
      subject_id: subjectId,
      exception_id,
      type,
      valid_from: iso(valid_from),
      valid_to: iso(valid_to),
      usage_cap_minutes,
      grant_ref,
    };
    if (device_id) payload.device_id = device_id;
    if (lesson_id) payload.lesson_id = lesson_id;
    return makeEvent("EXCEPTION_GRANTED", subjectId, payload, { occurredAt: at ?? valid_from });
  },

  exceptionRevoked(subjectId, exceptionId, by, at, reason) {
    const payload = { exception_id: exceptionId, reason: reason ?? "监护人撤回" };
    if (by) payload.revoked_by = by;
    return makeEvent("EXCEPTION_REVOKED", subjectId, payload, { occurredAt: at });
  },

  profileWithdrawn(subjectId, at, fields = {}) {
    const payload = { subject_id: subjectId };
    if (fields.reason) payload.reason = fields.reason;
    return makeEvent("PROFILE_WITHDRAWN", subjectId, payload, { occurredAt: at });
  },

  dayClosed(subjectId, localDate, at, totals = {}) {
    const payload = { subject_id: subjectId, local_date: localDate };
    if (totals && Object.keys(totals).length) payload.totals_by_category = totals;
    return makeEvent("DAY_CLOSED", subjectId, payload, { occurredAt: at });
  },

  schoolAgreementRegistered(subjectId, agreement, at) {
    const payload = { subject_id: subjectId, ...agreement };
    return makeEvent("SCHOOL_AGREEMENT_REGISTERED", subjectId, payload, { occurredAt: at });
  },

  schoolReportDelivered(subjectId, fields, at) {
    const { agreement_id, school_id, period_from, period_to } = fields;
    return makeEvent(
      "SCHOOL_REPORT_DELIVERED",
      subjectId,
      { agreement_id, school_id, period_from, period_to },
      { occurredAt: at },
    );
  },

  limitReached(subjectId, fields, at) {
    const { local_date, category, device_id, policy_id, policy_version } = fields;
    return makeEvent(
      "LIMIT_REACHED",
      subjectId,
      { subject_id: subjectId, local_date, category, device_id, policy_id, policy_version },
      { occurredAt: at },
    );
  },
};
