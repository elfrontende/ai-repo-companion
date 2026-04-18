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
  const notes = await loadNotes(rootDir);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const applied = [];
  const skipped = [];
  let createdCount = 0;

  for (const operation of operations ?? []) {
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

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}
