import { executeAgentStep } from "./agent-step-engine.mjs";
import {
  completeAgentRun,
  readTaskRun,
  recordRunArtifact,
  recordRunHandoff,
  recordRunRetryRequest,
  recordRunVerdict,
  startAgentRun,
  updateTaskRun
} from "./run-engine.mjs";

export async function runOrchestratedTask(rootDir, config, payload = {}) {
  const runId = payload.runId;
  const rollout = normalizeRuntimeConfig(config.multiAgentRuntime ?? {});
  const phaseGraph = buildPhaseGraph(payload.plan?.agents ?? [], payload.taskProfile ?? {});

  await updateTaskRun(rootDir, runId, {
    phaseGraph,
    multiAgent: {
      enabled: true,
      rolloutMode: rollout.rolloutMode,
      status: rollout.rolloutMode === "shadow" ? "shadowed" : "running",
      currentPhase: phaseGraph[0]?.id ?? "triage"
    }
  }, {
    stage: "multi-agent-planned",
    note: "Prepared the executable multi-agent phase graph."
  });

  if (rollout.rolloutMode === "shadow") {
    const run = await updateTaskRun(rootDir, runId, {
      multiAgent: {
        status: "shadowed",
        finalVerdict: {
          status: "info",
          summary: "Run stayed in shadow mode, so no agents were executed."
        }
      }
    }, {
      stage: "multi-agent-shadowed",
      note: "Skipped execution because the runtime is in shadow mode."
    });
    return {
      enabled: true,
      rolloutMode: rollout.rolloutMode,
      status: "shadowed",
      phaseGraph,
      run
    };
  }

  const state = {
    latestPhaseArtifacts: [],
    allArtifacts: [],
    allVerdicts: [],
    retryCountByPhase: {},
    ownerPhaseByVerifier: {}
  };

  for (const phase of phaseGraph) {
    await updateTaskRun(rootDir, runId, {
      multiAgent: {
        currentPhase: phase.id,
        status: "running"
      }
    }, {
      stage: `multi-agent:${phase.id}`,
      note: `Executing phase ${phase.id}.`
    });

    const phaseResult = await executePhase(rootDir, config, payload, phase, state, rollout);
    state.latestPhaseArtifacts = phaseResult.phaseArtifacts;
    state.allArtifacts.push(...phaseResult.phaseArtifacts);
    state.allVerdicts.push(...phaseResult.verdicts);

    if (phase.id === "verification") {
      const unresolved = phaseResult.verdicts.filter((item) => item.status === "needs-rework" || item.status === "blocked");
      if (unresolved.some((item) => item.status === "blocked")) {
        break;
      }

      if (unresolved.length > 0) {
        const reworkResult = await runBoundedRework(rootDir, config, payload, phaseGraph, phase, state, unresolved, rollout);
        state.latestPhaseArtifacts = reworkResult.phaseArtifacts;
        state.allArtifacts.push(...reworkResult.phaseArtifacts);
        state.allVerdicts.push(...reworkResult.verdicts);
        if (reworkResult.blocked) {
          break;
        }
      }
    }
  }

  const run = await readTaskRun(rootDir, runId);
  const finalVerdict = chooseFinalVerdict(run?.verdicts ?? []);
  const finalRun = await updateTaskRun(rootDir, runId, {
    multiAgent: {
      status: finalVerdict.status === "blocked" ? "blocked" : "completed",
      currentPhase: "completed",
      finalVerdict
    }
  }, {
    stage: "multi-agent-completed",
    note: "Completed multi-agent execution."
  });

  const memoryCapture = finalRun.artifacts.find((artifact) => artifact.kind === "sync-brief") ?? null;
  return {
    enabled: true,
    rolloutMode: rollout.rolloutMode,
    status: finalRun.multiAgent?.status ?? "completed",
    phaseGraph,
    finalVerdict,
    memoryCapture,
    run: finalRun
  };
}

function buildPhaseGraph(agents, taskProfile) {
  const phases = [
    buildPhase("triage", agents.filter((agent) => agent.role === "routing")),
    buildPhase("planning", agents.filter((agent) => ["planning", "migration", "data"].includes(agent.role))),
    buildPhase("design", agents.filter((agent) => ["architecture", "performance"].includes(agent.role))),
    buildPhase("delivery", agents.filter((agent) => ["implementation", "documentation", "migration"].includes(agent.role))),
    buildPhase("verification", agents.filter((agent) => ["verification", "security", "performance"].includes(agent.role))),
    buildPhase("consolidation", agents.filter((agent) => agent.role === "routing")),
    buildPhase("memory-capture", agents.filter((agent) => agent.role === "memory"))
  ].filter((phase) => phase.agentIds.length > 0);

  if (!phases.some((phase) => phase.id === "delivery")) {
    const fallbackOwners = agents.filter((agent) => ["planning", "migration", "documentation"].includes(agent.role));
    if (fallbackOwners.length > 0) {
      phases.splice(Math.max(1, phases.findIndex((phase) => phase.id === "verification")), 0, buildPhase("delivery", fallbackOwners));
    }
  }

  return phases.map((phase, index) => ({
    ...phase,
    order: index + 1,
    requiresApproval: phase.id === "verification" && taskProfile.risk === "high"
  }));
}

