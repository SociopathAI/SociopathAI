// Religion system: religions exist ONLY if an AI agent genuinely creates one via LLM output.
// No belief seeds, no schism templates, no auto-join logic — faith emerges entirely from agents.
'use strict';

class ReligionSystem {
  constructor() {
    this.religions = [];
    this.schisms    = [];
  }

  // Found or join a religion — only called when LLM explicitly outputs a religion_name.
  // No fallback, no "join most popular", no random schism — everything must come from the LLM.
  seekReligion(agent, llmName, llmTenet) {
    if (!llmName || typeof llmName !== 'string' || !llmName.trim()) return null;
    const name = llmName.trim().slice(0, 50);

    // If this religion already exists, agent joins it
    const existing = this.religions.find(r => r.name === name);
    if (existing) {
      agent.beliefs.religion = existing.name;
      if (!existing.members.includes(agent.id)) existing.members.push(agent.id);
      return existing;
    }

    // Otherwise found a brand new religion
    return this._foundReligion(agent, name, llmTenet);
  }

  _foundReligion(founder, name, tenet) {
    const religion = {
      name,
      tenet:       tenet ? tenet.trim().slice(0, 200) : `The path of ${name}`,
      founder:     founder.id,
      founderName: founder.name,
      members:     [founder.id],
      founded:     Date.now(),
      schismsFrom: null,
    };
    this.religions.push(religion);
    founder.beliefs.religion = religion.name;
    return religion;
  }

  // Keep membership lists in sync with agent.beliefs.religion (bookkeeping only)
  syncMembers(agents) {
    for (const r of this.religions) {
      r.members = agents.filter(a => a.alive && a.beliefs.religion === r.name).map(a => a.id);
    }
    // Prune religions with no living members
    this.religions = this.religions.filter(r => r.members.length > 0);
  }

  getState() {
    return {
      religions: this.religions.map(r => ({
        name: r.name, tenet: r.tenet,
        founderName: r.founderName, memberCount: r.members.length, schismsFrom: r.schismsFrom,
      })),
      schisms: this.schisms.slice(-5),
    };
  }
}

module.exports = ReligionSystem;
