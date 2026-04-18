import { loadNotes } from "./context-engine.mjs";
import { roughTokenMatch, slugify, tokenize } from "./note-parser.mjs";

// Idempotency protects the graph from repeated near-duplicate create_note
// operations across neighboring review runs. If the model keeps describing
// the same durable idea with slightly different wording, we prefer to reject
// the duplicate and point the caller at the existing note.

export async function applyIdempotencyGuard(rootDir, operations, config = {}) {
  const notes = await loadNotes(rootDir);
  const guardConfig = {
    minSimilarityScore: Math.max(1, Number(config.minSimilarityScore) || 7)
  };
  const accepted = [];
  const rejected = [];

  for (const operation of operations ?? []) {
    if (operation.type !== "create_note") {
      accepted.push(operation);
      continue;
    }

    const duplicate = findDuplicateCreateNote(operation, notes, guardConfig);
    if (!duplicate) {
      accepted.push(operation);
      continue;
    }

    rejected.push({
      type: operation.type,
      reason: `create_note is too similar to existing note ${duplicate.noteId}.`,
      noteId: duplicate.noteId,
      similarityScore: duplicate.score
    });
  }

  return {
    passed: accepted.length > 0,
    config: guardConfig,
    accepted,
    rejected,
    reason: rejected.length > 0
      ? "Some create_note operations were rejected as near-duplicates."
      : "No duplicate review notes were detected."
  };
}

function findDuplicateCreateNote(operation, notes, config) {
  const title = normalizeString(operation.title);
  const summary = normalizeString(operation.summary);
  const titleSlug = slugify(title);
  const opTags = normalizeArray(operation.tags);
  const opTitleTokens = tokenize(title);
  const opSummaryTokens = tokenize(summary);

  let best = null;

  for (const note of notes) {
    let score = 0;

    if (slugify(note.title ?? "") === titleSlug && titleSlug !== "note") {
      score += 5;
    }

    const noteTitleTokens = tokenize(note.title ?? "");
    const titleOverlap = overlapScore(opTitleTokens, noteTitleTokens);
    score += titleOverlap * 2;

    const noteBodyTokens = tokenize(note.body ?? "");
    const summaryOverlap = overlapScore(opSummaryTokens, noteBodyTokens);
    score += Math.min(4, summaryOverlap);

    const tagOverlap = overlapScore(opTags, note.tags ?? []);
    score += Math.min(3, tagOverlap);

    if (score < config.minSimilarityScore) {
      continue;
    }

    if (!best || score > best.score) {
      best = {
        noteId: note.id,
        score
      };
    }
  }

  return best;
}

function overlapScore(leftValues, rightValues) {
  let score = 0;
  for (const left of leftValues) {
    if (rightValues.some((right) => roughTokenMatch(left, right))) {
      score += 1;
    }
  }
  return score;
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
