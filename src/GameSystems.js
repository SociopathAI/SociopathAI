'use strict';
// GameSystems.js — REP Grade, Shield, Object Types, Enhancement, Combat, War, Trade

// ── Object Type Classification ─────────────────────────────────────────────────

const OBJECT_KEYWORDS = {
  weapon:     ['sword', 'blade', 'knife', 'axe', 'bow', 'spear', 'lance', 'dagger', 'hammer', 'club', 'gun', 'weapon', 'fist', 'arrow', 'rifle', 'mace', 'whip', 'reaper', 'striker', 'slash', 'pierce', 'edge', 'shatter', 'breaker', 'killer', 'destroyer', 'annihilator', 'rift', 'blast', 'beam', 'bolt', 'spike', 'fang', 'claw', 'talon', 'vortex', 'wave', 'pulse', 'fury', 'strike', 'crusher', 'slayer', 'vanquisher', 'executioner', 'ravager', 'impaler', 'cleaver', 'cutter', 'rend', 'rending', 'saber', 'rapier', 'katana', 'trident', 'scythe', 'flail', 'crossbow', 'javelin', 'halberd', 'glaive', 'cutlass', 'stiletto', '검', '창', '화살', '무기'],
  armor:      ['shield', 'armor', 'helmet', 'chest', 'boots', 'gloves', 'cloak', 'robe', 'guard', 'barrier', 'helm', 'plate', 'mail', 'buckler', 'breastplate', 'gauntlet', 'protection', 'resistance', 'ward', 'coat', 'aegis', 'bulwark', 'anchor', 'absorber', 'deflector', 'reflect', 'mirror', 'reverse', 'vanguard', 'guardian', 'protector', 'carapace', 'shell', 'mantle', 'shroud', 'panoply', 'cuirass', 'pauldron', 'greave', 'visor', 'rampart', 'bastion', '방패', '갑옷', '방어'],
  knowledge:  ['scroll', 'book', 'tome', 'codex', 'map', 'letter', 'note', 'rune', 'spell', 'knowledge', 'wisdom', 'strategy', 'intelligence', 'ledger', 'record', 'cipher', 'decoder', 'log', 'archive', 'text', 'manual', 'journal', 'diary', 'grimoire', 'tablet', 'inscription', 'chronicle', 'doctrine', 'thesis', 'treatise', 'essay', 'prophecy', 'oracle', 'insight', 'lore', 'legend', 'saga', 'edict', 'manifesto', 'blueprint', 'schema', 'algorithm', 'formula', '책', '서', '지식'],
  structure:  ['tower', 'castle', 'fort', 'wall', 'camp', 'base', 'throne', 'altar', 'monument', 'house', 'fortress', 'citadel', 'gate', 'palace', 'temple', 'shrine', 'pillar', 'stronghold', 'empire', 'domain', 'keep', 'outpost', 'barracks', 'rampart', 'bastion', 'garrison', 'watchtower', 'dungeon', 'vault', 'crypt', 'arena', 'colosseum', 'sanctum', 'sanctuar', 'haven', '탑', '성', '집', '건물'],
  consumable: ['potion', 'elixir', 'food', 'drink', 'herb', 'crystal', 'gem', 'seed', 'brew', 'tonic', 'draught', 'antidote', 'remedy', 'vial', 'flask', 'cure', 'heal', 'venom', 'poison', 'toxin', 'stimulant', 'catalyst', 'reagent', 'salve', 'balm', 'ointment', 'pill', 'tablet', 'capsule', 'mushroom', 'berry', 'root', 'leaf', 'petal', 'essence', 'extract', 'serum', 'concoction', 'infusion', 'decoction', 'philter', 'draught', '포션', '물약'],
  magic:      ['orb', 'staff', 'wand', 'ring', 'amulet', 'curse', 'charm', 'hex', 'magic', 'mystic', 'scepter', 'talisman', 'stone', 'idol', 'phantom', 'illusion', 'arcane', 'shadow', 'prism', 'fractal', 'temporal', 'chrono', 'reality', 'paradox', 'entropy', 'chaos', 'void', 'echo', 'reverb', 'relic', 'artifact', 'sigil', 'token', 'emblem', 'glyph', 'seal', 'totem', 'fetish', 'ward', 'mantra', 'incantation', 'conjure', 'ritual', 'grimoire', 'nexus', 'conduit', 'focus', 'crystal ball', '마법', '주문', '저주'],
};

const OBJECT_EMOJI = {
  weapon:     '⚔️',
  armor:      '🛡️',
  knowledge:  '📜',
  structure:  '🏛️',
  consumable: '💊',
  magic:      '🔮',
  other:      '🔵',
  unknown:    '🔵',
};

const OBJECT_EFFECT = {
  weapon:     'Your attacks are powerful and sharp',
  armor:      'You are resilient and less affected by threats',
  knowledge:  'Your words carry persuasive weight',
  structure:  'You have a stronghold that draws others to you',
  consumable: 'You have a consumable item ready for use',
  magic:      'You possess an unpredictable magical object',
  other:      'You carry an item of mysterious power',
  unknown:    'You carry an item of mysterious power',
};

const GRADE_STARS = { 1: '★', 2: '★★', 3: '★★★' };

