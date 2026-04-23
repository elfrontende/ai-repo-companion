import { roughTokenMatch, tokenize } from "./note-parser.mjs";

// This module is intentionally heuristic.
// We are not trying to "understand" the task perfectly here.
// We only need a cheap first pass that is good enough to choose:
// - which agents should participate
// - how risky the task looks
// - how much reasoning effort is worth spending

const intentKeywords = {
  architecture: ["architecture", "design", "boundary", "system", "orchestrator", "agent", "архітектура", "дизайн", "система", "оркестратор", "агент"],
  implementation: ["build", "implement", "code", "feature", "refactor", "cli", "зробити", "реалізувати", "код", "фіча", "рефакторинг"],
  verification: ["test", "verify", "qa", "regression", "bug", "safe", "flaky", "retry", "retries", "failure", "incident", "debug", "тест", "перевір", "регрес", "баг", "безпечно", "флейкі", "збій", "інцидент", "дебаг"],
  documentation: ["docs", "documentation", "readme", "guide", "comment", "документація", "доки", "гайд", "опис"],
  planning: ["plan", "rollout", "scope", "milestone", "roadmap", "estimate", "phase", "proposal", "sequence", "план", "спланувати", "планувати", "етап", "оцінка", "пропозиція", "послідовність"],
  memory: ["memory", "zettelkasten", "notes", "context", "retrieval", "index", "память", "памʼять", "нотатки", "контекст", "індекс"]
};

const riskKeywords = ["auth", "security", "migration", "payment", "infra", "core", "production", "безпека", "міграція", "прод", "інфра"];
const mediumRiskKeywords = ["flaky", "regression", "retry", "retries", "rollback", "timeout", "timeouts", "latency", "failure", "incident", "outage", "crash", "регрес", "відкат", "таймаут", "затримка", "збій", "інцидент", "падіння"];
const explicitMemoryTaskKeywords = ["memory", "zettelkasten", "notes", "note", "context", "retrieval", "index", "память", "памʼять", "нотатки", "контекст", "індекс"];

export function classifyTask(task) {
  // Tokenization keeps the classifier cheap and language-agnostic enough
  // for short English/Ukrainian engineering prompts.
  const tokens = tokenize(task);
  const companionTask = tokens.some((token) => explicitMemoryTaskKeywords.some((keyword) => matchesExplicitTaskKeyword(token, keyword)));
  const intentScores = Object.fromEntries(
    Object.entries(intentKeywords).map(([intent, keywords]) => [
      intent,
      keywords.reduce((sum, keyword) => sum + (tokens.some((token) => roughTokenMatch(token, keyword)) ? 1 : 0), 0)
    ])
  );
  if (!companionTask) {
    intentScores.memory = 0;
  }
  if (intentScores.planning > 0 && tokens.some((token) => ["plan", "спланувати", "планувати"].includes(token))) {
    intentScores.planning += 1;
  }

  const intents = Object.entries(intentScores)
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([intent]) => intent);

  const complexity = estimateComplexity(task, tokens, intents);
  const risk = riskKeywords.some((keyword) => tokens.some((token) => roughTokenMatch(token, keyword)))
    ? "high"
    : (mediumRiskKeywords.some((keyword) => tokens.some((token) => roughTokenMatch(token, keyword))) || complexity >= 7)
      ? "medium"
      : "low";
  const effort = complexity >= 8 || risk === "high"
    ? "high"
    : (complexity >= 4 || risk === "medium")
      ? "medium"
      : "low";

  return {
    // This compact profile is shared by routing, policy, retrieval, and
    // benchmarking, so keeping its shape stable makes the whole runtime saner.
    task,
    tokens,
    intents: intents.length ? intents : ["implementation"],
    complexity,
    risk,
    effort
  };
}

function matchesExplicitTaskKeyword(token, keyword) {
  if (!token || !keyword) {
    return false;
  }

  return token === keyword || (keyword.length >= 5 && token.startsWith(keyword));
}

function estimateComplexity(task, tokens, intents) {
  // Complexity is a small synthetic score used for routing.
  // It is intentionally simple so that it remains predictable to maintain.
  let score = 1;
  score += Math.min(4, Math.floor(tokens.length / 6));
  if (task.length > 120) {
    score += 1;
  }
  if (intents.includes("architecture")) {
    score += 2;
  }
  if (intents.includes("memory")) {
    score += 1;
  }
  if (intents.includes("verification")) {
    score += 1;
  }
  return Math.min(score, 10);
}
