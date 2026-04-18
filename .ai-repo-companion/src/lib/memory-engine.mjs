import fs from "node:fs/promises";
import path from "node:path";
import { appendLine, readJson, writeJson } from "./store.mjs";
import { estimateTokens, formatFrontmatter, parseFrontmatter, roughTokenMatch, slugify, tokenize } from "./note-parser.mjs";
import { loadNotes } from "./context-engine.mjs";

export async function syncMemory(rootDir, payload, config) {
  // syncMemory is the always-on local layer.
  // It must stay deterministic and token-free so it can safely run after
  // every task without accidentally becoming a hidden cost center.
  const timestamp = new Date().toISOString();
  const event = {
    id: `evt-${timestamp.replace(/[-:.TZ]/g, "")}`,
    at: timestamp,
    task: payload.task,
    summary: payload.summary,
    artifacts: payload.artifacts ?? []
  };

  await appendLine(path.join(rootDir, "state/memory/events.jsonl"), JSON.stringify(event));

  const notes = await loadNotes(rootDir);
  const related = findBestExistingNote(notes, payload.task, payload.summary);
  const touchedNote = related
    ? await updateExistingNote(related, payload, timestamp)
    : await createTaskNote(rootDir, payload, timestamp);

  const allNotes = await loadNotes(rootDir);
  await rebuildLinks(allNotes);
  await refreshWorkingMemory(rootDir, touchedNote.id, event.id, config);

  return {
    eventId: event.id,
    touchedNoteId: touchedNote.id,
    touchedNotePath: touchedNote.filePath
  };
}

function findBestExistingNote(notes, task, summary) {
  // We do a cheap overlap test first because it is usually enough to decide
  // whether a task extends existing knowledge or deserves a brand-new note.
  const queryTokens = tokenize(`${task} ${summary}`);
  let best = null;

  for (const note of notes) {
    const noteTokens = new Set(tokenize(`${note.title} ${note.tags.join(" ")} ${note.body}`));
    const overlap = queryTokens.filter((token) => [...noteTokens].some((candidate) => roughTokenMatch(token, candidate))).length;
    if (overlap < 3) {
      continue;
    }
    if (!best || overlap > best.overlap) {
      best = { note, overlap };
    }
  }

  return best?.note ?? null;
}

async function updateExistingNote(note, payload, timestamp) {
  // Existing notes get appended instead of fully rewritten.
  // That keeps the note history easy to inspect for a junior developer.
  const markdown = await fs.readFile(note.filePath, "utf8");
  const { meta, body } = parseFrontmatter(markdown);
  const updatedBody = [
    body.trim(),
    "",
    "## Update",
    `- ${timestamp}: ${payload.summary.trim()}`,
    ...payload.artifacts.map((artifact) => `- artifact: ${artifact}`)
  ].join("\n");

  const updatedMeta = {
    ...meta,
    tags: uniqueList([...(normalizeArray(meta.tags)), ...tokenize(payload.task).slice(0, 5)]),
    links: normalizeArray(meta.links)
  };

  await fs.writeFile(note.filePath, formatFrontmatter(updatedMeta, updatedBody), "utf8");
  return { ...note, id: updatedMeta.id, filePath: note.filePath };
}

async function createTaskNote(rootDir, payload, timestamp) {
  // New notes are intentionally tiny: one summary plus a few signals.
  // Retrieval gets more efficient when notes stay small and specific.
  const taskTokens = tokenize(payload.task);
  const id = `z-task-${timestamp.replace(/[-:.TZ]/g, "")}`;
  const title = payload.task.trim().slice(0, 80);
  const filePath = path.join(rootDir, "notes", `${id}-${slugify(title)}.md`);
  const meta = {
    id,
    title,
    kind: "task-learning",
    tags: uniqueList(["task", ...taskTokens.slice(0, 6)]),
    links: []
  };
  const body = [
    "# Summary",
    "",
    payload.summary.trim(),
    "",
    "# Signals",
    "",
    `- Source task: ${payload.task.trim()}`,
    ...payload.artifacts.map((artifact) => `- artifact: ${artifact}`)
  ].join("\n");

  await fs.writeFile(filePath, formatFrontmatter(meta, body), "utf8");
  return {
    ...meta,
    filePath,
    body,
    tokenEstimate: estimateTokens(body)
  };
}

export async function rebuildLinks(notes) {
  // Link rebuilding is local and approximate on purpose.
  // If the graph becomes too messy, policy-engine can later queue an
  // LLM-powered review job, but the default path should stay cheap.
  const noteMap = new Map(notes.map((note) => [note.id, note]));

  for (const note of notes) {
    const candidates = notes
      .filter((candidate) => candidate.id !== note.id)
      .map((candidate) => ({
        id: candidate.id,
        score: linkScore(note, candidate)
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 4)
      .map((candidate) => candidate.id);

    const markdown = await fs.readFile(note.filePath, "utf8");
    const { meta, body } = parseFrontmatter(markdown);
    const updatedMeta = {
      ...meta,
      links: uniqueList(candidates)
    };
    await fs.writeFile(note.filePath, formatFrontmatter(updatedMeta, body), "utf8");

    const updated = noteMap.get(note.id);
    if (updated) {
      updated.links = candidates;
    }
  }
}

function linkScore(left, right) {
  const leftTokens = [...normalizeArray(left.tags), ...tokenize(left.title), ...tokenize(left.body)];
  const rightTokens = [...normalizeArray(right.tags), ...tokenize(right.title), ...tokenize(right.body)];
  return rightTokens.reduce(
    (score, token) => score + (leftTokens.some((candidate) => roughTokenMatch(token, candidate)) ? 1 : 0),
    0
  );
}

async function refreshWorkingMemory(rootDir, noteId, eventId, config) {
  // Working memory stores pointers, not knowledge blobs.
  // This is one of the main token-saving design choices in the project.
  const workingPath = path.join(rootDir, "state/memory/working-memory.json");
  const current = await readJson(workingPath, {
    hotNoteIds: [],
    recentEventIds: [],
    lastSyncAt: null
  });
  const maxEntries = config.memory?.workingMemoryMaxEntries ?? 12;

  current.hotNoteIds = uniqueList([noteId, ...current.hotNoteIds]).slice(0, maxEntries);
  current.recentEventIds = uniqueList([eventId, ...current.recentEventIds]).slice(0, maxEntries);
  current.lastSyncAt = new Date().toISOString();

  await writeJson(workingPath, current);
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
