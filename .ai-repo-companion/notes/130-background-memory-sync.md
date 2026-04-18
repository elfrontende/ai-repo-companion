---
id: z-130-background-memory-sync
title: Background memory synchronization
kind: architecture
tags: memory,background,sync,events,links,память,памʼять,фон
links: z-110-atomic-notes,z-000-index,z-100-context-minimization,z-120-agent-orchestration
---

# Summary

Every task should emit a memory event that can create or refine notes without asking the user to manage memory manually.

# Signals

- Keep working memory as pointers to note ids and recent events only.
- Convert task summaries into linked notes after execution.
- Rebuild links from tags and overlapping concepts so retrieval improves over time.
