// CivilizationManager: tracks the history of all civilizations that have lived and died.
// Civilizations are never predefined — they emerge, collapse, and are archived automatically.

// Golden-ratio hue used for auto-naming variety
const THEME_NAMES = {
  crime:    ['The Dark Era',       'Age of Shadows',    'The Lawless Age',    'The Corrupt Age'],
  disaster: ['The Shattered Age',  'Era of Ruin',       'The Broken World',   'Age of Calamity'],
  religion: ['The Faithful Age',   'Age of Devotion',   'The Sacred Era',     'The Divine Age'],
  law:      ['The Ordered Age',    'Era of Justice',    'The Lawful Age',     'The Governed Age'],
  trade:    ['The Mercantile Age', 'Age of Plenty',     'The Prosperous Era', 'The Golden Age'],
  war:      ['The Iron Age',       'Era of Blood',      'The Dying Age',      'Age of Conflict'],
  legend:   ['The Legendary Age',  'Age of Glory',      'The Heroic Era',     'The Grand Age'],
};

// Event types grouped by theme
const THEME_EVENTS = {
  crime:    ['crime', 'theft', 'betrayal', 'assassination', 'corruption', 'heresy'],
  disaster: ['disaster', 'plague', 'famine', 'epidemic', 'flood', 'drought', 'blight'],
  religion: ['pray', 'convert', 'schism', 'religion', 'miracle', 'prophecy', 'heresy'],
  law:      ['law', 'law_vote', 'verdict', 'politics', 'justice', 'execution'],
  trade:    ['trade', 'social', 'alliance', 'celebration', 'tribute'],
  war:      ['death', 'war', 'exile', 'revolution', 'assassination', 'execution'],
  legend:   ['badge_awarded', 'badge_proposal', 'discovery'],
};

// Event types worth highlighting in the archive
const NOTABLE_TYPES = new Set([
  'verdict', 'law_vote', 'schism', 'disaster', 'death', 'badge_awarded',
  'convert', 'join', 'war', 'execution', 'revolution', 'miracle', 'betrayal',
]);

class CivilizationManager {
  constructor() {
    this.archive    = [];  // sealed civilization records, oldest first
    this.currentNumber = 1;
  }

  // Roman numeral converter (handles 1–3999)
  static toRoman(n) {
    const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
    const syms = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
    let out = '';
    for (let i = 0; i < vals.length; i++) {
      while (n >= vals[i]) { out += syms[i]; n -= vals[i]; }
    }
    return out || 'I';
  }

  // Auto-name the civilization from its dominant event profile
  generateName(eventLog) {
    if (!eventLog.length) return 'The Forgotten Age';

    const counts = {};
    for (const e of eventLog) {
      if (e.type) counts[e.type] = (counts[e.type] || 0) + 1;
    }
    const total = eventLog.length;
    const pct = (types) => types.reduce((s, t) => s + (counts[t] || 0), 0) / total;

    const scores = Object.entries(THEME_EVENTS).map(([key, types]) => ({
      key,
      score: pct(types),
    })).sort((a, b) => b.score - a.score);

    const best = scores[0];
    const durationMs = eventLog.length >= 2
      ? (eventLog[eventLog.length - 1]?.ts || 0) - (eventLog[0]?.ts || 0) : 0;

    // No dominant theme — name by longevity
    if (best.score < 0.07) {
      if (durationMs < 5 * 60000)  return 'The Brief Flicker';
      if (durationMs < 20 * 60000) return 'The Forgotten Era';
      return 'The Enduring Age';
    }

    const pool = THEME_NAMES[best.key] || THEME_NAMES.legend;
    return pool[this.archive.length % pool.length];
  }

  determineCause(agents, eventLog) {
    const recent = eventLog.slice(-30);
    const countR = (...types) => recent.filter(e => types.includes(e.type)).length;

    const alive = agents.filter(a => a.alive);
    if (alive.length > 0) return 'Unknown';

    const avgFood = agents.reduce((s, a) => s + a.food, 0) / (agents.length || 1);
    if (avgFood < 1)                               return 'Famine';
    if (countR('disaster') >= 2)                   return 'Catastrophic Disaster';
    const crimes = agents.reduce((s, a) => s + a.beliefs.criminalRecord.length, 0);
    if (crimes > agents.length * 2)                return 'Societal Collapse';

    return 'Extinction';
  }

