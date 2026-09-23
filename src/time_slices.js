// 时区与时间片工具。
//
// 不依赖 Temporal（当前 Node 默认未启用），全部通过 Intl.DateTimeFormat
// 读取指定 IANA 时区下的墙钟分量，因此对夏令时跳变是安全的：
// 时刻 -> 本地分量永远有定义；本地分量 -> 时刻在跳变空档/重叠时按
// disambiguation 规则解析（与 Temporal 的 compatible 同义）。

const PARTS_FORMATTER_CACHE = new Map();

function partsFormatter(timeZone) {
  let fmt = PARTS_FORMATTER_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    PARTS_FORMATTER_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// 返回某时刻在 tz 下的本地分量。
export function zonedParts(instant, timeZone) {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === 24 ? 0 : get("hour"),
    minute: get("minute"),
    second: get("second"),
    weekday: WEEKDAY_INDEX[parts.find((p) => p.type === "weekday").value],
  };
}

export function localDateAt(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function dateAdd(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffLocalDates(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

// tz 在 instant 处相对 UTC 的偏移（毫秒，东八区为 +28800000）。
// Intl 只能读到秒级墙钟，因此把时刻与墙钟都对齐到各自整秒起点：
// 现代 IANA 偏移均为整秒，这样得到的偏移没有亚秒抖动，
// f(I)=I+offset(I) 才是真正单调非降的函数。
export function offsetMillisAt(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  const wallFloor = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const instantFloor = Math.floor(new Date(instant).getTime() / 1000) * 1000;
  return wallFloor - instantFloor;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 在 [lo, hi] 内找出所有偏移跳变边界（新偏移生效的首个毫秒时刻）。
// 现代 IANA 数据中任意 24 小时窗口至多一次跳变；递归切分以兼容历史特殊年份。
function offsetBoundaries(timeZone, lo, hi) {
  const boundaries = [];
  const walk = (l, r) => {
    if (offsetMillisAt(l, timeZone) === offsetMillisAt(r, timeZone)) return;
    if (r - l <= 1) {
      boundaries.push(r);
      return;
    }
    const mid = Math.floor((l + r) / 2);
    walk(l, mid);
    walk(mid, r);
  };
  walk(lo, hi);
  return boundaries;
}

// 本地日期 + 当日经过秒数 -> 时刻。
// disambiguation（与 Temporal 语义一致）：
//   compatible（默认）= 春令时空档取跳变后时刻、重叠期取第一次出现；
//   earlier = 重叠取较早、空档取跳变前一刻；
//   later   = 重叠取较晚、空档取跳变后时刻。
export function localToInstant(dateStr, secondsOfDay, timeZone, disambiguation = "compatible") {
  const hour = Math.floor(secondsOfDay / 3600);
  const minute = Math.floor((secondsOfDay % 3600) / 60);
  const second = secondsOfDay % 60;
  const g = Date.parse(`${dateStr}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}Z`);

  const H = 48 * 3600_000;
  const lo = g - H;
  const hi = g + H;

  // 常量偏移段：[{a, b, o})，f(I) = I + o。
  const cuts = [lo, ...offsetBoundaries(timeZone, lo, hi), hi];
  const segments = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    segments.push({ a: cuts[i], b: cuts[i + 1], o: offsetMillisAt(cuts[i], timeZone) });
  }

  const solutions = [];
  for (const seg of segments) {
    const I = g - seg.o;
    if (I >= seg.a && I < seg.b) solutions.push(I);
  }

  if (solutions.length > 0) {
    solutions.sort((x, y) => x - y);
    const earlier = solutions[0];
    const later = solutions[solutions.length - 1];
    if (earlier === later || disambiguation === "earlier" || disambiguation === "compatible") {
      return new Date(earlier).toISOString();
    }
    return new Date(later).toISOString();
  }

  // 空档：g 落在某次向前跳变跨过的墙钟区间内。
  // later/compatible 取跳变首刻 T，earlier 取 T-1。
  for (const seg of segments) {
    const wallAtEnd = seg.b - 1 + seg.o; // 跳变前最后一刻的墙钟
    if (g > wallAtEnd) {
      const next = segments.find((q) => q.a === seg.b);
      if (next && g < seg.b + next.o) {
        const T = disambiguation === "earlier" ? seg.b - 1 : seg.b;
        return new Date(T).toISOString();
      }
    }
  }
  throw new Error(`cannot resolve local time ${dateStr} ${pad2(hour)}:${pad2(minute)} in ${timeZone}`);
}

export function localMidnightInstant(dateStr, timeZone) {
  return localToInstant(dateStr, 0, timeZone, "earlier");
}

export function nextMidnightInstant(dateStr, timeZone) {
  return localMidnightInstant(dateAdd(dateStr, 1), timeZone);
}

// 某时刻距其本地零点的秒数（直接来自墙钟分量；显示多少即计多少）。
export function secondsIntoLocalDay(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return p.hour * 3600 + p.minute * 60 + p.second;
}

// 判定某时刻是否落在给定的每日时间窗内。
// windows: [{start: "20:00", end: "21:30"}]，end 可小于等于 start（表示跨午夜，如 "22:00"-"06:00"）。
export function isWithinWindows(instant, timeZone, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return true;
  const secs = secondsIntoLocalDay(instant, timeZone);
  return windows.some((w) => {
    const start = hhmmToSeconds(w.start);
    const end = hhmmToSeconds(w.end);
    if (end > start) return secs >= start && secs < end;
    if (end === start) return false;
    // 跨午夜窗口
    return secs >= start || secs < end;
  });
}

function hhmmToSeconds(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 3600 + m * 60;
}

// 把一次会话 [started_at, ended_at) 按本地日期边界切分。
// 返回 [{local_date, start_at, end_at, duration_seconds}]，按时序排列。
// 每个切点使用该日本地零点的真实时刻，因此在夏令时变化日也正确。
export function splitSessionAcrossMidnight(startedAt, endedAt, timeZone) {
  const t0 = Date.parse(startedAt);
  const t1 = Date.parse(endedAt);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) {
    throw new Error("invalid session window");
  }
  if (t0 === t1) return [];

  const slices = [];
  let cursor = t0;
  let date = localDateAt(new Date(cursor), timeZone);

  // 安全阀：一次会话最多跨 14 个本地日期，异常数据直接报错而不是静默错账。
  for (let guard = 0; guard < 14; guard += 1) {
    const boundary = Date.parse(nextMidnightInstant(date, timeZone));
    const sliceEnd = Math.min(t1, boundary);
    if (sliceEnd > cursor) {
      slices.push({
        local_date: date,
        start_at: new Date(cursor).toISOString(),
        end_at: new Date(sliceEnd).toISOString(),
        duration_seconds: Math.round((sliceEnd - cursor) / 1000),
      });
    }
    if (sliceEnd >= t1) break;
    cursor = sliceEnd;
    date = dateAdd(date, 1);
  }

  const last = slices[slices.length - 1];
  if (!last || Date.parse(last.end_at) !== t1) {
    throw new Error("session spans more than 14 local days");
  }
  return slices;
}

// 上学日判定：
//   schoolDates 给出的本地日期恒为上学日；
//   holidays 给出的恒为非上学日；
//   两者都不包含时按周一至周五推断。
export function resolveDayKind(localDate, { schoolDates = null, holidays = null } = {}) {
  if (schoolDates && schoolDates.has(localDate)) return "school";
  if (holidays && holidays.has(localDate)) return "non_school";
  if (schoolDates) return "non_school";
  const weekday = zonedParts(`${localDate}T12:00:00Z`, "UTC").weekday;
  return weekday <= 5 ? "school" : "non_school";
}
