// 数字节律家庭协商：事件合同。
//
// 所有跨模块交换都以"事件"为单位。事件只描述已经发生或已被批准的事实，
// 政策解释、预算扣减与阻断决策由 src/engine.js 从事件流中重放得出，
// 因此重启、离线补传与定时重置都可以用同一条事件流重建。

// ---------------------------------------------------------------------------
// 事件种类
// ---------------------------------------------------------------------------

export const EVENT_KINDS = Object.freeze([
  // 基础合同（基线保留，BUDGET_SET 为旧版预算事件，仍合法）
  "BUDGET_SET",
  "CONSUMPTION_RECORDED",
  "LIMIT_REACHED",
  "EXCEPTION_REVIEWED",
  "PROFILE_WITHDRAWN",

  // 政策与校历
  "POLICY_DEFINED", // 定义或修订一条政策（同 policy_id 用 version 递增）
  "POLICY_WITHDRAWN", // 整条政策停用
  "CALENDAR_PUBLISHED", // 上学日 / 休息日校历

  // 设备时钟
  "CLOCK_SYNC", // 设备时钟与服务器对齐点，用于纠正补传事件的漂移

  // 临时延长：成员提出 -> 监护人批准
  "EXTENSION_REQUESTED",
  "EXTENSION_APPROVED",
  "EXTENSION_REJECTED",

  // 明确例外：紧急联系 / 已下载课程，必须带有效期与上限
  "EXCEPTION_GRANTED",
  "EXCEPTION_REVOKED",

  // 结算与对外共享
  "DAY_CLOSED", // 某成员某本地日已结账（定时任务或重建产生）
  "SCHOOL_AGREEMENT_REGISTERED", // 家庭与学校约定的汇总范围
  "SCHOOL_REPORT_DELIVERED", // 实际对外交付的汇总（审计用）
]);

// ---------------------------------------------------------------------------
// 领域枚举
// ---------------------------------------------------------------------------

// 内容类别。短视频、阅读、课程不再被粗暴合并；"*" 表示政策里的兜底类别。
export const CONTENT_CATEGORIES = Object.freeze([
  "SHORT_VIDEO",
  "READING",
  "LESSON",
  "COMMUNICATION",
  "EMERGENCY",
  "*",
]);

export const DAY_TYPES = Object.freeze(["SCHOOL_DAY", "NON_SCHOOL_DAY", "ANY"]);

export const WINDOW_ACTIONS = Object.freeze(["BLOCK", "WARN"]);

export const EXCEPTION_TYPES = Object.freeze(["EMERGENCY_CONTACT", "DOWNLOADED_LESSON"]);

// 学校可收到的汇总字段，只能是粗粒度聚合，不允许逐事件明细。
export const SCHOOL_REPORT_FIELDS = Object.freeze([
  "DAILY_TOTALS_BY_CATEGORY",
  "DAILY_LIMIT_HITS",
  "POLICY_COMPLIANCE_RATE",
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isIsoInstant(value) {
  return typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value));
}
function isLocalDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function isHHMM(value) {
  return typeof value === "string" && HHMM.test(value);
}
function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0;
}
function isPosInt(value) {
  return Number.isInteger(value) && value > 0;
}
function problemsFor(value, path, check) {
  const out = [];
  if (!check(value)) out.push(path);
  return out;
}

// ---------------------------------------------------------------------------
// 各事件负载校验
// ---------------------------------------------------------------------------

function validatePolicyRules(rules, path) {
  const problems = [];
  if (!Array.isArray(rules) || rules.length === 0) {
    problems.push(`${path}.rules`);
    return problems;
  }
  rules.forEach((rule, i) => {
    const p = `${path}.rules[${i}]`;
    if (!DAY_TYPES.includes(rule?.day_type)) problems.push(`${p}.day_type`);

    if (rule.budgets !== undefined) {
      if (!Array.isArray(rule.budgets)) {
        problems.push(`${p}.budgets`);
      } else {
        rule.budgets.forEach((b, j) => {
          const bp = `${p}.budgets[${j}]`;
          if (!CONTENT_CATEGORIES.includes(b?.category)) problems.push(`${bp}.category`);
          if (!isNonNegInt(b?.daily_limit_minutes)) problems.push(`${bp}.daily_limit_minutes`);
        });
      }
    }

    if (rule.windows !== undefined) {
      if (!Array.isArray(rule.windows)) {
        problems.push(`${p}.windows`);
      } else {
        rule.windows.forEach((w, j) => {
          const wp = `${p}.windows[${j}]`;
          if (w.category !== undefined && !CONTENT_CATEGORIES.includes(w.category))
            problems.push(`${wp}.category`);
          if (!isHHMM(w?.start) || !isHHMM(w?.end)) problems.push(`${wp}.start_end`);
          if (!WINDOW_ACTIONS.includes(w?.action)) problems.push(`${wp}.action`);
          if (isHHMM(w?.start) && isHHMM(w?.end) && w.start === w.end)
            problems.push(`${wp}.zero_length_window`);
        });
      }
    }
  });
  return problems;
}

