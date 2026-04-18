import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Provider adapters define how a queued review job is executed.
// The orchestration layer does not care whether the job is handled by
// a real provider CLI, a future SDK integration, or a dry-run adapter.

export async function executeReviewPayload(rootDir, payload, config) {
  const executionConfig = config.reviewExecution ?? {};
  const provider = pickProvider(payload.job.mode, executionConfig);
  const nativeCodex = executionConfig.nativeCodex ?? {};
  const nativeCursor = executionConfig.nativeCursor ?? {};
  const reviewProfile = resolveReviewProfile(payload.job.mode, executionConfig);
  const commandConfig = executionConfig.commandAdapters?.[provider];

  if (provider === "codex" && nativeCodex.enabled) {
    return executeNativeCodexAdapter(rootDir, payload, nativeCodex, reviewProfile);
  }
  if (provider === "cursor" && nativeCursor.enabled) {
    return executeNativeCursorAdapter(rootDir, payload, nativeCursor, reviewProfile);
  }

  const adapter = commandConfig?.enabled ? "command" : executionConfig.defaultAdapter ?? "dry-run";

  if (adapter === "command") {
    return executeCommandAdapter(rootDir, provider, payload, commandConfig);
  }

  return executeDryRunAdapter(provider, payload, reviewProfile);
}

function pickProvider(mode, executionConfig) {
  const configuredProvider = executionConfig.providerByMode?.[mode] ?? "claude";

  // Balanced work should prefer Cursor when it is available because that lane
  // is meant to stay lighter than the expensive Codex path.
  if (configuredProvider === "cursor") {
    if (isCursorAvailable(executionConfig)) {
      return "cursor";
    }
    if (isCodexAvailable(executionConfig)) {
      return "codex";
    }
  }

  // Expensive work stays Codex-first. If Codex is unavailable, keep the
  // configured provider so the caller still gets the expected failure mode.
  return configuredProvider;
}

function isCursorAvailable(executionConfig) {
  return Boolean(executionConfig.nativeCursor?.enabled || executionConfig.commandAdapters?.cursor?.enabled);
}

function isCodexAvailable(executionConfig) {
  return Boolean(executionConfig.nativeCodex?.enabled || executionConfig.commandAdapters?.codex?.enabled);
}

async function executeDryRunAdapter(provider, payload, reviewProfile) {
  return {
    provider,
    adapter: "dry-run",
    status: "prepared",
    output: {
      title: `Prepared ${payload.job.mode} review job for ${provider}`,
      prompt: buildReviewPrompt(payload, reviewProfile),
      contextBundle: payload.contextBundle,
      reviewProfile,
      usage: {
        totalTokens: null,
        durationMs: 0
      },
      suggestedNextStep: "Configure a real command adapter when you are ready to call an external AI."
    }
  };
}

