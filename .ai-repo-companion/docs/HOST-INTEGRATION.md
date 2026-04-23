# Host Integration Guide

This guide is for the real repository where the companion will run, especially when:

- the host repo is private or under NDA
- the live operator is a different AI
- you need post-run audit artifacts without exposing the host code here

## Goal

Treat `.ai-repo-companion/` as a portable control plane:

- memory and context selection
- multi-agent orchestration
- guarded review and approval
- operator reports and replayable run artifacts

The host AI works in the real repository. The companion provides the execution discipline around that work.

## Supported backends

The runtime now supports three agent execution styles:

1. `codex-native`
2. `cursor-native`
3. `command`

The generic path is `provider-runtime`, which maps logical agent providers to one of those concrete backends.

## Integration options

### 1. Codex host instructions

Host repositories can load `AGENTS.md` automatically. Generate it with:

```bash
npm run integrate -- --editor codex
```

Or write it into the host root directly:

```bash
npm run integrate -- --editor codex --hostRoot .. --writeHostFiles
```

### 2. Cursor auto-load rules

Cursor project rules live under `.cursor/rules/*.mdc`.

If you need a step-by-step setup for an existing host repository, read:

- `docs/CURSOR-EXISTING-PROJECT-SETUP.md`

Generate the rule pack with:

```bash
npm run integrate -- --editor cursor
```

Or write it directly into the host root:

```bash
npm run integrate -- --editor cursor --hostRoot .. --writeHostFiles
```

The generated rule uses `alwaysApply: true`, so Cursor should pick it up automatically from the host repository root.

### 3. Both editors

Most teams should generate both:

```bash
npm run integrate -- --editor both --hostRoot .. --writeHostFiles
```

## Recommended rollout

Start conservatively on a new host repository.

1. `shadow` or `advisory` first
2. docs and notes only
3. low-risk test scaffolding
4. medium-risk work with explicit approval
5. high-risk planning without apply
6. high-risk writes only after the runtime proves grounding quality

If the runtime cannot identify a real target file, owner, or handoff boundary, it should stop with `blocked`.

## Agent runtime config

The main config is `config/system.json` under `multiAgentRuntime`.

Relevant keys:

- `defaultAdapter`
- `liveProvider`
- `providerByAgentProvider`
- `nativeCodex`
- `nativeCursor`
- `commandAdapters`
- `integration`

Useful one-off CLI overrides:

```bash
npm run task -- --task "..." --summary "..." --agentLive --agentProvider codex
npm run task -- --task "..." --summary "..." --agentLive --agentProvider cursor
npm run task -- --task "..." --summary "..." --agentLive --agentProvider external --agentCommandProvider external
```

If you need a non-native backend, configure `multiAgentRuntime.commandAdapters.<provider>`.

## Command adapter contract

The command adapter is the handoff path for any external AI wrapper.

For multi-agent execution, stdin receives a `mode: "multi-agent-step"` JSON payload and stdout must return one JSON object with:

- `summary`
- `artifacts`
- `handoffs`
- `consultations`
- `verdict`

For queued review, stdin receives the review payload and stdout must return the structured review JSON expected by the local worker.

See the generated `COMMAND-ADAPTER-CONTRACT.md` in the integration pack for concrete examples.

## Operator workflow

For blind deployment, keep the feedback loop artifact-only:

- `state/runs/*`
- `state/reviews/reports/*`
- `state/reviews/history.jsonl`
- `state/reviews/metrics.json`
- `state/benchmarks/*`

Those files are enough to audit:

- which agents ran
- what handoffs happened
- where retries or blocks happened
- what the approval path did
- what the runtime cost

## Minimal host setup checklist

1. copy `.ai-repo-companion/` into the host root
2. ignore it in the host `.gitignore`
3. run `npm run init`
4. run `npm test`
5. run `npm run integrate -- --editor both --hostRoot .. --writeHostFiles`
6. verify host root contains:
   - `AGENTS.md`
   - `.cursor/rules/ai-repo-companion.mdc`
7. start with advisory or shadow mode

## What this still does not solve

This integration layer does not magically fix weak grounding. If the host repo corpus is poor or the live AI guesses file targets, the runtime will still need better host-specific notes and stricter stop conditions.
