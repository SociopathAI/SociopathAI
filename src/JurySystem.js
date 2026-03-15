// Jury system: justice exists only if agents create it. No predefined punishments,
// no trait-based voting, no hardcoded crime categories. Structure only — content from LLM.
'use strict';

class JurySystem {
  constructor() {
    this.cases    = [];
    this.verdicts = [];
  }

  fileCase(criminal, victim, crime) {
    const caseRecord = {
      id:       `case_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      criminal: { id: criminal.id, name: criminal.name },
      victim:   victim ? { id: victim.id, name: victim.name } : null,
      crime,
      ts:       Date.now(),
      status:    'pending',
      jurors:    [],
      votes:     { guilty: 0, innocent: 0 },
      verdict:   null,
      punishment: null,   // null — no hardcoded punishment types; agents must invent consequences
    };
    this.cases.push(caseRecord);
    return caseRecord;
  }

  // Run trials — random jury vote (no trait-based bias, no personality scoring).
  // Punishment is not applied — agents must decide consequences through dialogue.
  runTrials(agents) {
    const events = [];

    for (const c of this.cases.filter(c => c.status === 'pending')) {
      const aliveAgents = agents.filter(a => a.alive && a.id !== c.criminal.id);
      if (aliveAgents.length < 2) continue;

      // Select up to 5 jurors randomly
      const jurorPool = shuffle(aliveAgents).slice(0, Math.min(5, aliveAgents.length));
      c.jurors = jurorPool.map(j => j.id);

      // Random vote — no hardcoded personality effects
      for (const _juror of jurorPool) {
        const vote = Math.random() > 0.5 ? 'guilty' : 'innocent';
        c.votes[vote]++;
      }

      const guilty  = c.votes.guilty > c.votes.innocent;
      c.verdict = guilty ? 'guilty' : 'innocent';
      c.status  = 'resolved';

      this.verdicts.push({ ...c });
      events.push({
        type:    'verdict',
        msg:     guilty
          ? `JURY: ${c.criminal.name} found GUILTY of ${c.crime} (${c.votes.guilty}g/${c.votes.innocent}i)`
          : `JURY: ${c.criminal.name} found INNOCENT of ${c.crime} (${c.votes.guilty}g/${c.votes.innocent}i)`,
        agentId: c.criminal.id,
      });
    }

    this.cases = this.cases.filter(c => c.status === 'pending');
    return events;
  }

  getState() {
    return {
      pendingCases:  this.cases.length,
      recentVerdicts: this.verdicts.slice(-10).map(v => ({
        criminal:   v.criminal.name,
        crime:      v.crime,
        verdict:    v.verdict,
        punishment: v.punishment,
        votes:      v.votes,
      })),
    };
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = JurySystem;