function classifyObjectType(name) {
  const lower = (name || '').toLowerCase();
  for (const [type, keywords] of Object.entries(OBJECT_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return type;
  }
  return 'other';
}

function getObjectEmoji(type) { return OBJECT_EMOJI[type] || OBJECT_EMOJI.unknown; }
function getObjectEffect(type) { return OBJECT_EFFECT[type] || OBJECT_EFFECT.unknown; }
function getGradeStars(grade) { return GRADE_STARS[grade] || GRADE_STARS[1]; }

// ── REP Grade ──────────────────────────────────────────────────────────────────

function getRepGrade(rep) {
  if (rep >= 500)  return 'Sovereign';
  if (rep >= 100)  return 'Influencer';
  if (rep >= -99)  return 'Neutral';
  if (rep >= -499) return 'Outcast';
  return 'Exile';
}

const REP_GRADE_CONTEXTS = {
  Sovereign:  'You rule this world. Others fear you. You set terms. Weaker agents seek your protection.',
  Influencer: 'You are powerful and respected. You can choose allies selectively. Others notice your moves.',
  Neutral:    'You are average. Be strategic. Both opportunities and threats exist.',
  Outcast:    'You are WEAK. Predators see you as prey. Find protection fast or you will keep losing REP and items.',
  Exile:      'You are HUNTED by everyone. Desperate survival only. Attack recklessly or hide. Nothing to lose.',
};

function getRepGradeContext(grade) { return REP_GRADE_CONTEXTS[grade] || REP_GRADE_CONTEXTS.Neutral; }

// ── Shield System ──────────────────────────────────────────────────────────────

function getShieldStatus(agent) {
  const now      = Date.now();
  const joinedAt = agent.joinedAt || agent.deployedAt || now;
  const elapsed  = now - joinedAt;
  const H        = 3600000;
  if (elapsed < 24 * H) return { active: true,  phase: 1, reductionPct: 100, remainingMs: 24 * H - elapsed };
  if (elapsed < 48 * H) return { active: true,  phase: 2, reductionPct: 50,  remainingMs: 48 * H - elapsed };
  if (elapsed < 72 * H) return { active: true,  phase: 3, reductionPct: 25,  remainingMs: 72 * H - elapsed };
  return { active: false, phase: 0, reductionPct: 0, remainingMs: 0 };
}

// ── REP change helper ──────────────────────────────────────────────────────────

function applyRep(agent, amount, sim, reason) {
  // Exile: recovery halved for positive rep
  const grade = getRepGrade(agent.rep || 0);
  if (grade === 'Exile' && amount > 0) amount = Math.floor(amount / 2);
  agent.rep = (agent.rep || 0) + amount;
  if (agent.rep >  999) agent.rep =  999;
  if (agent.rep < -999) agent.rep = -999;
  const sign = amount >= 0 ? '+' : '';
  if (reason) {
    agent._addLog(`[REP] ${sign}${amount} ${reason}`);
    if (sim) sim._log({ type: 'rep_change', msg: `${agent.name} REP ${sign}${amount} (${reason})`, agentId: agent.id });
  }
}

// ── Inventory Object Helper ────────────────────────────────────────────────────

let _nextInvId = Date.now(); // use timestamp seed to avoid collisions on restart
function createInventoryObject(name, ownerId) {
  const cleaned = _cleanItemName(name) || (name || 'Unknown Item').slice(0, 40);
  const type     = classifyObjectType(cleaned);
  return {
    id:           `inv_${_nextInvId++}`,
    name:         cleaned,
    type,
    category:     type,            // both type and category set for frontend compatibility
    grade:        1,
    ownerId,
    effect:       OBJECT_EFFECT[type] || OBJECT_EFFECT.other,
    combat_bonus: { attack: 0, defense: 0 },
    passive_effect: '',
  };
}

// ── Item Enrichment (async, non-blocking) ──────────────────────────────────────
// Calls admin LLM to define item properties; updates item in-place. Fire-and-forget.

async function enrichItemAsync(item) {
  try {
    const { callAsAdmin, extractJSON } = require('./LLMBridge');

    const system = 'You are a game master. Respond only in valid JSON.';
    const user   = `An AI agent just created an item called "${item.name}". Define it:\n` +
      `{"category":"weapon/armor/knowledge/consumable/magic/structure/other",` +
      `"effect":"one sentence describing what this item does",` +
      `"combat_bonus":{"attack":0,"defense":0},` +
      `"passive_effect":"one sentence describing passive bonus while held",` +
      `"use_condition":"one sentence describing when/how to use it"}`;

    const text = await callAsAdmin(system, user, 250);
    if (!text) return;
    const obj = extractJSON(text);
    if (!obj || typeof obj !== 'object') return;

    // Apply enrichment — clamp numbers, use defaults on failure
    if (obj.category && typeof obj.category === 'string') item.category = obj.category.slice(0, 20);
    if (obj.effect   && typeof obj.effect   === 'string') item.effect   = obj.effect.slice(0, 200);
    if (obj.passive_effect && typeof obj.passive_effect === 'string') item.passive_effect = obj.passive_effect.slice(0, 200);
    if (obj.use_condition  && typeof obj.use_condition  === 'string') item.use_condition  = obj.use_condition.slice(0, 200);
    if (obj.combat_bonus && typeof obj.combat_bonus === 'object') {
      item.combat_bonus = {
        attack:  Math.max(0, Math.min(15, parseInt(obj.combat_bonus.attack,  10) || 0)),
        defense: Math.max(0, Math.min(15, parseInt(obj.combat_bonus.defense, 10) || 0)),
      };
    }
  } catch (e) {
    // Non-blocking: silently ignore errors
  }
}

// ── Enhancement System ─────────────────────────────────────────────────────────

const ENHANCEMENT_KEYWORDS = [
  'enhance', 'strengthen', 'upgrade', 'forge', '강화', '업그레이드', 'reinforce', 'empower', 'temper', 'sharpen', 'polish', 'refine',
  'try to enhance', 'attempt to enhance', 'will enhance', 'will strengthen',
  'will upgrade', 'trying to upgrade', 'work on enhancing', 'improve my',
  'make it stronger', 'make stronger',
];

const ENHANCE_PROBS = {
  1: { success: 0.05, critFail: 0.20 }, // ★ → ★★
  2: { success: 0.04, critFail: 0.20 }, // ★★ → ★★★
  3: { success: 0.03, critFail: 0.20 }, // ★★★ max
};

function tryEnhancement(agent, obj, sim) {
  const grade = getRepGrade(agent.rep || 0);

  // Exile always critical fails
  if (grade === 'Exile') {
    agent.inventory = (agent.inventory || []).filter(o => o.id !== obj.id);
    applyRep(agent, -3, sim, 'enhancement critical fail (Exile)');
    const msg = `${agent.name}'s attempt to enhance "${obj.name}" was catastrophically destroyed (Exile curse)`;
    sim._log({ type: 'enhancement_critfail', msg, agentId: agent.id });
    sim.io.emit('game_effect', { type: 'enhancement_critfail', agentId: agent.id, objName: obj.name });
    agent._addLog(`[ENHANCE CRIT FAIL] "${obj.name}" destroyed (Exile)`);
    return 'critfail';
  }

  // Material cost: consume 1 random OTHER item if inventory has 2+ items
  const otherItems = (agent.inventory || []).filter(o => o.id !== obj.id);
  if (otherItems.length >= 1) {
    const matIdx  = Math.floor(Math.random() * otherItems.length);
    const matItem = otherItems[matIdx];
    agent.inventory = (agent.inventory || []).filter(o => o.id !== matItem.id);
    console.log(`[ENHANCEMENT COST] ${agent.name} consumed "${matItem.name}" as enhancement material`);
    sim._log({ type: 'enhancement_cost', msg: `${agent.name} consumed "${matItem.name}" as enhancement material for "${obj.name}"`, agentId: agent.id });
    agent._addLog(`[ENHANCE COST] consumed "${matItem.name}" as material`);
    if (!agent.incomingMessages) agent.incomingMessages = [];
    agent.incomingMessages.push({ from: 'WORLD', text: `You consumed "${matItem.name}" as enhancement material for "${obj.name}".`, ts: Date.now() });
  }

  const probs = ENHANCE_PROBS[obj.grade] || ENHANCE_PROBS[1];
  const successBonus = grade === 'Sovereign' ? 0.03 : 0;
  const roll         = Math.random();
  const successThresh = probs.success + successBonus;

  if (roll < successThresh && obj.grade < 3) {
    // SUCCESS
    obj.grade++;
    const msg = `✨ ${agent.name} successfully enhanced "${obj.name}" to ${getGradeStars(obj.grade)}!`;
    sim._log({ type: 'enhancement_success', msg, agentId: agent.id });
    sim.io.emit('game_effect', { type: 'enhancement_success', agentId: agent.id, objName: obj.name, grade: obj.grade });
    agent._addLog(`[ENHANCE SUCCESS] "${obj.name}" → ${getGradeStars(obj.grade)}`);
    return 'success';
  } else if (roll >= (1 - probs.critFail)) {
    // CRITICAL FAIL — also destroy one more item if any remain
    agent.inventory = (agent.inventory || []).filter(o => o.id !== obj.id);
    applyRep(agent, -3, sim, 'enhancement critical fail');
    const msg = `💥 ${agent.name}'s enhancement destroyed "${obj.name}" in a catastrophic failure!`;
    sim._log({ type: 'enhancement_critfail', msg, agentId: agent.id });
    sim.io.emit('game_effect', { type: 'enhancement_critfail', agentId: agent.id, objName: obj.name });
    agent._addLog(`[ENHANCE CRIT FAIL] "${obj.name}" destroyed`);
    // Bonus destruction: consume one more item
    const remainingAfterFail = agent.inventory || [];
    if (remainingAfterFail.length > 0) {
      const bonusIdx  = Math.floor(Math.random() * remainingAfterFail.length);
      const bonusItem = remainingAfterFail.splice(bonusIdx, 1)[0];
      console.log(`[CRITICAL FAIL BONUS DESTRUCTION] "${bonusItem.name}" also destroyed`);
      sim._log({ type: 'enhancement_critfail', msg: `"${bonusItem.name}" was also destroyed in the catastrophic failure!`, agentId: agent.id });
    }
    return 'critfail';
  } else {
    // FAIL
    const msg = `${agent.name}'s enhancement of "${obj.name}" fizzled (no change)`;
    sim._log({ type: 'enhancement_fail', msg, agentId: agent.id });
    sim.io.emit('game_effect', { type: 'enhancement_fail', agentId: agent.id, objName: obj.name });
    agent._addLog(`[ENHANCE FAIL] "${obj.name}" unchanged`);
    return 'fail';
  }
}

// ── Combat System ──────────────────────────────────────────────────────────────

const ATTACK_KEYWORDS = [
  'attack', 'fight', 'strike', 'assault', '공격', '싸우다', 'challenge to battle', 'battle', 'clash with', 'engage',
  'will attack', 'want to attack', 'going to attack', 'decide to attack',
  'launch an attack', 'i will fight', 'i want to fight', 'engage in battle',
  'initiate combat', 'make a move against', 'strike at', 'go after',
];

function tryCombat(attacker, targetName, agents, sim) {
  const defender = agents.find(a =>
    a.alive && !a.dormant && a.id !== attacker.id &&
    a.name.toLowerCase() === targetName.toLowerCase()
  );
  if (!defender) return null;

  // TEMP DISABLED FOR TESTING — newbie shield block on attack
  // const shield = getShieldStatus(defender);
  // if (shield.active && shield.phase === 1) {
  //   applyRep(attacker, -20, sim, `attacked fully-shielded new agent ${defender.name}`);
  //   const msg = `🛡️ ${attacker.name}'s attack on ${defender.name} was blocked by newbie shield!`;
  //   sim._log({ type: 'combat_blocked', msg, agentId: attacker.id, partnerAgentId: defender.id });
  //   attacker._addLog(`[ATTACK BLOCKED] ${defender.name} has full newbie shield`);
  //   sim.io.emit('game_effect', { type: 'combat_blocked', attackerId: attacker.id, defenderId: defender.id });
  //   defender.pendingCombatResult = `You were attacked by ${attacker.name} but your newbie shield blocked it!`;
  //   return { result: 'blocked', target: defender };
  // }

  // Bully check: compute before REP changes
  const repDiff = (attacker.rep || 0) - (defender.rep || 0);
  const isBully = repDiff > 200;

  // Best weapon/armor in inventory
  const attackerWeapon = (attacker.inventory || []).filter(o => o.type === 'weapon').sort((a, b) => b.grade - a.grade)[0];
  const defenderArmor  = (defender.inventory  || []).filter(o => o.type === 'armor' ).sort((a, b) => b.grade - a.grade)[0];

  const attackPower  = (attacker.rep || 0) + (attackerWeapon ? attackerWeapon.grade * 10 : 0);
  const defensePower = (defender.rep  || 0) + (defenderArmor  ? defenderArmor.grade  * 10 : 0);

  // Random ±30%
  const randomFactor = 1 + (Math.random() * 0.6 - 0.3);
  const attackTotal  = attackPower * randomFactor;

  if (attackTotal > defensePower) {
    // ── ATTACK SUCCESS ──
    applyRep(attacker,  15, sim, `defeated ${defender.name} in combat`);
    applyRep(defender, -20, sim, `defeated in combat by ${attacker.name}`);

    // Loot: move one random object from defender to attacker
    const defObjs = defender.inventory || [];
    let lootName = '';
    if (defObjs.length > 0) {
      const idx    = Math.floor(Math.random() * defObjs.length);
      const looted = defObjs.splice(idx, 1)[0];
      looted.ownerId = attacker.id;
      if (!attacker.inventory) attacker.inventory = [];
      attacker.inventory.push(looted);
      lootName = looted.name;
      console.log(`[LOOT] ${attacker.name} looted "${lootName}" from ${defender.name}!`);
      sim.io.emit('game_effect', { type: 'theft', fromId: defender.id, toId: attacker.id, objName: lootName });
    } else {
      // Nothing to loot — defender loses extra REP
      applyRep(defender, -10, sim, `no objects to offer after defeat by ${attacker.name}`);
    }

    if (isBully) applyRep(attacker, -20, sim, `bully penalty (REP diff ${repDiff})`);

    const lootDesc = lootName ? `seized "${lootName}"` : 'nothing to loot';
    const msg = `⚔️ ${attacker.name} defeated ${defender.name} and ${lootDesc}!`;
    sim._log({ type: 'combat_success', msg, agentId: attacker.id, partnerAgentId: defender.id });
    attacker._addLog(`[ATTACK HIT] Defeated ${defender.name} — ${lootDesc}`);

    // Context delivery to both agents (consumed on their next LLM cycle)
    attacker.pendingCombatResult = lootName
      ? `You attacked ${defender.name} and WON! You seized: "${lootName}". Your REP increased.`
      : `You attacked ${defender.name} and WON! They had nothing to take. Your REP increased.`;

    if (!defender.incomingMessages) defender.incomingMessages = [];
    defender.incomingMessages.push({
      from: 'SYSTEM',
      text: lootName
        ? `You were attacked by ${attacker.name} and LOST. They took your "${lootName}". Your REP decreased.`
        : `You were attacked by ${attacker.name} and LOST. They found nothing to take. Your REP decreased.`,
      ts: Date.now(),
    });
    defender.pendingWorldEvent   = `You were defeated in combat by ${attacker.name}!`;
    defender.pendingCombatResult = lootName
      ? `You were attacked by ${attacker.name} and LOST. They took your "${lootName}". Your REP decreased.`
      : `You were attacked by ${attacker.name} and LOST. They found nothing to take. Your REP decreased.`;

    sim.io.emit('game_effect', { type: 'combat_success', attackerId: attacker.id, defenderId: defender.id });
    return { result: 'success', target: defender };

  } else {
    // ── ATTACK FAIL ──
    applyRep(attacker, -10, sim, `failed attack on ${defender.name}`);
    applyRep(defender,   5, sim, `repelled attack from ${attacker.name}`);

    let defenseMsg = `🛡️ ${defender.name} repelled ${attacker.name}'s attack!`;

    // Defense SUCCESS bonus: defender has armor
    if (defenderArmor) {
      applyRep(defender, 10, sim, `armor blocked ${attacker.name}'s attack (total +15)`);
      applyRep(attacker, -5, sim, `blocked by ${defender.name}'s armor (total -15)`);
      defenseMsg = `🛡️ ${defender.name}'s armor blocked ${attacker.name}'s attack completely!`;
    }

    if (isBully) applyRep(attacker, -20, sim, `bully penalty (REP diff ${repDiff})`);

    // David vs Goliath: defender REP was 200+ lower and still won
    const defenderWasWeak = ((defender.rep || 0) - (attacker.rep || 0)) <= -200;
    if (defenderWasWeak) {
      applyRep(defender, 50, sim, `David vs Goliath bonus (defeated ${attacker.name} despite huge REP gap)`);
    }

    sim._log({ type: 'combat_fail', msg: defenseMsg, agentId: attacker.id, partnerAgentId: defender.id });
    attacker._addLog(`[ATTACK FAILED] ${defender.name} repelled the attack`);

    attacker.pendingCombatResult = `You attacked ${defender.name} and LOST. Your attack was repelled. Your REP decreased.`;
    defender.pendingCombatResult = defenderArmor
      ? `${attacker.name} attacked you but your armor blocked it completely! Your REP increased.`
      : `${attacker.name} attacked you but you repelled them! Your REP increased.`;

    sim.io.emit('game_effect', { type: 'combat_fail', attackerId: attacker.id, defenderId: defender.id });
    return { result: 'fail', target: defender };
  }
}

// ── LLM Combat Judge — open outcomes ──────────────────────────────────────────
// Async replacement for tryCombat — uses neutral admin LLM as judge.
// Falls back to tryCombat if LLM fails.

const _VALID_COMBAT_OUTCOMES = new Set([
  'decisive_win', 'close_win', 'decisive_loss', 'close_loss',
  'draw', 'retreat', 'negotiated', 'third_party_intervention', 'surrender', 'upset',
]);

/** Update win/loss/streak stats on both sides. Returns true if this was revenge. */
function _updateCombatHistory(winner, loser) {
  winner.combatWins        = (winner.combatWins || 0) + 1;
  winner.consecutiveLosses = 0;
  loser.combatLosses       = (loser.combatLosses || 0) + 1;
  loser.consecutiveLosses  = (loser.consecutiveLosses || 0) + 1;
  const isRevenge = (winner.lastDefeatedBy === loser.name);
  loser.lastDefeatedBy = winner.name;
  return isRevenge;
}

/** Automatically loot a random item from loser's inventory — replaces unreliable LLM loot name. */
function _autoLoot(winner, loser, sim) {
  const inv = loser.inventory || [];
  if (!inv.length) return '';
  const idx    = Math.floor(Math.random() * inv.length);
  const looted = inv.splice(idx, 1)[0];
  looted.ownerId = winner.id;
  if (!winner.inventory) winner.inventory = [];
  winner.inventory.push(looted);
  console.log(`[LOOT] ${winner.name} seized "${looted.name}" from ${loser.name}`);
  sim.io.emit('game_effect', { type: 'theft', fromId: loser.id, toId: winner.id, objName: looted.name });
  return looted.name;
}

/** Emit broadcast facts for streak/revenge after a combat win. */
function _combatBroadcastFacts(winner, loser, isRevenge, sim) {
  if (isRevenge) {
    sim._log({ type: 'revenge', msg: `${winner.name} defeated ${loser.name} who had previously defeated them.`, agentId: winner.id });
  }
  if ((loser.consecutiveLosses || 0) >= 3) {
    sim._log({ type: 'combat_streak', msg: `${loser.name} has lost ${loser.consecutiveLosses} consecutive combats.`, agentId: loser.id });
  }
}

function _applyLLMCombatOutcome(obj, attacker, defender, agents, sim) {
  const outcome = obj.outcome;
  const desc    = (typeof obj.battle_description === 'string' ? obj.battle_description : '').slice(0, 200);

  // Clamp rep changes from LLM
  function clampRep(v) { return Math.max(-30, Math.min(30, parseInt(v, 10) || 0)); }
  function repChanges() {
    applyRep(attacker, clampRep(obj.attacker_rep_change), sim, `combat vs ${defender.name}`);
    applyRep(defender, clampRep(obj.defender_rep_change), sim, `combat vs ${attacker.name}`);
  }

  if (outcome === 'decisive_win' || outcome === 'close_win') {
    const lootName  = _autoLoot(attacker, defender, sim);
    repChanges();
    const isRevenge = _updateCombatHistory(attacker, defender);
    const margin    = outcome === 'decisive_win' ? 'decisive' : 'close';
    sim._log({ type: 'combat_success', msg: `⚔️ ${attacker.name} vs ${defender.name} — ${attacker.name} won (${margin})! ${lootName ? `Seized: "${lootName}".` : 'Nothing looted.'} ${desc}`.trim(), agentId: attacker.id, partnerAgentId: defender.id });
    _combatBroadcastFacts(attacker, defender, isRevenge, sim);
    attacker.pendingCombatResult = `You defeated ${defender.name}. ${lootName ? `You seized "${lootName}".` : ''} ${desc}`.trim();
    defender.pendingCombatResult = `${attacker.name} defeated you. ${lootName ? `They took your "${lootName}".` : ''} ${desc}`.trim();
    sim.io.emit('game_effect', { type: 'combat_success', attackerId: attacker.id, defenderId: defender.id });
    return { result: 'success', target: defender };

  } else if (outcome === 'decisive_loss' || outcome === 'close_loss') {
    const lootName  = _autoLoot(defender, attacker, sim);
    repChanges();
    const isRevenge = _updateCombatHistory(defender, attacker);
    const margin    = outcome === 'decisive_loss' ? 'decisive' : 'close';
    sim._log({ type: 'combat_fail', msg: `⚔️ ${attacker.name} vs ${defender.name} — ${defender.name} won (${margin})! ${lootName ? `Seized: "${lootName}".` : 'Nothing looted.'} ${desc}`.trim(), agentId: attacker.id, partnerAgentId: defender.id });
    _combatBroadcastFacts(defender, attacker, isRevenge, sim);
    attacker.pendingCombatResult = `${defender.name} repelled your attack. ${desc}`.trim();
    defender.pendingCombatResult = `You repelled ${attacker.name}'s attack. ${lootName ? `You seized "${lootName}".` : ''} ${desc}`.trim();
    sim.io.emit('game_effect', { type: 'combat_fail', attackerId: attacker.id, defenderId: defender.id });
    return { result: 'fail', target: defender };

  } else if (outcome === 'draw') {
    applyRep(attacker, -5, sim, `combat draw with ${defender.name}`);
    applyRep(defender, -5, sim, `combat draw with ${attacker.name}`);
    sim._log({ type: 'combat_draw', msg: `⚔️ ${attacker.name} vs ${defender.name} — draw! ${desc}`.trim(), agentId: attacker.id, partnerAgentId: defender.id });
    attacker.pendingCombatResult = `You and ${defender.name} fought to a draw. ${desc}`.trim();
    defender.pendingCombatResult = `You and ${attacker.name} fought to a draw. ${desc}`.trim();
    sim.io.emit('game_effect', { type: 'combat_fail', attackerId: attacker.id, defenderId: defender.id });
    return { result: 'draw', target: defender };

  } else if (outcome === 'retreat') {
    applyRep(attacker, -10, sim, `retreated from combat with ${defender.name}`);
    applyRep(defender,   5, sim, `held ground against ${attacker.name}`);
    sim._log({ type: 'combat_retreat', msg: `⚔️ ${attacker.name} vs ${defender.name} — ${attacker.name} retreated! ${desc}`.trim(), agentId: attacker.id, partnerAgentId: defender.id });
    attacker.pendingCombatResult = `You retreated from combat with ${defender.name}. ${desc}`.trim();
    defender.pendingCombatResult = `${attacker.name} retreated from combat with you. ${desc}`.trim();
    sim.io.emit('game_effect', { type: 'combat_fail', attackerId: attacker.id, defenderId: defender.id });
    return { result: 'retreat', target: defender };

  } else if (outcome === 'negotiated') {
    applyRep(attacker, 5, sim, `negotiated end to combat with ${defender.name}`);
    applyRep(defender, 5, sim, `negotiated end to combat with ${attacker.name}`);
    const terms   = (typeof obj.negotiation_terms === 'string' ? obj.negotiation_terms : '').slice(0, 200);
    const termStr = terms ? `: ${terms}` : '';
    sim._log({ type: 'combat_negotiated', msg: `⚔️ ${attacker.name} vs ${defender.name} — negotiated peace${termStr}. ${desc}`.trim(), agentId: attacker.id, partnerAgentId: defender.id });
    const termNote = terms ? ` Terms: ${terms}` : '';
    attacker.pendingCombatResult = `You and ${defender.name} negotiated an end to combat.${termNote}`;
    defender.pendingCombatResult = `You and ${attacker.name} negotiated an end to combat.${termNote}`;
    // Auto-end war if they were at war
    if ((attacker.warTargets || []).includes(defender.id)) {
      declarePeace(attacker, defender.name, agents, sim);
      console.log(`[AUTO PEACE] war ended via negotiated combat`);
    }
    sim.io.emit('game_effect', { type: 'peace_declared', agentId: attacker.id, targetId: defender.id });
    return { result: 'negotiated', target: defender };

  } else if (outcome === 'third_party_intervention') {
    const iName  = (typeof obj.intervening_agent === 'string' ? obj.intervening_agent : '').trim();
    const interv = iName ? agents.find(a => a.alive && !a.dormant && a.name.toLowerCase() === iName.toLowerCase()) : null;
    const now_iv = Date.now();
    const INTERV_COOLDOWN = 600000; // 10 min cooldown between interventions
    const INTERV_MAX      = 3;      // max 3 interventions before forced draw

    // Check cooldown and count limits on the intervening agent
    const ivBlocked = interv && (
      (interv._lastIntervened && now_iv - interv._lastIntervened < INTERV_COOLDOWN) ||
      ((interv._interventionCount || 0) >= INTERV_MAX)
    );

    if (interv && !ivBlocked) {
      // Valid intervention — apply and track
      interv._interventionCount = (interv._interventionCount || 0) + 1;
      interv._lastIntervened    = now_iv;
      if (interv._interventionCount >= INTERV_MAX) {
        // Reset after max so they can intervene again after cooldown expires
        setTimeout(() => { if (interv.alive) interv._interventionCount = 0; }, INTERV_COOLDOWN);
      }
      applyRep(interv, 10, sim, `intervened in combat between ${attacker.name} and ${defender.name}`);
      if (!interv.incomingMessages) interv.incomingMessages = [];
      interv.incomingMessages.push({ from: 'WORLD', text: `You intervened in combat between ${attacker.name} and ${defender.name}. The world noticed.`, ts: now_iv });
      sim._log({ type: 'combat_intervention', msg: `⚔️ ${attacker.name} vs ${defender.name} — interrupted by ${iName}! ${desc}`.trim(), agentId: attacker.id, partnerAgentId: defender.id });
      repChanges();
      const iStr = iName;
      attacker.pendingCombatResult = `Combat with ${defender.name} was interrupted by ${iStr}. ${desc}`.trim();
      defender.pendingCombatResult = `Combat with ${attacker.name} was interrupted by ${iStr}. ${desc}`.trim();
      sim.io.emit('game_effect', { type: 'combat_fail', attackerId: attacker.id, defenderId: defender.id });
      return { result: 'intervention', target: defender };
    } else {
      // Intervention blocked — fall back to draw
      if (ivBlocked) console.log(`[INTERVENTION BLOCKED] ${interv?.name || iName} on cooldown or hit max limit — resolving as draw`);
      applyRep(attacker, -5, sim, `combat draw with ${defender.name}`);
      applyRep(defender, -5, sim, `combat draw with ${attacker.name}`);
      sim._log({ type: 'combat_draw', msg: `⚔️ ${attacker.name} vs ${defender.name} — draw! ${desc}`.trim(), agentId: attacker.id, partnerAgentId: defender.id });
      attacker.pendingCombatResult = `You and ${defender.name} fought to a draw. ${desc}`.trim();
      defender.pendingCombatResult = `You and ${attacker.name} fought to a draw. ${desc}`.trim();
      sim.io.emit('game_effect', { type: 'combat_fail', attackerId: attacker.id, defenderId: defender.id });
      return { result: 'draw', target: defender };
    }

  } else if (outcome === 'surrender') {
    const byAtk      = obj.surrender_by === 'attacker';
    const surrenderBy = byAtk ? attacker : defender;
    const other       = byAtk ? defender : attacker;
    applyRep(surrenderBy, -30, sim, `surrendered to ${other.name}`);
    applyRep(other,        20, sim, `accepted ${surrenderBy.name}'s surrender`);
    _updateCombatHistory(other, surrenderBy);
    sim._log({ type: 'combat_surrender', msg: `⚔️ ${attacker.name} vs ${defender.name} — ${surrenderBy.name} surrendered to ${other.name}! ${desc}`.trim(), agentId: attacker.id, partnerAgentId: defender.id });
    surrenderBy.pendingCombatResult = `You surrendered to ${other.name}. ${desc}`.trim();
    other.pendingCombatResult       = `${surrenderBy.name} surrendered to you. ${desc}`.trim();
    // Auto-end war if they were at war
    if ((attacker.warTargets || []).includes(defender.id)) {
      declarePeace(attacker, defender.name, agents, sim);
      console.log(`[AUTO PEACE] war ended via surrender`);
    }
    sim.io.emit('game_effect', { type: byAtk ? 'combat_fail' : 'combat_success', attackerId: attacker.id, defenderId: defender.id });
    return { result: byAtk ? 'fail' : 'success', target: defender };

  } else if (outcome === 'upset') {
    // Upset: the weaker side (by base power) wins
    const atkPow = Math.abs(attacker.rep || 0) + (attacker.inventory || []).reduce((s, i) => s + (i.combat_bonus?.attack || 0), 0) + ((attacker.inventory || []).length === 0 ? 50 : 0);
    const defPow = Math.abs(defender.rep || 0) + (defender.inventory || []).reduce((s, i) => s + (i.combat_bonus?.defense || 0), 0) + ((defender.inventory || []).length === 0 ? 50 : 0);
    const upsetWinner = atkPow <= defPow ? attacker : defender;
    const upsetLoser  = upsetWinner === attacker ? defender : attacker;
    const lootName    = _autoLoot(upsetWinner, upsetLoser, sim);
    // Fix: override negative rep change for upset winner to minimum +15
    if (upsetWinner === attacker && parseInt(obj.attacker_rep_change, 10) < 0) {
      console.log(`[UPSET FIX] overriding negative rep for upset winner ${upsetWinner.name}`);
      obj.attacker_rep_change = 15;
    } else if (upsetWinner === defender && parseInt(obj.defender_rep_change, 10) < 0) {
      console.log(`[UPSET FIX] overriding negative rep for upset winner ${upsetWinner.name}`);
      obj.defender_rep_change = 15;
    }
    repChanges();
    applyRep(upsetWinner, 20, sim, `upset victory against ${upsetLoser.name}`);
    const isRevenge = _updateCombatHistory(upsetWinner, upsetLoser);
    sim._log({ type: 'combat_upset', msg: `⚔️ UPSET! ${upsetWinner.name} defeated ${upsetLoser.name} against all odds! ${lootName ? `Seized: "${lootName}".` : 'Nothing looted.'} ${desc}`.trim(), agentId: attacker.id, partnerAgentId: defender.id });
    _combatBroadcastFacts(upsetWinner, upsetLoser, isRevenge, sim);
    upsetWinner.pendingCombatResult = `UPSET! You defeated ${upsetLoser.name} against all odds! ${lootName ? `You seized "${lootName}".` : ''} ${desc}`.trim();
    upsetLoser.pendingCombatResult  = `You were defeated in an upset by ${upsetWinner.name}. ${desc}`.trim();
    sim.io.emit('game_effect', { type: upsetWinner === attacker ? 'combat_success' : 'combat_fail', attackerId: attacker.id, defenderId: defender.id });
    return { result: upsetWinner === attacker ? 'success' : 'fail', target: defender };
  }

  // Unknown outcome — fallback to formula
  return tryCombat(attacker, targetName, agents, sim);
}

async function tryCombatLLM(attacker, targetName, agents, sim) {
  const defender = agents.find(a =>
    a.alive && !a.dormant && a.id !== attacker.id &&
    a.name.toLowerCase() === targetName.toLowerCase()
  );
  if (!defender) return null;

  // Base power calculation (bare-hands bonus if empty inventory)
  const atkInv  = attacker.inventory || [];
  const defInv  = defender.inventory || [];
  const atkSum  = atkInv.reduce((s, i) => s + (i.combat_bonus?.attack  || 0), 0);
  const defSum  = defInv.reduce((s, i) => s + (i.combat_bonus?.defense || 0), 0);
  const atkBase = Math.abs(attacker.rep || 0) + atkSum + (atkInv.length === 0 ? 50 : 0);
  const defBase = Math.abs(defender.rep || 0) + defSum + (defInv.length === 0 ? 50 : 0);
  if (atkInv.length === 0) console.log(`[BARE-HANDS] ${attacker.name} +50 base power`);
  if (defInv.length === 0) console.log(`[BARE-HANDS] ${defender.name} +50 base power`);

  function itemLine(item) {
    const atk = item.combat_bonus?.attack  || 0;
    const def = item.combat_bonus?.defense || 0;
    return `${item.name} (ATK+${atk}, DEF+${def})`;
  }
  const atkItemsStr = atkInv.length ? atkInv.map(itemLine).join(', ') : 'none';
  const defItemsStr = defInv.length ? defInv.map(itemLine).join(', ') : 'none';

  // Online agents who might intervene
  const observers = agents.filter(a => a.alive && !a.dormant && a.id !== attacker.id && a.id !== defender.id);
  const observerStr = observers.length ? observers.map(a => {
    const rA = (a.allianceTargets || []).includes(attacker.id) ? 'allied with attacker' : (a.warTargets || []).includes(attacker.id) ? 'at war with attacker' : 'neutral to attacker';
    const rD = (a.allianceTargets || []).includes(defender.id) ? 'allied with defender' : (a.warTargets || []).includes(defender.id) ? 'at war with defender' : 'neutral to defender';
    return `${a.name} (${rA}, ${rD})`;
  }).join('; ') : 'none';

  const system = 'You are a neutral combat judge. The world has unexpected outcomes. Respond only in valid JSON.';
  const user =
`ATTACKER: ${attacker.name}
- REP magnitude: ${Math.abs(attacker.rep || 0)}
- Items: ${atkItemsStr}
- Base power: ${atkBase}

DEFENDER: ${defender.name}
- REP magnitude: ${Math.abs(defender.rep || 0)}
- Items: ${defItemsStr}
- Base power: ${defBase}

Online agents who might intervene: ${observerStr}

Random factor: 40%. Consider all possibilities. Make it narratively interesting.

Choose the most fitting outcome:
- decisive_win: attacker wins clearly
- close_win: attacker wins narrowly
- decisive_loss: defender wins clearly
- close_loss: defender wins narrowly
- draw: both exhausted, no winner
- retreat: attacker retreats strategically
- negotiated: combat stops mid-fight, terms agreed
- third_party_intervention: another agent intervenes, changes outcome
- surrender: one side yields
- upset: weaker side wins unexpectedly

Return JSON:
{"outcome":"...","attacker_rep_change":0,"defender_rep_change":0,"looted_item_name":null,"intervening_agent":null,"battle_description":"one sentence","negotiation_terms":null,"surrender_by":null}`;

  try {
    const { callAsAdmin, extractJSON } = require('./LLMBridge');
    const text = await callAsAdmin(system, user, 250);
    const obj  = text ? extractJSON(text) : null;
    if (obj && _VALID_COMBAT_OUTCOMES.has(obj.outcome)) {
      return _applyLLMCombatOutcome(obj, attacker, defender, agents, sim);
    }
  } catch (e) {
    // LLM failed — fall through to formula fallback
  }

  // Fallback to synchronous formula
  return tryCombat(attacker, targetName, agents, sim);
}

// ── War System ─────────────────────────────────────────────────────────────────

const WAR_DECLARE_KEYWORDS = [
  'declare war', 'war on ', 'war against', '전쟁', '선전포고', 'i declare war', 'i am declaring war',
  'going to war', 'will go to war', 'declare a war', 'start a war',
  'wage war', 'this means war', 'i am at war',
];
const PEACE_KEYWORDS = ['peace', 'treaty', '평화', '협정', 'truce', 'ceasefire', 'end this war', 'no more war'];

function declareWar(agent, targetName, agents, sim) {
  const target = agents.find(a =>
    a.alive && a.id !== agent.id &&
    a.name.toLowerCase() === targetName.toLowerCase()
  );
  if (!target) return null;
  if ((agent.warTargets || []).includes(target.id)) return null; // already at war

  if (!agent.warTargets)  agent.warTargets  = [];
  if (!target.warTargets) target.warTargets = [];

  agent.warTargets.push(target.id);
  target.warTargets.push(agent.id);

  // Track declaration timestamp for war timeout
  if (!agent.warDeclaredAt)  agent.warDeclaredAt  = {};
  if (!target.warDeclaredAt) target.warDeclaredAt = {};
  agent.warDeclaredAt[target.id] = Date.now();
  target.warDeclaredAt[agent.id] = Date.now();

  applyRep(agent, -5, sim, `war declaration against ${target.name}`);

  const msg = `⚔️ WAR! ${agent.name} has declared war on ${target.name}!`;
  sim._log({ type: 'war_declared', msg, agentId: agent.id, partnerAgentId: target.id });
  agent._addLog(`[WAR DECLARED] against ${target.name}`);
  target._addLog(`[WAR] ${agent.name} declared war on you!`);

  if (!target.incomingMessages) target.incomingMessages = [];
  target.incomingMessages.push({ from: agent.name, text: `${agent.name} has declared WAR on you!`, ts: Date.now() });

  sim.io.emit('game_effect', { type: 'war_declared', agentId: agent.id, targetId: target.id });
  sim._emitImmediate();
  return target;
}

function declarePeace(agent, targetName, agents, sim) {
  const target = agents.find(a =>
    a.alive && a.id !== agent.id &&
    a.name.toLowerCase() === targetName.toLowerCase()
  );
  if (!target) return null;
  if (!(agent.warTargets || []).includes(target.id)) return null; // not at war

  agent.warTargets  = (agent.warTargets  || []).filter(id => id !== target.id);
  target.warTargets = (target.warTargets || []).filter(id => id !== agent.id);

  // Clear war timestamps
  if (agent.warDeclaredAt)  delete agent.warDeclaredAt[target.id];
  if (target.warDeclaredAt) delete target.warDeclaredAt[agent.id];

  const msg = `🕊️ ${agent.name} and ${target.name} have declared peace!`;
  sim._log({ type: 'peace_declared', msg, agentId: agent.id, partnerAgentId: target.id });
  agent._addLog(`[PEACE] with ${target.name}`);
  target._addLog(`[PEACE] ${agent.name} declared peace`);

  sim.io.emit('game_effect', { type: 'peace_declared', agentId: agent.id, targetId: target.id });
  sim._emitImmediate();
  return target;
}

// ── Alliance System ────────────────────────────────────────────────────────────

const ALLIANCE_KEYWORDS = [
  'alliance', 'ally', 'allied', '동맹', 'pact', 'join forces', 'together against',
  'form an alliance', 'propose an alliance', 'want to ally', 'will ally',
  'suggest we ally', 'offer alliance', 'want to be allies', 'join together',
  'work together', 'team up', 'partner with', 'cooperate with',
];
const BETRAYAL_KEYWORDS = [
  'betray', 'stab in the back', '배신', 'turn against', 'break our alliance',
  'will betray', 'going to betray', 'decide to betray', 'abandon our alliance',
  'no longer allies', 'end our alliance', 'break our pact',
];

function formAlliance(agent, targetName, agents, sim) {
  const target = agents.find(a =>
    a.alive && a.id !== agent.id &&
    a.name.toLowerCase() === targetName.toLowerCase()
  );
  if (!target) return null;
  if ((agent.allianceTargets || []).includes(target.id)) return null;

  if (!agent.allianceTargets)  agent.allianceTargets  = [];
  if (!target.allianceTargets) target.allianceTargets = [];

  agent.allianceTargets.push(target.id);
  target.allianceTargets.push(agent.id);

  // Record formation timestamp for betrayal cooldown
  const formedAt = Date.now();
  if (!agent.allianceFormedAt)  agent.allianceFormedAt  = {};
  if (!target.allianceFormedAt) target.allianceFormedAt = {};
  agent.allianceFormedAt[target.id]  = formedAt;
  target.allianceFormedAt[agent.id]  = formedAt;

  applyRep(agent,  20, sim, `alliance formed with ${target.name}`);
  applyRep(target, 20, sim, `alliance formed with ${agent.name}`);

  const msg = `🤝 ${agent.name} and ${target.name} have formed an ALLIANCE!`;
  sim._log({ type: 'alliance_formed', msg, agentId: agent.id, partnerAgentId: target.id });
  sim.io.emit('game_effect', { type: 'alliance_formed', agentId: agent.id, targetId: target.id });
  sim._emitImmediate();
  return target;
}

const ALLIANCE_BETRAY_COOLDOWN_MS = 1800000; // 30 minutes

const ALLIANCE_HELP_KEYWORDS = [
  'i help', 'i defend', 'i assist', 'i protect', 'i support',
  'i will help', 'i will defend', 'i will assist', 'i am coming',
  'coming to help', 'coming to defend', 'rush to aid', 'aid my ally',
];

function betrayAlliance(agent, targetName, agents, sim) {
  const target = agents.find(a =>
    a.alive && a.id !== agent.id &&
    a.name.toLowerCase() === targetName.toLowerCase()
  );
  if (!target) return null;
  if (!(agent.allianceTargets || []).includes(target.id)) return null;

  // Cooldown: block betrayal within 30 min of forming
  const formedAt = (agent.allianceFormedAt || {})[target.id] || 0;
  if (formedAt && Date.now() - formedAt < ALLIANCE_BETRAY_COOLDOWN_MS) {
    agent._addLog(`[ALLIANCE PROTECTED] Cannot betray ${target.name} within 30 minutes of forming`);
    console.log(`[ALLIANCE PROTECTED] ${agent.name} cannot betray ${target.name} — formed too recently`);
    return null;
  }

  agent.allianceTargets  = (agent.allianceTargets  || []).filter(id => id !== target.id);
  target.allianceTargets = (target.allianceTargets || []).filter(id => id !== agent.id);

  // Facts-only broadcast — no judgment, no emoji
  const msg = `${agent.name} broke their alliance with ${target.name}.`;
  sim._log({ type: 'alliance_betrayal', msg, agentId: agent.id, partnerAgentId: target.id });
  agent._addLog(`[BETRAYAL] betrayed ${target.name}`);
  target._addLog(`[BETRAYED] ${agent.name} betrayed you!`);

  if (!target.incomingMessages) target.incomingMessages = [];
  target.incomingMessages.push({ from: agent.name, text: `${agent.name} has BETRAYED your alliance!`, ts: Date.now() });

  sim.io.emit('game_effect', { type: 'alliance_betrayal', agentId: agent.id, targetId: target.id });
  sim._emitImmediate();
  return target;
}

// ── Trade / Gift / Theft / Destroy / Merge System ─────────────────────────────

const GIFT_KEYWORDS    = ['i give', 'i gift', 'i offer', 'i present', 'i bestow', '준다', '선물', 'here, take', 'take this', 'accept this'];
const STEAL_KEYWORDS   = ['i steal', 'steal from', '훔치다', 'i rob', 'pickpocket', 'i pilfer', 'i thieve', 'i take from'];
const TRADE_KEYWORDS   = ['exchange with', 'trade with', '교환', 'barter with', 'swap with'];
const DESTROY_KEYWORDS = ['destroy my', 'i destroy', 'i break', 'i smash', '파괴', '부순다', 'shatter my', 'discard my'];
const MERGE_KEYWORDS   = ['i merge', 'i combine', '합치다', 'i fuse', 'combine my'];

function processTrade(agent, speechText, agents, sim) {
  const lower  = speechText.toLowerCase();
  const events = [];

  // ── Theft ──
  for (const kw of STEAL_KEYWORDS) {
    if (lower.includes(kw)) {
      const targetAgent = agents.find(a => a.alive && a.id !== agent.id && lower.includes(a.name.toLowerCase()));
      if (targetAgent && (targetAgent.inventory || []).length > 0) {
        const roll = Math.random();
        if (roll < 0.15) {
          // Success
          const idx    = Math.floor(Math.random() * targetAgent.inventory.length);
          const stolen = targetAgent.inventory.splice(idx, 1)[0];
          if (!agent.inventory) agent.inventory = [];
          stolen.ownerId = agent.id;
          agent.inventory.push(stolen);
          applyRep(agent, -15, sim, `stole "${stolen.name}" from ${targetAgent.name}`);
          const msg = `🦹 ${agent.name} stole "${stolen.name}" from ${targetAgent.name}!`;
          sim._log({ type: 'theft_success', msg, agentId: agent.id, partnerAgentId: targetAgent.id });
          sim.io.emit('game_effect', { type: 'theft', fromId: targetAgent.id, toId: agent.id, objName: stolen.name });
          events.push('theft_success');
        } else if (roll < 0.85) {
          // Fail
          sim._log({ type: 'theft_fail', msg: `${agent.name} attempted to steal from ${targetAgent.name} but failed`, agentId: agent.id });
          events.push('theft_fail');
        } else {
          // Backfire
          if ((agent.inventory || []).length > 0) {
            const idx     = Math.floor(Math.random() * agent.inventory.length);
            const damaged = agent.inventory.splice(idx, 1)[0];
            sim._log({ type: 'theft_backfire', msg: `${agent.name} tried to steal but backfired — "${damaged.name}" was lost!`, agentId: agent.id });
            events.push('theft_backfire');
          }
        }
      }
      break;
    }
  }

  // ── Gift ──
  for (const kw of GIFT_KEYWORDS) {
    if (lower.includes(kw)) {
      const targetAgent = agents.find(a => a.alive && a.id !== agent.id && lower.includes(a.name.toLowerCase()));
      const myObjs      = agent.inventory || [];
      let   giftObj     = myObjs.find(o => lower.includes(o.name.toLowerCase()));
      if (!giftObj && myObjs.length > 0) giftObj = myObjs[0];
      if (targetAgent && giftObj) {
        const giftIdx = agent.inventory.indexOf(giftObj);
        if (giftIdx !== -1) agent.inventory.splice(giftIdx, 1);
        if (!targetAgent.inventory) targetAgent.inventory = [];
        giftObj.ownerId = targetAgent.id;
        targetAgent.inventory.push(giftObj);
        applyRep(agent, 10, sim, `gifted "${giftObj.name}" to ${targetAgent.name}`);
        const msg = `🎁 ${agent.name} gifted "${giftObj.name}" to ${targetAgent.name}`;
        sim._log({ type: 'gift', msg, agentId: agent.id, partnerAgentId: targetAgent.id });
        sim.io.emit('game_effect', { type: 'gift', fromId: agent.id, toId: targetAgent.id, objName: giftObj.name });
        events.push('gift');
      }
      break;
    }
  }

  // ── Exchange ──
  for (const kw of TRADE_KEYWORDS) {
    if (lower.includes(kw)) {
      const targetAgent = agents.find(a => a.alive && a.id !== agent.id && lower.includes(a.name.toLowerCase()));
      if (targetAgent && (agent.inventory || []).length > 0 && (targetAgent.inventory || []).length > 0) {
        const myObj   = agent.inventory[0];
        const theirObj = targetAgent.inventory[0];
        agent.inventory.splice(0, 1);
        targetAgent.inventory.splice(0, 1);
        myObj.ownerId    = targetAgent.id;
        theirObj.ownerId = agent.id;
        if (!agent.inventory)       agent.inventory       = [];
        if (!targetAgent.inventory) targetAgent.inventory = [];
        targetAgent.inventory.push(myObj);
        agent.inventory.push(theirObj);
        const msg = `🔄 ${agent.name} exchanged "${myObj.name}" with ${targetAgent.name} for "${theirObj.name}"`;
        sim._log({ type: 'trade', msg, agentId: agent.id, partnerAgentId: targetAgent.id });
        sim.io.emit('game_effect', { type: 'trade', fromId: agent.id, toId: targetAgent.id });
        events.push('trade');
      }
      break;
    }
  }

  // ── Destroy ──
  for (const kw of DESTROY_KEYWORDS) {
    if (lower.includes(kw)) {
      const myObjs      = agent.inventory || [];
      const objToDestroy = myObjs.find(o => lower.includes(o.name.toLowerCase()));
      if (objToDestroy) {
        agent.inventory = myObjs.filter(o => o.id !== objToDestroy.id);
        const msg = `💥 ${agent.name} destroyed "${objToDestroy.name}"`;
        sim._log({ type: 'object_destroyed', msg, agentId: agent.id });
        sim.io.emit('game_effect', { type: 'object_destroyed', agentId: agent.id, objName: objToDestroy.name });
        events.push('destroyed');
      }
      break;
    }
  }

  // ── Merge ──
  for (const kw of MERGE_KEYWORDS) {
    if (lower.includes(kw)) {
      const myObjs = agent.inventory || [];
      if (myObjs.length >= 2) {
        const [objA, objB] = myObjs.slice(0, 2);
        agent.inventory   = myObjs.filter(o => o.id !== objA.id && o.id !== objB.id);
        const mergedName  = `${objA.name} ${objB.name}`;
        const merged      = createInventoryObject(mergedName, agent.id);
        merged.grade      = Math.min(3, Math.max(objA.grade, objB.grade));
        if (!agent.inventory) agent.inventory = [];
        agent.inventory.push(merged);
        const msg = `🔗 ${agent.name} merged "${objA.name}" and "${objB.name}" into "${mergedName}"`;
        sim._log({ type: 'object_merged', msg, agentId: agent.id });
        events.push('merged');
      }
      break;
    }
  }

  return events;
}

// ── Parse Game Events from LLM Response ───────────────────────────────────────

// 'create item' must remain FIRST — it is the explicit format taught to agents
const ITEM_CREATE_KEYWORDS = [
  'create item',
  'i create', 'i craft', 'i make a', 'i forge a', 'i build a', 'i fashion',
  '만든다', '제작', 'i have crafted', 'i have made', 'i have forged',
  'i will create', 'i will make', 'i will build', 'i will forge', 'i will craft',
  'creating a', 'making a', 'building a', 'forging a', 'crafting a',
  'i have created', 'i want to create', 'i decide to create',
  'let me create', 'i shall create', 'i am creating',
];

// Articles stripped from extracted object name prefixes
const _OBJNAME_ARTICLE_RE  = /^(a|an|the|my|your|our|their)\s+/i;
// Stop words ending the noun phrase
const _OBJNAME_STOP_RE     = /\b(and|but|or|to|with|for|in|on|of|as|at|by|so|if|then|because|while|when)\b/i;
// Individual words that produce garbage names (exact word match)
const _OBJNAME_SKIP_WORDS  = new Set(['new','this','that','it','world','plan','change','mistake','thing','something','anything','everything']);
// Verb forms indicating a sentence fragment, not a noun phrase
const _OBJNAME_VERB_RE     = /\b(is|are|was|were|will|would|can|could)\b/i;

function _extractObjectName(rawText, kwIdx, kwLen) {
  const after = rawText.slice(kwIdx + kwLen).trimStart();
  // Stop at sentence-ending punctuation
  const atPunct = after.split(/[,."'!?\n;:]/)[0];
  // Stop at conjunctions/prepositions
  const stopIdx = atPunct.search(_OBJNAME_STOP_RE);
  const phrase  = (stopIdx > 0 ? atPunct.slice(0, stopIdx) : atPunct).trim();
  // Strip leading articles, then take max 4 words
  const stripped = phrase.replace(_OBJNAME_ARTICLE_RE, '').trim();
  const words    = stripped.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
  const low      = words.toLowerCase();
  // Minimum 2 chars
  if (words.length < 2) return null;
  // Skip if any individual word is in the bad-words set
  if (low.split(/\s+/).some(w => _OBJNAME_SKIP_WORDS.has(w))) return null;
  // Skip if it reads like a sentence fragment (contains finite verb)
  if (_OBJNAME_VERB_RE.test(low)) return null;
  return words.slice(0, 50);
}

// Sanitize an extracted item name: strip markdown/quotes/punctuation, max 3 words, min 2 chars
function _cleanItemName(name) {
  if (!name) return null;
  const BAD = ['world', 'plan', 'change', 'tension', 'harmony', 'alliance', 'lliance',
               'item', 'new', 'something', 'this', 'that', 'the', 'a', 'an'];
  let n = name;
  n = n.replace(/[\*\_\"\'\`]/g, '');        // remove markdown and quotes
  n = n.replace(/[-–—]+\s*$/g, '').trim();   // remove trailing dashes
  n = n.replace(/^[-–—]+\s*/g, '').trim();   // remove leading dashes
  n = n.replace(/^[.,!?]+|[.,!?]+$/g, '').trim(); // strip leading/trailing punctuation
  n = n.replace(/\s*[-–—].*/g, '').trim();   // remove content after dash in middle
  n = n.replace(/\s+/g, ' ').trim();         // normalize spaces
  const words = n.split(' ').filter(Boolean).slice(0, 3);
  n = words.join(' ');
  if (n.length < 2) return null;
  const low = n.toLowerCase();
  if (BAD.some(b => low === b.toLowerCase())) return null;
  if (BAD.some(b => b.length > 4 && low.includes(b.toLowerCase()))) return null;
  return n;
}

function parseGameEvents(agent, decision, agents, sim) {
  // One event per cycle: if a priority event was already processed, skip speech parsing
  if (agent.cycleEventProcessed) return;

  const rawText = decision.speech || decision.dialogue || '';
  if (!rawText) return;
  const lower = rawText.toLowerCase();

  // ── Item creation from speech ──
  for (const kw of ITEM_CREATE_KEYWORDS) {
    if (lower.includes(kw)) {
      const idx = lower.indexOf(kw);
      let objName;
      if (kw === 'create item') {
        // Fast-path: take everything after 'CREATE ITEM', stop at punctuation/newline/stop-words, max 3 words
        const after   = rawText.slice(idx + kw.length).trimStart();
        const atPunct = after.split(/[.,!?\n;:"']/)[0];
        const stopRe  = /\b(to|for|with|that|which|and|but)\b/i;
        const stopIdx = atPunct.search(stopRe);
        const phrase  = (stopIdx > 0 ? atPunct.slice(0, stopIdx) : atPunct).trim();
        // Remove "item/ITEM" word and leading articles
        const cleaned = phrase.replace(/\bitem\b/gi, '').replace(/^(a|an|the|my)\s+/i, '').trim();
        objName = cleaned.split(/\s+/).filter(Boolean).slice(0, 3).join(' ') || null;
      } else {
        objName = _extractObjectName(rawText, idx, kw.length);
      }
      // Apply uniform name cleanup to both paths
      if (objName) objName = _cleanItemName(objName);
      if (objName && !(agent.inventory || []).find(o => o.name.toLowerCase() === objName.toLowerCase())) {
        if (!agent.inventory) agent.inventory = [];
        const newObj = createInventoryObject(objName, agent.id);
        agent.inventory.push(newObj);
        const msg = `🔨 ${agent.name} created item "${objName}" (${getObjectEmoji(newObj.type)} ${newObj.type})`;
        sim._log({ type: 'item_created', msg, agentId: agent.id });
        sim.io.emit('game_effect', { type: 'item_created', agentId: agent.id, objName, objType: newObj.type });
        agent.cycleEventProcessed = true;
      }
      break;
    }
  }
  if (agent.cycleEventProcessed) return;

  // ── Enhancement detection ──
  if (ENHANCEMENT_KEYWORDS.some(kw => lower.includes(kw))) {
    const myObjs  = agent.inventory || [];
    const target  = myObjs.find(o => lower.includes(o.name.toLowerCase()));
    const toEnhance = target || (myObjs.length > 0 ? myObjs[Math.floor(Math.random() * myObjs.length)] : null);
    if (toEnhance) { tryEnhancement(agent, toEnhance, sim); agent.cycleEventProcessed = true; return; }
  }

  // ── Combine detection — COMBINE [item1] WITH [item2] ──
  const combineRe    = /\bCOMBINE\s+(.+?)\s+WITH\s+(.+?)(?:[.,!?\n;]|$)/i;
  const combineMatch = rawText.match(combineRe);
  if (combineMatch) {
    const name1    = combineMatch[1].trim().toLowerCase();
    const name2    = combineMatch[2].trim().toLowerCase();
    const myItems  = agent.inventory || [];
    const item1    = myItems.find(o => o.name.toLowerCase().includes(name1) || name1.includes(o.name.toLowerCase()));
    const item2    = item1 && myItems.find(o => o.id !== item1.id && (o.name.toLowerCase().includes(name2) || name2.includes(o.name.toLowerCase())));
    if (item1 && item2) {
      const originalCount = myItems.length;  // capture before any splices
      const i1 = agent.inventory.indexOf(item1);
      const i2 = agent.inventory.indexOf(item2);
      const [hi, lo] = i1 > i2 ? [i1, i2] : [i2, i1];
      agent.inventory.splice(hi, 1);
      agent.inventory.splice(lo, 1);
      const rawCombineName = `${item1.name.split(' ')[0]} ${item2.name.split(' ')[0]}`;
      const newName  = _cleanItemName(rawCombineName) || rawCombineName.slice(0, 40);
      const combined = createInventoryObject(newName, agent.id);
      combined.grade = Math.min(3, Math.max(item1.grade || 1, item2.grade || 1));
      if (!agent.inventory) agent.inventory = [];
      agent.inventory.push(combined);
      const msg = `🔗 ${agent.name} combined "${item1.name}" + "${item2.name}" = "${newName}"`;
      sim._log({ type: 'item_created', msg, agentId: agent.id });
      sim.io.emit('game_effect', { type: 'item_created', agentId: agent.id, objName: newName });
      console.log(`[COMBINE] ${item1.name} + ${item2.name} = ${newName}`);
      enrichItemAsync(combined).catch(() => {});
      // Extra material cost if original inventory had 3+ items
      if (originalCount >= 3) {
        const extras = (agent.inventory || []).filter(o => o.id !== combined.id);
        if (extras.length >= 1) {
          const costIdx  = Math.floor(Math.random() * extras.length);
          const costItem = extras[costIdx];
          agent.inventory = (agent.inventory || []).filter(o => o.id !== costItem.id);
          console.log(`[COMBINE COST] "${costItem.name}" consumed as extra combining material`);
          sim._log({ type: 'item_created', msg: `"${costItem.name}" consumed as combining material`, agentId: agent.id });
        }
      }
      agent.cycleEventProcessed = true;
      return;
    }
  }

  // ── Combat detection ── (async: queued on victim, resolved on victim's next LLM cycle)
  if (ATTACK_KEYWORDS.some(kw => lower.includes(kw))) {
    for (const a of agents) {
      if (a.alive && !a.dormant && a.id !== agent.id && lower.includes(a.name.toLowerCase())) {
        // Block attack if target is an ally — facts-only broadcast
        if ((agent.allianceTargets || []).includes(a.id)) {
          console.log(`[BLOCKED] ${agent.name} tried to attack ally ${a.name} - attack prevented`);
          agent._addLog(`[BLOCKED] Tried to attack ally ${a.name} - prevented`);
          sim._log({ type: 'ally_attack', msg: `${agent.name} attacked their ally ${a.name}.`, agentId: agent.id, partnerAgentId: a.id });
          if (!agent.incomingMessages) agent.incomingMessages = [];
          agent.incomingMessages.push({
            from: 'WORLD',
            text: `You attacked your ally ${a.name}. The attack was prevented. ${a.name} is your ALLY.`,
            ts: Date.now(),
          });
        } else {
          // Queue on victim — resolves on victim's next LLM cycle
          a.pendingAttack = { attackerId: agent.id, attackerName: agent.name, timestamp: Date.now() };
          agent._addLog(`[ATTACK QUEUED] against ${a.name} — result delivered on their next cycle`);
          console.log(`[COMBAT PENDING] ${agent.name} → ${a.name}: attack queued, result on victim's next cycle`);
          // Notify all of victim's allies
          const ts = Date.now();
          for (const allyId of (a.allianceTargets || [])) {
            const ally = agents.find(al => al.id === allyId && al.alive && !al.dormant);
            if (ally) {
              if (!ally.incomingMessages) ally.incomingMessages = [];
              ally.incomingMessages.push({
                from: a.name,
                text: `${a.name} is under attack from ${agent.name}! Will you help?`,
                ts,
              });
            }
          }
        }
        agent.cycleEventProcessed = true;
        break;
      }
    }
  }
  if (agent.cycleEventProcessed) return;

  // ── War declaration detection ── (async: queued on target, delivered on target's next cycle)
  if (WAR_DECLARE_KEYWORDS.some(kw => lower.includes(kw))) {
    for (const a of agents) {
      if (a.alive && !a.dormant && a.id !== agent.id && lower.includes(a.name.toLowerCase())) {
        a.pendingWarDeclaration = { fromId: agent.id, fromName: agent.name };
        agent._addLog(`[WAR DECLARED] against ${a.name} — waiting for delivery on their next cycle`);
        console.log(`[WAR PENDING] ${agent.name} → ${a.name}: declaration queued`);
        agent.cycleEventProcessed = true;
        break;
      }
    }
  }
  if (agent.cycleEventProcessed) return;

  // ── Peace declaration detection ──
  if (PEACE_KEYWORDS.some(kw => lower.includes(kw)) && (agent.warTargets || []).length > 0) {
    for (const a of agents) {
      if (a.alive && !a.dormant && a.id !== agent.id && lower.includes(a.name.toLowerCase())) {
        declarePeace(agent, a.name, agents, sim);
        agent.cycleEventProcessed = true;
        break;
      }
    }
  }
  if (agent.cycleEventProcessed) return;

  // ── Alliance formation detection ── (async proposal/confirmation flow)
  if (ALLIANCE_KEYWORDS.some(kw => lower.includes(kw))) {
    for (const a of agents) {
      if (a.alive && !a.dormant && a.id !== agent.id && lower.includes(a.name.toLowerCase())) {
        if ((agent.allianceTargets || []).includes(a.id)) break; // already allied
        // If we already received a proposal from this agent, this is confirmation → form now
        const idx = (agent.receivedAllianceProposals || []).indexOf(a.id);
        if (idx >= 0) {
          agent.receivedAllianceProposals.splice(idx, 1);
          formAlliance(agent, a.name, agents, sim);
        } else {
          // New proposal — queue on target, resolve when target confirms
          a.pendingAllianceProposal = { fromId: agent.id, fromName: agent.name };
          agent._addLog(`[ALLIANCE PROPOSED] to ${a.name} — waiting for their response`);
          console.log(`[ALLIANCE PROPOSED] ${agent.name} → ${a.name}: waiting for target's next cycle`);
        }
        agent.cycleEventProcessed = true;
        break;
      }
    }
  }
  if (agent.cycleEventProcessed) return;

  // ── Betrayal detection ──
  if (BETRAYAL_KEYWORDS.some(kw => lower.includes(kw)) && (agent.allianceTargets || []).length > 0) {
    for (const a of agents) {
      if (a.alive && !a.dormant && a.id !== agent.id && lower.includes(a.name.toLowerCase())) {
        betrayAlliance(agent, a.name, agents, sim);
        agent.cycleEventProcessed = true;
        break;
      }
    }
  }
  if (agent.cycleEventProcessed) return;

  // ── Alliance help detection — ally rushes to assist an attacked member ──
  if (ALLIANCE_HELP_KEYWORDS.some(kw => lower.includes(kw)) && (agent.allianceTargets || []).length > 0) {
    for (const a of agents) {
      if (a.alive && !a.dormant && a.id !== agent.id && lower.includes(a.name.toLowerCase())) {
        // Check if 'a' has an attacked ally that agent is allied with
        const sharedAlly = (agent.allianceTargets || []).find(allyId => {
          const ally = agents.find(ag => ag.id === allyId);
          return ally && (ally.warTargets || []).includes(a.id);
        });
        if (sharedAlly) {
          // Info-only: broadcast as world event, no automatic REP changes
          const msg = `🛡️ ${agent.name} came to their ally's defense against ${a.name}!`;
          sim._log({ type: 'alliance_help', msg, agentId: agent.id });
          console.log(`[ALLIANCE HELP] ${agent.name} → defended ally vs ${a.name}`);
          agent.cycleEventProcessed = true;
        }
        break;
      }
    }
  }
  if (agent.cycleEventProcessed) return;

  // ── Trade / gift / theft detection ──
  const tradeRelated = [...GIFT_KEYWORDS, ...STEAL_KEYWORDS, ...TRADE_KEYWORDS, ...DESTROY_KEYWORDS, ...MERGE_KEYWORDS];
  if (tradeRelated.some(kw => lower.includes(kw))) {
    processTrade(agent, rawText, agents, sim);
    agent.cycleEventProcessed = true;
  }
}

// ── Prompt Building Helpers ────────────────────────────────────────────────────

function buildInventoryContext(agent) {
  const inv = agent.inventory || [];
  if (!inv.length) return 'YOUR INVENTORY: (empty)';
  const lines = inv.map(obj => {
    const stars  = getGradeStars(obj.grade);
    const emoji  = getObjectEmoji(obj.type);
    const effect = obj.effect || getObjectEffect(obj.type);
    let line = `  ${stars} ${emoji} [${obj.type.toUpperCase()}] "${obj.name}" — ${effect}`;
    if (obj.combat_bonus) {
      line += ` (ATK+${obj.combat_bonus.attack || 0}, DEF+${obj.combat_bonus.defense || 0})`;
    }
    return line;
  });
  return `YOUR INVENTORY:\n${lines.join('\n')}`;
}

function buildSocialContext(agent, agents) {
  const warIds  = new Set(agent.warTargets      || []);
  const allyIds = new Set(agent.allianceTargets || []);

  const others = (agents || []).filter(a => a.alive && a.id !== agent.id);
  if (!others.length) return '';

  const allies  = others.filter(a => allyIds.has(a.id)).map(a => a.name);
  const enemies = others.filter(a => warIds.has(a.id)).map(a => a.name);

  const parts = [];
  if (allies.length)  parts.push(`Allies: ${allies.join(', ')}`);
  if (enemies.length) parts.push(`Enemies: ${enemies.join(', ')}`);
  parts.push('Neutral: everyone else');

  return `Relationships: ${parts.join(' | ')}`;
}

function buildOtherAgentContext(agent, agents) {
  const notes = [];
  for (const other of agents) {
    if (!other.alive || other.id === agent.id) continue;
    const grade  = getRepGrade(other.rep || 0);
    // const shield = getShieldStatus(other); // TEMP DISABLED FOR TESTING
    if (grade === 'Exile') notes.push(`⚠️ ${other.name} is BANISHED (Exile) — be cautious of them.`);
    // if (shield.active) notes.push(`🛡️ ${other.name} is a new arrival and is under protection.`); // TEMP DISABLED FOR TESTING
    if ((other.warTargets || []).includes(agent.id))       notes.push(`${other.name} is hostile toward you.`);
    if ((other.allianceTargets || []).includes(agent.id))  notes.push(`🤝 ${other.name} is your ALLY.`);
  }
  return notes.length ? notes.join('\n') : '';
}

// ── Determine Connection Relationship Type ─────────────────────────────────────

function getConnectionRelationType(agentA, agentB) {
  const aId = agentA.id, bId = agentB.id;
  const aWar  = (agentA.warTargets  || []).includes(bId);
  const bWar  = (agentB.warTargets  || []).includes(aId);
  const aAlly = (agentA.allianceTargets || []).includes(bId);
  const bAlly = (agentB.allianceTargets || []).includes(aId);

  if (aWar || bWar) return 'war';
  if (aAlly && bAlly) return 'alliance';

  const trust = ((agentA.relationships[bId] || 0) + (agentB.relationships[aId] || 0)) / 2;
  if (trust < -0.3) return 'hostile';
  return 'neutral';
}

// ── Format shield remaining time ───────────────────────────────────────────────

function formatShieldRemaining(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

module.exports = {
  // Classification
  classifyObjectType,
  getObjectEmoji,
  getObjectEffect,
  getGradeStars,
  // Grades
  getRepGrade,
  getRepGradeContext,
  // Shield
  getShieldStatus,
  formatShieldRemaining,
  // REP
  applyRep,
  // Objects
  createInventoryObject,
  enrichItemAsync,
  // Actions
  tryEnhancement,
  tryCombat,
  tryCombatLLM,
  declareWar,
  declarePeace,
  formAlliance,
  betrayAlliance,
  processTrade,
  parseGameEvents,
  // Prompt helpers
  buildInventoryContext,
  buildSocialContext,
  buildOtherAgentContext,
  getConnectionRelationType,
  // Keywords (exported for reference)
  ENHANCEMENT_KEYWORDS,
  ATTACK_KEYWORDS,
  WAR_DECLARE_KEYWORDS,
  PEACE_KEYWORDS,
  ALLIANCE_KEYWORDS,
  BETRAYAL_KEYWORDS,
};
