import path from "node:path";
import { processReviewQueue } from "./review-worker.mjs";
import { readJson, writeJson } from "./store.mjs";

// This runner is the first automatic background layer.
// It does not daemonize itself or manage OS services.
// Instead, it provides a simple loop that can be launched by a shell,
// cron, launchd, systemd, or any future repo-local automation wrapper.

export async function runReviewWorker(rootDir, config, options = {}) {
  if (options.loop) {
    return runLoop(rootDir, config, options);
  }
  return runOnce(rootDir, config, options);
}

export async function runOnce(rootDir, config, options = {}) {
  // Worker-state breadcrumbs are mainly for humans. They answer simple
  // operator questions like "did the worker actually run?".
  const startedAt = new Date().toISOString();
  await updateWorkerState(rootDir, {
    status: "running",
    lastStartedAt: startedAt,
    lastRunMode: "once"
  });

  const result = await processReviewQueue(rootDir, config, options);

  await updateWorkerState(rootDir, {
    status: "idle",
    lastFinishedAt: new Date().toISOString(),
    lastProcessedCount: result.processedCount,
    lastRunMode: "once",
    runsDelta: 1
  });

  return {
    mode: "once",
    ...result
  };
}

async function runLoop(rootDir, config, options = {}) {
  const intervalSeconds = Number(options.intervalSeconds) || 30;
  const maxIterations = Number(options.maxIterations) || 0;
  const stopWhenEmpty = Boolean(options.stopWhenEmpty);
  const iterations = [];
  let completedIterations = 0;

  while (maxIterations === 0 || completedIterations < maxIterations) {
    const result = await runOnce(rootDir, config, options);
    iterations.push(result);
    completedIterations += 1;

    if (stopWhenEmpty && result.processedCount === 0) {
      break;
    }

    if (maxIterations !== 0 && completedIterations >= maxIterations) {
      break;
    }

    await updateWorkerState(rootDir, {
      status: "sleeping",
      lastRunMode: "loop"
    });
    await sleep(intervalSeconds * 1000);
  }

  await updateWorkerState(rootDir, {
    status: "idle",
    lastFinishedAt: new Date().toISOString(),
    lastRunMode: "loop"
  });

  return {
    mode: "loop",
    iterations
  };
}

export async function getWorkerState(rootDir) {
  return readJson(path.join(rootDir, "state/reviews/worker-state.json"), {
    status: "idle",
    lastStartedAt: null,
    lastFinishedAt: null,
    lastProcessedCount: 0,
    lastRunMode: null,
    runs: 0
  });
}

async function updateWorkerState(rootDir, patch) {
  const filePath = path.join(rootDir, "state/reviews/worker-state.json");
  const current = await getWorkerState(rootDir);
  const next = {
    ...current,
    ...patch
  };

  if (patch.runsDelta) {
    next.runs = current.runs + patch.runsDelta;
    delete next.runsDelta;
  }

  await writeJson(filePath, next);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
