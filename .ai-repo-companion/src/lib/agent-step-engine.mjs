import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getAgentContract, validateAgentContractInput, validateAgentContractOutput } from "./agent-contract-engine.mjs";

export async function executeAgentStep(rootDir, config, payload = {}) {
  const agent = payload.agent ?? {};
  const contract = getAgentContract(agent);
  const input = {
    task: payload.task ?? "",
    summary: payload.summary ?? "",
    taskProfile: payload.taskProfile ?? null,
    phase: payload.phase ?? "unspecified",
    handoff: payload.handoff ?? null,
    artifacts: payload.artifacts ?? [],
    contextBundle: payload.contextBundle ?? null,
    attempt: Number(payload.attempt) || 1
  };

  const inputValidation = validateAgentContractInput(contract, input);
  if (!inputValidation.ok) {
    throw new Error(inputValidation.reason);
  }

  const adapterConfig = resolveAgentAdapterConfig(config.multiAgentRuntime ?? {});
  const execution = adapterConfig.adapter === "codex-native"
    ? await executeNativeCodexAgentAdapter(rootDir, agent, input, contract, adapterConfig.nativeCodex)
    : buildLocalAgentExecution(agent, input, contract);
  const outputValidation = validateAgentContractOutput(contract, execution.output);
  if (!outputValidation.ok) {
    throw new Error(outputValidation.reason);
  }

  return {
    provider: execution.provider ?? agent.provider ?? "local",
    modelAlias: execution.modelAlias ?? agent.modelAlias ?? "local",
    adapter: execution.adapter,
    contract,
    input,
    output: execution.output,
    attempts: execution.attempts ?? [],
    usage: execution.usage ?? { totalTokens: null, durationMs: 0 },
    raw: execution.raw ?? "",
    inputValidation,
    outputValidation
  };
}

function resolveAgentAdapterConfig(runtimeConfig) {
  return {
    adapter: runtimeConfig.defaultAdapter ?? "local-contract",
    nativeCodex: runtimeConfig.nativeCodex ?? {}
  };
}

function buildLocalAgentExecution(agent, input, contract) {
  return {
    provider: agent.provider ?? "local",
    modelAlias: agent.modelAlias ?? "local",
    adapter: "local-contract",
    output: runLocalContractAdapter(agent, input, contract),
    attempts: [],
    usage: {
      totalTokens: null,
      durationMs: 0
    }
  };
}

async function executeNativeCodexAgentAdapter(rootDir, agent, input, contract, nativeCodex) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-agent-codex-"));
  const schemaPath = path.join(tempDir, "agent-output-schema.json");
  const outputPath = path.join(tempDir, "agent-output.json");
  const schema = buildCodexAgentOutputSchema(contract);
  const prompt = buildCodexAgentPrompt(agent, input, contract);

  await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");

  const args = [
    "exec",
    "-C",
    rootDir,
    "--skip-git-repo-check",
    "--sandbox",
    nativeCodex.sandbox ?? "workspace-write",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-"
  ];

  if (nativeCodex.model) {
    args.splice(1, 0, "--model", nativeCodex.model);
  }
  const reasoningEffort = mapAgentEffortToCodexReasoning(agent.effort ?? input.taskProfile?.effort ?? "medium");
  if (reasoningEffort) {
    args.splice(1, 0, "-c", `model_reasoning_effort="${reasoningEffort}"`);
  }
  if (Array.isArray(nativeCodex.extraArgs) && nativeCodex.extraArgs.length > 0) {
    args.splice(args.length - 1, 0, ...nativeCodex.extraArgs);
  }

  const retryConfig = {
    maxAttempts: Math.max(1, Number(nativeCodex.maxAttempts) || 2),
    retryBackoffMs: Math.max(0, Number(nativeCodex.retryBackoffMs) || 1500)
  };
  const attempts = [];
  let raw = "";
  let parsed = null;
  let lastResult = null;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt += 1) {
    const result = await runCommand(nativeCodex.binary ?? "codex", args, prompt, rootDir);
    lastResult = result;
    const attemptRecord = {
      attempt,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.code,
      durationMs: result.durationMs
    };

    if (result.code === 0) {
      try {
        raw = await fs.readFile(outputPath, "utf8");
        parsed = JSON.parse(raw);
        attempts.push({
          ...attemptRecord,
          status: "completed"
        });
        break;
      } catch (error) {
        attempts.push({
          ...attemptRecord,
          status: "failed",
          parseError: error.message
        });
      }
    } else {
      attempts.push({
        ...attemptRecord,
        status: "failed"
      });
    }

    if (attempt < retryConfig.maxAttempts) {
      await sleep(retryConfig.retryBackoffMs * attempt);
    }
  }

  if (!parsed) {
    throw new Error([
      `Codex agent step failed for ${agent.id}.`,
      lastResult?.stderr?.trim?.() ?? "",
      lastResult?.stdout?.trim?.() ?? ""
    ].filter(Boolean).join(" "));
  }

  return {
    provider: "codex",
    modelAlias: agent.modelAlias ?? "builder",
    adapter: "codex-native",
    output: parsed,
    attempts,
    usage: summarizeAttemptUsage(attempts),
    raw
  };
}