function buildPhase(id, phaseAgents) {
  return {
    id,
    agentIds: phaseAgents.map((agent) => agent.id)
  };
}

async function executePhase(rootDir, config, payload, phase, state, rollout, options = {}) {
  const runId = payload.runId;
  const run = await readTaskRun(rootDir, runId);
  const agents = phase.agentIds
    .map((id) => payload.plan.agents.find((agent) => agent.id === id))
    .filter(Boolean);
  const phaseArtifacts = [];
  const verdicts = [];

  for (const agent of agents) {
    const handoffRecord = await maybeCreateHandoff(rootDir, runId, phase, agent, state, options);
    const agentRunState = await startAgentRun(rootDir, runId, {
      phase: phase.id,
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      provider: agent.provider,
      modelAlias: agent.modelAlias,
      effort: agent.effort,
      contractId: agent.contractId,
      allowedActions: agent.allowedActions,
      ownership: agent.ownership,
      successCriteria: agent.successCriteria,
      input: {
        task: payload.task,
        taskProfile: payload.taskProfile,
        phase: phase.id,
        handoff: handoffRecord?.handoff ?? null,
        artifactCount: run?.artifacts?.length ?? 0
      }
    });
    const execution = await executeAgentStep(rootDir, config, {
      agent,
      task: payload.task,
      summary: payload.summary,
      taskProfile: payload.taskProfile,
      phase: phase.id,
      handoff: handoffRecord?.handoff ?? null,
      artifacts: state.allArtifacts,
      contextBundle: payload.contextBundle,
      attempt: options.attempt ?? 1
    });

    for (const artifact of execution.output.artifacts) {
      const recorded = await recordRunArtifact(rootDir, runId, {
        phase: phase.id,
        agentRunId: agentRunState.agentRun.id,
        agentId: agent.id,
        kind: artifact.kind,
        title: artifact.title,
        summary: artifact.summary,
        content: artifact.content ?? "",
        data: artifact.data ?? {},
        tags: [phase.id, agent.role]
      });
      phaseArtifacts.push(recorded.artifact);
    }

    for (const consultation of execution.output.consultations) {
      await recordRunHandoff(rootDir, runId, {
        fromAgentId: agent.id,
        toAgentId: consultation.to,
        fromAgentRunId: agentRunState.agentRun.id,
        toPhase: phase.id,
        reason: consultation.reason,
        brief: consultation.question,
        artifactIds: phaseArtifacts.map((item) => item.id),
        consultation: true
      });
    }

    const verdictRecord = await recordRunVerdict(rootDir, runId, {
      phase: phase.id,
      agentId: agent.id,
      agentRunId: agentRunState.agentRun.id,
      status: execution.output.verdict.status,
      summary: execution.output.verdict.summary,
      findings: execution.output.verdict.findings,
      retryable: execution.output.verdict.status === "needs-rework",
      recommendedOwnerAgentId: pickRecommendedOwner(payload.plan.agents, phase.id)
    });
    verdicts.push(verdictRecord.verdict);

    const verdictArtifact = await recordRunArtifact(rootDir, runId, {
      phase: phase.id,
      agentRunId: agentRunState.agentRun.id,
      agentId: agent.id,
      kind: "verdict-summary",
      title: `${agent.name} verdict`,
      summary: execution.output.verdict.summary,
      content: execution.output.verdict.findings.map((item) => `- ${item}`).join("\n")
    });
    phaseArtifacts.push(verdictArtifact.artifact);

    await completeAgentRun(rootDir, runId, agentRunState.agentRun.id, {
      summary: execution.output.summary,
      verdict: execution.output.verdict,
      output: {
        adapter: execution.adapter,
        artifacts: execution.output.artifacts.length,
        verdict: execution.output.verdict.status
      }
    });
  }

  return {
    phaseArtifacts,
    verdicts
  };
}

