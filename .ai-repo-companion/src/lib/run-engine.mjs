import path from "node:path";
import { appendLine, listFiles, readJson, writeJson } from "./store.mjs";

export async function startTaskRun(rootDir, payload = {}) {
  const timestamp = new Date().toISOString();
  const run = {
    id: createEntityId("run"),
    type: "task-run",
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    failedAt: null,
    currentStage: "started",
    task: payload.task ?? "",
    summary: payload.summary ?? "",
    taskArtifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [],
    taskProfile: payload.taskProfile ?? null,
    plan: null,
    phaseGraph: [],
    multiAgent: {
      enabled: false,
      rolloutMode: null,
      status: "not-started",
      currentPhase: null,
      finalVerdict: null,
      consultationCount: 0,
      reworkCount: 0,
      completedAgentRuns: 0
    },
    contextBundle: null,
    memoryPolicy: null,
    sync: null,
    policyOutcome: null,
    review: null,
    activeAgentRunId: null,
    agentRuns: [],
    artifacts: [],
    handoffs: [],
    verdicts: [],
    retryRequests: [],
    error: null,
    stageHistory: [
      {
        stage: "started",
        at: timestamp,
        status: "running",
        note: "Task run was created."
      }
    ]
  };
  const runPath = getTaskRunPath(rootDir, run.id);
  await writeJson(runPath, run);
  await appendRunHistory(rootDir, run, "started");
  return {
    run,
    runPath
  };
}

export async function updateTaskRun(rootDir, runId, patch = {}, options = {}) {
  const runPath = getTaskRunPath(rootDir, runId);
  const current = await readJson(runPath, null);
  if (!current) {
    throw new Error(`Task run "${runId}" does not exist.`);
  }

  const timestamp = new Date().toISOString();
  const nextStage = options.stage ?? current.currentStage ?? "running";
  const next = {
    ...current,
    ...patch,
    updatedAt: timestamp,
    multiAgent: mergeMultiAgentSummary(current.multiAgent, patch.multiAgent),
    currentStage: nextStage,
    stageHistory: [
      ...(Array.isArray(current.stageHistory) ? current.stageHistory : []),
      {
        stage: nextStage,
        at: timestamp,
        status: patch.status ?? current.status ?? "running",
        note: options.note ?? ""
      }
    ]
  };

  await writeJson(runPath, next);
  await appendRunHistory(rootDir, next, nextStage);
  return next;
}

export async function completeTaskRun(rootDir, runId, patch = {}, options = {}) {
  const runPath = getTaskRunPath(rootDir, runId);
  const current = await readJson(runPath, null);
  if (!current) {
    throw new Error(`Task run "${runId}" does not exist.`);
  }

  const timestamp = new Date().toISOString();
  const finalStage = options.stage ?? "completed";
  const next = {
    ...current,
    ...patch,
    status: "completed",
    updatedAt: timestamp,
    completedAt: timestamp,
    multiAgent: mergeMultiAgentSummary(current.multiAgent, patch.multiAgent),
    currentStage: finalStage,
    stageHistory: [
      ...(Array.isArray(current.stageHistory) ? current.stageHistory : []),
      {
        stage: finalStage,
        at: timestamp,
        status: "completed",
        note: options.note ?? "Task run completed."
      }
    ]
  };

  await writeJson(runPath, next);
  await appendRunHistory(rootDir, next, finalStage);
  return next;
}

export async function failTaskRun(rootDir, runId, error, patch = {}, options = {}) {
  const runPath = getTaskRunPath(rootDir, runId);
  const current = await readJson(runPath, null);
  if (!current) {
    throw new Error(`Task run "${runId}" does not exist.`);
  }

  const timestamp = new Date().toISOString();
  const finalStage = options.stage ?? "failed";
  const next = {
    ...current,
    ...patch,
    status: "failed",
    updatedAt: timestamp,
    failedAt: timestamp,
    multiAgent: mergeMultiAgentSummary(current.multiAgent, patch.multiAgent),
    currentStage: finalStage,
    error: {
      message: error?.message ?? String(error)
    },
    stageHistory: [
      ...(Array.isArray(current.stageHistory) ? current.stageHistory : []),
      {
        stage: finalStage,
        at: timestamp,
        status: "failed",
        note: error?.message ?? String(error)
      }
    ]
  };

  await writeJson(runPath, next);
  await appendRunHistory(rootDir, next, finalStage);
  return next;
}

export async function readTaskRun(rootDir, runId) {
  return readJson(getTaskRunPath(rootDir, runId), null);
}

