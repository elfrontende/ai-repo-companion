import fs from "node:fs/promises";
import path from "node:path";

// Tiny file-system helpers live here so the rest of the code reads like
// business logic instead of repetitive mkdir/read/write boilerplate.

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensureFile(filePath, initialContent = "") {
  // Rerunning bootstrap must be safe, so this helper only creates missing
  // files and never overwrites user/project state.
  try {
    await fs.access(filePath);
  } catch {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, initialContent, "utf8");
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    // Missing files are treated as "not initialized yet" so callers can stay
    // focused on business rules instead of repeated first-run checks.
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export async function appendLine(filePath, line) {
  // Append-only files make event history easy to inspect with plain shell
  // tools, which is helpful when debugging local runtime behavior.
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${line}\n`, "utf8");
}

export async function listFiles(dirPath, extension = null) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .filter((filePath) => !extension || filePath.endsWith(extension))
    .sort();
}
