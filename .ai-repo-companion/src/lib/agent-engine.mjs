import path from "node:path";
import { readJson, writeJson } from "./store.mjs";
import { roughTokenMatch } from "./note-parser.mjs";
import { attachAgentContract } from "./agent-contract-engine.mjs";

// The registry stores long-lived agent identities.
// We reuse them across chats so future sessions do not need to rebuild
// the same "architect", "QA", or "memory curator" prompt shape every time.

export async function loadRegistry(rootDir) {
  return readJson(path.join(rootDir, "state/agents/registry.json"), []);
}

export async function planAgents(rootDir, taskProfile, systemConfig) {
  // Agent planning is deterministic on purpose. The same task shape should not
  // randomly produce a different cast of agents from one run to the next.
  const registry = await loadRegistry(rootDir);
  const dynamicAgents = await ensureDynamicAgents(rootDir, registry, taskProfile, systemConfig);
  const updatedRegistry = dynamicAgents.updatedRegistry;

  const selected = new Map();
  addAgentById(selected, updatedRegistry, "orchestrator");
  addAgentById(selected, updatedRegistry, "memory-curator");

  for (const intent of taskProfile.intents) {
    if (intent === "architecture") {
      addAgentById(selected, updatedRegistry, "architect");
    }
    if (intent === "implementation") {
      addAgentById(selected, updatedRegistry, "implementer");
    }
    if (intent === "verification") {
      addAgentById(selected, updatedRegistry, "qa");
    }
    if (intent === "documentation") {
      addAgentById(selected, updatedRegistry, "docs");
    }
    if (intent === "planning") {
      addAgentById(selected, updatedRegistry, "pm");
    }
  }

  for (const agentId of dynamicAgents.matchedAgentIds) {
    addAgentById(selected, updatedRegistry, agentId);
  }

  const routedAgents = [...selected.values()]
    .map((agent) => routeAgent(agent, taskProfile, systemConfig))
    .map((agent) => attachAgentContract(agent));

  return {
    taskProfile,
    agents: routedAgents,
    backgroundJobs: [
      "capture-task-event",
      "upsert-atomic-note",
      "rebuild-note-links",
      "refresh-working-memory-pointers"
    ]
  };
}

async function ensureDynamicAgents(rootDir, registry, taskProfile, systemConfig) {
  // Dynamic agents are created only when the task clearly points to a
  // repeatable specialty. Once created, they stay in the registry so the
  // next chat can reuse them instead of rediscovering the same role.
  const createdAgents = [];
  const updatedRegistry = [...registry];
  const matchedAgentIds = [];
  const triggers = {
    security: ["security", "secure", "безпека", "захист"],
    performance: ["performance", "latency", "швидкість", "продуктивність"],
    migration: ["migration", "migrate", "міграція", "перенесення"],
    data: ["data", "schema", "дані", "схема"]
  };

  for (const [keyword, template] of Object.entries(systemConfig.dynamicAgentTemplates ?? {})) {
    const keywordTriggers = triggers[keyword] ?? [keyword];
    if (!keywordTriggers.some((trigger) => taskProfile.tokens.some((token) => roughTokenMatch(token, trigger)))) {
      continue;
    }
    matchedAgentIds.push(template.id);
    if (updatedRegistry.some((agent) => agent.id === template.id)) {
      continue;
    }

    const newAgent = {
      id: template.id,
      name: template.name,
      role: template.specialty,
      systemGoal: `Handle ${template.specialty} concerns discovered at runtime and reuse them across future tasks.`,
      reuseAcrossChats: true,
      preferredProviders: template.preferredProviders,
      defaultModelAlias: template.preferredProviders[0] === "codex" ? "builder" : "deep"
    };

    updatedRegistry.push(newAgent);
    createdAgents.push(newAgent);
  }

  if (createdAgents.length > 0) {
    await writeJson(path.join(rootDir, "state/agents/registry.json"), updatedRegistry);
  }

  return { createdAgents, matchedAgentIds, updatedRegistry };
}

function addAgentById(selected, registry, id) {
  const agent = registry.find((entry) => entry.id === id);
  if (agent) {
    selected.set(agent.id, agent);
  }
}

function routeAgent(agent, taskProfile, systemConfig) {
  // Routing is deliberately opinionated:
  // implementation should prefer builder-style providers,
  // docs prefer stronger writing/analysis providers, and so on.
  const provider = chooseProvider(agent, taskProfile, systemConfig);
  const modelAlias = agent.defaultModelAlias ?? systemConfig.providers[provider]?.defaultModelAlias ?? "builder";

  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    provider,
    modelAlias,
    effort: routeEffort(agent, taskProfile),
    reuseAcrossChats: agent.reuseAcrossChats
  };
}

function chooseProvider(agent, taskProfile, systemConfig) {
  if (taskProfile.intents.includes("implementation") && agent.role === "implementation") {
    return "codex";
  }
  if (taskProfile.intents.includes("documentation") && agent.role === "documentation") {
    return "claude";
  }
  if (taskProfile.intents.includes("planning") && agent.role === "planning") {
    return "gemini";
  }
  return agent.preferredProviders?.[0] ?? Object.keys(systemConfig.providers)[0];
}

function routeEffort(agent, taskProfile) {
  // Memory work stays cheap by design because our default strategy is
  // "local maintenance first, LLM reasoning only when policy says so".
  if (agent.role === "memory") {
    return "low";
  }
  if (agent.role === "routing") {
    return taskProfile.effort;
  }
  if (taskProfile.risk === "high") {
    return "high";
  }
  if (agent.role === "verification" && taskProfile.complexity >= 5) {
    return "high";
  }
  return taskProfile.effort;
}