async function executeNativeCodexAdapter(rootDir, payload, nativeCodex, reviewProfile) {
  // Native Codex integration uses schema-constrained output.
  // This is the safest way to let a real model propose memory edits:
  // the model can only return JSON that matches our operation schema.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-codex-"));
  const schemaPath = path.join(tempDir, "review-schema.json");
  const outputPath = path.join(tempDir, "review-output.json");
  const schema = buildCodexOutputSchema(reviewProfile);
  const prompt = buildReviewPrompt(payload, reviewProfile);

  await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");

  const args = [
    "exec",
    "-C",
    rootDir,
    "--skip-git-repo-check",
    "--sandbox",
    nativeCodex.sandbox ?? "workspace-write",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-"
  ];

  if (nativeCodex.model) {
    args.splice(1, 0, "--model", nativeCodex.model);
  }
  if (reviewProfile.codexReasoningEffort) {
    args.splice(1, 0, "-c", `model_reasoning_effort="${reviewProfile.codexReasoningEffort}"`);
  }
  if (Array.isArray(nativeCodex.extraArgs) && nativeCodex.extraArgs.length > 0) {
    args.splice(args.length - 1, 0, ...nativeCodex.extraArgs);
  }

  // Live Codex runs are the most fragile part of the pipeline because they
  // depend on an external CLI and a strict output contract.
  // We retry a small number of times so temporary transport or parse issues
  // do not immediately downgrade the whole review job to failed.
  const retryConfig = {
    maxAttempts: Math.max(1, Number(nativeCodex.maxAttempts) || 2),
    retryBackoffMs: Math.max(0, Number(nativeCodex.retryBackoffMs) || 1500)
  };
  const attempts = [];
  let raw = "";
  let parsed = null;
  let lastResult = null;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt += 1) {
    const result = await runCommand(nativeCodex.binary ?? "codex", args, prompt, rootDir);
    lastResult = result;
    const attemptRecord = {
      attempt,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.code,
      durationMs: result.durationMs
    };

    if (result.code === 0) {
      try {
        raw = await fs.readFile(outputPath, "utf8");
        parsed = JSON.parse(raw);
        attempts.push({
          ...attemptRecord,
          status: "completed"
        });
        break;
      } catch (error) {
        attempts.push({
          ...attemptRecord,
          status: "failed",
          parseError: error.message
        });
      }
    } else {
      attempts.push({
        ...attemptRecord,
        status: "failed"
      });
    }

    if (attempt < retryConfig.maxAttempts) {
      await sleep(retryConfig.retryBackoffMs * attempt);
    }
  }

  if (!parsed) {
    return {
      provider: "codex",
      adapter: "codex-native",
      status: "failed",
      output: {
        args,
        attempts,
        reviewProfile,
        usage: summarizeAttemptUsage(attempts),
        stdout: lastResult?.stdout?.trim?.() ?? "",
        stderr: lastResult?.stderr?.trim?.() ?? "",
        exitCode: lastResult?.code ?? 1
      }
    };
  }

  return {
    provider: "codex",
    adapter: "codex-native",
    status: "completed",
    output: {
      args,
      attempts,
      reviewProfile,
      usage: summarizeAttemptUsage(attempts),
      raw,
      parsed
    }
  };
}

async function executeNativeCursorAdapter(rootDir, payload, nativeCursor, reviewProfile) {
  // Cursor does not currently expose a schema-constrained output flag like Codex.
  // To keep the local apply path safe, we force a strict JSON-only contract
  // in the prompt and then parse the returned text locally.
  const prompt = buildCursorReviewPrompt(payload, reviewProfile);
  const args = [
    "agent",
    "--print",
    "--output-format",
    "text",
    "--mode",
    nativeCursor.mode ?? "ask",
    "--workspace",
    rootDir
  ];

  if (nativeCursor.trustWorkspace !== false) {
    args.push("--trust");
  }
  if (nativeCursor.force === true) {
    args.push("--force");
  }
  if (nativeCursor.sandbox) {
    args.push("--sandbox", nativeCursor.sandbox);
  }
  if (nativeCursor.model) {
    args.push("--model", nativeCursor.model);
  }
  if (Array.isArray(nativeCursor.extraArgs) && nativeCursor.extraArgs.length > 0) {
    args.push(...nativeCursor.extraArgs);
  }
  args.push(prompt);

  const retryConfig = {
    maxAttempts: Math.max(1, Number(nativeCursor.maxAttempts) || 2),
    retryBackoffMs: Math.max(0, Number(nativeCursor.retryBackoffMs) || 1500)
  };
  const attempts = [];
  let raw = "";
  let parsed = null;
  let lastResult = null;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt += 1) {
    const result = await runCommand(nativeCursor.binary ?? "cursor", args, "", rootDir);
    lastResult = result;
    const attemptRecord = {
      attempt,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.code,
      durationMs: result.durationMs
    };

    if (result.code === 0) {
      try {
        raw = extractJsonPayload(result.stdout);
        parsed = JSON.parse(raw);
        attempts.push({
          ...attemptRecord,
          status: "completed"
        });
        break;
      } catch (error) {
        attempts.push({
          ...attemptRecord,
          status: "failed",
          parseError: error.message
        });
      }
    } else {
      attempts.push({
        ...attemptRecord,
        status: "failed"
      });
    }

    if (attempt < retryConfig.maxAttempts) {
      await sleep(retryConfig.retryBackoffMs * attempt);
    }
  }

  if (!parsed) {
    return {
      provider: "cursor",
      adapter: "cursor-native",
      status: "failed",
      output: {
        args,
        attempts,
        reviewProfile,
        usage: summarizeAttemptUsage(attempts),
        stdout: lastResult?.stdout?.trim?.() ?? "",
        stderr: lastResult?.stderr?.trim?.() ?? "",
        exitCode: lastResult?.code ?? 1
      }
    };
  }

  return {
    provider: "cursor",
    adapter: "cursor-native",
    status: "completed",
    output: {
      args,
      attempts,
      reviewProfile,
      usage: summarizeAttemptUsage(attempts),
      raw,
      parsed
    }
  };
}

