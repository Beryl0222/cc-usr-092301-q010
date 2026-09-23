import assert from "node:assert/strict";
import test from "node:test";
import { RhythmEngine } from "../src/engine.js";
import { RecommendationService, RecommendationGatedError } from "../src/recommendations.js";
import { buildDisputePack, assertMinimal } from "../src/retention.js";
import { events as e } from "../src/events.js";
import { engineWithPolicy } from "./helpers.js";

const MIN = 60;

function teenWithUsage(at = "2026-09-21T19:31:00+08:00") {
  const eng = engineWithPolicy({ now: at });
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 30 * MIN, idempotency_key: "u",
  }));
  return eng;
}

test("撤权前可以生成个性化建议，且建议携带政策版本依据", () => {
  const eng = teenWithUsage();
  const svc = new RecommendationService(eng);
  const out = svc.buildSuggestions("teen", "phone", Date.parse("2026-09-21T19:31:00+08:00"));
  assert.equal(out.gated, false);
  assert.ok(out.suggestions.some((s) => s.type === "BUDGET_EXHAUSTED_TODAY"));
  assert.equal(out.basis.policy_id, "POL-MAIN");
  assert.equal(out.basis.policy_version, 1);
});

test("撤权后停止生成个性化建议（硬闸门）", () => {
  const eng = teenWithUsage();
  const withdrawnAt = Date.parse("2026-09-21T20:00:00+08:00");
  eng.append(e.profileWithdrawn("teen", "2026-09-21T20:00:00+08:00"));
  assert.equal(eng.isProfileWithdrawn("teen", withdrawnAt), true);
  const svc = new RecommendationService(eng);
  assert.throws(
    () => svc.buildSuggestions("teen", "phone", withdrawnAt),
    RecommendationGatedError,
  );
  // 非严格模式返回 gated 而非建议
  const lax = new RecommendationService(eng, { strict: false });
  const out = lax.buildSuggestions("teen", "phone", withdrawnAt);
  assert.equal(out.gated, true);
  assert.deepEqual(out.suggestions, []);
});

test("撤权前生成、撤权后才展示的建议不得交付", () => {
  const eng = teenWithUsage();
  const svc = new RecommendationService(eng);
  const generatedAt = Date.parse("2026-09-21T19:31:00+08:00");
  svc.buildSuggestions("teen", "phone", generatedAt);
  eng.append(e.profileWithdrawn("teen", "2026-09-21T20:00:00+08:00"));
  assert.equal(svc.isDeliverable("teen", generatedAt, Date.parse("2026-09-21T20:01:00+08:00")), false);
  assert.equal(svc.isDeliverable("teen", generatedAt, Date.parse("2026-09-21T19:40:00+08:00")), true);
});

test("撤权不影响日结账本与政策执行（阻断仍生效）", () => {
  const eng = teenWithUsage();
  eng.append(e.profileWithdrawn("teen", "2026-09-21T20:00:00+08:00"));
  const totals = eng.dailyTotals("teen", "2026-09-21");
  assert.equal(totals.SHORT_VIDEO.minutes, 30);
  const decision = eng.evaluate("teen", "phone", "SHORT_VIDEO",
    Date.parse("2026-09-21T20:05:00+08:00"), { durationSeconds: 60 });
  assert.equal(decision.outcome, "BLOCKED"); // 政策执行不因撤权而停
});

test("争议包保留结算所需最小聚合，但剔除课程/联系人/内容标识", () => {
  const eng = engineWithPolicy();
  eng.append(e.exceptionGranted("teen", {
    exception_id: "EX", type: "DOWNLOADED_LESSON",
    valid_from: "2026-09-21T00:00:00+08:00", valid_to: "2026-09-21T23:59:00+08:00",
    usage_cap_minutes: 30, grant_ref: "ORDER-1", lesson_id: "SECRET-LESSON", device_id: "phone",
  }));
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "LESSON",
    started_at: "2026-09-21T10:00:00+08:00", duration_seconds: 30 * MIN,
    downloaded: true, lesson_id: "SECRET-LESSON", idempotency_key: "le",
  }));
  eng.append(e.profileWithdrawn("teen", "2026-09-22T00:00:00+08:00"));
  const pack = buildDisputePack(eng, "teen", {
    period_from: "2026-09-21", period_to: "2026-09-21", dispute_ref: "DSP-1",
  });
  assert.equal(pack.profile_withdrawn, true);
  assert.ok(pack.retained.daily.length > 0);
  // 保留例外"类型"与用量，但不保留课程 id 与凭证
  const row = pack.retained.daily.find((r) => r.category === "LESSON");
  assert.ok(row.exceptions.some((x) => x.type === "DOWNLOADED_LESSON"));
  assertMinimal(pack);
  const text = JSON.stringify(pack);
  assert.ok(!text.includes("SECRET-LESSON"));
  assert.ok(!text.includes("ORDER-1"));
  assert.ok(!text.includes("contact_ref"));
});

test("争议包包含结账快照与迟到补传，供争议核对", () => {
  const clock = { t: Date.parse("2026-09-22T08:00:00+08:00") };
  const eng = engineWithPolicy();
  eng._now = () => clock.t;
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 20 * MIN, idempotency_key: "ontime",
  }));
  eng.closeDay("teen", "2026-09-21");
  clock.t = Date.parse("2026-09-22T09:00:00+08:00");
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T18:00:00+08:00", duration_seconds: 10 * MIN, idempotency_key: "late",
  }, "2026-09-22T09:00:00+08:00"));
  const pack = buildDisputePack(eng, "teen", {
    period_from: "2026-09-21", period_to: "2026-09-21", dispute_ref: "DSP-2",
  });
  assert.equal(pack.retained.closure.length, 1);
  assert.equal(pack.retained.late_arrivals.length, 1);
  assert.equal(pack.retained.late_arrivals[0].seconds, 10 * MIN);
  // 冻结快照仍是结账时的 20 分钟，未被迟到补传改写
  assert.equal(pack.retained.closure[0].totals.SHORT_VIDEO.minutes, 20);
  assertMinimal(pack);
});

test("争议导出必须登记争议工单号与合法期间", () => {
  const eng = new RhythmEngine();
  assert.throws(
    () => buildDisputePack(eng, "teen", { period_from: "2026-09-21", period_to: "2026-09-21" }),
    /争议工单号/,
  );
  assert.throws(
    () => buildDisputePack(eng, "teen", { period_from: "2026-09-22", period_to: "2026-09-21", dispute_ref: "X" }),
    /争议期间非法/,
  );
});
