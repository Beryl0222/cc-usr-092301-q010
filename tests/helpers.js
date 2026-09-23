// 测试夹具：构造常用政策与事件序列。
import { RhythmEngine } from "../src/engine.js";
import { events } from "../src/events.js";

export const TZ_SH = "Asia/Shanghai";
export const TZ_NY = "America/New_York";
export const TZ_HAVANA = "America/Havana";

/** 构造一个带上海时区政策的引擎。 */
export function engineWithPolicy({
  subject = "teen",
  policyId = "POL-MAIN",
  version = 1,
  timezone = TZ_SH,
  createdBy = "guardian-1",
  effectiveFrom = "2026-01-01T00:00:00+08:00",
  rules,
  scope,
  now = "2026-09-22T12:00:00+08:00",
} = {}) {
  const engine = new RhythmEngine({ now: () => Date.parse(now) });
  engine.append(
    events.policyDefined(
      subject,
      {
        policy_id: policyId,
        version,
        timezone,
        created_by: createdBy,
        effective_from: effectiveFrom,
        scope,
        rules:
          rules ?? [
            {
              day_type: "SCHOOL_DAY",
              budgets: [
                { category: "SHORT_VIDEO", daily_limit_minutes: 30 },
                { category: "READING", daily_limit_minutes: 40 },
              ],
              windows: [{ start: "22:00", end: "06:00", action: "BLOCK" }],
            },
            {
              day_type: "NON_SCHOOL_DAY",
              budgets: [{ category: "SHORT_VIDEO", daily_limit_minutes: 60 }],
            },
          ],
      },
      "2026-01-01T00:00:00+08:00",
    ),
  );
  return engine;
}

export const e = events;
