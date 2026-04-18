import fs from "node:fs/promises";
import path from "node:path";
import { appendLine, readJson, writeJson } from "./store.mjs";
import { recordReviewMetricsEvent } from "./review-metrics-engine.mjs";

// Recovery sessions protect the tiny window between
// "the model already returned note operations"
// and
// "the local runtime finished applying those operations".
//
// If the process dies in that window, we want a boring result:
// restore the notes directory from backup and put the job back into the queue.

export async function beginReviewApplyRecovery(rootDir, job, reportPath, config = {}) {
  const recoveryConfig = normalizeRecoveryConfig(config);
  if (!recoveryConfig.enabled) {
    return null;
  }

  const sessionId = `${job.id}-${Date.now()}`;
  const { recoveryDir, recoveryStatePath } = getRecoveryPaths(rootDir);
  const sessionDir = path.join(recoveryDir, sessionId);
  const backupNotesDir = path.join(sessionDir, "notes-backup");
  const notesDir = path.join(rootDir, "notes");

  await fs.mkdir(backupNotesDir, { recursive: true });
  await fs.cp(notesDir, backupNotesDir, { recursive: true });

  const state = {
    active: true,
    sessionId,
    jobId: job.id,
    reportPath,
    strategy: recoveryConfig.strategy,
    backupNotesDir,
    startedAt: new Date().toISOString()
  };

  await writeJson(recoveryStatePath, state);
  return state;
}

export async function completeReviewApplyRecovery(rootDir, session, config = {}) {
  const recoveryConfig = normalizeRecoveryConfig(config);
  if (!session) {
    return {
      completed: false,
      reason: "No active recovery session was created for this review run."
    };
  }

  const { recoveryStatePath } = getRecoveryPaths(rootDir);
  await writeJson(recoveryStatePath, inactiveRecoveryState());

  const sessionDir = path.dirname(session.backupNotesDir);
  if (!recoveryConfig.keepBackups) {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    completed: true,
    sessionId: session.sessionId,
    keptBackups: recoveryConfig.keepBackups
  };
}

export async function recoverInterruptedReviewRun(rootDir, config = {}) {
  const recoveryConfig = normalizeRecoveryConfig(config);
  if (!recoveryConfig.enabled) {
    return {
      recovered: false,
      reason: "Recovery policy is disabled."
    };
  }

  const { recoveryStatePath } = getRecoveryPaths(rootDir);
  const recoveryState = await readJson(recoveryStatePath, inactiveRecoveryState());
  if (!recoveryState?.active) {
    return {
      recovered: false,
      reason: "No interrupted review apply session was found."
    };
  }

  const queuePath = path.join(rootDir, "state/memory/review-queue.json");
  const historyPath = path.join(rootDir, "state/reviews/history.jsonl");
  const notesDir = path.join(rootDir, "notes");
  const recoveredAt = new Date().toISOString();

  await fs.rm(notesDir, { recursive: true, force: true });
  await fs.cp(recoveryState.backupNotesDir, notesDir, { recursive: true });

  const queue = await readJson(queuePath, []);
  const job = queue.find((entry) => entry.id === recoveryState.jobId);
  if (job) {
    job.status = "queued";
    job.startedAt = null;
    job.finishedAt = null;
    job.error = null;
    job.recoveryCount = (job.recoveryCount ?? 0) + 1;
    job.lastRecoveredAt = recoveredAt;
    job.recovery = {
      strategy: recoveryState.strategy,
      recoveredAt,
      action: "rolled-back-and-requeued"
    };
    await writeJson(queuePath, queue);
  }

  if (recoveryState.reportPath) {
    const report = await readJson(recoveryState.reportPath, null);
    if (report) {
      report.recovery = {
        sessionId: recoveryState.sessionId,
        strategy: recoveryState.strategy,
        recoveredAt,
        action: "rolled-back-and-requeued"
      };
      report.noteChanges = {
        ...(report.noteChanges ?? {}),
        applied: [],
        skipped: [],
        reason: "The previous apply step was interrupted. Notes were restored from backup and the job was re-queued."
      };
      await writeJson(recoveryState.reportPath, report);
    }
  }

  await appendLine(historyPath, JSON.stringify({
    id: recoveryState.jobId,
    at: recoveredAt,
    status: "recovered",
    provider: "local",
    adapter: "recovery-policy",
    reportPath: recoveryState.reportPath ?? null
  }));
  await recordReviewMetricsEvent(rootDir, {
    type: "recovery-run",
    at: recoveredAt,
    jobId: recoveryState.jobId,
    status: "recovered",
    recovered: true
  });

  await completeReviewApplyRecovery(rootDir, recoveryState, recoveryConfig);

  return {
    recovered: true,
    jobId: recoveryState.jobId,
    recoveredAt,
    action: "rolled-back-and-requeued",
    reportPath: recoveryState.reportPath ?? null
  };
}

function getRecoveryPaths(rootDir) {
  return {
    recoveryDir: path.join(rootDir, "state/reviews/recovery"),
    recoveryStatePath: path.join(rootDir, "state/reviews/recovery-state.json")
  };
}

function normalizeRecoveryConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    strategy: config.strategy ?? "rollback-and-requeue",
    keepBackups: config.keepBackups === true
  };
}

function inactiveRecoveryState() {
  return {
    active: false,
    sessionId: null,
    jobId: null,
    reportPath: null,
    strategy: null,
    backupNotesDir: null,
    startedAt: null
  };
}
