import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureWorkspace } from "./lib/bootstrap.mjs";
import { readJson } from "./lib/store.mjs";
import { classifyTask } from "./lib/task-engine.mjs";
import { planAgents } from "./lib/agent-engine.mjs";
import { assembleContext, loadNotes } from "./lib/context-engine.mjs";
import { syncMemory } from "./lib/memory-engine.mjs";
import { applyMemoryPolicyOutcome, evaluateMemoryPolicy } from "./lib/policy-engine.mjs";
import { approvePendingReview, inspectReviewQueue, processReviewQueue } from "./lib/review-worker.mjs";
import { getWorkerState, runReviewWorker } from "./lib/review-runner.mjs";
import { runTaskFlow } from "./lib/task-flow-engine.mjs";
import { summarizeReviewMetrics } from "./lib/review-metrics-engine.mjs";
import { analyzePolicyTuning, applyPolicyTuning, reconcileAutoPolicyTuning, runAutoPolicyTuning } from "./lib/policy-tuning-engine.mjs";
import { getRuntimeStatus, runRuntimeDoctor } from "./lib/runtime-status-engine.mjs";
import { buildRuntimeReport, writeRuntimeReportHtml } from "./lib/runtime-report-engine.mjs";
import { runSyntheticBenchmark, runSyntheticBenchmarkCycle } from "./lib/benchmark-engine.mjs";
import { applyReviewCostMode } from "./lib/review-cost-mode-engine.mjs";

// The CLI is intentionally thin.
// It is mostly argument parsing plus command routing into the lib/ modules.
// That keeps the interesting behavior testable without needing to shell out.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRoot = path.resolve(__dirname, "..");
const rootDir = process.env.AI_REPO_COMPANION_ROOT
  ? path.resolve(process.env.AI_REPO_COMPANION_ROOT)
  : defaultRoot;

const [command = "help", ...restArgs] = process.argv.slice(2);
const args = parseArgs(restArgs);

await ensureWorkspace(rootDir);
const systemConfig = await readJson(path.join(rootDir, "config/system.json"), {});

switch (command) {
  case "init":
    output({
      ok: true,
      rootDir,
      message: "Workspace is ready."
    });
    break;
  case "plan":
    await requireTask(args);
    output(await runPlan(args.task));
    break;
  case "context":
    await requireTask(args);
    output(await runContext(args.task, Number(args.budget) || systemConfig.retrieval?.defaultTokenBudget || 1200));
    break;
  case "policy":
    await requireTask(args);
    output(await runPolicy(args.task));
    break;
  case "sync":
    await requireTask(args);
    output(await runSync(args));
    break;
  case "task":
    await requireTask(args);
    output(await runTask(args));
    break;
  case "queue":
    output(await runQueue());
    break;
  case "status":
    output(await runStatus());
    break;
  case "doctor":
    output(await runDoctor());
    break;
  case "report":
    output(await runReport());
    break;
  case "benchmark":
    output(await runBenchmark(args));
    break;
  case "metrics":
    output(await runMetrics());
    break;
  case "tune":
    output(await runTune(args));
    break;
  case "review":
    output(await runReview(args));
    break;
  case "approve":
    output(await runApprove(args));
    break;
  case "worker":
    output(await runWorker(args));
    break;
  case "demo":
    await requireTask(args);
    output(await runDemo(args));
    break;
  default:
    output(helpText(), false);
}

async function runPlan(task) {
  const taskProfile = classifyTask(task);
  const plan = await planAgents(rootDir, taskProfile, systemConfig);
  const memoryPolicy = await evaluateMemoryPolicy(rootDir, taskProfile, systemConfig);
  return {
    rootDir,
    mode: "plan",
    memoryPolicy,
    ...plan
  };
}

async function runContext(task, budget) {
  const notes = await loadNotes(rootDir);
  return {
    rootDir,
    mode: "context",
    contextBundle: assembleContext(task, notes, {
      tokenBudget: budget,
      maxNotes: systemConfig.retrieval?.maxNotesPerBundle ?? 6
    })
  };
}

async function runPolicy(task) {
  const taskProfile = classifyTask(task);
  return {
    rootDir,
    mode: "policy",
    taskProfile,
    memoryPolicy: await evaluateMemoryPolicy(rootDir, taskProfile, systemConfig)
  };
}

async function runSync(args) {
  // We re-run task classification here because sync is the point where
  // we decide whether memory maintenance stays local or escalates into
  // a queued reasoning job for later.
  const taskProfile = classifyTask(args.task);
  const memoryPolicy = await evaluateMemoryPolicy(rootDir, taskProfile, systemConfig);
  const syncResult = await syncMemory(
    rootDir,
    {
      task: args.task,
      summary: args.summary ?? "No explicit summary provided.",
      artifacts: splitCsv(args.artifacts)
    },
    systemConfig
  );
  const policyOutcome = await applyMemoryPolicyOutcome(rootDir, memoryPolicy, taskProfile, syncResult, systemConfig);

  return {
    rootDir,
    mode: "sync",
    taskProfile,
    memoryPolicy,
    sync: syncResult,
    policyOutcome
  };
}

