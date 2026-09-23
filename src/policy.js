// 政策登记册：版本化政策的写入冲突检测与生效期选择。
//
// 政策是不可变的版本化文档：同一条 policy_id 的新版本必须 version 严格递增，
// 修订时监护人带 expected_version 做乐观锁——多位监护人同时编辑时，
// 后写入的一方会收到 VersionConflictError，而不是静默覆盖对方的修改。

export class VersionConflictError extends Error {
  constructor({ policy_id, expected_version, actual_version, event_id }) {
    super(
      `政策 ${policy_id} 版本冲突：期望基于 v${expected_version}，当前已是 v${actual_version}`,
    );
    this.name = "VersionConflictError";
    this.code = "POLICY_VERSION_CONFLICT";
    this.policy_id = policy_id;
    this.expected_version = expected_version;
    this.actual_version = actual_version;
    this.event_id = event_id;
  }
}

export class PolicyValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "PolicyValidationError";
    this.code = "POLICY_INVALID";
    this.details = details;
  }
}

function scopeMatches(scope, deviceId, category) {
  if (!scope) return { devices: false, categories: false, matched: true };
  const devices = Array.isArray(scope.devices) && scope.devices.length > 0;
  const categories = Array.isArray(scope.categories) && scope.categories.length > 0;
  const deviceOk = !devices || scope.devices.includes(deviceId);
  const categoryOk = !categories || scope.categories.includes(category);
  return { devices, categories, matched: deviceOk && categoryOk };
}

export class PolicyRegistry {
  constructor() {
    // policy_id -> { id, current_version, withdrawn, versions: Map<version, doc> }
    this._policies = new Map();
  }

  /**
   * 应用一条 POLICY_DEFINED 事件。
   * doc：{ policy_id, version, subject_id, timezone, scope, rules,
   *        effective_from, effective_to, created_by, expected_version }
   * 抛出 VersionConflictError / PolicyValidationError。
   */
  define(doc, meta = {}) {
    const existing = this._policies.get(doc.policy_id);
    if (existing?.withdrawn) {
      throw new PolicyValidationError(`政策 ${doc.policy_id} 已停用，不能继续追加版本`, {
        policy_id: doc.policy_id,
      });
    }
    if (existing) {
      const next = existing.current_version + 1;
      if (doc.version !== next) {
        throw new VersionConflictError({
          policy_id: doc.policy_id,
          expected_version: doc.version - 1,
          actual_version: existing.current_version,
          event_id: meta.event_id,
        });
      }
      // 修订必须基于自己看到的版本（乐观锁）；缺字段或版本落后都拒绝，
      // 避免两位监护人的后写方静默覆盖先写方。
      if (doc.expected_version === undefined) {
        throw new PolicyValidationError(
          `修订政策 ${doc.policy_id} 必须携带 expected_version`,
          { policy_id: doc.policy_id },
        );
      }
      if (doc.expected_version !== existing.current_version) {
        throw new VersionConflictError({
          policy_id: doc.policy_id,
          expected_version: doc.expected_version,
          actual_version: existing.current_version,
          event_id: meta.event_id,
        });
      }
      existing.current_version = doc.version;
      existing.versions.set(doc.version, doc);
    } else {
      if (doc.version !== 1) {
        throw new PolicyValidationError(
          `新政策 ${doc.policy_id} 必须从 v1 开始，收到 v${doc.version}`,
          { policy_id: doc.policy_id, version: doc.version },
        );
      }
      this._policies.set(doc.policy_id, {
        id: doc.policy_id,
        subject_id: doc.subject_id,
        current_version: 1,
        withdrawn: false,
        versions: new Map([[1, doc]]),
      });
    }
    return this._policies.get(doc.policy_id);
  }

  withdraw(policyId, meta = {}) {
    const existing = this._policies.get(policyId);
    if (!existing) {
      throw new PolicyValidationError(`停用失败：政策 ${policyId} 不存在`, { policy_id: policyId });
    }
    if (existing.withdrawn) {
      throw new PolicyValidationError(`政策 ${policyId} 已处于停用状态`, { policy_id: policyId });
    }
    existing.withdrawn = true;
    existing.withdrawn_at = meta.at;
    existing.withdrawn_by = meta.by;
    return existing;
  }

