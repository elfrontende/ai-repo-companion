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
npm run task -- --task "design a migration-safe auth refactor" --summary "Split auth boundary, add tests, capture migration assumptions" --reviewNow
npm run task -- --task "design a migration-safe auth refactor" --summary "Split auth boundary, add tests, capture migration assumptions" --reviewNow --live
npm run queue
npm run metrics
npm run tune
npm run tune -- --apply
npm run review -- --maxJobs 1
npm run worker -- --maxJobs 1
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
- queue compaction so closely related review jobs can merge before they spend another live model run
- review worker that consumes queued jobs and stores execution reports
- background review runner with `once` and `loop` modes
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
- `state/reviews/metrics.json` for local observability counters and latency summaries

## Typical flow

1. `plan` classifies the task and chooses agents.
2. `policy` or `plan` predicts which memory mode should be used.
3. `context` retrieves only the smallest useful set of atomic notes.
4. Main task execution happens in the external provider adapter layer.
5. `sync` always performs local memory maintenance.
6. If policy says `balanced` or `expensive`, `sync` also queues a future review job instead of silently spending extra tokens immediately.
7. `review` consumes queued jobs through a provider adapter and stores a report.

If you want one command instead of separate `sync` and `review` calls, use:

```bash
node src/cli.mjs task --task "design a migration-safe auth refactor" \
  --summary "Split auth boundary, add tests, capture migration assumptions" \
  --artifacts "auth,tests,docs" \
  --reviewNow
```

That command runs:

1. task classification
2. agent planning
3. bounded context assembly
4. local memory sync
5. queue creation when policy requires it
6. immediate review processing when `--reviewNow` is present