function runLocalContractAdapter(agent, input, contract) {
  switch (agent.role) {
    case "routing":
      return buildRoutingOutput(agent, input);
    case "planning":
      return buildPlanningOutput(agent, input);
    case "architecture":
      return buildArchitectureOutput(agent, input);
    case "verification":
      return buildVerificationOutput(agent, input);
    case "documentation":
      return buildDocumentationOutput(agent, input);
    case "memory":
      return buildMemoryOutput(agent, input);
    case "security":
      return buildSecurityOutput(agent, input);
    case "migration":
      return buildMigrationOutput(agent, input);
    case "data":
      return buildDataOutput(agent, input);
    case "performance":
      return buildPerformanceOutput(agent, input);
    case "implementation":
    default:
      return buildImplementationOutput(agent, input, contract);
  }
}

function buildRoutingOutput(agent, input) {
  const signals = summarizeTaskSignals(input);
  const artifactKind = input.phase === "consolidation" ? "final-decision" : "task-brief";
  const summary = input.phase === "consolidation"
    ? `Consolidated the ${signals.risk} risk run and prepared the final decision.`
    : `Mapped the task into an executable ${signals.risk} risk multi-agent flow.`;
  const artifact = {
    kind: artifactKind,
    title: input.phase === "consolidation" ? "Final decision" : "Task brief",
    summary,
    content: [
      `Task: ${input.task}`,
      `Intents: ${(input.taskProfile?.intents ?? []).join(", ") || "implementation"}`,
      `Risk: ${signals.risk}`,
      `Effort: ${signals.effort}`,
      `Complexity: ${signals.complexity}`,
      input.phase === "consolidation"
        ? `Captured ${input.artifacts.length} upstream artifacts before memory sync.`
        : `Prepared the initial handoff for downstream specialists.`
    ].join("\n")
  };

  return {
    summary,
    artifacts: [artifact],
    handoffs: [],
    consultations: [],
    verdict: {
      status: "info",
      summary: input.phase === "consolidation"
        ? "Run is ready for finalization."
        : "Task was triaged into an execution graph.",
      findings: []
    }
  };
}

function buildPlanningOutput(agent, input) {
  const signals = summarizeTaskSignals(input);
  const criteria = [
    "Keep scope bounded to the requested change.",
    signals.risk !== "low" ? "Define rollback and validation gates before completion." : "Keep the change small and easy to verify.",
    signals.needsDocs ? "Capture repo-facing operator notes or handoff guidance." : "Avoid unrelated documentation churn."
  ];
  if (signals.needsMigration) {
    criteria.push("Sequence rollout, compatibility, and backfill work explicitly.");
  }

  return {
    summary: "Clarified scope and acceptance criteria for the task.",
    artifacts: [
      {
        kind: "acceptance-criteria",
        title: "Acceptance criteria",
        summary: "Defined the minimum acceptable outcome for the run.",
        content: criteria.map((item) => `- ${item}`).join("\n")
      }
    ],
    handoffs: [],
    consultations: [],
    verdict: {
      status: "info",
      summary: "Planning artifacts are ready for downstream execution.",
      findings: []
    }
  };
}

