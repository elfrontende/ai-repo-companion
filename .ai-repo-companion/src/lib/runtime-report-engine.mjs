import { getRuntimeStatus, runRuntimeDoctor } from "./runtime-status-engine.mjs";

// The report command is the shortest operator-facing view of the control plane.
// It intentionally collapses status + doctor into one compact structure so a
// repo owner can answer "what is happening, why, and what should I do next?"
// without walking several JSON trees by hand.

export async function buildRuntimeReport(rootDir, config = {}) {
  const status = await getRuntimeStatus(rootDir, config);
  const doctor = await runRuntimeDoctor(rootDir, config);

  return {
    generatedAt: new Date().toISOString(),
    overview: buildOverview(status),
    economics: buildEconomics(status),
    controls: buildControls(status, doctor),
    evidence: buildEvidence(status, doctor)
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

function buildControls(status, doctor) {
  return {
    whyTuneNow: status.compactSummary.whyTuneNow,
    whyQueueBlocked: status.compactSummary.whyQueueBlocked,
    whyNotTuneHarder: status.compactSummary.whyNotTuneHarder,
    nextActions: status.nextActions.slice(0, 3).map(compactAction),
    doctorActions: doctor.recommendedActions.slice(0, 3).map(compactAction)
  };
}

function buildEvidence(status, doctor) {
  return {
    benchmark: {
      cheapestVariant: status.benchmarkSummary.cheapestVariant,
      balancedReductionPercent: status.benchmarkSummary.balancedReductionPercent,
      saverReductionPercent: status.benchmarkSummary.saverReductionPercent,
      confidence: buildConfidenceCard(status.benchmarkSummary.confidence),
      tuningOutcome: status.benchmarkSummary.tuningComparison?.outcome ?? null,
      tuningSummary: status.benchmarkSummary.tuningComparison?.summary ?? null
    },
    cycles: {
      trendDirection: status.benchmarkCycleSummary.trendDirection,
      latestOutcome: status.benchmarkCycleSummary.latestOutcome,
      windowDirection: status.benchmarkCycleSummary.windowComparison?.direction ?? null,
      confidence: buildConfidenceCard(status.benchmarkCycleSummary.confidence),
      recommendation: status.benchmarkCycleSummary.recommendation
    },
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
