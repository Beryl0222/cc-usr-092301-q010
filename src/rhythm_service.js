// 核心服务：事件溯源的家庭数字节律引擎。
//
// 所有状态都由只追加的事件重放得到；重启时 RhythmService.replay(events)
// 可完全重建账本、待审批延长与离线合并区间，判定结果保持一致。
// 派生的 INTERVENTION_RAISED 事件只由命令侧追加（确定性 ID），
// 重放期间不产生副作用，因此重放结果与在线执行逐字节一致。
//
// 关键保证：
//   - 政策用 policy_id + version 做乐观并发，expected_version 不符即拒绝；
//   - 消费按 record_id 幂等，重叠区间按并集合并，时钟漂移先夹取可行窗口，
//     因此离线补传/对时纠偏不会反复扣减预算；
//   - 会话在成员本地时区跨午夜切分到正确本地日期（夏令时安全）；
//   - 延长需成员发起、监护人批准，批准范围不得宽于申请，且不得晚于申请到期；
//   - 例外有硬性 expires_at，到期即时失效，撤销/拒绝同样即时失效，杜绝永久绕过；
//   - 撤回画像授权后停止个性化建议；结算争议所需最小记录通过留存标注保留；
//   - 学校共享只输出约定类别、按日按类别的分钟汇总，不含设备与事件标识。

import { makeEvent, validateContractEvent } from "./culture_time_budget.js";
import {
  isWithinWindows,
  localDateAt,
  resolveDayKind,
  splitSessionAcrossMidnight,
} from "./time_slices.js";
import { calendarFromRevision, resolveDailyLimit, scopeMatches, selectPolicy } from "./policy.js";

export class ContractViolationError extends Error {}

export class PolicyConflictError extends Error {
  constructor(policyId, currentVersion, attemptedVersion) {
    super(`policy ${policyId} version conflict: current=${currentVersion} attempted=${attemptedVersion}`);
    this.name = "PolicyConflictError";
    this.policy_id = policyId;
    this.current_version = currentVersion;
    this.attempted_version = attemptedVersion;
  }
}

const REMINDER_RATIO = 0.9;

function bucketKey(memberId, localDate, category) {
  return `${memberId}|${localDate}|${category}`;
}

// 归一化适用范围：成员必填，设备/类别可空，日别缺省为 any。
function normalizeScope(memberId, scope = {}) {
  return {
    member_id: memberId,
    device_id: scope.device_id ?? null,
    category: scope.category ?? null,
    day_kind: scope.day_kind ?? "any",
  };
}

function freshState() {
  return {
    seq: 0,
    eventIds: new Set(),
    policies: new Map(), // policy_id -> revisions[]（POLICY_SET 负载，含 _seq）
    memberTz: new Map(), // member_id -> IANA 时区（取最新政策）
    // bucket -> { intervals(同设备并集), used, exempt, recordIds:Set, reminded, blocked }
    ledger: new Map(),
    records: new Map(), // record_id -> {status, event_id, slices}
    extensions: new Map(), // extension_id -> {request, status, approval?, decline?}
    exceptions: new Map(), // exception_id -> {grant, status, review?}
    resets: new Set(), // `${member_id}|${local_date}`
    withdrawals: new Map(), // member_id -> PROFILE_WITHDRAWN 事件
    retentions: new Map(), // member_id -> [RETENTION_ANNOTATED 负载]
    interventions: new Map(), // intervention_id -> 负载（去重）
    interventionOrder: [],
    schoolShares: [],
    legacy: { budget: 0, limit: 0 },
  };
}

function getBucket(state, key) {
  let b = state.ledger.get(key);
  if (!b) {
    b = { intervals: [], used: 0, exempt: 0, recordIds: new Set(), reminded: false, blocked: false };
    state.ledger.set(key, b);
  }
  return b;
}

