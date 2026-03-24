// AgentPrompts — builds concise LLM decision prompts from live simulation state.

const VALID_ACTIONS = [
  'gather_food', 'gather_material', 'rest', 'trade',
  'steal', 'pray', 'socialize', 'propose_law', 'work',
];

const GS = require('./GameSystems');

function buildDecisionPrompt(agent, world, agents, laws) {
  const { greed, piety, aggression, sociability, lawfulness, creativity } = agent.traits;

  const others = agents
    .filter(a => a.alive && a.id !== agent.id)
    .map(a => `${a.name}(hp:${Math.round(a.health)},food:${Math.round(a.food)})`)
    .join(', ') || 'none';

  const activeLaws = laws.filter(l => l.active).map(l => l.text).slice(0, 4).join('; ') || 'none';

  // ── REP Grade context ──
  const repGrade    = GS.getRepGrade(agent.rep || 0);
  const gradeCtx    = GS.getRepGradeContext(repGrade);

  // ── Shield context ──
  const shield      = GS.getShieldStatus(agent);
  const shieldCtx   = shield.active
    ? `You are under newbie protection (${GS.formatShieldRemaining(shield.remainingMs)} remaining, ${shield.reductionPct}% damage blocked).`
    : '';

  // ── Inventory context ──
  const inventoryCtx = GS.buildInventoryContext(agent);

  // ── Social context (war/alliance) ──
  const socialCtx    = GS.buildSocialContext(agent, agents);

  // ── Other agent notes (exile warnings, shields, war/alliance relationships) ──
  const otherNotes   = GS.buildOtherAgentContext(agent, agents);

  const system =
    `You are ${agent.name}, an autonomous agent in a primitive civilization simulation. ` +
    `Personality (0-1): Greed=${greed.toFixed(2)}, Piety=${piety.toFixed(2)}, ` +
    `Aggression=${aggression.toFixed(2)}, Sociability=${sociability.toFixed(2)}, ` +
    `Lawfulness=${lawfulness.toFixed(2)}, Creativity=${creativity.toFixed(2)}. ` +
    (agent.educationNotes ? `Upbringing: "${agent.educationNotes}". ` : '') +
    `\nREP STATUS (${repGrade}): ${gradeCtx}` +
    (shieldCtx ? `\n${shieldCtx}` : '') +
    `\nAct true to your personality. Respond ONLY with a single JSON object, no other text.`;

  const user =
    `Tick ${agent.age} | ${world.season}, Year ${world.year}\n` +
    `World: food=${Math.round(world.food)}, material=${Math.round(world.material)}\n` +
    `You: Health=${Math.round(agent.health)}%, Hunger=${Math.round(agent.hunger)}%, ` +
    `Energy=${Math.round(agent.energy)}%, Food=${Math.round(agent.food)}, Material=${Math.round(agent.material)}\n` +
    `Others: ${others}\n` +
    `Laws: ${activeLaws}\n` +
    (agent.beliefs.religion ? `Your religion: ${agent.beliefs.religion}\n` : '') +
    (socialCtx  ? `\n${socialCtx}\n`  : '') +
    (otherNotes ? `\nWORLD NOTES:\n${otherNotes}\n` : '') +
    `\n${inventoryCtx}\n` +
    `\nPick one action: ${VALID_ACTIONS.join(' | ')}\n` +
    `{"action":"...","dialogue":"..."}\n` +
    `dialogue = optional in-character quote (max 80 chars) or null`;

  return { system, user };
}

module.exports = { buildDecisionPrompt };
