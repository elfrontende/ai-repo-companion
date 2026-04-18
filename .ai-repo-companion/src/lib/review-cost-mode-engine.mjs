// Cost-mode overlays are intentionally runtime-only.
// They let an operator say "be cheaper for this run" without mutating
// system.json or changing the default policy for later work.

export function applyReviewCostMode(config, options = {}) {
  const next = JSON.parse(JSON.stringify(config ?? {}));
  const execution = next.reviewExecution ?? {};
  const costMode = options.costMode ?? "balanced";
  const reviewProfile = options.reviewProfile ?? "auto";

  execution.reviewProfiles ??= {};
  execution.reviewProfiles.balanced ??= {
    promptStyle: "light",
    maxOperations: 2,
    codexReasoningEffort: "medium"
  };
  execution.reviewProfiles.expensive ??= {
    promptStyle: "strict",
    maxOperations: 3,
    codexReasoningEffort: "high"
  };
  execution.valueGate ??= {
    enabled: true,
    applyToModes: ["balanced"],
    minScore: 60
  };
  execution.operationRanking ??= {
    maxAppliedOperations: 2,
    minScore: 35
  };
  execution.nativeCodex ??= {};
  execution.nativeCursor ??= {};

  if (costMode === "saver") {
    execution.valueGate.enabled = true;
    execution.valueGate.minScore = Math.max(70, Number(execution.valueGate.minScore) + 10);
    execution.reviewProfiles.balanced = {
      ...execution.reviewProfiles.balanced,
      promptStyle: "light",
      maxOperations: 1,
      codexReasoningEffort: "low"
    };
    execution.operationRanking.maxAppliedOperations = 1;
    execution.nativeCodex.maxAttempts = 1;
    execution.nativeCursor.maxAttempts = 1;
  } else if (costMode === "strict") {
    execution.valueGate.enabled = true;
    execution.valueGate.minScore = Math.max(30, Number(execution.valueGate.minScore) - 15);
    execution.reviewProfiles.balanced = {
      ...execution.reviewProfiles.balanced,
      promptStyle: "strict",
      maxOperations: Math.max(2, Number(execution.reviewProfiles.balanced.maxOperations) || 2),
      codexReasoningEffort: "high"
    };
    execution.reviewProfiles.expensive = {
      ...execution.reviewProfiles.expensive,
      promptStyle: "strict",
      maxOperations: Math.max(3, Number(execution.reviewProfiles.expensive.maxOperations) || 3),
      codexReasoningEffort: "high"
    };
    execution.operationRanking.maxAppliedOperations = Math.max(
      3,
      Number(execution.operationRanking.maxAppliedOperations) || 3
    );
  }

  if (reviewProfile === "light") {
    execution.reviewProfiles.balanced = {
      ...execution.reviewProfiles.balanced,
      promptStyle: "light",
      maxOperations: Math.min(2, Number(execution.reviewProfiles.balanced.maxOperations) || 2),
      codexReasoningEffort: "medium"
    };
    execution.reviewProfiles.expensive = {
      ...execution.reviewProfiles.expensive,
      promptStyle: "light",
      maxOperations: 2,
      codexReasoningEffort: "medium"
    };
  } else if (reviewProfile === "heavy") {
    execution.reviewProfiles.balanced = {
      ...execution.reviewProfiles.balanced,
      promptStyle: "strict",
      maxOperations: Math.max(2, Number(execution.reviewProfiles.balanced.maxOperations) || 2),
      codexReasoningEffort: "high"
    };
    execution.reviewProfiles.expensive = {
      ...execution.reviewProfiles.expensive,
      promptStyle: "strict",
      maxOperations: Math.max(3, Number(execution.reviewProfiles.expensive.maxOperations) || 3),
      codexReasoningEffort: "high"
    };
  }

  next.reviewExecution = execution;
  next.runtimeCostControls = {
    costMode,
    reviewProfile
  };
  return next;
}