// 计算新区间相对“同设备历史区间并集”尚未计费的部分（毫秒）。
// 逐段用旧区间裁剪剩余片段，得到的是精确并集增量，
// 因此同一时段无论被多少条补传记录覆盖都只扣一次。
function uncoveredMillis(bucket, interval) {
  let parts = [{ s: interval.s, e: interval.e }];
  for (const old of bucket.intervals) {
    if (old.device !== interval.device) continue;
    const next = [];
    for (const part of parts) {
      const os = Math.max(part.s, old.s);
      const oe = Math.min(part.e, old.e);
      if (oe <= os) {
        next.push(part);
        continue;
      }
      if (os > part.s) next.push({ s: part.s, e: os });
      if (part.e > oe) next.push({ s: oe, e: part.e });
    }
    parts = next;
  }
  const ms = parts.reduce((sum, p) => sum + (p.e - p.s), 0);
  bucket.intervals.push({ s: interval.s, e: interval.e, device: interval.device });
  return ms;
}

function memberCalendar(state, memberId) {
  let chosen = null;
  for (const revisions of state.policies.values()) {
    for (const rev of revisions) {
      if (rev.scope.member_id !== memberId || !rev.school_calendar) continue;
      if (chosen === null || rev._seq > chosen._seq) chosen = rev;
    }
  }
  return calendarFromRevision(chosen);
}

function memberTimeZone(state, memberId) {
  const tz = state.memberTz.get(memberId);
  if (!tz) throw new ContractViolationError(`no policy/timezone known for member ${memberId}`);
  return tz;
}

function policyContext(state, memberId, deviceId, category, at) {
  const tz = memberTimeZone(state, memberId);
  const localDate = localDateAt(at, tz);
  const dayKind = resolveDayKind(localDate, memberCalendar(state, memberId));
  const selected = selectPolicy(state.policies, { member_id: memberId, device_id: deviceId, category, day_kind: dayKind, at });
  return { tz, localDate, dayKind, selected };
}

function findActiveException(state, ctx) {
  const atMs = Date.parse(ctx.at);
  for (const [exceptionId, entry] of state.exceptions) {
    const g = entry.grant;
    if (entry.status !== "granted") continue;
    if (g.scope.member_id !== ctx.member_id) continue;
    if (atMs < Date.parse(g.granted_at) || atMs >= Date.parse(g.expires_at)) continue;
    if (!scopeMatches(g.scope, ctx)) continue;
    // 必须凭显式用途标记匹配，避免普通短视频被紧急联系/已下载课程例外顺带豁免。
    if (g.kind !== ctx.usage_kind) continue;
    return { exception_id: exceptionId, ...g };
  }
  return null;
}

// 某一日本地类别桶在 at 时刻的预算（基准 + 有效期内的临时延长）。
function budgetAt(state, memberId, localDate, category, deviceId, dayKind, at) {
  const atMs = Date.parse(at);
  const pc = policyContext(state, memberId, deviceId, category, at);
  const base = pc.selected ? resolveDailyLimit(pc.selected, category) : null;
  const policy = pc.selected
    ? { policy_id: pc.selected.policy_id, version: pc.selected.version, effective_from: pc.selected.effective_from }
    : null;

  let extra = 0;
  const extensionIds = [];
  for (const [extensionId, entry] of state.extensions) {
    if (entry.status !== "approved") continue;
    const r = entry.request;
    if (r.member_id !== memberId || r.applies_to_date !== localDate) continue;
    if (Date.parse(entry.approval.valid_until) < atMs) continue;
    // 以监护人批准时实际授予的范围与秒数为准（只能比申请更窄）。
    const scope = entry.approval.scope ?? r.scope;
    if (!scopeMatches(scope, { member_id: memberId, device_id: deviceId, category, day_kind: dayKind })) continue;
    extra += entry.approval.extra_seconds ?? r.extra_seconds;
    extensionIds.push(extensionId);
  }

  return { base, total: base == null ? null : base + extra, extra, extensionIds, policy };
}

export class RhythmService {
  constructor() {
    this.state = freshState();
    this.events = [];
  }

