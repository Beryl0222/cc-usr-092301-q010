import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { makeEvent, validateContractEvent, validateEvent } from "../src/culture_time_budget.js";

test("基线样例仍符合信封约定", async () => {
  const record = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(record), []);
});

test("扩展事件信封接受全部新事件种类", () => {
  for (const kind of [
    "POLICY_SET",
    "CONSUMPTION_RECORDED",
    "DAY_RESET",
    "EXTENSION_REQUESTED",
    "EXTENSION_APPROVED",
    "EXTENSION_DECLINED",
    "EXCEPTION_GRANTED",
    "EXCEPTION_REVIEWED",
    "INTERVENTION_RAISED",
    "SCHOOL_SUMMARY_SHARED",
    "RETENTION_ANNOTATED",
  ]) {
    const problems = validateEvent({ event_id: "e", kind, occurred_at: "2026-09-20T01:00:00Z", subject_id: "m", payload: {} });
    assert.deepEqual(problems, [], kind);
  }
});

test("消费事件严格校验设备窗口与内容类别", () => {
  const ok = makeEvent(
    "CONSUMPTION_RECORDED",
    "m1",
    {
      record_id: "r1",
      member_id: "m1",
      device_id: "d1",
      category: "short_video",
      started_at: "2026-09-20T10:00:00Z",
      ended_at: "2026-09-20T10:05:00Z",
    },
    "2026-09-20T10:05:00Z",
  );
  assert.deepEqual(validateContractEvent(ok), []);

  const bad = structuredClone(ok);
  bad.payload.category = "everything";
  assert.ok(validateContractEvent(bad).includes("payload.category"));

  const badTime = structuredClone(ok);
  badTime.payload.ended_at = "not-a-time";
  assert.ok(validateContractEvent(badTime).includes("payload.device_window"));
});

test("政策事件严格校验版本、时区、生效期与行为主体角色", () => {
  const ok = makeEvent(
    "POLICY_SET",
    "m1",
    {
      policy_id: "p1",
      version: 1,
      expected_version: null,
      scope: { member_id: "m1", device_id: null, category: null, day_kind: "any" },
      time_zone: "Asia/Shanghai",
      daily_limits_seconds: { short_video: 3600 },
      windows: [],
      effective_from: "2026-09-01T00:00:00+08:00",
      effective_to: null,
      actor: { id: "g1", role: "guardian" },
    },
    "2026-09-01T00:00:00+08:00",
  );
  assert.deepEqual(validateContractEvent(ok), []);

  const badTz = structuredClone(ok);
  badTz.payload.time_zone = "Mars/Olympus";
  assert.ok(validateContractEvent(badTz).includes("payload.time_zone"));

  const badRole = structuredClone(ok);
  badRole.payload.actor.role = "alien";
  assert.ok(validateContractEvent(badRole).includes("payload.actor"));

  const badVersion = structuredClone(ok);
  badVersion.payload.version = 0;
  assert.ok(validateContractEvent(badVersion).includes("payload.version"));
});

test("未知事件种类与残缺负载会被拒绝", () => {
  assert.ok(validateEvent({ event_id: "x", kind: "NOPE", occurred_at: "2026-09-20T00:00:00Z", subject_id: "m", payload: {} }).includes("kind"));
  const missing = makeEvent("EXTENSION_APPROVED", "m", { extension_id: "x" }, "2026-09-20T00:00:00Z");
  assert.deepEqual(
    new Set(validateContractEvent(missing)),
    new Set(["payload.guardian_id", "payload.approved_at", "payload.valid_until"]),
  );
});
