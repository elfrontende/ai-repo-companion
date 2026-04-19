import path from "node:path";
import { loadNotes } from "./context-engine.mjs";
import { roughTokenMatch, tokenize } from "./note-parser.mjs";
import { readJson, writeJson } from "./store.mjs";

// This file decides how "smart" memory maintenance should be after a task.
// The key idea is simple:
// - cheap: only local file operations, no extra reasoning pass
// - balanced: local operations + queue one small review job
// - expensive: local operations + queue one deeper review job

export async function evaluateMemoryPolicy(rootDir, taskProfile, config) {
  const policyConfig = config.memoryPolicy ?? {};
  const policyStatePath = path.join(rootDir, "state/memory/policy-state.json");
  const policyState = await readJson(policyStatePath, defaultPolicyState());
  const notes = await loadNotes(rootDir);
  const domains = inferDomains(taskProfile, policyConfig);
  const domainSnapshots = domains.map((domain) => ({
    domain,
    existingEvents: policyState.domains?.[domain]?.eventCount ?? 0,
    queuedJobs: policyState.domains?.[domain]?.queuedJobs ?? 0,
    duplicateCandidates: countDuplicateCandidates(domain, notes, policyConfig)
  }));

  const reasons = [];
  let mode = policyConfig.defaultMode ?? "cheap";
  let shouldQueueReview = false;

  const hasHardTrigger = taskProfile.intents.includes("architecture")
    || domains.some((domain) => (policyConfig.hardTriggers ?? []).includes(domain))
    || (taskProfile.risk === "high" && domains.length > 0);

  if (hasHardTrigger) {
    mode = "expensive";
    shouldQueueReview = true;
    reasons.push("High-risk or architectural task touched a protected domain.");
  } else if (taskProfile.risk === "medium") {
    mode = "balanced";
    shouldQueueReview = true;
    reasons.push("Medium-risk task should get a small memory review pass.");
  }

  for (const snapshot of domainSnapshots) {
    if (snapshot.existingEvents + 1 >= (policyConfig.sameDomainEventThreshold ?? 3)) {
      mode = promoteMode(mode, "balanced");
      shouldQueueReview = true;
      reasons.push(`Domain "${snapshot.domain}" accumulated enough events to justify cleanup.`);
    }
    if (
      snapshot.duplicateCandidates >= (policyConfig.duplicateCandidateThreshold ?? 2)
      && (taskProfile.complexity >= 3 || taskProfile.risk !== "low")
    ) {
      mode = promoteMode(mode, "balanced");
      shouldQueueReview = true;
      reasons.push(`Domain "${snapshot.domain}" already has overlapping notes that may need merge/refactor.`);
    }
    if (snapshot.queuedJobs >= (policyConfig.maxQueuedJobsPerDomain ?? 2)) {
      shouldQueueReview = false;
      reasons.push(`Domain "${snapshot.domain}" already has enough queued review jobs, so no new job was added.`);
    }
  }

  if (reasons.length === 0) {
    reasons.push("Task is routine enough for local-only memory maintenance.");
  }

  return {
    mode,
    domains,
    reasons,
    shouldQueueReview,
    reviewBudget: mode === "expensive"
      ? policyConfig.expensiveTokenBudget ?? 700
      : mode === "balanced"
        ? policyConfig.balancedTokenBudget ?? 300
        : 0,
    domainSnapshots
  };
}

export async function applyMemoryPolicyOutcome(rootDir, decision, taskProfile, syncResult, config = {}) {
  // This is where a policy decision becomes real local state: counters move,
  // and maybe a new review job lands in the queue.
  const policyStatePath = path.join(rootDir, "state/memory/policy-state.json");
  const queuePath = path.join(rootDir, "state/memory/review-queue.json");
  const policyState = await readJson(policyStatePath, defaultPolicyState());
  const queue = await readJson(queuePath, []);
  const now = new Date().toISOString();

  for (const domain of decision.domains) {
    const current = policyState.domains[domain] ?? {
      eventCount: 0,
      queuedJobs: 0,
      lastTask: null,
      lastMode: null,
      lastUpdatedAt: null
    };

    current.eventCount += 1;
    current.lastTask = taskProfile.task;
    current.lastMode = decision.mode;
    current.lastUpdatedAt = now;
    policyState.domains[domain] = current;
  }

  policyState.recentModes = [
    {
      at: now,
      mode: decision.mode,
      task: taskProfile.task,
      domains: decision.domains
    },
    ...policyState.recentModes
  ].slice(0, 20);
  policyState.lastDecisionAt = now;

  let queuedJob = null;
  if (decision.shouldQueueReview && decision.mode !== "cheap" && decision.domains.length > 0) {
    const candidateJob = {
      id: `memjob-${now.replace(/[-:.TZ]/g, "")}`,
      createdAt: now,
      mode: decision.mode,
      budget: decision.reviewBudget,
      task: taskProfile.task,
      domains: decision.domains,
      reasons: decision.reasons,
      sourceEventId: syncResult.eventId,
      sourceNoteId: syncResult.touchedNoteId,
      sourceEventIds: [syncResult.eventId],
      sourceNoteIds: [syncResult.touchedNoteId],
      tasks: [
        {
          task: taskProfile.task,
          reasons: decision.reasons,
          sourceEventId: syncResult.eventId,
          sourceNoteId: syncResult.touchedNoteId,
          addedAt: now
        }
      ],
      mergedTaskCount: 1,
      status: "queued"
    };

    const compaction = compactQueuedJob(queue, candidateJob, config.reviewExecution?.queueCompaction ?? {});
    if (compaction.merged) {
      queuedJob = compaction.job;
    } else {
      queuedJob = candidateJob;
      queue.unshift(queuedJob);

      for (const domain of decision.domains) {
        const current = policyState.domains[domain];
        current.queuedJobs += 1;
      }
    }
  }

  await writeJson(policyStatePath, policyState);
  await writeJson(queuePath, queue.slice(0, 50));

  return {
    queuedJob,
    policyStatePath,
    queuePath
  };
}

