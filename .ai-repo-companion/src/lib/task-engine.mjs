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
  verification: ["test", "verify", "qa", "regression", "bug", "safe", "тест", "перевір", "регрес", "баг", "безпечно"],
  documentation: ["docs", "documentation", "readme", "guide", "comment", "документація", "доки", "гайд", "опис"],
  planning: ["plan", "scope", "milestone", "roadmap", "estimate", "phase", "план", "етап", "roadmap", "оцінка", "milestone"],
  memory: ["memory", "zettelkasten", "notes", "context", "retrieval", "index", "память", "памʼять", "нотатки", "контекст", "індекс"]
};

const riskKeywords = ["auth", "security", "migration", "payment", "infra", "core", "production", "безпека", "міграція", "прод", "інфра"];

export function classifyTask(task) {
  // Tokenization keeps the classifier cheap and language-agnostic enough
  // for short English/Ukrainian engineering prompts.
  const tokens = tokenize(task);
  const intentScores = Object.fromEntries(
    Object.entries(intentKeywords).map(([intent, keywords]) => [
      intent,
      keywords.reduce((sum, keyword) => sum + (tokens.some((token) => roughTokenMatch(token, keyword)) ? 1 : 0), 0)
    ])
  );

  const intents = Object.entries(intentScores)
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1])
    .map(([intent]) => intent);

  const complexity = estimateComplexity(task, tokens, intents);
  const risk = riskKeywords.some((keyword) => tokens.some((token) => roughTokenMatch(token, keyword))) ? "high" : complexity >= 7 ? "medium" : "low";
  const effort = complexity >= 8 || risk === "high" ? "high" : complexity >= 4 ? "medium" : "low";

  return {
    task,
    tokens,
    intents: intents.length ? intents : ["implementation"],
    complexity,
    risk,
    effort
  };
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
