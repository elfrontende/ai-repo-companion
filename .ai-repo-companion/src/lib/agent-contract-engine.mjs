const baseOutputSchema = {
  required: ["summary", "artifacts", "handoffs", "consultations", "verdict"],
  artifactShape: {
    required: ["kind", "title", "summary"]
  },
  handoffShape: {
    required: ["to", "reason", "brief"]
  },
  consultationShape: {
    required: ["to", "question", "reason"]
  },
  verdictShape: {
    required: ["status", "summary", "findings"]
  }
};

const roleContracts = {
  routing: {
    contractId: "routing-v1",
    allowedActions: ["plan-phases", "create-handoff", "request-retry", "consolidate-run"],
    ownership: {
      writeScopes: [],
      readScopes: ["task", "context", "run-ledger", "artifacts", "verdicts"]
    },
    successCriteria: [
      "Produces a phase plan with explicit owners.",
      "Emits handoffs that downstream agents can execute without reading the whole run.",
      "Closes the run with a final decision or bounded retry request."
    ],
    defaultArtifactKinds: ["task-brief", "phase-plan", "final-decision"]
  },
  planning: {
    contractId: "planning-v1",
    allowedActions: ["define-scope", "set-acceptance-criteria", "prepare-rollout-plan"],
    ownership: {
      writeScopes: ["plans"],
      readScopes: ["task", "context", "artifacts"]
    },
    successCriteria: [
      "Clarifies scope, acceptance criteria, and open questions.",
      "Identifies rollout risks and sequencing for non-trivial tasks."
    ],
    defaultArtifactKinds: ["scope-brief", "acceptance-criteria", "rollout-plan"]
  },
  architecture: {
    contractId: "architecture-v1",
    allowedActions: ["propose-design", "review-boundaries", "consult-on-rework"],
    ownership: {
      writeScopes: ["design"],
      readScopes: ["task", "context", "plans", "artifacts"]
    },
    successCriteria: [
      "Produces a concrete design or boundary recommendation.",
      "Calls out coupling and fallback paths for risky changes."
    ],
    defaultArtifactKinds: ["design-note", "boundary-review"]
  },
  implementation: {
    contractId: "implementation-v1",
    allowedActions: ["propose-change", "revise-change", "prepare-follow-up"],
    ownership: {
      writeScopes: ["code", "docs", "scripts"],
      readScopes: ["task", "context", "plans", "design", "findings"]
    },
    successCriteria: [
      "Produces a concrete implementation or change plan.",
      "Addresses verifier findings within bounded retries."
    ],
    defaultArtifactKinds: ["change-plan", "rework-response"]
  },
  verification: {
    contractId: "verification-v1",
    allowedActions: ["verify", "issue-verdict", "request-rework"],
    ownership: {
      writeScopes: [],
      readScopes: ["task", "context", "plans", "design", "implementation"]
    },
    successCriteria: [
      "Produces a pass or needs-rework verdict.",
      "Explains missing checks, rollback paths, or validation gaps."
    ],
    defaultArtifactKinds: ["verification-report", "test-checklist"]
  },
  documentation: {
    contractId: "documentation-v1",
    allowedActions: ["draft-docs", "review-doc-clarity", "request-doc-follow-up"],
    ownership: {
      writeScopes: ["docs"],
      readScopes: ["task", "context", "plans", "design", "implementation"]
    },
    successCriteria: [
      "Produces concise repo-facing guidance for doc-centric or handoff tasks.",
      "Flags missing operator-facing context when docs are part of the task."
    ],
    defaultArtifactKinds: ["docs-outline", "handoff-note"]
  },
  memory: {
    contractId: "memory-v1",
    allowedActions: ["capture-memory", "prepare-memory-sync", "summarize-run"],
    ownership: {
      writeScopes: ["notes", "working-memory"],
      readScopes: ["run-ledger", "artifacts", "verdicts"]
    },
    successCriteria: [
      "Captures durable run learnings without bloating working memory.",
      "Produces a minimal sync summary for the existing memory pipeline."
    ],
    defaultArtifactKinds: ["memory-capture", "sync-brief"]
  },
  security: {
    contractId: "security-v1",
    allowedActions: ["review-security", "issue-verdict", "request-rework"],
    ownership: {
      writeScopes: [],
      readScopes: ["task", "context", "plans", "design", "implementation"]
    },
    successCriteria: [
      "Checks approval, rollback, and sensitive-surface risks.",
      "Escalates missing controls for risky tasks."
    ],
    defaultArtifactKinds: ["security-review", "security-findings"]
  },
  migration: {
    contractId: "migration-v1",
    allowedActions: ["plan-migration", "review-rollout", "request-rework"],
    ownership: {
      writeScopes: ["plans"],
      readScopes: ["task", "context", "design", "verification"]
    },
    successCriteria: [
      "Produces staged rollout, backfill, compatibility, and rollback guidance.",
      "Raises missing migration safeguards before completion."
    ],
    defaultArtifactKinds: ["migration-plan", "rollout-checklist"]
  },
  data: {
    contractId: "data-v1",
    allowedActions: ["review-data-shape", "prepare-data-follow-up", "consult-on-rework"],
    ownership: {
      writeScopes: ["plans"],
      readScopes: ["task", "context", "design", "implementation"]
    },
    successCriteria: [
      "Identifies schema and backfill considerations.",
      "Calls out data consistency or observability gaps."
    ],
    defaultArtifactKinds: ["data-review", "schema-notes"]
  },
  performance: {
    contractId: "performance-v1",
    allowedActions: ["review-performance", "request-optimization", "issue-verdict"],
    ownership: {
      writeScopes: [],
      readScopes: ["task", "context", "design", "implementation"]
    },
    successCriteria: [
      "Calls out likely latency and efficiency hotspots.",
      "Suggests measurable follow-ups when performance matters."
    ],
    defaultArtifactKinds: ["performance-review", "optimization-notes"]
  }
};

