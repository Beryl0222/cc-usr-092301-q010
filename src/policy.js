// 节律政策模型。
//
// 政策是带版本的不可变修订（POLICY_SET 事件的负载）：
//   scope 约定适用范围（成员/设备/类别/上学日），
//   daily_limits_seconds 给出该范围内各类别的每日秒数预算（缺省或 null = 不限），
//   windows 给出允许使用的每日墙钟时段（空数组 = 全天），
//   effective_from/effective_to 给出生效期。
//
// 同一 policy_id 的修订按版本号单调递增；某时刻可有多份政策覆盖
// （如一份通用政策 + 一份仅针对某设备的政策），按范围具体度择优。

export const WILDCARD = "*";

export function scopeMatches(scope, ctx) {
  if (scope.member_id !== ctx.member_id) return false;
  if (scope.device_id != null && scope.device_id !== ctx.device_id) return false;
  if (scope.category != null && scope.category !== ctx.category) return false;
  if (scope.day_kind !== "any" && scope.day_kind !== ctx.day_kind) return false;
  return true;
}

// 具体度评分：指定设备 > 指定类别 > 指定上学日；分值越高越优先。
export function scopeSpecificity(scope) {
  let score = 0;
  if (scope.device_id != null) score += 4;
  if (scope.category != null) score += 2;
  if (scope.day_kind !== "any") score += 1;
  return score;
}

export function revisionActiveAt(revision, atMs) {
  const from = Date.parse(revision.effective_from);
  if (atMs < from) return false;
  if (revision.effective_to != null && atMs >= Date.parse(revision.effective_to)) return false;
  return true;
}

// revisions: 同一政策流的全部修订（POLICY_SET 负载）。
// 返回某时刻生效的修订（最高版本），无则 null。
export function activeRevisionAt(revisions, atMs) {
  let winner = null;
  for (const rev of revisions) {
    if (!revisionActiveAt(rev, atMs)) continue;
    if (winner === null || rev.version > winner.version) winner = rev;
  }
  return winner;
}

// 在全部政策流中选出某上下文（成员/设备/类别/日别/时刻）适用的一份修订。
// streams: Map<policy_id, revisions[]>，或数组 [[policy_id, revisions[]]。
// tie 由追加顺序（_seq）确定，保证可重现。
export function selectPolicy(streams, ctx) {
  const atMs = Date.parse(ctx.at);
  let winner = null;

  for (const [policyId, revisions] of streams) {
    const rev = activeRevisionAt(revisions, atMs);
    if (rev === null) continue;
    if (!scopeMatches(rev.scope, ctx)) continue;

    const candidate = { policyId, rev, specificity: scopeSpecificity(rev.scope) };
    if (
      winner === null ||
      candidate.specificity > winner.specificity ||
      (candidate.specificity === winner.specificity &&
        (candidate.rev.version > winner.rev.version ||
          (candidate.rev.version === winner.rev.version && (candidate.rev._seq ?? 0) > (winner.rev._seq ?? 0))))
    ) {
      winner = candidate;
    }
  }

  return winner === null ? null : { policy_id: winner.policyId, ...winner.rev };
}

// 读取某类别在该修订下的每日秒数预算；null 表示不限。
export function resolveDailyLimit(revision, category) {
  const limits = revision.daily_limits_seconds ?? {};
  if (Object.prototype.hasOwnProperty.call(limits, category)) {
    const v = limits[category];
    return v == null ? null : v;
  }
  if (Object.prototype.hasOwnProperty.call(limits, WILDCARD)) {
    const v = limits[WILDCARD];
    return v == null ? null : v;
  }
  return null;
}

// 上学历：政策可携带 school_dates/holidays 快照。
export function calendarFromRevision(revision) {
  const cal = revision?.school_calendar ?? null;
  if (!cal) return { schoolDates: null, holidays: null };
  return {
    schoolDates: Array.isArray(cal.school_dates) ? new Set(cal.school_dates) : null,
    holidays: Array.isArray(cal.holidays) ? new Set(cal.holidays) : null,
  };
}

// 供阻断解释使用的政策坐标。
export function describePolicyTarget(revision) {
  const s = revision.scope;
  return {
    device: s.device_id ?? "all_devices",
    category: s.category ?? "all_categories",
    day_kind: s.day_kind,
  };
}
