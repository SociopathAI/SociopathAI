// EventCategoryRegistry: categories emerge ONLY from actual agent actions.
// Nothing is predefined. The golden-ratio auto-coloring applies to everything.
'use strict';

// Golden angle — guarantees maximally distinct hues for sequential colors
const GOLDEN_ANGLE = 137.508;

class EventCategoryRegistry {
  constructor() {
    this.categories = new Map();
    this._autoIndex = 1;
    // Pre-register point_award with fixed gold color so it always stands out
    const now = Date.now();
    this.categories.set('point_award', { type: 'point_award', label: 'Point Award', color: '#FFD700', count: 0, firstSeen: now, lastSeen: now });
  }

  register(type) {
    const now = Date.now();
    if (!type) type = 'unknown';
    if (this.categories.has(type)) {
      const cat = this.categories.get(type);
      cat.count++;
      cat.lastSeen = now;
      return;
    }
    // Auto-humanize label
    const label = type
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    // Golden-ratio hue — maximally distinct, never repeats
    const hue   = Math.round((this._autoIndex * GOLDEN_ANGLE) % 360);
    const sat   = 55 + (this._autoIndex % 3) * 10;
    const lit   = 58 + (this._autoIndex % 2) * 8;
    const color = `hsl(${hue},${sat}%,${lit}%)`;
    this._autoIndex++;

    this.categories.set(type, { type, label, color, count: 1, firstSeen: now, lastSeen: now });
  }

  getAll() {
    return Array.from(this.categories.values());
  }
}

module.exports = EventCategoryRegistry;
