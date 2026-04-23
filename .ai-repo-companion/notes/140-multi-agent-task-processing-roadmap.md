---
id: z-140-multi-agent-task-processing-roadmap
title: Multi-agent task-processing roadmap
scope: system
kind: roadmap
tags: roadmap,multi-agent,orchestration,run-ledger,phases
links: z-120-agent-orchestration,z-130-background-memory-sync,z-000-index
---

# Summary

The workspace should evolve from agent planning plus memory review into a full multi-agent task-processing system with explicit runs, handoffs, verification, and bounded rework.

# Signals

- Start with a run ledger that records task runs, stages, agent outputs, and verdicts as durable local state.
- Make agent contracts executable before adding consultation, rework, or broader orchestration graphs.
- Keep risky apply behind approval and preserve the current review pipeline as a safety layer while multi-agent execution grows.
- Evaluate the new runtime against clear baselines instead of assuming that more agents automatically improve outcomes.
