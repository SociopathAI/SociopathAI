// BadgeSystem: agents autonomously propose, name, and vote on badges
// No human defines badge names — names are generated from proposing agent's dominant trait
// Badge names emerge from personality × event type combinations

// Word pools — dominant trait of proposing agent selects the adjective
const ADJECTIVE_POOL = {
  greed:       ['Shadow', 'Iron', 'Hollow', 'Hungry', 'Dark'],
  piety:       ['Blessed', 'Sacred', 'Fallen', 'Holy', 'Eternal'],
  aggression:  ['Blood', 'Savage', 'Storm', 'Fury', 'Violent'],
  sociability: ['Golden', 'Warm', 'Bright', 'Gentle', 'Bonded'],
  lawfulness:  ['Order', 'Steel', 'True', 'Bound', 'Just'],
  creativity:  ['Phantom', 'Drifting', 'Echo', 'Fading', 'Lost'],
};

// Trigger-type determines the noun
const NOUN_POOL = {
  crime_spree:   ['Thief', 'Blade', 'Wraith', 'Hand', 'Shadow'],
  lone_survivor: ['Remnant', 'Last', 'Ghost', 'Relic', 'Witness'],
  lawmaker:      ['Architect', 'Scribe', 'Keeper', 'Builder', 'Author'],
  devoted:       ['Pilgrim', 'Seeker', 'Faithful', 'Devotee', 'Soul'],
  merchant:      ['Dealer', 'Broker', 'Trader', 'Exchanger', 'Merchant'],
  elder:         ['Elder', 'Ancient', 'Sage', 'Endurer', 'Veteran'],
  hoarder:       ['Miser', 'Vault', 'Collector', 'Hoarder', 'Keeper'],
  peacemaker:    ['Weaver', 'Bridge', 'Herald', 'Peacemaker', 'Bond'],
  outcast:       ['Exile', 'Wanderer', 'Stray', 'Drifter', 'Alone'],
};

// Description templates for each trigger
const TRIGGER_DESC = {
  crime_spree:   'committed crimes against the community repeatedly',
  lone_survivor: 'survived a great disaster while others perished',
  lawmaker:      'proposed many laws that shaped the civilization',
  devoted:       'reached a state of extraordinary spiritual faith',
  merchant:      'built the community through trade and exchange',
  elder:         'persevered through countless ticks of existence',
  hoarder:       'accumulated vast stores of resources',
  peacemaker:    'forged many bonds of trust with others',
  outcast:       'accumulated many enemies and broken bonds',
};

// Vote tendency per trigger per trait
const VOTE_WEIGHTS = {
  crime_spree:   { lawfulness: 0.7, aggression: 0.4, piety: 0.5 },
  lone_survivor: { sociability: 0.5, piety: 0.4, base: 0.4 },
  lawmaker:      { lawfulness: 0.8, creativity: 0.4 },
  devoted:       { piety: 0.9, aggression: -0.3 },
  merchant:      { sociability: 0.6, greed: 0.3 },
  elder:         { base: 0.55 },
  hoarder:       { greed: -0.5, lawfulness: 0.4 },
  peacemaker:    { sociability: 0.7, aggression: -0.3 },
  outcast:       { aggression: 0.5, sociability: -0.4 },
};

class BadgeSystem {
  constructor() {
    this.awarded   = [];   // finalized badges with full data
    this.proposals = [];   // pending badge proposals awaiting votes
    this._triggered = new Set(); // "agentId:trigger" — prevent duplicate proposals
  }

  // Scan living agents for trigger conditions (now = real timestamp)
  checkTriggers(agents, now) {
    const newProposals = [];
    for (const agent of agents.filter(a => a.alive)) {
      for (const trigger of this._getTriggersFor(agent, now)) {
        const key = `${agent.id}:${trigger}`;
        if (this._triggered.has(key)) continue;

        const proposer = agents
          .filter(a => a.alive && a.id !== agent.id)
          .sort((a, b) => b.traits.creativity - a.traits.creativity)[0];
        if (!proposer) continue;

        const proposal = this._buildProposal(proposer, agent, trigger, now);
        this.proposals.push(proposal);
        this._triggered.add(key);
        newProposals.push(proposal);
      }
    }
    return newProposals;
  }

  proposeForEvent(proposer, recipient, trigger) {
    const key = `${recipient.id}:${trigger}`;
    if (this._triggered.has(key)) return null;
    this._triggered.add(key);
    const proposal = this._buildProposal(proposer || recipient, recipient, trigger, Date.now());
    this.proposals.push(proposal);
    return proposal;
  }