async function runQueue() {
  return {
    rootDir,
    mode: "queue",
    queue: await inspectReviewQueue(rootDir)
  };
}

async function runStatus() {
  return {
    rootDir,
    mode: "status",
    status: await getRuntimeStatus(rootDir, systemConfig)
  };
}

async function runDoctor() {
  return {
    rootDir,
    mode: "doctor",
    doctor: await runRuntimeDoctor(rootDir, systemConfig)
  };
}

async function runReport() {
  if (args.format === "html") {
    const html = await writeRuntimeReportHtml(rootDir, systemConfig, args.output ? path.resolve(args.output) : null);
    return {
      rootDir,
      mode: "report",
      format: "html",
      outputPath: html.outputPath,
      report: html.report
    };
  }
  return {
    rootDir,
    mode: "report",
    report: await buildRuntimeReport(rootDir, systemConfig)
  };
}

async function runBenchmark(args = {}) {
  const iterations = Math.max(1, Number(args.iterations) || 1);
  const suite = args.suite ?? "mixed";
  return {
    rootDir,
    mode: "benchmark",
    benchmark: iterations > 1
      ? await runSyntheticBenchmarkCycle(rootDir, {
        iterations,
        autoTuneBetweenRuns: args.autoTuneBetweenRuns === true,
        suite
      })
      : await runSyntheticBenchmark(rootDir, systemConfig, { suite })
  };
}

async function runMetrics() {
  return {
    rootDir,
    mode: "metrics",
    metrics: await summarizeReviewMetrics(rootDir)
  };
}

async function runTune(args) {
  return {
    rootDir,
    mode: "tune",
    tuning: args.auto
      ? await runAutoPolicyTuning(rootDir, { phase: args.phase })
      : (args.reconcile
        ? await reconcileAutoPolicyTuning(rootDir, { phase: args.phase })
      : (args.apply
        ? await applyPolicyTuning(rootDir, { phase: args.phase })
        : await analyzePolicyTuning(rootDir, { phase: args.phase })))
  };
}

async function runTask(args) {
  const reviewConfig = buildRuntimeReviewConfig(systemConfig, args);

  return {
    rootDir,
    mode: "task",
    flow: await runTaskFlow(rootDir, systemConfig, {
      task: args.task,
      summary: args.summary,
      artifacts: splitCsv(args.artifacts),
      budget: args.budget,
      reviewNow: args.reviewNow,
      reviewConfig
    }),
    runtimeReviewConfig: describeRuntimeReviewConfig(reviewConfig)
  };
}

async function runReview(args) {
  const reviewConfig = buildRuntimeReviewConfig(systemConfig, args);

  return {
    rootDir,
    mode: "review",
    result: await processReviewQueue(rootDir, systemConfig, {
      maxJobs: args.maxJobs,
      jobId: args.jobId,
      reviewConfig
    }),
    queue: await inspectReviewQueue(rootDir),
    runtimeReviewConfig: describeRuntimeReviewConfig(reviewConfig)
  };
}

async function runWorker(args) {
  const reviewConfig = buildRuntimeReviewConfig(systemConfig, args);

  return {
    rootDir,
    mode: "worker",
    result: await runReviewWorker(rootDir, reviewConfig, {
      maxJobs: args.maxJobs,
      jobId: args.jobId,
      loop: args.loop,
      intervalSeconds: args.intervalSeconds,
      maxIterations: args.maxIterations,
      stopWhenEmpty: args.stopWhenEmpty,
      reviewConfig
    }),
    workerState: await getWorkerState(rootDir),
    queue: await inspectReviewQueue(rootDir)
  };
}

async function runApprove(args) {
  if (!args.jobId) {
    output({ error: "Missing required flag --jobId" }, false);
    process.exitCode = 1;
    process.exit();
  }

  return {
    rootDir,
    mode: "approve",
    result: await approvePendingReview(rootDir, args.jobId, systemConfig),
    queue: await inspectReviewQueue(rootDir)
  };
}

async function runDemo(args) {
  const plan = await runPlan(args.task);
  const context = await runContext(args.task, Number(args.budget) || systemConfig.retrieval?.defaultTokenBudget || 1200);
  const sync = await runSync(args);

  return {
    rootDir,
    mode: "demo",
    plan,
    context,
    sync
  };
}