  /** 当前版本号（供编辑方读取后填入 expected_version）。 */
  currentVersion(policyId) {
    return this._policies.get(policyId)?.current_version ?? null;
  }

  /** 成员名下全部政策的时区（去重），供尚无消费记录时推断日界。 */
  timezonesFor(subjectId) {
    const out = new Set();
    for (const rec of this._policies.values()) {
      if (rec.subject_id !== subjectId || rec.withdrawn) continue;
      const latest = rec.versions.get(rec.current_version);
      if (latest) out.add(latest.timezone);
    }
    return [...out];
  }

  /**
   * 不考虑生效期，按设备/类别匹配度选出最具体政策的时区。
   * 用于在"某时刻政策恰好不生效"的边界情况下仍能正确确定本地日。
   */
  timezoneFor(subjectId, deviceId, category) {
    const candidates = [];
    for (const rec of this._policies.values()) {
      if (rec.subject_id !== subjectId || rec.withdrawn) continue;
      const doc = rec.versions.get(rec.current_version);
      const sm = scopeMatches(doc.scope, deviceId, category);
      if (!sm.matched) continue;
      candidates.push({ doc, specificity: sm.specificity });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      const af = Date.parse(a.doc.effective_from);
      const bf = Date.parse(b.doc.effective_from);
      if (bf !== af) return bf - af;
      return b.doc.version - a.doc.version;
    });
    return candidates[0].doc.timezone;
  }

  /**
   * 在某绝对时刻为"成员 + 设备 + 内容类别"选出适用政策版本。
   * 返回 { policy, version, specificity } 或 null。
   * 多条政策同时命中时，更具体的优先（限定了设备/类别 > 兜底政策），
   * 同等具体时新生效期、新版本优先，保证选择确定且可解释。
   */
  select(subjectId, deviceId, category, instantMs) {
    const candidates = [];
    for (const rec of this._policies.values()) {
      if (rec.subject_id !== subjectId || rec.withdrawn) continue;
      // 选择该时刻处于生效期内的最新版本（政策换版通常有重叠或衔接）。
      let activeDoc = null;
      for (const v of rec.versions.values()) {
        const from = Date.parse(v.effective_from);
        const to = v.effective_to ? Date.parse(v.effective_to) : Infinity;
        if (instantMs >= from && instantMs < to && (!activeDoc || v.version > activeDoc.version)) {
          activeDoc = v;
        }
      }
      if (!activeDoc) continue;
      const sm = scopeMatches(activeDoc.scope, deviceId, category);
      if (!sm.matched) continue;
      candidates.push({
        doc: activeDoc,
        specificity: (sm.devices ? 1 : 0) + (sm.categories ? 1 : 0),
      });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      const af = Date.parse(a.doc.effective_from);
      const bf = Date.parse(b.doc.effective_from);
      if (bf !== af) return bf - af;
      return b.doc.version - a.doc.version;
    });
    const winner = candidates[0];
    return { policy: winner.doc, version: winner.doc.version, specificity: winner.specificity };
  }
}

/**
 * 从政策版本中解析某天类型实际生效的规则：
 * 精确日类型规则优先，其次 ANY 兜底。
 */
export function resolveRule(policy, dayType) {
  const rules = policy.rules ?? [];
  return rules.find((r) => r.day_type === dayType) ?? rules.find((r) => r.day_type === "ANY") ?? null;
}

/** 取某类别当日分钟预算：类别精确预算优先，"*" 为兜底；无预算条目表示不限。 */
export function budgetFor(rule, category) {
  if (!rule?.budgets) return null;
  const exact = rule.budgets.find((b) => b.category === category);
  if (exact) return exact.daily_limit_minutes;
  const wildcard = rule.budgets.find((b) => b.category === "*");
  return wildcard ? wildcard.daily_limit_minutes : null;
}

/** 取某类别适用的挂钟时间窗（精确类别 + 通配）。 */
export function windowsFor(rule, category) {
  if (!rule?.windows) return [];
  return rule.windows.filter((w) => w.category === undefined || w.category === "*" || w.category === category);
}
