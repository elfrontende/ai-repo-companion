import fs from "node:fs/promises";
import path from "node:path";
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

export async function writeRuntimeReportHtml(rootDir, config = {}, outputPath) {
  const report = await buildRuntimeReport(rootDir, config);
  const finalOutputPath = outputPath || path.join(rootDir, "state/reports/runtime-report.html");
  await fs.mkdir(path.dirname(finalOutputPath), { recursive: true });
  await fs.writeFile(finalOutputPath, renderRuntimeReportHtml(report), "utf8");
  return {
    outputPath: finalOutputPath,
    report
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
    whySkipped: status.compactSummary.whySkipped,
    whyLiveReview: status.compactSummary.whyLiveReview,
    whyConfident: status.compactSummary.whyConfident,
    topWasteDomains: status.benchmarkSummary.topWasteDomains.map((item) => ({
      domain: item.domain,
      liveTokensUsed: item.liveTokensUsed,
      reductionGap: item.reductionGap,
      evidenceScore: item.evidenceScore,
      evidenceBand: item.evidenceBand,
      riskLevel: item.riskLevel,
      expectedSavingsHint: item.expectedSavingsHint,
      expectedOutcome: item.expectedOutcome,
      impactSummary: item.impactSummary,
      whyRanked: item.whyRanked
    })),
    safeSavingsOpportunities: status.benchmarkSummary.safeSavingsOpportunities.map((item) => ({
      domain: item.domain,
      action: item.action,
      currentThreshold: item.currentThreshold,
      suggestedThreshold: item.suggestedThreshold,
      evidenceScore: item.evidenceScore,
      evidenceBand: item.evidenceBand,
      riskLevel: item.riskLevel,
      expectedSavingsHint: item.expectedSavingsHint,
      expectedOutcome: item.expectedOutcome,
      impactSummary: item.impactSummary,
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
    tuningPreview: (tuning.tuningPlan?.steps ?? []).slice(0, 3).map(buildPhasePreview),
    workflowPreview: (tuning.workflow?.phases ?? []).slice(0, 3).map(buildWorkflowPreview)
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
      stableWindowDirection: multiCycle.stableWindowDirection ?? null,
      windowHistorySummary: multiCycle.windowHistorySummary ?? { available: false, reason: "no-window-history" },
      windowComparison: {
        direction: cycleWindow.direction ?? null,
        delta: cycleWindow.delta ?? null,
        summary: cycleWindow.recommendation ?? "No cycle window comparison is available yet."
      },
      windowHistory: {
        count: multiCycle.windowHistory?.count ?? 0,
        items: (multiCycle.windowHistory?.items ?? []).slice(-3)
      },
      recentWindowExtremes: multiCycle.recentWindowExtremes ?? { available: false, reason: "no-window-history" },
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
    evidenceScore: action.evidenceScore,
    evidenceBand: action.evidenceBand,
    riskLevel: action.riskLevel,
    expectedOutcome: action.expectedOutcome,
    impactSummary: action.impactSummary
  };
}

function buildPhasePreview(step) {
  return {
    phase: step.phase,
    title: step.title,
    riskLevel: step.riskLevel,
    confidence: buildConfidenceCard(step.confidence),
    whyThisPhase: step.whyThisPhase,
    expectedImpactSummary: step.expectedImpactSummary,
    deltaBreakdown: step.deltaBreakdown,
    deltaHint: summarizePhaseDeltaHint(step.expectedImpact),
    deltaCard: buildPhaseDeltaCard(step.expectedImpact, step.deltaBreakdown)
  };
}

function buildPhaseEvidenceCard(step) {
  return {
    phase: step.phase,
    riskLevel: step.riskLevel,
    confidence: buildConfidenceCard(step.confidence),
    applyableCount: step.applyableCount,
    autoApplicableCount: step.autoApplicableCount,
    expectedImpactSummary: step.expectedImpactSummary,
    deltaBreakdown: step.deltaBreakdown,
    deltaHint: summarizePhaseDeltaHint(step.expectedImpact),
    deltaCard: buildPhaseDeltaCard(step.expectedImpact, step.deltaBreakdown),
    whyThisPhase: step.whyThisPhase
  };
}

function buildWorkflowPreview(phase) {
  return {
    phase: phase.phase,
    recommendation: phase.recommendation,
    commands: phase.commands,
    recommendedLoop: phase.recommendedLoop
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

function buildPhaseDeltaCard(expectedImpact, deltaBreakdown) {
  const domains = Array.isArray(expectedImpact?.domains)
    ? expectedImpact.domains.map((item) => item.domain).filter(Boolean)
    : Array.isArray(expectedImpact?.affectedDomains)
      ? expectedImpact.affectedDomains.filter(Boolean)
      : [];

  return {
    estimatedTokenDelta: Number(expectedImpact?.estimatedTokenDelta) || 0,
    totalThresholdDelta: Number(deltaBreakdown?.totalThresholdDelta) || 0,
    affectedDomains: domains,
    applyableChanges: Number(deltaBreakdown?.applyableChanges) || 0,
    autoApplicableChanges: Number(deltaBreakdown?.autoApplicableChanges) || 0
  };
}

function buildLongRunSummary(benchmarkCycleSummary) {
  const trendDirection = benchmarkCycleSummary.trendDirection ?? "mixed";
  const averageBalancedDelta = Number(benchmarkCycleSummary.averageBalancedDelta) || 0;
  const latestOutcomeStreak = Number(benchmarkCycleSummary.latestOutcomeStreak) || 0;
  const confidence = benchmarkCycleSummary.confidence?.level ?? "low";
  const stableWindowDirection = benchmarkCycleSummary.multiCycle?.stableWindowDirection ?? null;
  const spread = benchmarkCycleSummary.multiCycle?.recentWindowExtremes?.spread ?? null;

  if (trendDirection === "improving") {
    return `Long-run cycle evidence is ${confidence} confidence and improving, with an average balanced delta of ${averageBalancedDelta.toFixed(2)} across the recent window, a streak of ${latestOutcomeStreak}, ${stableWindowDirection === "improving" ? "repeated improving window comparisons," : "at least one recent improving window comparison,"} and a recent window spread of ${Number.isFinite(spread) ? spread.toFixed(2) : "0.00"}.`;
  }
  if (trendDirection === "degrading") {
    return `Long-run cycle evidence is ${confidence} confidence and degrading, with an average balanced delta of ${averageBalancedDelta.toFixed(2)}, a streak of ${latestOutcomeStreak}, ${stableWindowDirection === "degrading" ? "repeated degrading window comparisons," : "at least one recent degrading window comparison,"} and a recent window spread of ${Number.isFinite(spread) ? spread.toFixed(2) : "0.00"}.`;
  }
  return `Long-run cycle evidence is ${confidence} confidence and still mixed, so recent benchmark windows should be treated as directional rather than conclusive.`;
}

function renderRuntimeReportHtml(report) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AI Repo Companion Runtime Report</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f4ef;
        --panel: #fffdf7;
        --ink: #1c1b18;
        --muted: #6b665f;
        --accent: #0f766e;
        --border: #d9d2c4;
      }
      body {
        margin: 0;
        font: 15px/1.5 "Iowan Old Style", "Palatino Linotype", Georgia, serif;
        background: linear-gradient(180deg, #f8f6ef 0%, #ece7d9 100%);
        color: var(--ink);
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 32px 20px 64px;
      }
      h1, h2, h3 {
        font-family: "Avenir Next Condensed", "Helvetica Neue", Arial, sans-serif;
        letter-spacing: 0.02em;
        margin: 0 0 12px;
      }
      h1 {
        font-size: 36px;
      }
      h2 {
        font-size: 24px;
        margin-top: 28px;
      }
      .lede {
        color: var(--muted);
        margin: 0 0 24px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 18px;
        box-shadow: 0 10px 24px rgba(28, 27, 24, 0.04);
      }
      .eyebrow {
        font: 12px/1.2 "Avenir Next Condensed", "Helvetica Neue", Arial, sans-serif;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--accent);
        margin-bottom: 8px;
      }
      .metric {
        font-size: 28px;
        font-weight: 700;
        margin-bottom: 6px;
      }
      .muted {
        color: var(--muted);
      }
      ul {
        padding-left: 18px;
        margin: 8px 0 0;
      }
      li + li {
        margin-top: 8px;
      }
      code {
        font-family: "SFMono-Regular", Menlo, Consolas, monospace;
        background: rgba(15, 118, 110, 0.08);
        padding: 1px 5px;
        border-radius: 6px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Runtime Report</h1>
      <p class="lede">Generated at ${escapeHtml(report.generatedAt)}. This page compresses the operator control plane into a short visual briefing.</p>
      <section class="grid">
        <article class="card">
          <div class="eyebrow">Health</div>
          <div class="metric">${escapeHtml(report.overview.health)}</div>
          <div class="muted">Queued: ${report.overview.queue.queued}, running: ${report.overview.queue.running}, approvals: ${report.overview.queue.awaitingApproval}</div>
        </article>
        <article class="card">
          <div class="eyebrow">Live Tokens</div>
          <div class="metric">${escapeHtml(String(report.overview.liveTokensUsed))}</div>
          <div class="muted">Average per run: ${escapeHtml(String(report.overview.avgTokensPerRun))}</div>
        </article>
        <article class="card">
          <div class="eyebrow">Benchmark Confidence</div>
          <div class="metric">${escapeHtml(report.overview.confidence.benchmark.level)}</div>
          <div class="muted">${escapeHtml(report.overview.confidence.benchmark.primaryReason)}</div>
        </article>
        <article class="card">
          <div class="eyebrow">Cycle Confidence</div>
          <div class="metric">${escapeHtml(report.overview.confidence.cycles.level)}</div>
          <div class="muted">${escapeHtml(report.overview.confidence.cycles.primaryReason)}</div>
        </article>
      </section>

      <h2>Economics</h2>
      <section class="grid">
        <article class="card">
          <div class="eyebrow">Why Expensive</div>
          <div>${escapeHtml(report.economics.whyExpensive)}</div>
        </article>
        <article class="card">
          <div class="eyebrow">Why Skipped</div>
          <div>${escapeHtml(report.economics.whySkipped)}</div>
        </article>
        <article class="card">
          <div class="eyebrow">Why Live Review</div>
          <div>${escapeHtml(report.economics.whyLiveReview)}</div>
        </article>
        <article class="card">
          <div class="eyebrow">Why Confident</div>
          <div>${escapeHtml(report.economics.whyConfident)}</div>
        </article>
      </section>

      <h2>Next Actions</h2>
      <section class="grid">
        ${renderListCard("Runtime Actions", report.controls.nextActions.map((item) => `<code>${escapeHtml(item.action)}</code> — ${escapeHtml(item.whyNow)}`))}
        ${renderListCard("Doctor Actions", report.controls.doctorActions.map((item) => `<code>${escapeHtml(item.action)}</code> — ${escapeHtml(item.whyNow)}`))}
      </section>

      <h2>Tuning Workflow</h2>
      <section class="grid">
        ${renderListCard(
          "Phase Loops",
          report.controls.workflowPreview.map((phase) => `<strong>${escapeHtml(phase.phase)}</strong> — ${escapeHtml(phase.recommendation)}<br><span class="muted">${escapeHtml(phase.recommendedLoop.join(" -> "))}</span>`)
        )}
      </section>

      <h2>Evidence</h2>
      <section class="grid">
        <article class="card">
          <div class="eyebrow">Before / After</div>
          <div class="metric">${escapeHtml(report.evidence.beforeAfter.confidence.level)}</div>
          <div>${escapeHtml(report.evidence.beforeAfter.summary)}</div>
        </article>
        <article class="card">
          <div class="eyebrow">Long Run</div>
          <div class="metric">${escapeHtml(report.evidence.longRun.confidence.level)}</div>
          <div>${escapeHtml(report.evidence.longRun.summary)}</div>
        </article>
        <article class="card">
          <div class="eyebrow">Window Compare</div>
          <div class="metric">${escapeHtml(report.evidence.longRun.stableWindowDirection ?? report.evidence.cycleWindow.direction ?? "mixed")}</div>
          <div>${escapeHtml(report.evidence.cycleWindow.summary)}</div>
        </article>
        <article class="card">
          <div class="eyebrow">Rollback</div>
          <div class="metric">${escapeHtml(report.evidence.rollback.canaryStatus)}</div>
          <div>${escapeHtml(report.evidence.rollback.primaryReason)}</div>
        </article>
        <article class="card">
          <div class="eyebrow">Diagnostics</div>
          <div class="metric">${escapeHtml(report.evidence.diagnostics.highestSeverity)}</div>
          <div>${escapeHtml(report.evidence.diagnostics.topFinding)}</div>
        </article>
      </section>
    </main>
  </body>
</html>`;
}

function renderListCard(title, items) {
  const list = items.length > 0
    ? `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`
    : `<div class="muted">No items.</div>`;
  return `<article class="card"><div class="eyebrow">${escapeHtml(title)}</div>${list}</article>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
