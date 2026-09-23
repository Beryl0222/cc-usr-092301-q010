// 核心引擎：事件溯源 fold。
//
// 所有状态都由 append 进来的事件重放得到，不接受外部直接改状态，
// 因此进程重启后重建引擎与重启前一致；定时重置、待审批延长、离线合并
// 都只是事件流的不同投影。
//
// 关键不变量：
//  1. 去重：event_id 与 (subject,device,idempotency_key) 两级幂等，
//     离线设备反复补传同一条记录不会二次扣减预算。
//  2. 真实时间：消费片段用 CLOCK_SYNC 锚点纠正设备时钟漂移；
//     切分与扣减一律使用纠正后的绝对时间，同一事件集永远得到同一结果。
//  3. 本地日：扣减归属到成员政策时区下的本地日，跨午夜片段切到对应日期，
//     DST 春跳/秋回不丢秒、不重秒（见 src/time.js）。
//  4. 可解释：每次允许/提醒/阻断都能给出政策版本、时间片、延长与例外依据。

import { validateEvent } from "./culture_time_budget.js";
import {
  localDateOf,
  startOfLocalDay,
  endOfLocalDay,
  splitByLocalDay,
  hhmmToMinutes,
  withinWindows,
  SchoolCalendar,
} from "./time.js";
import {
  PolicyRegistry,
  VersionConflictError,
  PolicyValidationError,
  resolveRule,
  budgetFor,
  windowsFor,
} from "./policy.js";
import { events } from "./events.js";

export { VersionConflictError, PolicyValidationError };

const MINUTE = 60;
const DAY_MINUTES = 1440;

export class EngineError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 设备时钟：漂移纠正
// ---------------------------------------------------------------------------

class DeviceClocks {
  constructor() {
    // device_id -> [{ device_ms, server_ms }] 按设备时间排序
    this.anchors = new Map();
  }

  sync(deviceId, deviceMs, serverMs) {
    if (!this.anchors.has(deviceId)) this.anchors.set(deviceId, []);
    const list = this.anchors.get(deviceId);
    const anchor = { device_ms: deviceMs, server_ms: serverMs };
    // 按设备时间插入（补传的旧同步点也可能晚到）。
    const i = list.findIndex((a) => a.device_ms > deviceMs);
    if (i === -1) list.push(anchor);
    else list.splice(i, 0, anchor);
  }

  /**
   * 设备读数 -> 估计的真实时间。相邻锚点间线性插值（漂移率缓慢变化），
   * 区间外用最近锚点外推；无任何锚点时零偏移。
   */
  correct(deviceId, deviceMs) {
    const list = this.anchors.get(deviceId);
    if (!list || list.length === 0) return { corrected_ms: deviceMs, offset_ms: 0, anchored: false };
    const at = (a) => ({ corrected_ms: Math.round(deviceMs - (a.device_ms - a.server_ms)), offset_ms: a.device_ms - a.server_ms, anchored: true });
    if (deviceMs <= list[0].device_ms) return at(list[0]);
    const last = list[list.length - 1];
    if (deviceMs >= last.device_ms) return at(last);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (deviceMs >= a.device_ms && deviceMs <= b.device_ms) {
        const ratio = (deviceMs - a.device_ms) / (b.device_ms - a.device_ms);
        const offset = a.device_ms - a.server_ms + ratio * ((b.device_ms - b.server_ms) - (a.device_ms - a.server_ms));
        return { corrected_ms: Math.round(deviceMs - offset), offset_ms: Math.round(offset), anchored: true };
      }
    }
    return { corrected_ms: deviceMs, offset_ms: 0, anchored: false };
  }
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

export class RhythmEngine {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this.policies = new PolicyRegistry();
    this.calendars = new SchoolCalendar();
    this.clocks = new DeviceClocks();

    this.eventLog = []; // 到达顺序的全部已接受事件
    this.seenEventIds = new Set();
    this.seenConsumptionKeys = new Set(); // `${subject}|${device}|${idempotency_key}`

