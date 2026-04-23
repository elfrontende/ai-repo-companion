# AI Repo Companion

This repository is the hidden runtime that sits inside a host project as `.ai-repo-companion/`.

## Working rules

- keep changes grounded in the existing runtime shape
- prefer editing `src/lib/`, `config/`, `docs/`, and `tests/` over ad hoc scripts
- do not hand-edit `state/` unless the task is explicitly about stored runtime state or fixtures
- keep new execution behavior observable through `status`, `report`, or `run`

## Host integration

- use `npm run integrate -- --editor both` to generate Codex and Cursor host instructions
- use `npm run integrate -- --editor both --hostRoot .. --writeHostFiles` to write those files into the parent host repo
- keep Cursor instructions in `.cursor/rules/*.mdc`
- keep Codex host instructions in `AGENTS.md`

## Runtime expectations

- `provider-runtime` should stay model-agnostic
- native Codex and native Cursor should remain first-class paths
- external command adapters must keep stdin/stdout JSON contracts stable
- if grounding is missing, the runtime should block instead of inventing targets

## Docs

- `docs/HOST-INTEGRATION.md` explains blind deployment into a real host repo
- `docs/DEVELOPER-GUIDE.md` explains the code layout
- `docs/USER-GUIDE.md` explains operator commands
