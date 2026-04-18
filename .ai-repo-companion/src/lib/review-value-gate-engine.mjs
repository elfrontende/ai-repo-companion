// The value gate exists for one reason:
// if a queued review job looks too weak to justify a live model call,
// we should skip it locally and save tokens.
//
// This is intentionally heuristic and simple. We do not try to be "smart"
// in a magical way here. We only look at cheap, already-available signals:
// - how many tasks were compacted into the job
// - how many reasons/domains/events back the job
// - how much context the bounded retriever found for it

export function assessReviewValueGate(job, payload, config = {}) {
  const resolvedThreshold = resolveDomainAwareThreshold(job, config);
  const gate = {
    enabled: config.enabled !== false,
    applyToModes: Array.isArray(config.applyToModes) && config.applyToModes.length > 0
      ? config.applyToModes
      : ["balanced"],
    minScore: resolvedThreshold.value
  };

  if (!gate.enabled) {
    return buildSkippedAssessment(gate, "Value gate is disabled in config.");
  }

  if (!gate.applyToModes.includes(job.mode)) {
    return buildSkippedAssessment(gate, `Mode "${job.mode}" is not covered by the value gate.`);
  }

  const contributions = [];
  const mergedTaskCount = Number(job.mergedTaskCount) || Math.max(1, Array.isArray(job.tasks) ? job.tasks.length : 1);
  addContribution(contributions, "mergedTasks", mergedTaskScore(mergedTaskCount), `${mergedTaskCount} merged task(s) in this review job.`);

  const reasonCount = Array.isArray(job.reasons) ? job.reasons.length : 0;
  addContribution(contributions, "reasons", bucketScore(reasonCount, [
    [3, 16],
    [2, 10],
    [1, 4]
  ]), `${reasonCount} queue reason(s) support this review job.`);

  const domainCount = Array.isArray(job.domains) ? job.domains.length : 0;
  addContribution(contributions, "domains", bucketScore(domainCount, [
    [3, 14],
    [2, 10],
    [1, 5]
  ]), `${domainCount} domain(s) are attached to this review job.`);

  const sourceEventCount = Array.isArray(job.sourceEventIds)
    ? job.sourceEventIds.length
    : (job.sourceEventId ? 1 : 0);
  addContribution(contributions, "sourceEvents", bucketScore(sourceEventCount, [
    [3, 16],
    [2, 12],
    [1, 4]
  ]), `${sourceEventCount} source event(s) fed this review job.`);

  const selectedNotesCount = Number(payload?.contextBundle?.selectedNotes?.length) || 0;
  addContribution(contributions, "selectedNotes", bucketScore(selectedNotesCount, [
    [5, 12],
    [3, 8],
    [1, 4]
  ]), `${selectedNotesCount} note(s) were selected for bounded context.`);

  const usedTokens = Number(payload?.contextBundle?.usedTokens) || 0;
  addContribution(contributions, "contextTokens", bucketScore(usedTokens, [
    [250, 10],
    [120, 6],
    [1, 3]
  ]), `${usedTokens} estimated context token(s) were actually used.`);

  const score = contributions.reduce((sum, item) => sum + item.score, 0);
  const passed = score >= gate.minScore;

  return {
    enabled: true,
    applies: true,
    passed,
    shouldSkip: !passed,
    score,
    threshold: gate.minScore,
    thresholdSource: resolvedThreshold.source,
    contributions,
    reason: passed
      ? "Review job cleared the local value gate and can use a live model call."
      : "Review job was skipped by the local value gate because current signals suggest that a live review would likely be low-value."
  };
}

function buildSkippedAssessment(gate, reason) {
  return {
    enabled: gate.enabled,
    applies: false,
    passed: true,
    shouldSkip: false,
    score: null,
    threshold: gate.minScore,
    thresholdSource: "default",
    contributions: [],
    reason
  };
}

function resolveDomainAwareThreshold(job, config) {
  const defaultThreshold = Math.max(1, Number(config.minScore) || 40);
  const perDomain = config.minScoreByDomain ?? {};
  const domains = Array.isArray(job?.domains) ? job.domains : [];
  let matchedDomain = null;
  let matchedThreshold = defaultThreshold;

  for (const domain of domains) {
    const domainThreshold = Number(perDomain?.[domain]);
    if (!Number.isFinite(domainThreshold)) {
      continue;
    }
    if (domainThreshold > matchedThreshold) {
      matchedThreshold = Math.max(1, domainThreshold);
      matchedDomain = domain;
    }
  }

  return {
    value: matchedThreshold,
    source: matchedDomain ? `domain:${matchedDomain}` : "default"
  };
}

function addContribution(contributions, key, score, note) {
  contributions.push({
    key,
    score,
    note
  });
}

function mergedTaskScore(count) {
  if (count >= 3) {
    return 20;
  }
  if (count === 2) {
    return 14;
  }
  return 8;
}

function bucketScore(value, buckets) {
  for (const [threshold, score] of buckets) {
    if (value >= threshold) {
      return score;
    }
  }
  return 0;
}
