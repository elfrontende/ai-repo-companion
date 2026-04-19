import { loadNotes } from "./context-engine.mjs";
import { roughTokenMatch, slugify, tokenize } from "./note-parser.mjs";

// Idempotency protects the graph from repeated near-duplicate create_note
// operations across neighboring review runs. If the model keeps describing
// the same durable idea with slightly different wording, we prefer to keep
// one canonical note instead of growing a pile of near-identical review notes.
//
// Default behavior is intentionally gentle:
// - keep the existing note as the source of truth
// - rewrite duplicate create_note operations into append_note_update
// - fall back to hard rejection only when the config says so

export async function applyIdempotencyGuard(rootDir, operations, config = {}) {
  // Duplicate pressure mostly comes from create_note, so that is where we are
  // intentionally strict. Existing-note updates can stay for later guards.
  const notes = await loadNotes(rootDir);
  const noteIds = new Set(notes.map((note) => note.id));
  const guardConfig = {
    minSimilarityScore: Math.max(1, Number(config.minSimilarityScore) || 7),
    rewriteDuplicatesToAppendUpdate: config.rewriteDuplicatesToAppendUpdate !== false
  };
  const accepted = [];
  const rejected = [];
  const rewritten = [];

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

    if (guardConfig.rewriteDuplicatesToAppendUpdate) {
      const rewrittenOperation = rewriteDuplicateCreateNote(operation, duplicate.noteId, noteIds);
      accepted.push(rewrittenOperation);
      rewritten.push({
        fromType: operation.type,
        toType: rewrittenOperation.type,
        originalTitle: normalizeString(operation.title),
        noteId: duplicate.noteId,
        similarityScore: duplicate.score,
        reason: `Rewrote duplicate create_note into append_note_update for ${duplicate.noteId}.`
      });
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
    rewritten,
    rejected,
    reason: buildGuardReason(rewritten, rejected)
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

function rewriteDuplicateCreateNote(operation, targetNoteId, noteIds) {
  // The rewrite keeps the existing note canonical and turns the duplicate
  // proposal into a safe append-only review update. We only keep links that
  // already point at known notes, and we never let the rewritten update add
  // a self-link back to its own target note.
  const linksToAdd = uniqueList(
    normalizeArray(operation.links).filter((link) => noteIds.has(link) && link !== targetNoteId)
  );

  return {
    type: "append_note_update",
    noteId: targetNoteId,
    sourceNoteId: "",
    targetNoteId: "",
    title: "",
    kind: "",
    summary: normalizeString(operation.summary),
    signals: normalizeArray(operation.signals),
    tagsToAdd: uniqueList(normalizeArray(operation.tags)),
    linksToAdd,
    tags: [],
    links: []
  };
}

function buildGuardReason(rewritten, rejected) {
  if (rewritten.length > 0 && rejected.length > 0) {
    return "Some create_note operations were rewritten as updates, while others were rejected as duplicates.";
  }
  if (rewritten.length > 0) {
    return "Some create_note operations were rewritten into append_note_update for existing notes.";
  }
  if (rejected.length > 0) {
    return "Some create_note operations were rejected as near-duplicates.";
  }
  return "No duplicate review notes were detected.";
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

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}