export async function readLatestTaskRunSummary(rootDir) {
  const files = (await listFiles(path.join(rootDir, "state/runs"), ".json"))
    .filter((filePath) => !filePath.endsWith("history.json"));
  const latestPath = files.at(-1);
  if (!latestPath) {
    return {
      available: false,
      reason: "no-task-runs"
    };
  }

  const run = await readJson(latestPath, null);
  if (!run) {
    return {
      available: false,
      reason: "latest-task-run-missing"
    };
  }

  return {
    available: true,
    id: run.id,
    status: run.status,
    currentStage: run.currentStage,
    task: run.task,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt ?? null,
    failedAt: run.failedAt ?? null,
    reviewStatus: run.review?.status ?? null,
    queuedJobId: run.review?.queuedJobId ?? null,
    activeAgentRunId: run.activeAgentRunId ?? null,
    multiAgentStatus: run.multiAgent?.status ?? "not-started",
    currentPhase: run.multiAgent?.currentPhase ?? run.currentStage,
    finalVerdict: run.multiAgent?.finalVerdict?.status ?? null,
    agentRunCount: Array.isArray(run.agentRuns) ? run.agentRuns.length : 0,
    artifactCount: Array.isArray(run.artifacts) ? run.artifacts.length : 0,
    handoffCount: Array.isArray(run.handoffs) ? run.handoffs.length : 0,
    verdictCount: Array.isArray(run.verdicts) ? run.verdicts.length : 0,
    retryCount: Array.isArray(run.retryRequests) ? run.retryRequests.length : 0,
    runPath: latestPath
  };
}

export async function startAgentRun(rootDir, runId, payload = {}) {
  const timestamp = new Date().toISOString();
  const agentRun = {
    id: createEntityId("agentrun"),
    runId,
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    failedAt: null,
    phase: payload.phase ?? "unspecified",
    agentId: payload.agentId ?? "unknown",
    agentName: payload.agentName ?? payload.agentId ?? "Unknown agent",
    role: payload.role ?? "implementation",
    provider: payload.provider ?? "local",
    modelAlias: payload.modelAlias ?? "local",
    effort: payload.effort ?? "low",
    contractId: payload.contractId ?? null,
    allowedActions: payload.allowedActions ?? [],
    ownership: payload.ownership ?? { writeScopes: [], readScopes: [] },
    successCriteria: payload.successCriteria ?? [],
    input: payload.input ?? {},
    summary: null,
    verdict: null,
    output: null,
    error: null
  };
  const recordPath = getRunEntityPath(rootDir, "agent-runs", runId, agentRun.id);
  await writeJson(recordPath, agentRun);
  await updateRunSummary(rootDir, runId, {
    activeAgentRunId: agentRun.id,
    multiAgent: {
      currentPhase: agentRun.phase
    }
  }, {
    collection: "agentRuns",
    summary: summarizeAgentRun(agentRun)
  });
  await appendRunHistory(rootDir, await readTaskRun(rootDir, runId), `agent:${agentRun.phase}:${agentRun.agentId}`);
  return {
    agentRun,
    recordPath
  };
}

export async function completeAgentRun(rootDir, runId, agentRunId, patch = {}) {
  const recordPath = getRunEntityPath(rootDir, "agent-runs", runId, agentRunId);
  const current = await readJson(recordPath, null);
  if (!current) {
    throw new Error(`Agent run "${agentRunId}" does not exist for run "${runId}".`);
  }
  const timestamp = new Date().toISOString();
  const next = {
    ...current,
    ...patch,
    status: "completed",
    updatedAt: timestamp,
    completedAt: timestamp
  };
  await writeJson(recordPath, next);
  await updateRunSummary(rootDir, runId, {
    activeAgentRunId: null,
    multiAgent: {
      currentPhase: next.phase,
      completedAgentRuns: incrementCounter,
      lastCompletedAgentId: next.agentId
    }
  }, {
    collection: "agentRuns",
    summary: summarizeAgentRun(next)
  });
  await appendRunHistory(rootDir, await readTaskRun(rootDir, runId), `agent-completed:${next.phase}:${next.agentId}`);
  return next;
}