function buildArchitectureOutput(agent, input) {
  const signals = summarizeTaskSignals(input);
  const designLines = [
    "- Keep boundaries explicit between orchestration, verification, and note apply.",
    signals.needsMigration
      ? "- Preserve compatibility during rollout instead of assuming a single cutover."
      : "- Prefer the existing repo patterns over new abstractions.",
    signals.risk !== "low"
      ? "- Separate risky approval-gated work from cheap local bookkeeping."
      : "- Keep the implementation path light and observable."
  ];

  return {
    summary: "Outlined the design and boundary constraints for the task.",
    artifacts: [
      {
        kind: "design-note",
        title: "Design note",
        summary: "Captured the main design constraints for the requested task.",
        content: designLines.join("\n")
      }
    ],
    handoffs: [],
    consultations: [],
    verdict: {
      status: "info",
      summary: "Design guidance is ready for implementation and verification.",
      findings: []
    }
  };
}

function buildImplementationOutput(agent, input) {
  const signals = summarizeTaskSignals(input);
  const retryFindings = normalizeRetryFindings(input);
  const isRetry = input.attempt > 1 || retryFindings.length > 0;
  const actions = [
    "- Make the smallest change that satisfies the scoped request.",
    signals.needsDocs ? "- Update the user-facing wording and handoff notes." : "- Keep repo-facing docs stable unless the change requires them.",
    signals.needsVerification ? "- Add or update verification coverage around the affected flow." : "- Keep validation proportionate to the change."
  ];

  if (signals.risk === "high") {
    if (isRetry) {
      actions.push("- Add an explicit rollback path and approval gate for the risky part.");
      actions.push("- Record the verification checkpoints needed before and after rollout.");
    } else {
      actions.push("- Stage the rollout carefully and monitor the first release wave.");
    }
  }

  if (retryFindings.length > 0) {
    actions.push(...retryFindings.map((finding) => `- Addressed finding: ${finding}`));
  }

  return {
    summary: isRetry
      ? "Reworked the implementation plan to satisfy verifier findings."
      : "Prepared the implementation slice for the requested task.",
    artifacts: [
      {
        kind: isRetry ? "rework-response" : "change-plan",
        title: isRetry ? "Rework response" : "Change plan",
        summary: isRetry
          ? "Updated the planned change after verifier feedback."
          : "Outlined the concrete implementation work for the task.",
        content: actions.join("\n")
      }
    ],
    handoffs: [],
    consultations: [],
    verdict: {
      status: "info",
      summary: isRetry ? "Implementation was revised for another verification pass." : "Implementation is ready for verification.",
      findings: []
    }
  };
}

function buildVerificationOutput(agent, input) {
  const aggregate = buildArtifactText(input.artifacts);
  const signals = summarizeTaskSignals(input);
  const findings = [];

  if (!aggregate) {
    findings.push("No upstream artifacts were provided for verification.");
  }
  if (signals.needsVerification && !/\b(test|verify|validation|check|monitor)\b/i.test(aggregate)) {
    findings.push("No explicit verification or monitoring plan is recorded.");
  }
  if (signals.risk === "high" && !/\b(rollback|approval|backfill|compatibility)\b/i.test(aggregate)) {
    findings.push("Risky work is missing rollback, approval, or compatibility guidance.");
  }

  return {
    summary: findings.length > 0
      ? "Verification found issues that should be reworked."
      : "Verification checks are satisfied.",
    artifacts: [
      {
        kind: "verification-report",
        title: "Verification report",
        summary: findings.length > 0
          ? "Captured the main execution gaps."
          : "Confirmed that execution artifacts cover the requested checks.",
        content: findings.length > 0
          ? findings.map((item) => `- ${item}`).join("\n")
          : "- Verification, rollout, and monitoring guidance look sufficient for this task."
      }
    ],
    handoffs: [],
    consultations: [],
    verdict: {
      status: findings.length > 0 ? "needs-rework" : "pass",
      summary: findings.length > 0
        ? "Execution should return to the owner for one bounded rework."
        : "Execution passed verification.",
      findings
    }
  };
}