    // subject -> 派生状态
    this.withdrawn = new Map(); // subject -> { at_ms, event_id }
    this.extensions = new Map(); // subject -> { requests, approvals, rejections }
    this.exceptions = new Map(); // subject -> Map<exception_id, doc>
    this.sessions = new Map(); // subject -> [session]（原始设备时间，读取时纠正+切分）
    this.closedDays = new Map(); // subject -> Map<date, { at_ms, totals, late }>
    this.schoolAgreements = new Map(); // subject -> [agreement]
    this.reportLog = []; // 已对外交付的学校汇总审计记录
  }

  // -------------------------------------------------------------------------
  // 事件入口
  // -------------------------------------------------------------------------

  /**
   * 校验、去重并 fold 一条事件。
   * 重复事件返回 { accepted:false, duplicated, reason }，不产生任何扣减。
   */
  append(event) {
    const problems = validateEvent(event);
    if (problems.length > 0) {
      throw new EngineError(`事件校验失败：${problems.join(", ")}`, "EVENT_INVALID", { problems });
    }
    if (this.seenEventIds.has(event.event_id)) {
      return { accepted: false, duplicated: true, reason: "event_id" };
    }
    // 任何已接受事件都可能改变派生结果（时钟锚点、政策版本等），统一失效缓存。
    this._invalidateSliceCache();
    const atMs = Date.parse(event.occurred_at);
    let result = { accepted: true };

    switch (event.kind) {
      case "POLICY_DEFINED":
        this._appendPolicy(event, atMs);
        break;
      case "POLICY_WITHDRAWN":
        this.policies.withdraw(event.payload.policy_id, { at: atMs, by: event.payload.withdrawn_by });
        break;
      case "CALENDAR_PUBLISHED":
        this.calendars.publish(event.payload.subject_id, event.payload.school_days, event.payload.source);
        break;
      case "CLOCK_SYNC":
        this.clocks.sync(
          event.payload.device_id,
          Date.parse(event.payload.device_time),
          Date.parse(event.payload.server_time),
        );
        break;
      case "CONSUMPTION_RECORDED":
        result = this._appendConsumption(event, atMs);
        break;
      case "EXTENSION_REQUESTED":
      case "EXTENSION_APPROVED":
      case "EXTENSION_REJECTED":
        this._appendExtension(event, atMs);
        break;
      case "EXCEPTION_GRANTED":
      case "EXCEPTION_REVOKED":
        this._appendException(event, atMs);
        break;
      case "PROFILE_WITHDRAWN":
        if (!this.withdrawn.has(event.subject_id)) {
          this.withdrawn.set(event.subject_id, { at_ms: atMs, event_id: event.event_id });
        }
        break;
      case "DAY_CLOSED":
        this._appendDayClosed(event, atMs);
        break;
      case "SCHOOL_AGREEMENT_REGISTERED":
        this._appendAgreement(event);
        break;
      case "SCHOOL_REPORT_DELIVERED":
        this.reportLog.push({ event, at_ms: atMs });
        break;
      // 外部系统产生的事件可被回放，引擎不重复派生动作。
      case "LIMIT_REACHED":
      case "BUDGET_SET":
      case "EXCEPTION_REVIEWED":
        break;
      default:
        throw new EngineError(`未处理的事件种类：${event.kind}`, "EVENT_UNKNOWN_KIND");
    }

    // 消费重复时 _appendConsumption 已自行处理登记，避免把重复事件再入日志。
    if (result.accepted !== false || result.duplicated !== true) {
      this.seenEventIds.add(event.event_id);
      this.eventLog.push(event);
    }
    return result;
  }

  /** 重放一组事件（重启恢复）。 */
  replay(events) {
    const out = [];
    for (const e of events) out.push(this.append(e));
    return out;
  }

  _appendPolicy(event, atMs) {
    this.policies.define({ ...event.payload }, { event_id: event.event_id, at: atMs });
  }

  // -------------------------------------------------------------------------
  // 延长：提出 / 批准 / 驳回
  // -------------------------------------------------------------------------

  _extensionState(subjectId) {
    if (!this.extensions.has(subjectId)) {
      this.extensions.set(subjectId, { requests: new Map(), approvals: [], rejections: new Map() });
    }
    return this.extensions.get(subjectId);
  }

  _appendExtension(event, atMs) {
    const p = event.payload;
    const state = this._extensionState(p.subject_id);
    if (event.kind === "EXTENSION_REQUESTED") {
      if (!state.requests.has(p.request_id)) {
        state.requests.set(p.request_id, { ...p, requested_at: atMs });
      }
      return;
    }
    if (event.kind === "EXTENSION_APPROVED") {
      const req = state.requests.get(p.request_id);
      if (!req) {
        throw new EngineError(`批准的延长 ${p.request_id} 没有对应的申请`, "EXTENSION_ORPHAN_APPROVAL");
      }
      if (state.approvals.some((a) => a.request_id === p.request_id)) return; // 重复批准幂等
      // 监护人只能在申请范围内收紧，不能借批准扩大范围（防止批准变成绕过）。
      if (p.extra_minutes > req.extra_minutes) {
        throw new EngineError(
          `批准的分钟数 ${p.extra_minutes} 超过申请的 ${req.extra_minutes}`,
          "EXTENSION_SCOPE_EXCEEDED",
        );
      }
      if (Date.parse(p.valid_to) > Date.parse(req.valid_to)) {
        throw new EngineError("批准有效期超过申请有效期", "EXTENSION_SCOPE_EXCEEDED");
      }
      if ((req.category ?? null) !== (p.category ?? null)) {
        throw new EngineError("批准的内容类别与申请不一致", "EXTENSION_SCOPE_EXCEEDED");
      }
      if ((req.device_id ?? null) !== (p.device_id ?? null)) {
        throw new EngineError("批准的设备范围与申请不一致", "EXTENSION_SCOPE_EXCEEDED");
      }
      state.approvals.push({
        ...p,
        approved_at: atMs,
        valid_from_ms: Date.parse(p.valid_from),
        valid_to_ms: Date.parse(p.valid_to),
      });
      return;
    }
    // EXTENSION_REJECTED
    if (!state.rejections.has(p.request_id)) {
      state.rejections.set(p.request_id, { at: atMs, reviewer: p.reviewer_id, reason: p.reason });
    }
  }

  /** 待审批延长（重启后仍然存在，直到被批准或驳回）。 */
  pendingExtensions(subjectId) {
    const state = this.extensions.get(subjectId);
    if (!state) return [];
    return [...state.requests.values()]
      .filter(
        (r) =>
          !state.approvals.some((a) => a.request_id === r.request_id) &&
          !state.rejections.has(r.request_id),
      )
      .map((r) => ({
        request_id: r.request_id,
        requested_by: r.requested_by,
        extra_minutes: r.extra_minutes,
        valid_to: r.valid_to,
        category: r.category,
        device_id: r.device_id,
      }));
  }

  /**
   * 某本地日生效的延长额度。延长锚定到其 valid_from 所在本地日，
   * 避免跨午夜窗口在两个本地日重复计入分钟数。
   */
  extensionGrantsFor(subjectId, deviceId, category, localDate, dayStartMs, dayEndMs, tz) {
    const state = this.extensions.get(subjectId);
    if (!state) return [];
    return state.approvals.filter((a) => {
      if (a.category && a.category !== category) return false;
      if (a.device_id && a.device_id !== deviceId) return false;
      const anchorDate = localDateOf(tz, a.valid_from_ms);
      return anchorDate === localDate && a.valid_to_ms > dayStartMs && a.valid_from_ms < dayEndMs;
    });
  }

  // -------------------------------------------------------------------------
  // 例外：紧急联系 / 已下载课程
  // -------------------------------------------------------------------------

  _appendException(event, atMs) {
    const p = event.payload;
    // REVOKE 负载不含 subject_id，主体以事件信封为准（GRANT 负载与信封一致）。
    const subjectId = event.kind === "EXCEPTION_GRANTED" ? p.subject_id : event.subject_id;
    if (!this.exceptions.has(subjectId)) this.exceptions.set(subjectId, new Map());
    const map = this.exceptions.get(subjectId);
    if (event.kind === "EXCEPTION_GRANTED") {
      if (map.has(p.exception_id)) {
        throw new EngineError(`例外 ${p.exception_id} 已存在，不能重复授予`, "EXCEPTION_DUPLICATE");
      }
      map.set(p.exception_id, {
        ...p,
        granted_at: atMs,
        valid_from_ms: Date.parse(p.valid_from),
        valid_to_ms: Date.parse(p.valid_to),
        revoked: false,
      });
    } else {
      const rec = map.get(p.exception_id);
      if (!rec) throw new EngineError(`撤回的例外 ${p.exception_id} 不存在`, "EXCEPTION_UNKNOWN");
      rec.revoked = true;
      rec.revoked_at = atMs;
      rec.revoke_reason = p.reason;
    }
  }

  /** 时间片 -> 可用且凭证匹配的例外（有效期、设备、grant_ref/lesson_id 全部对齐）。 */
  matchException(subjectId, slice) {
    const map = this.exceptions.get(subjectId);
    if (!map) return null;
    for (const exc of map.values()) {
      if (exc.revoked) continue;
      if (slice.start_ms >= exc.valid_to_ms || slice.end_ms <= exc.valid_from_ms) continue;
      if (exc.device_id && exc.device_id !== slice.device_id) continue;
      if (exc.type === "EMERGENCY_CONTACT") {
        if (slice.contact_ref && slice.contact_ref === exc.grant_ref) return exc;
      } else if (exc.type === "DOWNLOADED_LESSON") {
        if (slice.downloaded && slice.lesson_id && slice.lesson_id === exc.lesson_id) return exc;
      }
    }
    return null;
  }

  /** 此刻某设备可用例外（含当日剩余额度），供紧急联系/下载课程客户端声明使用。 */
  activeExceptions(subjectId, deviceId, atMs) {
    const map = this.exceptions.get(subjectId);
    if (!map) return [];
    const tz = this.timezoneFor(subjectId, atMs, deviceId);
    const localDate = localDateOf(tz, atMs);
    return [...map.values()]
      .filter(
        (e) =>
          !e.revoked &&
          atMs >= e.valid_from_ms &&
          atMs < e.valid_to_ms &&
          (!e.device_id || e.device_id === deviceId),
      )
      .map((e) => ({
        exception_id: e.exception_id,
        type: e.type,
        grant_ref: e.grant_ref,
        lesson_id: e.lesson_id ?? null,
        valid_to: e.valid_to,
        remaining_cap_seconds: this._exceptionRemaining(subjectId, e, localDate, tz),
      }));
  }

  _exceptionRemaining(subjectId, exc, localDate, tz) {
    const dayStart = startOfLocalDay(tz, localDate);
    const dayEnd = endOfLocalDay(tz, localDate);
    let used = 0;
    for (const s of this._daySlices(subjectId, localDate)) {
      if (s.start_ms >= exc.valid_to_ms || s.end_ms <= exc.valid_from_ms) continue;
      if (this.matchException(subjectId, s)?.exception_id === exc.exception_id) {
        used += Math.min(s.end_ms, exc.valid_to_ms, dayEnd) - Math.max(s.start_ms, exc.valid_from_ms, dayStart);
      }
    }
    // used 是毫秒，上限按秒比较；截断到秒。
    return Math.max(0, exc.usage_cap_minutes * MINUTE - Math.round(used / 1000));
  }

  // -------------------------------------------------------------------------
  // 消费记录：漂移纠正、跨日切分、幂等去重、闭包日冻结
  // -------------------------------------------------------------------------

  _appendConsumption(event, atMs) {
    const p = event.payload;
    const dedupeKey = `${p.subject_id}|${p.device_id}|${p.idempotency_key}`;
    if (this.seenConsumptionKeys.has(dedupeKey)) {
      // 业务键重复（设备换 event_id 重发/补传）：整段忽略，不切分不扣减。
      return { accepted: false, duplicated: true, reason: "idempotency_key" };
    }

    const claimedStart = Date.parse(p.started_at);
    const claimedEnd = p.ended_at
      ? Date.parse(p.ended_at)
      : claimedStart + (p.duration_seconds ?? 0) * 1000;

    const session = {
      key: dedupeKey,
      event_id: event.event_id,
      device_id: p.device_id,
      category: p.category,
      claimed_start_ms: claimedStart,
      claimed_end_ms: claimedEnd,
      downloaded: p.downloaded === true,
      lesson_id: p.lesson_id ?? null,
      contact_ref: p.contact_ref ?? null,
      arrived_at: atMs,
    };

    // 用"当前已知"锚点做一次入帐校验：纠正后跨度必须为正，且能归属到某政策时区。
    // 之后若有更晚到达的 CLOCK_SYNC，派生时会自动使用新锚点重新纠正。
    const startNow = this.clocks.correct(p.device_id, claimedStart).corrected_ms;
    const endNow = this.clocks.correct(p.device_id, claimedEnd).corrected_ms;
    if (endNow < startNow) {
      throw new EngineError("纠正时钟漂移后片段结束早于开始", "CONSUMPTION_NEGATIVE_SPAN", {
        idempotency_key: p.idempotency_key,
      });
    }
    if (!this.policies.select(p.subject_id, p.device_id, p.category, startNow)) {
      throw new EngineError(
        `成员 ${p.subject_id} 在该时刻没有适用政策，无法归属本地日`,
        "POLICY_NOT_FOUND",
        { at: new Date(startNow).toISOString(), category: p.category },
      );
    }

    if (!this.sessions.has(p.subject_id)) this.sessions.set(p.subject_id, []);
    this.sessions.get(p.subject_id).push(session);
    // 业务键去重状态在此提交；event_id 去重与日志由 append() 统一处理，
    // 避免同一条事件被登记两次。
    this.seenConsumptionKeys.add(dedupeKey);

    // 每个受影响 (设备,类别,本地日) 给出当日分配，便于调用方立即拿到解释。
    const allocations = [];
    const seen = new Set();
    for (const s of this._deriveSlices(p.subject_id).filter((x) => x.event_id === event.event_id)) {
      const k = `${s.device_id}|${s.category}|${s.local_date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      allocations.push(this.allocateDay(p.subject_id, s.device_id, s.category, s.local_date));
    }
    return { accepted: true, slices: this._deriveSlices(p.subject_id).filter((x) => x.event_id === event.event_id), allocations };
  }

  /**
   * 从原始会话 + 当前全部时钟锚点派生时间片。
   * 每次都用完整锚点集纠正，所以 CLOCK_SYNC 早到或晚到、补传乱序都得到同一结果。
   */
  _deriveSlices(subjectId) {
    if (this._sliceCache?.has(subjectId)) return this._sliceCache.get(subjectId);
    const out = [];
    for (const sess of this.sessions.get(subjectId) ?? []) {
      const start = this.clocks.correct(sess.device_id, sess.claimed_start_ms).corrected_ms;
      const end = this.clocks.correct(sess.device_id, sess.claimed_end_ms).corrected_ms;
      if (end < start) continue;
      const selected = this.policies.select(subjectId, sess.device_id, sess.category, start);
      if (!selected) continue;
      const tz = selected.policy.timezone;
      for (const part of splitByLocalDay(tz, start, end)) {
        out.push({
          key: sess.key,
          event_id: sess.event_id,
          device_id: sess.device_id,
          category: sess.category,
          local_date: part.local_date,
          start_ms: part.start_ms,
          end_ms: part.end_ms,
          seconds: part.duration_seconds,
          downloaded: sess.downloaded,
          lesson_id: sess.lesson_id,
          contact_ref: sess.contact_ref,
          arrived_at: sess.arrived_at,
        });
      }
    }
    out.sort((a, b) => a.start_ms - b.start_ms || a.event_id.localeCompare(b.event_id));
    this._sliceCache ??= new Map();
    this._sliceCache.set(subjectId, out);
    return out;
  }

  _invalidateSliceCache() {
    this._sliceCache = null;
  }

  // -------------------------------------------------------------------------
  // 单日分配：时间窗阻断 -> 例外（带上限）-> 基础预算 -> 延长 -> 超时
  // -------------------------------------------------------------------------

  _daySlices(subjectId, localDate) {
    return this.slicesFor(subjectId).filter((s) => s.local_date === localDate);
  }

  /** 成员全部派生时间片（已纠正漂移、已切分本地日）。 */
  slicesFor(subjectId) {
    return this._deriveSlices(subjectId);
  }

  /** 结账快照形成后才到达、却归属该日的时间片（离线补传冲突）。 */
  _lateSlices(subjectId, localDate) {
    const closed = this.closedDays.get(subjectId)?.get(localDate);
    if (!closed) return [];
    return this._daySlices(subjectId, localDate).filter((s) => s.arrived_at >= closed.at_ms);
  }

  /** 找到成员在某本地日适用的政策版本；换时区改版本时反复重锚直到稳定。 */
  _selectForDay(subjectId, deviceId, category, localDate, tzSeed) {
    let tz = tzSeed;
    let selected = null;
    for (let i = 0; i < 3; i++) {
      const next = this.policies.select(subjectId, deviceId, category, startOfLocalDay(tz, localDate));
      if (!next) return null;
      if (selected && next.policy.policy_id === selected.policy.policy_id && next.version === selected.version) break;
      selected = next;
      tz = next.policy.timezone;
    }
    return selected;
  }

  /** 推断成员当前主时区（用于尚无消费时的日界计算）。 */
  timezoneFor(subjectId, atMs = this._now(), deviceId = null, category = "SHORT_VIDEO") {
    const candidates = deviceId ? [deviceId] : [...new Set(this._deriveSlices(subjectId).map((s) => s.device_id))];
    for (const d of candidates) {
      const sel = this.policies.select(subjectId, d, category, atMs);
      if (sel) return sel.policy.timezone;
    }
    return this.timezonesForAny(subjectId);
  }

  /** 成员任意政策时区（不依赖时刻），无政策时兜底 UTC。 */
  timezonesForAny(subjectId) {
    return this.policies.timezonesFor(subjectId)[0] ?? "UTC";
  }

  /**
   * 把一天内某设备/类别的全部时间片按真实开始顺序分配到各池子。
   * 只依赖已存时间片集合，与到达顺序无关——离线补传、乱序、重启重建结果一致。
   */
  allocateDay(subjectId, deviceId, category, localDate) {
    const tz0 =
      this.policies.timezoneFor(subjectId, deviceId, category) ??
      this.timezonesForAny(subjectId);
    const selected = this._selectForDay(subjectId, deviceId, category, localDate, tz0);
    if (!selected) return null;
    const tz = selected.policy.timezone;
    const dayStart = startOfLocalDay(tz, localDate);
    const dayEnd = endOfLocalDay(tz, localDate);
    const dayInfo = this.calendars.dayType(subjectId, localDate);
    const rule = resolveRule(selected.policy, dayInfo.day_type);
    const baseMinutes = rule ? budgetFor(rule, category) : null;
    const windows = rule ? windowsFor(rule, category) : [];
    const grants = this.extensionGrantsFor(subjectId, deviceId, category, localDate, dayStart, dayEnd, tz);
    const baseSeconds = baseMinutes === null ? null : baseMinutes * MINUTE;
    const extensionSeconds = grants.reduce((sum, g) => sum + g.extra_minutes * MINUTE, 0);

    // 把时间片在时间窗边界处进一步切开（时间片只在午夜切过，窗边界可能在日内）。
    const transitions = new Set();
    for (const w of windows) {
      const s = hhmmToMinutes(w.start);
      const e = hhmmToMinutes(w.end);
      if (s < e) transitions.add(s).add(e);
      else {
        transitions.add(s).add(DAY_MINUTES).add(0).add(e); // 跨午夜窗
      }
    }
    transitions.delete(0);

    const segments = [];
    for (const s of this._daySlices(subjectId, localDate).filter(
      (x) => x.device_id === deviceId && x.category === category,
    )) {
      // 与本日边界相交（迟到/边界数据），换算为日内秒数。
      const segStart = Math.max(s.start_ms, dayStart);
      const segEnd = Math.min(s.end_ms, dayEnd);
      if (segEnd <= segStart) continue;
      const startMin = (segStart - dayStart) / 60000;
      const endMin = (segEnd - dayStart) / 60000;
      const cuts = [...transitions].filter((t) => t > startMin && t < endMin).sort((a, b) => a - b);
      let cur = startMin;
      for (const c of cuts) {
        segments.push({ slice: s, startMin: cur, endMin: c });
        cur = c;
      }
      segments.push({ slice: s, startMin: cur, endMin: endMin });
    }

    // 例外当日上限：exception_id -> 剩余秒
    const excCaps = new Map();
    for (const exc of (this.exceptions.get(subjectId) ?? new Map()).values()) {
      if (exc.revoked) continue;
      if (exc.valid_to_ms <= dayStart || exc.valid_from_ms >= dayEnd) continue;
      if (exc.device_id && exc.device_id !== deviceId) continue;
      excCaps.set(exc.exception_id, exc.usage_cap_minutes * MINUTE);
    }

    const lines = [];
    let baseUsed = 0;
    let extensionUsed = 0;
    let exceptionUsedTotal = 0;
    let windowBlocked = 0;
    let overrun = 0;

    for (const seg of segments) {
      const seconds = Math.round((seg.endMin - seg.startMin) * 60);
      if (seconds <= 0) continue;
      const lineStartMs = dayStart + Math.round(seg.startMin * 60000);
      const lineEndMs = dayStart + Math.round(seg.endMin * 60000);
      const probeMs = dayStart + Math.round(((seg.startMin + seg.endMin) / 2) * 60000);
      const line = { slice: seg.slice, start_ms: lineStartMs, end_ms: lineEndMs, pools: [] };
      let remaining = seconds;

      // 1) 例外池最优先：紧急联系/下载课程在有效期与凭证匹配时，
      //    既绕过预算也绕过静默时间窗；超出当日上限的部分才回到常规判定。
      const exc = this.matchException(subjectId, { ...seg.slice, start_ms: lineStartMs, end_ms: lineEndMs });
      if (exc && excCaps.has(exc.exception_id)) {
        const take = Math.min(remaining, excCaps.get(exc.exception_id));
        if (take > 0) {
          line.pools.push({
            kind: "EXCEPTION",
            seconds: take,
            exception_id: exc.exception_id,
            type: exc.type,
            grant_ref: exc.grant_ref,
          });
          excCaps.set(exc.exception_id, excCaps.get(exc.exception_id) - take);
          exceptionUsedTotal += take;
          remaining -= take;
        }
      }

      if (remaining <= 0) {
        lines.push(line);
        continue;
      }

      // 2) 静默时间窗阻断（例外额度之外的部分）。
      const win = withinWindows(windows, probeMs, tz);
      if (!win.allowed) {
        line.pools.push({ kind: "WINDOW_BLOCKED", seconds: remaining, window: win.window });
        windowBlocked += remaining;
        lines.push(line);
        continue;
      }

      // 3) 常规池：先基础预算，再延长，最后计超时。
      if (baseSeconds === null) {
        line.pools.push({ kind: "UNLIMITED", seconds: remaining });
        baseUsed += remaining;
        lines.push(line);
        continue;
      }

      const takeBase = Math.min(remaining, Math.max(0, baseSeconds - baseUsed));
      if (takeBase > 0) {
        line.pools.push({ kind: "BASE", seconds: takeBase });
        baseUsed += takeBase;
        remaining -= takeBase;
      }
      const takeExt = Math.min(remaining, Math.max(0, extensionSeconds - extensionUsed));
      if (takeExt > 0) {
        line.pools.push({ kind: "EXTENSION", seconds: takeExt, grants: grants.map((g) => g.request_id) });
        extensionUsed += takeExt;
        remaining -= takeExt;
      }
      if (remaining > 0) {
        line.pools.push({ kind: "OVERRUN", seconds: remaining });
        overrun += remaining;
      }
      lines.push(line);
    }

    return {
      subject_id: subjectId,
      device_id: deviceId,
      category,
      local_date: localDate,
      timezone: tz,
      day_type: dayInfo,
      policy: {
        policy_id: selected.policy.policy_id,
        version: selected.version,
        effective_from: selected.policy.effective_from,
        effective_to: selected.policy.effective_to ?? null,
        scope: selected.policy.scope ?? null,
        created_by: selected.policy.created_by,
      },
      windows,
      base_limit_seconds: baseSeconds,
      extension_seconds: extensionSeconds,
      extension_grants: grants.map((g) => ({
        request_id: g.request_id,
        approved_by: g.approved_by,
        extra_minutes: g.extra_minutes,
        valid_from: g.valid_from,
        valid_to: g.valid_to,
      })),
      base_used_seconds: baseUsed,
      extension_used_seconds: extensionUsed,
      regular_used_seconds: baseUsed + extensionUsed,
      exception_used_seconds: exceptionUsedTotal,
      exception_caps: [...excCaps.entries()].map(([id, left]) => {
        const exc = this.exceptions.get(subjectId).get(id);
        const cap = exc.usage_cap_minutes * MINUTE;
        return { exception_id: id, used_seconds: cap - left, cap_seconds: cap };
      }),
      overrun_seconds: overrun,
      window_blocked_seconds: windowBlocked,
      lines,
    };
  }

  // -------------------------------------------------------------------------
  // 实时决策与解释
  // -------------------------------------------------------------------------

  /**
   * 评估"此刻开始 durationSeconds 的使用请求"。
   * exceptionClaim：声明走例外（{contact_ref} 紧急联系或 {lesson_id} 下载课程），
   * 匹配成功的部分绕过静默窗与预算，但仍受例外当日上限约束。
   * 返回 ALLOWED / WARNED / BLOCKED 与完整依据：政策版本、本地日、时间片、
   * 时间窗、已用额度、延长与例外。
   */
  evaluate(subjectId, deviceId, category, atMs, { durationSeconds = 0, exceptionClaim = null } = {}) {
    const selected = this.policies.select(subjectId, deviceId, category, atMs);
    if (!selected) {
      return {
        outcome: "BLOCKED",
        reasons: ["POLICY_NOT_FOUND"],
        at_ms: atMs,
        explanation: this.explain(subjectId, deviceId, category, atMs),
      };
    }
    const tz = selected.policy.timezone;
    const localDate = localDateOf(tz, atMs);
    const windows = windowsFor(resolveRule(selected.policy, this.calendars.dayType(subjectId, localDate).day_type), category);
    const win = withinWindows(windows, atMs, tz);
    const explanation = this.explain(subjectId, deviceId, category, atMs);

    // 例外优先：凭证匹配且额度未满时，紧急联系/下载课程绕过时间窗与预算。
    let claimed = null;
    let claimedSeconds = 0;
    if (exceptionClaim) {
      claimed = this._claimException(subjectId, deviceId, atMs, exceptionClaim);
      if (claimed) claimedSeconds = Math.min(durationSeconds, claimed.remaining_cap_seconds);
    }

    if (!win.allowed) {
      // 静默窗内：只有凭证匹配的例外额度可放行。
      if (claimedSeconds === 0) {
        return { outcome: "BLOCKED", reasons: ["WINDOW_BLOCKED"], at_ms: atMs, window: win.window, explanation };
      }
      if (claimedSeconds >= durationSeconds) {
        return {
          outcome: "ALLOWED",
          reasons: ["EXCEPTION_ALLOWED", "WINDOW_EXEMPT"],
          at_ms: atMs,
          allowed_seconds: durationSeconds,
          blocked_seconds: 0,
          exception: {
            exception_id: claimed.exception_id,
            type: claimed.type,
            granted_seconds: durationSeconds,
            remaining_cap_seconds: claimed.remaining_cap_seconds,
            valid_to: claimed.valid_to,
          },
          window: win.window,
          active_exceptions: this.activeExceptions(subjectId, deviceId, atMs),
          explanation,
        };
      }
      return {
        outcome: "BLOCKED",
        reasons: ["EXCEPTION_PARTIAL", "WINDOW_BLOCKED"],
        at_ms: atMs,
        allowed_seconds: claimedSeconds,
        blocked_seconds: durationSeconds - claimedSeconds,
        exception: {
          exception_id: claimed.exception_id,
          type: claimed.type,
          granted_seconds: claimedSeconds,
          remaining_cap_seconds: claimed.remaining_cap_seconds,
          valid_to: claimed.valid_to,
        },
        window: win.window,
        active_exceptions: this.activeExceptions(subjectId, deviceId, atMs),
        explanation,
      };
    }

    const proposed = splitByLocalDay(tz, atMs, atMs + durationSeconds * 1000);
    let blockedSeconds = 0;
    let allowedSeconds = claimedSeconds;
    let regularToCheck = durationSeconds - claimedSeconds;
    for (const part of proposed) {
      if (regularToCheck <= 0) break;
      const alloc = this.allocateDay(subjectId, deviceId, category, part.local_date);
      if (!alloc) {
        blockedSeconds += part.duration_seconds;
        continue;
      }
      const capacity = alloc.base_limit_seconds === null
        ? Infinity
        : alloc.base_limit_seconds + alloc.extension_seconds;
      const remaining = capacity - alloc.regular_used_seconds;
      const want = Math.min(part.duration_seconds, regularToCheck);
      const take = Math.min(want, Math.max(0, remaining));
      allowedSeconds += take;
      blockedSeconds += want - take;
      regularToCheck -= want;
    }

    const reasons = [];
    let outcome = "ALLOWED";
    if (blockedSeconds > 0) {
      outcome = "BLOCKED";
      reasons.push(claimed ? "EXCEPTION_PARTIAL_BUDGET_EXHAUSTED" : "BUDGET_EXHAUSTED");
    } else if (win.warn) {
      outcome = "WARNED";
      reasons.push("WINDOW_WARN");
    }
    if (claimed) {
      reasons.unshift(claimedSeconds === durationSeconds ? "EXCEPTION_ALLOWED" : "EXCEPTION_PARTIAL");
    }
    return {
      outcome,
      reasons,
      at_ms: atMs,
      allowed_seconds: allowedSeconds,
      blocked_seconds: blockedSeconds,
      exception: claimed
        ? {
            exception_id: claimed.exception_id,
            type: claimed.type,
            granted_seconds: claimedSeconds,
            remaining_cap_seconds: claimed.remaining_cap_seconds,
            valid_to: claimed.valid_to,
          }
        : null,
      window: win.warn ?? null,
      active_exceptions: this.activeExceptions(subjectId, deviceId, atMs),
      explanation,
    };
  }

  /** 校验实时例外声明：凭证必须与某条有效、未撤回、设备匹配的例外对齐。 */
  _claimException(subjectId, deviceId, atMs, claim) {
    const active = this.activeExceptions(subjectId, deviceId, atMs);
    return (
      active.find((e) => {
        if (claim.contact_ref !== undefined)
          return e.type === "EMERGENCY_CONTACT" && e.grant_ref === claim.contact_ref;
        if (claim.lesson_id !== undefined)
          return e.type === "DOWNLOADED_LESSON" && e.lesson_id === claim.lesson_id;
        return false;
      }) ?? null
    );
  }

  /** 某次提醒/阻断/允许的完整解释：政策版本、时间片、延长与例外依据。 */
  explain(subjectId, deviceId, category, atMs) {
    const selected = this.policies.select(subjectId, deviceId, category, atMs);
    const tz = selected?.policy.timezone ?? this.timezoneFor(subjectId, atMs, deviceId, category);
    const localDate = localDateOf(tz, atMs);
    const dayInfo = this.calendars.dayType(subjectId, localDate);
    const rule = selected ? resolveRule(selected.policy, dayInfo.day_type) : null;
    const alloc = selected ? this.allocateDay(subjectId, deviceId, category, localDate) : null;
    return {
      at: new Date(atMs).toISOString(),
      timezone: tz,
      local_date: localDate,
      day_type: dayInfo.day_type,
      day_type_source: dayInfo.source,
      policy: selected
        ? {
            policy_id: selected.policy.policy_id,
            version: selected.version,
            effective_from: selected.policy.effective_from,
            effective_to: selected.policy.effective_to ?? null,
            scope: selected.policy.scope ?? null,
            created_by: selected.policy.created_by,
          }
        : null,
      rule: rule ? { day_type: rule.day_type, budgets: rule.budgets ?? [], windows: rule.windows ?? [] } : null,
      usage: alloc
        ? {
            base_limit_minutes: alloc.base_limit_seconds === null ? null : alloc.base_limit_seconds / MINUTE,
            extension_minutes: alloc.extension_seconds / MINUTE,
            extension_grants: alloc.extension_grants,
            used_minutes: alloc.regular_used_seconds / MINUTE,
            exception_used_minutes: alloc.exception_used_seconds / MINUTE,
            exceptions: alloc.exception_caps,
            overrun_minutes: alloc.overrun_seconds / MINUTE,
            window_blocked_minutes: alloc.window_blocked_seconds / MINUTE,
            slices: alloc.lines.map((l) => ({
              start: new Date(l.start_ms).toISOString(),
              end: new Date(l.end_ms).toISOString(),
              pools: l.pools,
            })),
          }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // 日结（定时重置的一致性依据）
  // -------------------------------------------------------------------------

  _appendDayClosed(event, atMs) {
    const p = event.payload;
    if (!this.closedDays.has(p.subject_id)) this.closedDays.set(p.subject_id, new Map());
    const map = this.closedDays.get(p.subject_id);
    if (map.has(p.local_date)) return; // 重复结账幂等，保留首次快照
    map.set(p.local_date, {
      at_ms: atMs,
      totals: p.totals_by_category ?? this.dailyTotals(p.subject_id, p.local_date),
      event_id: event.event_id,
    });
  }

  /**
   * 结账：冻结某本地日汇总。通常由定时任务在本地日结束后调用；
   * 重启后定时任务只需对未结账日期补跑，结果与实时结账一致（纯重放）。
   * 结账后到达的该日补传进入 late 挂起列表，绝不改动冻结快照。
   */
  closeDay(subjectId, localDate) {
    if (!this.closedDays.has(subjectId)) this.closedDays.set(subjectId, new Map());
    const map = this.closedDays.get(subjectId);
    if (map.has(localDate)) return { duplicated: true, closed: map.get(localDate) };
    const totals = this.dailyTotals(subjectId, localDate);
    // DAY_CLOSED 的事件时间即真实结账时刻；重放与实时结账对"迟到补传"判定一致。
    const closedAt = this._now();
    const event = events.dayClosed(subjectId, localDate, new Date(closedAt).toISOString(), totals);
    map.set(localDate, { at_ms: closedAt, totals, event_id: event.event_id });
    this.seenEventIds.add(event.event_id);
    this.eventLog.push(event);
    return { duplicated: false, closed: map.get(localDate), event };
  }

  /** 定时任务入口：结账所有"已结束且有数据"的本地日。幂等。 */
  closeDueDays(subjectId, atMs = this._now()) {
    const dates = new Set(this._deriveSlices(subjectId).map((s) => s.local_date));
    const out = [];
    for (const date of [...dates].sort()) {
      if (this.closedDays.get(subjectId)?.has(date)) continue;
      // 该日是否已结束：以当日各 (设备,类别) 所选政策时区的日界为准。
      const daySlices = this._daySlices(subjectId, date);
      const due = daySlices.every((s) => {
        const tz = this.policies.select(subjectId, s.device_id, s.category, s.start_ms)?.policy.timezone
          ?? this.timezonesForAny(subjectId);
        return endOfLocalDay(tz, date) <= atMs;
      });
      if (due) out.push(this.closeDay(subjectId, date));
    }
    return out;
  }

  /** 某日按类别汇总（秒与分钟）。冻结快照之外的争议核对也用它。 */
  dailyTotals(subjectId, localDate) {
    const daySlices = this._daySlices(subjectId, localDate);
    const totals = {};
    for (const s of daySlices) {
      (totals[s.category] ??= { seconds: 0, overrun_seconds: 0, window_blocked_seconds: 0, exception_seconds: 0 }).seconds += s.seconds;
    }
    const pairs = new Set(daySlices.map((s) => `${s.device_id}|${s.category}`));
    for (const pair of pairs) {
      const [deviceId, category] = pair.split("|");
      const alloc = this.allocateDay(subjectId, deviceId, category, localDate);
      if (!alloc) continue;
      totals[category].overrun_seconds += alloc.overrun_seconds;
      totals[category].window_blocked_seconds += alloc.window_blocked_seconds;
      totals[category].exception_seconds += alloc.exception_used_seconds;
    }
    for (const v of Object.values(totals)) {
      v.minutes = Math.round(v.seconds / MINUTE);
      v.overrun_minutes = Math.round(v.overrun_seconds / MINUTE);
      v.window_blocked_minutes = Math.round(v.window_blocked_seconds / MINUTE);
      v.exception_minutes = Math.round(v.exception_seconds / MINUTE);
    }
    return totals;
  }

  /** 结账快照形成后才到达、却归属该日的补传（离线合并冲突），供结算争议复核。 */
  lateArrivals(subjectId, localDate) {
    return this._lateSlices(subjectId, localDate);
  }

  // -------------------------------------------------------------------------
  // 学校协议与汇总
  // -------------------------------------------------------------------------

  _appendAgreement(event) {
    const p = event.payload;
    for (const sid of p.subject_ids) {
      if (!this.schoolAgreements.has(sid)) this.schoolAgreements.set(sid, []);
      this.schoolAgreements.get(sid).push({ ...p });
    }
  }

  /**
   * 生成学校汇总：严格限制在协议约定的成员、类别、字段与日期范围内，
   * 只输出按日按类别的粗粒度聚合，不输出逐事件明细。
   * 优先使用结账冻结快照，保证学校拿到的数字与结算口径一致。
   */
  buildSchoolReport(schoolId, subjectIds, periodFrom, periodTo, { fields } = {}) {
    const days = enumerateDates(periodFrom, periodTo);
    const rows = [];
    for (const subjectId of subjectIds) {
      const agreement = this._findAgreement(schoolId, subjectId, periodFrom, periodTo);
      if (!agreement) {
        throw new EngineError(
          `学校 ${schoolId} 与成员 ${subjectId} 在该期间没有有效协议`,
          "SCHOOL_AGREEMENT_REQUIRED",
        );
      }
      const wanted = fields ?? agreement.fields;
      for (const f of wanted) {
        if (!agreement.fields.includes(f)) {
          throw new EngineError(`字段 ${f} 超出协议约定范围`, "SCHOOL_AGREEMENT_FIELD_DENIED", { field: f });
        }
      }
      const allowedFields = new Set(wanted);
      for (const date of days) {
        const row = { subject_id: subjectId, date, school_id: schoolId };
        if (allowedFields.has("DAILY_TOTALS_BY_CATEGORY")) {
          const totals = this.closedDays.get(subjectId)?.get(date)?.totals
            ?? this.dailyTotals(subjectId, date);
          const byCat = {};
          for (const cat of agreement.categories) {
            if (totals[cat]) {
              byCat[cat] = {
                minutes: totals[cat].minutes,
                overrun_minutes: totals[cat].overrun_minutes ?? 0,
                window_blocked_minutes: totals[cat].window_blocked_minutes ?? 0,
              };
            } else {
              byCat[cat] = { minutes: 0, overrun_minutes: 0, window_blocked_minutes: 0 };
            }
          }
          row.totals_by_category = byCat;
        }
        if (allowedFields.has("DAILY_LIMIT_HITS")) {
          row.limit_hits = this._limitHits(subjectId, date, agreement.categories);
        }
        if (allowedFields.has("POLICY_COMPLIANCE_RATE")) {
          row.compliance_rate = this._complianceRate(subjectId, date, agreement.categories);
        }
        rows.push(row);
      }
    }
    return {
      school_id: schoolId,
      period_from: periodFrom,
      period_to: periodTo,
      granularity: "DAILY_BY_CATEGORY",
      rows,
    };
  }

  _findAgreement(schoolId, subjectId, from, to) {
    const list = this.schoolAgreements.get(subjectId) ?? [];
    return (
      list.find(
        (a) =>
          a.school_id === schoolId &&
          a.effective_from <= from &&
          (a.effective_to === undefined || a.effective_to >= to),
      ) ?? null
    );
  }

  _dayDeviceCategories(subjectId, localDate) {
    const devices = new Map();
    for (const s of this._daySlices(subjectId, localDate)) {
      if (!devices.has(s.device_id)) devices.set(s.device_id, new Set());
      devices.get(s.device_id).add(s.category);
    }
    return devices;
  }

  _limitHits(subjectId, localDate, categories) {
    let hits = 0;
    for (const [deviceId, cats] of this._dayDeviceCategories(subjectId, localDate)) {
      for (const category of cats) {
        if (!categories.includes(category)) continue;
        const alloc = this.allocateDay(subjectId, deviceId, category, localDate);
        if (alloc && (alloc.overrun_seconds > 0 || alloc.window_blocked_seconds > 0)) hits += 1;
      }
    }
    return hits;
  }

  _complianceRate(subjectId, localDate, categories) {
    let total = 0;
    let compliant = 0;
    for (const [deviceId, cats] of this._dayDeviceCategories(subjectId, localDate)) {
      for (const category of cats) {
        if (!categories.includes(category)) continue;
        const alloc = this.allocateDay(subjectId, deviceId, category, localDate);
        if (!alloc) continue;
        const used = alloc.regular_used_seconds + alloc.overrun_seconds + alloc.window_blocked_seconds;
        if (used === 0) continue;
        total += 1;
        if (alloc.overrun_seconds === 0 && alloc.window_blocked_seconds === 0) compliant += 1;
      }
    }
    return total === 0 ? null : Number((compliant / total).toFixed(4));
  }

  /** 登记一次实际对外交付（审计：谁、何时、拿到了哪个期间的汇总）。 */
  recordReportDelivery(event) {
    return this.append(event);
  }

  // -------------------------------------------------------------------------
  // 撤权状态（个性化建议模块据此停机）
  // -------------------------------------------------------------------------

  profileWithdrawnAt(subjectId) {
    return this.withdrawn.get(subjectId)?.at_ms ?? null;
  }

  isProfileWithdrawn(subjectId, atMs = this._now()) {
    const w = this.withdrawn.get(subjectId);
    return !!w && w.at_ms <= atMs;
  }
}

// ---------------------------------------------------------------------------

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

export const __test__ = { enumerateDates, DeviceClocks, MINUTE };