function validatePolicyDefined(payload) {
  const problems = [];
  if (typeof payload?.policy_id !== "string" || !payload.policy_id) problems.push("payload.policy_id");
  if (!isPosInt(payload?.version)) problems.push("payload.version");
  if (typeof payload?.subject_id !== "string" || !payload.subject_id) problems.push("payload.subject_id");
  if (typeof payload?.timezone !== "string" || !isValidTimeZone(payload.timezone))
    problems.push("payload.timezone");
  if (!isIsoInstant(payload?.effective_from)) problems.push("payload.effective_from");
  if (payload?.effective_to !== undefined &&
      (!isIsoInstant(payload.effective_to) || payload.effective_to <= payload.effective_from))
    problems.push("payload.effective_to");
  if (typeof payload?.created_by !== "string" || !payload.created_by) problems.push("payload.created_by");
  if (payload?.scope !== undefined) {
    if (typeof payload.scope !== "object" || payload.scope === null) problems.push("payload.scope");
    else {
      for (const key of ["devices", "categories"]) {
        if (payload.scope[key] !== undefined &&
            (!Array.isArray(payload.scope[key]) || payload.scope[key].some((x) => typeof x !== "string")))
          problems.push(`payload.scope.${key}`);
      }
      if (Array.isArray(payload.scope.categories) &&
          payload.scope.categories.some((c) => !CONTENT_CATEGORIES.includes(c)))
        problems.push("payload.scope.categories.value");
    }
  }
  problems.push(...validatePolicyRules(payload?.rules, "payload"));
  // 可选乐观锁：监护人修改时填写自己依据的最新版本；
  // 与服务端当前版本不一致即拒绝（多人并发改同一政策）。
  if (payload?.expected_version !== undefined && !isPosInt(payload.expected_version))
    problems.push("payload.expected_version");
  return problems;
}

function validateCalendar(payload) {
  const problems = [];
  if (typeof payload?.subject_id !== "string" || !payload.subject_id) problems.push("payload.subject_id");
  if (!Array.isArray(payload?.school_days) || payload.school_days.some((d) => !isLocalDate(d)))
    problems.push("payload.school_days");
  if (!["SCHOOL", "GUARDIAN"].includes(payload?.source)) problems.push("payload.source");
  if (payload?.effective_from && !isLocalDate(payload.effective_from))
    problems.push("payload.effective_from");
  return problems;
}

function validateConsumption(payload) {
  const problems = [];
  if (typeof payload?.subject_id !== "string" || !payload.subject_id) problems.push("payload.subject_id");
  if (typeof payload?.device_id !== "string" || !payload.device_id) problems.push("payload.device_id");
  if (!CONTENT_CATEGORIES.includes(payload?.category) || payload.category === "*")
    problems.push("payload.category");
  if (!isIsoInstant(payload?.started_at)) problems.push("payload.started_at");
  // ended_at 与 duration_seconds 至少给一个，用于确定片段长度。
  if (!isIsoInstant(payload?.ended_at) && !isNonNegInt(payload?.duration_seconds))
    problems.push("payload.ended_at_or_duration");
  if (isIsoInstant(payload?.ended_at) && isIsoInstant(payload?.started_at) &&
      payload.ended_at < payload.started_at)
    problems.push("payload.ended_before_start");
  // 设备本地时钟读数；离线补传时与 recorded_at / CLOCK_SYNC 配合纠正漂移。
  if (payload?.device_clock_at !== undefined && !isIsoInstant(payload.device_clock_at))
    problems.push("payload.device_clock_at");
  if (payload?.duration_seconds !== undefined && !isNonNegInt(payload.duration_seconds))
    problems.push("payload.duration_seconds");
  if (typeof payload?.idempotency_key !== "string" || !payload.idempotency_key)
    problems.push("payload.idempotency_key");
  if (payload?.downloaded !== undefined && typeof payload.downloaded !== "boolean")
    problems.push("payload.downloaded");
  // 下载课程例外匹配用（DOWNLOADED_LESSON 凭课程 id 放行）。
  if (payload?.lesson_id !== undefined &&
      (typeof payload.lesson_id !== "string" || !payload.lesson_id))
    problems.push("payload.lesson_id");
  // 紧急联系的登记凭证号，与 EXCEPTION_GRANTED.grant_ref 对应。
  if (payload?.contact_ref !== undefined &&
      (typeof payload.contact_ref !== "string" || !payload.contact_ref))
    problems.push("payload.contact_ref");
  return problems;
}

