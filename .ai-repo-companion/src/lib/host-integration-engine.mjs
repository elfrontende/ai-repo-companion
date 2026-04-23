import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, writeJson } from "./store.mjs";

export async function writeHostIntegrationPack(rootDir, config, options = {}) {
  const integrationConfig = config.multiAgentRuntime?.integration ?? {};
  const hiddenRoot = config.hiddenRoot ?? ".ai-repo-companion";
  const editor = normalizeEditor(options.editor ?? integrationConfig.defaultEditor ?? "both");
  const previewRoot = path.join(rootDir, integrationConfig.packOutputDir ?? "state/integration/host-pack");
  const hostRoot = options.hostRoot ? path.resolve(options.hostRoot) : null;
  const writeHostFiles = options.writeHostFiles === true && Boolean(hostRoot);
  const generatedAt = new Date().toISOString();
  const files = buildHostIntegrationFiles(hiddenRoot);

  await fs.rm(previewRoot, { recursive: true, force: true });

  const writtenFiles = [];
  for (const file of files) {
    if (!shouldIncludeEditorFile(file, editor)) {
      continue;
    }

    const previewPath = path.join(previewRoot, file.relativePath);
    await ensureDir(path.dirname(previewPath));
    await fs.writeFile(previewPath, file.content, "utf8");

    let hostPath = null;
    if (writeHostFiles && file.writeToHost !== false) {
      hostPath = path.join(hostRoot, file.relativePath);
      await ensureDir(path.dirname(hostPath));
      await fs.writeFile(hostPath, file.content, "utf8");
    }

    writtenFiles.push({
      id: file.id,
      editor: file.editor ?? "both",
      relativePath: file.relativePath,
      previewPath,
      hostPath,
      writeToHost: file.writeToHost !== false,
      description: file.description
    });
  }

  const manifest = {
    generatedAt,
    editor,
    hiddenRoot,
    previewRoot,
    hostRoot: hostRoot ?? null,
    writeHostFiles,
    files: writtenFiles
  };

  await writeJson(path.join(previewRoot, "manifest.json"), manifest);

  return {
    generatedAt,
    editor,
    hiddenRoot,
    previewRoot,
    hostRoot: hostRoot ?? null,
    writeHostFiles,
    files: writtenFiles,
    nextSteps: buildNextSteps(hiddenRoot, editor, writeHostFiles)
  };
}

function buildHostIntegrationFiles(hiddenRoot) {
  return [
    {
      id: "install-guide",
      editor: "both",
      relativePath: "INSTALL.md",
      writeToHost: false,
      description: "Step-by-step host repository integration guide.",
      content: buildInstallGuide(hiddenRoot)
    },
    {
      id: "command-adapter-contract",
      editor: "both",
      relativePath: "COMMAND-ADAPTER-CONTRACT.md",
      writeToHost: false,
      description: "stdin/stdout contract for external agent and review adapters.",
      content: buildCommandAdapterContract(hiddenRoot)
    },
    {
      id: "codex-host-instructions",
      editor: "codex",
      relativePath: "AGENTS.md",
      writeToHost: true,
      description: "Codex host repository instructions.",
      content: buildCodexHostInstructions(hiddenRoot)
    },
    {
      id: "cursor-project-rule",
      editor: "cursor",
      relativePath: ".cursor/rules/ai-repo-companion.mdc",
      writeToHost: true,
      description: "Cursor always-apply project rule for the host repository.",
      content: buildCursorProjectRule(hiddenRoot)
    },
    {
      id: "gitignore-snippet",
      editor: "both",
      relativePath: "gitignore.snippet",
      writeToHost: false,
      description: "Suggested host repository ignore entry.",
      content: `${hiddenRoot}/\n`
    }
  ];
}

