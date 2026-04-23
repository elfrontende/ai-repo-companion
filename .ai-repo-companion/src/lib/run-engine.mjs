import path from "node:path";
import { appendLine, listFiles, readJson, writeJson } from "./store.mjs";

export async function startTaskRun(rootDir, payload = {}) {
  const timestamp = new Date().toISOString();
  const run = {
    id: `run-${timestamp.replace(/[-:.TZ]/g, "")}`,
    type: "task-run",
    status: "running",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    failedAt: null,
    currentStage: "started",
    task: payload.task ?? "",
    summary: payload.summary ?? "",
    artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : [],
    taskProfile: payload.taskProfile ?? null,
    plan: null,
    contextBundle: null,
    memoryPolicy: null,
    sync: null,
    policyOutcome: null,
    review: null,
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
    runPath: latestPath
  };
}

function getTaskRunPath(rootDir, runId) {
  return path.join(rootDir, "state/runs", `${runId}.json`);
}

async function appendRunHistory(rootDir, run, stage) {
  await appendLine(path.join(rootDir, "state/runs/history.jsonl"), JSON.stringify({
    id: run.id,
    at: run.updatedAt,
    status: run.status,
    stage,
    task: run.task
  }));
}
