import fs from "node:fs/promises";
import path from "node:path";
import { loadNotes } from "./context-engine.mjs";
import { formatFrontmatter, parseFrontmatter, slugify } from "./note-parser.mjs";
import { rebuildLinks } from "./memory-engine.mjs";

// This module applies safe, structured note changes produced by a review agent.
// The LLM proposes operations in JSON. Local code validates and applies them.
// That keeps the note graph under deterministic control and avoids direct
// free-form writes from the model into our memory files.

export async function applyReviewOperations(rootDir, operations, options = {}) {
  // The operation vocabulary stays intentionally tiny. A small local apply
  // surface is easier to audit, test, and keep deterministic over time.
  const notes = await loadNotes(rootDir);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const applied = [];
  const skipped = [];
  let createdCount = 0;

  for (const operation of operations ?? []) {
    const validated = validateOperation(operation);
    if (!validated.ok) {
      skipped.push({
        type: operation?.type ?? "unknown",
        reason: validated.reason
      });
      continue;
    }

    if (operation.type === "append_note_update") {
      const target = noteById.get(operation.noteId);
      if (!target) {
        skipped.push({
          type: operation.type,
          noteId: operation.noteId,
          reason: "Target note does not exist."
        });
        continue;
      }

      await appendNoteUpdate(target.filePath, operation, options.timestamp);
      applied.push({
        type: operation.type,
        noteId: operation.noteId
      });
      continue;
    }

    if (operation.type === "merge_note_into_existing") {
      const source = noteById.get(operation.sourceNoteId);
      const target = noteById.get(operation.targetNoteId);
      if (!source || !target) {
        skipped.push({
          type: operation.type,
          sourceNoteId: operation.sourceNoteId,
          targetNoteId: operation.targetNoteId,
          reason: "Source or target note does not exist."
        });
        continue;
      }

      await mergeNoteIntoExisting(source, target, operation, options.timestamp);
      applied.push({
        type: operation.type,
        sourceNoteId: operation.sourceNoteId,
        targetNoteId: operation.targetNoteId
      });
      continue;
    }

    if (operation.type === "create_note") {
      createdCount += 1;
      const created = await createReviewNote(rootDir, operation, options.timestamp, createdCount);
      applied.push({
        type: operation.type,
        noteId: created.noteId,
        filePath: created.filePath
      });
      continue;
    }

    skipped.push({
      type: operation.type ?? "unknown",
      reason: "Unsupported operation type."
    });
  }

  const refreshedNotes = await loadNotes(rootDir);
  await rebuildLinks(refreshedNotes);

  return {
    applied,
    skipped
  };
}

async function appendNoteUpdate(filePath, operation, timestamp = new Date().toISOString()) {
  // We append instead of rewriting note bodies because append-only review
  // history is much easier for a junior developer to inspect and trust.
  const markdown = await fs.readFile(filePath, "utf8");
  const { meta, body } = parseFrontmatter(markdown);
  const tags = uniqueList([...(normalizeArray(meta.tags)), ...(operation.tagsToAdd ?? [])]);
  const links = uniqueList([...(normalizeArray(meta.links)), ...(operation.linksToAdd ?? [])]);
  const updateLines = [
    body.trim(),
    "",
    "## Review Update",
    `- ${timestamp}: ${operation.summary.trim()}`,
    ...(operation.signals ?? []).map((signal) => `- signal: ${signal}`)
  ];

  await fs.writeFile(filePath, formatFrontmatter({
    ...meta,
    tags,
    links
  }, updateLines.join("\n")), "utf8");
}

