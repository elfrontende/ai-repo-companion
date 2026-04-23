# AI Repo Companion Developer Guide

## Why this guide exists

This guide is for the next person who has to maintain or extend the project.

The goal is not to explain every line of code. The goal is to make the project easy to re-enter after a long break.

If you are new to the codebase, read this file in order:

0. `docs/ONBOARDING.md`
1. architecture map
2. main flows
3. configuration model
4. testing and benchmarking
5. common maintenance tasks

If you are not new, but you want a fast recurring health check, open:

- `docs/MAINTENANCE-CHECKLIST.md`

## Project idea in developer terms

This project is a local runtime around AI-assisted repository work.

It does four jobs:

1. stores durable knowledge in atomic notes
2. builds bounded context bundles for tasks
3. runs a guarded live review flow when needed
4. measures and tunes its own cost policy

The project is intentionally:

- local-first
- file-based
- zero-dependency
- inspectable through JSON and Markdown

## File map

### Top-level folders

- `config/` - runtime configuration
- `docs/` - human documentation
- `notes/` - durable knowledge graph
- `src/` - CLI and runtime modules
- `state/` - mutable runtime state
- `tests/` - smoke test

### `src/` modules by responsibility

#### Core task path

- `cli.mjs` - command entrypoint
- `task-engine.mjs` - classify tasks
- `agent-engine.mjs` - choose agents
- `context-engine.mjs` - load notes and build context bundles
- `task-flow-engine.mjs` - one-command finish-task flow

#### Memory and policy

- `memory-engine.mjs` - local event and note sync
- `policy-engine.mjs` - choose `cheap / balanced / expensive`
- `review-value-gate-engine.mjs` - skip weak balanced review jobs before model call
- `review-cost-mode-engine.mjs` - one-run cost overrides

#### Review execution

- `review-worker.mjs` - queue consumer and review orchestrator
- `provider-engine.mjs` - provider adapters
- `review-note-engine.mjs` - apply structured note changes
- `review-normalization-engine.mjs` - normalize model output
- `review-quality-engine.mjs` - reject weak operations
- `review-idempotency-engine.mjs` - avoid duplicates
- `review-ranking-engine.mjs` - pick best operations
- `review-approval-engine.mjs` - suggest-only / approval flow
- `review-recovery-engine.mjs` - rollback if note apply fails
- `review-lock-engine.mjs` - guard against concurrent workers
- `review-runner.mjs` - worker loop wrapper

#### Observability and tuning

- `review-metrics-engine.mjs` - local counters and summaries
- `benchmark-engine.mjs` - synthetic benchmark and cycles
- `policy-tuning-engine.mjs` - tuning suggestions, auto-tune, reconcile
- `runtime-status-engine.mjs` - `status` and `doctor`
- `runtime-report-engine.mjs` - compact operator report

#### Shared utilities

- `bootstrap.mjs` - initialize workspace layout
- `store.mjs` - file helpers
- `note-parser.mjs` - frontmatter and token helpers

## The main runtime flows

## 1. Task flow

This is the easiest mental model.

Entry:

- `node src/cli.mjs task ...`

Sequence:

1. classify task
2. plan agents
3. assemble bounded context
4. sync memory locally
5. evaluate memory policy
6. queue review if needed
7. optionally process review immediately

Main file:

- `src/lib/task-flow-engine.mjs`

## 2. Review flow

Entry:

- `node src/cli.mjs review ...`
- `node src/cli.mjs worker ...`

Sequence:

1. acquire worker lock
2. recover interrupted apply if needed
3. expire stale approvals if needed
4. pull queued jobs
5. check staleness
6. check value gate
7. build provider payload
8. run provider
9. normalize operations
10. quality gate
11. idempotency guard
12. ranking
13. approval check if needed
14. apply note changes or wait for approval
15. write metrics, report, queue state

Main file:

- `src/lib/review-worker.mjs`

## 3. Tuning flow

Entry:

- `node src/cli.mjs tune`
- `node src/cli.mjs tune --auto`
- `node src/cli.mjs tune --reconcile`