function validateClockSync(payload) {
  const problems = [];
  if (typeof payload?.device_id !== "string" || !payload.device_id) problems.push("payload.device_id");
  if (!isIsoInstant(payload?.device_time)) problems.push("payload.device_time");
  if (!isIsoInstant(payload?.server_time)) problems.push("payload.server_time");
  return problems;
}

function validateExtension(payload, kind) {
  const problems = [];
  if (typeof payload?.request_id !== "string" || !payload.request_id) problems.push("payload.request_id");
  if (typeof payload?.subject_id !== "string" || !payload.subject_id) problems.push("payload.subject_id");
  if (kind === "EXTENSION_REQUESTED") {
    if (typeof payload?.requested_by !== "string" || !payload.requested_by)
      problems.push("payload.requested_by");
    if (payload?.device_id !== undefined && typeof payload.device_id !== "string")
      problems.push("payload.device_id");
    if (payload?.category !== undefined &&
        (!CONTENT_CATEGORIES.includes(payload.category) || payload.category === "*"))
      problems.push("payload.category");
    if (!isPosInt(payload?.extra_minutes)) problems.push("payload.extra_minutes");
    if (!isIsoInstant(payload?.valid_to)) problems.push("payload.valid_to");
    if (payload?.reason !== undefined && typeof payload.reason !== "string")
      problems.push("payload.reason");
  } else if (kind === "EXTENSION_APPROVED") {
    // 监护人批准：必须有批准人、范围与有效期；延长不能无限期。
    if (typeof payload?.approved_by !== "string" || !payload.approved_by)
      problems.push("payload.approved_by");
    if (!isPosInt(payload?.extra_minutes)) problems.push("payload.extra_minutes");
    if (!isIsoInstant(payload?.valid_from) || !isIsoInstant(payload?.valid_to) ||
        payload.valid_to <= payload.valid_from)
      problems.push("payload.valid_window");
    if (payload?.device_id !== undefined && typeof payload.device_id !== "string")
      problems.push("payload.device_id");
    if (payload?.category !== undefined &&
        (!CONTENT_CATEGORIES.includes(payload.category) || payload.category === "*"))
      problems.push("payload.category");
  } else if (kind === "EXTENSION_REJECTED") {
    if (typeof payload?.reviewer_id !== "string" || !payload.reviewer_id)
      problems.push("payload.reviewer_id");
  }
  return problems;
}

function validateException(payload, kind) {
  const problems = [];
  if (kind === "EXCEPTION_GRANTED") {
    if (typeof payload?.exception_id !== "string" || !payload.exception_id)
      problems.push("payload.exception_id");
    if (typeof payload?.subject_id !== "string" || !payload.subject_id)
      problems.push("payload.subject_id");
    if (!EXCEPTION_TYPES.includes(payload?.type)) problems.push("payload.type");
    if (payload?.type === "EMERGENCY_CONTACT") {
      if (!isNonNegInt(payload?.usage_cap_minutes)) problems.push("payload.usage_cap_minutes");
    }
    if (payload?.type === "DOWNLOADED_LESSON") {
      if (typeof payload?.lesson_id !== "string" || !payload.lesson_id) problems.push("payload.lesson_id");
      if (!isNonNegInt(payload?.usage_cap_minutes)) problems.push("payload.usage_cap_minutes");
    }
    if (payload?.device_id !== undefined && typeof payload.device_id !== "string")
      problems.push("payload.device_id");
    if (!isIsoInstant(payload?.valid_from) || !isIsoInstant(payload?.valid_to) ||
        payload.valid_to <= payload.valid_from)
      problems.push("payload.valid_window");
    // 每次授予可被审计的凭证（紧急联系人登记或课程购买凭证），例外不是口头放行。
    if (typeof payload?.grant_ref !== "string" || !payload.grant_ref) problems.push("payload.grant_ref");
  } else {
    if (typeof payload?.exception_id !== "string" || !payload.exception_id)
      problems.push("payload.exception_id");
    if (typeof payload?.reason !== "string") problems.push("payload.reason");
  }
  return problems;
}