function buildDocumentationOutput(agent, input) {
  const signals = summarizeTaskSignals(input);
  const retryFindings = normalizeRetryFindings(input);
  const isRetry = input.attempt > 1 || retryFindings.length > 0;
  const lines = [
    "- Keep wording concise and repo-facing.",
    "- Prefer direct operator guidance over feature narration.",
    signals.needsVerification
      ? "- Mention how the change should be checked after rollout."
      : "- Avoid procedural noise."
  ];

  if (signals.risk === "high") {
    lines.push(isRetry
      ? "- Add explicit approval and rollback instructions for operators."
      : "- Note the risky surface and expected owner handoff.");
  }
  if (retryFindings.length > 0) {
    lines.push(...retryFindings.map((finding) => `- Addressed finding: ${finding}`));
  }

  return {
    summary: isRetry
      ? "Reworked the docs and handoff guidance after verifier feedback."
      : "Prepared repo-facing docs and handoff guidance.",
    artifacts: [
      {
        kind: "handoff-note",
        title: "Handoff note",
        summary: "Prepared the operator-facing explanation of the change.",
        content: lines.join("\n")
      }
    ],
    handoffs: [],
    consultations: [],
    verdict: {
      status: "info",
      summary: "Documentation artifacts are ready for consolidation.",
      findings: []
    }
  };
}

function buildMemoryOutput(agent, input) {
  const aggregate = buildArtifactText(input.artifacts);
  const verdicts = (input.artifacts ?? []).filter((artifact) => artifact.kind === "verdict-summary");
  const summary = aggregate
    ? `Captured ${input.artifacts.length} execution artifacts and ${verdicts.length} verdict snapshots for durable memory.`
    : "No durable execution artifacts were produced.";

  return {
    summary,
    artifacts: [
      {
        kind: "sync-brief",
        title: "Memory sync brief",
        summary,
        content: aggregate
          ? aggregate.split("\n").slice(0, 8).join("\n")
          : "- No execution artifacts were available for memory sync."
      }
    ],
    handoffs: [],
    consultations: [],
    verdict: {
      status: "info",
      summary: "Memory sync brief is ready for the existing note pipeline.",
      findings: []
    }
  };
}

function buildSecurityOutput(agent, input) {
  const aggregate = buildArtifactText(input.artifacts);
  const signals = summarizeTaskSignals(input);
  const findings = [];

  if (signals.risk === "high") {
    if (!/\b(approval|permission|security|guard|rollback)\b/i.test(aggregate)) {
      findings.push("Sensitive work is missing an explicit approval, guard, or rollback path.");
    }
    if (signals.needsMigration && !/\b(backfill|compatibility|rollout)\b/i.test(aggregate)) {
      findings.push("Migration work is missing rollout or compatibility safeguards.");
    }
  }

  return {
    summary: findings.length > 0
      ? "Security review found missing safeguards."
      : "Security review did not find blocking issues.",
    artifacts: [
      {
        kind: "security-review",
        title: "Security review",
        summary: findings.length > 0
          ? "Captured the missing risky-work safeguards."
          : "Confirmed that risky-work safeguards are present.",
        content: findings.length > 0
          ? findings.map((item) => `- ${item}`).join("\n")
          : "- Sensitive surfaces have the expected approval and rollback guardrails."
      }
    ],
    handoffs: [],
    consultations: [],
    verdict: {
      status: findings.length > 0 ? "needs-rework" : "pass",
      summary: findings.length > 0
        ? "Security review requests one bounded rework."
        : "Security review passed.",
      findings
    }
  };
}

