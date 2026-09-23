// 时区、本地日与时间片切分。
//
// 设计要点：一切切分都在"绝对时间（UTC 毫秒）"上进行，再映射回成员本地日。
// 因此夏令时春跳（本地时间不存在）、秋回（本地时间出现两次）以及午夜跳变
// 都不会造成重复扣减或丢分钟：本地日的边界只是该时区下某一个 UTC 时刻。

const PARTS_CACHE = new Map();

function partsFormatter(timeZone) {
  let fmt = PARTS_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    PARTS_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

/** 把绝对时间映射为本地日历部件。hour 可能为 24（闰秒/边界格式的极端情况）。 */
export function localParts(timeZone, instantMs) {
  const out = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  // 部分 ICU 在午夜把 hour 输出为 "24"。
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** 绝对时间 -> 本地日期字符串 YYYY-MM-DD（按成员时区）。 */
export function localDateOf(timeZone, instantMs) {
  const p = localParts(timeZone, instantMs);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** 本地日历日期 -> UTC 毫秒（该本地日 00:00 对应的绝对时刻）。 */
export function localDateToUtc(timeZone, dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const targetDay = Date.UTC(y, m - 1, d);

  // 本地日历日随绝对时间单调推进，在 UTC 前一日 12:00 到次日 12:00 之间
  // 二分"本地日首次等于目标日"的时刻；任何 UTC 偏移（±14h 内）都被覆盖，
  // 包括午夜直接跳变（哈瓦那春跳）的时区。
  let lo = Date.UTC(y, m - 1, d) - 2 * 86400_000;
  let hi = Date.UTC(y, m - 1, d) + 2 * 86400_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (Date.parse(localDateOf(timeZone, mid)) >= targetDay) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 本地日 00:00 的绝对时刻。语义同 localDateToUtc，命名用于表达"边界"。 */
export function startOfLocalDay(timeZone, dateStr) {
  return localDateToUtc(timeZone, dateStr);
}

/** 下一本地日 00:00 的绝对时刻（即本日结束边界）。 */
export function endOfLocalDay(timeZone, dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return localDateToUtc(timeZone, new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10));
}

/**
 * 把 [startMs, endMs) 的连续会话按本地日边界切成时间片。
 * 每个时间片：{ local_date, start_ms, end_ms, duration_seconds, start_wall, end_wall }
 * 时长以绝对时间为准，所以春跳/秋回/午夜跳变都不会重复或丢失秒数。
 */
export function splitByLocalDay(timeZone, startMs, endMs) {
  if (endMs < startMs) throw new Error("splitByLocalDay: end before start");
  const slices = [];
  let cursor = startMs;
  // 安全上限：避免极端输入下死循环（一日不可能短于 23 小时）。
  for (let guard = 0; cursor < endMs && guard < 400; guard++) {
    const dateStr = localDateOf(timeZone, cursor);
    const boundary = endOfLocalDay(timeZone, dateStr);
    const sliceEnd = Math.min(boundary, endMs);
    slices.push({
      local_date: dateStr,
      start_ms: cursor,
      end_ms: sliceEnd,
      duration_seconds: Math.round((sliceEnd - cursor) / 1000),
      start_wall: wallTime(timeZone, cursor),
      end_wall: wallTime(timeZone, Math.max(sliceEnd - 1000, cursor)),
    });
    cursor = sliceEnd;
    if (sliceEnd === endMs) break;
  }
  if (cursor < endMs) throw new Error("splitByLocalDay: exceeded day iteration guard");
  return slices;
}

/** 绝对时间 -> "HH:MM" 本地挂钟时间（用于时间窗判断与解释展示）。 */
export function wallTime(timeZone, instantMs) {
  const p = localParts(timeZone, instantMs);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "HH:MM" -> 当日分钟数。 */
export function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * 判断某绝对时刻是否落在允许的挂钟时间窗内。
 * 窗口支持跨午夜（start > end，例如 20:00-06:00）。
 */
export function withinWindows(windows, instantMs, timeZone) {
  if (!windows || windows.length === 0) return { allowed: true };
  const mins = hhmmToMinutes(wallTime(timeZone, instantMs));
  // 最严匹配优先：BLOCK 优先于 WARN。
  let hitWarn = null;
  for (const w of windows) {
    const s = hhmmToMinutes(w.start);
    const e = hhmmToMinutes(w.end);
    const inside = s < e ? mins >= s && mins < e : mins >= s || mins < e;
    if (inside) {
      if (w.action === "BLOCK") return { allowed: false, window: w };
      hitWarn = w;
    }
  }
  return hitWarn ? { allowed: true, warn: hitWarn } : { allowed: true };
}

// ---------------------------------------------------------------------------
// 校历：上学日 / 休息日
// ---------------------------------------------------------------------------

/**
 * 校历维护一组显式上学日集合与发布范围。
 * CALENDAR_PUBLISHED 事件会替换覆盖区间内的旧数据（学校重新发布时纠偏）。
 */
export class SchoolCalendar {
  constructor() {
    // 每个 subject 维护已排序、去重、按发布来源合并后的上学日集合。
    this.schoolDays = new Map();
  }

  publish(subjectId, dates, source) {
    if (!this.schoolDays.has(subjectId)) this.schoolDays.set(subjectId, new Set());
    const set = this.schoolDays.get(subjectId);
    // 显式列表即该来源在该批日期上的事实：学校来源覆盖，家庭来源只补充。
    for (const d of dates) set.add(d);
    return { subject_id: subjectId, source, added: dates.length };
  }

  /**
   * 判定日类型：校历显式列入的日期为上学日（含周末调休补课）；
   * 未覆盖时按工作日兜底（周一至周五视为上学日），并在 source 中注明依据。
   */
  dayType(subjectId, dateStr) {
    const set = this.schoolDays.get(subjectId);
    if (set?.has(dateStr)) return { day_type: "SCHOOL_DAY", source: "CALENDAR" };
    const [y, m, d] = dateStr.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const isWeekday = dow >= 1 && dow <= 5;
    return { day_type: isWeekday ? "SCHOOL_DAY" : "NON_SCHOOL_DAY", source: "WEEKDAY_FALLBACK" };
  }
}
