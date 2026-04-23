import { spawn } from "node:child_process";

export function runCommand(command, args, stdinBody, cwd) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      });
    });

    if (stdinBody) {
      child.stdin.write(stdinBody);
    }
    child.stdin.end();
  });
}

export function summarizeAttemptUsage(attempts) {
  const totalTokens = attempts.reduce((sum, attempt) => sum + (extractTokenUsageFromText(attempt.stdout) ?? 0) + (extractTokenUsageFromText(attempt.stderr) ?? 0), 0);
  const durationMs = attempts.reduce((sum, attempt) => sum + (Number(attempt.durationMs) || 0), 0);
  return {
    totalTokens: totalTokens > 0 ? totalTokens : null,
    durationMs
  };
}

export function extractTokenUsageFromText(text) {
  if (!text) {
    return null;
  }
  const match = text.match(/tokens used\s+([\d,]+)/i);
  return match ? Number(match[1].replaceAll(",", "")) : null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractJsonPayload(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("Provider returned empty output.");
  }

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Fall through to the looser extraction paths below.
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch) {
    const candidate = fencedMatch[1].trim();
    JSON.parse(candidate);
    return candidate;
  }

  const balanced = extractBalancedJsonObject(trimmed);
  if (!balanced) {
    throw new Error("Provider output did not contain a parseable JSON object.");
  }

  JSON.parse(balanced);
  return balanced;
}

function extractBalancedJsonObject(text) {
  const startIndex = text.indexOf("{");
  if (startIndex === -1) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return "";
}
