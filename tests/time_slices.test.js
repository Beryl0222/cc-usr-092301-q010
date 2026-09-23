import assert from "node:assert/strict";
import test from "node:test";
import {
  dateAdd,
  diffLocalDates,
  isWithinWindows,
  localDateAt,
  localToInstant,
  resolveDayKind,
  secondsIntoLocalDay,
  splitSessionAcrossMidnight,
  zonedParts,
} from "../src/time_slices.js";

test("本地日期归属跟随成员时区而非服务器 UTC", () => {
  // 上海时间 9 月 21 日 00:30，UTC 仍是 9 月 20 日。
  const instant = "2026-09-20T16:30:00Z";
  assert.equal(localDateAt(instant, "Asia/Shanghai"), "2026-09-21");
  assert.equal(localDateAt(instant, "UTC"), "2026-09-20");
  assert.equal(localDateAt(instant, "America/New_York"), "2026-09-20");
});

test("跨午夜会话按本地日期边界切分且秒数守恒", () => {
  // 15:50Z–16:10Z = 上海本地 23:50–00:10
  const slices = splitSessionAcrossMidnight("2026-09-20T15:50:00Z", "2026-09-20T16:10:00Z", "Asia/Shanghai");
  assert.deepEqual(
    slices.map((s) => [s.local_date, s.duration_seconds]),
    [
      ["2026-09-20", 600],
      ["2026-09-21", 600],
    ],
  );
  const total = slices.reduce((a, s) => a + s.duration_seconds, 0);
  assert.equal(total, 1200);
});

test("夏令时春令时空档与秋令时重叠都可解释地解析", () => {
  // 纽约 2026-03-08 02:30 不存在（时钟 02:00 -> 03:00）。
  const gap = localToInstant("2026-03-08", 2 * 3600 + 30 * 60, "America/New_York");
  const gapParts = zonedParts(gap, "America/New_York");
  assert.equal(gapParts.hour, 3);
  assert.equal(gapParts.minute, 0);

  const gapEarlier = localToInstant("2026-03-08", 2 * 3600 + 30 * 60, "America/New_York", "earlier");
  assert.equal(zonedParts(gapEarlier, "America/New_York").hour, 1);
  assert.equal(gapEarlier.endsWith("59.999Z"), true);

  // 纽约 2026-11-01 01:30 出现两次，相差恰好 1 小时。
  const earlier = localToInstant("2026-11-01", 1 * 3600 + 30 * 60, "America/New_York", "earlier");
  const later = localToInstant("2026-11-01", 1 * 3600 + 30 * 60, "America/New_York", "later");
  assert.equal((Date.parse(later) - Date.parse(earlier)) / 3600_000, 1);
  for (const ins of [earlier, later]) {
    const p = zonedParts(ins, "America/New_York");
    assert.equal(p.hour, 1);
    assert.equal(p.minute, 30);
  }
  // compatible 取第一次出现（与 Temporal 默认一致）。
  assert.equal(localToInstant("2026-11-01", 1 * 3600 + 30 * 60, "America/New_York"), earlier);
});

test("夏令时变化日的跨夜切分使用真实本地零点：春令时 23 小时日", () => {
  // 悉尼 2026-10-04 春令时开始，当地该日只有 23 小时。
  // 会话从 10-03 22:30 本地（12:30Z，仍为 +10:00）持续到 10-05 01:00 本地（14:00Z，+11:00）。
  const slices = splitSessionAcrossMidnight("2026-10-03T12:30:00Z", "2026-10-04T14:00:00Z", "Australia/Sydney");
  assert.deepEqual(
    slices.map((s) => [s.local_date, s.duration_seconds]),
    [
      ["2026-10-03", 5400], // 22:30 到午夜
      ["2026-10-04", 82800], // 23 小时
      ["2026-10-05", 3600],
    ],
  );
});

