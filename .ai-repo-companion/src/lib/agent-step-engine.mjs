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

  const adapter = config.multiAgentRuntime?.defaultAdapter ?? "local-contract";
  const output = runLocalContractAdapter(agent, input, contract);
  const outputValidation = validateAgentContractOutput(contract, output);
  if (!outputValidation.ok) {
    throw new Error(outputValidation.reason);
  }

  return {
    provider: agent.provider ?? "local",
    modelAlias: agent.modelAlias ?? "local",
    adapter,
    contract,
    input,
    output,
    inputValidation,
    outputValidation
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
