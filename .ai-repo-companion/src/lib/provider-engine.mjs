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
  const commandConfig = executionConfig.commandAdapters?.[provider];

  if (provider === "codex" && nativeCodex.enabled) {
    return executeNativeCodexAdapter(rootDir, payload, nativeCodex);
  }

  const adapter = commandConfig?.enabled ? "command" : executionConfig.defaultAdapter ?? "dry-run";

  if (adapter === "command") {
    return executeCommandAdapter(rootDir, provider, payload, commandConfig);
  }

  return executeDryRunAdapter(provider, payload);
}

function pickProvider(mode, executionConfig) {
  return executionConfig.providerByMode?.[mode] ?? "claude";
}

async function executeDryRunAdapter(provider, payload) {
  return {
    provider,
    adapter: "dry-run",
    status: "prepared",
    output: {
      title: `Prepared ${payload.job.mode} review job for ${provider}`,
      prompt: buildReviewPrompt(payload),
      contextBundle: payload.contextBundle,
      suggestedNextStep: "Configure a real command adapter when you are ready to call an external AI."
    }
  };
}

async function executeNativeCodexAdapter(rootDir, payload, nativeCodex) {
  // Native Codex integration uses schema-constrained output.
  // This is the safest way to let a real model propose memory edits:
  // the model can only return JSON that matches our operation schema.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-repo-companion-codex-"));
  const schemaPath = path.join(tempDir, "review-schema.json");
  const outputPath = path.join(tempDir, "review-output.json");
  const schema = buildCodexOutputSchema();
  const prompt = buildReviewPrompt(payload);

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
    const result = await runCommand("codex", args, prompt, rootDir);
    lastResult = result;
    const attemptRecord = {
      attempt,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.code
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
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.code
    }
  };
}

function buildReviewPrompt(payload) {
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
    "",
    "Why this review was queued:",
    ...payload.job.reasons.map((reason) => `- ${reason}`),
    "",
    "Relevant note snippets:",
    ...payload.contextBundle.selectedNotes.map((note) => `- ${note.id} | ${note.title} | tags=${note.tags.join(", ")} | ${note.snippet}`),
    "",
    "Response rules:",
    "- Do not propose more than 3 operations.",
    "- Do not rewrite entire notes.",
    "- linksToAdd and links must use existing note ids when possible.",
    "- signals must be short bullet-ready strings.",
    "- Every operation object must include every schema key.",
    "- When a field does not apply, use an empty string for text fields and [] for list fields."
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
      resolve({ code, stdout, stderr });
    });

    child.stdin.write(stdinBody);
    child.stdin.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCodexOutputSchema() {
  // Keep the schema intentionally small.
  // The more operation types we add, the harder it becomes to keep the
  // local apply step understandable and safe for maintenance.
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
        maxItems: 3,
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

export async function persistReviewReport(rootDir, jobId, report) {
  const reportPath = path.join(rootDir, "state/reviews/reports", `${jobId}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}
