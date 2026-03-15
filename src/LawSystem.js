// Law system: laws exist ONLY if AI agents invent and vote on them via LLM dialogue.
// No templates, no topics, no hardcoded voting logic — laws emerge from agent language.
'use strict';

class LawSystem {
  constructor() {
    this.laws = [];
    this.proposals = [];
    this.voteHistory = [];
  }

  // Propose a law — text must come entirely from LLM output, never from hardcoded templates
  propose(proposer, llmText) {
    if (!llmText || typeof llmText !== 'string' || !llmText.trim()) return null;
    const text = llmText.trim().slice(0, 200);
    const proposal = {
      id:           `law_${Date.now()}`,
      text,
      type:         'custom',    // UI styling only — no behavior attached
      proposedBy:   proposer.id,
      proposerName: proposer.name,
      votes:        { yes: 0, no: 0, abstain: 0 },
      voters:       [],
      active:       false,
      tick:         null,
    };
    this.proposals.push(proposal);
    return proposal;
  }

  // Run voting — each alive agent casts a random vote.
  // No trait-based voting logic: personality has no hardcoded effect on voting.
  runVoting(agents) {
    const results = [];
    for (const proposal of this.proposals) {
      const alive = agents.filter(a => a.alive);
      if (proposal.voters.length >= alive.length) continue;

      for (const agent of alive) {
        if (proposal.voters.includes(agent.id)) continue;
        const roll = Math.random();
        const vote = roll < 0.45 ? 'yes' : roll < 0.85 ? 'no' : 'abstain';
        proposal.votes[vote]++;
        proposal.voters.push(agent.id);
      }

      if (proposal.voters.length >= alive.length) {
        const passed = proposal.votes.yes > proposal.votes.no;
        proposal.active = passed;
        proposal.tick   = Date.now();
        if (passed) this.laws.push({ ...proposal });
        results.push({ passed, law: proposal });
      }
    }
    // Remove resolved proposals
    this.proposals = this.proposals.filter(p => p.tick === null);
    return results;
  }

  getState() {
    return {
      laws: this.laws.map(l => ({
        id: l.id, text: l.text, type: l.type,
        proposerName: l.proposerName, votes: l.votes, active: l.active,
      })),
      proposals: this.proposals.map(p => ({
        id: p.id, text: p.text, proposerName: p.proposerName,
        votes: p.votes, voters: p.voters.length,
      })),
    };
  }
}

module.exports = LawSystem;
