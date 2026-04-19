import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { readJson, writeJson } from "./store.mjs";

// The worker lock prevents two local processes from mutating the same review
// queue at the same time. This is the simplest useful guard before we grow
// into a more advanced daemon/runtime model.

export async function acquireReviewLock(rootDir, config = {}) {
  const policy = normalizeLockConfig(config);
  if (!policy.enabled) {
    return {
      acquired: true,
      enabled: false,
      reason: "Runtime lock is disabled."
    };
  }

  const lockPath = path.join(rootDir, "state/reviews/worker-lock.json");
  const ownerId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const payload = {
    ownerId,
    startedAt
  };

  try {
    await fs.writeFile(lockPath, JSON.stringify(payload, null, 2), { encoding: "utf8", flag: "wx" });
    return {
      acquired: true,
      enabled: true,
      ownerId,
      startedAt,
      lockPath,
      staleRecovered: false
    };
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }

  const existing = await readJson(lockPath, null);
  if (!existing?.ownerId || !existing?.startedAt) {
    await fs.rm(lockPath, { force: true }).catch(() => {});
    return acquireReviewLock(rootDir, policy);
  }
  const ageMinutes = existing?.startedAt ? diffMinutes(existing.startedAt, new Date().toISOString()) : 0;
  if (ageMinutes >= policy.maxAgeMinutes) {
    await fs.rm(lockPath, { force: true }).catch(() => {});
    return acquireReviewLock(rootDir, policy);
  }

  return {
    acquired: false,
    enabled: true,
    ownerId: existing?.ownerId ?? null,
    startedAt: existing?.startedAt ?? null,
    ageMinutes,
    lockPath,
    staleRecovered: false,
    reason: "Another review worker already holds the runtime lock."
  };
}

export async function releaseReviewLock(rootDir, lock) {
  // Release is best-effort. The critical safety rule is to never delete a lock
  // that now belongs to a different worker.
  if (!lock?.acquired || !lock.lockPath) {
    return {
      released: false,
      reason: "No active review lock was held by this process."
    };
  }

  const current = await readJson(lock.lockPath, null);
  if (current?.ownerId && current.ownerId !== lock.ownerId) {
    return {
      released: false,
      reason: "Review lock ownership changed before release."
    };
  }

  await fs.rm(lock.lockPath, { force: true }).catch(() => {});
  return {
    released: true,
    ownerId: lock.ownerId
  };
}

function normalizeLockConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    maxAgeMinutes: Math.max(1, Number(config.maxAgeMinutes) || 15)
  };
}

function diffMinutes(startAt, endAt) {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0;
  }
  return Math.max(0, Math.floor((endMs - startMs) / 60000));
}
