# AI Repo Companion Onboarding

## What this file is

This is the fastest way for a new developer to get back into the project.

If you only have 10-15 minutes, read this file first.

## What the project does in one sentence

It is a local control layer around AI-assisted repository work: it stores small notes, builds minimal context, decides when a live AI review is worth paying for, and tunes those rules over time.

## Read in this order

1. `README.md`
2. `docs/USER-GUIDE.md`
3. `docs/DEVELOPER-GUIDE.md`

If you are debugging behavior, then read:

4. `src/cli.mjs`
5. `src/lib/task-flow-engine.mjs`
6. `src/lib/review-worker.mjs`

## The three most important ideas

### 1. Knowledge stays in small notes

The project does not try to keep one giant memory blob.

Instead it stores:
- many small Markdown notes in `notes/`
- light links between those notes
- only small pointer lists in working memory

This is the main token-saving design choice.

### 2. Not every task should trigger a live AI call

The system tries to avoid expensive live review unless it looks useful.

That is why there are:
- `cheap`
- `balanced`
- `expensive`

And also:
- `saver`
- `balanced`
- `strict`

If you do not understand a behavior, it is usually because one of these policy layers made a decision.

### 3. Local guards matter as much as the model

The model does not write directly into memory files.

Instead it proposes structured operations, and local code decides:
- is it valid?
- is it good enough?
- is it duplicated?
- is it worth applying now?

So if the runtime behaves oddly, do not only inspect prompts. Also inspect the local guards.

## First commands to run

From `.ai-repo-companion/`:

```bash
npm test
node src/cli.mjs status
node src/cli.mjs doctor
node src/cli.mjs report
node src/cli.mjs benchmark
```

What they tell you:
- `npm test` - whether the integrated smoke flow still works
- `status` - current queue, metrics, benchmark summary, tuning summary
- `doctor` - what looks unhealthy and what to do next
- `report` - compact operator snapshot
- `benchmark` - synthetic cost/performance baseline

## If you need to understand one full task flow

Use this path:

1. `src/cli.mjs`
2. `src/lib/task-flow-engine.mjs`
3. `src/lib/task-engine.mjs`
4. `src/lib/context-engine.mjs`
5. `src/lib/memory-engine.mjs`
6. `src/lib/policy-engine.mjs`
7. `src/lib/review-worker.mjs`

That sequence explains almost the whole runtime.

## If something is wrong, start here

### The system is too expensive

Look at:
- `report`
- `status`
- `benchmark`
- `src/lib/review-value-gate-engine.mjs`
- `src/lib/policy-engine.mjs`
- `src/lib/policy-tuning-engine.mjs`

### The system is skipping too much

Look at:
- `report`
- `doctor`
- `src/lib/review-value-gate-engine.mjs`
- `src/lib/policy-engine.mjs`
- `config/system.json`

### Notes are noisy or strange

Look at:
- `src/lib/review-normalization-engine.mjs`
- `src/lib/review-quality-engine.mjs`
- `src/lib/review-idempotency-engine.mjs`
- `src/lib/review-ranking-engine.mjs`
- `src/lib/review-note-engine.mjs`

### Queue / worker behavior looks wrong

Look at:
- `src/lib/review-worker.mjs`
- `src/lib/review-runner.mjs`
- `src/lib/review-lock-engine.mjs`
- `state/memory/review-queue.json`
- `state/reviews/worker-state.json`

### Auto-tuning looks suspicious

Look at:
- `src/lib/policy-tuning-engine.mjs`
- `state/tuning/`
- `state/benchmarks/`
- `report`
- `doctor`

## The main files to remember

If you remember only these files, you can usually recover quickly:

- `src/cli.mjs`
- `src/lib/task-flow-engine.mjs`
- `src/lib/review-worker.mjs`
- `src/lib/policy-engine.mjs`
- `src/lib/policy-tuning-engine.mjs`
- `src/lib/benchmark-engine.mjs`
- `src/lib/runtime-status-engine.mjs`
- `config/system.json`

## The normal maintenance loop

When changing runtime behavior, use this order:

1. make the code change
2. run `npm test`
3. run `node src/cli.mjs benchmark`
4. run `node src/cli.mjs report`
5. verify the change did not only “work”, but also did not obviously hurt economics

## What not to do

- Do not make the model write free-form files directly.
- Do not add clever hidden state when a small JSON file is enough.
- Do not weaken safety guards just to get “more output”.
- Do not optimize only prompt size and ignore the number of live runs.

## Simple mental model

Think about the project as three loops:

1. task loop  
take a task, gather tiny context, maybe review, update memory

2. control loop  
measure cost, queue pressure, benchmark results, operator advice

3. tuning loop  
adjust policy, benchmark again, keep or roll back the change

If you know which loop you are in, the codebase becomes much easier to navigate.