async function executeCommandAdapter(rootDir, provider, payload, commandConfig) {
  if (!commandConfig?.command) {
    throw new Error(`Command adapter for provider "${provider}" is enabled but has no command.`);
  }

  const args = (commandConfig.args ?? []).map((arg) => interpolateArg(arg, payload, provider));
  const result = await runCommand(commandConfig.command, args, JSON.stringify(payload, null, 2), rootDir);

  return {
    provider,
    adapter: "command",
    status: result.code === 0 ? "completed" : "failed",
    output: {
      command: commandConfig.command,
      args,
      usage: summarizeAttemptUsage([{
        attempt: 1,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        exitCode: result.code,
        durationMs: result.durationMs,
        status: result.code === 0 ? "completed" : "failed"
      }]),
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.code
    }
  };
}

function buildReviewPrompt(payload, reviewProfile = {}) {
  const mergedTasks = Array.isArray(payload.job.tasks) ? payload.job.tasks : [];
  const maxOperations = reviewProfile.maxOperations ?? 3;
  const promptStyle = reviewProfile.promptStyle ?? "strict";

  if (promptStyle === "light") {
    return [
      "You maintain a Zettelkasten memory graph for a repository assistant.",
      "Return only structured JSON that matches the provided schema.",
      "Prefer the smallest correct memory update.",
      "",
      `Review mode: ${payload.job.mode}`,
      `Budget: ${payload.job.budget} tokens`,
      `Task: ${payload.job.task}`,
      ...(mergedTasks.length > 1
        ? [`Merged tasks: ${mergedTasks.length}`]
        : []),
      "",
      "Relevant note snippets:",
      ...payload.contextBundle.selectedNotes.map((note) => `- ${note.id} | ${note.title} | ${note.snippet}`),
      "",
      "Rules:",
      `- Do not propose more than ${maxOperations} operations.`,
      "- Prefer append_note_update over create_note.",
      "- Create a new note only when the knowledge is clearly distinct.",
      "- Keep summaries and signals short.",
      "- Use existing note ids in links whenever possible."
    ].join("\n");
  }

  return [
    "You are maintaining a Zettelkasten memory graph for a repository assistant.",
    "Return only structured JSON that matches the provided schema.",
    "Prefer small, precise memory changes over broad rewrites.",
    "Use append_note_update for existing notes whenever possible.",
    "Use merge_note_into_existing when a note is clearly a duplicate of another note.",
    "Create a new note only when the knowledge is clearly distinct.",
    "",
    `Review mode: ${payload.job.mode}`,
    `Domains: ${payload.job.domains.join(", ")}`,
    `Budget: ${payload.job.budget} tokens`,
    `Task: ${payload.job.task}`,
    ...(payload.staleness?.level === "stale"
      ? [
        `Job staleness: stale (${payload.staleness.ageMinutes} minutes old)`,
        "Rebuild your judgment from current note snippets instead of trusting the original queue reasons blindly."
      ]
      : []),
    ...(mergedTasks.length > 1
      ? [
        `Merged tasks in this review job: ${mergedTasks.length}`,
        ...mergedTasks.map((entry, index) => `- task ${index + 1}: ${entry.task}`)
      ]
      : []),
    "",
    "Why this review was queued:",
    ...payload.job.reasons.map((reason) => `- ${reason}`),
    "",
    "Relevant note snippets:",
    ...payload.contextBundle.selectedNotes.map((note) => `- ${note.id} | ${note.title} | tags=${note.tags.join(", ")} | ${note.snippet}`),
    "",
    "Response rules:",
    `- Do not propose more than ${maxOperations} operations.`,
    "- Do not rewrite entire notes.",
    "- linksToAdd and links must use existing note ids when possible.",
    "- signals must be short bullet-ready strings.",
    "- Every operation object must include every schema key.",
    "- When a field does not apply, use an empty string for text fields and [] for list fields."
  ].join("\n");
}