export async function failAgentRun(rootDir, runId, agentRunId, error, patch = {}) {
  const recordPath = getRunEntityPath(rootDir, "agent-runs", runId, agentRunId);
  const current = await readJson(recordPath, null);
  if (!current) {
    throw new Error(`Agent run "${agentRunId}" does not exist for run "${runId}".`);
  }
  const timestamp = new Date().toISOString();
  const next = {
    ...current,
    ...patch,
    status: "failed",
    updatedAt: timestamp,
    failedAt: timestamp,
    error: {
      message: error?.message ?? String(error)
    }
  };
  await writeJson(recordPath, next);
  await updateRunSummary(rootDir, runId, {
    activeAgentRunId: null,
    multiAgent: {
      currentPhase: next.phase,
      lastFailedAgentId: next.agentId
    }
  }, {
    collection: "agentRuns",
    summary: summarizeAgentRun(next)
  });
  await appendRunHistory(rootDir, await readTaskRun(rootDir, runId), `agent-failed:${next.phase}:${next.agentId}`);
  return next;
}

export async function recordRunArtifact(rootDir, runId, payload = {}) {
  const timestamp = new Date().toISOString();
  const artifact = {
    id: createEntityId("artifact"),
    runId,
    createdAt: timestamp,
    phase: payload.phase ?? "unspecified",
    agentRunId: payload.agentRunId ?? null,
    agentId: payload.agentId ?? null,
    kind: payload.kind ?? "note",
    title: payload.title ?? "Untitled artifact",
    summary: payload.summary ?? "",
    content: payload.content ?? "",
    data: payload.data ?? {},
    sourceArtifactIds: payload.sourceArtifactIds ?? [],
    tags: payload.tags ?? []
  };
  const recordPath = getRunEntityPath(rootDir, "artifacts", runId, artifact.id);
  await writeJson(recordPath, artifact);
  await updateRunSummary(rootDir, runId, {}, {
    collection: "artifacts",
    summary: summarizeArtifact(artifact)
  });
  return {
    artifact,
    recordPath
  };
}

export async function recordRunHandoff(rootDir, runId, payload = {}) {
  const timestamp = new Date().toISOString();
  const handoff = {
    id: createEntityId("handoff"),
    runId,
    createdAt: timestamp,
    fromAgentId: payload.fromAgentId ?? "unknown",
    toAgentId: payload.toAgentId ?? "unknown",
    fromAgentRunId: payload.fromAgentRunId ?? null,
    toPhase: payload.toPhase ?? "unspecified",
    reason: payload.reason ?? "",
    brief: payload.brief ?? "",
    artifactIds: payload.artifactIds ?? [],
    consultation: Boolean(payload.consultation),
    status: payload.status ?? "created"
  };
  const recordPath = getRunEntityPath(rootDir, "handoffs", runId, handoff.id);
  await writeJson(recordPath, handoff);
  await updateRunSummary(rootDir, runId, {
    multiAgent: {
      consultationCount: handoff.consultation ? incrementCounter : 0
    }
  }, {
    collection: "handoffs",
    summary: summarizeHandoff(handoff)
  });
  return {
    handoff,
    recordPath
  };
}

export async function updateRunHandoff(rootDir, runId, handoffId, patch = {}) {
  return updateRunCollectionRecord(rootDir, "handoffs", runId, handoffId, patch, summarizeHandoff, "handoffs");
}

export async function recordRunVerdict(rootDir, runId, payload = {}) {
  const timestamp = new Date().toISOString();
  const verdict = {
    id: createEntityId("verdict"),
    runId,
    createdAt: timestamp,
    phase: payload.phase ?? "unspecified",
    agentId: payload.agentId ?? "unknown",
    agentRunId: payload.agentRunId ?? null,
    status: payload.status ?? "info",
    summary: payload.summary ?? "",
    findings: payload.findings ?? [],
    recommendedOwnerAgentId: payload.recommendedOwnerAgentId ?? null,
    retryable: Boolean(payload.retryable)
  };
  const recordPath = getRunEntityPath(rootDir, "verdicts", runId, verdict.id);
  await writeJson(recordPath, verdict);
  await updateRunSummary(rootDir, runId, {
    multiAgent: {
      finalVerdict: verdict.status === "pass" || verdict.status === "blocked" ? verdict : null
    }
  }, {
    collection: "verdicts",
    summary: summarizeVerdict(verdict)
  });
  return {
    verdict,
    recordPath
  };
}