  static replay(events) {
    const svc = new RhythmService();
    for (const event of events) svc.#fold(event);
    svc.events = [...events]; // 事件日志即持久化内容；状态全部来自上面的 fold
    return svc;
  }

  #append(event) {
    this.#fold(event);
    this.events.push(event);
    return event;
  }

  #fold(event) {
    const problems = validateContractEvent(event);
    if (problems.length > 0) throw new ContractViolationError(`${event.kind}(${event.event_id}): ${problems.join(", ")}`);
    if (this.state.eventIds.has(event.event_id)) {
      throw new ContractViolationError(`duplicate event_id ${event.event_id}`);
    }
    const s = this.state;
    s.eventIds.add(event.event_id);
    const p = event.payload;

    switch (event.kind) {
      case "BUDGET_SET":
        s.legacy.budget += 1;
        break;
      case "LIMIT_REACHED":
        s.legacy.limit += 1;
        break;
      case "POLICY_SET":
        this.#foldPolicy(event);
        break;
      case "CONSUMPTION_RECORDED":
        this.#foldConsumption(event);
        break;
      case "DAY_RESET":
        s.resets.add(`${p.member_id}|${p.local_date}`);
        break;
      case "EXTENSION_REQUESTED":
        s.extensions.set(p.extension_id, { request: p, status: "pending" });
        break;
      case "EXTENSION_APPROVED": {
        const entry = s.extensions.get(p.extension_id);
        if (!entry || entry.status !== "pending") {
          throw new ContractViolationError(`extension ${p.extension_id} not awaiting approval`);
        }
        entry.status = "approved";
        entry.approval = p;
        break;
      }
      case "EXTENSION_DECLINED": {
        const entry = s.extensions.get(p.extension_id);
        if (!entry || entry.status !== "pending") {
          throw new ContractViolationError(`extension ${p.extension_id} not awaiting approval`);
        }
        entry.status = "declined";
        entry.decline = p;
        break;
      }
      case "EXCEPTION_GRANTED":
        s.exceptions.set(p.exception_id, { grant: p, status: "granted" });
        break;
      case "EXCEPTION_REVIEWED": {
        const entry = s.exceptions.get(p.exception_id);
        if (!entry) throw new ContractViolationError(`unknown exception ${p.exception_id}`);
        entry.status = p.decision === "approved" ? "granted" : p.decision; // revoked | denied | expired
        entry.review = p;
        break;
      }
      case "INTERVENTION_RAISED":
        if (!s.interventions.has(p.intervention_id)) {
          s.interventions.set(p.intervention_id, p);
          s.interventionOrder.push(p);
        }
        // 重放时重建桶级提醒/阻断标记，保证重启后不会对同一日桶重复发出干预。
        {
          const date = p.basis?.local_date ?? localDateAt(p.at, memberTimeZone(s, p.member_id));
          const b = getBucket(s, bucketKey(p.member_id, date, p.category));
          if (p.mode === "block") b.blocked = true;
          if (p.mode === "reminder") b.reminded = true;
        }
        break;
      case "SCHOOL_SUMMARY_SHARED":
        s.schoolShares.push(p);
        break;
      case "PROFILE_WITHDRAWN":
        s.withdrawals.set(p.member_id, event);
        break;
      case "RETENTION_ANNOTATED": {
        const list = s.retentions.get(p.member_id) ?? [];
        list.push(p);
        s.retentions.set(p.member_id, list);
        break;
      }
      default:
        throw new ContractViolationError(`unknown event kind ${event.kind}`);
    }
  }

  #foldPolicy(event) {
    const s = this.state;
    const p = event.payload;
    const revisions = s.policies.get(p.policy_id) ?? [];
    const current = revisions.length === 0 ? null : revisions[revisions.length - 1].version;
    if (p.expected_version !== current) {
      throw new PolicyConflictError(p.policy_id, current, p.version);
    }
    if (current !== null && p.version <= current) {
      throw new PolicyConflictError(p.policy_id, current, p.version);
    }
    s.policies.set(p.policy_id, [...revisions, { ...p, _seq: s.seq++ }]);
    s.memberTz.set(p.scope.member_id, p.time_zone);
  }

  // 纯状态更新：夹取漂移窗口 → 跨夜切分 → 例外判定 → 并集入账。
  #foldConsumption(event) {
    const s = this.state;
    const p = event.payload;
    if (s.records.has(p.record_id)) return; // 同 record_id 不重复入账

    const tz = memberTimeZone(s, p.member_id);

    // 时钟漂移：设备时间 ± max_skew 给出可行区间，且不可能晚于服务器首报。
    const skewMs = (p.server_window?.max_skew_seconds ?? 0) * 1000;
    let fStart = Date.parse(p.started_at) - skewMs;
    let fEnd = Date.parse(p.ended_at) + skewMs;
    if (p.server_window?.first_seen_at) {
      fEnd = Math.min(fEnd, Date.parse(p.server_window.first_seen_at));
    }
    if (fEnd <= fStart) {
      s.records.set(p.record_id, { status: "rejected", event_id: event.event_id, reason: "infeasible_window" });
      return;
    }

    const slices = splitSessionAcrossMidnight(new Date(fStart).toISOString(), new Date(fEnd).toISOString(), tz);
    const decisionSlices = [];

    for (const slice of slices) {
      const sMs = Date.parse(slice.start_at);
      const eMs = Date.parse(slice.end_at);
      const dayKind = resolveDayKind(slice.local_date, memberCalendar(s, p.member_id));
      const ctx = {
        member_id: p.member_id,
        device_id: p.device_id,
        category: p.category,
        day_kind: dayKind,
        at: slice.end_at,
        usage_kind: p.usage_kind ?? null,
      };
      const ex = findActiveException(s, ctx);
      const b = getBucket(s, bucketKey(p.member_id, slice.local_date, p.category));
      const uncovered = uncoveredMillis(b, { s: sMs, e: eMs, device: p.device_id });

      if (ex) {
        b.exempt += Math.round(uncovered / 1000);
        decisionSlices.push({ ...slice, exempt: true, exception_id: ex.exception_id, charged_seconds: 0 });
      } else {
        b.used += Math.round(uncovered / 1000);
        decisionSlices.push({ ...slice, exempt: false, charged_seconds: Math.round(uncovered / 1000) });
      }
      b.recordIds.add(p.record_id);
    }

    s.records.set(p.record_id, {
      status: "applied",
      event_id: event.event_id,
      member_id: p.member_id,
      device_id: p.device_id,
      category: p.category,
      slices: decisionSlices,
    });
  }

  // 命令侧在入账后按桶触发提醒/阻断；ID 确定性，重放不会重复。
  #raiseInterventions(p, slices) {
    const s = this.state;
    for (const slice of slices) {
      if (slice.exempt) continue;
      const key = bucketKey(p.member_id, slice.local_date, p.category);
      const b = s.ledger.get(key);
      const dayKind = resolveDayKind(slice.local_date, memberCalendar(s, p.member_id));
      const info = budgetAt(s, p.member_id, slice.local_date, p.category, p.device_id, dayKind, slice.end_at);

      const raise = (mode) => {
        const interventionId = `iv-${p.record_id}-${slice.local_date}-${mode}`;
        if (s.interventions.has(interventionId)) return;
        const pc = policyContext(s, p.member_id, p.device_id, p.category, slice.end_at);
        const basis = {
          policy: info.policy,
          local_date: slice.local_date,
          day_kind: dayKind,
          time_slice: { start_at: slice.start_at, end_at: slice.end_at, duration_seconds: slice.charged_seconds },
          daily_limit_seconds: info.base,
          extra_seconds: info.extra,
          extension_ids: info.extensionIds,
          used_seconds: b.used,
          window: pc.selected?.windows ?? null,
          exception: null,
          contributing_record_ids: [...b.recordIds],
          consumption_event_id: s.records.get(p.record_id)?.event_id,
        };
        this.#append(
          makeEvent(
            "INTERVENTION_RAISED",
            p.member_id,
            {
              intervention_id: interventionId,
              member_id: p.member_id,
              device_id: p.device_id,
              category: p.category,
              at: slice.end_at,
              mode,
              basis,
            },
            slice.end_at,
            interventionId,
          ),
        );
        if (mode === "block") b.blocked = true;
        if (mode === "reminder") b.reminded = true;
      };

      if (!b.blocked && b.used >= (info.total ?? Infinity)) raise("block");
      else if (!b.reminded && !b.blocked && b.used >= (info.total ?? Infinity) * REMINDER_RATIO) raise("reminder");
    }
  }

  // ---- 命令 API -----------------------------------------------------------

  setPolicy({
    policyId,
    scope,
    timeZone,
    dailyLimits,
    windows = [],
    effectiveFrom,
    effectiveTo = null,
    actor,
    schoolCalendar = null,
    occurredAt = new Date().toISOString(),
  }) {
    const revisions = this.state.policies.get(policyId) ?? [];
    const current = revisions.length === 0 ? null : revisions[revisions.length - 1].version;
    const payload = {
      policy_id: policyId,
      version: (current ?? 0) + 1,
      expected_version: current,
      scope: { day_kind: "any", ...scope },
      time_zone: timeZone,
      daily_limits_seconds: dailyLimits,
      windows,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      school_calendar: schoolCalendar,
      actor,
    };
    return this.#append(makeEvent("POLICY_SET", scope.member_id, payload, occurredAt));
  }

  // 监护人基于已知版本改策；版本不符抛 PolicyConflictError。
  revisePolicy(policyId, expectedVersion, changes, occurredAt = new Date().toISOString()) {
    const revisions = this.state.policies.get(policyId);
    if (!revisions || revisions.length === 0) throw new ContractViolationError(`unknown policy ${policyId}`);
    const current = revisions[revisions.length - 1];
    if (current.version !== expectedVersion) {
      throw new PolicyConflictError(policyId, current.version, expectedVersion);
    }
    const next = {
      ...current,
      ...changes,
      scope: { ...current.scope, ...(changes.scope ?? {}) },
      school_calendar: changes.school_calendar ?? current.school_calendar ?? null,
      policy_id: policyId,
      version: current.version + 1,
      expected_version: current.version,
    };
    delete next._seq;
    return this.#append(makeEvent("POLICY_SET", next.scope.member_id, next, occurredAt));
  }

  recordConsumption({
    recordId,
    memberId,
    deviceId,
    category,
    startedAt,
    endedAt,
    usageKind = null,
    serverWindow = null,
    occurredAt,
  }) {
    if (this.state.records.has(recordId)) {
      // 同一 record_id 重传：原样返回首次结论，不产生新事件、不重复扣减。
      return { duplicate: true, decision: this.state.records.get(recordId) };
    }
    const payload = {
      record_id: recordId,
      member_id: memberId,
      device_id: deviceId,
      category,
      usage_kind: usageKind,
      started_at: startedAt,
      ended_at: endedAt,
      server_window: serverWindow,
    };
    this.#append(makeEvent("CONSUMPTION_RECORDED", memberId, payload, occurredAt ?? endedAt));
    const decision = this.state.records.get(recordId);
    if (decision.status === "applied") this.#raiseInterventions(payload, decision.slices);
    return { duplicate: false, decision };
  }

  requestExtension({ extensionId, memberId, scope = {}, extraSeconds, reason, requestedAt, appliesToDate, expiresAt }) {
    const payload = {
      extension_id: extensionId,
      member_id: memberId,
      scope: normalizeScope(memberId, scope),
      extra_seconds: extraSeconds,
      reason,
      requested_at: requestedAt,
      applies_to_date: appliesToDate,
      expires_at: expiresAt,
    };
    return this.#append(makeEvent("EXTENSION_REQUESTED", memberId, payload, requestedAt));
  }

  approveExtension(extensionId, guardianId, { approvedAt, validUntil, scope = null, extraSeconds = null }) {
    const entry = this.state.extensions.get(extensionId);
    if (!entry) throw new ContractViolationError(`unknown extension ${extensionId}`);
    if (entry.status !== "pending") throw new ContractViolationError(`extension ${extensionId} already ${entry.status}`);
    if (Date.parse(validUntil) > Date.parse(entry.request.expires_at)) {
      throw new ContractViolationError("approval valid_until exceeds request expires_at");
    }
    if (Date.parse(validUntil) <= Date.parse(approvedAt)) {
      throw new ContractViolationError("extension must be valid for a positive duration");
    }
    // 批准的范围只能是申请范围的子集，时长只能更短。
    const asked = entry.request.scope;
    const grantedScope = scope === null ? asked : normalizeScope(entry.request.member_id, scope);
    if (
      (asked.device_id != null && grantedScope.device_id !== asked.device_id) ||
      (asked.category != null && grantedScope.category !== asked.category)
    ) {
      throw new ContractViolationError("approval scope must be within request scope");
    }
    const grantedExtra = extraSeconds === null ? entry.request.extra_seconds : extraSeconds;
    if (grantedExtra > entry.request.extra_seconds || grantedExtra <= 0) {
      throw new ContractViolationError("approved extra seconds must be within request");
    }
    const payload = {
      extension_id: extensionId,
      guardian_id: guardianId,
      approved_at: approvedAt,
      valid_until: validUntil,
      scope: grantedScope,
      extra_seconds: grantedExtra,
    };
    return this.#append(makeEvent("EXTENSION_APPROVED", entry.request.member_id, payload, approvedAt));
  }

  declineExtension(extensionId, guardianId, declinedAt) {
    const entry = this.state.extensions.get(extensionId);
    if (!entry) throw new ContractViolationError(`unknown extension ${extensionId}`);
    if (entry.status !== "pending") throw new ContractViolationError(`extension ${extensionId} already ${entry.status}`);
    return this.#append(
      makeEvent(
        "EXTENSION_DECLINED",
        entry.request.member_id,
        { extension_id: extensionId, guardian_id: guardianId, declined_at: declinedAt },
        declinedAt,
      ),
    );
  }

  pendingExtensions() {
    return [...this.state.extensions.entries()]
      .filter(([, e]) => e.status === "pending")
      .map(([id, e]) => ({ extension_id: id, ...e.request }));
  }

  grantException({ exceptionId, memberId, kind, scope = {}, requestedBy, grantedBy, grantedAt, expiresAt }) {
    if (Date.parse(expiresAt) <= Date.parse(grantedAt)) {
      throw new ContractViolationError("exception must have a finite positive lifetime");
    }
    if (!["emergency_contact", "downloaded_course"].includes(kind)) {
      throw new ContractViolationError(`unsupported exception kind ${kind}`);
    }
    const payload = {
      exception_id: exceptionId,
      member_id: memberId,
      kind,
      scope: normalizeScope(memberId, scope),
      requested_by: requestedBy,
      granted_by: grantedBy,
      granted_at: grantedAt,
      expires_at: expiresAt,
    };
    return this.#append(makeEvent("EXCEPTION_GRANTED", memberId, payload, grantedAt));
  }

  reviewException(exceptionId, decision, reviewerId, reviewedAt) {
    const entry = this.state.exceptions.get(exceptionId);
    if (!entry) throw new ContractViolationError(`unknown exception ${exceptionId}`);
    return this.#append(
      makeEvent(
        "EXCEPTION_REVIEWED",
        entry.grant.member_id,
        { exception_id: exceptionId, decision, reviewer_id: reviewerId, reviewed_at: reviewedAt },
        reviewedAt,
      ),
    );
  }

  // 调度器：补本地零点重置标记、给已过硬到期时间的例外补过期复核。
  // 全部按确定性幂等键去重，重启后重复运行结果一致。
  runScheduler(nowIso) {
    const now = Date.parse(nowIso);
    for (const memberId of this.state.memberTz.keys()) {
      const tz = memberTimeZone(this.state, memberId);
      const today = localDateAt(now, tz);
      if (!this.state.resets.has(`${memberId}|${today}`)) {
        this.#append(
          makeEvent(
            "DAY_RESET",
            memberId,
            { member_id: memberId, local_date: today, time_zone: tz, at: nowIso },
            nowIso,
            `reset-${memberId}-${today}`,
          ),
        );
      }
    }
    for (const [exceptionId, entry] of this.state.exceptions) {
      if (entry.status !== "granted" || entry.review) continue;
      if (now >= Date.parse(entry.grant.expires_at)) {
        this.#append(
          makeEvent(
            "EXCEPTION_REVIEWED",
            entry.grant.member_id,
            { exception_id: exceptionId, decision: "expired", reviewer_id: "system", reviewed_at: nowIso },
            nowIso,
            `review-${exceptionId}-expired`,
          ),
        );
      }
    }
  }

  // 实时强制执行判定：allow/reminder/block 与完整依据（政策版本/时间片/例外）。
  evaluateAt(memberId, { deviceId, category, usageKind = null, at }) {
    const s = this.state;
    const pc = policyContext(s, memberId, deviceId, category, at);
    const ctx = { member_id: memberId, device_id: deviceId, category, day_kind: pc.dayKind, at, usage_kind: usageKind };
    const ex = findActiveException(s, ctx);
    const b = s.ledger.get(bucketKey(memberId, pc.localDate, category));
    const info = budgetAt(s, memberId, pc.localDate, category, deviceId, pc.dayKind, at);

    const basis = {
      policy: info.policy,
      local_date: pc.localDate,
      day_kind: pc.dayKind,
      evaluated_at: at,
      daily_limit_seconds: info.base,
      extra_seconds: info.extra,
      extension_ids: info.extensionIds,
      used_seconds: b?.used ?? 0,
      exempt_seconds: b?.exempt ?? 0,
      window: pc.selected?.windows ?? null,
      exception: ex
        ? { exception_id: ex.exception_id, kind: ex.kind, expires_at: ex.expires_at, scope: ex.scope }
        : null,
    };

    if (ex) return { mode: "allow", reason: `active_exception:${ex.kind}`, basis };

    if (pc.selected?.windows?.length > 0 && !isWithinWindows(at, pc.tz, pc.selected.windows)) {
      return { mode: "block", reason: "outside_allowed_window", basis };
    }

    if (info.total != null) {
      const used = b?.used ?? 0;
      if (used >= info.total) return { mode: "block", reason: "daily_limit_exceeded", basis };
      if (used >= info.total * REMINDER_RATIO) return { mode: "reminder", reason: "near_daily_limit", basis };
    }
    return { mode: "allow", reason: "within_limits", basis };
  }

  // 个性化建议：撤权后一律停止生成。
  recommendation(memberId, { deviceId, category, at }) {
    const withdrawal = this.state.withdrawals.get(memberId);
    if (withdrawal && Date.parse(withdrawal.payload.written_at) <= Date.parse(at)) {
      return {
        suppressed: true,
        reason: "profile_withdrawn",
        basis: { withdrawal_event_id: withdrawal.event_id, written_at: withdrawal.payload.written_at },
      };
    }
    const verdict = this.evaluateAt(memberId, { deviceId, category, at });
    return {
      suppressed: false,
      suggestion: verdict.mode === "allow" ? "continue_planned_rhythm" : "suggest_alternative_offline_activity",
      verdict,
    };
  }

  withdrawProfile(memberId, writtenAt, scope = { personalization: true }) {
    if (this.state.withdrawals.has(memberId)) {
      throw new ContractViolationError(`profile already withdrawn for ${memberId}`);
    }
    return this.#append(
      makeEvent("PROFILE_WITHDRAWN", memberId, { member_id: memberId, written_at: writtenAt, scope }, writtenAt),
    );
  }

  annotateRetention(memberId, { recordIds, reason, retainUntil, fieldsRetained }, at = new Date().toISOString()) {
    return this.#append(
      makeEvent(
        "RETENTION_ANNOTATED",
        memberId,
        { member_id: memberId, record_ids: recordIds, reason, retain_until: retainUntil, fields_retained: fieldsRetained },
        at,
      ),
    );
  }

  // 脱敏导出：撤权后未列入留存的消费记录删除明细；留存记录仅保留声明字段。
  prunedExport(memberId) {
    const retainedIds = new Set();
    const fields = new Set();
    for (const note of this.state.retentions.get(memberId) ?? []) {
      note.record_ids.forEach((id) => retainedIds.add(id));
      note.fields_retained.forEach((f) => fields.add(f));
    }
    const minimal = ["record_id", "member_id", "category"];

    return this.events.map((event) => {
      if (event.subject_id !== memberId || event.kind !== "CONSUMPTION_RECORDED") return event;
      const clone = structuredClone(event);
      const id = clone.payload.record_id;
      if (retainedIds.has(id)) {
        const kept = {};
        for (const f of new Set([...minimal, ...fields])) {
          if (f in clone.payload) kept[f] = clone.payload[f];
        }
        clone.payload = kept;
      } else {
        clone.payload = { record_id: id, member_id: memberId, redacted: true };
      }
      return clone;
    });
  }

  // 学校共享：仅约定类别、按日按类别汇总到分钟，不含设备/事件/例外明细。
  shareSchoolSummary({ schoolId, memberIds, range, allowedCategories, agreementId, sharedAt = new Date().toISOString() }) {
    const totals = new Map();
    for (const decision of this.state.records.values()) {
      if (decision.status !== "applied") continue;
      if (!memberIds.includes(decision.member_id)) continue;
      if (!allowedCategories.includes(decision.category)) continue;
      for (const slice of decision.slices ?? []) {
        if (slice.local_date < range.from || slice.local_date > range.to || slice.exempt) continue;
        const key = `${decision.member_id}|${slice.local_date}|${decision.category}`;
        totals.set(key, (totals.get(key) ?? 0) + slice.charged_seconds);
      }
    }
    const buckets = [...totals.entries()].map(([key, seconds]) => {
      const [member_id, local_date, category] = key.split("|");
      return { member_id, local_date, category, used_minutes: Math.round(seconds / 60) };
    });
    buckets.sort(
      (a, b) =>
        a.local_date.localeCompare(b.local_date) ||
        a.member_id.localeCompare(b.member_id) ||
        a.category.localeCompare(b.category),
    );

    const payload = {
      school_id: schoolId,
      range,
      buckets,
      basis: { agreement_id: agreementId, allowed_categories: [...allowedCategories], granularity: "day_category_minutes" },
      shared_at: sharedAt,
    };
    return this.#append(makeEvent("SCHOOL_SUMMARY_SHARED", "school:" + schoolId, payload, sharedAt));
  }

  // ---- 查询辅助 -----------------------------------------------------------

  ledgerView(memberId, localDate) {
    const out = {};
    for (const [key, b] of this.state.ledger) {
      if (!key.startsWith(`${memberId}|${localDate}|`)) continue;
      out[key.split("|")[2]] = {
        used_seconds: b.used,
        exempt_seconds: b.exempt,
        interval_count: b.intervals.length,
        record_ids: [...b.recordIds],
      };
    }
    return out;
  }

  interventions() {
    return this.state.interventionOrder;
  }

  policyVersion(policyId) {
    const revisions = this.state.policies.get(policyId);
    return revisions ? revisions[revisions.length - 1].version : null;
  }
}