  _getTriggersFor(agent, now) {
    const t = [];
    if (agent.beliefs.criminalRecord.length >= 3)                       t.push('crime_spree');
    if (agent.stats.lawsProposed >= 3)                                  t.push('lawmaker');
    if (agent.beliefs.faithStrength > 0.88)                             t.push('devoted');
    // Elder: alive for at least 10 minutes (600s)
    if (agent.deployedAt && (now - agent.deployedAt) >= 600000)         t.push('elder');
    if ((agent.food + agent.material) >= 100)                           t.push('hoarder');
    if ((agent.stats.totalTrades || 0) >= 8)                           t.push('merchant');
    const rels = Object.values(agent.relationships || {});
    if (rels.filter(r => r > 0.4).length >= 4)                         t.push('peacemaker');
    if (rels.filter(r => r < -0.4).length >= 4)                        t.push('outcast');
    return t;
  }

  _buildProposal(proposer, recipient, trigger, now) {
    const name = this._generateName(proposer, trigger);
    const desc = `${recipient.name} has ${TRIGGER_DESC[trigger] || trigger}. ${proposer.name} proposes this title.`;
    return {
      id: `badge_${now}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      desc,
      trigger,
      recipientId:   recipient.id,
      recipientName: recipient.name,
      proposerId:    proposer.id,
      proposerName:  proposer.name,
      votes:  { yes: 0, no: 0 },
      voters: [],
      ts:     now,
    };
  }

  // Name is generated by the proposer: dominant trait → adjective + trigger → noun
  _generateName(proposer, trigger) {
    const traits  = proposer.traits;
    const dominant = Object.entries(traits).sort((a, b) => b[1] - a[1])[0][0];
    const adjPool  = ADJECTIVE_POOL[dominant]  || ADJECTIVE_POOL.creativity;
    const nounPool = NOUN_POOL[trigger] || ['One'];
    const adj  = adjPool[Math.floor(Math.random() * adjPool.length)];
    const noun = nounPool[Math.floor(Math.random() * nounPool.length)];
    return `${adj} ${noun}`;
  }

  // Run all pending proposals through agent voting
  runVoting(agents) {
    const results = [];
    const aliveCount = agents.filter(a => a.alive).length;

    for (const proposal of this.proposals) {
      // Cast votes from all alive agents who haven't voted yet
      for (const agent of agents.filter(a => a.alive && !proposal.voters.includes(a.id))) {
        proposal.votes[this._agentVote(agent, proposal)]++;
        proposal.voters.push(agent.id);
      }

      // Resolve once all alive have voted
      if (proposal.voters.length >= aliveCount) {
        const passed = proposal.votes.yes > proposal.votes.no;
        if (passed) {
          const awarded = { ...proposal };
          this.awarded.push(awarded);
          const recipient = agents.find(a => a.id === proposal.recipientId);
          if (recipient) {
            recipient.badges.push({
              id:           awarded.id,
              name:         awarded.name,
              desc:         awarded.desc,
              trigger:      awarded.trigger,
              ts:           awarded.ts,
              proposerName: awarded.proposerName,
              votes:        { yes: awarded.votes.yes, no: awarded.votes.no },
            });
          }
          results.push({ passed: true, badge: awarded });
        } else {
          results.push({ passed: false, badge: proposal });
        }
      }
    }

    // Clear resolved proposals
    this.proposals = this.proposals.filter(p => p.voters.length < aliveCount);
    return results;
  }

  _agentVote(agent, proposal) {
    const weights = VOTE_WEIGHTS[proposal.trigger] || {};
    let score = weights.base || 0.45;

    for (const [trait, weight] of Object.entries(weights)) {
      if (trait === 'base') continue;
      score += (agent.traits[trait] || 0) * weight;
    }

    // Trust bias toward recipient
    const trust = (agent.relationships || {})[proposal.recipientId] || 0;
    score += trust * 0.15;
    score += (Math.random() - 0.5) * 0.2;

    return score > 0.5 ? 'yes' : 'no';
  }

  getState() {
    return {
      awarded: this.awarded.slice(-30).map(b => ({
        id:            b.id,
        name:          b.name,
        desc:          b.desc,
        trigger:       b.trigger,
        recipientName: b.recipientName,
        proposerName:  b.proposerName,
        votes:         b.votes,
        ts:            b.ts,
      })),
      proposals: this.proposals.map(p => ({
        id:            p.id,
        name:          p.name,
        desc:          p.desc,
        recipientName: p.recipientName,
        proposerName:  p.proposerName,
        votes:         p.votes,
        voters:        p.voters.length,
      })),
    };
  }
}

module.exports = BadgeSystem;
