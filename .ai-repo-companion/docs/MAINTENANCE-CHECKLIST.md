# AI Repo Companion Maintenance Checklist

## What this file is

This is a practical checklist for keeping the runtime healthy over time.

It is not a deep architecture document.

Use it when you want to answer:
- is the system still healthy?
- is it still cheap enough?
- did recent tuning help or hurt?
- are notes and queues staying under control?

## When to use it

Run this checklist:
- before a release
- after a bigger config change
- after changing benchmark or tuning logic
- after changing review or memory policy
- after a long break from the project

## The short version

From `.ai-repo-companion/`:

```bash
npm test
node src/cli.mjs status
node src/cli.mjs doctor
node src/cli.mjs report
node src/cli.mjs benchmark
```

If all of these look sane, the system is usually fine.

## 1. Basic health

### Run

```bash
npm test
```

### Expect

- smoke test passes
- no runtime crash

### If it fails

Start with:
- `src/cli.mjs`
- `src/lib/task-flow-engine.mjs`
- `src/lib/review-worker.mjs`

This usually means a core flow broke, not just a docs issue.

## 2. Runtime health

### Run

```bash
node src/cli.mjs status
node src/cli.mjs doctor
```

### Expect

- queue is not growing forever
- worker state is sane
- no stuck recovery session
- no stale lock that never clears
- no repeated high-severity doctor findings

### Red flags

- many queued jobs but little processing
- repeated approval or recovery problems
- benchmark marked stale for too long
- tuning canary stuck in pending/rollback loops

## 3. Cost health

### Run

```bash
node src/cli.mjs report
```

### Expect

- `whyExpensive` makes sense
- `topWasteDomains` are understandable
- `safeSavingsOpportunities` are not obviously nonsense
- `compactSummary` still describes the system honestly

### Red flags

- system suddenly spends more, but report does not explain why
- one cheap domain dominates token burn for too long
- system keeps recommending the same savings action but economics do not improve

## 4. Benchmark health

### Run

```bash
node src/cli.mjs benchmark
```

Optional:

```bash
node src/cli.mjs benchmark --suite low-risk
node src/cli.mjs benchmark --suite high-risk
```

### Expect

- benchmark completes normally
- the cheapest variant result is believable
- confidence is not permanently low
- the signal is not completely noisy

### Red flags

- benchmark confidence stays low for a long time
- cheapest variant flips too often without clear cause
- `saver` and `balanced` look random from run to run

## 5. Tuning health

### Run

```bash
node src/cli.mjs tune
```

Optional:

```bash
node src/cli.mjs tune --auto
node src/cli.mjs tune --reconcile
```

### Expect

- tuning suggestions are understandable
- tuning phases look ordered in a sensible way
- expected impact hints are believable
- auto-tune does not suggest reckless global changes first

### Red flags

- tuning plan jumps too quickly to global changes
- rollback keeps happening on the same phase
- phase explanations no longer match actual runtime behavior

## 6. Long-run evidence health

### What to check

Look in:
- `report`
- `status`
- `doctor`

And focus on:
- benchmark trend confidence
- cycle confidence
- window history
- before/after tuning evidence
- rollback evidence

### Expect

- recent windows tell a coherent story
- rollback happens rarely and for understandable reasons
- cycle signal is not permanently contradictory

### Red flags

- every recent window says something different
- rollback fires often with no stable pattern
- evidence looks noisy, but tune still pushes aggressive changes

## 7. Notes health

### What to inspect

Look at a few files in `notes/`.

### Expect

- notes are still small
- titles are understandable
- review-created notes are not exploding in count
- links look sensible
- important knowledge is not duplicated five times

### Red flags

- many near-duplicate notes
- giant notes full of repeated updates
- broken or meaningless link patterns

If this starts happening, inspect:
- `review-idempotency-engine.mjs`
- `review-quality-engine.mjs`
- `review-ranking-engine.mjs`
- `review-note-engine.mjs`

## 8. Queue health

### What to inspect

Look at:
- `state/memory/review-queue.json`
- `state/reviews/worker-state.json`

### Expect

- jobs move through the queue
- compaction is working for related tasks
- old jobs are not sitting forever without reason

### Red flags

- queue keeps growing
- many stale jobs
- jobs never leave `awaiting-approval`
- same type of job gets repeatedly requeued with no outcome

## 9. When to tune

Tune when:
- cheap domains keep burning tokens
- `doctor` repeatedly points to the same domain drift
- benchmark and cycle evidence agree that `balanced` is too heavy

Do not tune aggressively when:
- benchmark confidence is low
- signal is noisy
- rollback just happened
- you changed runtime logic and have not rebuilt evidence yet

## 10. Safe maintenance loop

This is the default loop to follow after a meaningful change:

1. change code or config
2. run `npm test`
3. run `node src/cli.mjs benchmark`
4. run `node src/cli.mjs report`
5. if needed, run `node src/cli.mjs tune`
6. if auto-tune was used, run a fresh benchmark and then `tune --reconcile`

## The most important rule

Do not optimize only for “more AI output”.

The project is healthy when it keeps a good balance between:
- low token spend
- useful memory updates
- understandable behavior
- safe local control

If one of those collapses, the system is not healthy, even if one metric looks better.