async function runBoundedRework(rootDir, config, payload, phaseGraph, verificationPhase, state, unresolvedVerdicts, rollout) {
  let lastPhaseArtifacts = [];
  let latestVerdicts = unresolvedVerdicts;
  let blocked = false;

  for (const verdict of unresolvedVerdicts) {
    const attempt = (state.retryCountByPhase[verificationPhase.id] ?? 0) + 1;
    state.retryCountByPhase[verificationPhase.id] = attempt;

    if (attempt > rollout.maxReworkLoops) {
      blocked = true;
      break;
    }

    const ownerPhase = pickOwnerPhase(phaseGraph, verificationPhase.id);
    const ownerAgent = payload.plan.agents.find((agent) => agent.id === verdict.recommendedOwnerAgentId)
      ?? payload.plan.agents.find((agent) => ownerPhase.agentIds.includes(agent.id));
    if (!ownerPhase || !ownerAgent) {
      blocked = true;
      break;
    }
    if (rollout.requireWritableOwnerForRework && !hasWritableOwnership(ownerAgent)) {
      blocked = true;
      break;
    }

    const retryRecord = await recordRunRetryRequest(rootDir, payload.runId, {
      phase: ownerPhase.id,
      requestedByAgentId: verdict.agentId,
      targetAgentId: ownerAgent.id,
      targetPhase: ownerPhase.id,
      reason: verdict.summary,
      findings: verdict.findings,
      attempt
    });

    await recordRunHandoff(rootDir, payload.runId, {
      fromAgentId: verdict.agentId,
      toAgentId: ownerAgent.id,
      toPhase: ownerPhase.id,
      reason: verdict.summary,
      brief: "Return the work to the owner with the attached verifier findings.",
      artifactIds: [],
      consultation: true
    });

    const ownerResult = await executePhase(rootDir, config, payload, {
      ...ownerPhase,
      agentIds: [ownerAgent.id]
    }, state, rollout, {
      attempt,
      retryRequest: retryRecord.retryRequest,
      handoff: {
        findings: verdict.findings,
        reason: verdict.summary
      }
    });
    lastPhaseArtifacts.push(...ownerResult.phaseArtifacts);
    state.allArtifacts.push(...ownerResult.phaseArtifacts);

    const verificationResult = await executePhase(rootDir, config, payload, verificationPhase, state, rollout, {
      attempt
    });
    latestVerdicts = verificationResult.verdicts;
    lastPhaseArtifacts.push(...verificationResult.phaseArtifacts);
    const stillFailing = latestVerdicts.filter((item) => item.status === "needs-rework" || item.status === "blocked");
    if (stillFailing.length === 0) {
      break;
    }
    if (attempt >= rollout.maxReworkLoops) {
      blocked = true;
      break;
    }
  }

  return {
    phaseArtifacts: lastPhaseArtifacts,
    verdicts: latestVerdicts,
    blocked
  };
}

async function maybeCreateHandoff(rootDir, runId, phase, agent, state, options = {}) {
  const sourceArtifacts = state.latestPhaseArtifacts;
  const retryHandoff = options.handoff ?? null;
  const brief = retryHandoff
    ? "Follow the verifier findings and return an updated artifact."
    : sourceArtifacts.length > 0
      ? `Continue from ${sourceArtifacts.length} upstream artifact(s).`
      : "Start from the original task and bounded context.";

  const fromAgentId = retryHandoff?.fromAgentId
    ?? sourceArtifacts.at(-1)?.agentId
    ?? "orchestrator";
  const handoff = {
    fromAgentId,
    toAgentId: agent.id,
    toPhase: phase.id,
    reason: retryHandoff?.reason ?? `Advance the run into ${phase.id}.`,
    brief,
    artifactIds: sourceArtifacts.map((item) => item.id),
    consultation: Boolean(retryHandoff)
  };
  const record = await recordRunHandoff(rootDir, runId, handoff);
  return record;
}

function pickRecommendedOwner(agents, verifierPhaseId) {
  const preferred = agents.find((agent) => hasWritableOwnership(agent) && agent.role === "implementation")
    ?? agents.find((agent) => hasWritableOwnership(agent) && agent.role === "documentation")
    ?? agents.find((agent) => hasWritableOwnership(agent) && agent.role === "migration")
    ?? agents.find((agent) => hasWritableOwnership(agent) && agent.role === "planning")
    ?? agents.find((agent) => hasWritableOwnership(agent));
  return preferred?.id ?? null;
}

function pickOwnerPhase(phaseGraph, verifierPhaseId) {
  const verifierIndex = phaseGraph.findIndex((phase) => phase.id === verifierPhaseId);
  const upstream = phaseGraph.slice(0, verifierIndex).reverse();
  return upstream.find((phase) => phase.id === "delivery")
    ?? upstream.find((phase) => phase.id === "design")
    ?? upstream.find((phase) => phase.id === "planning")
    ?? upstream[0]
    ?? null;
}

function chooseFinalVerdict(verdicts) {
  const latestBlocking = [...verdicts].reverse().find((verdict) => verdict.status === "blocked");
  if (latestBlocking) {
    return latestBlocking;
  }
  const latestRework = [...verdicts].reverse().find((verdict) => verdict.status === "needs-rework");
  if (latestRework) {
    return {
      ...latestRework,
      status: "blocked",
      summary: "Run exhausted bounded rework and still needs attention."
    };
  }
  return [...verdicts].reverse().find((verdict) => verdict.status === "pass")
    ?? {
      status: "info",
      summary: "Run completed without a blocking verifier verdict.",
      findings: []
    };
}

function normalizeRuntimeConfig(config) {
  return {
    enabled: config.enabled !== false,
    rolloutMode: config.rolloutMode ?? "active",
    maxReworkLoops: Math.max(1, Number(config.maxReworkLoops) || 2),
    requireWritableOwnerForRework: config.requireWritableOwnerForRework !== false
  };
}

function hasWritableOwnership(agent) {
  return Array.isArray(agent?.ownership?.writeScopes) && agent.ownership.writeScopes.length > 0;
}
