import { loadNotes } from "./context-engine.mjs";

// A live provider can return valid JSON that is still too weak to trust.
// This quality gate protects the note graph from low-signal writes such as:
// - tiny summaries
// - empty create_note payloads
// - append updates that add no real signal
//
// The goal is not to judge the model harshly. The goal is to apply only
// changes that are strong enough to be worth saving as durable memory.

export async function evaluateReviewOperations(rootDir, operations) {
  const notes = await loadNotes(rootDir);
  const noteIds = new Set(notes.map((note) => note.id));
  const accepted = [];
  const rejected = [];

  for (const operation of operations ?? []) {
    const verdict = evaluateOperation(operation, noteIds);
    if (verdict.ok) {
      accepted.push(operation);
      continue;
    }

    rejected.push({
      type: operation?.type ?? "unknown",
      reason: verdict.reason
    });
  }

  return {
    passed: accepted.length > 0,
    accepted,
    rejected,
    reason: accepted.length > 0
      ? "At least one operation passed the quality gate."
      : "All operations were rejected by the quality gate."
  };
}

function evaluateOperation(operation, noteIds) {
  if (!operation || typeof operation !== "object") {
    return { ok: false, reason: "Operation must be an object." };
  }

  const summary = normalizeString(operation.summary);
  if (summary.length < 24) {
    return { ok: false, reason: "Summary is too short to become durable memory." };
  }

  if (operation.type === "create_note") {
    if (normalizeString(operation.title).length < 12) {
      return { ok: false, reason: "create_note title is too short." };
    }
    if (normalizeArray(operation.signals).length < 2) {
      return { ok: false, reason: "create_note needs at least two signals." };
    }
    if (normalizeArray(operation.tags).length < 2) {
      return { ok: false, reason: "create_note needs at least two tags." };
    }
    return { ok: true };
  }

  if (operation.type === "append_note_update") {
    if (!noteIds.has(operation.noteId)) {
      return { ok: false, reason: "append_note_update targets an unknown note." };
    }
    const linksToAdd = normalizeArray(operation.linksToAdd);
    const unknownLinks = linksToAdd.filter((link) => !noteIds.has(link));
    if (unknownLinks.length > 0) {
      return { ok: false, reason: "append_note_update still contains unresolved links." };
    }
    if (linksToAdd.includes(operation.noteId)) {
      return { ok: false, reason: "append_note_update cannot add a self-link." };
    }
    if (operation.noteId === "z-000-index" && linksToAdd.length === 0) {
      return { ok: false, reason: "index updates must add at least one outgoing note link." };
    }
    const hasSignalPayload = normalizeArray(operation.signals).length > 0
      || normalizeArray(operation.tagsToAdd).length > 0
      || linksToAdd.length > 0;
    if (!hasSignalPayload) {
      return { ok: false, reason: "append_note_update adds no signals, tags, or links." };
    }
    return { ok: true };
  }

  if (operation.type === "merge_note_into_existing") {
    if (!noteIds.has(operation.sourceNoteId) || !noteIds.has(operation.targetNoteId)) {
      return { ok: false, reason: "merge_note_into_existing references an unknown note." };
    }
    if (operation.sourceNoteId === operation.targetNoteId) {
      return { ok: false, reason: "merge_note_into_existing cannot merge a note into itself." };
    }
    if (normalizeArray(operation.signals).length === 0) {
      return { ok: false, reason: "merge_note_into_existing needs at least one signal." };
    }
    const linksToAdd = normalizeArray(operation.linksToAdd);
    const unknownLinks = linksToAdd.filter((link) => !noteIds.has(link));
    if (unknownLinks.length > 0) {
      return { ok: false, reason: "merge_note_into_existing still contains unresolved links." };
    }
    if (linksToAdd.includes(operation.targetNoteId)) {
      return { ok: false, reason: "merge_note_into_existing cannot add a self-link to the target note." };
    }
    return { ok: true };
  }

  return { ok: false, reason: "Unsupported operation type." };
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
