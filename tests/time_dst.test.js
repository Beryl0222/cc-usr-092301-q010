import assert from "node:assert/strict";
import test from "node:test";
import {
  localDateOf,
  localDateToUtc,
  startOfLocalDay,
  endOfLocalDay,
  splitByLocalDay,
  wallTime,
  withinWindows,
  SchoolCalendar,
} from "../src/time.js";

test("本地日边界映射到正确的 UTC 时刻", () => {
  assert.equal(new Date(startOfLocalDay("Asia/Shanghai", "2026-09-21")).toISOString(), "2026-09-20T16:00:00.000Z");
  assert.equal(new Date(startOfLocalDay("America/New_York", "2026-09-21")).toISOString(), "2026-09-21T04:00:00.000Z");
  assert.equal(localDateOf("Asia/Shanghai", Date.parse("2026-09-20T16:00:00Z")), "2026-09-21");
});

test("跨午夜会话切分到两个本地日，秒数不重不丢", () => {
  // 上海 23:30 -> 次日 00:30
  const slices = splitByLocalDay("Asia/Shanghai",
    Date.parse("2026-09-20T15:30:00Z"), Date.parse("2026-09-20T16:30:00Z"));
  assert.deepEqual(slices.map((s) => [s.local_date, s.duration_seconds]),
    [["2026-09-20", 1800], ["2026-09-21", 1800]]);
  assert.equal(slices[0].end_wall, "23:59");
  assert.equal(slices[1].start_wall, "00:00");
  assert.equal(slices.reduce((a, s) => a + s.duration_seconds, 0), 3600);
});

test("春跳日（23 小时）：切分以绝对时间为准，不丢秒", () => {
  // 纽约 2026-03-08 本地 01:30-04:30（02:00-03:00 不存在），实际 2 小时
  const slices = splitByLocalDay("America/New_York",
    Date.parse("2026-03-08T06:30:00Z"), Date.parse("2026-03-08T08:30:00Z"));
  assert.equal(slices.length, 1);
  assert.equal(slices[0].duration_seconds, 7200);
  assert.equal(slices[0].local_date, "2026-03-08");
  // 该日边界：本地午夜 = UTC 05:00（EST），次日边界 = UTC 04:00（EDT）
  assert.equal(new Date(startOfLocalDay("America/New_York", "2026-03-08")).toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(new Date(endOfLocalDay("America/New_York", "2026-03-08")).toISOString(), "2026-03-09T04:00:00.000Z");
});

test("秋回日（25 小时）：01:30 出现两次但按 UTC 区分，整日 90000 秒", () => {
  // 纽约 11-01 本地午夜 = 04:00Z(EDT)，次日午夜 = 11-02 05:00Z(EST)，整日 25 小时
  const slices = splitByLocalDay("America/New_York",
    Date.parse("2026-11-01T04:00:00Z"), Date.parse("2026-11-02T05:00:00Z"));
  assert.deepEqual(slices.map((s) => s.local_date), ["2026-11-01"]);
  assert.equal(slices[0].duration_seconds, 90000);
  // 两个挂钟 01:30 映射到不同 UTC 时刻与不同偏移
  assert.equal(wallTime("America/New_York", Date.parse("2026-11-01T05:30:00Z")), "01:30");
  assert.equal(wallTime("America/New_York", Date.parse("2026-11-01T06:30:00Z")), "01:30");
  assert.equal(localDateOf("America/New_York", Date.parse("2026-11-01T05:30:00Z")), "2026-11-01");
  assert.equal(localDateOf("America/New_York", Date.parse("2026-11-01T06:30:00Z")), "2026-11-01");
  // 跨过次日边界后，多出来的 1 小时切到 11-02
  const over = splitByLocalDay("America/New_York",
    Date.parse("2026-11-01T04:00:00Z"), Date.parse("2026-11-02T06:00:00Z"));
  assert.deepEqual(over.map((s) => [s.local_date, s.duration_seconds]),
    [["2026-11-01", 90000], ["2026-11-02", 3600]]);
});

test("午夜直接跳变时区（哈瓦那春跳 00:00 被跳过）边界正确", () => {
  // 2026-03-08 哈瓦那没有本地 00:00-01:00；日界直接落在 UTC 05:00
  assert.equal(new Date(localDateToUtc("America/Havana", "2026-03-08")).toISOString(), "2026-03-08T05:00:00.000Z");
  // 跨该边界的会话：03-07 23:30 -> 03-08 02:30（跳过 1 小时，实际 2 小时）
  const slices = splitByLocalDay("America/Havana",
    Date.parse("2026-03-08T04:30:00Z"), Date.parse("2026-03-08T06:30:00Z"));
  assert.deepEqual(slices.map((s) => [s.local_date, s.duration_seconds]),
    [["2026-03-07", 1800], ["2026-03-08", 5400]]);
  assert.equal(slices.reduce((a, s) => a + s.duration_seconds, 0), 7200);
});

test("跨午夜时间窗 20:00-06:00 正确判定", () => {
  const w = [{ start: "20:00", end: "06:00", action: "BLOCK" }];
  assert.equal(withinWindows(w, Date.parse("2026-09-20T22:00:00+08:00"), "Asia/Shanghai").allowed, false);
  assert.equal(withinWindows(w, Date.parse("2026-09-21T05:59:00+08:00"), "Asia/Shanghai").allowed, false);
  assert.equal(withinWindows(w, Date.parse("2026-09-21T06:00:00+08:00"), "Asia/Shanghai").allowed, true);
  assert.equal(withinWindows(w, Date.parse("2026-09-21T12:00:00+08:00"), "Asia/Shanghai").allowed, true);
});

test("WARN 窗不阻断但给出提醒，BLOCK 优先", () => {
  const windows = [
    { start: "12:00", end: "13:00", action: "WARN" },
    { start: "12:30", end: "12:45", action: "BLOCK" },
  ];
  const atWarn = Date.parse("2026-09-21T12:10:00+08:00");
  const atBlock = Date.parse("2026-09-21T12:35:00+08:00");
  assert.equal(withinWindows(windows, atWarn, "Asia/Shanghai").allowed, true);
  assert.ok(withinWindows(windows, atWarn, "Asia/Shanghai").warn);
  assert.equal(withinWindows(windows, atBlock, "Asia/Shanghai").allowed, false);
});

test("校历：显式上学日（含调休补课）优先于工作日兜底", () => {
  const cal = new SchoolCalendar();
  // 2026-09-19 是周六，学校发布为补课上学日
  cal.publish("teen", ["2026-09-19", "2026-09-21"], "SCHOOL");
  assert.deepEqual(cal.dayType("teen", "2026-09-19"), { day_type: "SCHOOL_DAY", source: "CALENDAR" });
  assert.deepEqual(cal.dayType("teen", "2026-09-20"), { day_type: "NON_SCHOOL_DAY", source: "WEEKDAY_FALLBACK" });
  assert.deepEqual(cal.dayType("teen", "2026-09-21"), { day_type: "SCHOOL_DAY", source: "CALENDAR" });
});