test("夏令时变化日的跨夜切分：秋令时 25 小时日", () => {
  // 纽约 2026-11-01 为 25 小时日。本地 10-31 23:30（03:30Z，EDT）到 11-02 00:30（05:30Z，EST）。
  const slices = splitSessionAcrossMidnight("2026-11-01T03:30:00Z", "2026-11-02T05:30:00Z", "America/New_York");
  assert.deepEqual(
    slices.map((s) => [s.local_date, s.duration_seconds]),
    [
      ["2026-10-31", 1800],
      ["2026-11-01", 90000], // 25 小时
      ["2026-11-02", 1800],
    ],
  );
});

test("普通日期本地时刻往返一致", () => {
  for (const tz of ["Asia/Shanghai", "America/New_York", "Europe/London", "Australia/Sydney", "UTC"]) {
    for (const dateStr of ["2026-06-21", "2026-12-21"]) {
      for (const sod of [0, 7 * 3600 + 30, 12 * 3600, 23 * 3600 + 59 * 60]) {
        const ins = localToInstant(dateStr, sod, tz);
        const p = zonedParts(ins, tz);
        assert.equal(localDateAt(ins, tz), dateStr);
        assert.equal(p.hour * 3600 + p.minute * 60 + p.second, sod, `${tz} ${dateStr} ${sod}`);
      }
    }
  }
});

test("每日时间窗：普通窗口与跨午夜窗口", () => {
  assert.equal(isWithinWindows("2026-09-20T12:00:00Z", "UTC", [{ start: "19:00", end: "21:30" }]), false);
  assert.equal(isWithinWindows("2026-09-20T19:00:00Z", "UTC", [{ start: "19:00", end: "21:30" }]), true);
  assert.equal(isWithinWindows("2026-09-20T21:30:00Z", "UTC", [{ start: "19:00", end: "21:30" }]), false);
  // 跨午夜窗口 22:00-06:00
  assert.equal(isWithinWindows("2026-09-20T23:00:00Z", "UTC", [{ start: "22:00", end: "06:00" }]), true);
  assert.equal(isWithinWindows("2026-09-20T05:59:00Z", "UTC", [{ start: "22:00", end: "06:00" }]), true);
  assert.equal(isWithinWindows("2026-09-20T06:00:00Z", "UTC", [{ start: "22:00", end: "06:00" }]), false);
  // 空窗口列表 = 全天允许
  assert.equal(isWithinWindows("2026-09-20T03:00:00Z", "UTC", []), true);
});

test("秒入日在重叠期返回墙钟秒数（25 小时日可超过 86400 毫秒的真实跨度）", () => {
  assert.equal(secondsIntoLocalDay("2026-11-01T06:30:00Z", "America/New_York"), 1 * 3600 + 30 * 60);
  assert.equal(secondsIntoLocalDay("2026-11-01T07:30:00Z", "America/New_York"), 2 * 3600 + 30 * 60);
});

test("上学日：校历优先，缺省按周一至周五", () => {
  // 2026-09-21 是周一，09-20 是周日。
  assert.equal(resolveDayKind("2026-09-21"), "school");
  assert.equal(resolveDayKind("2026-09-20"), "non_school");
  assert.equal(resolveDayKind("2026-09-21", { schoolDates: new Set(["2026-09-21"]) }), "school");
  assert.equal(
    resolveDayKind("2026-09-21", { schoolDates: new Set(["2026-09-19"]), holidays: new Set(["2026-09-21"]) }),
    "non_school",
  );
  // 给出 schoolDates 集合即视为完整校历：不在其中的工作日也是非上学日。
  assert.equal(resolveDayKind("2026-09-22", { schoolDates: new Set(["2026-09-21"]) }), "non_school");
});

test("日期工具", () => {
  assert.equal(dateAdd("2026-12-31", 1), "2027-01-01");
  assert.equal(diffLocalDates("2026-09-01", "2026-09-11"), 10);
});