export async function recordRunRetryRequest(rootDir, runId, payload = {}) {
  const timestamp = new Date().toISOString();
  const retryRequest = {
    id: createEntityId("retry"),
    runId,
    createdAt: timestamp,
    phase: payload.phase ?? "unspecified",
    requestedByAgentId: payload.requestedByAgentId ?? "unknown",
    targetAgentId: payload.targetAgentId ?? "unknown",
    targetPhase: payload.targetPhase ?? payload.phase ?? "unspecified",
    reason: payload.reason ?? "",
    findings: payload.findings ?? [],
    attempt: Number(payload.attempt) || 1,
    status: payload.status ?? "requested"
  };
  const recordPath = getRunEntityPath(rootDir, "retries", runId, retryRequest.id);
  await writeJson(recordPath, retryRequest);
  await updateRunSummary(rootDir, runId, {
    multiAgent: {
      reworkCount: incrementCounter
    }
  }, {
    collection: "retryRequests",
    summary: summarizeRetryRequest(retryRequest)
  });
  return {
    retryRequest,
    recordPath
  };
}

export async function updateRunRetryRequest(rootDir, runId, retryRequestId, patch = {}) {
  return updateRunCollectionRecord(rootDir, "retries", runId, retryRequestId, patch, summarizeRetryRequest, "retryRequests");
}

export async function readRunCollection(rootDir, runId, collection) {
  const files = (await listFiles(path.join(rootDir, "state/runs", collection), ".json"))
    .filter((filePath) => path.basename(filePath).startsWith(`${runId}--`));
  const items = [];
  for (const filePath of files) {
    const item = await readJson(filePath, null);
    if (item) {
      items.push(item);
    }
  }
  return items;
}

export async function readTaskRunSurface(rootDir, runId = "latest") {
  const run = runId === "latest"
    ? await readLatestTaskRun(rootDir)
    : await readTaskRun(rootDir, runId);
  if (!run) {
    return {
      available: false,
      reason: runId === "latest" ? "no-task-runs" : "task-run-missing"
    };
  }

  const [agentRuns, artifacts, handoffs, verdicts, retries] = await Promise.all([
    readRunCollection(rootDir, run.id, "agent-runs"),
    readRunCollection(rootDir, run.id, "artifacts"),
    readRunCollection(rootDir, run.id, "handoffs"),
    readRunCollection(rootDir, run.id, "verdicts"),
    readRunCollection(rootDir, run.id, "retries")
  ]);

  return {
    available: true,
    run: {
      id: run.id,
      status: run.status,
      currentStage: run.currentStage,
      task: run.task,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt ?? null,
      failedAt: run.failedAt ?? null,
      reviewStatus: run.review?.status ?? null,
      multiAgentStatus: run.multiAgent?.status ?? "not-started",
      rolloutMode: run.multiAgent?.rolloutMode ?? null,
      currentPhase: run.multiAgent?.currentPhase ?? null,
      finalVerdict: run.multiAgent?.finalVerdict ?? null,
      phaseGraph: run.phaseGraph ?? [],
      activeAgentRunId: run.activeAgentRunId ?? null
    },
    agentRuns: {
      total: agentRuns.length,
      active: agentRuns.filter((item) => item.status === "running").length,
      completed: agentRuns.filter((item) => item.status === "completed").length,
      failed: agentRuns.filter((item) => item.status === "failed").length,
      items: agentRuns
    },
    artifacts: {
      total: artifacts.length,
      latest: artifacts.slice(-5)
    },
    handoffs: {
      total: handoffs.length,
      pending: handoffs.filter((item) => item.status === "created").length,
      consumed: handoffs.filter((item) => item.status === "consumed").length,
      consultations: handoffs.filter((item) => item.consultation).length,
      items: handoffs.slice(-5)
    },
    verdicts: {
      total: verdicts.length,
      latest: verdicts.at(-1) ?? null,
      blocking: verdicts.filter((item) => item.status === "blocked" || item.status === "needs-rework").length,
      items: verdicts.slice(-5)
    },
    retries: {
      total: retries.length,
      open: retries.filter((item) => item.status === "requested").length,
      completed: retries.filter((item) => item.status === "completed").length,
      exhausted: retries.filter((item) => item.status === "exhausted").length,
      items: retries.slice(-5)
    }
  };
}

export async function readLatestTaskRunSurface(rootDir) {
  return readTaskRunSurface(rootDir, "latest");
}

function getTaskRunPath(rootDir, runId) {
  return path.join(rootDir, "state/runs", `${runId}.json`);
}

function getRunEntityPath(rootDir, collection, runId, entityId) {
  return path.join(rootDir, "state/runs", collection, `${runId}--${entityId}.json`);
}

