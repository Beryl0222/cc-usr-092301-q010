import assert from "node:assert/strict";
import test from "node:test";
import { RhythmEngine } from "../src/engine.js";
import { events as e } from "../src/events.js";
import { engineWithPolicy } from "./helpers.js";

const MIN = 60;

function setupWithAgreement({ fields } = {}) {
  const clock = { t: Date.parse("2026-09-22T08:00:00+08:00") };
  const eng = engineWithPolicy();
  eng._now = () => clock.t;
  // 09-21 上学日：短视频 30 分钟用满
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 30 * MIN, idempotency_key: "v",
  }));
  // 阅读 10 分钟（协议不包含阅读，学校不应看到）
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "READING",
    started_at: "2026-09-21T18:00:00+08:00", duration_seconds: 10 * MIN, idempotency_key: "r",
  }));
  eng.append(e.schoolAgreementRegistered("teen", {
    agreement_id: "AGR-1", school_id: "school-7",
    subject_ids: ["teen"], categories: ["SHORT_VIDEO"],
    fields: fields ?? ["DAILY_TOTALS_BY_CATEGORY", "DAILY_LIMIT_HITS", "POLICY_COMPLIANCE_RATE"],
    effective_from: "2026-09-01", effective_to: "2026-12-31",
  }, "2026-09-01T00:00:00+08:00"));
  eng.closeDay("teen", "2026-09-21");
  return { eng, clock };
}

test("学校只收到协议范围内按日按类别的汇总", () => {
  const { eng } = setupWithAgreement();
  const report = eng.buildSchoolReport("school-7", ["teen"], "2026-09-21", "2026-09-21");
  assert.equal(report.granularity, "DAILY_BY_CATEGORY");
  assert.equal(report.rows.length, 1);
  const row = report.rows[0];
  assert.deepEqual(Object.keys(row.totals_by_category), ["SHORT_VIDEO"]);
  assert.equal(row.totals_by_category.SHORT_VIDEO.minutes, 30);
  assert.ok(!("READING" in row.totals_by_category));
  assert.equal(row.limit_hits, 0);
  assert.equal(row.compliance_rate, 1);
  // 汇总里不允许出现任何逐事件标识
  const text = JSON.stringify(report);
  assert.ok(!text.includes("idempotency"));
  assert.ok(!text.includes("cons_v"));
});

test("没有有效协议时拒绝向学校出数", () => {
  const { eng } = setupWithAgreement();
  assert.throws(
    () => eng.buildSchoolReport("unknown-school", ["teen"], "2026-09-21", "2026-09-21"),
    /没有有效协议/,
  );
  // 期间超出协议范围
  assert.throws(
    () => eng.buildSchoolReport("school-7", ["teen"], "2026-08-01", "2026-09-21"),
    /没有有效协议/,
  );
});

test("请求协议外字段被拒绝", () => {
  const { eng } = setupWithAgreement({ fields: ["DAILY_TOTALS_BY_CATEGORY"] });
  assert.throws(
    () => eng.buildSchoolReport("school-7", ["teen"], "2026-09-21", "2026-09-21",
      { fields: ["DAILY_TOTALS_BY_CATEGORY", "POLICY_COMPLIANCE_RATE"] }),
    /超出协议约定范围/,
  );
});

test("非协议成员不在报告内", () => {
  const { eng } = setupWithAgreement();
  assert.throws(
    () => eng.buildSchoolReport("school-7", ["teen", "other-teen"], "2026-09-21", "2026-09-21"),
    /没有有效协议/,
  );
});

test("超时与窗阻计入 limit_hits，合规率随之下降", () => {
  const eng = engineWithPolicy();
  eng.append(e.schoolAgreementRegistered("teen", {
    agreement_id: "AGR", school_id: "s", subject_ids: ["teen"],
    categories: ["SHORT_VIDEO"],
    fields: ["DAILY_TOTALS_BY_CATEGORY", "DAILY_LIMIT_HITS", "POLICY_COMPLIANCE_RATE"],
    effective_from: "2026-09-01",
  }));
  // 40 分钟短视频，超过上学日 30 分钟上限
  eng.append(e.consumption("teen", {
    device_id: "phone", category: "SHORT_VIDEO",
    started_at: "2026-09-21T19:00:00+08:00", duration_seconds: 40 * MIN, idempotency_key: "over",
  }));
  const report = eng.buildSchoolReport("s", ["teen"], "2026-09-21", "2026-09-21");
  assert.equal(report.rows[0].totals_by_category.SHORT_VIDEO.overrun_minutes, 10);
  assert.equal(report.rows[0].limit_hits, 1);
  assert.equal(report.rows[0].compliance_rate, 0);
});

test("实际交付需登记审计事件（谁在何时拿到哪个期间）", () => {
  const { eng } = setupWithAgreement();
  eng.buildSchoolReport("school-7", ["teen"], "2026-09-21", "2026-09-21");
  // 构建报告本身不产生交付记录；显式登记交付
  eng.recordReportDelivery(e.schoolReportDelivered("teen", {
    agreement_id: "AGR-1", school_id: "school-7",
    period_from: "2026-09-21", period_to: "2026-09-21",
  }, "2026-09-22T09:00:00+08:00"));
  assert.equal(eng.reportLog.length, 1);
  assert.equal(eng.reportLog[0].event.payload.period_from, "2026-09-21");
});