Sequence:

1. read metrics
2. read latest benchmark
3. generate bounded suggestions
4. group them into ordered phases
5. apply manually or bounded auto-apply
6. record canary
7. later reconcile using a fresher benchmark
8. keep or roll back changes

Main file:

- `src/lib/policy-tuning-engine.mjs`

## 4. Benchmark flow

Entry:

- `node src/cli.mjs benchmark`
- `node src/cli.mjs benchmark --iterations 5 --autoTuneBetweenRuns`

Sequence:

1. build synthetic tasks
2. evaluate variants:
   - `saver`
   - `balanced`
   - `strict`
   - `baseline`
3. compute per-task and aggregate deltas
4. append benchmark history
5. compute trends and confidence
6. optionally run cycles with tuning between iterations

Main file:

- `src/lib/benchmark-engine.mjs`

## How the knowledge graph works

Notes in `notes/` are the durable memory.

The project intentionally avoids a giant memory blob.

Each note should be:

- small
- focused
- linkable
- cheap to retrieve

Important rule:

- long-term knowledge belongs in `notes/`
- temporary pointers belong in `state/memory/working-memory.json`

## Configuration mental model

Most configuration lives in `config/system.json`.

Read it in these sections:

### Retrieval

Controls how much context can be selected.

Use this when:

- context is too noisy
- retrieval is too broad
- prompt cost is too high

### Memory policy

Controls mode selection and queue creation.

Use this when:

- too many tasks go straight to review
- too few tasks ever reach review

### Review execution

Controls the expensive path.

Use this when:

- live reviews cost too much
- quality gates are too strict or too weak
- approval is too frequent or too rare
- queue behavior feels wrong

### Tuning

Controls benchmark history, auto-apply, rollback, and confidence windows.

Use this when:

- auto-tune is too timid
- auto-tune is too aggressive
- benchmark evidence is too noisy

## How to debug the system

## Start with operator commands

Usually you do not need to open files first.

Run:

```bash
npm run status
npm run doctor
npm run report
```

Use them like this:

- `status` - current machine-readable state
- `doctor` - findings and suggested next actions
- `report` - condensed operator snapshot

## Then inspect state files

Most useful files:

- `state/memory/review-queue.json`
- `state/reviews/metrics.json`
- `state/reviews/history.jsonl`
- `state/reviews/reports/`
- `state/tuning/last-tuning.json`
- `state/benchmarks/last-benchmark.json`

## Then inspect code

Common mapping:

- wrong context -> `context-engine.mjs`
- wrong mode selection -> `policy-engine.mjs`
- skipped live review -> `review-value-gate-engine.mjs`
- weird provider behavior -> `provider-engine.mjs`
- model output rejected -> normalization / quality / idempotency / ranking modules
- odd tuning suggestion -> `policy-tuning-engine.mjs`

## Testing strategy

There is one main smoke test file:

- `tests/smoke.mjs`

It is intentionally broad. It covers:

- workspace bootstrap
- planning
- memory sync
- policy
- queue flow
- provider stubs
- normalization and quality gates
- approval
- recovery
- runtime status/doctor/report
- benchmark and tuning

Run:

```bash
npm test
```

## Benchmarking strategy

Benchmark is the main evidence loop.

Run:

```bash
npm run benchmark
```

Useful variants:

```bash
npm run benchmark -- --suite low-risk
npm run benchmark -- --suite high-risk
npm run benchmark -- --corpus synthetic-noise
npm run benchmark -- --iterations 5 --autoTuneBetweenRuns
```

The default benchmark uses the real note corpus. Use `--corpus synthetic-noise` only when you want to stress retrieval under artificial clutter and compare that against the real-corpus baseline.

Use benchmark results to answer:

- is current policy still economical?
- is `saver` consistently beating `balanced`?
- is a domain noisy or stable?
- did the last tune help or hurt?

## How to read benchmark output

The benchmark compares several runtime profiles against a naive baseline using the current note corpus by default.

