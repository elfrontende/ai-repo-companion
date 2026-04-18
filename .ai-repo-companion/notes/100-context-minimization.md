---
id: z-100-context-minimization
title: Context minimization pipeline
kind: principle
tags: context,tokens,retrieval,budget,контекст,токени
links: z-110-atomic-notes,z-130-background-memory-sync,z-000-index,z-120-agent-orchestration
---

# Summary

Context should be assembled from the smallest useful set of notes under a token budget.

# Signals

- Score notes by task token overlap, tags, aliases, and linked neighbors.
- Prefer atomic notes over broad documents because they compress better.
- Stop retrieval as soon as the bundle covers the current task and budget.
