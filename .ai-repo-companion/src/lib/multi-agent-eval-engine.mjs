import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureWorkspace } from "./bootstrap.mjs";
import { readTaskRunSurface } from "./run-engine.mjs";
import { readJson, writeJson } from "./store.mjs";
import { runTaskFlow } from "./task-flow-engine.mjs";

const defaultScenarios = [
  {
    id: "docs-low-risk",
    task: "tighten deployment README wording and remove repeated guidance",
    summary: "Clarified deployment wording and removed a duplicated paragraph.",
    artifacts: ["docs", "readme"],
    reviewNow: false
  },
  {
    id: "verification-medium",
    task: "investigate flaky regression in API retries and prepare a safe fix handoff",
    summary: "Captured the suspected retry failure mode and the safest next debugging slice.",
    artifacts: ["tests", "api", "handoff"],
    reviewNow: false
  },
  {
    id: "migration-high-risk",
    task: "plan a safe auth schema migration rollout with backfill and security checks",
    summary: "Prepared a staged auth rollout with verification and approval constraints.",
    artifacts: ["auth", "migration", "security"],
    reviewNow: false
  }
];

export async function runMultiAgentEvaluation(rootDir, config, options = {}) {
  const scenarios = selectScenarios(options.suite);
  const results = [];

  for (const scenario of scenarios) {
    const legacyRoot = await prepareEvalWorkspace(rootDir, scenario.id, "legacy");
    const activeRoot = await prepareEvalWorkspace(rootDir, scenario.id, "active");
    const legacyConfig = await readJson(path.join(legacyRoot, "config/system.json"), {});
    const activeConfig = await readJson(path.join(activeRoot, "config/system.json"), {});

    legacyConfig.multiAgentRuntime = {
      ...(legacyConfig.multiAgentRuntime ?? {}),
      enabled: false
    };
    activeConfig.multiAgentRuntime = {
      ...(activeConfig.multiAgentRuntime ?? {}),
      enabled: true,
      rolloutMode: options.rolloutMode ?? activeConfig.multiAgentRuntime?.rolloutMode ?? "active"
    };

    const legacyRun = await runTaskFlow(legacyRoot, legacyConfig, scenario);
    const activeRun = await runTaskFlow(activeRoot, activeConfig, scenario);
    const legacySurface = await readTaskRunSurface(legacyRoot, legacyRun.run.id);
    const activeSurface = await readTaskRunSurface(activeRoot, activeRun.run.id);

    results.push(compareScenario(scenario, legacySurface, activeSurface));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    suite: options.suite ?? "default",
    rolloutMode: options.rolloutMode ?? config.multiAgentRuntime?.rolloutMode ?? "active",
    scenarioCount: results.length,
    aggregate: buildAggregate(results),
    scenarios: results
  };

  const outputPath = path.join(rootDir, "state/runs/evaluations/last-multi-agent-eval.json");
  await writeJson(outputPath, report);
  return {
    outputPath,
    report
  };
}

export async function readLatestMultiAgentEvaluation(rootDir) {
  const report = await readJson(path.join(rootDir, "state/runs/evaluations/last-multi-agent-eval.json"), null);
  if (!report) {
    return {
      loaded: false,
      reason: "no-multi-agent-eval"
    };
  }
  return {
    loaded: true,
    generatedAt: report.generatedAt,
    suite: report.suite,
    rolloutMode: report.rolloutMode,
    aggregate: report.aggregate,
    scenarios: report.scenarios
  };
}

function compareScenario(scenario, legacySurface, activeSurface) {
  const legacyCoverage = scoreRunSurface(legacySurface);
  const activeCoverage = scoreRunSurface(activeSurface);
  return {
    id: scenario.id,
    task: scenario.task,
    legacy: summarizeSurface(legacySurface, legacyCoverage),
    active: summarizeSurface(activeSurface, activeCoverage),
    delta: {
      coverageScore: activeCoverage - legacyCoverage,
      agentRuns: activeSurface.agentRuns.total - legacySurface.agentRuns.total,
      handoffs: activeSurface.handoffs.total - legacySurface.handoffs.total,
      verdicts: activeSurface.verdicts.total - legacySurface.verdicts.total,
      retries: activeSurface.retries.total - legacySurface.retries.total
    }
  };
}

