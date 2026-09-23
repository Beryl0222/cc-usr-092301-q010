// 个性化建议服务。
//
// 撤权是硬闸门：PROFILE_WITHDRAWN 生效后，本服务不生成、不返回任何个性化建议；
// 撤权前已生成但尚未展示的建议同样不得在撤权后展示（deliverable=false）。
// 建议本身携带依据（政策版本、当日用量、时间片），做到可解释。

export class RecommendationGatedError extends Error {
  constructor(subjectId, withdrawnAt) {
    super(`成员 ${subjectId} 已撤回画像授权，停止生成个性化建议`);
    this.name = "RecommendationGatedError";
    this.code = "PROFILE_WITHDRAWN";
    this.subject_id = subjectId;
    this.withdrawn_at = new Date(withdrawnAt).toISOString();
  }
}

export class RecommendationService {
  /**
   * @param engine RhythmEngine
   * @param options.strict true（默认）时撤权后调用直接抛错；false 时返回 { gated:true }
   */
  constructor(engine, { strict = true } = {}) {
    this.engine = engine;
    this.strict = strict;
    // 已生成建议的留痕：撤权后可审计"最后一条建议"的时间点。
    this.generated = new Map(); // subject_id -> [{ at_ms, suggestion, basis }]
  }

  /**
   * 基于当前节律状态生成个性化建议。
   * 返回 { suggestions:[...], generated_at, basis }，撤权时抛错或返回 gated。
   */
  buildSuggestions(subjectId, deviceId, atMs = this.engine._now()) {
    const withdrawnAt = this.engine.profileWithdrawnAt(subjectId);
    if (withdrawnAt !== null && withdrawnAt <= atMs) {
      if (this.strict) throw new RecommendationGatedError(subjectId, withdrawnAt);
      return { gated: true, withdrawn_at: new Date(withdrawnAt).toISOString(), suggestions: [] };
    }

    const suggestions = [];
    // 对成员当日有数据的各类别逐一评估，给出可执行的节律建议。
    const categories = this._activeCategories(subjectId);
    for (const category of categories) {
      const evaluation = this.engine.evaluate(subjectId, deviceId, category, atMs, { durationSeconds: 0 });
      if (evaluation.reasons.includes("POLICY_NOT_FOUND")) continue;
      const usage = evaluation.explanation.usage;
      if (!usage) continue;

      if (evaluation.reasons.includes("WINDOW_BLOCKED")) {
        suggestions.push({
          type: "WINDOW_BLOCKED_NOW",
          category,
          message: "当前处于约定的静默时段，该内容已被阻断",
          priority: "HIGH",
        });
      } else if (usage.base_limit_minutes !== null) {
        const limit = usage.base_limit_minutes + usage.extension_minutes;
        const remainingMin = Math.max(0, Math.round((limit - usage.used_minutes) * 10) / 10);
        if (remainingMin === 0) {
          suggestions.push({
            type: "BUDGET_EXHAUSTED_TODAY",
            category,
            message: "今日额度已用完，可与监护人商量临时延长",
            priority: "HIGH",
          });
        } else if (remainingMin <= 10) {
          suggestions.push({
            type: "BUDGET_NEAR_LIMIT",
            category,
            remaining_minutes: remainingMin,
            message: `今日该类别仅剩约 ${remainingMin} 分钟`,
            priority: "MEDIUM",
          });
        }
      }
    }

    const out = {
      gated: false,
      generated_at: new Date(atMs).toISOString(),
      suggestions,
      basis: this._basis(subjectId, deviceId, atMs),
    };
    if (!this.generated.has(subjectId)) this.generated.set(subjectId, []);
    this.generated.get(subjectId).push({ at_ms: atMs, suggestions });
    return out;
  }

  /**
   * 撤权时刻检查：某条建议是否还允许展示。
   * 撤权后任何个性化建议都不可交付，即使它生成于撤权之前。
   */
  isDeliverable(subjectId, suggestionGeneratedAtMs, atMs = this.engine._now()) {
    const withdrawnAt = this.engine.profileWithdrawnAt(subjectId);
    if (withdrawnAt === null) return true;
    return atMs < withdrawnAt && suggestionGeneratedAtMs < withdrawnAt;
  }

  lastGeneratedAt(subjectId) {
    const list = this.generated.get(subjectId);
    return list && list.length > 0 ? list[list.length - 1].at_ms : null;
  }

  _activeCategories(subjectId) {
    // 去重当日类别；由调用方设备限定在 evaluate 中完成。
    const set = new Set();
    for (const s of this.engine.slicesFor(subjectId)) set.add(s.category);
    return [...set];
  }

  _basis(subjectId, deviceId, atMs) {
    // 依据用于解释与审计：建议不是黑盒推荐，而是政策+用量的直接推论。
    const first = this.engine.evaluate(subjectId, deviceId, "SHORT_VIDEO", atMs, { durationSeconds: 0 });
    return first.explanation.policy
      ? {
          policy_id: first.explanation.policy.policy_id,
          policy_version: first.explanation.policy.version,
          local_date: first.explanation.local_date,
          timezone: first.explanation.timezone,
        }
      : null;
  }
}