async function mergeNoteIntoExisting(sourceNote, targetNote, operation, timestamp = new Date().toISOString()) {
  // Merge is deliberately non-destructive.
  // We enrich the target note and mark the source note as deprecated
  // instead of deleting it. That keeps the knowledge trail auditable.
  const sourceMarkdown = await fs.readFile(sourceNote.filePath, "utf8");
  const targetMarkdown = await fs.readFile(targetNote.filePath, "utf8");
  const { meta: sourceMeta, body: sourceBody } = parseFrontmatter(sourceMarkdown);
  const { meta: targetMeta, body: targetBody } = parseFrontmatter(targetMarkdown);

  const mergedTargetBody = [
    targetBody.trim(),
    "",
    "## Review Merge",
    `- ${timestamp}: ${operation.summary.trim()}`,
    `- merged note: ${sourceNote.id}`,
    ...(operation.signals ?? []).map((signal) => `- signal: ${signal}`)
  ].join("\n");

  await fs.writeFile(targetNote.filePath, formatFrontmatter({
    ...targetMeta,
    tags: uniqueList([
      ...normalizeArray(targetMeta.tags),
      ...normalizeArray(sourceMeta.tags),
      ...(operation.tagsToAdd ?? [])
    ]),
    links: uniqueList([
      ...normalizeArray(targetMeta.links),
      ...normalizeArray(sourceMeta.links),
      sourceNote.id,
      ...(operation.linksToAdd ?? [])
    ])
  }, mergedTargetBody), "utf8");

  const deprecatedBody = [
    sourceBody.trim(),
    "",
    "## Deprecated",
    `- ${timestamp}: merged into ${targetNote.id}`,
    `- merge summary: ${operation.summary.trim()}`
  ].join("\n");

  await fs.writeFile(sourceNote.filePath, formatFrontmatter({
    ...sourceMeta,
    kind: "deprecated",
    tags: uniqueList([
      ...normalizeArray(sourceMeta.tags),
      "deprecated",
      "merged"
    ]),
    links: uniqueList([
      ...normalizeArray(sourceMeta.links),
      targetNote.id
    ])
  }, deprecatedBody), "utf8");
}

async function createReviewNote(rootDir, operation, timestamp = new Date().toISOString(), ordinal = 1) {
  // Review-created notes use a deterministic id prefix so it is always clear
  // which notes came from the deeper review pipeline.
  const noteId = `z-review-${timestamp.replace(/[-:.TZ]/g, "")}-${ordinal}`;
  const title = operation.title.trim().slice(0, 80);
  const filePath = path.join(rootDir, "notes", `${noteId}-${slugify(title)}.md`);
  const meta = {
    id: noteId,
    title,
    kind: operation.kind ?? "task-learning",
    tags: uniqueList(operation.tags ?? []),
    links: uniqueList(operation.links ?? [])
  };
  const body = [
    "# Summary",
    "",
    operation.summary.trim(),
    "",
    "# Signals",
    "",
    ...(operation.signals ?? []).map((signal) => `- ${signal}`)
  ].join("\n");

  await fs.writeFile(filePath, formatFrontmatter(meta, body), "utf8");
  return { noteId, filePath };
}

function validateOperation(operation) {
  // Codex output schema requires every key to exist, even when the field is
  // not relevant for the chosen operation type. Because of that, the local
  // apply layer must normalize empty placeholders and reject incomplete
  // operations before they touch the note graph.
  if (!operation || typeof operation !== "object") {
    return { ok: false, reason: "Operation must be an object." };
  }

  if (normalizeString(operation.type) === "") {
    return { ok: false, reason: "Operation type is missing." };
  }

  if (normalizeString(operation.summary) === "") {
    return { ok: false, reason: "Operation summary is missing." };
  }

  if (operation.type === "append_note_update" && normalizeString(operation.noteId) === "") {
    return { ok: false, reason: "append_note_update requires noteId." };
  }

  if (
    operation.type === "merge_note_into_existing"
    && (normalizeString(operation.sourceNoteId) === "" || normalizeString(operation.targetNoteId) === "")
  ) {
    return { ok: false, reason: "merge_note_into_existing requires sourceNoteId and targetNoteId." };
  }

  if (operation.type === "create_note" && normalizeString(operation.title) === "") {
    return { ok: false, reason: "create_note requires title." };
  }

  return { ok: true };
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}
