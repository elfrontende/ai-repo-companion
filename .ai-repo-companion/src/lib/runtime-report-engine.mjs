import { getRuntimeStatus, runRuntimeDoctor } from "./runtime-status-engine.mjs";
import { analyzePolicyTuning } from "./policy-tuning-engine.mjs";

// The report command is the shortest operator-facing view of the control plane.
// It intentionally collapses status + doctor into one compact structure so a
// repo owner can answer "what is happening, why, and what should I do next?"
// without walking several JSON trees by hand.

export async function buildRuntimeReport(rootDir, config = {}) {
  const status = await getRuntimeStatus(rootDir, config);
  const doctor = await runRuntimeDoctor(rootDir, config);
  const tuning = await analyzePolicyTuning(rootDir);

  return {
    generatedAt: new Date().toISOString(),
    overview: buildOverview(status),
    economics: buildEconomics(status),
    controls: buildControls(status, doctor, tuning),
    evidence: buildEvidence(status, doctor, tuning)
  };
}

function buildOverview(status) {
  return {
    health: status.compactSummary.health,
    queue: {
      queued: status.queue.queued,
      running: status.queue.running,
      awaitingApproval: status.queue.awaitingApproval
    },
    liveTokensUsed: status.costSummary.liveTokensUsed,
    avgTokensPerRun: status.costSummary.avgTokensPerRun,
    canaryStatus: status.tuningSummary.canaryStatus ?? "none",
    confidence: {
      benchmark: buildConfidenceCard(status.benchmarkSummary.confidence),
      cycles: buildConfidenceCard(status.benchmarkCycleSummary.confidence)
    }
  };
}

function buildEconomics(status) {
  return {
    whyExpensive: status.compactSummary.whyExpensive,
    whyConfident: status.compactSummary.whyConfident,
    topWasteDomains: status.benchmarkSummary.topWasteDomains.map((item) => ({
      domain: item.domain,
      liveTokensUsed: item.liveTokensUsed,
      reductionGap: item.reductionGap,
      riskLevel: item.riskLevel,
      expectedSavingsHint: item.expectedSavingsHint,
      whyRanked: item.whyRanked
    })),
    safeSavingsOpportunities: status.benchmarkSummary.safeSavingsOpportunities.map((item) => ({
      domain: item.domain,
      action: item.action,
      currentThreshold: item.currentThreshold,
      suggestedThreshold: item.suggestedThreshold,
      riskLevel: item.riskLevel,
      expectedSavingsHint: item.expectedSavingsHint,
      whyRanked: item.whyRanked
    }))
  };
}

function buildControls(status, doctor, tuning) {
  return {
    whyTuneNow: status.compactSummary.whyTuneNow,
    whyQueueBlocked: status.compactSummary.whyQueueBlocked,
    whyNotTuneHarder: status.compactSummary.whyNotTuneHarder,
    nextActions: status.nextActions.slice(0, 3).map(compactAction),
    doctorActions: doctor.recommendedActions.slice(0, 3).map(compactAction),
    tuningPreview: (tuning.tuningPlan?.steps ?? []).slice(0, 3).map(buildPhasePreview)
  };
}

function buildEvidence(status, doctor, tuning) {
  const tuningComparison = status.benchmarkSummary.tuningComparison ?? {};
  const cycleWindow = status.benchmarkCycleSummary.windowComparison ?? {};
  const multiCycle = status.benchmarkCycleSummary.multiCycle ?? {};
  return {
    benchmark: {
      cheapestVariant: status.benchmarkSummary.cheapestVariant,
      balancedReductionPercent: status.benchmarkSummary.balancedReductionPercent,
      saverReductionPercent: status.benchmarkSummary.saverReductionPercent,
      confidence: buildConfidenceCard(status.benchmarkSummary.confidence),
      tuningOutcome: status.benchmarkSummary.tuningComparison?.outcome ?? null,
      tuningSummary: status.benchmarkSummary.tuningComparison?.summary ?? null
    },
    beforeAfter: {
      cheapestVariantBaseline: tuningComparison.cheapestVariant?.baseline ?? null,
      cheapestVariantCurrent: tuningComparison.cheapestVariant?.current ?? null,
      balancedReductionPercentDelta: tuningComparison.balancedReductionPercentDelta ?? null,
      saverReductionPercentDelta: tuningComparison.saverReductionPercentDelta ?? null,
      confidence: buildConfidenceCard(tuningComparison.confidence),
      summary: tuningComparison.summary ?? "No before/after tuning evidence is available yet."
    },
    cycles: {
      trendDirection: status.benchmarkCycleSummary.trendDirection,
      latestOutcome: status.benchmarkCycleSummary.latestOutcome,
      windowDirection: status.benchmarkCycleSummary.windowComparison?.direction ?? null,
      confidence: buildConfidenceCard(status.benchmarkCycleSummary.confidence),
      recommendation: status.benchmarkCycleSummary.recommendation
    },
    rollback: {
      canaryStatus: status.tuningSummary.canaryStatus ?? "none",
      reconciledAt: status.tuningSummary.canaryReconciledAt ?? null,
      remainingRollbackCount: status.tuningSummary.canaryRemainingRollbackCount ?? 0,
      recentAppliedPhases: status.tuningSummary.recentAppliedPhases ?? [],
      primaryReason: status.tuningSummary.canaryReconciliationReasons?.[0] ?? "No rollback or reconcile reason is recorded yet."
    },
    cycleWindow: {
      direction: cycleWindow.direction ?? null,
      delta: cycleWindow.delta ?? null,
      currentWindowAverage: cycleWindow.currentWindowAverage ?? null,
      previousWindowAverage: cycleWindow.previousWindowAverage ?? null,
      summary: cycleWindow.recommendation ?? "No cycle window comparison is available yet."
    },
    longRun: {
      recentCycleCount: multiCycle.recentCycleCount ?? 0,
      trendDirection: status.benchmarkCycleSummary.trendDirection,
      latestOutcomeStreak: status.benchmarkCycleSummary.latestOutcomeStreak,
      averageBalancedDelta: status.benchmarkCycleSummary.averageBalancedDelta,
      averageRollbackCount: status.benchmarkCycleSummary.averageRollbackCount,
      windowComparison: {
        direction: cycleWindow.direction ?? null,
        delta: cycleWindow.delta ?? null,
        summary: cycleWindow.recommendation ?? "No cycle window comparison is available yet."
      },
      confidence: buildConfidenceCard(status.benchmarkCycleSummary.confidence),
      summary: buildLongRunSummary(status.benchmarkCycleSummary)
    },
    tuningPhases: (tuning.tuningPlan?.steps ?? []).slice(0, 3).map(buildPhaseEvidenceCard),
    diagnostics: {
      highestSeverity: doctor.compactSummary.highestSeverity,
      topFinding: doctor.compactSummary.topFinding,
      whyBlocked: doctor.compactSummary.whyBlocked
    }
  };
}

