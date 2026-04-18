# AI Repo Companion

`AI Repo Companion` is a local-only hidden workspace that can be dropped into any repository and ignored with one entry in the host project's `.gitignore`.

## Goals

- keep AI-specific state outside the main repository surface
- minimize token usage by retrieving only atomic notes that match the current task
- keep persistent memory almost empty and store durable knowledge in linked Zettelkasten notes
- maintain a reusable agent registry that survives across chats
- run memory updates as a background-style pipeline after every task

## Layout

All files live under one hidden directory:

- `config/` static system configuration
- `notes/` atomic Zettelkasten notes
- `state/agents/` reusable agent registry
- `state/memory/` event log and pointer-only working memory
- `src/` zero-dependency Node runtime
- `tests/` smoke test

## Quick start

From the repository root:

```bash
cd .ai-repo-companion
npm run init
npm run plan -- --task "design a migration-safe auth refactor"
npm run policy -- --task "design a migration-safe auth refactor"
npm run context -- --task "design a migration-safe auth refactor" --budget 900
npm run sync -- --task "design a migration-safe auth refactor" --summary "Split auth boundary, add tests, capture migration assumptions"
npm run queue
npm run review -- --maxJobs 1
npm test
```

## What is implemented

- agent registry with reusable base agents
- dynamic agent creation when a task reveals a missing specialty
- task classification and automatic effort/provider/model routing
- context bundling from atomic notes under a token budget
- note/event synchronization with automatic link rebuilding
- pointer-only working memory so long-term knowledge remains in notes
- memory policy engine with `cheap`, `balanced`, and `expensive` review modes
- queued review jobs for future LLM-backed memory cleanup instead of hidden always-on background costs
- review worker that consumes queued jobs and stores execution reports
- pluggable provider adapter layer with `dry-run` and `command` execution modes

## Memory modes

The workspace now has three memory maintenance modes:

- `cheap`: always-on default. Only local file operations happen after a task. No extra reasoning job is queued.
- `balanced`: still performs local sync first, but also queues one small memory review job when a domain gets messy or active.
- `expensive`: reserved for architectural, migration, or security-heavy tasks. Queues a larger review job with a bigger token budget.

Mode selection is driven by `config/system.json`:

- `sameDomainEventThreshold`: how many tasks in one domain should accumulate before cleanup is suggested
- `duplicateCandidateThreshold`: how many overlapping notes should exist before cleanup is suggested
- `hardTriggers`: domains that can escalate directly to `expensive`

Persistent policy state lives in:

- `state/memory/policy-state.json` for recent mode decisions and domain counters
- `state/memory/review-queue.json` for queued memory review jobs
- `state/reviews/history.jsonl` for executed review runs
- `state/reviews/reports/` for per-job execution reports

## Typical flow

1. `plan` classifies the task and chooses agents.
2. `policy` or `plan` predicts which memory mode should be used.
3. `context` retrieves only the smallest useful set of atomic notes.
4. Main task execution happens in the external provider adapter layer.
5. `sync` always performs local memory maintenance.
6. If policy says `balanced` or `expensive`, `sync` also queues a future review job instead of silently spending extra tokens immediately.
7. `review` consumes queued jobs through a provider adapter and stores a report.

This design keeps hidden token burn under control: the local sync path is always deterministic, while deeper memory reasoning becomes explicit and inspectable.

## Review worker

There are now two separate stages after a task:

- `sync`: update files locally and decide whether deeper memory review is needed
- `review`: consume queued review jobs later, either in batches or one-by-one

Useful commands:

```bash
node src/cli.mjs queue
node src/cli.mjs review --maxJobs 2
node src/cli.mjs review --jobId memjob-20260418120000000
```

By default, the worker uses the `dry-run` adapter. That means:

- no external AI is called
- a full execution payload is still prepared
- the prepared prompt and bounded context bundle are written into a report file

This makes the pipeline safe to test before any provider integration exists.

## Codex first

The first native provider path is Codex.

When `reviewExecution.nativeCodex.enabled=true`, the worker will:

1. build a bounded review prompt
2. call `codex exec`
3. force a JSON-only response through a schema
4. apply returned note operations locally

Supported structured operations today:

- `append_note_update`
- `create_note`

The model does not edit note files directly. It only proposes structured operations, and local code applies them. This is safer and easier to debug than letting an LLM write free-form Markdown into the note graph.

Example config:

```json
"reviewExecution": {
  "defaultAdapter": "dry-run",
  "providerByMode": {
    "balanced": "codex",
    "expensive": "codex"
  },
  "nativeCodex": {
    "enabled": true,
    "model": "",
    "sandbox": "workspace-write",
    "extraArgs": []
  }
}
```

Leave `model` empty to use your Codex CLI default, or set it explicitly if you want a dedicated review model.

## Connecting other providers

Real execution is configured in `config/system.json` under `reviewExecution.commandAdapters`.

Each provider can later be wired to a local CLI command:

```json
"reviewExecution": {
  "defaultAdapter": "dry-run",
  "commandAdapters": {
    "claude": {
      "enabled": true,
      "command": "my-claude-wrapper",
      "args": ["review", "--mode", "{mode}"]
    }
  }
}
```

When enabled, the worker will send the review payload JSON to that command via stdin. This keeps the core runtime provider-agnostic and lets each repository choose how to connect Claude, Codex, Gemini, or Cursor later.

## What is intentionally not implemented yet

- direct provider SDK execution for Claude, Codex, Gemini, or Cursor
- embeddings or vector databases
- file watchers or daemonized background workers

The current scaffold is the orchestration and memory layer that those adapters can plug into later.