function buildMigrationOutput(agent, input) {
  const retryFindings = normalizeRetryFindings(input);
  const isRetry = input.attempt > 1 || retryFindings.length > 0;
  const lines = [
    "- Sequence rollout in stages instead of a single cutover.",
    "- Keep compatibility for the transition window.",
    isRetry
      ? "- Include explicit rollback, backfill completion, and approval checkpoints."
      : "- Track rollout progress and watch the first release window."
  ];
  if (retryFindings.length > 0) {
    lines.push(...retryFindings.map((finding) => `- Addressed finding: ${finding}`));
  }

  return {
    summary: isRetry
      ? "Reworked the migration plan to include the requested safeguards."
      : "Prepared the staged migration and rollout plan.",
    artifacts: [
      {
        kind: "migration-plan",
        title: "Migration plan",
        summary: "Outlined rollout, compatibility, and operational steps for the change.",
        content: lines.join("\n")
      }
    ],
    handoffs: [],
    consultations: [],
    verdict: {
      status: "info",
      summary: "Migration guidance is ready for verification.",
      findings: []
    }
  };
}

function buildDataOutput(agent, input) {
  return {
    summary: "Reviewed data and schema considerations for the task.",
    artifacts: [
      {
        kind: "data-review",
        title: "Data review",
        summary: "Captured schema and consistency considerations.",
        content: [
          "- Keep data shape changes explicit and reversible.",
          "- Record any backfill or compatibility requirements before rollout."
        ].join("\n")
      }
    ],
    handoffs: [],
    consultations: [],
    verdict: {
      status: "info",
      summary: "Data review is available for downstream phases.",
      findings: []
    }
  };
}

function buildPerformanceOutput(agent, input) {
  const aggregate = buildArtifactText(input.artifacts);
  const findings = /\b(cache|batch|limit|latency|perf|performance)\b/i.test(aggregate)
    ? []
    : ["No explicit performance consideration is recorded for this task."];

  return {
    summary: findings.length > 0
      ? "Performance review found a missing consideration."
      : "Performance review is satisfied.",
    artifacts: [
      {
        kind: "performance-review",
        title: "Performance review",
        summary: findings.length > 0
          ? "Captured the missing efficiency consideration."
          : "Confirmed that performance considerations are present.",
        content: findings.length > 0
          ? findings.map((item) => `- ${item}`).join("\n")
          : "- Performance and efficiency considerations are present where expected."
      }
    ],
    handoffs: [],
    consultations: [],
    verdict: {
      status: findings.length > 0 ? "needs-rework" : "pass",
      summary: findings.length > 0 ? "Performance review requests a follow-up." : "Performance review passed.",
      findings
    }
  };
}

function summarizeTaskSignals(input) {
  const tokens = input.taskProfile?.tokens ?? [];
  const tokenSet = new Set(tokens);
  return {
    risk: input.taskProfile?.risk ?? "low",
    effort: input.taskProfile?.effort ?? "low",
    complexity: input.taskProfile?.complexity ?? 1,
    needsMigration: tokenSet.has("migration") || tokenSet.has("migrate") || tokenSet.has("rollout") || tokenSet.has("backfill"),
    needsDocs: (input.taskProfile?.intents ?? []).includes("documentation") || /\b(readme|guide|docs|handoff)\b/i.test(input.task),
    needsVerification: (input.taskProfile?.intents ?? []).includes("verification") || input.taskProfile?.risk !== "low"
  };
}

function normalizeRetryFindings(input) {
  if (!input?.handoff) {
    return [];
  }
  return Array.isArray(input.handoff.findings)
    ? input.handoff.findings.filter(Boolean)
    : [];
}