function validateSchoolAgreement(payload) {
  const problems = [];
  if (typeof payload?.agreement_id !== "string" || !payload.agreement_id)
    problems.push("payload.agreement_id");
  if (typeof payload?.school_id !== "string" || !payload.school_id) problems.push("payload.school_id");
  if (!Array.isArray(payload?.subject_ids) || payload.subject_ids.length === 0 ||
      payload.subject_ids.some((x) => typeof x !== "string"))
    problems.push("payload.subject_ids");
  if (!Array.isArray(payload?.categories) ||
      payload.categories.some((c) => !CONTENT_CATEGORIES.includes(c) || c === "*"))
    problems.push("payload.categories");
  if (!Array.isArray(payload?.fields) || payload.fields.length === 0 ||
      payload.fields.some((f) => !SCHOOL_REPORT_FIELDS.includes(f)))
    problems.push("payload.fields");
  if (!isLocalDate(payload?.effective_from)) problems.push("payload.effective_from");
  if (payload?.effective_to !== undefined &&
      (!isLocalDate(payload.effective_to) || payload.effective_to <= payload.effective_from))
    problems.push("payload.effective_to");
  return problems;
}

function validateSchoolReport(payload) {
  const problems = [];
  if (typeof payload?.agreement_id !== "string" || !payload.agreement_id)
    problems.push("payload.agreement_id");
  if (typeof payload?.school_id !== "string" || !payload.school_id) problems.push("payload.school_id");
  if (!isLocalDate(payload?.period_from) || !isLocalDate(payload?.period_to) ||
      payload.period_to < payload.period_from)
    problems.push("payload.period");
  return problems;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

const PAYLOAD_VALIDATORS = {
  POLICY_DEFINED: validatePolicyDefined,
  POLICY_WITHDRAWN: (p) => problemsFor(p?.policy_id, "payload.policy_id", (v) => typeof v === "string" && !!v),
  CALENDAR_PUBLISHED: validateCalendar,
  CONSUMPTION_RECORDED: validateConsumption,
  CLOCK_SYNC: validateClockSync,
  EXTENSION_REQUESTED: (p) => validateExtension(p, "EXTENSION_REQUESTED"),
  EXTENSION_APPROVED: (p) => validateExtension(p, "EXTENSION_APPROVED"),
  EXTENSION_REJECTED: (p) => validateExtension(p, "EXTENSION_REJECTED"),
  EXCEPTION_GRANTED: (p) => validateException(p, "EXCEPTION_GRANTED"),
  EXCEPTION_REVOKED: (p) => validateException(p, "EXCEPTION_REVOKED"),
  SCHOOL_AGREEMENT_REGISTERED: validateSchoolAgreement,
  SCHOOL_REPORT_DELIVERED: validateSchoolReport,
  // 旧版与系统派生事件只做最小校验。
  BUDGET_SET: () => [],
  EXCEPTION_REVIEWED: () => [],
  LIMIT_REACHED: () => [],
  PROFILE_WITHDRAWN: () => [],
  DAY_CLOSED: (p) => {
    const problems = [];
    if (typeof p?.subject_id !== "string" || !p.subject_id) problems.push("payload.subject_id");
    if (!isLocalDate(p?.local_date)) problems.push("payload.local_date");
    return problems;
  },
};

/**
 * 校验事件信封与负载，返回问题字段路径数组；空数组表示合法。
 * 不抛异常，便于批量补传时收集所有问题。
 */
export function validateEvent(record) {
  if (record === null || typeof record !== "object") return ["record"];
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind");
    return problems;
  }
  if (!isIsoInstant(record.occurred_at)) problems.push("occurred_at");
  if (typeof record.subject_id !== "string" || !record.subject_id) problems.push("subject_id");
  if (record.payload === null || typeof record.payload !== "object") problems.push("payload");
  const validatePayload = PAYLOAD_VALIDATORS[record.kind];
  if (validatePayload && record.payload !== null && typeof record.payload === "object") {
    problems.push(...validatePayload(record.payload));
    if (record.payload.subject_id !== undefined && record.payload.subject_id !== record.subject_id)
      problems.push("payload.subject_id_mismatch");
  }
  return problems;
}
