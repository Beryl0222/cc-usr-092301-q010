import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateEvent, EVENT_KINDS } from "../src/culture_time_budget.js";
import { events as e } from "../src/events.js";

test("样例符合领域约定", async () => {
  const record = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(record), []);
});

test("事件种类覆盖政策、延长、例外、时钟、结账与校协议", () => {
  for (const kind of [
    "POLICY_DEFINED", "POLICY_WITHDRAWN", "CALENDAR_PUBLISHED",
    "CLOCK_SYNC", "EXTENSION_REQUESTED", "EXTENSION_APPROVED", "EXTENSION_REJECTED",
    "EXCEPTION_GRANTED", "EXCEPTION_REVOKED", "DAY_CLOSED",
    "SCHOOL_AGREEMENT_REGISTERED", "SCHOOL_REPORT_DELIVERED",
  ]) {
    assert.ok(EVENT_KINDS.includes(kind), `缺少事件种类 ${kind}`);
  }
  // 基线事件仍然合法。
  assert.ok(EVENT_KINDS.includes("BUDGET_SET"));
});

test("合法政策定义事件通过校验", () => {
  const event = e.policyDefined("teen", {
    policy_id: "P1", version: 1, timezone: "Asia/Shanghai", created_by: "g",
    effective_from: "2026-09-01T00:00:00+08:00",
    rules: [{ day_type: "SCHOOL_DAY", budgets: [{ category: "SHORT_VIDEO", daily_limit_minutes: 30 }] }],
  });
  assert.deepEqual(validateEvent(event), []);
});

test("非法时区与非法时间窗被拒绝", () => {
  const event = {
    event_id: "x1", kind: "POLICY_DEFINED", occurred_at: "2026-09-01T00:00:00Z", subject_id: "teen",
    payload: {
      subject_id: "teen", policy_id: "P1", version: 1, timezone: "Mars/Olympus", created_by: "g",
      effective_from: "2026-09-01T00:00:00Z",
      rules: [{
        day_type: "SCHOOL_DAY",
        budgets: [{ category: "SHORT_VIDEO", daily_limit_minutes: 30 }],
        windows: [{ start: "22:00", end: "22:00", action: "BLOCK" }],
      }],
    },
  };
  const problems = validateEvent(event);
  assert.ok(problems.includes("payload.timezone"));
  assert.ok(problems.some((p) => p.endsWith("zero_length_window")));
});

test("消费事件必须给出结束时间或时长、幂等键与真实类别", () => {
  const bad = {
    event_id: "c1", kind: "CONSUMPTION_RECORDED", occurred_at: "2026-09-20T12:00:00Z", subject_id: "teen",
    payload: {
      subject_id: "teen", device_id: "phone", category: "*",
      started_at: "2026-09-20T12:00:00Z", idempotency_key: "k",
    },
  };
  const problems = validateEvent(bad);
  assert.ok(problems.includes("payload.category"));
  assert.ok(problems.includes("payload.ended_at_or_duration"));
});

test("负载 subject_id 与信封不一致被拒绝", () => {
  const policy = e.policyDefined("teen", {
    policy_id: "P", version: 1, timezone: "UTC", created_by: "g",
    effective_from: "2026-01-01T00:00:00Z",
    rules: [{ day_type: "ANY", budgets: [{ category: "*", daily_limit_minutes: 10 }] }],
  });
  const forged = { ...policy, subject_id: "intruder" };
  assert.ok(validateEvent(forged).includes("payload.subject_id_mismatch"));
});

test("例外必须带有效期、凭证与用量上限", () => {
  const bad = {
    event_id: "x", kind: "EXCEPTION_GRANTED", occurred_at: "2026-09-01T00:00:00Z", subject_id: "teen",
    payload: {
      subject_id: "teen", exception_id: "EX", type: "EMERGENCY_CONTACT",
      valid_from: "2026-09-02T00:00:00Z", valid_to: "2026-09-01T00:00:00Z",
    },
  };
  const problems = validateEvent(bad);
  assert.ok(problems.includes("payload.valid_window"));
  assert.ok(problems.includes("payload.usage_cap_minutes"));
  assert.ok(problems.includes("payload.grant_ref"));
});

test("校协议字段必须在允许清单内", () => {
  const bad = {
    event_id: "a", kind: "SCHOOL_AGREEMENT_REGISTERED",
    occurred_at: "2026-09-01T00:00:00Z", subject_id: "teen",
    payload: {
      subject_id: "teen", agreement_id: "A1", school_id: "S1",
      subject_ids: ["teen"], categories: ["SHORT_VIDEO"],
      fields: ["RAW_EVENTS"], effective_from: "2026-09-01",
    },
  };
  assert.ok(validateEvent(bad).includes("payload.fields"));
});

test("事件工厂拒绝构造非法事件", () => {
  assert.throws(
    () => e.policyDefined("teen", {
      policy_id: "P", version: 1, timezone: "Bad/Zone", created_by: "g",
      effective_from: "2026-01-01T00:00:00Z",
      rules: [{ day_type: "ANY" }],
    }),
    /校验失败/,
  );
});
