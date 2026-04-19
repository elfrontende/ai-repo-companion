import fs from "node:fs/promises";
import path from "node:path";
import { listFiles } from "./store.mjs";
import { estimateTokens, parseFrontmatter, roughTokenMatch, tokenize } from "./note-parser.mjs";

// Context assembly is the cheapest big win in the whole project.
// Instead of sending "everything we know" to the model, we rank notes and
// stop once we have the smallest note bundle that still looks useful.

export async function loadNotes(rootDir) {
  const notesDir = path.join(rootDir, "notes");
  const files = await listFiles(notesDir, ".md");
  const notes = [];

  for (const filePath of files) {
    const markdown = await fs.readFile(filePath, "utf8");
    const { meta, body } = parseFrontmatter(markdown);
    notes.push({
      filePath,
      ...meta,
      tags: normalizeArray(meta.tags),
      links: normalizeArray(meta.links),
      body,
      tokenEstimate: estimateTokens(body)
    });
  }

  return notes;
}

export function assembleContext(task, notes, options = {}) {
  // The bundler is intentionally simple:
  // 1. score all notes against the task
  // 2. sort strongest first
  // 3. stop at note count or token budget
  const tokenBudget = options.tokenBudget ?? 1200;
  const maxNotes = options.maxNotes ?? 6;
  const taskTokens = tokenize(task);
  const noteById = new Map(notes.map((note) => [note.id, note]));

  const ranked = notes
    .map((note) => ({
      note,
      score: scoreNote(note, taskTokens, noteById)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.note.tokenEstimate - right.note.tokenEstimate);

  const selected = [];
  let usedTokens = 0;

  for (const entry of ranked) {
    if (selected.length >= maxNotes) {
      break;
    }
    if (usedTokens + entry.note.tokenEstimate > tokenBudget && selected.length > 0) {
      continue;
    }
    selected.push({
      id: entry.note.id,
      title: entry.note.title,
      kind: entry.note.kind,
      score: round(entry.score),
      tokenEstimate: entry.note.tokenEstimate,
      tags: entry.note.tags,
      links: entry.note.links,
      snippet: compactSnippet(entry.note.body)
    });
    usedTokens += entry.note.tokenEstimate;
  }

  return {
    task,
    tokenBudget,
    usedTokens,
    selectedNotes: selected
  };
}

function scoreNote(note, taskTokens, noteById) {
  // We bias toward structured signals before body text:
  // tags > title > tags tokenized again > body > linked neighbors.
  // This keeps retrieval stable even when note bodies grow over time.
  const titleTokens = tokenize(note.title ?? "");
  const bodyTokens = tokenize(note.body ?? "");
  const tagTokens = note.tags.flatMap((tag) => tokenize(tag));

  let score = 0;
  for (const token of taskTokens) {
    if (matchesAny(token, note.tags)) {
      score += 5;
    }
    if (matchesAny(token, titleTokens)) {
      score += 4;
    }
    if (matchesAny(token, tagTokens)) {
      score += 3;
    }
    if (matchesAny(token, bodyTokens)) {
      score += 1;
    }
  }

  for (const linkedId of note.links) {
    const linked = noteById.get(linkedId);
    if (!linked) {
      continue;
    }
    const linkedTokens = tokenize(`${linked.title} ${linked.tags.join(" ")}`);
    if (taskTokens.some((token) => matchesAny(token, linkedTokens))) {
      score += 0.5;
    }
  }

  return score;
}

function compactSnippet(body) {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function matchesAny(token, collection) {
  return collection.some((candidate) => roughTokenMatch(token, candidate));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