export function getAgentContract(agentOrRole) {
  const role = typeof agentOrRole === "string"
    ? agentOrRole
    : agentOrRole?.role;
  const baseContract = roleContracts[role] ?? roleContracts.implementation;
  return {
    role,
    contractId: baseContract.contractId,
    inputSchema: {
      required: ["task", "taskProfile", "phase", "artifacts", "handoff"]
    },
    outputSchema: baseOutputSchema,
    allowedActions: [...baseContract.allowedActions],
    ownership: {
      writeScopes: [...(baseContract.ownership?.writeScopes ?? [])],
      readScopes: [...(baseContract.ownership?.readScopes ?? [])]
    },
    successCriteria: [...baseContract.successCriteria],
    defaultArtifactKinds: [...baseContract.defaultArtifactKinds]
  };
}

export function attachAgentContract(agent) {
  const contract = getAgentContract(agent);
  return {
    ...agent,
    contractId: contract.contractId,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    allowedActions: contract.allowedActions,
    ownership: contract.ownership,
    successCriteria: contract.successCriteria,
    defaultArtifactKinds: contract.defaultArtifactKinds
  };
}

export function validateAgentContractInput(contract, input) {
  const missing = (contract?.inputSchema?.required ?? []).filter((key) => {
    if (key === "artifacts") {
      return !Array.isArray(input?.artifacts);
    }
    return input?.[key] == null;
  });

  return {
    ok: missing.length === 0,
    missing,
    reason: missing.length === 0
      ? "Agent input satisfies the declared contract."
      : `Agent input is missing required fields: ${missing.join(", ")}.`
  };
}

export function validateAgentContractOutput(contract, output) {
  const schema = contract?.outputSchema ?? baseOutputSchema;
  const missing = schema.required.filter((key) => output?.[key] == null);
  const errors = [];

  if (missing.length > 0) {
    errors.push(`Missing required output fields: ${missing.join(", ")}.`);
  }
  if (!Array.isArray(output?.artifacts)) {
    errors.push("Output artifacts must be an array.");
  }
  if (!Array.isArray(output?.handoffs)) {
    errors.push("Output handoffs must be an array.");
  }
  if (!Array.isArray(output?.consultations)) {
    errors.push("Output consultations must be an array.");
  }
  if (typeof output?.summary !== "string" || output.summary.trim().length === 0) {
    errors.push("Output summary must be a non-empty string.");
  }

  for (const artifact of output?.artifacts ?? []) {
    const missingArtifactKeys = schema.artifactShape.required.filter((key) => !artifact?.[key]);
    if (missingArtifactKeys.length > 0) {
      errors.push(`Artifact is missing required keys: ${missingArtifactKeys.join(", ")}.`);
      break;
    }
  }

  for (const handoff of output?.handoffs ?? []) {
    const missingHandoffKeys = schema.handoffShape.required.filter((key) => !handoff?.[key]);
    if (missingHandoffKeys.length > 0) {
      errors.push(`Handoff is missing required keys: ${missingHandoffKeys.join(", ")}.`);
      break;
    }
  }

  for (const consultation of output?.consultations ?? []) {
    const missingConsultationKeys = schema.consultationShape.required.filter((key) => !consultation?.[key]);
    if (missingConsultationKeys.length > 0) {
      errors.push(`Consultation is missing required keys: ${missingConsultationKeys.join(", ")}.`);
      break;
    }
  }

  const verdict = output?.verdict;
  if (!verdict || typeof verdict !== "object") {
    errors.push("Output verdict must be an object.");
  } else {
    const missingVerdictKeys = schema.verdictShape.required.filter((key) => verdict?.[key] == null);
    if (missingVerdictKeys.length > 0) {
      errors.push(`Verdict is missing required keys: ${missingVerdictKeys.join(", ")}.`);
    }
    if (!["pass", "needs-rework", "blocked", "info"].includes(verdict.status)) {
      errors.push("Verdict status must be one of: pass, needs-rework, blocked, info.");
    }
    if (!Array.isArray(verdict.findings)) {
      errors.push("Verdict findings must be an array.");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    reason: errors[0] ?? "Agent output satisfies the declared contract."
  };
}
