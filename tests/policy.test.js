import assert from "node:assert/strict";
import test from "node:test";
import { PolicyRegistry, VersionConflictError, PolicyValidationError, resolveRule, budgetFor, windowsFor } from "../src/policy.js";

function policyDoc({ id = "P1", version = 1, expected_version, scope, effective_from = "2026-09-01T00:00:00Z", effective_to, tz = "Asia/Shanghai" } = {}) {
  return {
    policy_id: id,
    version,
    subject_id: "teen",
    timezone: tz,
    scope,
    rules: [{ day_type: "ANY", budgets: [{ category: "SHORT_VIDEO", daily_limit_minutes: 30 }] }],
    effective_from,
    effective_to,
    created_by: "g1",
    expected_version,
  };
}

test("新政策必须从 v1 开始", () => {
  const reg = new PolicyRegistry();
  assert.throws(() => reg.define(policyDoc({ version: 2 })), PolicyValidationError);
  reg.define(policyDoc({ version: 1 }));
});

test("修订必须严格递增版本并携带 expected_version", () => {
  const reg = new PolicyRegistry();
  reg.define(policyDoc({ version: 1 }));
  // 跳版本被拒
  assert.throws(() => reg.define(policyDoc({ version: 3, expected_version: 1 })), VersionConflictError);
  // 缺乐观锁被拒
  assert.throws(() => reg.define(policyDoc({ version: 2 })), PolicyValidationError);
  // 正确修订
  reg.define(policyDoc({ version: 2, expected_version: 1 }));
  assert.equal(reg.currentVersion("P1"), 2);
});

test("两位监护人并发修改同一政策：后写方收到版本冲突", () => {
  const reg = new PolicyRegistry();
  reg.define(policyDoc({ version: 1 }));
  // 双方都基于 v1 编辑；监护人 A 先提交 v2
  reg.define(policyDoc({ version: 2, expected_version: 1, created_by: "mom" }));
  // 监护人 B 仍基于 v1 提交 -> 冲突
  let err;
  assert.throws(
    () => reg.define(policyDoc({ version: 2, expected_version: 1, created_by: "dad" }), { event_id: "evt-dad" }),
    (e2) => ((err = e2), e2 instanceof VersionConflictError),
  );
  assert.equal(err.code, "POLICY_VERSION_CONFLICT");
  assert.equal(err.expected_version, 1);
  assert.equal(err.actual_version, 2);
  assert.equal(err.event_id, "evt-dad");
  // 冲突后政策仍停在 A 的 v2，未被 B 覆盖
  assert.equal(reg.currentVersion("P1"), 2);
});

test("B 重新读取后基于 v2 提交 v3 成功", () => {
  const reg = new PolicyRegistry();
  reg.define(policyDoc({ version: 1 }));
  reg.define(policyDoc({ version: 2, expected_version: 1 }));
  reg.define(policyDoc({ version: 3, expected_version: 2 }));
  assert.equal(reg.currentVersion("P1"), 3);
});

test("生效期：时刻落在不同版本区间时选择对应版本", () => {
  const reg = new PolicyRegistry();
  reg.define(policyDoc({ version: 1, effective_from: "2026-09-01T00:00:00Z", effective_to: "2026-09-10T00:00:00Z" }));
  reg.define(policyDoc({ version: 2, expected_version: 1, effective_from: "2026-09-10T00:00:00Z" }));
  assert.equal(reg.select("teen", "phone", "SHORT_VIDEO", Date.parse("2026-09-05T00:00:00Z")).version, 1);
  assert.equal(reg.select("teen", "phone", "SHORT_VIDEO", Date.parse("2026-09-10T00:00:00Z")).version, 2);
  assert.equal(reg.select("teen", "phone", "SHORT_VIDEO", Date.parse("2026-08-30T00:00:00Z")), null);
});

test("范围：限定设备/类别的具体政策优先于兜底政策", () => {
  const reg = new PolicyRegistry();
  // 兜底政策（无 scope）
  reg.define({
    ...policyDoc({ id: "P-GLOBAL" }),
    rules: [{ day_type: "ANY", budgets: [{ category: "*", daily_limit_minutes: 100 }] }],
  });
  // 平板短视频更严格
  reg.define({
    ...policyDoc({ id: "P-TABLET", scope: { devices: ["tablet"], categories: ["SHORT_VIDEO"] } }),
    rules: [{ day_type: "ANY", budgets: [{ category: "SHORT_VIDEO", daily_limit_minutes: 15 }] }],
  });
  const t = reg.select("teen", "tablet", "SHORT_VIDEO", Date.parse("2026-09-05T00:00:00Z"));
  assert.equal(t.policy.policy_id, "P-TABLET");
  assert.equal(t.specificity, 2);
  const p = reg.select("teen", "phone", "SHORT_VIDEO", Date.parse("2026-09-05T00:00:00Z"));
  assert.equal(p.policy.policy_id, "P-GLOBAL");
  // 平板上的阅读不受平板短视频政策限制 -> 落兜底
  const r = reg.select("teen", "tablet", "READING", Date.parse("2026-09-05T00:00:00Z"));
  assert.equal(r.policy.policy_id, "P-GLOBAL");
});

test("停用政策后不再被选中，也不能追加版本", () => {
  const reg = new PolicyRegistry();
  reg.define(policyDoc({ version: 1 }));
  reg.withdraw("P1");
  assert.equal(reg.select("teen", "phone", "SHORT_VIDEO", Date.parse("2026-09-05T00:00:00Z")), null);
  assert.throws(() => reg.define(policyDoc({ version: 2, expected_version: 1 })), PolicyValidationError);
});

test("规则与预算解析：类别精确优先于通配，日类型 ANY 兜底", () => {
  const policy = {
    rules: [
      { day_type: "SCHOOL_DAY", budgets: [{ category: "SHORT_VIDEO", daily_limit_minutes: 20 }, { category: "*", daily_limit_minutes: 40 }] },
      { day_type: "ANY", budgets: [{ category: "SHORT_VIDEO", daily_limit_minutes: 90 }] },
    ],
  };
  assert.equal(budgetFor(resolveRule(policy, "SCHOOL_DAY"), "SHORT_VIDEO"), 20);
  assert.equal(budgetFor(resolveRule(policy, "SCHOOL_DAY"), "READING"), 40);
  assert.equal(budgetFor(resolveRule(policy, "NON_SCHOOL_DAY"), "SHORT_VIDEO"), 90);
  assert.equal(budgetFor(resolveRule(policy, "NON_SCHOOL_DAY"), "READING"), null);
  assert.ok(windowsFor(resolveRule(policy, "SCHOOL_DAY"), "READING").length === 0);
});
