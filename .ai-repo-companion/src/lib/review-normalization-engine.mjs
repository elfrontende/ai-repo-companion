import { loadNotes } from "./context-engine.mjs";
import { roughTokenMatch, slugify, tokenize } from "./note-parser.mjs";

// Review operations often contain note titles where the local graph expects
// note ids. This module resolves those human-friendly references into stable
// ids before quality checks and file writes happen.

export async function normalizeReviewOperations(rootDir, operations) {
  // Models often know note titles better than stable ids. Normalization turns
  // those fuzzy references into graph-safe ids before stricter gates run.
  const notes = await loadNotes(rootDir);
  const resolvers = buildResolvers(notes);
  const normalized = [];
  const changes = [];

  for (const operation of operations ?? []) {
    const next = structuredClone(operation);

    const noteIdResult = normalizeSingleRef(next.noteId, resolvers);
    if (noteIdResult.changed) {
      next.noteId = noteIdResult.value;
      changes.push({
        type: next.type ?? "unknown",
        field: "noteId",
        from: operation.noteId,
        to: next.noteId
      });
    }

    const sourceResult = normalizeSingleRef(next.sourceNoteId, resolvers);
    if (sourceResult.changed) {
      next.sourceNoteId = sourceResult.value;
      changes.push({
        type: next.type ?? "unknown",
        field: "sourceNoteId",
        from: operation.sourceNoteId,
        to: next.sourceNoteId
      });
    }

    const targetResult = normalizeSingleRef(next.targetNoteId, resolvers);
    if (targetResult.changed) {
      next.targetNoteId = targetResult.value;
      changes.push({
        type: next.type ?? "unknown",
        field: "targetNoteId",
        from: operation.targetNoteId,
        to: next.targetNoteId
      });
    }

    const linksToAddResult = normalizeRefArray(next.linksToAdd, resolvers);
    if (linksToAddResult.changed) {
      next.linksToAdd = linksToAddResult.value;
      changes.push({
        type: next.type ?? "unknown",
        field: "linksToAdd",
        from: operation.linksToAdd ?? [],
        to: next.linksToAdd
      });
    }

    const linksResult = normalizeRefArray(next.links, resolvers);
    if (linksResult.changed) {
      next.links = linksResult.value;
      changes.push({
        type: next.type ?? "unknown",
        field: "links",
        from: operation.links ?? [],
        to: next.links
      });
    }

    normalized.push(next);
  }

  return {
    normalized,
    changes
  };
}

function buildResolvers(notes) {
  const byId = new Map();
  const byTitle = new Map();
  const bySlug = new Map();

  for (const note of notes) {
    byId.set(note.id, note.id);
    byTitle.set(normalizeString(note.title), note.id);
    bySlug.set(slugify(note.title ?? ""), note.id);
  }

  return { notes, byId, byTitle, bySlug };
}

function normalizeSingleRef(value, resolvers) {
  const raw = normalizeString(value);
  if (raw === "") {
    return { value: "", changed: false };
  }
  if (resolvers.byId.has(raw)) {
    return { value: raw, changed: false };
  }

  const resolved = resolveReference(raw, resolvers);
  if (!resolved || resolved === raw) {
    return { value: raw, changed: false };
  }

  return { value: resolved, changed: true };
}

function normalizeRefArray(value, resolvers) {
  const input = Array.isArray(value) ? value : [];
  const output = [];
  let changed = false;

  for (const item of input) {
    const raw = normalizeString(item);
    if (raw === "") {
      continue;
    }
    const resolved = resolveReference(raw, resolvers) ?? raw;
    if (resolved !== raw) {
      changed = true;
    }
    output.push(resolved);
  }

  const deduped = [...new Set(output)];
  if (deduped.length !== input.filter((item) => normalizeString(item) !== "").length) {
    changed = true;
  }

  return {
    value: deduped,
    changed
  };
}

function resolveReference(value, resolvers) {
  const normalized = normalizeString(value);
  if (normalized === "") {
    return null;
  }

  const exactTitle = resolvers.byTitle.get(normalized);
  if (exactTitle) {
    return exactTitle;
  }

  const slug = resolvers.bySlug.get(slugify(normalized));
  if (slug) {
    return slug;
  }

  const refTokens = tokenize(normalized);
  if (refTokens.length === 0) {
    return null;
  }

  let bestMatch = null;
  let bestScore = 0;
  for (const note of resolvers.notes) {
    const noteTokens = tokenize(`${note.title} ${note.id}`);
    const score = refTokens.reduce((total, token) => (
      noteTokens.some((candidate) => roughTokenMatch(token, candidate)) ? total + 1 : total
    ), 0);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = note.id;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}
