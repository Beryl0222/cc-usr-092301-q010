import assert from "node:assert/strict";
import test from "node:test";
import { activeRevisionAt, resolveDailyLimit, scopeMatches, scopeSpecificity, selectPolicy } from "../src/policy.js";

const rev = (over = {}) => ({
  version: 1,
  effective_from: "2026-09-01T00:00:00+08:00",
  effective_to: null,
  scope: { member_id: "m1", device_id: null, category: null, day_kind: "any" },
  daily_limits_seconds: { short_video: 3600 },
  ...over,
});

test("范围匹配：设备/类别/上学日逐项过滤", () => {
  const s = rev().scope;
  assert.equal(scopeMatches(s, { member_id: "m1", device_id: "d1", category: "game", day_kind: "school" }), true);
  const deviceOnly = { ...s, device_id: "d1" };
  assert.equal(scopeMatches(deviceOnly, { member_id: "m1", device_id: "d2", category: "game", day_kind: "school" }), false);
  const schoolOnly = { ...s, day_kind: "school" };
  assert.equal(scopeMatches(schoolOnly, { member_id: "m1", device_id: "d1", category: "game", day_kind: "non_school" }), false);
});

test("具体度：设备 > 类别 > 上学日", () => {
  assert.ok(scopeSpecificity({ device_id: "d", category: "c", day_kind: "school" }) > scopeSpecificity({ device_id: null, category: "c", day_kind: "school" }));
  assert.ok(scopeSpecificity({ device_id: null, category: "c", day_kind: "any" }) > scopeSpecificity({ device_id: null, category: null, day_kind: "school" }));
});

test("生效期之外修订不生效", () => {
  const r = rev({ effective_from: "2026-09-10T00:00:00+08:00", effective_to: "2026-09-20T00:00:00+08:00" });
  assert.equal(activeRevisionAt([r], Date.parse("2026-09-09T00:00:00+08:00")), null);
  assert.ok(activeRevisionAt([r], Date.parse("2026-09-15T00:00:00+08:00")));
  // 右开区间：effective_to 当刻已失效
  assert.equal(activeRevisionAt([r], Date.parse("2026-09-20T00:00:00+08:00")), null);
});

test("选择政策：设备专用政策覆盖通用政策，且类别独立预算", () => {
  const general = rev({ daily_limits_seconds: { short_video: 1800 } });
  const tablet = rev({
    version: 1,
    scope: { member_id: "m1", device_id: "tablet", category: null, day_kind: "any" },
    daily_limits_seconds: { short_video: 600 },
  });
  const streams = new Map([
    ["general", [general]],
    ["tablet", [tablet]],
  ]);
  const onTablet = selectPolicy(streams, { member_id: "m1", device_id: "tablet", category: "short_video", day_kind: "school", at: "2026-09-21T10:00:00+08:00" });
  assert.equal(onTablet.policy_id, "tablet");
  assert.equal(resolveDailyLimit(onTablet, "short_video"), 600);
  const onPhone = selectPolicy(streams, { member_id: "m1", device_id: "phone", category: "short_video", day_kind: "school", at: "2026-09-21T10:00:00+08:00" });
  assert.equal(onPhone.policy_id, "general");
  assert.equal(resolveDailyLimit(onPhone, "short_video"), 1800);
});

test("类别未列出且无通配符时表示不限", () => {
  assert.equal(resolveDailyLimit(rev(), "reading"), null);
  assert.equal(resolveDailyLimit(rev({ daily_limits_seconds: { "*": 1200 } }), "reading"), 1200);
  assert.equal(resolveDailyLimit(rev({ daily_limits_seconds: { short_video: null } }), "short_video"), null);
});