function summarizeSurface(surface, coverageScore) {
  return {
    status: surface.run.status,
    multiAgentStatus: surface.run.multiAgentStatus,
    finalVerdict: surface.run.finalVerdict?.status ?? null,
    coverageScore,
    phaseCount: surface.run.phaseGraph.length,
    agentRuns: surface.agentRuns.total,
    handoffs: surface.handoffs.total,
    verdicts: surface.verdicts.total,
    retries: surface.retries.total,
    blockingVerdicts: surface.verdicts.blocking
  };
}

function scoreRunSurface(surface) {
  let score = 0;
  score += Math.min(surface.run.phaseGraph.length, 4);
  if (surface.agentRuns.total > 1) {
    score += 2;
  }
  if (surface.handoffs.total > 0) {
    score += 1;
  }
  if (surface.verdicts.total > 0) {
    score += 2;
  }
  if (surface.retries.completed > 0) {
    score += 2;
  }
  if (surface.run.finalVerdict?.status === "pass") {
    score += 2;
  }
  if (surface.run.finalVerdict?.status === "blocked") {
    score -= 2;
  }
  if (surface.run.finalVerdict?.status === "needs-rework") {
    score -= 1;
  }
  return score;
}

function buildAggregate(results) {
  const totals = results.reduce((acc, item) => {
    acc.coverageDelta += item.delta.coverageScore;
    acc.agentRunDelta += item.delta.agentRuns;
    acc.handoffDelta += item.delta.handoffs;
    acc.verdictDelta += item.delta.verdicts;
    acc.retryDelta += item.delta.retries;
    if (item.active.retries > 0) {
      acc.reworkedScenarios += 1;
    }
    if (item.active.finalVerdict === "blocked" || item.active.finalVerdict === "needs-rework") {
      acc.blockedScenarios += 1;
    }
    return acc;
  }, {
    coverageDelta: 0,
    agentRunDelta: 0,
    handoffDelta: 0,
    verdictDelta: 0,
    retryDelta: 0,
    reworkedScenarios: 0,
    blockedScenarios: 0
  });

  return {
    averageCoverageDelta: round(totals.coverageDelta / Math.max(1, results.length)),
    averageAgentRunDelta: round(totals.agentRunDelta / Math.max(1, results.length)),
    averageHandoffDelta: round(totals.handoffDelta / Math.max(1, results.length)),
    averageVerdictDelta: round(totals.verdictDelta / Math.max(1, results.length)),
    averageRetryDelta: round(totals.retryDelta / Math.max(1, results.length)),
    reworkedScenarios: totals.reworkedScenarios,
    blockedScenarios: totals.blockedScenarios
  };
}

function selectScenarios(suite) {
  if (suite === "high-risk") {
    return defaultScenarios.filter((scenario) => scenario.id === "migration-high-risk");
  }
  if (suite === "low-risk") {
    return defaultScenarios.filter((scenario) => scenario.id === "docs-low-risk");
  }
  return defaultScenarios;
}

async function prepareEvalWorkspace(rootDir, scenarioId, variant) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ai-repo-companion-eval-${scenarioId}-${variant}-`));
  await fs.cp(path.join(rootDir, "config"), path.join(tempRoot, "config"), { recursive: true });
  await fs.cp(path.join(rootDir, "notes"), path.join(tempRoot, "notes"), { recursive: true });
  await fs.cp(path.join(rootDir, "state"), path.join(tempRoot, "state"), { recursive: true });
  await ensureWorkspace(tempRoot);

  await fs.writeFile(path.join(tempRoot, "state/memory/working-memory.json"), JSON.stringify({
    hotNoteIds: [],
    recentEventIds: [],
    lastSyncAt: null
  }, null, 2));
  await fs.writeFile(path.join(tempRoot, "state/memory/events.jsonl"), "");
  await fs.writeFile(path.join(tempRoot, "state/memory/policy-state.json"), JSON.stringify({
    domains: {},
    recentModes: [],
    lastDecisionAt: null
  }, null, 2));
  await fs.writeFile(path.join(tempRoot, "state/memory/review-queue.json"), "[]\n");
  await fs.writeFile(path.join(tempRoot, "state/reviews/history.jsonl"), "");

  return tempRoot;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