function buildConfidenceCard(confidence) {
  return {
    level: confidence?.level ?? "low",
    score: confidence?.score ?? 0,
    primaryReason: confidence?.reasons?.[0] ?? "confidence evidence is unavailable"
  };
}

function compactAction(action) {
  return {
    action: action.action,
    reason: action.reason,
    whyNow: action.whyNow,
    riskLevel: action.riskLevel,
    expectedOutcome: action.expectedOutcome
  };
}

function buildPhasePreview(step) {
  return {
    phase: step.phase,
    title: step.title,
    riskLevel: step.riskLevel,
    whyThisPhase: step.whyThisPhase,
    expectedImpactSummary: step.expectedImpactSummary,
    deltaHint: summarizePhaseDeltaHint(step.expectedImpact)
  };
}

function buildPhaseEvidenceCard(step) {
  return {
    phase: step.phase,
    riskLevel: step.riskLevel,
    applyableCount: step.applyableCount,
    autoApplicableCount: step.autoApplicableCount,
    expectedImpactSummary: step.expectedImpactSummary,
    deltaHint: summarizePhaseDeltaHint(step.expectedImpact),
    whyThisPhase: step.whyThisPhase
  };
}

function summarizePhaseDeltaHint(expectedImpact) {
  const domainCount = Array.isArray(expectedImpact?.domains)
    ? expectedImpact.domains.length
    : Array.isArray(expectedImpact?.affectedDomains)
      ? expectedImpact.affectedDomains.length
      : 0;
  const estimatedTokenDelta = Number(expectedImpact?.estimatedTokenDelta) || 0;
  const thresholdDelta = Array.isArray(expectedImpact?.domains)
    ? expectedImpact.domains.reduce((total, item) => total + (Number(item.thresholdDelta) || 0), 0)
    : Number(expectedImpact?.thresholdDelta) || 0;

  if (estimatedTokenDelta > 0 && domainCount > 0) {
    return `Touches ${domainCount} domain(s) with about ${estimatedTokenDelta} synthetic tokens of expected upside.`;
  }
  if (estimatedTokenDelta > 0) {
    return `Carries about ${estimatedTokenDelta} synthetic tokens of expected upside.`;
  }
  if (thresholdDelta > 0 && domainCount > 0) {
    return `Raises domain gates by about ${thresholdDelta} points across ${domainCount} domain(s).`;
  }
  if (thresholdDelta > 0) {
    return `Raises local thresholds by about ${thresholdDelta} points.`;
  }
  return "Expected impact is directional but not yet strong enough for a numeric delta hint.";
}

function buildLongRunSummary(benchmarkCycleSummary) {
  const trendDirection = benchmarkCycleSummary.trendDirection ?? "mixed";
  const averageBalancedDelta = Number(benchmarkCycleSummary.averageBalancedDelta) || 0;
  const latestOutcomeStreak = Number(benchmarkCycleSummary.latestOutcomeStreak) || 0;
  const confidence = benchmarkCycleSummary.confidence?.level ?? "low";

  if (trendDirection === "improving") {
    return `Long-run cycle evidence is ${confidence} confidence and improving, with an average balanced delta of ${averageBalancedDelta.toFixed(2)} across the recent window and a streak of ${latestOutcomeStreak}.`;
  }
  if (trendDirection === "degrading") {
    return `Long-run cycle evidence is ${confidence} confidence and degrading, with an average balanced delta of ${averageBalancedDelta.toFixed(2)} and a streak of ${latestOutcomeStreak}.`;
  }
  return `Long-run cycle evidence is ${confidence} confidence and still mixed, so recent benchmark windows should be treated as directional rather than conclusive.`;
}