function buildInstallGuide(hiddenRoot) {
  return [
    "# Host Integration",
    "",
    "Use this pack when the real repository is private or under NDA and the runtime must be handed to another AI.",
    "",
    "## What this pack gives you",
    "",
    "- `AGENTS.md` for Codex-aware hosts",
    "- `.cursor/rules/ai-repo-companion.mdc` for Cursor auto-load",
    "- a command adapter contract for non-native backends",
    "- one place to explain rollout rules to the operator",
    "",
    "## Recommended setup",
    "",
    "1. Copy the full hidden runtime into the host repo root as:",
    `   - \`${hiddenRoot}/\``,
    "2. Ignore that folder in the host repo:",
    `   - add \`${hiddenRoot}/\` to \`.gitignore\``,
    `3. From \`${hiddenRoot}/\`, run:`,
    "   - `npm run init`",
    "   - `npm test`",
    "4. Generate or refresh host-facing instructions:",
    "   - `npm run integrate -- --editor both`",
    "5. To write host files directly into the parent repo:",
    "   - `npm run integrate -- --editor both --hostRoot .. --writeHostFiles`",
    "",
    "## Rollout guidance",
    "",
    "- start with `shadow` or `advisory` for a real host repository",
    "- allow writes only for docs, notes, or low-risk scaffolding first",
    "- keep auth, schema migration, infra, and security-sensitive paths on approval-only until the runtime proves grounding quality",
    "- if the AI cannot identify a concrete target file, it must stop and report the missing grounding instead of inventing one",
    "",
    "## Backend options",
    "",
    "- native Codex agent runtime",
    "- native Cursor agent runtime",
    "- generic command adapter for any other AI wrapper",
    "",
    `See \`${hiddenRoot}/docs/HOST-INTEGRATION.md\` for the full operator guide.`,
    ""
  ].join("\n");
}

function buildCommandAdapterContract(hiddenRoot) {
  return [
    "# Command Adapter Contract",
    "",
    `This repository can route both review jobs and multi-agent steps through an external command. The host repo keeps the runtime in \`${hiddenRoot}/\`, while the external AI wrapper lives wherever the operator wants.`,
    "",
    "## Multi-agent step contract",
    "",
    "The runtime writes one JSON payload to stdin:",
    "",
    "```json",
    "{",
    '  "mode": "multi-agent-step",',
    '  "provider": "external",',
    '  "agent": {',
    '    "id": "implementer",',
    '    "role": "implementation",',
    '    "effort": "medium"',
    "  },",
    '  "contract": {',
    '    "inputSchema": {},',
    '    "outputSchema": {},',
    '    "allowedActions": ["propose changes"],',
    '    "successCriteria": ["keep scope bounded"]',
    "  },",
    '  "input": {',
    '    "task": "tighten deployment README wording",',
    '    "phase": "delivery"',
    "  },",
    '  "knownAgentIds": ["orchestrator", "memory-curator", "docs"]',
    "}",
    "```",
    "",
    "The command must return one JSON object to stdout:",
    "",
    "```json",
    "{",
    '  "summary": "short sentence",',
    '  "artifacts": [',
    '    {',
    '      "kind": "change-plan",',
    '      "title": "short title",',
    '      "summary": "short summary",',
    '      "content": "artifact body",',
    '      "data": {}',
    "    }",
    "  ],",
    '  "handoffs": [',
    '    { "to": "qa", "reason": "why", "brief": "next step" }',
    "  ],",
    '  "consultations": [',
    '    { "to": "architect", "question": "question", "reason": "why" }',
    "  ],",
    '  "verdict": {',
    '    "status": "pass | needs-rework | blocked | info",',
    '    "summary": "short verdict summary",',
    '    "findings": ["short finding"]',
    "  }",
    "}",
    "```",
    "",
    "## Review job contract",
    "",
    "The review worker already supports the same stdin/stdout idea for queued memory review. Its payload shape is documented in the live review section of the runtime docs and is routed through `reviewExecution.commandAdapters`.",
    "",
    "## Safety requirements",
    "",
    "- stdout must contain parseable JSON",
    "- do not invent unknown agent ids",
    "- do not return Markdown fences around JSON",
    "- if grounding is missing, return `blocked` instead of inventing files or facts",
    ""
  ].join("\n");
}