async function appendRunHistory(rootDir, run, stage) {
  if (!run) {
    return;
  }
  await appendLine(path.join(rootDir, "state/runs/history.jsonl"), JSON.stringify({
    id: run.id,
    at: run.updatedAt,
    status: run.status,
    stage,
    task: run.task
  }));
}

async function updateRunSummary(rootDir, runId, patch = {}, collectionUpdate = null) {
  const runPath = getTaskRunPath(rootDir, runId);
  const current = await readJson(runPath, null);
  if (!current) {
    throw new Error(`Task run "${runId}" does not exist.`);
  }

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    multiAgent: mergeMultiAgentSummary(current.multiAgent, patch.multiAgent)
  };

  if (collectionUpdate?.collection && collectionUpdate.summary) {
    next[collectionUpdate.collection] = upsertCollectionSummary(
      current[collectionUpdate.collection] ?? [],
      collectionUpdate.summary
    );
  }

  await writeJson(runPath, next);
  return next;
}

async function updateRunCollectionRecord(rootDir, collection, runId, entityId, patch, summarizer, summaryCollection) {
  const recordPath = getRunEntityPath(rootDir, collection, runId, entityId);
  const current = await readJson(recordPath, null);
  if (!current) {
    throw new Error(`Run record "${entityId}" does not exist in ${collection}.`);
  }
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await writeJson(recordPath, next);
  await updateRunSummary(rootDir, runId, {}, {
    collection: summaryCollection,
    summary: summarizer(next)
  });
  return next;
}

function mergeMultiAgentSummary(current = {}, patch = {}) {
  const result = {
    ...(current ?? {})
  };

  for (const [key, value] of Object.entries(patch ?? {})) {
    if (typeof value === "function") {
      result[key] = value(Number(current?.[key]) || 0);
      continue;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = mergeMultiAgentSummary(current?.[key] ?? {}, value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function upsertCollectionSummary(items, summary) {
  const next = Array.isArray(items) ? [...items] : [];
  const index = next.findIndex((item) => item.id === summary.id);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...summary
    };
    return next;
  }
  next.push(summary);
  return next;
}

function summarizeAgentRun(agentRun) {
  return {
    id: agentRun.id,
    phase: agentRun.phase,
    agentId: agentRun.agentId,
    agentName: agentRun.agentName,
    role: agentRun.role,
    status: agentRun.status,
    provider: agentRun.provider,
    modelAlias: agentRun.modelAlias,
    effort: agentRun.effort,
    verdictStatus: agentRun.verdict?.status ?? null,
    summary: agentRun.summary ?? null,
    completedAt: agentRun.completedAt ?? null,
    failedAt: agentRun.failedAt ?? null
  };
}

function summarizeArtifact(artifact) {
  return {
    id: artifact.id,
    phase: artifact.phase,
    agentId: artifact.agentId,
    agentRunId: artifact.agentRunId,
    kind: artifact.kind,
    title: artifact.title,
    summary: artifact.summary,
    createdAt: artifact.createdAt
  };
}

function summarizeHandoff(handoff) {
  return {
    id: handoff.id,
    fromAgentId: handoff.fromAgentId,
    toAgentId: handoff.toAgentId,
    toPhase: handoff.toPhase,
    reason: handoff.reason,
    consultation: handoff.consultation,
    status: handoff.status,
    createdAt: handoff.createdAt
  };
}

function summarizeVerdict(verdict) {
  return {
    id: verdict.id,
    phase: verdict.phase,
    agentId: verdict.agentId,
    status: verdict.status,
    summary: verdict.summary,
    retryable: verdict.retryable,
    recommendedOwnerAgentId: verdict.recommendedOwnerAgentId,
    createdAt: verdict.createdAt
  };
}

function summarizeRetryRequest(retryRequest) {
  return {
    id: retryRequest.id,
    phase: retryRequest.phase,
    requestedByAgentId: retryRequest.requestedByAgentId,
    targetAgentId: retryRequest.targetAgentId,
    targetPhase: retryRequest.targetPhase,
    reason: retryRequest.reason,
    attempt: retryRequest.attempt,
    status: retryRequest.status,
    createdAt: retryRequest.createdAt
  };
}

async function readLatestTaskRun(rootDir) {
  const files = (await listFiles(path.join(rootDir, "state/runs"), ".json"))
    .filter((filePath) => !filePath.endsWith("history.json"));
  const latestPath = files.at(-1);
  if (!latestPath) {
    return null;
  }
  return readJson(latestPath, null);
}

function createEntityId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

function incrementCounter(value) {
  return value + 1;
}
