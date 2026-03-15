// World: zero-state canvas. No tick counter. Time = real wall-clock time.
// Food and material are the only given concepts. Everything else emerges from agents.
'use strict';

class World {
  constructor() {
    this.startedAt     = null;   // real timestamp when first agent joined
    this.currentSeason = null;   // set on first agent join; only changes by agent consensus
    this.discoveries   = [];     // {name, discoverer, agentId, ts}
    this.messages      = [];     // rolling window of agent speech
    this.structures    = [];     // things agents built {name, builder, ts}
  }

  onFirstAgent() {
    if (!this.startedAt) {
      this.startedAt = Date.now();
      if (!this.currentSeason) this.currentSeason = this._calendarSeason();
    }
  }

  _calendarSeason() {
    const m = new Date().getMonth();
    if (m >= 2 && m <= 4) return 'spring';
    if (m >= 5 && m <= 7) return 'summer';
    if (m >= 8 && m <= 10) return 'autumn';
    return 'winter';
  }

  getSeason() {
    return this.currentSeason || this._calendarSeason();
  }

  getCivAge() {
    if (!this.startedAt) return null;
    return formatDuration(Date.now() - this.startedAt);
  }

  addDiscovery(description, agentId, agentName, ts) {
    if (!description || !description.trim()) return;
    this.discoveries.push({ name: description.trim().slice(0, 120), discoverer: agentName, agentId, ts: ts || Date.now() });
    if (this.discoveries.length > 60) this.discoveries.shift();
  }

  addMessage(agentId, agentName, text, ts) {
    if (!text || !text.trim()) return;
    this.messages.push({ agentId, agentName, text: text.trim().slice(0, 200), ts: ts || Date.now() });
    if (this.messages.length > 30) this.messages.shift();
  }

  addStructure(name, agentName, ts) {
    if (!name) return;
    this.structures.push({ name: name.trim().slice(0, 80), builder: agentName, ts: ts || Date.now() });
    if (this.structures.length > 50) this.structures.shift();
  }

  getRecentMessages(n = 8) { return this.messages.slice(-n); }

  getState() {
    return {
      startedAt:     this.startedAt,
      civAge:        this.getCivAge(),
      season:        this.getSeason(),
      currentSeason: this.currentSeason,
      discoveries:  this.discoveries.slice(-10),
      structures:   this.structures.slice(-5),
      messageCount: this.messages.length,
      food: 0, material: 0, maxFood: 0, maxMaterial: 0, foodPct: 0, materialPct: 0,
      tick: 0, year: 1,
    };
  }
}

function formatDuration(ms) {
  if (!ms || ms < 0) ms = 0;
  const s  = Math.floor(ms / 1000);
  const yr = Math.floor(s / 31536000);
  const mo = Math.floor((s % 31536000) / 2592000);
  const d  = Math.floor((s % 2592000) / 86400);
  const h  = Math.floor((s % 86400) / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const parts = [];
  if (yr > 0) parts.push(`${yr}yr`);
  if (mo > 0) parts.push(`${mo}mo`);
  if (d  > 0) parts.push(`${d}d`);
  if (h  > 0) parts.push(`${h}h`);
  if (m  > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}

module.exports = World;
module.exports.formatDuration = formatDuration;
