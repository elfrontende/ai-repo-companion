# AI Repo Companion User Guide

## What this project is

`AI Repo Companion` is a hidden local folder that you place inside a repository. It helps an AI assistant work with that repository without constantly dragging the whole project into every prompt.

The simple idea is:

1. keep project knowledge in small linked notes
2. give the AI only the notes that matter for the current task
3. skip expensive live AI calls when the task does not justify the cost
4. keep learning from finished work without making the user manage memory by hand

This project is local-first. It is meant to live in `.ai-repo-companion/` and usually should be ignored by git in the host repository.

## Who this is for

This is useful if you:

- work with AI on the same repository over time
- want lower token cost
- want less noisy context
- want project memory that builds up automatically
- want more control than a plain chat prompt gives you

This is probably not worth it if you:

- only ask one-off questions about random repositories
- do not care about token cost
- prefer a simple prompt-only workflow

## What it does in plain language

When you finish a task, the companion can:

- classify the task
- decide how risky or important it is
- gather only the most relevant notes
- choose whether to skip live AI review or run it
- update memory in a safe, local way

So instead of thinking of it as "another AI", think of it as:

- a memory manager
- a context filter
- a cost controller
- a local safety layer around live AI review

## Main concepts

### Atomic notes

The project stores knowledge in small notes instead of one huge memory file.

Why this matters:

- smaller notes are cheaper to retrieve
- easier to link
- easier to update
- easier to review later

### Review queue

Not every task should trigger a live AI call. The project can place review jobs in a queue and process them later.

Why this matters:

- you can separate cheap local maintenance from expensive model calls
- you can batch related work
- you can inspect what the system is trying to do

### Memory modes

The system has three broad modes:

- `cheap` - local-only work, no live AI call
- `balanced` - normal middle ground
- `expensive` - heavy review for risky or important work

### Cost modes

You can also ask for a cheaper or stricter runtime for one run:

- `saver` - more aggressive about saving tokens
- `balanced` - default
- `strict` - more likely to allow a heavier review

## Folder layout

Everything lives inside `.ai-repo-companion/`.

- `config/` - runtime settings
- `docs/` - human documentation
- `notes/` - atomic project notes
- `src/` - Node runtime
- `state/` - queue, memory, metrics, benchmark, tuning state
- `tests/` - smoke tests

## How to add it to your project

### 1. Copy the folder

Place `.ai-repo-companion/` in the root of your repository.

### 2. Ignore it in the host repo

Add this line to the host repository `.gitignore`:

```gitignore
.ai-repo-companion/
```

### 3. Initialize it

From the host repository root:

```bash
cd .ai-repo-companion
npm run init
```

### 4. Check that it works

```bash
npm run status
npm test
```

If both work, the local workspace is ready.

### 5. Generate host editor instructions

If the host repository will be used from Codex, Cursor, or both, generate the host-facing files:

```bash
npm run integrate -- --editor both
```

To write them directly into the host repository root:

```bash
npm run integrate -- --editor both --hostRoot .. --writeHostFiles
```

That produces:

- `AGENTS.md` for Codex
- `.cursor/rules/ai-repo-companion.mdc` for Cursor auto-load
- a preview pack in `state/integration/host-pack/`

## Everyday usage

## The simplest path

The easiest command is `task`.

Example:

```bash
npm run task -- \
  --task "design a migration-safe auth refactor" \
  --summary "Split auth boundary and capture rollout assumptions" \
  --artifacts "auth,tests,docs" \
  --reviewNow
```

This one command does:

1. task classification
2. agent planning
3. context retrieval
4. local memory sync
5. queue creation if needed
6. review processing if `--reviewNow` is present

## Useful daily commands

```bash
npm run status
npm run doctor
npm run report
npm run queue
npm run metrics
```

Use them like this:

- `status` - quick machine-readable state of runtime health
- `doctor` - warnings and suggested next actions
- `report` - compact operator summary
- `queue` - see waiting review jobs
- `metrics` - review and cost counters

## Live review

If you want a real live provider run:

```bash
npm run task -- \
  --task "design a migration-safe auth refactor" \
  --summary "Split auth boundary and capture rollout assumptions" \
  --reviewNow \
  --live
```

That uses the configured live provider path for the current runtime.

## Live multi-agent runtime

If you want the multi-agent execution graph to call a live provider for each step:

```bash
npm run task -- \
  --task "tighten deployment README wording" \
  --summary "Drive the live multi-agent runtime" \
  --agentLive \
  --agentProvider codex
```

Cursor works the same way:

```bash
npm run task -- \
  --task "tighten deployment README wording" \
  --summary "Drive the live multi-agent runtime" \
  --agentLive \
  --agentProvider cursor
```