function parseArgs(argv) {
  // This parser is deliberately minimal because the project only needs
  // flat `--flag value` pairs for local operator commands.
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

async function requireTask(args) {
  if (!args.task) {
    output({ error: "Missing required flag --task" }, false);
    process.exitCode = 1;
    process.exit();
  }
}

function splitCsv(value) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function helpText() {
  return {
    usage: [
      "node src/cli.mjs init",
      "node src/cli.mjs plan --task \"design a token-efficient memory system\"",
      "node src/cli.mjs policy --task \"design a token-efficient memory system\"",
      "node src/cli.mjs context --task \"design a token-efficient memory system\" --budget 900",
      "node src/cli.mjs sync --task \"design a token-efficient memory system\" --summary \"Captured retrieval rules\" --artifacts \"cli,tests,notes\"",
      "node src/cli.mjs task --task \"design a token-efficient memory system\" --summary \"Captured retrieval rules\" --artifacts \"cli,tests,notes\" --reviewNow",
      "node src/cli.mjs task --task \"design a token-efficient memory system\" --summary \"Captured retrieval rules\" --artifacts \"cli,tests,notes\" --reviewNow --live",
      "node src/cli.mjs task --task \"design a token-efficient memory system\" --summary \"Captured retrieval rules\" --reviewNow --live --costMode saver",
      "node src/cli.mjs review --jobId memjob-123 --live --costMode strict --reviewProfile heavy",
      "node src/cli.mjs task --task \"capture auth rollout learnings\" --summary \"Collapsed duplicate auth notes\" --artifacts \"notes,worker\" --reviewNow --live --provider cursor",
      "node src/cli.mjs queue",
      "node src/cli.mjs status",
      "node src/cli.mjs doctor",
      "node src/cli.mjs report",
      "node src/cli.mjs report --format html",
      "node src/cli.mjs report --format html --output ./runtime-report.html",
      "node src/cli.mjs benchmark",
      "node src/cli.mjs benchmark --suite low-risk",
      "node src/cli.mjs benchmark --suite high-risk",
      "node src/cli.mjs benchmark --iterations 5 --autoTuneBetweenRuns",
      "node src/cli.mjs metrics",
      "node src/cli.mjs tune",
      "node src/cli.mjs tune --phase cheap-domains",
      "node src/cli.mjs tune --apply",
      "node src/cli.mjs tune --apply --phase balanced-lane",
      "node src/cli.mjs tune --auto",
      "node src/cli.mjs tune --auto --phase cheap-domains",
      "node src/cli.mjs tune --reconcile",
      "node src/cli.mjs review --maxJobs 1",
      "node src/cli.mjs review --jobId memjob-123 --live",
      "node src/cli.mjs review --jobId memjob-123 --live --model gpt-5.4",
      "node src/cli.mjs review --jobId memjob-123 --live --provider cursor",
      "node src/cli.mjs approve --jobId memjob-123",
      "node src/cli.mjs worker --maxJobs 1",
      "node src/cli.mjs worker --loop --intervalSeconds 30 --stopWhenEmpty",
      "node src/cli.mjs demo --task \"design a token-efficient memory system\" --summary \"Captured retrieval rules\""
    ]
  };
}

function buildRuntimeReviewConfig(baseConfig, args) {
  // CLI review overrides must stay ephemeral.
  // We never mutate system.json here because "run this one job live" should
  // not silently change the repository's default execution policy.
  const config = applyReviewCostMode(baseConfig, {
    costMode: args.costMode,
    reviewProfile: args.reviewProfile
  });
  const execution = config.reviewExecution ?? {};

  if (!args.live) {
    return config;
  }

  const provider = args.provider ?? "codex";

  execution.providerByMode = {
    ...(execution.providerByMode ?? {}),
    balanced: provider,
    expensive: provider
  };
  execution.nativeCodex = {
    ...(execution.nativeCodex ?? {}),
    enabled: false
  };
  execution.nativeCursor = {
    ...(execution.nativeCursor ?? {}),
    enabled: false
  };

  if (provider === "codex") {
    execution.nativeCodex.enabled = true;
    if (args.model) {
      execution.nativeCodex.model = args.model;
    }
  }

  if (provider === "cursor") {
    execution.nativeCursor.enabled = true;
    if (args.model) {
      execution.nativeCursor.model = args.model;
    }
  }

  config.reviewExecution = execution;
  return config;
}

function describeRuntimeReviewConfig(config) {
  // This is only for visibility in CLI output.
  // It helps operators confirm which effective runtime overrides were used
  // without digging through the merged config by hand.
  return {
    runtimeCostControls: config.runtimeCostControls ?? {
      costMode: "balanced",
      reviewProfile: "auto"
    },
    providerByMode: config.reviewExecution?.providerByMode ?? {},
    nativeCodex: {
      enabled: config.reviewExecution?.nativeCodex?.enabled ?? false,
      binary: config.reviewExecution?.nativeCodex?.binary ?? "codex",
      model: config.reviewExecution?.nativeCodex?.model ?? "",
      maxAttempts: config.reviewExecution?.nativeCodex?.maxAttempts ?? 1,
      retryBackoffMs: config.reviewExecution?.nativeCodex?.retryBackoffMs ?? 0
    },
    nativeCursor: {
      enabled: config.reviewExecution?.nativeCursor?.enabled ?? false,
      binary: config.reviewExecution?.nativeCursor?.binary ?? "cursor",
      model: config.reviewExecution?.nativeCursor?.model ?? "",
      mode: config.reviewExecution?.nativeCursor?.mode ?? "ask",
      sandbox: config.reviewExecution?.nativeCursor?.sandbox ?? "enabled",
      trustWorkspace: config.reviewExecution?.nativeCursor?.trustWorkspace !== false,
      force: config.reviewExecution?.nativeCursor?.force === true,
      maxAttempts: config.reviewExecution?.nativeCursor?.maxAttempts ?? 1,
      retryBackoffMs: config.reviewExecution?.nativeCursor?.retryBackoffMs ?? 0
    },
    reviewProfiles: {
      balanced: {
        promptStyle: config.reviewExecution?.reviewProfiles?.balanced?.promptStyle ?? "light",
        maxOperations: config.reviewExecution?.reviewProfiles?.balanced?.maxOperations ?? 2,
        codexReasoningEffort: config.reviewExecution?.reviewProfiles?.balanced?.codexReasoningEffort ?? "medium"
      },
      expensive: {
        promptStyle: config.reviewExecution?.reviewProfiles?.expensive?.promptStyle ?? "strict",
        maxOperations: config.reviewExecution?.reviewProfiles?.expensive?.maxOperations ?? 3,
        codexReasoningEffort: config.reviewExecution?.reviewProfiles?.expensive?.codexReasoningEffort ?? "high"
      }
    },
    valueGate: {
      enabled: config.reviewExecution?.valueGate?.enabled !== false,
      applyToModes: config.reviewExecution?.valueGate?.applyToModes ?? ["balanced"],
      minScore: config.reviewExecution?.valueGate?.minScore ?? 60
    },
    operationRanking: {
      maxAppliedOperations: config.reviewExecution?.operationRanking?.maxAppliedOperations ?? 2,
      minScore: config.reviewExecution?.operationRanking?.minScore ?? 35
    },
    idempotency: {
      minSimilarityScore: config.reviewExecution?.idempotency?.minSimilarityScore ?? 7,
      rewriteDuplicatesToAppendUpdate: config.reviewExecution?.idempotency?.rewriteDuplicatesToAppendUpdate !== false
    },
    queueCompaction: {
      enabled: config.reviewExecution?.queueCompaction?.enabled !== false,
      maxTasksPerJob: config.reviewExecution?.queueCompaction?.maxTasksPerJob ?? 3,
      mergeWindowMinutes: config.reviewExecution?.queueCompaction?.mergeWindowMinutes ?? 30
    },
    staleJobs: {
      enabled: config.reviewExecution?.staleJobs?.enabled !== false,
      staleAfterMinutes: config.reviewExecution?.staleJobs?.staleAfterMinutes ?? 60,
      maxAgeMinutes: config.reviewExecution?.staleJobs?.maxAgeMinutes ?? 240,
      skipExpired: config.reviewExecution?.staleJobs?.skipExpired !== false
    },
    retention: {
      enabled: config.reviewExecution?.retention?.enabled !== false,
      maxReportFiles: config.reviewExecution?.retention?.maxReportFiles ?? 25,
      maxHistoryEntries: config.reviewExecution?.retention?.maxHistoryEntries ?? 200
    },
    approval: {
      enabled: config.reviewExecution?.approval?.enabled !== false,
      strategy: config.reviewExecution?.approval?.strategy ?? "suggest-only",
      requireForModes: config.reviewExecution?.approval?.requireForModes ?? ["expensive"],
      requireForDomains: config.reviewExecution?.approval?.requireForDomains ?? ["security"],
      pendingApprovalTtlMinutes: config.reviewExecution?.approval?.pendingApprovalTtlMinutes ?? 240,
      onExpired: config.reviewExecution?.approval?.onExpired === "expire" ? "expire" : "requeue"
    },
    recovery: {
      enabled: config.reviewExecution?.recovery?.enabled !== false,
      strategy: config.reviewExecution?.recovery?.strategy ?? "rollback-and-requeue",
      keepBackups: config.reviewExecution?.recovery?.keepBackups === true
    },
    runtimeLock: {
      enabled: config.reviewExecution?.runtimeLock?.enabled !== false,
      maxAgeMinutes: config.reviewExecution?.runtimeLock?.maxAgeMinutes ?? 15
    }
  };
}

function output(value, pretty = true) {
  const payload = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  console.log(payload);
}
