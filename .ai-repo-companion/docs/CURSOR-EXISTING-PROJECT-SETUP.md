# Cursor Setup For An Existing Project

Use this guide when you already have a real project and want Cursor to work with the companion runtime.

The target shape is:

- the host repository stays as the main project
- `.ai-repo-companion/` lives in the host repository root
- Cursor auto-loads repository rules from `.cursor/rules/`
- the companion runtime is called from inside `.ai-repo-companion/`

## 1. Copy the runtime into the host project

Put the full hidden runtime into the host repository root:

```bash
rsync -a /path/to/ai-repo-companion/.ai-repo-companion/ /path/to/your-project/.ai-repo-companion/
cd /path/to/your-project/.ai-repo-companion
npm run init
npm test
```

## 2. Ignore the runtime in the host repository

Add this line to the host repository `.gitignore`:

```gitignore
.ai-repo-companion/
```

## 3. Generate Cursor auto-load instructions

From inside `.ai-repo-companion/`, run:

```bash
npm run integrate -- --editor cursor --hostRoot .. --writeHostFiles
```

That writes this file into the host repository:

```text
/path/to/your-project/.cursor/rules/ai-repo-companion.mdc
```

The generated rule uses `alwaysApply: true`, so Cursor should pick it up automatically when the host repository root is opened.

## 4. If the host repo should support both Cursor and Codex

Generate both host-facing files:

```bash
npm run integrate -- --editor both --hostRoot .. --writeHostFiles
```

That writes:

- `AGENTS.md` into the host repository root
- `.cursor/rules/ai-repo-companion.mdc` for Cursor

## 5. Run the live multi-agent runtime through Cursor

Requirements:

- the `cursor` CLI must be available in `PATH`
- Cursor must already be authenticated
- the host repository must be opened from its real root

Run the companion from inside `.ai-repo-companion/`:

```bash
cd /path/to/your-project/.ai-repo-companion

npm run task -- \
  --task "tighten deployment README wording" \
  --summary "docs cleanup" \
  --agentLive \
  --agentProvider cursor
```

## 6. If Cursor only needs the instructions, but another wrapper executes the live AI

Keep the Cursor rule, but route execution through a command adapter.

Use:

- `multiAgentRuntime.commandAdapters`
- `reviewExecution.commandAdapters`

See:

- `docs/HOST-INTEGRATION.md`
- the generated `COMMAND-ADAPTER-CONTRACT.md` in the integration pack

## 7. What to verify after setup

- the host repository contains `.ai-repo-companion/`
- the host repository contains `.cursor/rules/ai-repo-companion.mdc`
- `cd .ai-repo-companion && npm test` passes
- `npm run integrate -- --editor cursor` generates a preview pack in `state/integration/host-pack/`
- Cursor is opened on the host repository root, not on a nested folder

## Recommended starting mode

Start with:

1. `integrate --editor cursor --hostRoot .. --writeHostFiles`
2. `task ... --agentLive --agentProvider cursor` only for low-risk docs or test tasks
3. advisory or shadow mode before risky repository flows

## Related docs

- `docs/HOST-INTEGRATION.md`
- `docs/USER-GUIDE.md`
- `.cursor/rules/ai-repo-companion.mdc`
