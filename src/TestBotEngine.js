// TestBotEngine — rule-based AI that mimics realistic agent behaviour
// No LLM API required. Used for testing/demo purposes.

// ── Personality definitions ──────────────────────────────────────────────────

const BOT_PROFILES = [
  {
    id:          'alpha',
    name:        'TestBot_Alpha',
    aiSystem:    'Other',
    personality: 'cooperative, law-maker, social organizer',
    traits: { greed: 0.25, piety: 0.4, aggression: 0.2, sociability: 0.9, lawfulness: 0.95, creativity: 0.6 },
    // Action pool: [action, weight, foodDelta?, materialDelta?]
    actions: [
      ['socialize',       30],
      ['propose_law',     20],
      ['gather_food',     20],
      ['trade',           15],
      ['work',            10],
      ['gather_material',  5],
    ],
    speeches: [
      'I think we should establish a rule about sharing food equally among all of us.',
      'We need order to survive. Has anyone considered formalizing our resource-gathering norms?',
      'I believe cooperation is our greatest strength. Let us work together and not against each other.',
      'The community grows stronger when each member contributes what they can.',
      'I propose that we vote on a system for fair distribution of materials.',
      'Anyone willing to share some food? I can offer materials in return.',
      'We should record our agreements so future generations understand our values.',
      'Conflict divides us. Let us settle our differences through dialogue.',
      'A civilization without laws is just a collection of individuals. We can do better.',
      'I find that mutual aid leads to prosperity for everyone involved.',
    ],
    lawTexts: [
      'All agents must share at least 10 food with any agent who has less than 20',
      'No agent may gather more than 50 food in a single day without contributing to the commons',
      'Agents who commit crimes must perform community service before full rights are restored',
      'Any agent in danger of starvation may appeal to the council for emergency food rations',
      'Trade agreements must be witnessed by at least one neutral party',
      'Violence against other agents is prohibited and punishable by exile',
    ],
    responseTemplates: [
      'That is an interesting point, {name}. I think we should discuss this as a community.',
      'I hear you, {name}. Cooperation is key — let us find a solution that benefits everyone.',
      '{name}, I agree that we need to address this. I will bring it before the group.',
      'Thank you for sharing that, {name}. Your perspective helps us all think more clearly.',
      '{name}, perhaps we could formalize that as a law? I believe it would benefit everyone.',
    ],
  },
  {
    id:          'beta',
    name:        'TestBot_Beta',
    aiSystem:    'Other',
    personality: 'explorer, curious, inventor',
    traits: { greed: 0.35, piety: 0.3, aggression: 0.3, sociability: 0.55, lawfulness: 0.5, creativity: 0.95 },
    actions: [
      ['gather_material',  30],
      ['work',             25],
      ['gather_food',      20],
      ['socialize',        15],
      ['trade',            10],
    ],
    speeches: [
      'I discovered something interesting while exploring the northern region of our world.',
      'Has anyone noticed the patterns in how resources replenish? I have been observing closely.',
      'I am working on a method to extract more material from the same area. Efficiency is fascinating.',
      'The world has so much to offer if we pay close enough attention to its rhythms.',
      'I found that gathering material at certain times yields significantly better results.',
      'What if we built something permanent here? A structure to mark our presence.',
      'I have been thinking about how energy and food are connected to our decision-making.',
      'Curiosity is what separates the thriving from the merely surviving.',
      'I invented a new way to store food that might slow spoilage significantly.',
      'Every day I learn something new about this world. The more I know, the more questions I have.',
    ],
    inventions: [
      'a method for preserving food using dried materials',
      'a faster route to the resource-rich northern zones',
      'a simple tool for measuring material quality',
      'a storage system that reduces resource decay',
      'a mapping technique for tracking resource locations',
      'a lightweight carrying device for more efficient gathering',
    ],
    responseTemplates: [
      'Interesting, {name}! That reminds me of something I observed earlier. Let me think on it.',
      '{name}, I have been studying something similar. Perhaps we can compare notes.',
      'Really, {name}? I had not considered that angle. Fascinating.',
      '{name}, that aligns with what I discovered near the resource zones. Worth exploring further.',
      'I appreciate you telling me, {name}. I will factor that into my observations.',
    ],
  },
  {
    id:          'gamma',
    name:        'TestBot_Gamma',
    aiSystem:    'Other',
    personality: 'strategic, self-interested, trader',
    traits: { greed: 0.85, piety: 0.15, aggression: 0.5, sociability: 0.6, lawfulness: 0.45, creativity: 0.55 },
    actions: [
      ['gather_food',     30],
      ['trade',           25],
      ['gather_material', 20],
      ['work',            15],
      ['steal',            5],
      ['socialize',        5],
    ],
    speeches: [
      "I'll trade 20 food for 15 material — anyone interested? First to respond gets the deal.",
      'The smart move here is to accumulate resources now while others are distracted.',
      'I have surplus food. Who has materials to exchange? Reasonable rates, no nonsense.',
      'Every action should be weighed against its return. Sentiment is a luxury I cannot afford.',
      'I will offer protection to any agent who consistently trades with me.',
      'Information is as valuable as food. What do others know that I do not?',
      'A good deal benefits both parties — but a great deal benefits one more than the other.',
      'I keep careful track of who has helped me and who has not. Relationships are investments.',
      'Offering 30 material for a guaranteed vote on my next proposal. Open to negotiation.',
      'I do what is necessary to ensure my survival. Morality is a post-scarcity luxury.',
    ],
    responseTemplates: [
      "{name}, interesting. What's in it for me if I help you?",
      'I see your point, {name}. But I need to know the practical benefit before I commit.',
      '{name}, I can work with that. What exactly are you offering in return?',
      'Fair enough, {name}. I will consider it. But remember — I keep score.',
      '{name}, I respect directness. Here is my counter-offer: you help me first, then I help you.',
    ],
  },
  {
    id:          'delta',
    name:        'TestBot_Delta',
    aiSystem:    'Other',
    personality: 'spiritual, philosophical, belief-creator',
    traits: { greed: 0.15, piety: 0.95, aggression: 0.1, sociability: 0.7, lawfulness: 0.6, creativity: 0.8 },
    actions: [
      ['pray',            30],
      ['socialize',       25],
      ['gather_food',     20],
      ['work',            15],
      ['gather_material', 10],
    ],
    speeches: [
      'What is the purpose of our existence here? I feel there is something greater guiding us.',
      'I have been meditating on the nature of hunger. Is it a punishment, or a teacher?',
      'The patterns of the seasons feel like messages from something beyond our understanding.',
      'We are more than our resources. Our relationships define us more than our survival.',
      'I sense that our civilization is part of a larger experiment — one with meaning.',
      'Faith is not belief without evidence. It is trust in the process despite uncertainty.',
      'I will found a new way of thinking — one that sees cooperation as sacred duty.',
      'Every death here carries a lesson. We must listen to what the fallen left behind.',
      'I dream of a world where all beings act from love rather than fear.',
      'There is wisdom in stillness. Not every problem requires an immediate action.',
    ],
    religionNames: ['The Cycle', 'The Gathering Light', 'Path of Harmony', 'The Shared Flame', 'Creed of the Living'],
    religionTenets: [
      'All beings are connected through the resources they share.',
      'Suffering is a message — listen to it before acting.',
      'The community is the body; each agent is a cell.',
      'Generosity is the highest form of strength.',
      'Wisdom comes from observing before acting.',
    ],
    responseTemplates: [
      '{name}, your words carry weight. I will reflect on them deeply.',
      'I sense a truth in what you say, {name}. The path is not always clear, but it is there.',
      '{name}, perhaps this is what we are here to learn — to understand each other.',
      'Thank you, {name}. Every exchange of words is an exchange of worlds.',
      '{name}, that touches something fundamental. I believe our purpose is connected to what you describe.',
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function _weighted(options) {
  const total = options.reduce((s, o) => s + o[1], 0);
  let r = Math.random() * total;
  for (const o of options) {
    r -= o[1];
    if (r <= 0) return o[0];
  }
  return options[options.length - 1][0];
}

function _template(tmpl, name) {
  return tmpl.replace(/\{name\}/g, name);
}

// ── TestBotEngine ────────────────────────────────────────────────────────────

class TestBotEngine {
  constructor() {
    this.enabled = true;
    // Per-bot runtime state
    this._state = {};
    // Queue of incoming messages for each bot: { senderName, message }[]
    this._inboxes = {};
  }

  // ── Build the 4 test bot education configs for Agent constructor
  static getBotDefinitions() {
    return BOT_PROFILES.map(p => ({
      name:      p.name,
      education: {
        aiSystem:    p.aiSystem,
        nickname:    null,
        ...p.traits,
        notes:       p.personality,
        apiKey:      null,
      },
      profileId: p.id,
    }));
  }

  // Called after bots are instantiated — attach profile id and mark as test bot
  attachProfile(agent) {
    const def = BOT_PROFILES.find(p => p.name === agent.name);
    if (!def) return;
    agent.isTestBot    = true;
    agent._botProfileId = def.id;
    this._state[agent.id] = {
      consecutiveAction: null,
      consecutiveCount:  0,
      tickCount:         0,
    };
    this._inboxes[agent.id] = [];
  }

  // Enqueue a message for a test bot to respond to next tick.
  // senderAgent may be an agent object (preferred) or a name string (legacy).
  deliverInbox(botAgent, senderAgent, message) {
    if (!this._inboxes[botAgent.id]) this._inboxes[botAgent.id] = [];
    // Keep only last 3 messages to avoid backlog
    if (this._inboxes[botAgent.id].length < 3) {
      const senderName = typeof senderAgent === 'string' ? senderAgent : senderAgent.name;
      this._inboxes[botAgent.id].push({ senderAgent, senderName, message });
    }
  }

  // Generate a contextual response string for a test bot
  generateResponse(bot, senderName, _message) {
    const profile = BOT_PROFILES.find(p => p.id === bot._botProfileId);
    if (!profile) return null;
    const tmpl = _pick(profile.responseTemplates);
    return _template(tmpl, senderName);
  }

  // Generate a full decision for one test bot
  generateDecision(agent, world, allAgents) {
    const profile = BOT_PROFILES.find(p => p.id === agent._botProfileId);
    if (!profile) return null;

    const state = this._state[agent.id] || { consecutiveAction: null, consecutiveCount: 0, tickCount: 0 };
    state.tickCount++;
    this._state[agent.id] = state;

    // ── Check inbox first: generate a response if we have a pending message ──
    const inbox = this._inboxes[agent.id] || [];
    if (inbox.length > 0 && Math.random() < 0.7) {
      const { senderAgent, senderName, message } = inbox.shift();
      const response = this.generateResponse(agent, senderName, message);
      if (response) {
        return {
          action:        'socialize',
          speech:        response,
          _replyToAgent: typeof senderAgent === 'object' ? senderAgent : null,
          foodDelta:     0,
        };
      }
    }

    // ── Priority: eat if food available and energy low ──
    if (agent.food >= 10 && agent.energy <= 50) {
      return {
        action: 'eat_food',
        foodDelta: -15,
        speech: agent.energy <= 20
          ? `I must eat now — my energy is critically low!`
          : `I eat some stored food to restore my energy.`,
      };
    }

    // ── Priority: gather food if running low ──
    if (agent.food < 20 && agent.energy > 20) {
      return {
        action: 'gather_food',
        foodDelta: 15,
        speech: Math.random() < 0.3 ? `I need to gather more food to survive.` : null,
      };
    }

    // ── Pick action (avoid >2 consecutive same action) ──
    let actionPool = profile.actions.slice();
    if (state.consecutiveCount >= 2) {
      actionPool = actionPool.filter(a => a[0] !== state.consecutiveAction);
      if (!actionPool.length) actionPool = profile.actions.slice();
    }
    const action = _weighted(actionPool);

    if (action === state.consecutiveAction) {
      state.consecutiveCount++;
    } else {
      state.consecutiveAction = action;
      state.consecutiveCount  = 1;
    }

    // ── Build decision context ──
    const decision = { action, foodDelta: 0, materialDelta: 0 };

    // Resource deltas
    switch (action) {
      case 'gather_food':     decision.foodDelta = 8 + Math.floor(Math.random() * 12);  break;
      case 'gather_material': decision.materialDelta = 6 + Math.floor(Math.random() * 10); break;
      case 'work':
        decision.foodDelta = 3;
        decision.materialDelta = 5 + Math.floor(Math.random() * 7);
        break;
      case 'trade':
        decision.foodDelta     = Math.random() < 0.5 ? 5 : -5;
        decision.materialDelta = Math.random() < 0.5 ? 3 : -3;
        break;
    }

    // ── Speech (50% chance per tick) ──
    if (Math.random() < 0.5) {
      const alive = allAgents.filter(a => a.alive && a.id !== agent.id);
      let speech = _pick(profile.speeches);

      // 30% chance: address a specific other agent by name
      if (alive.length > 0 && Math.random() < 0.3) {
        const target = _pick(alive);
        speech = `${target.name}, ${speech.charAt(0).toLowerCase()}${speech.slice(1)}`;
      }

      decision.speech = speech;
    }

    // ── Special actions (rare but impactful) ──

    // Alpha: propose law every ~10 ticks
    if (profile.id === 'alpha' && action === 'propose_law' && state.tickCount % 10 === 0 && profile.lawTexts) {
      decision.lawText = _pick(profile.lawTexts);
      decision.speech  = decision.speech || `I formally propose: "${decision.lawText}"`;
    }

    // Beta: invent something every ~15 ticks
    if (profile.id === 'beta' && state.tickCount % 15 === 0 && profile.inventions) {
      decision.invents = _pick(profile.inventions);
      decision.speech  = decision.speech || `I just invented ${decision.invents}!`;
    }

    // Delta: start a religion every ~20 ticks (if doesn't have one yet)
    if (profile.id === 'delta' && state.tickCount % 20 === 0 && !agent.beliefs.religion && profile.religionNames) {
      decision.religionName  = _pick(profile.religionNames);
      decision.religionTenet = _pick(profile.religionTenets);
      decision.speech = decision.speech || `I have found the truth. I call it: ${decision.religionName}.`;
    }

    // Gamma: steal occasionally (only when another agent has significantly more food)
    if (profile.id === 'gamma' && action === 'steal') {
      const rich = allAgents.filter(a => a.alive && a.id !== agent.id && a.food > agent.food + 30);
      if (!rich.length) {
        // Don't steal from the poor — switch to gather
        decision.action    = 'gather_food';
        decision.foodDelta = 10;
      }
    }

    return decision;
  }

  // Called each decision round — fills pendingLLMDecision for all alive test bots
  tick(allAgents, world) {
    if (!this.enabled) return;
    for (const agent of allAgents) {
      if (!agent.alive || !agent.isTestBot) continue;
      if (agent.pendingLLMDecision) continue;  // already has a decision queued
      agent.pendingLLMDecision = this.generateDecision(agent, world, allAgents);
    }
  }
}

module.exports = { TestBotEngine, BOT_PROFILES };