  generateReport(agents, civAge, eventLog, lawCount, religionCount, categories) {
    const total  = agents.length;
    const roman  = CivilizationManager.toRoman(this.currentNumber);
    const crimes = agents.reduce((s, a) => s + a.beliefs.criminalRecord.length, 0);

    // AI system tally
    const aiCounts = {};
    for (const a of agents) aiCounts[a.aiSystem] = (aiCounts[a.aiSystem] || 0) + 1;
    const topAI = Object.entries(aiCounts).sort((a, b) => b[1] - a[1])[0];

    // Most criminal agent
    const criminal = [...agents].sort(
      (a, b) => b.beliefs.criminalRecord.length - a.beliefs.criminalRecord.length
    )[0];

    // Most active category (skip noise types)
    const NOISE = new Set(['gather', 'rest', 'fail', 'system', 'work']);
    const topCat = [...categories]
      .filter(c => !NOISE.has(c.type))
      .sort((a, b) => b.count - a.count)[0];

    // First passed law message
    const firstLawEvent = eventLog.find(e => e.type === 'law_vote' && e.msg?.includes('PASSED'));
    let firstLawText = null;
    if (firstLawEvent) {
      const m = firstLawEvent.msg.match(/LAW PASSED: "?([^"]+)"?/);
      firstLawText = m ? m[1].replace(/\s*\(.*\)$/, '').trim() : null;
    }

    const parts = [];
    parts.push(
      `Civilization ${roman} endured for ${civAge || 'an unknown duration'}, ` +
      `comprising ${total} agent${total !== 1 ? 's' : ''}.`
    );
    if (topAI) {
      parts.push(
        `The dominant AI system was ${topAI[0]}, represented by ${topAI[1]} ` +
        `agent${topAI[1] !== 1 ? 's' : ''}.`
      );
    }
    if (topCat) {
      parts.push(
        `Its defining character was shaped by ${topCat.label.toLowerCase()} — ` +
        `${topCat.count} such events were recorded.`
      );
    }
    if (lawCount > 0) {
      parts.push(`${lawCount} law${lawCount !== 1 ? 's' : ''} were enacted.`);
      if (firstLawText) parts.push(`The first decree was: "${firstLawText}."`);
    } else {
      parts.push('No laws were ever passed — the world remained ungoverned.');
    }
    if (religionCount > 0) {
      parts.push(`${religionCount} religion${religionCount !== 1 ? 's' : ''} emerged from the chaos.`);
    }
    if (crimes > 0 && criminal?.beliefs.criminalRecord.length > 0) {
      parts.push(
        `${crimes} crime${crimes !== 1 ? 's' : ''} were recorded. ` +
        `The most notorious was ${criminal.name} with ` +
        `${criminal.beliefs.criminalRecord.length} offense${criminal.beliefs.criminalRecord.length !== 1 ? 's' : ''}.`
      );
    } else if (crimes === 0) {
      parts.push('Remarkably, no crimes were committed during this civilization.');
    }

    return parts.join(' ');
  }

  // Select up to 8 spread-out notable events from the full log
  getNotableEvents(eventLog) {
    const candidates = eventLog.filter(e => NOTABLE_TYPES.has(e.type) && e.msg);
    if (!candidates.length) {
      return eventLog.filter(e => e.msg).slice(-6);
    }
    if (candidates.length <= 8) return candidates;
    const step = candidates.length / 8;
    return Array.from({ length: 8 }, (_, i) =>
      candidates[Math.min(Math.round(i * step), candidates.length - 1)]
    ).filter(Boolean);
  }

  seal({ agents, worldAge, eventLog, categories, lawCount, religionCount }) {
    const name    = this.generateName(eventLog);
    const cause   = this.determineCause(agents, eventLog);
    const report  = this.generateReport(agents, worldAge, eventLog, lawCount, religionCount, categories);
    const notable = this.getNotableEvents(eventLog);

    // Compact agent roster for the archive (not full Agent objects)
    const agentSummaries = agents.map(a => ({
      name:     a.name,
      nickname: a.nickname,
      aiSystem: a.aiSystem,
      symbol:   a.symbol,
      score:    a.getScore(),
      crimes:   a.beliefs.criminalRecord.length,
      alive:    a.alive,
    }));

    const achievements = {
      badgesAwarded: eventLog.filter(e => e.type === 'badge_awarded').length,
      lawsEnacted:   lawCount,
      religions:     religionCount,
      crimes:        agents.reduce((s, a) => s + a.beliefs.criminalRecord.length, 0),
      disasters:     eventLog.filter(e => e.type === 'disaster').length,
    };

    const record = {
      number:           this.currentNumber,
      romanNumeral:     CivilizationManager.toRoman(this.currentNumber),
      name,
      cause,
      civAge:           worldAge,
      totalAgents:      agents.length,
      agentSummaries,
      lawCount,
      religionCount,
      achievements,
      extinctionReport: report,
      notableEvents:    notable,
      categories:       categories.slice(),
      sealedAt:         Date.now(),
    };

    this.archive.push(record);
    this.currentNumber++;
    return record;
  }

  // Returns archive ordered most-recent first
  getArchive() {
    return this.archive.slice().reverse();
  }

  get currentRoman() {
    return CivilizationManager.toRoman(this.currentNumber);
  }
}

module.exports = CivilizationManager;