function buildCursorReviewPrompt(payload, reviewProfile = {}) {
  return [
    buildReviewPrompt(payload, reviewProfile).replace(
      "Return only structured JSON that matches the provided schema.",
      "Return exactly one raw JSON object and nothing else. Do not use markdown fences."
    ),
    "",
    "JSON contract:",
    "{",
    '  "summary": "short sentence",',
    '  "operations": [',
    "    {",
    '      "type": "append_note_update | merge_note_into_existing | create_note",',
    '      "noteId": "",',
    '      "sourceNoteId": "",',
    '      "targetNoteId": "",',
    '      "title": "",',
    '      "kind": "",',
    '      "summary": "",',
    '      "signals": [],',
    '      "tagsToAdd": [],',
    '      "linksToAdd": [],',
    '      "tags": [],',
    '      "links": []',
    "    }",
    "  ]",
    "}",
    "Every operation object must include every key above.",
    "For non-applicable text fields use an empty string.",
    "For non-applicable list fields use []."
  ].join("\n");
}

function interpolateArg(arg, payload, provider) {
  return arg
    .replaceAll("{provider}", provider)
    .replaceAll("{mode}", payload.job.mode)
    .replaceAll("{task}", payload.job.task);
}

function runCommand(command, args, stdinBody, cwd) {
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

    child.stdin.write(stdinBody);
    child.stdin.end();
  });
}

function summarizeAttemptUsage(attempts) {
  const totalTokens = attempts.reduce((sum, attempt) => sum + (extractTokenUsageFromText(attempt.stdout) ?? 0) + (extractTokenUsageFromText(attempt.stderr) ?? 0), 0);
  const durationMs = attempts.reduce((sum, attempt) => sum + (Number(attempt.durationMs) || 0), 0);
  return {
    totalTokens: totalTokens > 0 ? totalTokens : null,
    durationMs
  };
}

function extractTokenUsageFromText(text) {
  if (!text) {
    return null;
  }
  const match = text.match(/tokens used\s+([\d,]+)/i);
  return match ? Number(match[1].replaceAll(",", "")) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJsonPayload(rawText) {
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

function buildCodexOutputSchema(reviewProfile = {}) {
  // Keep the schema intentionally small.
  // The more operation types we add, the harder it becomes to keep the
  // local apply step understandable and safe for maintenance.
  const maxOperations = reviewProfile.maxOperations ?? 3;
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "operations"],
    properties: {
      summary: {
        type: "string"
      },
      operations: {
        type: "array",
        maxItems: maxOperations,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "type",
            "noteId",
            "sourceNoteId",
            "targetNoteId",
            "title",
            "kind",
            "summary",
            "signals",
            "tagsToAdd",
            "linksToAdd",
            "tags",
            "links"
          ],
          properties: {
            type: {
              type: "string",
              enum: [
                "append_note_update",
                "merge_note_into_existing",
                "create_note"
              ]
            },
            noteId: {
              type: "string",
              description: "Existing target note id for append_note_update. Use an empty string when not needed."
            },
            sourceNoteId: {
              type: "string",
              description: "Source note id for merge_note_into_existing. Use an empty string when not needed."
            },
            targetNoteId: {
              type: "string",
              description: "Target note id for merge_note_into_existing. Use an empty string when not needed."
            },
            title: {
              type: "string",
              description: "Title for create_note. Use an empty string when not needed."
            },
            kind: {
              type: "string",
              description: "Note kind for create_note. Use an empty string when not needed."
            },
            summary: { type: "string" },
            signals: {
              type: "array",
              items: { type: "string" }
            },
            tagsToAdd: {
              type: "array",
              items: { type: "string" }
            },
            linksToAdd: {
              type: "array",
              items: { type: "string" }
            },
            tags: {
              type: "array",
              items: { type: "string" }
            },
            links: {
              type: "array",
              items: { type: "string" }
            }
          }
        }
      }
    }
  };
}

function resolveReviewProfile(mode, executionConfig) {
  const profiles = executionConfig.reviewProfiles ?? {};
  const defaults = mode === "balanced"
    ? { promptStyle: "light", maxOperations: 2, codexReasoningEffort: "medium" }
    : { promptStyle: "strict", maxOperations: 3, codexReasoningEffort: "high" };

  return {
    ...defaults,
    ...(profiles[mode] ?? {})
  };
}

export async function persistReviewReport(rootDir, jobId, report) {
  const reportPath = path.join(rootDir, "state/reviews/reports", `${jobId}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}