### What `baseline` means

`baseline` is the control case. It represents a simpler "plain prompting"
style where the runtime does not benefit from the same cost-saving policy.

This matters because it gives you a stable question:

- is the current runtime cheaper than a naive approach?
- is it still useful after the savings?

### What the main numbers mean

- `totalTokens` - how many live tokens the run used
- `reductionPercent` - how much cheaper a profile is than `baseline`
- `cheapestVariant` - which runtime profile currently wins on cost
- `confidence` - how much the runtime trusts that the signal is stable
- `windowHistory` / `multiCycle` - whether this looks like a one-off result or a longer trend

### How to interpret a good benchmark

A good benchmark usually looks like:

- `balanced` or `saver` consistently cheaper than `baseline`
- no large regression in useful selected operations
- benchmark confidence not marked as weak
- no obvious drift warnings in `doctor`

If cost is better but confidence is low, do not rush into tuning. Run another benchmark or a cycle first.

## Test layers

The project currently has three practical evidence layers:

### 1. Smoke tests

Run with:

```bash
npm test
```

Purpose:

- catch broken loops
- catch broken JSON shape expectations
- catch state-flow regressions

### 2. Synthetic benchmark

Run with:

```bash
npm run benchmark
```

Purpose:

- compare runtime profiles
- compare runtime vs baseline
- generate cost evidence

### 3. Benchmark cycle

Run with:

```bash
npm run benchmark -- --iterations 5 --autoTuneBetweenRuns
```

Purpose:

- see whether tuning helps across multiple runs
- see whether the system is stabilizing or oscillating
- feed canary and rollback logic with longer evidence

## How to add a new feature safely

Recommended order:

1. decide which layer it belongs to
2. add or update comments first if the change is conceptually tricky
3. implement the smallest bounded change
4. extend smoke tests
5. update docs
6. if economics changed, run benchmark

## Where to add new logic

### New runtime command

Add it to:

- `src/cli.mjs`

Keep command handlers thin. Business logic should live in `src/lib/`.

### New policy rule

Add it to:

- `policy-engine.mjs` if it changes memory mode
- `review-value-gate-engine.mjs` if it changes pre-live gating
- `policy-tuning-engine.mjs` if it changes tuning behavior

### New provider behavior

Add it to:

- `provider-engine.mjs`

Keep the worker provider-agnostic. The worker should still only see structured execution results.

### New report or diagnostics field

Add it to:

- `runtime-status-engine.mjs`
- `runtime-report-engine.mjs`

Try to keep operator-facing fields short and explorable.

## Important maintenance rules

### Keep durable memory small and linked

Avoid adding giant notes or giant persistent blobs.

### Prefer skipping weak live runs

The project usually wins on cost by not running low-value reviews, not by magically making each model call tiny.

### Keep tuning bounded

Do not let tuning mutate arbitrary config keys. The project is safer because auto-tune is narrow and reversible.

### Keep operator outputs readable

If a new field makes `status`, `doctor`, or `report` much harder to scan, it probably needs a better summary layer.

## Common maintenance tasks

### Rebuild confidence in the current config

```bash
npm run benchmark
npm run doctor
npm run report
```

### Preview tuning

```bash
npm run tune
npm run tune -- --phase cheap-domains
```

### Apply one tuning phase

```bash
npm run tune -- --apply --phase cheap-domains
```

### Validate the last auto-tune

```bash
npm run benchmark
npm run tune -- --reconcile
```

## A good mental model for future maintenance

This project is easiest to maintain if you think of it as three loops:

### Loop 1: knowledge loop

task -> local sync -> notes

### Loop 2: review loop

queued job -> provider -> guards -> safe note change

### Loop 3: economics loop

metrics + benchmark -> tune -> benchmark -> reconcile

If you can place a bug or a feature inside one of those loops, you usually know where to work next.

## Short summary

For maintenance purposes, this project is best understood as:

- a local memory graph
- a guarded review runner
- a benchmark-driven cost control system

If you keep those three ideas clear, the codebase stays understandable.