This is the easiest Codex-first flow to use after finishing a task.

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
node src/cli.mjs review --jobId memjob-20260418120000000 --live
node src/cli.mjs review --jobId memjob-20260418120000000 --live --model gpt-5.4
node src/cli.mjs approve --jobId memjob-20260418120000000
node src/cli.mjs worker --maxJobs 1
node src/cli.mjs worker --loop --intervalSeconds 30 --stopWhenEmpty
```

By default, the worker uses the `dry-run` adapter. That means:

- no external AI is called
- a full execution payload is still prepared
- the prepared prompt and bounded context bundle are written into a report file

This makes the pipeline safe to test before any provider integration exists.

Queue compaction is now enabled by default. When two nearby queued jobs share
the same mode and at least one domain, the second job can merge into the first
one instead of creating another live review run. The merged job keeps a
`tasks` list and `mergedTaskCount`, so the later review prompt still sees the
full batch context.

Stale-job policy is also enabled by default:

- `stale` jobs are still allowed to run, but the worker marks them as stale and tells the model to rebuild judgment from current note snippets
- `expired` jobs are skipped locally instead of spending a live model call on an outdated queue entry

This reduces the chance of paying for review runs whose original queue reasons are no longer trustworthy.

Review retention is also enabled by default:

- old JSON reports in `state/reviews/reports/` are trimmed by count
- old lines in `state/reviews/history.jsonl` are trimmed by count
- current queue items are not touched, so retention only limits past execution artifacts

This keeps the local review trail bounded without letting report files and history logs grow forever.

Local review observability is enabled by default:

- every processed review run updates `state/reviews/metrics.json`
- metrics track queue latency, approval latency, apply rate, rejection/defer counts, recovery runs, and approval expiry outcomes
- `node src/cli.mjs metrics` prints a compact local summary for policy tuning

This gives the pipeline enough signal for later tuning without adding any external telemetry dependency.

Policy tuning is now metrics-aware:

- `node src/cli.mjs tune` reads local review metrics and proposes bounded config changes
- `node src/cli.mjs tune --apply` writes only the safe, auto-apply suggestions back into `config/system.json`
- the tuner currently adjusts queue pressure, ranking strictness, apply budget, and approval TTL

This keeps policy iteration lightweight: collect local evidence first, then nudge the config instead of re-guessing thresholds by hand.

Review recovery is enabled by default too:

- before note apply, the worker snapshots the whole `notes/` directory
- if the process dies during apply, the next worker run restores that backup
- the interrupted job is put back into `queued` so the review can replay safely

This keeps append-style note updates from being double-applied after a crash or half-finished local write.

Review approval is now enabled by default for sensitive runs:

- `expensive` review jobs stop in `suggest-only` mode by default
- any job that touches the `security` domain also stops before local note apply
- the worker writes a pending approval file to `state/reviews/approvals/`
- a human can then run `approve --jobId ...` to apply the already-ranked operations through the same recovery-safe path

This gives high-risk review runs a manual checkpoint without losing the rest of the automated Codex-first pipeline.

Pending approvals are also time-bounded now:

- `pendingApprovalTtlMinutes` controls how long a job may wait in `awaiting-approval`
- `onExpired: "requeue"` is the default and sends the job back through a fresh review pass
- `onExpired: "expire"` closes the pending approval without applying note changes

This prevents old approval snapshots from sitting around until they no longer match the current note graph.

Runtime locking is enabled by default:

- every `review` or `worker` run first tries to acquire `state/reviews/worker-lock.json`
- if another fresh process already owns the lock, the new run exits cleanly without touching the queue
- stale locks are broken automatically after `runtimeLock.maxAgeMinutes`

This prevents two local processes from mutating the review queue and note graph at the same time.

## Codex first

The first native provider path is Codex.

When `reviewExecution.nativeCodex.enabled=true`, the worker will:

1. build a bounded review prompt
2. call `codex exec`
3. force a JSON-only response through a schema
4. apply returned note operations locally

Supported structured operations today:

- `append_note_update`
- `merge_note_into_existing`
- `create_note`

The model does not edit note files directly. It only proposes structured operations, and local code applies them. This is safer and easier to debug than letting an LLM write free-form Markdown into the note graph.

Important Codex detail:

- the output schema now requires every operation key to be present
- unused text fields must be returned as `""`
- unused list fields must be returned as `[]`

This looks verbose, but it matches the current Codex JSON schema requirements and keeps live runs stable.

Codex live safety now has two extra layers:

- retry/backoff: native Codex review can retry once or more when the CLI fails or the output JSON cannot be parsed
- quality gate: even valid JSON is filtered before apply, so tiny summaries or low-signal note writes are rejected instead of being saved

These defaults live in `config/system.json`:

```json
"nativeCodex": {
  "enabled": false,
  "model": "",
  "sandbox": "workspace-write",
  "maxAttempts": 2,
  "retryBackoffMs": 1500,
  "extraArgs": []
}
```

Quality gate rules are intentionally simple:

- `create_note` must have a meaningful title, summary, tags, and at least two signals
- `append_note_update` must target a real note and add some real signal
- `merge_note_into_existing` must reference real notes and explain the merge

If all operations fail the gate, the review run is still reported, but no note files are modified.

There is now a third local safety layer before the quality gate:

- link normalization: if Codex returns a note title like `Atomic Zettelkasten notes` instead of a note id like `z-110-atomic-notes`, the worker tries to resolve it locally before quality checks run

This matters because model outputs are often semantically correct but not graph-safe. The local runtime now prefers fixing those references automatically instead of rejecting the whole review.

The quality gate now also blocks semantically bad links:

- no self-links like `z-000-index -> z-000-index`
- index updates must point to at least one other note
- merge updates cannot add the target note as its own extra link

After normalization and quality checks, the runtime now ranks accepted operations before apply:

- durable note creation is preferred over lightweight index edits
- architectural and decision notes score higher than generic updates
- low-value but still valid updates can be deferred when the apply budget is exhausted

Current defaults:

- `maxAppliedOperations`: `2`
- `minScore`: `35`

There is now one more local guard after quality checks:

- idempotency guard: if Codex proposes a `create_note` that is too similar to an existing note, the runtime now rewrites it into an `append_note_update` for that note instead of creating a near-duplicate review note on every neighboring run

This keeps the graph cleaner when the model keeps rediscovering the same durable idea with slightly different wording.

If you want the stricter old behavior, set:

```json
"idempotency": {
  "minSimilarityScore": 7,
  "rewriteDuplicatesToAppendUpdate": false
}
```

In strict mode, duplicate `create_note` operations are rejected instead of being rewritten.

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

For one-off runs, you do not need to edit the config file. The CLI supports an ephemeral live mode:

```bash
node src/cli.mjs review --jobId memjob-20260418120000000 --live
```

That command temporarily forces the current review run through native Codex, but does not rewrite `system.json`.

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

## Background runner

The repository now includes a lightweight automatic runner in `src/lib/review-runner.mjs`.

It supports two styles:

- `once`: process a batch of queued review jobs and stop
- `loop`: keep polling on an interval until manually stopped or until the queue is empty

Worker state is stored in `state/reviews/worker-state.json`.

This is intentionally simple:

- no hidden daemon install
- no OS-specific service manager logic
- can be launched from shell, cron, launchd, or systemd later

## What is intentionally not implemented yet

- direct provider SDK execution for Claude, Codex, Gemini, or Cursor
- embeddings or vector databases
- file watchers or daemonized background workers

The current scaffold is the orchestration and memory layer that those adapters can plug into later.