function buildCodexHostInstructions(hiddenRoot) {
  return [
    "# AI Repo Companion Host Instructions",
    "",
    `This repository includes a hidden orchestration runtime in \`${hiddenRoot}/\`. Use it as the memory, context, and guarded multi-agent layer for repository work.`,
    "",
    "## Required behavior",
    "",
    "- prefer the companion for multi-step or risky repository work",
    "- keep host-repo edits grounded in real files and explicit handoffs",
    "- if the target file or owner is unclear, stop and report the missing grounding",
    "- do not edit companion `state/` files by hand unless the task is specifically about runtime internals",
    "",
    "## Entry points",
    "",
    `- read \`${hiddenRoot}/docs/HOST-INTEGRATION.md\` for the operating model`,
    `- read \`${hiddenRoot}/docs/USER-GUIDE.md\` for command examples`,
    `- run companion commands from \`${hiddenRoot}/\``,
    "",
    "## Practical commands",
    "",
    "- `npm run task -- --task \"...\" --summary \"...\"`",
    "- `npm run task -- --task \"...\" --summary \"...\" --reviewNow`",
    "- `npm run task -- --task \"...\" --summary \"...\" --agentLive --agentProvider codex`",
    "- `npm run task -- --task \"...\" --summary \"...\" --agentLive --agentProvider cursor`",
    "- `npm run report`",
    "- `npm run run -- --runId latest`",
    "",
    "## Rollout policy",
    "",
    "- start with shadow or advisory behavior for new host repos",
    "- keep high-risk domains approval-only until the runtime proves reliable on that repo",
    "- treat `needs-rework` as a real signal to re-ground the task instead of pushing forward blindly",
    ""
  ].join("\n");
}

function buildCursorProjectRule(hiddenRoot) {
  return [
    "---",
    "description: Use AI Repo Companion as the repository memory and guarded multi-agent runtime.",
    "alwaysApply: true",
    "---",
    "",
    `This repository includes a hidden orchestration runtime at \`${hiddenRoot}/\`.`,
    "",
    "When work is multi-step, risky, or needs durable repo memory:",
    "",
    "- prefer the companion runtime over ad hoc long prompts",
    `- read \`${hiddenRoot}/docs/HOST-INTEGRATION.md\` before major changes`,
    `- run commands from \`${hiddenRoot}/\`, not from the host root`,
    "- if the target file is unclear, stop and report the missing grounding instead of inventing one",
    "- do not edit companion `state/` files manually unless the task is specifically about runtime internals",
    "",
    "Useful commands:",
    "",
    "- `npm run task -- --task \"...\" --summary \"...\"`",
    "- `npm run task -- --task \"...\" --summary \"...\" --reviewNow`",
    "- `npm run task -- --task \"...\" --summary \"...\" --agentLive --agentProvider cursor`",
    "- `npm run task -- --task \"...\" --summary \"...\" --agentLive --agentProvider codex`",
    "- `npm run report`",
    "- `npm run run -- --runId latest`",
    ""
  ].join("\n");
}

function normalizeEditor(editor) {
  if (editor === "codex" || editor === "cursor") {
    return editor;
  }
  return "both";
}

function shouldIncludeEditorFile(file, editor) {
  return file.editor === "both" || editor === "both" || file.editor === editor;
}

function buildNextSteps(hiddenRoot, editor, writeHostFiles) {
  const steps = [
    `Review the generated pack in \`${hiddenRoot}/state/integration/host-pack/\`.`,
    `Read \`${hiddenRoot}/docs/HOST-INTEGRATION.md\` before enabling write access in a real host repo.`
  ];

  if (!writeHostFiles) {
    steps.push("Copy the generated host-facing files into the host repository when you are ready.");
  }
  if (editor === "both" || editor === "cursor") {
    steps.push("Confirm Cursor sees `.cursor/rules/ai-repo-companion.mdc` in the host repository root.");
  }
  if (editor === "both" || editor === "codex") {
    steps.push("Confirm Codex sees `AGENTS.md` in the host repository root.");
  }
  return steps;
}
