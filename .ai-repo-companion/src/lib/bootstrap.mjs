import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, ensureFile } from "./store.mjs";

const seedFiles = [
  "config/system.json",
  "state/agents/registry.json",
  "state/memory/working-memory.json",
  "state/memory/events.jsonl",
  "state/memory/policy-state.json",
  "state/memory/review-queue.json",
  "state/reviews/history.jsonl",
  "state/reviews/metrics.json",
  "state/reviews/recovery-state.json",
  "state/reviews/worker-state.json",
  "notes/000-index.md",
  "notes/100-context-minimization.md",
  "notes/110-atomic-notes.md",
  "notes/120-agent-orchestration.md",
  "notes/130-background-memory-sync.md"
];

export async function ensureWorkspace(rootDir) {
  // This function creates the minimum folder/file layout the workspace expects.
  // It is intentionally conservative: it only fills missing files and never
  // overwrites existing project state.
  const requiredDirs = [
    "config",
    "notes",
    "state/agents",
    "state/benchmarks",
    "state/memory",
    "state/reviews",
    "state/reviews/approvals",
    "state/reviews/recovery",
    "state/reviews/reports",
    "src",
    "tests"
  ];

  for (const relativeDir of requiredDirs) {
    await ensureDir(path.join(rootDir, relativeDir));
  }

  for (const relativeFile of seedFiles) {
    const sourcePath = path.join(rootDir, relativeFile);
    const content = await fs.readFile(sourcePath, "utf8").catch(() => null);
    await ensureFile(sourcePath, content ?? "");
  }
}