For non-native backends, configure `multiAgentRuntime.commandAdapters` and use:

```bash
npm run task -- \
  --task "tighten deployment README wording" \
  --summary "Drive the live multi-agent runtime" \
  --agentLive \
  --agentProvider external \
  --agentCommandProvider external
```

## Cost control examples

Cheaper one-off run:

```bash
npm run task -- \
  --task "tighten README wording" \
  --summary "Docs cleanup" \
  --reviewNow \
  --live \
  --costMode saver
```

Stricter one-off run:

```bash
npm run review -- \
  --jobId memjob-123 \
  --live \
  --costMode strict \
  --reviewProfile heavy
```

## Approval flow

Some jobs are intentionally not applied automatically.

Typical examples:

- `expensive` review jobs
- `security` domain review jobs

In these cases the system may prepare changes but wait for approval.

To apply a pending suggestion:

```bash
npm run approve -- --jobId memjob-123
```

## Benchmarking

If you want to see whether the current config is economical:

```bash
npm run benchmark
```

You can also run narrower suites:

```bash
npm run benchmark -- --suite low-risk
npm run benchmark -- --suite high-risk
```

And longer canary cycles:

```bash
npm run benchmark -- --iterations 5 --autoTuneBetweenRuns
```

This helps answer:

- is the current config still cheap?
- is `saver` actually better than `balanced`?
- is tuning helping or making things worse?

## Tuning

The system can suggest bounded config changes.

Preview:

```bash
npm run tune
```

Preview only one phase:

```bash
npm run tune -- --phase cheap-domains
```

Apply suggestions manually:

```bash
npm run tune -- --apply
```

Bounded auto-tune:

```bash
npm run tune -- --auto
```

Check whether the last auto-tune should be accepted or rolled back:

```bash
npm run tune -- --reconcile
```

## The most important settings

Most people only need to understand a few groups in `config/system.json`.

### Retrieval

This controls how much note context the system pulls in.

Important keys:

- `defaultTokenBudget`
- `maxNotesPerBundle`

Lower values:

- cheaper
- faster
- risk missing useful context

Higher values:

- broader context
- more expensive
- more risk of noise

### Memory policy

This controls when the system stays local and when it queues review work.

Important ideas:

- same-domain activity can escalate review
- duplicated notes can escalate review
- some domains can jump directly to heavier review

### Review execution

This controls live review behavior.

Important areas:

- provider selection
- value gate
- review profiles
- ranking
- approval
- retention
- recovery

### Value gate

This is one of the most important cost controls.

It answers:

"Does this review job look valuable enough to spend a live AI call on?"

If the answer is "probably not", the job is skipped locally.

### Approval

This answers:

"Even if the model produced a good suggestion, do we still want a human checkpoint before changing durable memory?"

### Recovery

This protects the system if the process fails during note apply.

## What affects cost the most

The biggest cost drivers are usually:

- how many live review calls happen
- how often weak jobs are skipped before model call
- how large the selected note bundle is
- how often heavy review profiles are used

In practice, the biggest savings often come from:

- not running a live review at all for weak jobs
- keeping `balanced` cheap
- only using `expensive` for truly risky work

## Common expectations

### "Will this always save tokens?"

Usually yes over time, but not on every single task.

Why:

- some hard tasks still need a real live model call
- expensive tasks can still cost a lot
- the biggest savings come from filtering weak tasks, not from magic prompt shrinking alone

### "Will it always produce better output than plain prompting?"

Not always.

The main purpose is:

- better cost control
- better context hygiene
- safer memory updates

On some tasks plain prompting can still produce more raw ideas. The project tries to trade a little recall for better control and lower waste.

### "Does it change my project files?"

It changes files inside `.ai-repo-companion/`.  
It is not designed to modify your host repository application code by itself.

## Good default workflow

If you do not want to think much, use this pattern:

1. do work in your normal tools
2. run `npm run task -- --task "... " --summary "... " --reviewNow`
3. check `npm run report`
4. if needed, check `npm run doctor`
5. occasionally run `npm run benchmark`
6. only tune when benchmark and doctor keep showing stable waste

## When to be careful

Be careful if:

- you lower gates too much and start paying for weak live reviews
- you auto-tune too aggressively without checking benchmark evidence
- you treat the benchmark as truth instead of as local evidence
- you assume every selected note change is equally useful

## Short summary

The easiest way to understand the project is:

- it is a local AI memory and cost controller
- it helps AI use less context
- it tries to skip weak expensive runs
- it keeps memory updates safe
- it can locally measure and tune itself

If you only remember one thing, remember this:

`AI Repo Companion` is not mainly about "making AI smarter". It is mainly about making AI work in a repository **more controlled, more economical, and easier to trust over time**.
