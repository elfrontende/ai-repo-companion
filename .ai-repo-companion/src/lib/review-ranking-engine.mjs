import { loadNotes } from "./context-engine.mjs";

// Ranking is the final local decision layer before note writes happen.
// Quality gate answers: "Is this operation safe enough to consider?"
// Ranking answers: "Which safe operations are worth applying right now?"
//
// This matters when the model returns several valid updates. We want durable
// memory to prefer the strongest changes first instead of applying every
// acceptable operation blindly.

export async function rankReviewOperations(rootDir, operations, config = {}) {
  const notes = await loadNotes(rootDir);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const rankingConfig = {
    maxAppliedOperations: Math.max(1, Number(config.maxAppliedOperations) || 2),
    minScore: Math.max(0, Number(config.minScore) || 35)
  };

  const ranked = (operations ?? [])
    .map((operation, index) => scoreOperation(operation, noteById, index))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = [];
  const deferred = [];

  for (const candidate of ranked) {
    if (candidate.score < rankingConfig.minScore) {
      deferred.push({
        ...serializeCandidate(candidate),
        reason: "Score is below the minimum apply threshold."
      });
      continue;
    }

    if (selected.length >= rankingConfig.maxAppliedOperations) {
      deferred.push({
        ...serializeCandidate(candidate),
        reason: "Higher-ranked operations already used the apply budget."
      });
      continue;
    }

    selected.push(candidate);
  }

  return {
    passed: selected.length > 0,
    config: rankingConfig,
    ranked: ranked.map(serializeCandidate),
    selected: selected.map((candidate) => candidate.operation),
    deferred,
    reason: selected.length > 0
      ? "At least one operation passed ranking and was selected for apply."
      : "No operation reached the ranking threshold."
  };
}

function scoreOperation(operation, noteById, index) {
  const reasons = [];
  let score = 0;

  if (operation.type === "create_note") {
    score += 60;
    reasons.push("create_note is usually the most durable kind of memory change.");

    if (normalizeString(operation.kind) === "architecture" || normalizeString(operation.kind) === "decision") {
      score += 8;
      reasons.push("Architectural and decision notes deserve stronger preference.");
    }

    const signalCount = normalizeArray(operation.signals).length;
    score += Math.min(12, signalCount * 3);
    if (signalCount > 0) {
      reasons.push(`Signal count adds ${Math.min(12, signalCount * 3)} points.`);
    }

    const tagCount = normalizeArray(operation.tags).length;
    score += Math.min(8, tagCount * 2);
    if (tagCount > 0) {
      reasons.push(`Tags add ${Math.min(8, tagCount * 2)} points.`);
    }

    const linkCount = normalizeArray(operation.links).length;
    score += Math.min(8, linkCount * 2);
    if (linkCount > 0) {
      reasons.push(`Links add ${Math.min(8, linkCount * 2)} points.`);
    }
  } else if (operation.type === "merge_note_into_existing") {
    score += 50;
    reasons.push("merge_note_into_existing can reduce long-term duplication.");

    const signalCount = normalizeArray(operation.signals).length;
    score += Math.min(10, signalCount * 3);
    if (signalCount > 0) {
      reasons.push(`Signals add ${Math.min(10, signalCount * 3)} points.`);
    }
  } else if (operation.type === "append_note_update") {
    score += 30;
    reasons.push("append_note_update is useful but usually less durable than a new note.");

    const signalCount = normalizeArray(operation.signals).length;
    score += Math.min(9, signalCount * 3);
    if (signalCount > 0) {
      reasons.push(`Signals add ${Math.min(9, signalCount * 3)} points.`);
    }

    const tagCount = normalizeArray(operation.tagsToAdd).length;
    score += Math.min(6, tagCount * 2);
    if (tagCount > 0) {
      reasons.push(`New tags add ${Math.min(6, tagCount * 2)} points.`);
    }

    const linkCount = normalizeArray(operation.linksToAdd).length;
    score += Math.min(9, linkCount * 3);
    if (linkCount > 0) {
      reasons.push(`New links add ${Math.min(9, linkCount * 3)} points.`);
    }

    if (operation.noteId === "z-000-index") {
      score -= 8;
      reasons.push("Index-only updates are useful, but they are usually secondary to core knowledge changes.");
    }

    const targetKind = noteById.get(operation.noteId)?.kind ?? "";
    if (targetKind === "architecture" || targetKind === "decision") {
      score += 4;
      reasons.push("Updating an architecture or decision note gets a small bonus.");
    }
  }

  const summaryBonus = Math.min(12, Math.floor(normalizeString(operation.summary).length / 24));
  score += summaryBonus;
  if (summaryBonus > 0) {
    reasons.push(`Summary length adds ${summaryBonus} points.`);
  }

  return {
    index,
    operation,
    score,
    reasons
  };
}

function serializeCandidate(candidate) {
  return {
    index: candidate.index,
    type: candidate.operation?.type ?? "unknown",
    score: candidate.score,
    reasons: candidate.reasons
  };
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}