function buildArtifactText(artifacts) {
  return (artifacts ?? [])
    .map((artifact) => [artifact.title, artifact.summary, artifact.content].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n");
}

function buildCodexAgentPrompt(agent, input, contract) {
  const artifactLines = (input.artifacts ?? [])
    .slice(-8)
    .map((artifact) => `- ${artifact.kind} | ${artifact.title} | ${artifact.summary}`);
  const handoffLines = input.handoff
    ? [
      `From: ${input.handoff.fromAgentId ?? "unknown"}`,
      `Reason: ${input.handoff.reason ?? "n/a"}`,
      `Brief: ${input.handoff.brief ?? "n/a"}`,
      ...(Array.isArray(input.handoff.findings) && input.handoff.findings.length > 0
        ? ["Findings:", ...input.handoff.findings.map((item) => `- ${item}`)]
        : [])
    ]
    : ["No explicit handoff was provided."];

  return [
    "You are executing one step in a repository multi-agent runtime.",
    "Return only structured JSON that matches the provided schema.",
    `Agent: ${agent.name} (${agent.role})`,
    `Phase: ${input.phase}`,
    `Task: ${input.task}`,
    `Task summary: ${input.summary || "No explicit summary."}`,
    `Risk: ${input.taskProfile?.risk ?? "low"}`,
    `Effort: ${input.taskProfile?.effort ?? "low"}`,
    `Intents: ${(input.taskProfile?.intents ?? []).join(", ") || "implementation"}`,
    `Attempt: ${input.attempt}`,
    "",
    "Allowed actions:",
    ...(contract.allowedActions ?? []).map((item) => `- ${item}`),
    "",
    "Success criteria:",
    ...(contract.successCriteria ?? []).map((item) => `- ${item}`),
    "",
    "Handoff:",
    ...handoffLines,
    "",
    "Recent upstream artifacts:",
    ...(artifactLines.length > 0 ? artifactLines : ["- No upstream artifacts yet."]),
    "",
    "Output rules:",
    "- Keep artifacts concise and operational.",
    "- Use verdict status pass only when the phase is genuinely satisfied.",
    "- Use needs-rework only when the next owner can fix the issue in one bounded retry.",
    "- Use blocked only when the run cannot proceed safely.",
    "- Keep consultations and handoffs small and explicit."
  ].join("\n");
}

function buildCodexAgentOutputSchema(contract) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "artifacts", "handoffs", "consultations", "verdict"],
    properties: {
      summary: { type: "string" },
      artifacts: {
        type: "array",
        maxItems: Math.max(1, (contract.defaultArtifactKinds ?? []).length || 2),
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "title", "summary", "content", "data"],
          properties: {
            kind: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            content: { type: "string" },
            data: {
              type: "object",
              additionalProperties: false,
              properties: {}
            }
          }
        }
      },
      handoffs: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["to", "reason", "brief"],
          properties: {
            to: { type: "string" },
            reason: { type: "string" },
            brief: { type: "string" }
          }
        }
      },
      consultations: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["to", "question", "reason"],
          properties: {
            to: { type: "string" },
            question: { type: "string" },
            reason: { type: "string" }
          }
        }
      },
      verdict: {
        type: "object",
        additionalProperties: false,
        required: ["status", "summary", "findings"],
        properties: {
          status: {
            type: "string",
            enum: ["pass", "needs-rework", "blocked", "info"]
          },
          summary: { type: "string" },
          findings: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    }
  };
}

function mapAgentEffortToCodexReasoning(effort) {
  if (effort === "high") {
    return "high";
  }
  if (effort === "low") {
    return "low";
  }
  return "medium";
}

function runCommand(command, args, stdinBody, cwd) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      });
    });

    child.stdin.write(stdinBody);
    child.stdin.end();
  });
}

function summarizeAttemptUsage(attempts) {
  const totalTokens = attempts.reduce((sum, attempt) => sum + (extractTokenUsageFromText(attempt.stdout) ?? 0) + (extractTokenUsageFromText(attempt.stderr) ?? 0), 0);
  const durationMs = attempts.reduce((sum, attempt) => sum + (Number(attempt.durationMs) || 0), 0);
  return {
    totalTokens: totalTokens > 0 ? totalTokens : null,
    durationMs
  };
}

function extractTokenUsageFromText(text) {
  if (!text) {
    return null;
  }
  const match = text.match(/tokens used\s+([\d,]+)/i);
  return match ? Number(match[1].replaceAll(",", "")) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