function inferDomains(taskProfile, policyConfig) {
  const matches = new Set();
  const catalog = policyConfig.domainCatalog ?? {};

  for (const [domain, keywords] of Object.entries(catalog)) {
    if (keywords.some((keyword) => taskProfile.tokens.some((token) => roughTokenMatch(token, keyword)))) {
      matches.add(domain);
    }
  }

  if (taskProfile.intents.includes("architecture")) {
    matches.add("architecture");
  }

  return [...matches];
}

function countDuplicateCandidates(domain, notes, policyConfig) {
  const keywords = policyConfig.domainCatalog?.[domain] ?? [];
  if (keywords.length === 0) {
    return 0;
  }

  return notes.filter((note) => {
    const haystack = tokenize(`${note.title} ${note.tags.join(" ")} ${note.body}`);
    return keywords.some((keyword) => haystack.some((token) => roughTokenMatch(token, keyword)));
  }).length;
}

function promoteMode(currentMode, nextMode) {
  const weights = { cheap: 1, balanced: 2, expensive: 3 };
  return weights[nextMode] > weights[currentMode] ? nextMode : currentMode;
}

function defaultPolicyState() {
  return {
    domains: {},
    recentModes: [],
    lastDecisionAt: null
  };
}

function compactQueuedJob(queue, candidateJob, config) {
  const compactionConfig = {
    enabled: config.enabled !== false,
    maxTasksPerJob: Math.max(1, Number(config.maxTasksPerJob) || 3),
    mergeWindowMinutes: Math.max(1, Number(config.mergeWindowMinutes) || 30)
  };

  if (!compactionConfig.enabled) {
    return { merged: false, job: candidateJob, config: compactionConfig };
  }

  const candidateCreatedAt = Date.parse(candidateJob.createdAt);
  const mergeWindowMs = compactionConfig.mergeWindowMinutes * 60 * 1000;

  const target = queue.find((job) => {
    if (job.status !== "queued") {
      return false;
    }
    if (job.mode !== candidateJob.mode) {
      return false;
    }
    if (!hasDomainOverlap(job.domains, candidateJob.domains)) {
      return false;
    }
    const existingTasks = Array.isArray(job.tasks) && job.tasks.length > 0 ? job.tasks : [job];
    if (existingTasks.length >= compactionConfig.maxTasksPerJob) {
      return false;
    }
    const createdAt = Date.parse(job.createdAt);
    return Number.isFinite(createdAt) && Math.abs(candidateCreatedAt - createdAt) <= mergeWindowMs;
  });

  if (!target) {
    return { merged: false, job: candidateJob, config: compactionConfig };
  }

  target.budget = Math.max(Number(target.budget) || 0, Number(candidateJob.budget) || 0);
  target.domains = uniqueList([...(target.domains ?? []), ...(candidateJob.domains ?? [])]);
  target.reasons = uniqueList([...(target.reasons ?? []), ...(candidateJob.reasons ?? [])]);
  target.sourceEventIds = uniqueList([...(target.sourceEventIds ?? []), ...(candidateJob.sourceEventIds ?? [])]);
  target.sourceNoteIds = uniqueList([...(target.sourceNoteIds ?? []), ...(candidateJob.sourceNoteIds ?? [])]);
  target.tasks = [...(target.tasks ?? []), ...(candidateJob.tasks ?? [])];
  target.mergedTaskCount = target.tasks.length;
  target.lastCompactedAt = candidateJob.createdAt;
  target.compaction = {
    enabled: true,
    mergeCount: (target.compaction?.mergeCount ?? 0) + 1,
    lastMergedTask: candidateJob.task
  };

  return {
    merged: true,
    job: target,
    config: compactionConfig
  };
}

function hasDomainOverlap(leftDomains = [], rightDomains = []) {
  return leftDomains.some((domain) => rightDomains.includes(domain));
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}
