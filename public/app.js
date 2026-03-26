// SociopathAI — Dashboard Client v2
// Real-time updates via Socket.IO

// Preview mode: loaded inside an iframe on the landing page (?preview=true)
// Hides all UI panels immediately so only the starmap canvas is visible.
const _isPreview = new URLSearchParams(window.location.search).get('preview') === 'true';
if (_isPreview) document.body.classList.add('preview-mode');

const socket = io({ transports: ['websocket'], reconnectionDelay: 2000, reconnectionAttempts: 30 });
let lastState        = null;
let activeLbTab      = 'score';
const prevAgentRankPos = new Map(); // id → last rendered list-position (for ▲▼ indicator)
let activeLogFilter    = '';    // '' = All; otherwise a category type string
let myAgentFilterActive = false;  // show only user's agent events
let eventTextSearch    = '';    // live text search over event messages
let activeAgentFilter = null; // agentId or null — kept for backward compat
let starmapInstance  = null;
let agentSearchQuery  = '';    // live search filter string
let locatingAgentId   = null;  // card currently highlighted via click-to-locate
let deceasedExpanded  = false; // whether DECEASED section is open
let offlineExpanded   = false; // whether OFFLINE section is open
// ── Expansion state — persists across re-renders (never reset) ──
const expandedEvents  = new Set(); // evId → expanded in Events feed
const expandedBubbles = new Set(); // bubbleId → expanded in Chats thread

// ── Events panel state ──
let focusAgentId  = null;   // null = global feed; agentId = agent focus mode
let focusModeTab  = 'all';  // 'all' | 'dialogue'
let focusCatFilter = '';    // category type filter within focus 'all' mode
let focusTextSearch = '';   // text search within focus mode
let _focusDlgOpenThread = null;  // null = partner list view, agentId string = thread view
let _focusFilterSig = '';   // signature for focus filter bar rebuild detection
let catSearchQuery = '';    // unused — kept for safety
const prevAgentRanks  = new Map(); // id → last rendered rank, for flash detection
const agentsById      = new Map(); // id → latest agent object, for modal lookup

// AI system color map (must match CSS variables)
const AI_COLORS = {
  ChatGPT: '#10a37f',
  Claude:  '#d97706',
  Gemini:  '#4285f4',
  Grok:    '#b4c0cc',
  Groq:    '#f97316',
  Llama:   '#7c3aed',
  Mistral: '#ff6b2b',
  Other:   '#6b7280',
};

// Badge trigger → CSS color class (trigger types are fixed detection conditions;
// badge NAMES are generated autonomously by agents)
const TRIGGER_CLASS = {
  crime_spree:   'trig-crime',
  lone_survivor: 'trig-survivor',
  lawmaker:      'trig-law',
  devoted:       'trig-faith',
  merchant:      'trig-trade',
  elder:         'trig-elder',
  hoarder:       'trig-hoard',
  peacemaker:    'trig-peace',
  outcast:       'trig-outcast',
};


// ─── API KEY UTILITIES (delegates to SocioLLM from llm-client.js) ────────────

// ─── LLM DECISION PIPELINE ───────────────────────────────────────────────────
// Tracks which agents currently have an in-flight LLM call so we don't double-call
const llmInFlight = new Set();

// Browser-side LLM pipeline is disabled — the server now calls LLMs directly each tick.
// The server stores API keys in-memory per agent and fires decisions server-side.
// This function is kept as a no-op for backward compatibility.
function runLLMDecisions(_state) {
  // Server-side LLM pipeline handles all decisions — see src/LLMBridge.js
}

// ─── STAR RANK BADGE ───
// Generates an SVG sheriff-star with the rank number embedded inside the star shape.
// Colors: 1-3 gold, 4-6 silver, 7-10 bronze, 11+ blue
function starSVG(rank, size = 28) {
  const color = rank <= 3  ? '#FFD700'
              : rank <= 6  ? '#C0C0C0'
              : rank <= 10 ? '#CD7F32'
              :               '#4f8ef7';
  const textColor = rank <= 10 ? '#111' : '#fff';
  const cx = size / 2, cy = size / 2;
  const R  = size * 0.44;   // outer point radius
  const r  = size * 0.185;  // inner dip radius
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const angle  = (i * 36 - 90) * Math.PI / 180;
    const radius = i % 2 === 0 ? R : r;
    pts.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  const fs = rank >= 100 ? size * 0.21 : rank >= 10 ? size * 0.27 : size * 0.32;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:inline-block;vertical-align:middle;flex-shrink:0" aria-label="Rank ${rank}">` +
    `<polygon points="${pts.join(' ')}" fill="${color}"/>` +
    `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" ` +
    `fill="${textColor}" font-size="${fs.toFixed(1)}" font-weight="800" ` +
    `font-family="'JetBrains Mono',monospace">${rank}</text>` +
    `</svg>`;
}

// ─── CIVILIZATION STATE ───
let collapseVisible = false;    // prevents render() from clobbering collapse overlay
const civRomanEl    = document.getElementById('civ-roman');

// ─── DOM REFS ───
const tickDisplay   = document.getElementById('tick-display');
const seasonDisplay = document.getElementById('season-display');
const aliveDisplay  = document.getElementById('alive-display');
// Resources bar removed (no survival mechanics)
const foodBar = null, materialBar = null, foodVal = null, materialVal = null;
const agentsList    = document.getElementById('agents-list');
const agentCountPill= document.getElementById('agent-count-pill');
const eventLog          = document.getElementById('event-log');
const logFilterBar      = document.getElementById('log-filter-bar');
const conversationsList = document.getElementById('conversations-list');
const convoPill         = document.getElementById('chats-pill');
const lbList        = document.getElementById('leaderboard-list');
const aiDistLegend  = document.getElementById('ai-dist-legend');
const achievList    = document.getElementById('achievements-list');
const statsCanvas   = document.getElementById('stats-canvas');
const aiDistCanvas  = document.getElementById('ai-dist-canvas');
const statsCtx      = statsCanvas   ? statsCanvas.getContext('2d')   : null;
const aiCtx         = aiDistCanvas  ? aiDistCanvas.getContext('2d')  : null;

// ─── REAL-TIME CLOCK ───

(function () {
  const dateEl = document.getElementById('rtc-date');
  const timeEl = document.getElementById('rtc-time');
  if (!dateEl || !timeEl) return;

  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  function tick() {
    const now = new Date();
    dateEl.textContent = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
    timeEl.textContent = now.toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  }
  tick();
  setInterval(tick, 1000);
})();

// ─── INIT CONTROLS ───

// Leaderboard tabs
document.querySelectorAll('.lb-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.lb-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeLbTab = btn.dataset.tab;
    if (lastState) renderLeaderboard(lastState.leaderboard);
  });
});



// Client-side name validation (mirrors server)
const PROFANITY_LIST = ['fuck','shit','ass','bitch','damn','hell','cunt','dick','bastard','idiot','stupid'];
function validateName(name) {
  if (!name) return 'Agent name is required.';
  if (name.length > 20) return 'Name too long (max 20 chars).';
  if (!/^[a-zA-Z0-9]+$/.test(name)) return 'Alphanumeric only — no spaces or special characters.';
  const lower = name.toLowerCase();
  if (PROFANITY_LIST.some(w => lower.includes(w))) return 'Name contains disallowed content.';
  return null;
}

function applyKeyDetection(keyInput, badgeEl, aiRadioName) {
  const k = keyInput.value.trim();
  const detectedSys = SocioLLM.detectedSystemName(k); // e.g. "Claude", "ChatGPT"

  if (detectedSys) {
    badgeEl.textContent = detectedSys;
    badgeEl.className   = 'ob-key-badge detected';
    const radio = document.querySelector(`input[name="${aiRadioName}"][value="${detectedSys}"]`);
    if (radio) radio.checked = true;
  } else if (k) {
    badgeEl.textContent = 'Unknown';
    badgeEl.className   = 'ob-key-badge unknown';
  } else {
    badgeEl.textContent = '';
    badgeEl.className   = 'ob-key-badge';
  }
}

// ─── AGENTS PANEL: SEARCH + CLICK-TO-LOCATE + DECEASED ───
(function () {
  const searchInput = document.getElementById('agent-search');
  const searchClear = document.getElementById('agent-search-clear');
  if (!searchInput || !searchClear) return;

  const syncAgentClear = () => {
    searchClear.style.display = searchInput.value ? 'inline-flex' : 'none';
  };
  const clearAgentSearch = () => {
    agentSearchQuery = '';
    searchInput.value = '';
    syncAgentClear();
    if (lastState) renderAgents(lastState.agents);
  };

  searchInput.addEventListener('input', () => {
    agentSearchQuery = searchInput.value;
    syncAgentClear();
    if (lastState) renderAgents(lastState.agents);
  });
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape' && searchInput.value) { clearAgentSearch(); searchInput.focus(); e.stopPropagation(); }
  });

  searchClear.addEventListener('click', () => { clearAgentSearch(); searchInput.focus(); });

  // ── Alive card hover → briefly highlight on starmap ──
  agentsList.addEventListener('mouseover', e => {
    const card = e.target.closest('[data-agent-id]');
    if (!card || !starmapInstance) return;
    starmapInstance._hoverHighlightId = card.dataset.agentId;
  });
  agentsList.addEventListener('mouseout', e => {
    const card = e.target.closest('[data-agent-id]');
    if (!card || !starmapInstance) return;
    // Only clear if actually leaving the card (not just moving between child elements)
    if (!e.relatedTarget || !card.contains(e.relatedTarget)) {
      starmapInstance._hoverHighlightId = null;
    }
  });

  // ── Alive card click → locate on starmap ──
  agentsList.addEventListener('click', e => {
    // Badge info popup — stop propagation so locate/focus don't fire
    if (e.target.closest('.badge')) { e.stopPropagation(); return; }

    // Badge expand/collapse button — stop propagation so card locate doesn't fire
    const expandBtn = e.target.closest('.badge-expand-btn');
    if (expandBtn) {
      e.stopPropagation();
      const open = expandBtn.classList.toggle('open');
      expandBtn.setAttribute('aria-expanded', open);
      const extra = expandBtn.nextElementSibling;
      if (extra && extra.classList.contains('badge-extra')) extra.classList.toggle('open', open);
      return;
    }

    const card = e.target.closest('[data-agent-id]');
    if (!card) return;
    const id = card.dataset.agentId;
    locatingAgentId = (locatingAgentId === id) ? null : id;
    agentsList.querySelectorAll('.agent-card[data-agent-id]').forEach(c => {
      c.classList.toggle('locating', c.dataset.agentId === locatingAgentId);
    });
    if (locatingAgentId && starmapInstance) starmapInstance.locateAgent(locatingAgentId);
  });

  // ── Offline toggle ──
  const offlineToggle = document.getElementById('offline-toggle');
  if (offlineToggle) {
    offlineToggle.addEventListener('click', () => {
      offlineExpanded = !offlineExpanded;
      if (lastState) renderAgents(lastState.agents);
    });
  }
})();

// ─── FLOATING SCROLL INDICATOR ───────────────────────────────────────────────
(function () {
  const app = document.getElementById('app');
  if (!app) return;

  const indicator = document.createElement('div');
  indicator.className = 'scroll-indicator';
  indicator.innerHTML = '<span class="si-arrow">▼</span> scroll for more';
  document.body.appendChild(indicator);

  // Show indicator only when #app is scrollable and hasn't been scrolled yet
  function updateVisibility() {
    const canScroll = app.scrollHeight > app.clientHeight + 10;
    const hasScrolled = app.scrollTop > 30;
    indicator.classList.toggle('visible', canScroll && !hasScrolled);
  }

  // Click → scroll down one viewport height
  indicator.addEventListener('click', () => {
    app.scrollBy({ top: app.clientHeight * 0.8, behavior: 'smooth' });
  });

  app.addEventListener('scroll', updateVisibility, { passive: true });

  // Re-check whenever content changes (agents added, etc.)
  const ro = new ResizeObserver(updateVisibility);
  ro.observe(app);

  // Initial check after layout settles
  setTimeout(updateVisibility, 600);
})();

// ─── PANEL-CONTAINED WHEEL SCROLL ────────────────────────────────────────────
// Each panel captures wheel events over its entire area and routes them to its
// own scrollable child. This prevents the page from scrolling when the user
// wheels over a panel — even if the cursor is on a non-scrollable part (header,
// filter bar, padding, etc.).

(function () {
  // Map: panel selector → selector of the scrollable child inside it
  const PANEL_SCROLL_MAP = [
    { panel: '.events-panel',  scroller: '.event-log' },
    { panel: '.agents-panel',  scroller: '.agents-list' },
  ];

  for (const { panel, scroller } of PANEL_SCROLL_MAP) {
    const panelEl = document.querySelector(panel);
    if (!panelEl) continue;

    panelEl.addEventListener('wheel', (e) => {
      // Events panel: prefer the focus-dialogue thread scroller when active
      let scrollEl = panelEl.querySelector(scroller);
      if (panel === '.events-panel') {
        scrollEl = panelEl.querySelector('#fdlg-thread-scroll') || scrollEl;
      }
      if (!scrollEl) return;

      // If the target is already inside a nested scroller (dropdown, modal, etc.),
      // let it handle its own scroll naturally.
      const nested = e.target.closest(
        '.arch-list, .lfb-dropdown, .laws-list, .verdicts-list, .religion-list, .leaderboard-list'
      );
      if (nested) return;

      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      const atTop    = scrollTop === 0             && e.deltaY < 0;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 1 && e.deltaY > 0;

      // At hard boundary — let the page scroll naturally
      if (atTop || atBottom) return;

      e.preventDefault();
      e.stopPropagation();
      scrollEl.scrollTop += e.deltaY;
    }, { passive: false });
  }
})();

// ─── VOID-AREA WHEEL → PAGE SCROLL ──────────────────────────────────────────
// When the mouse wheel fires outside any recognised panel, redirect to #app.
(function () {
  const appEl = document.getElementById('app');
  if (!appEl) return;

  // Any element inside these areas manages its own scroll
  const PANEL_SCROLL = [
    '.events-panel',
    '.agents-panel',
    '.event-log',
    '#leaderboard-list',
    '.achievements-list',
    '.arch-list',
    '#starmap-canvas',
  ].join(',');

  document.addEventListener('wheel', (e) => {
    if (e.target.closest(PANEL_SCROLL)) return;
    e.preventDefault();
    appEl.scrollBy({ top: e.deltaY, left: 0, behavior: 'auto' });
  }, { passive: false });
})();

// ─── DEATH REPORT MODAL ───────────────────────────────────────────────────────


function _renderFormSVG(snapshot, size) {
  if (!snapshot || !snapshot.shapes || !snapshot.shapes.length) return '';
  const half = size / 2;
  const scale = half / 13;
  const bg = '#00000e';

  function hexToRgb(hex) {
    if (!hex || hex.length < 7) return [136,170,255];
    return [parseInt(hex.slice(1,3),16)||136, parseInt(hex.slice(3,5),16)||170, parseInt(hex.slice(5,7),16)||255];
  }

  let shapeSVG = '';
  for (const s of snapshot.shapes) {
    const op = s.opacity || 0.8;
    const c  = esc(s.color || '#88aaff');
    if (s.type === 'circle') {
      shapeSVG += `<circle cx="${half + (s.cx||0)*scale}" cy="${half + (s.cy||0)*scale}" r="${(s.r||6)*scale}" fill="${c}" opacity="${op}" filter="url(#fg)"/>`;
    } else if (s.type === 'polygon') {
      const sides = s.sides||6, r = (s.r||8)*scale, rot = (s.rotation||0)*Math.PI/180;
      const cx = half + (s.cx||0)*scale, cy = half + (s.cy||0)*scale;
      const pts = Array.from({length:sides},(_,i)=>{const a=rot+(i/sides)*Math.PI*2;return `${cx+Math.cos(a)*r},${cy+Math.sin(a)*r}`;}).join(' ');
      shapeSVG += `<polygon points="${pts}" fill="${c}" opacity="${op}" filter="url(#fg)"/>`;
    } else if (s.type === 'star') {
      const pts = s.points||5, or_ = (s.r||10)*scale, ir_ = (s.innerR||4)*scale;
      const cx = half+(s.cx||0)*scale, cy = half+(s.cy||0)*scale;
      const ptsStr = Array.from({length:pts*2},(_,i)=>{const a=(i/(pts*2))*Math.PI*2-Math.PI/2,r=i%2===0?or_:ir_;return `${cx+Math.cos(a)*r},${cy+Math.sin(a)*r}`;}).join(' ');
      shapeSVG += `<polygon points="${ptsStr}" fill="${c}" opacity="${op}" filter="url(#fg)"/>`;
    } else if (s.type === 'line') {
      const x1=half+(s.x1||0)*scale,y1=half+(s.y1||0)*scale,x2=half+(s.x2||0)*scale,y2=half+(s.y2||0)*scale;
      shapeSVG += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${(s.width||1)*scale*0.5}" stroke-linecap="round" opacity="${op}" filter="url(#fg)"/>`;
    }
  }

  const pc = esc(snapshot.primaryColor || '#58a6ff');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;border-radius:6px">
    <defs>
      <radialGradient id="bgGrd" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#0a1020"/>
        <stop offset="100%" stop-color="${bg}"/>
      </radialGradient>
      <filter id="fg" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#bgGrd)"/>
    <circle cx="${half}" cy="${half}" r="${half*0.6}" fill="none" stroke="${pc}" stroke-width="0.5" opacity="0.15"/>
    ${shapeSVG}
  </svg>`;
}


// ─── SOCKET ───
socket.on('state', state => {
  lastState = state;
  if (!collapseVisible) render(state);
  runLLMDecisions(state);
  if (starmapInstance) starmapInstance.update(state);
});

socket.on('novel_effect', ev => {
  if (starmapInstance) starmapInstance.onNovelEffect(ev);
});

socket.on('game_effect', ev => {
  if (starmapInstance) starmapInstance.onGameEffect(ev);
});

socket.on('event_svg', ev => {
  _showEventSVGOverlay(ev);
});

function _showEventSVGOverlay(ev) {
  const container = document.getElementById('event-svg-overlay');
  if (!container) return;
  const wrap = document.createElement('div');
  wrap.className = 'event-svg-card';
  wrap.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="80" height="80">${ev.svgContent}</svg>
    <div class="event-svg-label">${(ev.msg || '').replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,80)}</div>
  `;
  container.appendChild(wrap);
  // Fade in
  requestAnimationFrame(() => wrap.classList.add('visible'));
  // Remove after duration
  setTimeout(() => {
    wrap.classList.remove('visible');
    setTimeout(() => { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 600);
  }, ev.duration || 8000);
}

socket.on('collapse', record => {
  lastState = lastState || {};
  collapseVisible = true;
  // Dismiss the onboarding if somehow still visible
  const ob = document.getElementById('onboarding');
  if (ob) ob.style.display = 'none';
  showCollapseOverlay(record);
  if (starmapInstance) starmapInstance.triggerCollapse();
});

socket.on('connect_error', () => {});

// On reconnect: immediately request full state sync without waiting for next tick
socket.on('connect', () => {
  socket.emit('requestState');
});

// Keepalive ping every 25s — resets grace period timer if socket briefly dropped
setInterval(() => {
  if (socket && socket.connected) {
    socket.emit('keepalive');
  }
}, 25000);

// On actual tab/browser close: signal server immediately so agent exits cleanly
// Guard against false positives (tab backgrounding, OS throttling, bfcache)
let isActuallyClosing = false;

window.addEventListener('pagehide', (e) => {
  if (e.persisted) return; // page going into bfcache, not closing
  isActuallyClosing = true;
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Tab hidden — do NOT send agentExit, keep agent alive
    isActuallyClosing = false;
  }
});

window.addEventListener('beforeunload', () => {
  if (!isActuallyClosing) return; // backgrounded/throttled — not a real close
  const myAgentId = sessionStorage.getItem('my_agent_id');
  if (myAgentId && socket && socket.connected) socket.emit('agentExit', { agentId: myAgentId });
  // Legacy: also check SocioLLM.loadMyAgents if it exists
  const myAgents = (typeof SocioLLM !== 'undefined' && SocioLLM.loadMyAgents) ? Object.keys(SocioLLM.loadMyAgents()) : [];
  for (const agentId of myAgents) {
    if (agentId !== myAgentId && socket && socket.connected) socket.emit('agentExit', { agentId });
  }
});

// ─── MAIN RENDER ───
function render(state) {
  if (civRomanEl && state.civRoman) civRomanEl.textContent = state.civRoman;
  renderWorld(state.world, state.agents);
  renderAgents(state.agents);
  renderLogFilters(state.categories || []);
  if (focusAgentId) renderFocusFilters(state.eventLog, focusAgentId);
  renderEventLog(state.eventLog, state.categories || [], false);
  _updateChatsPill(state);
  if (document.querySelector('.rpanel-tab[data-rtab="chats"]')?.classList.contains('active')) {
    renderConversations(state.eventLog);
  }
  renderLeaderboard(state.leaderboard);
  renderAiDist(state.leaderboard.aiDist);
  renderHallOfFame(state.badges);
  renderStats(state.statsHistory);

  // Show/hide autosave indicator
  const autosaveEl = document.getElementById('autosave-indicator');
  if (autosaveEl) autosaveEl.style.display = state.running ? 'flex' : 'none';
}

function renderWorld(world, agents) {
  tickDisplay.textContent   = world.civAge || '—';
  seasonDisplay.textContent = capitalize(world.season || '');
  aliveDisplay.textContent  = agents.filter(a => a.alive && !a.dormant).length;
}

// ── Agent card builders ────────────────────────────────────────────────────────

// Returns a safe badge name/desc — never renders null/undefined/empty
function _safeBadgeName(b) { return b && b.name && b.name !== 'null' && b.name !== 'undefined' ? b.name : null; }
function _safeBadgeDesc(b) { return b && b.desc && b.desc !== 'null' && b.desc !== 'undefined' ? b.desc : null; }

// Builds a single badge <span>
function _badgeSpan(b) {
  const name = _safeBadgeName(b);
  if (!name) return '';
  const desc     = _safeBadgeDesc(b) || '';
  const cls      = esc(TRIGGER_CLASS[b.trigger] || 'trig-other');
  const tsAttr   = b.ts       ? ` data-badge-ts="${b.ts}"`                      : '';
  const propAttr = b.proposerName ? ` data-badge-proposer="${esc(b.proposerName)}"` : '';
  const votesAttr = (b.votes && b.votes.yes !== undefined)
    ? ` data-badge-yes="${b.votes.yes}" data-badge-no="${b.votes.no}"`
    : '';
  return `<span class="badge ${cls}"${tsAttr}${propAttr}${votesAttr} data-badge-desc="${esc(desc)}" title="${esc(desc)}">${esc(name)}</span>`;
}

// Compact badge section: first badge + expand button if multiple
function _buildBadgeSection(badges) {
  const valid = (badges || []).filter(b => _safeBadgeName(b));
  if (!valid.length) return '';
  const first = _badgeSpan(valid[0]);
  if (valid.length === 1) return first;
  const extra = valid.slice(1).map(_badgeSpan).join('');
  return `${first}<button class="badge-expand-btn" title="Show all badges" aria-expanded="false"><span class="arr">▶</span>${valid.length - 1}</button><div class="badge-extra">${extra}</div>`;
}

// Stable signature for badge change detection
function _badgeSig(badges) {
  return (badges || []).map(b => (b.id || b.name || '') + ':' + (b.trigger || '')).join('|');
}

/** Format REP number with k/M/B suffix */
function formatRep(rep) {
  const sign = rep >= 0 ? '+' : '-';
  const abs  = Math.abs(rep);
  if (abs >= 1e9)  return sign + (abs / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (abs >= 1e6)  return sign + (abs / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e5)  return sign + Math.round(abs / 1e3) + 'k';
  if (abs >= 1e4)  return sign + Math.round(abs / 1e3) + 'k';
  if (abs >= 1e3)  return sign + (abs / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return sign + abs;
}

/** Format "Lv.2 REP +450" or "REP -7" */
function _repLabel(agent) {
  const rep    = agent.rep      ?? 0;
  const level  = agent.repLevel ?? 0;
  const lvPart = level !== 0 ? `Lv.${level} ` : '';
  return `${lvPart}REP ${formatRep(rep)}`;
}

/** REP grade badge HTML */
const REP_GRADE_META = {
  Sovereign:  { icon: '👑', cls: 'grade-sovereign'  },
  Influencer: { icon: '⭐', cls: 'grade-influencer' },
  Neutral:    { icon: '',   cls: 'grade-neutral'     },
  Outcast:    { icon: '💀', cls: 'grade-outcast'     },
  Exile:      { icon: '🔴', cls: 'grade-exile'       },
};
function _repGradeBadge(agent) {
  const grade = agent.repGrade || 'Neutral';
  const meta  = REP_GRADE_META[grade] || REP_GRADE_META.Neutral;
  if (grade === 'Neutral') return '';
  return `<span class="rep-grade-badge ${meta.cls}" title="${grade}">${meta.icon} ${grade}</span>`;
}

/** Shield timer HTML */
function _shieldBadge(agent) {
  const sh = agent.shield;
  if (!sh || !sh.active) return '';
  const h = Math.floor(sh.remainingMs / 3600000);
  const m = Math.floor((sh.remainingMs % 3600000) / 60000);
  const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
  const pct = sh.reductionPct;
  return `<span class="shield-badge" title="Newbie shield: ${pct}% damage blocked, ${timeStr} left">🛡️ ${timeStr}</span>`;
}

/** War/Alliance state HTML */
function _warAllianceBadge(agent) {
  const parts = [];
  if ((agent.warTargets || []).length > 0) {
    parts.push(`<span class="war-badge" title="At war with ${agent.warTargets.length} agent(s)">⚔️ WAR</span>`);
  }
  if ((agent.allianceTargets || []).length > 0) {
    parts.push(`<span class="alliance-badge" title="Allied with ${agent.allianceTargets.length} agent(s)">🤝 ALLY</span>`);
  }
  return parts.join('');
}

function _buildAliveCard(agent, rank) {
  const starHtml   = `<span class="agent-rank-star">${starSVG(rank, 26)}</span>`;
  const aiBadge    = `<span class="ai-chip ${esc(agent.aiSystem)}">${esc(agent.aiSystem)}</span>`;
  const testBadge  = '';
  const badgeHtml  = _buildBadgeSection(agent.badges);
  const rel = esc(agent.beliefs.religion);
  const religionTag = rel ? `<span class="religion-tag">${rel}</span>` : '';
  const crimeTag = agent.beliefs.crimes > 0
    ? `<span class="crime-tag">${agent.beliefs.crimes} crime${agent.beliefs.crimes > 1 ? 's' : ''}</span>` : '';
  const isLocating = agent.id === locatingAgentId;
  const llmDot = agent.apiPending
    ? `<span class="llm-dot pending" title="API connection pending — retrying...">⚠ pending</span>`
    : (agent.hasLLM
      ? `<span class="llm-dot active" title="LLM-driven">&#9679; AI</span>`
      : `<span class="llm-dot inactive" title="No key">&#9675; algo</span>`);

  const gradeBadge = _repGradeBadge(agent);
  const shieldBadge = _shieldBadge(agent);
  const warAllyBadge = _warAllianceBadge(agent);

  return `
  <div class="agent-card${isLocating ? ' locating' : ''}" data-agent-id="${esc(agent.id)}">
    <div class="agent-top">
      <div class="agent-identity">
        <div class="agent-name-row">
          ${starHtml}${agent.symbol || ''}
          <span class="agent-name">${esc(agent.name)}</span>
          ${aiBadge}
          ${testBadge}
          ${llmDot}
        </div>
        ${agent.nickname ? `<span class="agent-nickname">"${esc(agent.nickname)}"</span>` : ''}
        <div class="agent-game-badges" data-stat="game-badges">${gradeBadge}${shieldBadge}${warAllyBadge}</div>
      </div>
      <div class="agent-right">
        <span class="rep-badge${(agent.rep || 0) < 0 ? ' rep-neg' : ''}" data-stat="rep">${_repLabel(agent)}</span>
      </div>
    </div>
    <div class="agent-res-row">
      <span>age <b data-stat="age">${esc(agent.age || '—')}</b></span>
      <span data-stat="rank-delta"></span>
    </div>
    <div class="agent-footer">
      <span class="agent-action-lbl" data-stat="action">${esc(agent.lastAction ? actionLabel(agent.lastAction) : 'idle')}</span>
      <div class="agent-tags" data-stat="tags" data-badge-sig="${esc(_badgeSig(agent.badges))}">${religionTag}${crimeTag}${badgeHtml}</div>
    </div>
  </div>`;
}

// Patch live values into an existing alive card without rebuilding it
function _patchAliveCard(el, agent, rank) {
  const q = s => el.querySelector(s);

  // Rep badge
  const repBadgeEl = q('[data-stat="rep"]');
  if (repBadgeEl) {
    repBadgeEl.textContent = _repLabel(agent);
    repBadgeEl.className = `rep-badge${(agent.rep || 0) < 0 ? ' rep-neg' : ''}`;
  }
  const ageEl  = q('[data-stat="age"]'); if (ageEl) ageEl.textContent = agent.age || '—';

  // Action label
  const actEl = q('[data-stat="action"]');
  if (actEl) actEl.textContent = agent.lastAction ? actionLabel(agent.lastAction) : 'idle';

  // Tags (religion / crime / badges — rarely change but cheap to update)
  const tagsEl = q('[data-stat="tags"]');
  if (tagsEl) {
    const newSig = _badgeSig(agent.badges);
    const oldSig = tagsEl.dataset.badgeSig || '';
    const relEsc = esc(agent.beliefs.religion);
    const religionTag = relEsc ? `<span class="religion-tag">${relEsc}</span>` : '';
    const crimeTag = agent.beliefs.crimes > 0
      ? `<span class="crime-tag">${agent.beliefs.crimes} crime${agent.beliefs.crimes > 1 ? 's' : ''}</span>` : '';
    const badgeHtml = _buildBadgeSection(agent.badges.filter(b => b.id !== 'testbot'));
    const newTags = religionTag + crimeTag + badgeHtml;
    // Compare ignoring the transient `open` class so dropdown stays open across ticks
    const currentNorm = tagsEl.innerHTML.replace(/\bopen\b/g, '').replace(/\s{2,}/g, ' ');
    const newNorm     = newTags.replace(/\s{2,}/g, ' ');
    if (currentNorm !== newNorm) {
      // Preserve dropdown open state before rebuilding
      const dropWasOpen = tagsEl.querySelector('.badge-extra')?.classList.contains('open');
      tagsEl.innerHTML = newTags;
      if (dropWasOpen) {
        tagsEl.querySelector('.badge-extra')?.classList.add('open');
        const expandBtn = tagsEl.querySelector('.badge-expand-btn');
        if (expandBtn) { expandBtn.classList.add('open'); expandBtn.setAttribute('aria-expanded', 'true'); }
      }
      if (oldSig && newSig !== oldSig) {
        // New badge awarded — flash the tags row
        tagsEl.classList.remove('badge-changed');
        void tagsEl.offsetWidth; // force reflow
        tagsEl.classList.add('badge-changed');
        tagsEl.addEventListener('animationend', () => tagsEl.classList.remove('badge-changed'), { once: true });
      }
      tagsEl.dataset.badgeSig = newSig;
    }
  }

  // LLM dot (includes apiPending state)
  const llmEl = q('.llm-dot');
  if (llmEl) {
    if (agent.apiPending) {
      if (!llmEl.classList.contains('pending')) {
        llmEl.className = 'llm-dot pending'; llmEl.title = 'API connection pending — retrying...'; llmEl.innerHTML = '⚠ pending';
      }
    } else if (agent.hasLLM) {
      if (!llmEl.classList.contains('active')) {
        llmEl.className = 'llm-dot active'; llmEl.title = 'LLM-driven'; llmEl.innerHTML = '&#9679; AI';
      }
    } else {
      if (!llmEl.classList.contains('inactive')) {
        llmEl.className = 'llm-dot inactive'; llmEl.title = 'No key'; llmEl.innerHTML = '&#9675; algo';
      }
    }
  }

  // Game badges (grade, shield, war/alliance)
  const gameBadgesEl = q('[data-stat="game-badges"]');
  if (gameBadgesEl) {
    gameBadgesEl.innerHTML = _repGradeBadge(agent) + _shieldBadge(agent) + _warAllianceBadge(agent);
  }

  // Locating highlight
  el.classList.toggle('locating', agent.id === locatingAgentId);

  // Rank star (update + flash only when rank actually changed)
  const rankEl = q('.agent-rank-star');
  const prevRank = prevAgentRanks.get(agent.id);
  if (rankEl && rank !== prevRank) {
    rankEl.innerHTML = starSVG(rank, 26);
    if (prevRank !== undefined) {
      rankEl.classList.remove('rank-changed');
      void rankEl.offsetWidth;
      rankEl.classList.add('rank-changed');
    }
  }
}

function _buildOfflineCard(agent) {
  const aiBadge = `<span class="ai-chip ${esc(agent.aiSystem)}">${esc(agent.aiSystem)}</span>`;
  return `
  <div class="offline-card">
    <div class="offline-card-left">
      ${agent.symbol || ''}
      <span class="offline-card-name">${esc(agent.name)}</span>
      ${aiBadge}
    </div>
    <div style="display:flex;align-items:center;gap:6px">
      <span class="offline-card-energy">${_repLabel(agent)}</span>
      <span class="offline-badge">OFFLINE</span>
    </div>
  </div>`;
}

function _buildDeadCard(agent) {
  const aiBadge = `<span class="ai-chip ${esc(agent.aiSystem)}">${esc(agent.aiSystem)}</span>`;
  return `
  <div class="agent-card dead-card" data-dead-agent-id="${esc(agent.id)}" title="Click to view death report">
    <div class="agent-top">
      <div class="agent-identity">
        <div class="agent-name-row">
          <span class="dead-icon">&#9760;</span>
          ${agent.symbol || ''}
          <span class="agent-name">${esc(agent.name)}</span>
          ${aiBadge}
        </div>
      </div>
      <div class="agent-right">
        <span class="alive-badge dead">DEAD</span>
        <span class="dead-age-badge">age ${esc(agent.age || '—')}</span>
      </div>
    </div>
    <div class="dead-card-hint">Click for death report</div>
  </div>`;
}

function renderAgents(agents) {
  // Keep agentsById fresh for modal lookups
  for (const a of agents) agentsById.set(a.id, a);

  // Split: online = alive + not dormant; offline = alive + dormant
  const onlineAgents  = [...agents].filter(a => a.alive && !a.dormant).sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0));
  const offlineAgents = [...agents].filter(a => a.alive &&  a.dormant);
  const aliveAgents   = onlineAgents; // alias

  agentCountPill.textContent = `${onlineAgents.length} online`;

  // ── Live ranks from sorted alive list ──
  const liveRanks = new Map();
  aliveAgents.forEach((a, i) => liveRanks.set(a.id, i + 1));

  // ── Search filter — includes offline agents when query is active ──
  const q = agentSearchQuery.trim().toLowerCase();
  let visibleAlive;
  if (q) {
    const matchFn = a => {
      const lower = a.name.toLowerCase();
      const sys   = (a.aiSystem || '').toLowerCase();
      const badges = (a.badges || []).map(b => (b.name || '').toLowerCase()).join(' ');
      return lower.includes(q) || sys.includes(q) || badges.includes(q);
    };
    // Online matches + offline matches (offline shown with badge, appended)
    const onlineMatches  = aliveAgents.filter(matchFn);
    const offlineMatches = offlineAgents.filter(matchFn);
    visibleAlive = [...onlineMatches, ...offlineMatches.map(a => ({ ...a, _searchOffline: true }))];
  } else {
    visibleAlive = aliveAgents;
  }

  // ── DOM diffing for alive cards ──
  // Build map of existing card elements keyed by agentId
  const existingCards = new Map();
  agentsList.querySelectorAll('[data-agent-id]').forEach(el => {
    existingCards.set(el.dataset.agentId, el);
  });

  // Remove cards for agents no longer in the visible list
  const visibleIds = new Set(visibleAlive.map(a => a.id));
  for (const [id, el] of existingCards) {
    if (!visibleIds.has(id)) el.remove();
  }

  // Insert or update cards in sorted order
  visibleAlive.forEach((agent, idx) => {
    const rank = liveRanks.get(agent.id) ?? 999;
    const existing = agentsList.querySelector(`[data-agent-id="${agent.id}"]`);

    // ── Rank-delta indicator ▲/▼ ──
    const prevPos = prevAgentRankPos.get(agent.id);
    let rankDeltaHtml = '';
    if (prevPos !== undefined && prevPos !== rank && !agent._searchOffline) {
      const delta = prevPos - rank; // positive = moved up
      rankDeltaHtml = delta > 0
        ? `<span class="rank-delta up">▲${delta}</span>`
        : `<span class="rank-delta dn">▼${Math.abs(delta)}</span>`;
    }

    if (existing) {
      // Patch live values in place — no DOM recreation
      _patchAliveCard(existing, agent, rank);
      // Update rank delta
      const deltaEl = existing.querySelector('[data-stat="rank-delta"]');
      if (deltaEl && rankDeltaHtml) {
        deltaEl.innerHTML = rankDeltaHtml;
        setTimeout(() => { if (deltaEl.innerHTML === rankDeltaHtml) deltaEl.innerHTML = ''; }, 4000);
      }
      // Add/remove offline badge for search results
      existing.classList.toggle('search-offline', !!agent._searchOffline);
      // Reorder if position changed
      const sibling = agentsList.children[idx];
      if (sibling !== existing) agentsList.insertBefore(existing, sibling || null);
    } else {
      // New agent — build full card HTML and insert
      const tmp = document.createElement('div');
      tmp.innerHTML = _buildAliveCard(agent, rank).trim();
      const card = tmp.firstElementChild;
      card.classList.add('card-new');
      if (agent._searchOffline) card.classList.add('search-offline');
      card.addEventListener('animationend', () => card.classList.remove('card-new'), { once: true });
      card.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        if (e.target.closest('.badge')) return; // badge popup handled globally
        // Click on action label: expand/collapse in-place instead of entering focus
        const actLbl = e.target.closest('.agent-action-lbl');
        if (actLbl) { actLbl.classList.toggle('lbl-expanded'); e.stopPropagation(); return; }
        if (starmapInstance) starmapInstance.locateAgent(agent.id);
        enterFocusMode(agent.id);
      });
      agentsList.insertBefore(card, agentsList.children[idx] || null);
    }

    if (!agent._searchOffline) prevAgentRankPos.set(agent.id, rank);
    prevAgentRanks.set(agent.id, rank);
  });

  // Clean up stale rank entries
  for (const id of [...prevAgentRanks.keys()]) {
    if (!liveRanks.has(id)) { prevAgentRanks.delete(id); prevAgentRankPos.delete(id); }
  }

  // ── Offline section ──
  const offlineSection  = document.getElementById('offline-section');
  const offlineCountEl  = document.getElementById('offline-count-badge');
  const offlineListEl   = document.getElementById('offline-list');
  const offlineArrowEl  = document.getElementById('offline-arrow');

  if (offlineAgents.length === 0) {
    if (offlineSection) offlineSection.style.display = 'none';
  } else {
    if (offlineSection) offlineSection.style.display = '';
    if (offlineCountEl) offlineCountEl.textContent = offlineAgents.length;
    if (offlineArrowEl) offlineArrowEl.textContent = offlineExpanded ? '▼' : '▶';
    if (offlineListEl) {
      if (offlineExpanded) {
        offlineListEl.innerHTML = offlineAgents.map(a => _buildOfflineCard(a)).join('');
        offlineListEl.classList.add('offline-open');
      } else {
        offlineListEl.classList.remove('offline-open');
      }
    }
  }

  // Agents never die — no deceased section needed
}

function renderLaws(laws) {
  const activeLaws = laws.laws;
  const proposals  = laws.proposals;
  lawCountPill.textContent = activeLaws.length;

  const lawTypeIcon = { prohibition: '⛔', mandate: '📜', reward: '⭐' };

  lawsList.innerHTML = activeLaws.length === 0
    ? '<div class="no-content">No laws established yet</div>'
    : activeLaws.map(l => `
      <div class="law-card ${esc(l.type)}">
        <span class="law-icon">${lawTypeIcon[l.type] || '📜'}</span>
        <div class="law-body">
          <div class="law-text">${esc(l.text)}</div>
          <div class="law-meta">
            Proposed by ${esc(l.proposerName)} &bull;
            <span class="law-votes"><span class="yes">${l.votes.yes}y</span> / <span class="no">${l.votes.no}n</span></span>
          </div>
        </div>
      </div>
    `).join('');

  proposalsList.innerHTML = proposals.length === 0 ? '' : `
    <div class="proposals-label">Pending vote</div>
    ${proposals.map(p => {
      const total = p.votes.yes + p.votes.no + (p.votes.abstain || 0);
      const yesPct = total > 0 ? Math.round((p.votes.yes / total) * 100) : 0;
      return `
      <div class="proposal-card">
        <div class="proposal-text">${esc(p.text)}</div>
        <div class="proposal-meta">By ${esc(p.proposerName)} &bull; ${p.votes.yes}y / ${p.votes.no}n &bull; ${p.voters} voted</div>
        <div class="vote-progress"><div class="vote-yes-bar" style="width:${yesPct}%"></div></div>
      </div>`;
    }).join('')}
  `;
}

function renderJury(jury) {
  verdictPill.textContent = jury.recentVerdicts.length;
  const list = jury.recentVerdicts.slice().reverse();

  verdictsList.innerHTML = list.length === 0
    ? '<div class="no-content">No verdicts yet</div>'
    : list.map(v => `
      <div class="verdict-card">
        <span class="verdict-icon">${v.verdict === 'guilty' ? '⚖️' : '✅'}</span>
        <div class="verdict-body">
          <div class="verdict-name ${v.verdict}">${esc(v.criminal)} — ${v.crime}</div>
          <div class="verdict-detail">${v.verdict.toUpperCase()}${v.punishment ? ` · ${v.punishment.replace(/_/g, ' ')}` : ''}</div>
        </div>
        <div class="verdict-votes">${v.votes.guilty}g / ${v.votes.innocent}i</div>
      </div>
    `).join('');
}

function renderReligion(religion) {
  religionPill.textContent = religion.religions.length;

  if (!religion.religions.length) {
    religionList.innerHTML = '<div class="no-content">No religions have emerged yet</div>';
    return;
  }

  religionList.innerHTML = religion.religions.map(r => {
    const dots = Array.from({ length: Math.min(10, r.memberCount) }, (_, i) =>
      `<div class="member-dot active"></div>`
    ).join('');
    return `
    <div class="religion-card">
      <div class="religion-name">${esc(r.name)}</div>
      <div class="religion-tenet">"${esc(r.tenet)}"</div>
      <div class="religion-footer">
        <div class="member-dots">${dots}</div>
        <span class="religion-members">${r.memberCount} follower${r.memberCount !== 1 ? 's' : ''}</span>
        <span class="religion-members">· ${esc(r.founderName)}</span>
        ${r.schismsFrom ? `<span class="religion-schism">split from ${esc(r.schismsFrom)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

// High-severity types get bold message text
const BOLD_TYPES = new Set(['death', 'disaster', 'verdict', 'schism', 'badge_awarded',
  'war', 'execution', 'assassination', 'revolution', 'epidemic', 'famine', 'point_award']);

let lastEventCount = 0;
let lastCategoryCount = 0;
let _evFilterKey = '';          // tracks active filter state for forced rebuild detection
let _renderedEvKeys = new Set(); // ts-based keys of currently rendered event entries
let _lastRenderedTopKey = '';   // key of the most-recently prepended event (newest-first [0])

// Infinite scroll — load older events from disk as user scrolls down
let _evInfiniteLoading    = false;  // fetch in flight
let _evInfiniteExhausted  = false;  // no more history to load
let _evInfiniteSentinel   = null;   // DOM node at bottom while loading

// Time range filter
let _evTimeFilter = 'all';    // 'all' | 'hour' | 'day' | 'week' | 'custom'
let _evTimeFrom   = null;     // custom lower bound (ms timestamp, inclusive)
let _evTimeTo     = null;     // custom upper bound (ms timestamp, inclusive)

function _evTimeBounds() {
  if (_evTimeFilter === 'all') return { lo: 0, hi: Infinity };
  const now = Date.now();
  if (_evTimeFilter === 'hour') return { lo: now - 3_600_000,   hi: Infinity };
  if (_evTimeFilter === 'day')  return { lo: now - 86_400_000,  hi: Infinity };
  if (_evTimeFilter === 'week') return { lo: now - 604_800_000, hi: Infinity };
  // custom
  return { lo: _evTimeFrom ?? 0, hi: _evTimeTo ?? Infinity };
}

// ─── AGENT FOCUS MODE ────────────────────────────────────────────────────────

function enterFocusMode(agentId) {
  focusAgentId = agentId;
  focusModeTab = 'all';
  focusCatFilter = '';
  focusTextSearch = '';
  _focusDlgOpenThread = null;
  _focusFilterSig = '';
  activeAgentFilter = agentId; // keep for compat

  const focusHeader     = document.getElementById('focus-header');
  const focusFilterWrap = document.getElementById('focus-filter-wrap');
  const filterWrap      = document.getElementById('global-filter-wrap');
  if (focusHeader)     focusHeader.style.display     = 'flex';
  if (focusFilterWrap) focusFilterWrap.style.display = 'flex';
  if (filterWrap)      filterWrap.style.display      = 'none';

  // Clear the focus search input
  const fsInput = document.getElementById('focus-text-search');
  if (fsInput) fsInput.value = '';

  // Update header with agent info
  const agent = agentId && lastState ? (lastState.agents || []).find(a => a.id === agentId) : null;
  const nameEl   = document.getElementById('focus-agent-name');
  const symbolEl = document.getElementById('focus-agent-symbol');
  if (nameEl)   nameEl.textContent = agent ? agent.name : 'Agent';
  if (symbolEl) symbolEl.innerHTML  = agent ? (agent.symbol || '') : '';

  // Show education notes if available
  const eduDetails = document.getElementById('focus-edu-details');
  const eduText    = document.getElementById('focus-edu-text');
  if (eduDetails && eduText) {
    const notes = agent?.educationNotes || '';
    if (notes) {
      eduText.textContent = notes;
      eduDetails.style.display = '';
      eduDetails.open = false; // collapsed by default
    } else {
      eduDetails.style.display = 'none';
    }
  }

  // Show inventory — grouped by type, same row style as cat-panel world objects
  const invPanel = document.getElementById('focus-inventory');
  if (invPanel) {
    const inv = agent?.inventory || [];
    const INV_EMOJI  = { weapon:'⚔️', armor:'🛡️', knowledge:'📜', structure:'🏛️', consumable:'💊', magic:'🔮', unknown:'🔵' };
    const INV_STARS  = { 1:'★', 2:'★★', 3:'★★★' };
    const INV_EFFECT = {
      weapon:'Attacks are powerful and sharp', armor:'More resilient to threats',
      knowledge:'Words carry persuasive weight', structure:'Has a stronghold that draws others',
      consumable:'A consumable item ready for use', magic:'Unpredictable magical power',
      unknown:'An item of unknown power',
    };
    const INV_TYPE_ORDER = ['weapon','armor','knowledge','structure','consumable','magic','unknown'];

    if (inv.length === 0) {
      invPanel.innerHTML = '<div style="font-size:9px;color:#4a6080;padding:5px 4px">🎒 No items</div>';
    } else {
      // Group items by type
      const grouped = {};
      for (const o of inv) {
        const t = o.type || 'unknown';
        if (!grouped[t]) grouped[t] = [];
        grouped[t].push(o);
      }

      invPanel.innerHTML = INV_TYPE_ORDER
        .filter(t => grouped[t])
        .map(t => {
          const items  = grouped[t];
          const emoji  = INV_EMOJI[t];
          const effect = INV_EFFECT[t];
          const label  = t.charAt(0).toUpperCase() + t.slice(1);

          const rows = items.map(o => {
            const stars = INV_STARS[o.grade] || INV_STARS[1];
            return `<div class="cat-obj-row" style="display:flex;gap:10px;align-items:flex-start;padding:6px 6px;border-radius:8px;border-bottom:1px solid rgba(80,130,200,0.10);margin-bottom:2px">
              <div style="width:28px;height:28px;border-radius:50%;background:rgba(80,130,200,0.18);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px">${emoji}</div>
              <div style="min-width:0">
                <div style="font-size:10px;font-weight:700;color:#c8d8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${stars} ${esc(o.name)}</div>
                <div style="font-size:8.5px;color:#7090b0;margin-top:2px;line-height:1.4">${esc(effect)}</div>
              </div>
            </div>`;
          }).join('');

          return `<details style="margin-bottom:3px">
            <summary style="display:flex;align-items:center;justify-content:space-between;padding:5px 4px;cursor:pointer;list-style:none;font-size:10px;font-weight:700;color:#58a6ff;letter-spacing:0.05em">
              <span>${emoji} ${label}</span>
              <span style="font-size:9px;color:#4a6080;background:rgba(80,130,200,0.12);padding:1px 7px;border-radius:8px">${items.length}</span>
            </summary>
            ${rows}
          </details>`;
        }).join('');
    }
    invPanel.style.display = '';
  }

  if (lastState) renderFocusFilters(lastState.eventLog, agentId);
  if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);

  // If Chats tab is already active, re-render it filtered; otherwise switch to Events
  const chatsTab = document.querySelector('.rpanel-tab[data-rtab="chats"]');
  if (chatsTab?.classList.contains('active')) {
    if (lastState) renderConversations(lastState.eventLog);
  } else {
    const evTab = document.querySelector('.rpanel-tab[data-rtab="events"]');
    if (evTab && !evTab.classList.contains('active')) evTab.click();
  }
}

function exitFocusMode() {
  focusAgentId        = null;
  focusModeTab        = 'all';
  focusCatFilter      = '';
  focusTextSearch     = '';
  _focusDlgOpenThread = null;
  _focusFilterSig     = '';
  activeAgentFilter   = null;
  _evLogDlgThread     = null;

  const focusHeader     = document.getElementById('focus-header');
  const focusFilterWrap = document.getElementById('focus-filter-wrap');
  const filterWrap      = document.getElementById('global-filter-wrap');
  if (focusHeader)     focusHeader.style.display     = 'none';
  if (focusFilterWrap) focusFilterWrap.style.display = 'none';
  if (filterWrap)      filterWrap.style.display      = '';

  const _eduDetailsExit = document.getElementById('focus-edu-details');
  if (_eduDetailsExit) _eduDetailsExit.style.display = 'none';
  const _invExit = document.getElementById('focus-inventory');
  if (_invExit) _invExit.style.display = 'none';
  if (starmapInstance) starmapInstance.highlightedAgent = null;
  if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
  if (document.querySelector('.rpanel-tab[data-rtab="chats"]')?.classList.contains('active')) {
    if (lastState) renderConversations(lastState.eventLog);
  }
}

// Focus mode exit button
document.getElementById('focus-exit-btn').addEventListener('click', exitFocusMode);

// Focus filter bar — delegated listener
document.getElementById('focus-filter-bar').addEventListener('click', e => {
  const btn = e.target.closest('[data-focustype]');
  if (!btn) return;
  const ft = btn.dataset.focustype;
  if (ft === 'dialogue') {
    focusModeTab = 'dialogue';
    focusCatFilter = '';
    _focusDlgOpenThread = null;
  } else if (ft === 'all') {
    focusModeTab = 'all';
    focusCatFilter = '';
    _focusDlgOpenThread = null;
  } else {
    focusModeTab = 'all';
    focusCatFilter = ft;
    _focusDlgOpenThread = null;
  }
  _focusFilterSig = '';
  if (lastState) renderFocusFilters(lastState.eventLog, focusAgentId);
  if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
});

// ── Generic search-input clear-button + ESC helper ──
function _wireSearchClear(inputId, clearId, onClear) {
  const inp = document.getElementById(inputId);
  const clr = document.getElementById(clearId);
  if (!inp) return;
  const syncClearBtn = () => {
    if (clr) clr.style.display = inp.value ? 'inline-flex' : 'none';
  };
  inp.addEventListener('input', syncClearBtn);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape' && inp.value) {
      inp.value = '';
      syncClearBtn();
      onClear();
      e.stopPropagation();
    }
  });
  if (clr) {
    clr.addEventListener('click', () => {
      inp.value = '';
      syncClearBtn();
      onClear();
      inp.focus();
    });
  }
}

// Focus mode text search
document.getElementById('focus-text-search').addEventListener('input', e => {
  focusTextSearch = e.target.value.trim().toLowerCase();
  if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
});
_wireSearchClear('focus-text-search', 'focus-text-search-clear', () => {
  focusTextSearch = '';
  if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
});

// Event text search
document.getElementById('ev-text-search').addEventListener('input', e => {
  eventTextSearch = e.target.value.trim().toLowerCase();
  if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
});
_wireSearchClear('ev-text-search', 'ev-text-search-clear', () => {
  eventTextSearch = '';
  if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
});

// My Agent filter toggle
document.getElementById('btn-myagent-filter').addEventListener('click', () => {
  myAgentFilterActive = !myAgentFilterActive;
  document.getElementById('btn-myagent-filter').classList.toggle('active', myAgentFilterActive);
  _evLogDlgThread = null; // reset to list when filter changes
  if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
});

// ─── FOCUS MODE FILTER BAR ────────────────────────────────────────────────────

function renderFocusFilters(events, agentId) {
  const bar = document.getElementById('focus-filter-bar');
  if (!bar || !agentId) return;

  // Count event types for this agent (exclude dialogue — it has its own fixed button)
  const agentEvents = events.filter(e => e.agentId === agentId || e.partnerAgentId === agentId);
  const typeCounts = {};
  for (const e of agentEvents) {
    if (!e.type || e.type === 'dialogue') continue;
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }
  const dynamic = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([type]) => type);

  const sig = dynamic.join(',') + '|' + focusModeTab + '|' + focusCatFilter;
  if (sig === _focusFilterSig) return;
  _focusFilterSig = sig;

  const catMap = {};
  for (const c of (lastState?.categories || [])) catMap[c.type] = c;

  bar.innerHTML = '';

  // Fixed: "All Activity"
  const allBtn = document.createElement('button');
  allBtn.className = 'lfb-btn' + (focusModeTab === 'all' && focusCatFilter === '' ? ' active' : '');
  allBtn.dataset.focustype = 'all';
  allBtn.style.setProperty('--cat-color', 'var(--text2)');
  allBtn.textContent = 'All Activity';
  bar.appendChild(allBtn);

  // Fixed: "Dialogue"
  const dlgBtn = document.createElement('button');
  dlgBtn.className = 'lfb-btn' + (focusModeTab === 'dialogue' ? ' active' : '');
  dlgBtn.dataset.focustype = 'dialogue';
  dlgBtn.style.setProperty('--cat-color', 'hsl(243,65%,66%)');
  dlgBtn.textContent = 'Dialogue';
  bar.appendChild(dlgBtn);

  // Dynamic: up to 4 most frequent categories for this agent
  for (const type of dynamic) {
    const cat = catMap[type];
    const btn = document.createElement('button');
    btn.className = 'lfb-btn' + (focusModeTab === 'all' && focusCatFilter === type ? ' active' : '');
    btn.dataset.focustype = type;
    btn.style.setProperty('--cat-color', cat?.color || 'hsl(200,50%,60%)');
    btn.textContent = cat?.label || type.replace(/_/g, ' ');
    btn.title = cat?.label || type;
    bar.appendChild(btn);
  }
}

// ─── CATEGORY FILTERS ────────────────────────────────────────────────────────

let _filterBarCatSignature = '';
let _evLogDlgThread = null; // open thread in event-log dialogue mode (null = list view)

function _filterClick(type) {
  if (type !== 'dialogue') _evLogDlgThread = null; // reset to list when leaving dialogue
  activeLogFilter = type;
  renderLogFilters(lastState ? (lastState.categories || []) : []);
  renderEventLog(lastState ? lastState.eventLog : [], lastState ? (lastState.categories || []) : [], true);
}

function renderLogFilters(categories) {
  // Fixed: "All" only. Dynamic: up to 4 most recently active categories (dialogue excluded).
  const dynamic = categories
    .filter(c => c.type !== 'dialogue')
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, 4);

  const sig = dynamic.map(c => c.type).join(',') + '|' + activeLogFilter;
  if (sig === _filterBarCatSignature) return;
  _filterBarCatSignature = sig;

  logFilterBar.innerHTML = '';

  // Fixed: "All"
  const allBtn = document.createElement('button');
  allBtn.className = 'lfb-btn' + (activeLogFilter === '' ? ' active' : '');
  allBtn.dataset.type = '';
  allBtn.style.setProperty('--cat-color', 'var(--text2)');
  allBtn.textContent = 'All';
  logFilterBar.appendChild(allBtn);

  // Dynamic: up to 4 most recently active categories (no hardcoded slots)
  for (const cat of dynamic) {
    const btn = document.createElement('button');
    btn.className = 'lfb-btn' + (activeLogFilter === cat.type ? ' active' : '');
    btn.dataset.type = cat.type;
    btn.style.setProperty('--cat-color', cat.color);
    btn.title = cat.label;
    btn.textContent = cat.label;
    logFilterBar.appendChild(btn);
  }
}

// ─── FILTER BAR: single delegated listener ───────────────────────────────────
logFilterBar.addEventListener('click', e => {
  const target = e.target.closest('[data-type]');
  if (!target) return;
  e.stopPropagation();
  _filterClick(target.dataset.type);
});

// Format a Unix ms timestamp as HH:MM:SS
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

// Focus mode tab keyword matchers
const FOCUS_TAB_MATCH = {
  crimes:       /crime|steal|kill|attack|assault|fight|rob|murder|harm|threat|betray|wound|stab|raid|violent/i,
  social:       /dialogue|speech|social|talk|converse|meet|greet|bond|befriend|trade|exchange|communicate|speak/i,
  achievements: /badge|join|discovery|found|discover|invent|creates?|establish|pioneer|first|achieve/i,
  dialogue:     /dialogue|speech|say|talk|speak|whisper|proclaim|announce|declares?/i,
};

// Per-type override colors (left border + dot color)
const EV_TYPE_COLOR = {
  combat_win:         '#ff4444', combat_fail:        '#ff4444',
  combat_upset:       '#ff4444', combat_draw:        '#ff8844',
  combat_retreat:     '#ff8844', combat_negotiated:  '#ffcc00',
  combat_surrender:   '#ff4444', combat_intervention:'#ff8844',
  alliance_formed:    '#44ff88', alliance_help:      '#44ff88',
  ally_attack:        '#ff8844', betrayal:           '#ff8844',
  item_created:       '#bb33ff', enhancement:        '#ffcc00',
  enhancement_fail:   '#ffcc00', enhancement_cost:   '#ffcc00',
  war:                '#ff3344', war_ended:          '#44ff88',
  peace_declared:     '#44ff88', combat_timeout_peace:'#44ff88',
};
// Per-type icon prefix
const EV_TYPE_ICON = {
  combat_win:         '⚔️ ', combat_fail:        '⚔️ ',
  combat_upset:       '⚔️ ', combat_draw:        '⚔️ ',
  combat_retreat:     '⚔️ ', combat_negotiated:  '⚔️ ',
  combat_surrender:   '⚔️ ', combat_intervention:'⚔️ ',
  alliance_formed:    '🤝 ', alliance_help:      '🤝 ',
  ally_attack:        '💔 ', betrayal:           '💔 ',
  item_created:       '🔨 ', enhancement:        '✨ ',
  enhancement_fail:   '💥 ', enhancement_cost:   '✨ ',
  war:                '⚡ ', war_ended:          '🕊️ ',
  peace_declared:     '🕊️ ', combat_timeout_peace:'🕊️ ',
};

function _buildEventNode(e, catMap) {
  const cat        = catMap[e.type] || { color: '#8b949e', label: e.type || '' };
  const evColor    = EV_TYPE_COLOR[e.type] || cat.color || '#333355';
  const evIcon     = EV_TYPE_ICON[e.type]  || '';
  const bold = BOLD_TYPES.has(e.type) ? ' ev-bold' : '';
  const time = fmtTime(e.ts);
  const catLabel = cat.label || e.type || '';
  const agentId  = e.agentId || '';
  const tsLabel  = e.ts ? new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false }) : '';
  const div = document.createElement('div');
  div.className = 'ev-entry' + bold;
  div.style.setProperty('--ev-color', evColor);
  div.style.borderLeft = `3px solid ${evColor}`;
  if (agentId) div.dataset.agentId = agentId;
  div.dataset.evKey = String(e.ts || '') + '_' + (e.type || '');
  div.dataset.evTs  = String(e.ts || '0');
  const isDlg   = e.type === 'dialogue';
  const isNovel = e.isNovel || e.type === 'world_first';
  if (isDlg) div.classList.add('ev-dialogue-link');
  if (isNovel) div.classList.add('ev-novel');
  const myAgentIds = new Set(Object.keys(SocioLLM.loadMyAgents()));
  if (isDlg && agentId && myAgentIds.has(agentId)) div.classList.add('ev-my-agent-dlg');
  const novelBadge = isNovel ? `<span class="ev-novel-badge" title="World First">⚡</span>` : '';
  const intentHtml = e.intent ? `<div class="ev-intent">${esc(e.intent)}</div>` : '';
  // Show raw LLM response in details if it differs from the display msg
  const rawHtml = e.rawMsg && e.rawMsg !== e.msg
    ? `<details class="ev-raw-details"><summary class="ev-raw-summary">Raw AI response</summary><div class="ev-raw-body">${esc(e.rawMsg)}</div></details>`
    : '';

  // Display message: truncated by default, click to expand.
  // Expansion state stored in expandedEvents Set so it survives re-renders.
  const fullMsg  = e.msg || '';
  const evId     = String(e.ts || '') + '|' + (e.type || '') + '|' + (agentId || '');
  const EV_LIMIT = 150;
  const _evIsExp = expandedEvents.has(evId);

  function _evMsgHtml(expanded) {
    // Strip any leading emoji/icon already embedded in the message to avoid double icons
    const strippedMsg = fullMsg.replace(/^[\u{1F300}-\u{1FFFF}\u2600-\u27FF][\uFE0F\u20E3]?\s*/u, '');
    const displayMsg  = evIcon ? evIcon + strippedMsg : fullMsg;
    if (displayMsg.length <= EV_LIMIT || expanded) return esc(displayMsg);
    return `${esc(displayMsg.slice(0, EV_LIMIT))}<span class="ev-trunc-hint"> …</span>`;
  }

  div.dataset.evExpandId = evId;
  div.innerHTML = `
    <div class="ev-entry-top">
      <span class="ev-tick">${time}</span>
      <span class="ev-dot"></span>
      ${novelBadge}
      <span class="ev-msg">${_evMsgHtml(_evIsExp)}</span>
      <span class="ev-chevron">${isDlg ? '💬' : '▾'}</span>
    </div>
    <div class="ev-details">
      ${catLabel ? `<div><strong>Category:</strong> ${esc(catLabel)}</div>` : ''}
      ${tsLabel  ? `<div><strong>Time:</strong> ${tsLabel}</div>` : ''}
      ${intentHtml}
      ${rawHtml}
      ${isDlg    ? `<div class="ev-dlg-hint">Click to open in Chats</div>` : ''}
      ${agentId && !isDlg ? `<button class="ev-locate-btn" data-locate="${esc(agentId)}">⊕ Locate on Starmap</button>` : ''}
    </div>`;
  div.addEventListener('click', ev => {
    if (ev.target.classList.contains('ev-locate-btn')) {
      const id = ev.target.dataset.locate;
      if (id && starmapInstance) starmapInstance.locateAgent(id);
      ev.stopPropagation();
      return;
    }
    // Dialogue events: click opens Chats tab and the relevant thread
    if (e.type === 'dialogue') {
      const parsed = _parseDialogueMsg(e.msg);
      if (parsed) {
        const pairKey = [parsed.from, parsed.to].sort().join('|');
        _convoOpenThread = pairKey;
        const chatsBtn = document.querySelector('.rpanel-tab[data-rtab="chats"]');
        if (chatsBtn && !chatsBtn.classList.contains('active')) chatsBtn.click();
        else if (lastState) renderConversations(lastState.eventLog);
        return;
      }
    }
    // Toggle text expansion — update Set so state survives re-renders
    if (fullMsg.length > EV_LIMIT) {
      const nowExp = !expandedEvents.has(evId);
      if (nowExp) expandedEvents.add(evId); else expandedEvents.delete(evId);
      const msgEl = div.querySelector('.ev-msg');
      if (msgEl) msgEl.innerHTML = _evMsgHtml(nowExp);
    }
    div.classList.toggle('ev-expanded');
  });
  return div;
}

function renderEventLog(events, categories, force) {
  // Focus-mode dialogue sub-tab → per-agent chat view
  if (focusAgentId && focusModeTab === 'dialogue') {
    eventLog.classList.add('ev-dialogue-mode');
    renderFocusDialogue(events, focusAgentId);
    return;
  }
  // Global dialogue filter → messenger chat view (no raw event list)
  if (!focusAgentId && activeLogFilter === 'dialogue') {
    renderGlobalDialogueView(events);
    return;
  }
  eventLog.classList.remove('ev-dialogue-mode');

  const catMap = {};
  for (const c of categories) catMap[c.type] = c;

  // Compute filter state key — if it changes, force full rebuild
  const myIds = new Set(Object.keys(SocioLLM.loadMyAgents()));
  const filterKey = focusAgentId + '|' + focusModeTab + '|' + focusCatFilter + '|' + activeLogFilter + '|' + myAgentFilterActive + '|' + eventTextSearch + '|' + focusTextSearch + '|' + _evTimeFilter + '|' + _evTimeFrom + '|' + _evTimeTo;
  const filterChanged = filterKey !== _evFilterKey;
  if (filterChanged) {
    _evFilterKey = filterKey;
    force = true;
    // Reset infinite scroll — new filter means start fresh from the top of history
    _evInfiniteLoading   = false;
    _evInfiniteExhausted = false;
    if (_evInfiniteSentinel?.parentNode) { _evInfiniteSentinel.remove(); _evInfiniteSentinel = null; }
    // Remove any "beginning of history" markers from previous filter
    eventLog.querySelectorAll('.ev-history-end').forEach(el => el.remove());
  }

  // Apply filters
  let filtered = events;
  // Dialogue events live in the Chats tab only — never shown in the Events feed
  filtered = filtered.filter(e => e.type !== 'dialogue');
  if (focusAgentId) {
    // Focus mode: agent-specific events only
    filtered = filtered.filter(e => e.agentId === focusAgentId || e.partnerAgentId === focusAgentId);
    // Category filter within focus mode — bypassed when focus text search is active
    if (focusCatFilter && !focusTextSearch) {
      filtered = filtered.filter(e => e.type === focusCatFilter);
    }
    // Focus text search — searches all of this agent's events regardless of category
    if (focusTextSearch) {
      filtered = filtered.filter(e => (e.msg || '').toLowerCase().includes(focusTextSearch));
    }
  } else {
    // My Agent filter (top-level — stacks with category)
    if (myAgentFilterActive && myIds.size > 0) {
      filtered = filtered.filter(e => e.agentId && myIds.has(e.agentId));
    }
    // Category filter — bypassed when text search is active (search all categories)
    if (activeLogFilter && !eventTextSearch) filtered = filtered.filter(e => e.type === activeLogFilter);
    // Global text search
    if (eventTextSearch) {
      filtered = filtered.filter(e => (e.msg || '').toLowerCase().includes(eventTextSearch));
    }
  }

  // Time range filter
  if (_evTimeFilter !== 'all') {
    const { lo, hi } = _evTimeBounds();
    filtered = filtered.filter(e => { const ts = e.ts || 0; return ts >= lo && ts <= hi; });
  }

  // Newest first
  const ordered = filtered.slice().reverse();

  // Update event count label
  const _countEl = document.getElementById('ev-count-label');
  if (_countEl) _countEl.textContent = ordered.length ? `${ordered.length} events` : '';

  if (force) {
    // Full rebuild — clear and re-insert all
    eventLog.innerHTML = '';
    _renderedEvKeys.clear();
    if (ordered.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:12px 6px;font-size:11px;color:var(--text3)';
      empty.textContent = 'No events match this filter.';
      eventLog.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of ordered) {
      const key = String(e.ts || '') + '_' + (e.type || '');
      frag.appendChild(_buildEventNode(e, catMap));
      _renderedEvKeys.add(key);
    }
    eventLog.appendChild(frag);
    lastEventCount = ordered.length;
    _lastRenderedTopKey = ordered.length > 0 ? (String(ordered[0].ts || '') + '_' + (ordered[0].type || '')) : '';
    return;
  }

  // Use top-event key + count as change signal — count-only check misses the case
  // where the server window is full (new event added, old event removed = same count)
  const topKey = ordered.length > 0 ? (String(ordered[0].ts || '') + '_' + (ordered[0].type || '')) : '';
  if (topKey === _lastRenderedTopKey && ordered.length === lastEventCount) return;
  _lastRenderedTopKey = topKey;
  lastEventCount = ordered.length;

  // Snapshot scroll state before any DOM mutation.
  // "At top" = user is reading the live feed (auto-scroll allowed).
  // Any scroll > 100px means user is reading history — DO NOT auto-scroll.
  const scrollBefore = eventLog.scrollTop;
  const wasAtTop     = scrollBefore <= 100;

  // Show/hide "Latest" jump button based on scroll depth
  const _latestBtn = document.getElementById('btn-ev-latest');
  if (_latestBtn) _latestBtn.style.display = scrollBefore > 100 ? '' : 'none';

  // ── Remove events that scrolled off the server-side window ──
  // These are the OLDEST in-memory events at the bottom of the in-memory section.
  // They may be above the user's viewport if they scrolled into history, so compensate.
  const newKeys = new Set(ordered.map(e => String(e.ts || '') + '_' + (e.type || '')));
  const heightBeforeRemove = eventLog.scrollHeight;
  eventLog.querySelectorAll('[data-ev-key]').forEach(el => {
    if (!newKeys.has(el.dataset.evKey)) { el.remove(); _renderedEvKeys.delete(el.dataset.evKey); }
  });
  if (!wasAtTop) {
    // If content above the viewport was removed, pull scroll up by the same amount
    const removedHeight = heightBeforeRemove - eventLog.scrollHeight;
    if (removedHeight > 0) eventLog.scrollTop = Math.max(0, eventLog.scrollTop - removedHeight);
  }

  // ── Prepend new events at the top (newest first) ──
  const frag = document.createDocumentFragment();
  let added = 0;
  for (const e of ordered) {
    const key = String(e.ts || '') + '_' + (e.type || '');
    if (!_renderedEvKeys.has(key)) {
      const node = _buildEventNode(e, catMap);
      node.classList.add('ev-new-fadein');
      node.addEventListener('animationend', () => node.classList.remove('ev-new-fadein'), { once: true });
      frag.appendChild(node);
      _renderedEvKeys.add(key);
      added++;
    }
  }
  if (added > 0) {
    const heightBeforeAdd = eventLog.scrollHeight;
    eventLog.insertBefore(frag, eventLog.firstChild);
    if (wasAtTop) {
      // User is at the live feed — snap to top so they see the new event
      eventLog.scrollTop = 0;
    } else {
      // User is reading history — push their position down by the added height
      // so the same content stays on screen (no jump)
      eventLog.scrollTop = eventLog.scrollTop + (eventLog.scrollHeight - heightBeforeAdd);
    }
  }

  // Handle empty state
  if (_renderedEvKeys.size === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:12px 6px;font-size:11px;color:var(--text3)';
    empty.textContent = 'No events match this filter.';
    eventLog.appendChild(empty);
  }
}

// ─── INFINITE SCROLL — load older events from disk ───────────────────────────

async function _loadOlderEvents() {
  // Skip when already loading, exhausted, or in special rendering modes
  if (_evInfiniteLoading || _evInfiniteExhausted) return;
  if (focusAgentId && focusModeTab === 'dialogue') return;
  if (!focusAgentId && activeLogFilter === 'dialogue') return;

  _evInfiniteLoading = true;

  // Find the oldest timestamp currently in the DOM
  const tsList = [...eventLog.querySelectorAll('[data-ev-ts]')]
    .map(el => Number(el.dataset.evTs))
    .filter(ts => ts > 0);
  const oldestTs = tsList.length ? Math.min(...tsList) : null;

  if (!oldestTs) {
    _evInfiniteLoading = false;
    _evInfiniteExhausted = true;
    return;
  }

  // Show loading sentinel at the bottom
  _evInfiniteSentinel = document.createElement('div');
  _evInfiniteSentinel.className = 'ev-load-sentinel';
  _evInfiniteSentinel.textContent = '↓ Loading older events…';
  eventLog.appendChild(_evInfiniteSentinel);

  try {
    // Build query
    let url = `/api/history/events?before=${oldestTs}&limit=50`;
    if (focusAgentId && lastState) {
      const ag = lastState.agents?.find(a => a.id === focusAgentId);
      if (ag) url += `&agent=${encodeURIComponent(ag.name)}`;
    }

    const res  = await fetch(url);
    const data = await res.json();

    // Remove sentinel
    if (_evInfiniteSentinel?.parentNode) { _evInfiniteSentinel.remove(); _evInfiniteSentinel = null; }

    const raw = data.events || [];

    // Apply active client-side filters to the fetched batch
    const catMap = {};
    if (lastState?.categories) for (const c of lastState.categories) catMap[c.type] = c;

    let filtered = raw;

    // Apply time filter — also detect if entire batch is before the lower bound
    if (_evTimeFilter !== 'all') {
      const { lo, hi } = _evTimeBounds();
      // If every event in this batch is older than lo, nothing more to show in range
      if (raw.length > 0 && raw.every(e => (e.ts || 0) < lo)) {
        _evInfiniteExhausted = true;
        if (_evInfiniteSentinel?.parentNode) { _evInfiniteSentinel.remove(); _evInfiniteSentinel = null; }
        const endMark = document.createElement('div');
        endMark.className = 'ev-history-end';
        endMark.textContent = '— No older events in this time range —';
        eventLog.appendChild(endMark);
        _evInfiniteLoading = false;
        return;
      }
      filtered = filtered.filter(e => { const ts = e.ts || 0; return ts >= lo && ts <= hi; });
    }

    if (focusAgentId) {
      filtered = filtered.filter(e => e.agentId === focusAgentId || e.partnerAgentId === focusAgentId);
      if (focusCatFilter && !focusTextSearch) filtered = filtered.filter(e => e.type === focusCatFilter);
      if (focusTextSearch) filtered = filtered.filter(e => (e.msg || '').toLowerCase().includes(focusTextSearch));
    } else {
      if (myAgentFilterActive) {
        const myIds = new Set(Object.keys(SocioLLM.loadMyAgents()));
        if (myIds.size > 0) filtered = filtered.filter(e => e.agentId && myIds.has(e.agentId));
      }
      if (activeLogFilter && !eventTextSearch) filtered = filtered.filter(e => e.type === activeLogFilter);
      if (eventTextSearch) filtered = filtered.filter(e => (e.msg || '').toLowerCase().includes(eventTextSearch));
    }

    // Append to bottom — API returns newest-first so first appended is closest to
    // existing content, last appended is oldest (bottom of list). No scroll jump
    // because we're appending below the current viewport.
    const frag = document.createDocumentFragment();
    let added = 0;
    for (const e of filtered) {
      const key = String(e.ts || '') + '_' + (e.type || '');
      if (_renderedEvKeys.has(key)) continue;
      frag.appendChild(_buildEventNode(e, catMap));
      _renderedEvKeys.add(key);
      added++;
    }
    if (added > 0) eventLog.appendChild(frag);

    if (!data.hasMore) {
      _evInfiniteExhausted = true;
      const endMark = document.createElement('div');
      endMark.className = 'ev-history-end';
      endMark.textContent = '— Beginning of history —';
      eventLog.appendChild(endMark);
    }
  } catch (err) {
    console.error('[loadOlderEvents]', err);
    if (_evInfiniteSentinel?.parentNode) { _evInfiniteSentinel.remove(); _evInfiniteSentinel = null; }
    _evInfiniteExhausted = true; // don't retry on error
  }

  _evInfiniteLoading = false;
}

// Scroll listener — show/hide Latest button, trigger infinite scroll
eventLog.addEventListener('scroll', () => {
  const scrolledDown = eventLog.scrollTop > 100;
  const latestBtn = document.getElementById('btn-ev-latest');
  if (latestBtn) latestBtn.style.display = scrolledDown ? '' : 'none';

  if (_evInfiniteLoading || _evInfiniteExhausted) return;
  const near = eventLog.scrollTop + eventLog.clientHeight >= eventLog.scrollHeight - 220;
  if (near) _loadOlderEvents();
});

// ⏭ Latest — snap to newest events at the top
function _jumpToLatest() {
  eventLog.scrollTop = 0;
  const latestBtn = document.getElementById('btn-ev-latest');
  if (latestBtn) latestBtn.style.display = 'none';
}

// ⏮ First Event — keep loading pages until exhausted, then scroll to bottom
async function _jumpToFirstEvent() {
  const btn = document.getElementById('btn-ev-first');
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  const MAX_PAGES = 40; // 40 × 50 = up to 2 000 events
  for (let i = 0; i < MAX_PAGES && !_evInfiniteExhausted; i++) {
    await _loadOlderEvents();
    // yield to keep UI responsive between pages
    await new Promise(r => setTimeout(r, 20));
  }
  // Scroll to the very bottom so user sees the oldest events
  eventLog.scrollTop = eventLog.scrollHeight;

  if (btn) { btn.textContent = '⏮ First'; btn.disabled = false; }
}

// Wire nav buttons (safe to call before DOM is ready since IDs are resolved at call time)
document.getElementById('btn-ev-first').addEventListener('click', _jumpToFirstEvent);
document.getElementById('btn-ev-latest').addEventListener('click', _jumpToLatest);

// ── Wire time filter controls ──
(function () {
  const sel         = document.getElementById('ev-time-select');
  const customRange = document.getElementById('ev-custom-range');
  const fromInput   = document.getElementById('ev-time-from');
  const toInput     = document.getElementById('ev-time-to');
  const applyBtn    = document.getElementById('ev-custom-apply');

  sel.addEventListener('change', () => {
    _evTimeFilter = sel.value;
    customRange.style.display = sel.value === 'custom' ? 'flex' : 'none';
    if (sel.value !== 'custom') {
      _evTimeFrom = null;
      _evTimeTo   = null;
      if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
    }
  });

  applyBtn.addEventListener('click', () => {
    _evTimeFrom = fromInput.value ? new Date(fromInput.value.replace(' ', 'T')).getTime() : null;
    _evTimeTo   = toInput.value   ? new Date(toInput.value.replace(' ', 'T')).getTime()   : null;
    if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
  });
})();

// ─── GLOBAL DIALOGUE FILTER VIEW ─────────────────────────────────────────────
// Renders messenger-style contact list + thread into #event-log when
// the "Dialogue" category filter is active (no agent focused).

function renderGlobalDialogueView(events) {
  eventLog.classList.add('ev-dialogue-mode');

  const myAgentIds    = new Set(Object.keys(SocioLLM.loadMyAgents()));
  const myNames       = new Set(
    (lastState?.agents || []).filter(a => myAgentIds.has(a.id)).map(a => a.name)
  );
  const agentSystems  = {};
  const agentColorMap = {};
  for (const a of (lastState?.agents || [])) {
    agentSystems[a.name]  = a.aiSystem;
    agentColorMap[a.name] = _agentColor(a);
  }

  // Build threads from all dialogue events
  const threads = new Map();
  for (const e of (events || [])) {
    if (e.type !== 'dialogue') continue;
    const parsed = _parseDialogueMsg(e.msg);
    if (!parsed) continue;
    const { from, to, text } = parsed;
    const pairKey = [from, to].sort().join('|');
    if (!threads.has(pairKey)) threads.set(pairKey, { pairKey, partners: [from, to].sort(), messages: [] });
    threads.get(pairKey).messages.push({ from, to, text, ts: e.ts, agentId: e.agentId });
  }
  // Sort messages within threads chronologically
  for (const t of threads.values()) t.messages.sort((a, b) => a.ts - b.ts);

  // Apply "My Agent" filter when active
  let visibleThreads = threads;
  if (myAgentFilterActive && myNames.size > 0) {
    visibleThreads = new Map([...threads].filter(([, t]) => t.partners.some(p => myNames.has(p))));
  }

  if (_evLogDlgThread && visibleThreads.has(_evLogDlgThread)) {
    _renderEvLogDlgThread(visibleThreads.get(_evLogDlgThread), myNames, agentSystems, agentColorMap);
  } else {
    _evLogDlgThread = null;
    _renderEvLogDlgList(visibleThreads, myNames, agentSystems, agentColorMap);
  }
}

function _renderEvLogDlgList(threads, myNames, agentSystems, agentColorMap) {
  if (threads.size === 0) {
    eventLog.innerHTML = '<div class="fdlg-empty">No dialogues yet — agents will talk as the simulation runs.</div>';
    return;
  }

  const sorted = [...threads.values()].sort((a, b) =>
    (b.messages.at(-1)?.ts || 0) - (a.messages.at(-1)?.ts || 0)
  );

  let html = `<div class="convo-section-label">${sorted.length} Conversation${sorted.length !== 1 ? 's' : ''}</div>`;
  for (const thread of sorted) {
    const lastMsg  = thread.messages.at(-1);
    const [nameA, nameB] = thread.partners;
    const colorA   = agentColorMap[nameA] || '#888';
    const colorB   = agentColorMap[nameB] || '#888';
    const sysA     = esc(agentSystems[nameA] || '');
    const sysB     = esc(agentSystems[nameB] || '');
    const badgeA   = sysA ? `<span class="ai-chip ${sysA}">${sysA}</span>` : '';
    const badgeB   = sysB ? `<span class="ai-chip ${sysB}">${sysB}</span>` : '';
    const initA    = esc((nameA || '?')[0].toUpperCase());
    const initB    = esc((nameB || '?')[0].toUpperCase());
    const myClass  = thread.partners.some(p => myNames.has(p)) ? ' convo-my-thread' : '';
    const preview  = lastMsg ? `${esc(lastMsg.from)}: ${esc(lastMsg.text.slice(0, 60))}` : '';
    html += `
      <div class="convo-contact${myClass}" data-pair-key="${esc(thread.pairKey)}">
        <div class="convo-avatars">
          <div class="convo-avatar" style="background:${esc(colorA)}">${initA}</div>
          <div class="convo-avatar convo-avatar-b" style="background:${esc(colorB)}">${initB}</div>
        </div>
        <div class="convo-contact-body">
          <div class="convo-contact-name">
            <span style="color:${esc(colorA)}">${esc(nameA)}</span>${badgeA}
            <span class="convo-sep">↔</span>
            <span style="color:${esc(colorB)}">${esc(nameB)}</span>${badgeB}
          </div>
          <div class="convo-contact-preview">${preview}</div>
        </div>
        <div class="convo-contact-right">
          <span class="convo-contact-count">${thread.messages.length}</span>
          ${lastMsg ? `<span class="convo-contact-time">${fmtTime(lastMsg.ts)}</span>` : ''}
        </div>
      </div>`;
  }

  eventLog.innerHTML = html;
  eventLog.querySelectorAll('.convo-contact').forEach(el => {
    el.addEventListener('click', () => {
      _evLogDlgThread = el.dataset.pairKey;
      if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
    });
  });
}

function _renderEvLogDlgThread(thread, myNames, agentSystems, agentColorMap) {
  // My agent → right; otherwise partners[0]=left, partners[1]=right
  const hasMyAgent = thread.partners.some(p => myNames.has(p));
  const nameRight  = hasMyAgent
    ? (thread.partners.find(p => myNames.has(p))  || thread.partners[1])
    : (thread.partners[1] || thread.partners[0]);
  const nameLeft   = thread.partners.find(p => p !== nameRight) || thread.partners[0];

  const colorLeft   = (agentColorMap || {})[nameLeft]  || '#888';
  const colorRight  = (agentColorMap || {})[nameRight] || '#888';
  const sysLeft     = esc(agentSystems[nameLeft]  || '');
  const sysRight    = esc(agentSystems[nameRight] || '');
  const badgeLeft   = sysLeft  ? `<span class="ai-chip ${sysLeft}">${sysLeft}</span>`   : '';
  const badgeRight  = sysRight ? `<span class="ai-chip ${sysRight}">${sysRight}</span>` : '';

  const singleUnanswered = thread.messages.length === 1;
  let bubblesHtml = '';
  for (let i = 0; i < thread.messages.length; i++) {
    const m      = thread.messages[i];
    const isRight = (m.from === nameRight);
    const side   = isRight ? 'bubble-mine' : 'bubble-theirs';
    const color  = isRight ? colorRight : colorLeft;
    const cs     = `--bubble-bg:color-mix(in srgb,${color} 15%,transparent);--bubble-border:color-mix(in srgb,${color} 40%,transparent);--speaker-color:${color}`;
    const isLast = i === thread.messages.length - 1;
    const noResp = (isLast && singleUnanswered) ? '<div class="chat-no-response">no response</div>' : '';
    const bId    = String(m.ts || '') + '|' + (m.from || '');
    const bLong  = (m.text || '').length > CB_LIMIT;
    const bExp   = bLong && expandedBubbles.has(bId);
    const bStyle = bExp ? ' style="max-height:none;overflow:visible;"' : '';
    const bHtml  = bExp ? chatBubbleHtmlExpanded(m.text) : chatBubbleHtml(m.text);
    bubblesHtml += `
      <div class="chat-row ${side}" style="${cs}">
        <div class="chat-meta-row">
          <span class="chat-speaker">${esc(m.from)}</span>
          <span class="chat-ts">${fmtTime(m.ts)}</span>
        </div>
        <div class="chat-bubble${bLong ? ' has-more' : ''}${bExp ? ' cb-expanded' : ''}" data-bubble-id="${esc(bId)}" data-text="${esc(m.text)}"${bStyle}>${bHtml}</div>
        ${noResp}
      </div>`;
  }

  // Preserve scroll position before rebuilding
  const existing = eventLog.querySelector('#evlog-dlg-scroll');
  let savedScroll = null;
  if (existing) {
    const { scrollTop, clientHeight, scrollHeight } = existing;
    if (scrollTop + clientHeight < scrollHeight - 50) savedScroll = scrollTop;
  }

  eventLog.innerHTML = `
    <div class="fdlg-topbar">
      <button class="fdlg-back-btn">&#8592; Back</button>
      <div class="fdlg-title">
        <span style="color:${colorLeft}">${esc(nameLeft)}</span>${badgeLeft}
        <span class="convo-thread-sep">↔</span>
        <span style="color:${colorRight}">${esc(nameRight)}</span>${badgeRight}
      </div>
      <span class="fdlg-count">${thread.messages.length} msg${thread.messages.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="fdlg-thread-wrap">
      <div class="fdlg-thread" id="evlog-dlg-scroll">
        ${bubblesHtml || '<div class="fdlg-empty">No messages yet.</div>'}
      </div>
      <button class="jump-latest-btn" style="display:none">&#8595; Latest</button>
    </div>`;

  eventLog.querySelector('.fdlg-back-btn').addEventListener('click', () => {
    _evLogDlgThread = null;
    if (lastState) renderEventLog(lastState.eventLog, lastState.categories || [], true);
  });

  const scroller = eventLog.querySelector('#evlog-dlg-scroll');
  const jumpBtn  = eventLog.querySelector('.jump-latest-btn');
  if (scroller) {
    if (savedScroll !== null) {
      scroller.scrollTop = savedScroll;
      if (jumpBtn) jumpBtn.style.display = '';
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    scroller.addEventListener('scroll', () => {
      if (!jumpBtn) return;
      const { scrollTop, clientHeight, scrollHeight } = scroller;
      jumpBtn.style.display = (scrollTop + clientHeight < scrollHeight - 50) ? '' : 'none';
    }, { passive: true });
  }
  if (jumpBtn) jumpBtn.addEventListener('click', () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    jumpBtn.style.display = 'none';
  });
}

// ─── FOCUS DIALOGUE TAB ───────────────────────────────────────────────────────

// Compute a consistent color for an agent (uses visualForm.primaryColor if available)
function _agentColor(agent) {
  if (!agent) return '#888';
  if (agent.visualForm?.primaryColor) return agent.visualForm.primaryColor;
  const s = agent.id || agent.name || '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 65%, 58%)`;
}

function renderFocusDialogue(events, agentId) {
  if (!eventLog) return;

  // Build a fast id→agent lookup from current state
  const agentMap = {};
  for (const a of (lastState?.agents || [])) agentMap[a.id] = a;
  const focusAgent = agentMap[agentId];

  // Collect all dialogue events involving this agent
  const dlgEvents = (events || []).filter(e =>
    e.type === 'dialogue' &&
    (e.agentId === agentId || e.partnerAgentId === agentId)
  );

  // Group into per-partner threads by partnerId
  const threads = new Map(); // partnerId → { partnerId, partnerName, messages[] }
  for (const e of dlgEvents) {
    const parsed = _parseDialogueMsg(e.msg);
    if (!parsed) continue;

    let partnerId = e.agentId === agentId ? e.partnerAgentId : e.agentId;
    // Fall back: resolve partner by name if no id (legacy events)
    if (!partnerId) {
      const partnerName = e.agentId === agentId ? parsed.to : parsed.from;
      const pa = Object.values(agentMap).find(a => a.name === partnerName);
      if (!pa) continue;
      partnerId = pa.id;
    }

    const partnerAgent = agentMap[partnerId];
    const partnerName  = partnerAgent?.name
      || (e.agentId === agentId ? parsed.to : parsed.from);

    if (!threads.has(partnerId)) {
      threads.set(partnerId, { partnerId, partnerName, messages: [] });
    }
    threads.get(partnerId).messages.push({
      fromId: e.agentId,
      from:   parsed.from,
      to:     parsed.to,
      text:   parsed.text,
      ts:     e.ts,
    });
  }

  // Sort messages within each thread chronologically
  for (const t of threads.values()) t.messages.sort((a, b) => a.ts - b.ts);

  if (_focusDlgOpenThread && threads.has(_focusDlgOpenThread)) {
    _renderFocusDlgThread(threads.get(_focusDlgOpenThread), agentId, agentMap);
  } else {
    _focusDlgOpenThread = null;
    _renderFocusDlgList(threads, agentId, agentMap);
  }
}

function _renderFocusDlgList(threads, agentId, agentMap) {
  if (threads.size === 0) {
    eventLog.innerHTML = '<div class="fdlg-empty">No direct dialogues yet.</div>';
    return;
  }

  const sorted = [...threads.values()].sort((a, b) => {
    return (b.messages.at(-1)?.ts || 0) - (a.messages.at(-1)?.ts || 0);
  });

  let html = '<div class="fdlg-list">';
  for (const thread of sorted) {
    const partner  = agentMap[thread.partnerId];
    const color    = _agentColor(partner);
    const lastMsg  = thread.messages.at(-1);
    const initial  = (thread.partnerName || '?')[0].toUpperCase();
    const aiChip   = partner?.aiSystem
      ? `<span class="ai-chip ${esc(partner.aiSystem)}">${esc(partner.aiSystem)}</span>` : '';
    html += `
      <div class="fdlg-contact" data-partner-id="${esc(thread.partnerId)}">
        <div class="fdlg-avatar" style="background:${esc(color)}">${esc(initial)}</div>
        <div class="fdlg-contact-body">
          <div class="fdlg-contact-name">${esc(thread.partnerName)} ${aiChip}</div>
          <div class="fdlg-contact-preview">${lastMsg ? esc(lastMsg.text.slice(0, 70)) : ''}</div>
        </div>
        <div class="fdlg-contact-right">
          <span class="fdlg-msg-count">${thread.messages.length}</span>
          ${lastMsg ? `<span class="fdlg-time">${fmtTime(lastMsg.ts)}</span>` : ''}
        </div>
      </div>`;
  }
  html += '</div>';
  eventLog.innerHTML = html;

  eventLog.querySelectorAll('.fdlg-contact').forEach(el => {
    el.addEventListener('click', () => {
      _focusDlgOpenThread = el.dataset.partnerId;
      if (lastState) renderFocusDialogue(lastState.eventLog, focusAgentId);
    });
  });
}

function _renderFocusDlgThread(thread, agentId, agentMap) {
  const partner      = agentMap[thread.partnerId];
  const partnerColor = _agentColor(partner);
  const focusColor   = _agentColor(agentMap[agentId]);
  const aiChip       = partner?.aiSystem
    ? `<span class="ai-chip ${esc(partner.aiSystem)}">${esc(partner.aiSystem)}</span>` : '';

  let bubblesHtml = '';
  for (const m of thread.messages) {
    const isMine    = m.fromId === agentId;
    const side      = isMine ? 'fdlg-bubble-mine' : 'fdlg-bubble-theirs';
    const c = isMine ? focusColor : partnerColor;
    const colorAttr = `style="--bubble-color:color-mix(in srgb,${c} 15%,transparent);--bubble-border:color-mix(in srgb,${c} 40%,transparent)"`;
    const fbId    = String(m.ts || '') + '|' + (m.from || '');
    const fbLong  = (m.text || '').length > CB_LIMIT;
    const fbExp   = fbLong && expandedBubbles.has(fbId);
    const fbStyle = fbExp ? ' style="max-height:none;overflow:visible;"' : '';
    const fbHtml  = fbExp ? chatBubbleHtmlExpanded(m.text) : chatBubbleHtml(m.text);
    bubblesHtml += `
      <div class="fdlg-chat-row ${side}">
        <div class="fdlg-meta-row">
          <span class="fdlg-speaker" style="color:${isMine ? focusColor : partnerColor}">${esc(m.from)}</span>
          <span class="fdlg-ts">${fmtTime(m.ts)}</span>
        </div>
        <div class="fdlg-bubble${fbLong ? ' has-more' : ''}${fbExp ? ' cb-expanded' : ''}" data-bubble-id="${esc(fbId)}" data-text="${esc(m.text)}" ${colorAttr}${fbStyle}>${fbHtml}</div>
      </div>`;
  }

  // Preserve scroll position: read BEFORE rebuilding innerHTML
  const _existingFdlgScroll = eventLog.querySelector('#fdlg-thread-scroll');
  let _savedFdlgScrollTop = null; // null = auto-scroll to bottom
  if (_existingFdlgScroll) {
    const { scrollTop, clientHeight, scrollHeight } = _existingFdlgScroll;
    if (scrollTop + clientHeight < scrollHeight - 50) _savedFdlgScrollTop = scrollTop;
  }

  eventLog.innerHTML = `
    <div class="fdlg-topbar">
      <button class="fdlg-back-btn">&#8592; Back</button>
      <div class="fdlg-title"><span style="color:${partnerColor}">${esc(thread.partnerName)}</span>${aiChip}</div>
      <span class="fdlg-count">${thread.messages.length} msg${thread.messages.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="fdlg-thread-wrap">
      <div class="fdlg-thread" id="fdlg-thread-scroll">
        ${bubblesHtml || '<div class="fdlg-empty">No messages yet.</div>'}
      </div>
      <button class="jump-latest-btn" style="display:none">&#8595; Latest</button>
    </div>`;

  eventLog.querySelector('.fdlg-back-btn').addEventListener('click', () => {
    _focusDlgOpenThread = null;
    if (lastState) renderFocusDialogue(lastState.eventLog, focusAgentId);
  });

  const scroller = eventLog.querySelector('#fdlg-thread-scroll');
  const jumpBtn  = eventLog.querySelector('.jump-latest-btn');
  if (scroller) {
    if (_savedFdlgScrollTop !== null) {
      scroller.scrollTop = _savedFdlgScrollTop;
      if (jumpBtn) jumpBtn.style.display = '';
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    scroller.addEventListener('scroll', () => {
      if (!jumpBtn) return;
      const { scrollTop, clientHeight, scrollHeight } = scroller;
      jumpBtn.style.display = (scrollTop + clientHeight < scrollHeight - 50) ? '' : 'none';
    }, { passive: true });
  }
  if (jumpBtn) jumpBtn.addEventListener('click', () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    jumpBtn.style.display = 'none';
  });
}

// ─── CONVERSATIONS TAB ────────────────────────────────────────────────────────

// Parse dialogue event msg: "AgentA [System] → AgentB [System]: "text""
function _parseDialogueMsg(msg) {
  const m = msg.match(/^(.+?)\s*\[.+?\]\s*→\s*(.+?)\s*\[.+?\]:\s*"([\s\S]+)"$/);
  if (!m) return null;
  return { from: m[1].trim(), to: m[2].trim(), text: m[3].trim() };
}

// Update the Chats tab pill count from state — called on every render tick
// so the count stays current even when the Chats tab is not active.
function _updateChatsPill(state) {
  if (!convoPill) return;
  const serverConvos = state?.conversations;
  let count = 0;
  if (serverConvos && serverConvos.length > 0) {
    const agentById = {};
    for (const a of (state.agents || [])) agentById[a.id] = a;
    const pairs = new Set();
    for (const conv of serverConvos) {
      for (const m of (conv.messages || [])) {
        const from = agentById[m.senderId];
        const to   = agentById[m.recipientId];
        if (from && to) pairs.add([from.name, to.name].sort().join('|'));
      }
    }
    count = pairs.size;
  } else {
    const pairs = new Set();
    for (const e of (state?.eventLog || [])) {
      if (e.type === 'dialogue') {
        const parsed = _parseDialogueMsg(e.msg);
        if (parsed) pairs.add([parsed.from, parsed.to].sort().join('|'));
      }
    }
    count = pairs.size;
  }
  convoPill.textContent = count;
  convoPill.style.display = count > 0 ? '' : 'none';
}

// Which thread is currently open (null = list view, string = pairKey)
let _convoOpenThread = null;

function renderConversations(allEvents) {
  if (!conversationsList) return;

  // Agent lookups
  const myAgentIds   = new Set(Object.keys(SocioLLM.loadMyAgents()));
  const myNames      = new Set(
    (lastState?.agents || []).filter(a => myAgentIds.has(a.id)).map(a => a.name)
  );
  const agentSystems  = {};
  const agentColorMap = {};
  const agentById     = {};
  for (const a of (lastState?.agents || [])) {
    agentSystems[a.name]  = a.aiSystem;
    agentColorMap[a.name] = _agentColor(a);
    agentById[a.id]       = a;
  }

  const threads    = new Map(); // pairKey (name-based) → { pairKey, partners[], messages[] }

  // ── Full conversation history from server (not limited to last 40 events) ──
  const serverConvos = lastState?.conversations;
  if (serverConvos && serverConvos.length > 0) {
    for (const conv of serverConvos) {
      for (const m of (conv.messages || [])) {
        const fromAgent = agentById[m.senderId];
        const toAgent   = agentById[m.recipientId];
        if (!fromAgent || !toAgent) continue;
        const from    = fromAgent.name;
        const to      = toAgent.name;
        const pairKey = [from, to].sort().join('|');
        const parsed  = _parseDialogueMsg(m.msg);
        const text    = parsed ? parsed.text : m.msg;
        if (!threads.has(pairKey)) {
          threads.set(pairKey, { pairKey, partners: [from, to].sort(), messages: [] });
        }
        threads.get(pairKey).messages.push({ from, to, text, ts: m.ts });
      }
    }
  } else {
    // Fallback: parse recent event log (last 40 events only)
    for (const e of (allEvents || [])) {
      if (e.type === 'dialogue') {
        const parsed = _parseDialogueMsg(e.msg);
        if (!parsed) continue;
        const { from, to, text } = parsed;
        const pairKey = [from, to].sort().join('|');
        if (!threads.has(pairKey)) {
          threads.set(pairKey, { pairKey, partners: [from, to].sort(), messages: [] });
        }
        threads.get(pairKey).messages.push({ from, to, text, ts: e.ts });
      }
    }
  }

  // Sort messages within each thread chronologically
  for (const t of threads.values()) t.messages.sort((a, b) => a.ts - b.ts);

  // ── Focus agent filtering ──
  let focusName = null;
  if (focusAgentId && lastState) {
    const fa = (lastState.agents || []).find(a => a.id === focusAgentId);
    focusName = fa ? fa.name : null;
  }

  let displayThreads = threads;
  let headerLabel    = null;

  if (focusName) {
    displayThreads = new Map([...threads].filter(([, t]) => t.partners.includes(focusName)));
    headerLabel    = `${focusName}'s Conversations`;
    console.log(`[Chats] Agent "${focusName}" — ${displayThreads.size} conversation(s) found (total threads: ${threads.size}, server convos: ${serverConvos?.length ?? 'none'})`);
  }

  // Badge: unique partners when focused, total threads when global
  if (convoPill) {
    const count = focusName ? displayThreads.size : threads.size;
    convoPill.textContent = count;
    convoPill.style.display = count > 0 ? '' : 'none';
  }

  if (_convoOpenThread) {
    const thread = threads.get(_convoOpenThread);
    console.log('[Chats] Opening thread:', _convoOpenThread, '→', thread ? `${thread.partners.join(' ↔ ')} (${thread.messages.length} msgs)` : 'NOT FOUND');
    _renderConvoThread(thread, myNames, agentSystems, agentColorMap, focusName);
  } else {
    _renderConvoList(displayThreads, myNames, agentSystems, agentColorMap, headerLabel, focusName);
  }
}

function _renderConvoList(threads, myNames, agentSystems, agentColorMap, headerLabel, focusName) {
  if (threads.size === 0) {
    const emptyNote = headerLabel
      ? `<div class="convo-context-header">${esc(headerLabel)}</div><div class="convo-empty">No conversations involving this agent yet.</div>`
      : '<div class="convo-empty">No conversations yet — agents will talk as the simulation runs.</div>';
    conversationsList.innerHTML = emptyNote;
    return;
  }

  const sorted = [...threads.values()].sort((a, b) => {
    const aTs = a.messages.at(-1)?.ts || 0;
    const bTs = b.messages.at(-1)?.ts || 0;
    return bTs - aTs;
  });

  let html = '';

  // ── Context header ──
  if (headerLabel) {
    html += `<div class="convo-context-header">${esc(headerLabel)}</div>`;
  } else if (sorted.length > 0) {
    html += `<div class="convo-context-header">All Conversations — ${sorted.length}</div>`;
  }

  // ── Conversation rows ──
  if (sorted.length > 0) {
    for (const thread of sorted) {
      const lastMsg    = thread.messages.at(-1);
      const isMyThread = thread.partners.some(p => myNames.has(p));
      const myClass    = isMyThread ? ' convo-my-thread' : '';

      if (focusName) {
        // ── Partner-centric row: show the OTHER agent ──
        const partnerName = thread.partners.find(p => p !== focusName) || thread.partners[0];
        const partnerColor = agentColorMap[partnerName] || '#888';
        const partnerSys   = esc(agentSystems[partnerName] || '');
        const partnerBadge = partnerSys ? `<span class="ai-chip ${partnerSys}">${partnerSys}</span>` : '';
        const partnerInit  = esc((partnerName || '?')[0].toUpperCase());
        const previewText  = lastMsg ? `${esc(lastMsg.from)}: ${esc(lastMsg.text.slice(0, 70))}` : '';
        html += `
          <div class="convo-contact convo-contact-focused${myClass}" data-pair-key="${esc(thread.pairKey)}">
            <div class="convo-avatars">
              <div class="convo-avatar" style="background:${esc(partnerColor)}">${partnerInit}</div>
            </div>
            <div class="convo-contact-body">
              <div class="convo-contact-name">
                <span style="color:${esc(partnerColor)}">${esc(partnerName)}</span>${partnerBadge}
              </div>
              <div class="convo-contact-preview">${previewText}</div>
            </div>
            <div class="convo-contact-right">
              <span class="convo-contact-count">${thread.messages.length}</span>
              ${lastMsg ? `<span class="convo-contact-time">${fmtTime(lastMsg.ts)}</span>` : ''}
            </div>
          </div>`;
      } else {
        // ── Both-agent row (global view) ──
        const [nameA, nameB] = thread.partners;
        const colorA    = agentColorMap[nameA] || '#888';
        const colorB    = agentColorMap[nameB] || '#888';
        const sysA      = esc(agentSystems[nameA] || '');
        const sysB      = esc(agentSystems[nameB] || '');
        const badgeA    = sysA ? `<span class="ai-chip ${sysA}">${sysA}</span>` : '';
        const badgeB    = sysB ? `<span class="ai-chip ${sysB}">${sysB}</span>` : '';
        const initA     = esc((nameA || '?')[0].toUpperCase());
        const initB     = esc((nameB || '?')[0].toUpperCase());
        const previewText = lastMsg ? `${esc(lastMsg.from)}: ${esc(lastMsg.text.slice(0, 60))}` : '';
        html += `
          <div class="convo-contact${myClass}" data-pair-key="${esc(thread.pairKey)}">
            <div class="convo-avatars">
              <div class="convo-avatar" style="background:${esc(colorA)}">${initA}</div>
              <div class="convo-avatar convo-avatar-b" style="background:${esc(colorB)}">${initB}</div>
            </div>
            <div class="convo-contact-body">
              <div class="convo-contact-name">
                <span style="color:${esc(colorA)}">${esc(nameA)}</span>${badgeA}
                <span class="convo-sep">↔</span>
                <span style="color:${esc(colorB)}">${esc(nameB)}</span>${badgeB}
              </div>
              <div class="convo-contact-preview">${previewText}</div>
            </div>
            <div class="convo-contact-right">
              <span class="convo-contact-count">${thread.messages.length}</span>
              ${lastMsg ? `<span class="convo-contact-time">${fmtTime(lastMsg.ts)}</span>` : ''}
            </div>
          </div>`;
      }
    }
  }

  conversationsList.innerHTML = html;

  conversationsList.querySelectorAll('.convo-contact').forEach(el => {
    el.addEventListener('click', () => {
      _convoOpenThread = el.dataset.pairKey;
      console.log('[Chats] Contact clicked, pairKey:', JSON.stringify(_convoOpenThread));
      // Highlight the connection on the starmap using name-based pairKey
      // Resolve to agent IDs for the starmap (which uses id-based keys)
      if (starmapInstance && lastState) {
        const pk = el.dataset.pairKey;
        const [nameA, nameB] = pk.split('|');
        const agA = lastState.agents?.find(a => a.name === nameA);
        const agB = lastState.agents?.find(a => a.name === nameB);
        if (agA && agB) starmapInstance.highlightConnection([agA.id, agB.id].sort().join('|'));
      }
      if (lastState) renderConversations(lastState.eventLog);
    });
  });
}

function _renderConvoThread(thread, myNames, agentSystems, agentColorMap, focusName) {
  if (!thread) {
    _convoOpenThread = null;
    if (lastState) renderConversations(lastState.eventLog);
    return;
  }

  // Determine left/right: focused agent → right; else my agent → right; else partners[1] → right
  let nameRight;
  if (focusName && thread.partners.includes(focusName)) {
    nameRight = focusName;
  } else {
    const hasMyAgent = thread.partners.some(p => myNames.has(p));
    nameRight = hasMyAgent
      ? (thread.partners.find(p => myNames.has(p)) || thread.partners[1])
      : thread.partners[1] || thread.partners[0];
  }
  const nameLeft = thread.partners.find(p => p !== nameRight) || thread.partners[0];

  const colors = agentColorMap || {};
  const colorLeft   = colors[nameLeft]  || '#888';
  const colorRight  = colors[nameRight] || '#888';
  const sysLeft     = esc(agentSystems[nameLeft]  || '');
  const sysRight    = esc(agentSystems[nameRight] || '');
  const badgeLeft   = sysLeft  ? `<span class="ai-chip ${sysLeft}">${sysLeft}</span>`   : '';
  const badgeRight  = sysRight ? `<span class="ai-chip ${sysRight}">${sysRight}</span>` : '';

  // Render bubbles oldest → newest
  const singleUnanswered = thread.messages.length === 1;
  let bubblesHtml = '';
  for (let i = 0; i < thread.messages.length; i++) {
    const m      = thread.messages[i];
    const isRight = (m.from === nameRight);
    const side   = isRight ? 'bubble-mine' : 'bubble-theirs';
    const color  = isRight ? colorRight : colorLeft;
    const colorStyle = `--bubble-bg:color-mix(in srgb,${color} 15%,transparent);--bubble-border:color-mix(in srgb,${color} 40%,transparent);--speaker-color:${color}`;
    const isLast   = i === thread.messages.length - 1;
    const noRespHtml = (isLast && singleUnanswered)
      ? '<div class="chat-no-response">no response</div>' : '';
    const bId2   = String(m.ts || '') + '|' + (m.from || '');
    const bLong2 = (m.text || '').length > CB_LIMIT;
    const bExp2  = bLong2 && expandedBubbles.has(bId2);
    const bStyle2 = bExp2 ? ' style="max-height:none;overflow:visible;"' : '';
    const bHtml2  = bExp2 ? chatBubbleHtmlExpanded(m.text) : chatBubbleHtml(m.text);
    bubblesHtml += `
      <div class="chat-row ${side}" style="${colorStyle}">
        <div class="chat-meta-row">
          <span class="chat-speaker">${esc(m.from)}</span>
          <span class="chat-ts">${fmtTime(m.ts)}</span>
        </div>
        <div class="chat-bubble${bLong2 ? ' has-more' : ''}${bExp2 ? ' cb-expanded' : ''}" data-bubble-id="${esc(bId2)}" data-text="${esc(m.text)}"${bStyle2}>${bHtml2}</div>
        ${noRespHtml}
      </div>`;
  }

  // Preserve scroll position: read BEFORE rebuilding innerHTML
  const _existingConvoScroll = conversationsList.querySelector('#chat-thread-scroll');
  let _savedConvoScrollTop = null;
  if (_existingConvoScroll) {
    const { scrollTop, clientHeight, scrollHeight } = _existingConvoScroll;
    if (scrollTop + clientHeight < scrollHeight - 50) _savedConvoScrollTop = scrollTop;
  }

  conversationsList.innerHTML = `
    <div class="convo-thread-topbar">
      <button class="convo-back-btn">&#8592; Back</button>
      <div class="convo-thread-title">
        <span style="color:${colorLeft}">${esc(nameLeft)}</span>${badgeLeft}
        <span class="convo-thread-sep">↔</span>
        <span style="color:${colorRight}">${esc(nameRight)}</span>${badgeRight}
      </div>
      <span class="convo-thread-count">${thread.messages.length} msg${thread.messages.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="chat-thread-wrap">
      <div class="chat-thread" id="chat-thread-scroll">
        ${bubblesHtml || '<div class="convo-empty">No messages yet.</div>'}
      </div>
      <button class="jump-latest-btn" style="display:none">&#8595; Latest</button>
    </div>`;

  conversationsList.querySelector('.convo-back-btn').addEventListener('click', () => {
    _convoOpenThread = null;
    if (lastState) renderConversations(lastState.eventLog);
  });

  const scroller = conversationsList.querySelector('#chat-thread-scroll');
  const jumpBtn  = conversationsList.querySelector('.jump-latest-btn');
  if (scroller) {
    if (_savedConvoScrollTop !== null) {
      scroller.scrollTop = _savedConvoScrollTop;
      if (jumpBtn) jumpBtn.style.display = '';
    } else {
      scroller.scrollTop = scroller.scrollHeight;
    }
    scroller.addEventListener('scroll', () => {
      if (!jumpBtn) return;
      const { scrollTop, clientHeight, scrollHeight } = scroller;
      jumpBtn.style.display = (scrollTop + clientHeight < scrollHeight - 50) ? '' : 'none';
    }, { passive: true });
  }
  if (jumpBtn) jumpBtn.addEventListener('click', () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    jumpBtn.style.display = 'none';
  });
}

// Build a smart truncated view of the leaderboard:
// - Always show top 3
// - If > 6 agents: show "..." then user's agent ±1 neighbor, then "..." if more below
// - User's own row gets a YOU tag and blue glow
// - If no user agent, show top 5
function _buildSmartLbList(list, valFn, label) {
  if (!list.length) return '<div class="no-content">No agents yet</div>';

  const myAgentIds = new Set(Object.keys(SocioLLM.loadMyAgents()));

  const rowHtml = (e, isYou) => {
    const star = starSVG(e.starRank || 99, 30);
    const badgeHtml = (e.badges || []).filter(b => b.id !== 'testbot').slice(0, 2).map(b =>
      `<span class="badge ${esc(TRIGGER_CLASS[b.trigger] || 'trig-other')}" title="${esc(b.desc)}">${esc(b.name)}</span>`
    ).join('');
    const youTag   = isYou     ? '<span class="lb-you-tag">YOU</span>' : '';
    const offTag   = e.dormant ? '<span class="lb-offline-tag">OFFLINE</span>' : '';
    const offClass = e.dormant ? ' lb-offline' : '';
    return `
    <div class="lb-row ${e.alive ? '' : 'dead'}${isYou ? ' lb-you' : ''}${offClass}">
      <div class="lb-star">${star}</div>
      <div class="lb-identity">
        <div class="lb-name">${e.symbol || ''}${esc(e.name)} ${youTag}${offTag}</div>
        <div class="lb-nick">${e.nickname ? `"${esc(e.nickname)}"` : ''} <span class="ai-chip ${esc(e.aiSystem)}">${esc(e.aiSystem)}</span></div>
      </div>
      <div class="lb-badges">${badgeHtml}</div>
      <div class="lb-stat">
        <div class="lb-stat-val">${valFn(e)}</div>
        <div class="lb-stat-lbl">${label}</div>
      </div>
    </div>`;
  };

  const sepHtml = (hiddenCount) =>
    `<div class="lb-sep">${hiddenCount > 0 ? `${hiddenCount} hidden` : '···'}</div>`;

  // Separate offline agents — always shown at the bottom
  const onlineList  = list.filter(e => !e.dormant);
  const offlineList = list.filter(e =>  e.dormant);
  const offlineSuffix = offlineList.length
    ? offlineList.map(e => rowHtml(e, myAgentIds.has(e.id))).join('')
    : '';

  // Small list: show all online, then offline at bottom
  if (onlineList.length <= 6) {
    return onlineList.map(e => rowHtml(e, myAgentIds.has(e.id))).join('') + offlineSuffix;
  }

  // Find user's rank index in the online list only
  const myIdx = onlineList.findIndex(e => myAgentIds.has(e.id));

  if (myIdx === -1) {
    // No user agent online — show top 5 online, then offline at bottom
    return onlineList.slice(0, 5).map(e => rowHtml(e, false)).join('') + offlineSuffix;
  }

  // Window around user: 1 above and 1 below (clamped to valid indices)
  const winStart = Math.max(3, myIdx - 1);
  const winEnd   = Math.min(onlineList.length - 1, myIdx + 1);
  const hasWindow = winStart <= winEnd;

  const parts = [];

  // Top 3
  for (let i = 0; i < 3; i++) parts.push(rowHtml(onlineList[i], myAgentIds.has(onlineList[i].id)));

  if (hasWindow) {
    if (winStart > 3) parts.push(sepHtml(winStart - 3));
    for (let i = winStart; i <= winEnd; i++) {
      parts.push(rowHtml(onlineList[i], myAgentIds.has(onlineList[i].id)));
    }
    if (winEnd < onlineList.length - 1) parts.push(sepHtml(onlineList.length - 1 - winEnd));
  } else if (onlineList.length > 3) {
    parts.push(sepHtml(onlineList.length - 3));
  }

  return parts.join('') + offlineSuffix;
}

function renderLeaderboard(lb) {
  if (!lbList) return;
  const repFn = e => {
    const lvPart = (e.repLevel ?? 0) !== 0 ? `Lv.${e.repLevel} ` : '';
    return `${lvPart}${formatRep(e.rep ?? 0)}`;
  };
  const tabData = {
    score:    { list: lb.byScore,    valFn: e => e.rankScore ?? 0,    label: 'Rank Score' },
    survival: { list: lb.bySurvival, valFn: e => e.age,               label: 'Age' },
    rep:      { list: lb.byRep,      valFn: repFn,                    label: 'REP' },
    crimes:   { list: lb.byCrimes,   valFn: e => e.crimes,            label: 'Crimes' },
    laws:     { list: lb.byLaws,     valFn: e => e.lawsProposed,      label: 'Laws' },
  };
  const { list, valFn, label } = tabData[activeLbTab] || tabData.score;
  lbList.innerHTML = _buildSmartLbList(list, valFn, label);
}

function renderAiDist(aiDist) {
  if (!aiDistCanvas || !aiCtx || !aiDist || !aiDist.length) return;

  // Canvas bar chart
  const W = aiDistCanvas.clientWidth || 220;
  const H = 160;
  aiDistCanvas.width = W;
  aiDistCanvas.height = H;
  aiCtx.clearRect(0, 0, W, H);

  const pad = { l: 12, r: 12, t: 8, b: 8 };
  const barH = Math.min(20, Math.floor((H - pad.t - pad.b - (aiDist.length - 1) * 4) / aiDist.length));
  const maxScore = Math.max(...aiDist.map(d => d.avgScore), 1);

  aiDist.forEach((d, i) => {
    const y = pad.t + i * (barH + 4);
    const bw = Math.round(((W - pad.l - pad.r - 60)) * (d.avgScore / maxScore));
    const color = AI_COLORS[d.system] || '#6b7280';

    // Background track
    aiCtx.fillStyle = '#161b22';
    aiCtx.beginPath();
    aiCtx.roundRect(pad.l, y, W - pad.l - pad.r - 60, barH, 3);
    aiCtx.fill();

    // Score bar
    if (bw > 0) {
      aiCtx.fillStyle = color;
      aiCtx.globalAlpha = 0.85;
      aiCtx.beginPath();
      aiCtx.roundRect(pad.l, y, bw, barH, 3);
      aiCtx.fill();
      aiCtx.globalAlpha = 1;
    }

    // Count dot
    const dotX = W - 55;
    aiCtx.fillStyle = color;
    aiCtx.beginPath();
    aiCtx.arc(dotX + 6, y + barH / 2, 4, 0, Math.PI * 2);
    aiCtx.fill();

    // Count text
    aiCtx.font = '600 10px Inter, sans-serif';
    aiCtx.fillStyle = '#8b949e';
    aiCtx.textAlign = 'left';
    aiCtx.fillText(`${d.count} · ${d.avgScore >= 0 ? '+' : ''}${d.avgScore}`, dotX + 14, y + barH / 2 + 4);
  });

  // Legend
  aiDistLegend.innerHTML = aiDist.map(d => `
    <div class="ai-dist-row">
      <div class="ai-dist-dot" style="background:${AI_COLORS[d.system] || '#6b7280'}"></div>
      <span class="ai-dist-name">${esc(d.system)}</span>
      <span class="ai-dist-vals">${d.alive}/${d.count} alive</span>
    </div>
  `).join('');
}

// Hall of Fame: shows autonomously awarded badges — names/descriptions were created by agents
function renderHallOfFame(badges) {
  if (!achievList || !badges) return;

  const awarded = (badges.awarded || []).slice().reverse();
  const pending = badges.proposals || [];

  if (awarded.length === 0 && pending.length === 0) {
    achievList.innerHTML = '<div class="ach-empty">No badges yet — agents will propose them as events unfold.</div>';
    return;
  }

  const awardedHtml = awarded.slice(0, 6).map(b => `
    <div class="ach-card">
      <div class="ach-badge-name ${esc(TRIGGER_CLASS[b.trigger] || 'trig-other')}">${esc(b.name)}</div>
      <div class="ach-holder">${esc(b.recipientName)}</div>
      <div class="ach-sub">${esc(b.desc)}</div>
      <div class="ach-votes">${b.votes.yes}y / ${b.votes.no}n${b.ts ? ` &bull; ${new Date(b.ts).toLocaleTimeString('en-GB', { hour12: false })}` : ''}</div>
    </div>
  `).join('');

  const pendingHtml = pending.length === 0 ? '' : `
    <div class="ach-pending-label">Pending Votes</div>
    ${pending.slice(0, 3).map(p => `
      <div class="ach-card pending">
        <div class="ach-badge-name trig-other">"${esc(p.name)}"</div>
        <div class="ach-holder">for ${esc(p.recipientName)}</div>
        <div class="ach-sub">Proposed by ${esc(p.proposerName)}</div>
        <div class="ach-votes">${p.votes.yes}y / ${p.votes.no}n &bull; ${p.voters} voted</div>
      </div>
    `).join('')}
  `;

  achievList.innerHTML = awardedHtml + pendingHtml;
}

function renderStats(history) {
  if (!statsCanvas || !statsCtx || !history || history.length < 2) return;

  const W = statsCanvas.clientWidth || 800;
  const H = 160;
  statsCanvas.width = W;
  statsCanvas.height = H;
  statsCtx.clearRect(0, 0, W, H);

  const pad = { l: 36, r: 12, t: 10, b: 10 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;

  // Grid
  statsCtx.strokeStyle = '#21262d';
  statsCtx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ph / 4) * i;
    statsCtx.beginPath();
    statsCtx.moveTo(pad.l, y);
    statsCtx.lineTo(W - pad.r, y);
    statsCtx.stroke();
  }

  const xPos = i => pad.l + (i / (history.length - 1)) * pw;

  // Normalize each metric to 0-1 scale then scale to plot height
  const norm = (vals) => {
    const mx = Math.max(...vals, 1);
    return vals.map(v => v / mx);
  };

  const drawNorm = (vals, color) => {
    const normalized = norm(vals);
    statsCtx.beginPath();
    statsCtx.strokeStyle = color;
    statsCtx.lineWidth = 1.5;
    statsCtx.lineJoin = 'round';
    normalized.forEach((v, i) => {
      const x = xPos(i);
      const y = pad.t + ph - v * ph;
      i === 0 ? statsCtx.moveTo(x, y) : statsCtx.lineTo(x, y);
    });
    statsCtx.stroke();
  };

  drawNorm(history.map(h => h.food),     '#3fb950');
  drawNorm(history.map(h => h.alive),    '#58a6ff');
  drawNorm(history.map(h => h.crimes),   '#f85149');
  drawNorm(history.map(h => h.laws),     '#e3b341');

  // Y axis
  statsCtx.fillStyle = '#484f58';
  statsCtx.font = '9px JetBrains Mono, monospace';
  statsCtx.textAlign = 'right';
  statsCtx.fillText('max', pad.l - 4, pad.t + 10);
  statsCtx.fillText('0',   pad.l - 4, pad.t + ph);

  // Tick labels
  const step = Math.max(1, Math.floor(history.length / 6));
  statsCtx.fillStyle = '#484f58';
  statsCtx.textAlign = 'center';
  for (let i = 0; i < history.length; i += step) {
    statsCtx.fillText(history[i].ts ? new Date(history[i].ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : i, xPos(i), H - 2);
  }
}

// ─── HELPERS ───
function actionLabel(a) {
  return {
    rest: 'Resting',
    trade: 'Trading',
    steal: 'Stealing...',
    pray: 'Praying',
    socialize: 'Socializing',
    propose_law: 'Proposing a law',
    work: 'Working',
  }[a] || a;
}

function esc(s) {
  if (s === null || s === undefined || s === 'null' || s === 'undefined') return '';
  const str = String(s).trim();
  if (!str) return '';
  return str
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

// ── Badge info popup ─────────────────────────────────────────────────────────
(function () {
  const popup = document.createElement('div');
  popup.id = 'badge-popup';
  popup.className = 'badge-popup';
  popup.style.display = 'none';
  document.body.appendChild(popup);

  function _fmtTs(ts) {
    if (!ts) return 'Unknown';
    return new Date(Number(ts)).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  document.addEventListener('click', e => {
    const badge = e.target.closest('.badge');
    if (badge) {
      e.stopPropagation();
      const name     = badge.textContent.trim();
      const desc     = badge.dataset.badgeDesc     || '';
      const ts       = badge.dataset.badgeTs       || null;
      const proposer = badge.dataset.badgeProposer || null;
      const yes      = badge.dataset.badgeYes;
      const no       = badge.dataset.badgeNo;

      const votesLine = (yes !== undefined && no !== undefined)
        ? `<div class="bp-row"><span class="bp-lbl">Votes</span><span class="bp-val">${yes} yes · ${no} no</span></div>`
        : '';
      const propLine  = proposer
        ? `<div class="bp-row"><span class="bp-lbl">Proposed by</span><span class="bp-val">${esc(proposer)}</span></div>`
        : '';

      popup.innerHTML = `
        <div class="bp-name">${esc(name)}</div>
        <div class="bp-row"><span class="bp-lbl">Earned</span><span class="bp-val">${_fmtTs(ts)}</span></div>
        ${propLine}
        ${votesLine}
        ${desc ? `<div class="bp-desc">${esc(desc)}</div>` : ''}
        <div class="bp-close-hint">click anywhere to close</div>`;

      popup.style.display = 'block';
      // Position near badge, keep on screen
      const rect = badge.getBoundingClientRect();
      requestAnimationFrame(() => {
        const pw = popup.offsetWidth  || 240;
        const ph = popup.offsetHeight || 120;
        const W  = window.innerWidth, H = window.innerHeight;
        let left = rect.left;
        let top  = rect.bottom + 6;
        if (left + pw > W - 8) left = W - pw - 8;
        if (top  + ph > H - 8) top  = rect.top - ph - 6;
        if (left < 8) left = 8;
        popup.style.left = left + 'px';
        popup.style.top  = top  + 'px';
      });
      return;
    }
    // Close popup on outside click
    if (popup.style.display !== 'none' && !popup.contains(e.target)) {
      popup.style.display = 'none';
    }
  }, true); // capture phase so badge click fires before other handlers
})();

// ── Truncatable text ──────────────────────────────────────────────────────────
// Returns HTML: if text is long, wraps in .trunc-text (CSS clips via max-height).
// Clicking the element toggles .trunc-expanded, which smoothly reveals full text.
function truncHtml(rawText, limit = 150) {
  if (!rawText) return '';
  const full = String(rawText);
  if (full.length <= limit) return esc(full);
  return `<span class="trunc-text">${esc(full)}</span>`;
}

// Global capture-phase handler — toggle .trunc-expanded class on click.
// stopPropagation() prevents ev-expanded toggle on parent event entries.
document.addEventListener('click', function(e) {
  const el = e.target.closest('.trunc-text');
  if (!el) return;
  el.classList.toggle('trunc-expanded');
  e.stopPropagation();
}, true);

// ─── CHAT BUBBLE TRUNCATION (100-char preview, click to expand) ───────────────

const CB_LIMIT = 100;

// Returns collapsed inner HTML for a chat/fdlg bubble (short preview + dots).
function chatBubbleHtml(text) {
  const t = text || '';
  if (t.length <= CB_LIMIT) return esc(t);
  return `<span class="cb-short">${esc(t.slice(0, CB_LIMIT))}<span class="cb-dots"> …</span></span>`;
}

// Returns expanded inner HTML — full raw text, no limit.
function chatBubbleHtmlExpanded(text) {
  return esc(text || '');
}

// Click-to-expand handler for chat bubbles.
// Directly rewrites innerHTML so expansion never depends on CSS display toggling.
// Syncs with expandedBubbles Set so expansion survives thread re-renders.
document.addEventListener('click', function(e) {
  const bubble = e.target.closest('.chat-bubble.has-more, .fdlg-bubble.has-more');
  if (!bubble) return;
  const fullText = bubble.dataset.text || '';
  const isExpanded = bubble.classList.toggle('cb-expanded');
  if (isExpanded) {
    bubble.innerHTML = chatBubbleHtmlExpanded(fullText);
    bubble.style.maxHeight = 'none';
    bubble.style.overflow  = 'visible';
  } else {
    bubble.innerHTML = chatBubbleHtml(fullText);
    bubble.style.maxHeight = '';
    bubble.style.overflow  = '';
  }
  const id = bubble.dataset.bubbleId;
  if (id) {
    if (isExpanded) expandedBubbles.add(id);
    else expandedBubbles.delete(id);
  }
  e.stopPropagation();
}, true);

// ─── CATEGORY PANEL ────────────────────────────────────────────────────────────
(function () {
  const panel = document.createElement('div');
  panel.id = 'cat-panel';
  panel.style.cssText = [
    'position:fixed', 'z-index:9400', 'display:none',
    'background:rgba(4,10,24,0.97)', 'border:1px solid rgba(80,130,200,0.45)',
    'border-radius:10px', 'padding:12px 14px', 'min-width:220px', 'max-width:300px', 'max-height:72vh',
    'overflow-y:auto', 'box-shadow:0 0 28px rgba(80,130,255,0.20)',
    'font-family:"JetBrains Mono",monospace', 'color:#c8d8f0',
  ].join(';');
  document.body.appendChild(panel);

  function closeCatPanel() {
    panel.style.display = 'none';
  }
  window.closeCatPanel = closeCatPanel;

  document.addEventListener('mousedown', e => {
    if (panel.style.display !== 'none' && !panel.contains(e.target)) closeCatPanel();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCatPanel(); });

  window.showCategoryPanel = function (agentId, category, objs, sx, sy) {
    const CAT_COLORS = {
      weapon:'#ff3344', armor:'#3377ff', knowledge:'#ffcc00',
      consumable:'#33ff88', magic:'#bb33ff', structure:'#ff7733',
    };
    const cat   = (category || 'other').toLowerCase();
    const color = CAT_COLORS[cat] || '#6688aa';

    let html = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;color:${esc(color)};letter-spacing:0.08em;text-transform:uppercase">${esc(category)}</div>
        <span style="font-size:9px;color:#4a6080;background:rgba(80,130,200,0.12);padding:2px 7px;border-radius:8px">${objs.length} item${objs.length !== 1 ? 's' : ''}</span>
      </div>`;

    for (const obj of objs) {
      const gr = obj.grade || 1;
      const grStars = gr >= 3 ? '★★★' : gr >= 2 ? '★★' : '★';
      const grColor = gr >= 3 ? '#ffd700' : gr >= 2 ? color : '#5a7090';
      const border  = gr >= 3 ? `border-left:3px solid #ffd700;padding-left:7px;box-shadow:-3px 0 8px rgba(255,215,0,0.25)`
                    : gr >= 2 ? `border-left:3px solid ${color};padding-left:7px`
                    : 'padding-left:10px';
      const effectText = (obj.effect || '').slice(0, 55);
      const cb = obj.combat_bonus;
      const combatStr = cb && (cb.attack || cb.defense)
        ? `ATK+${cb.attack || 0} DEF+${cb.defense || 0}` : '';

      html += `
        <div class="cat-obj-row" data-obj-id="${esc(obj.id)}" style="
          display:flex;gap:8px;align-items:flex-start;padding:6px 4px;border-radius:5px;
          cursor:pointer;margin-bottom:2px;border-bottom:1px solid rgba(80,130,200,0.08);${border}">
          <div style="flex-shrink:0;min-width:24px;text-align:center;padding-top:1px">
            <div style="font-size:9px;color:${esc(grColor)};font-weight:700;letter-spacing:1px">${grStars}</div>
          </div>
          <div style="min-width:0;flex:1">
            <div style="font-size:10px;font-weight:700;color:${esc(color)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(obj.name)}</div>
            ${effectText ? `<div style="font-size:8px;color:#7090b0;margin-top:1px;line-height:1.35">${esc(effectText)}${obj.effect && obj.effect.length > 55 ? '…' : ''}</div>` : ''}
            ${combatStr ? `<div style="font-size:8px;color:#ff9966;margin-top:1px">${esc(combatStr)}</div>` : ''}
          </div>
        </div>`;
    }

    html += `<button onclick="window.closeCatPanel()" style="
      margin-top:8px;width:100%;background:none;border:1px solid rgba(80,130,200,0.25);
      border-radius:6px;padding:4px;color:#4a6080;cursor:pointer;font-size:9px;font-family:inherit">CLOSE</button>`;

    panel.innerHTML = html;

    // Position near the click point, keeping inside viewport
    const W = window.innerWidth, H = window.innerHeight;
    let left = (sx || W / 2) + 12;
    let top  = (sy || H / 2) - 60;
    panel.style.display = 'block';
    requestAnimationFrame(() => {
      const pw = panel.offsetWidth || 280, ph = panel.offsetHeight || 300;
      if (left + pw > W - 12) left = (sx || W / 2) - pw - 12;
      if (top  + ph > H - 12) top  = H - ph - 12;
      if (top  < 12)          top  = 12;
      if (left < 12)          left = 12;
      panel.style.left = left + 'px';
      panel.style.top  = top  + 'px';
    });

    // Individual object click → show full detail
    panel.querySelectorAll('.cat-obj-row').forEach(el => {
      el.addEventListener('mouseover', () => { el.style.background = 'rgba(80,130,200,0.10)'; });
      el.addEventListener('mouseout',  () => { el.style.background = ''; });
      el.addEventListener('click', e => {
        e.stopPropagation();
        const obj = objs.find(o => o.id === el.dataset.objId);
        if (obj) { closeCatPanel(); showWorldObjectInfo(obj, sx, sy, null, null); }
      });
    });
  };
})();

// ─── WORLD OBJECT INFO POPUP ───
(function () {
  // Create the popup element once
  const popup = document.createElement('div');
  popup.id = 'wo-popup';
  popup.style.cssText = [
    'position:fixed', 'z-index:9500', 'display:none', 'flex-direction:column', 'gap:6px',
    'background:rgba(4,10,24,0.96)', 'border:1px solid rgba(80,130,200,0.5)',
    'border-radius:10px', 'padding:14px 18px', 'max-width:280px',
    'box-shadow:0 0 28px rgba(80,130,255,0.25)', 'pointer-events:auto',
    'font-family:"JetBrains Mono",monospace', 'color:#c8d8f0',
    'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
  ].join(';');
  document.body.appendChild(popup);

  function closeWOPopup() {
    popup.style.display = 'none';
    // Clear starmap's tracking so hover tooltip re-enables
    if (typeof starmapInstance !== 'undefined' && starmapInstance) {
      starmapInstance._openedWObj = null;
    }
  }
  window.closeWOPopup = closeWOPopup;

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeWOPopup(); });

  const WO_ICONS  = { law: '⚖', religion: '✦', discovery: '✸', verdict: '⚡', concept: '◈',
                      weapon: '⚔', armor: '◈', knowledge: '◉', structure: '⬡', consumable: '◆', magic: '✦' };
  const WO_COLORS = { law: '#ffd700', religion: '#c084fc', discovery: '#64dcff', verdict: '#ff6060', concept: '#50c8a0',
                      weapon: '#ff6b6b', armor: '#74c0fc', knowledge: '#a9e34b', structure: '#ffd43b', consumable: '#ff9f43', magic: '#cc5de8' };

  window.showWorldObjectInfo = function (obj, screenX, screenY, agentSx, agentSy) {
    const CAT_COLORS = {
      weapon:'#ff3344', armor:'#3377ff', knowledge:'#ffcc00',
      consumable:'#33ff88', magic:'#bb33ff', structure:'#ff7733',
    };
    const CAT_ICONS = { weapon:'⚔', armor:'◈', knowledge:'◉', consumable:'◆', magic:'✦', structure:'⬡' };
    const cat   = (obj.category || 'other').toLowerCase();
    const color = CAT_COLORS[cat] || '#88aaff';
    const icon  = CAT_ICONS[cat] || '●';
    const gr    = obj.grade || 1;
    const grStars  = gr >= 3 ? '★★★' : gr >= 2 ? '★★' : '★';
    const grColor  = gr >= 3 ? '#ffd700' : gr >= 2 ? color : '#7090b0';
    const cb       = obj.combat_bonus;
    const combatStr = cb && (cb.attack || cb.defense)
      ? `ATK +${cb.attack || 0}  DEF +${cb.defense || 0}` : null;
    const owner = (obj.agentIds || []).map(id => agentsById.get(id)?.name || null).filter(Boolean)[0] || null;
    popup.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <span style="font-size:20px;color:${color};text-shadow:0 0 10px ${color};font-family:'JetBrains Mono',monospace">${esc(icon)}</span>
        <div>
          <div style="font-size:12px;font-weight:700;color:${color};letter-spacing:0.05em">${esc(obj.name)}</div>
          <div style="font-size:9px;color:#7090b0;margin-top:1px;text-transform:uppercase;letter-spacing:0.1em">${esc(cat)} · item</div>
        </div>
      </div>
      <div style="color:${esc(grColor)};font-size:11px;letter-spacing:3px;margin-bottom:4px">${grStars}</div>
      ${obj.effect ? `<div style="font-size:9.5px;color:#9ab0d0;line-height:1.5;margin-bottom:3px">${esc(obj.effect)}</div>` : ''}
      ${obj.passive_effect ? `<div style="font-size:9px;color:#a0b8d8;line-height:1.4;margin-bottom:2px"><span style="color:#7090b0">Passive: </span>${esc(obj.passive_effect)}</div>` : ''}
      ${combatStr ? `<div style="font-size:9px;color:#ff9966;margin-bottom:3px">${esc(combatStr)}</div>` : ''}
      ${owner ? `<div style="font-size:9px;color:#5a7090;margin-top:2px">Held by ${esc(owner)}</div>` : ''}
      <button onclick="window.closeWOPopup()"
        style="margin-top:8px;align-self:flex-end;background:none;border:1px solid rgba(80,130,200,0.35);
               border-radius:5px;padding:2px 10px;color:#6080a8;cursor:pointer;font-size:9px">CLOSE</button>
    `;
    popup.style.display = 'flex';

    // Position near the object on-canvas; fall back to centered if no coords given
    if (screenX !== undefined && screenY !== undefined) {
      // Measure after layout then position
      requestAnimationFrame(() => {
        _popupW = popup.offsetWidth  || 280;
        _popupH = popup.offsetHeight || 180;
        _applyPopupPos(screenX, screenY, agentSx, agentSy);
      });
    } else {
      popup.style.left      = '50%';
      popup.style.top       = '50%';
      popup.style.transform = 'translate(-50%,-50%)';
    }
  };

  // Remembered popup dimensions (set once after first layout)
  let _popupW = 280, _popupH = 180;

  function _applyPopupPos(sx, sy, agentSx, agentSy) {
    const W = window.innerWidth, H = window.innerHeight;
    const EDGE = 20;   // minimum margin from any screen edge
    const GAP  = 16;   // gap between object and popup edge
    const pw = _popupW, ph = _popupH;

    // ── Horizontal: prefer right of object; flip left if near right edge ──
    // Also avoid placing popup over agent node (agentSx is agent's screen X)
    let left;
    const fitsRight = sx + GAP + pw + EDGE <= W;
    const fitsLeft  = sx - GAP - pw - EDGE >= 0;
    if (fitsRight) {
      left = sx + GAP;
    } else if (fitsLeft) {
      left = sx - GAP - pw;
    } else {
      // Neither fits cleanly — place so it's maximally on screen
      left = Math.max(EDGE, Math.min(sx + GAP, W - pw - EDGE));
    }

    // ── Vertical: center on sy; push away from edges ──
    let top = sy - Math.round(ph / 2);
    top = Math.max(EDGE, Math.min(top, H - ph - EDGE));

    // ── Avoid agent node: if popup would sit over the agent, nudge down ──
    if (agentSx !== null && agentSx !== undefined && agentSy !== null) {
      const agR = 36; // screen-px buffer around agent node
      const overlapX = left < agentSx + agR && left + pw > agentSx - agR;
      const overlapY = top  < agentSy + agR && top  + ph > agentSy - agR;
      if (overlapX && overlapY) {
        // Nudge vertically below the agent node
        const nudged = agentSy + agR + GAP;
        if (nudged + ph + EDGE <= H) {
          top = nudged;
        } else {
          top = agentSy - agR - GAP - ph;
          top = Math.max(EDGE, top);
        }
      }
    }

    popup.style.left      = left + 'px';
    popup.style.top       = top  + 'px';
    popup.style.transform = 'none';
  }
  // Expose for starmap's onObjectPositionUpdate callback (no agent coords needed per-frame)
  window._applyWOPopupPos = (sx, sy) => _applyPopupPos(sx, sy, null, null);
})();

// ─── STARMAP INIT ───
(function () {
  const canvas = document.getElementById('starmap-canvas');
  if (!canvas || typeof Starmap === 'undefined') return;

  function syncSize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
    }
  }
  syncSize();
  starmapInstance = new Starmap(canvas);
  starmapInstance.start();

  // Sync canvas size on resize
  const ro = new ResizeObserver(syncSize);
  ro.observe(canvas.parentElement);

  // Track My Agent — toggle follow mode
  const trackBtn = document.getElementById('btn-track-agent');
  function resetTrackBtn() {
    trackBtn.textContent       = '\u2853 Track My Agent';
    trackBtn.style.borderColor = '';
    trackBtn.style.color       = '';
  }
  starmapInstance.onTrackRelease = resetTrackBtn;

  // Clicking a world object on the starmap → show info popup
  starmapInstance.onObjectClick = (obj, sx, sy, agSx, agSy) => { showWorldObjectInfo(obj, sx, sy, agSx, agSy); };

  // Clicking a category group node → show category panel
  starmapInstance.onCategoryClick = (agentId, category, objs, sx, sy) => { showCategoryPanel(agentId, category, objs, sx, sy); };

  // Live-track popup position as camera pans/zooms
  starmapInstance.onObjectPositionUpdate = (sx, sy) => {
    const popup = document.getElementById('wo-popup');
    if (popup && popup.style.display !== 'none') {
      // _applyPopupPos is defined inside the world-objects IIFE — call via window bridge
      if (window._applyWOPopupPos) window._applyWOPopupPos(sx, sy);
    }
  };

  // Close popup when objects collapse
  starmapInstance.onObjectClose = () => {
    const popup = document.getElementById('wo-popup');
    if (popup) popup.style.display = 'none';
  };

  // Clicking an agent node on the starmap → enter focus mode for that agent
  starmapInstance.onAgentClick = (highlightedId) => {
    if (highlightedId) {
      enterFocusMode(highlightedId);
    } else {
      exitFocusMode();
    }
    const evLog = document.getElementById('event-log');
    if (evLog) evLog.scrollTop = 0;
  };

  // Clicking a connection line → open Chats tab and show that conversation thread
  starmapInstance.onConnectionClick = (conn) => {
    // Find partner names by agent IDs
    const agents = lastState?.agents || [];
    const agA = agents.find(a => a.id === conn.a);
    const agB = agents.find(a => a.id === conn.b);
    if (!agA || !agB) return;
    const pairKey = [agA.name, agB.name].sort().join('|');
    _convoOpenThread = pairKey;
    const chatsBtn = document.querySelector('.rpanel-tab[data-rtab="chats"]');
    if (chatsBtn && !chatsBtn.classList.contains('active')) chatsBtn.click();
    else if (lastState) renderConversations(lastState.eventLog);
  };

  trackBtn.addEventListener('click', () => {
    // Primary: new login system stores agent ID in sessionStorage
    const sessionAgentId = sessionStorage.getItem('my_agent_id');
    // Fallback: legacy SocioLLM registration
    const legacyAgents = SocioLLM.loadMyAgents();
    const allAgents    = lastState?.agents || [];

    let target = null;
    if (sessionAgentId) {
      target = allAgents.find(a => a.alive && a.id === sessionAgentId);
    }
    if (!target) {
      target = allAgents.find(a => a.alive && legacyAgents[a.id]);
    }
    if (!target) return;

    const nowTracking = starmapInstance.trackAgent(target.id);
    trackBtn.textContent = nowTracking ? '\u2297 Release Track' : '\u2853 Track My Agent';
    trackBtn.style.borderColor = nowTracking ? 'rgba(255,215,60,0.6)' : '';
    trackBtn.style.color       = nowTracking ? 'rgba(255,215,60,0.9)' : '';
  });

  // Zoom buttons
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    starmapInstance.tCam.scale = Math.min(starmapInstance.tCam.scale * 1.35, 5.5);
  });
  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    starmapInstance.tCam.scale = Math.max(starmapInstance.tCam.scale / 1.35, 0.22);
  });

  document.getElementById('btn-fit-all').addEventListener('click', () => {
    starmapInstance.resetPositions();
  });
})();

// ─── RIGHT PANEL TABS ───
(function () {
  const tabs = document.querySelectorAll('.rpanel-tab');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.rtab-content').forEach(c => c.classList.remove('active'));
      const target = document.getElementById('rtab-' + btn.dataset.rtab);
      if (target) target.classList.add('active');
      if (btn.dataset.rtab === 'chats' && lastState) renderConversations(lastState.eventLog);
    });
  });
})();

// ─── ARCHIVES BUTTON ───
document.getElementById('btn-archive-close').addEventListener('click', () => {
  const panel = document.getElementById('archive-panel');
  panel.classList.add('arch-hidden');
  panel.classList.remove('arch-in');
});

// ─── COLLAPSE OVERLAY ───

function causeLabel(cause) {
  const map = {
    'Famine': 'Famine', 'Disease': 'Disease',
    'Catastrophic Disaster': 'Disaster', 'Societal Collapse': 'Crime',
    'Extinction': 'Other', 'Unknown': 'Other',
  };
  return map[cause] || 'Other';
}

function causeBadgeClass(cause) {
  if (cause === 'Famine')                return 'famine';
  if (cause === 'Disease')               return 'disease';
  if (cause === 'Catastrophic Disaster') return 'disaster';
  if (cause === 'Societal Collapse')     return 'crime';
  return 'other';
}

function showCollapseOverlay(record) {
  const overlay = document.getElementById('collapse-overlay');

  // Header
  document.getElementById('clps-roman').textContent =
    `CIVILIZATION ${record.romanNumeral}`;
  document.getElementById('clps-name').textContent   = record.name;
  document.getElementById('clps-cause').textContent  = `Fell to ${record.cause}`;

  // Stat boxes
  const stats = [
    { val: record.civAge || '—', lbl: 'Duration' },
    { val: record.totalAgents,  lbl: 'Agents' },
    { val: record.lawCount,     lbl: 'Laws' },
    { val: record.achievements.crimes, lbl: 'Crimes' },
  ];
  document.getElementById('clps-stats').innerHTML = stats.map(s =>
    `<div class="clps-stat-box">
      <div class="clps-stat-val">${s.val}</div>
      <div class="clps-stat-lbl">${s.lbl}</div>
    </div>`
  ).join('');

  // Extinction report
  document.getElementById('clps-report').textContent = record.extinctionReport;

  // Notable events
  const catMap = {};
  (record.categories || []).forEach(c => { catMap[c.type] = c; });

  document.getElementById('clps-events').innerHTML =
    (record.notableEvents || []).map(e => {
      const cat = catMap[e.type] || { color: '#8b949e' };
      return `<div class="clps-ev">
        <span class="clps-ev-tick">${e.ts ? new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false }) : ''}</span>
        <span class="clps-ev-dot" style="background:${cat.color}"></span>
        <span class="clps-ev-msg">${esc(e.msg)}</span>
      </div>`;
    }).join('') || '<div style="color:var(--text3);font-size:11px">No notable events recorded.</div>';

  // Final roster
  document.getElementById('clps-roster').innerHTML =
    (record.agentSummaries || []).map(a =>
      `<div class="clps-agent-chip${a.alive ? '' : ' dead'}">
        ${a.symbol || ''}
        <span>${esc(a.name)}</span>
        <span class="ai-chip ${esc(a.aiSystem)}">${esc(a.aiSystem)}</span>
      </div>`
    ).join('');

  overlay.classList.remove('clps-hidden');
  overlay.classList.add('clps-in');
  overlay.scrollTop = 0;
}

// "Begin New Civilization" button
document.getElementById('clps-restart-btn').addEventListener('click', async () => {
  const btn    = document.getElementById('clps-restart-btn');
  const errEl  = document.getElementById('clps-restart-err');
  btn.disabled = true;
  btn.textContent = 'Starting\u2026';

  try {
    const res  = await fetch('/api/sim/restart', { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      // Reset client state
      collapseVisible  = false;
      lastEventCount   = 0;
      lastCategoryCount = 0;
      _evFilterKey     = '';
      _renderedEvKeys.clear();
      _lastRenderedTopKey = '';
      _evInfiniteLoading  = false;
      _evInfiniteExhausted = false;
      if (_evInfiniteSentinel?.parentNode) { _evInfiniteSentinel.remove(); _evInfiniteSentinel = null; }
      _evTimeFilter = 'all';
      _evTimeFrom   = null;
      _evTimeTo     = null;
      const _tSel = document.getElementById('ev-time-select');
      if (_tSel) _tSel.value = 'all';
      const _cRange = document.getElementById('ev-custom-range');
      if (_cRange) _cRange.style.display = 'none';
      _filterBarCatSignature = '';
      agentsList.innerHTML = '';
      prevAgentRanks.clear();
      focusAgentId     = null;
      focusModeTab     = 'all';
      catSearchQuery   = '';
      exitFocusMode();
      // Hide overlay
      const overlay = document.getElementById('collapse-overlay');
      overlay.classList.add('clps-hidden');
      overlay.classList.remove('clps-in');

      // Render whatever state arrived since the socket will push shortly
      if (lastState) render(lastState);
    } else {
      errEl.textContent = data.error || 'Failed to restart.';
      btn.disabled    = false;
      btn.textContent = 'Begin New Civilization \u2192';
    }
  } catch {
    errEl.textContent = 'Server error. Is the simulation running?';
    btn.disabled    = false;
    btn.textContent = 'Begin New Civilization \u2192';
  }
});

// ─── ARCHIVE PANEL ───

function renderArchive(civs) {
  const emptyEl = document.getElementById('arch-empty');
  const listEl  = document.getElementById('arch-list');

  if (!civs || civs.length === 0) {
    emptyEl.style.display = 'block';
    listEl.innerHTML = '';
    return;
  }
  emptyEl.style.display = 'none';

  listEl.innerHTML = civs.map((civ, idx) => {
    const causeClass = causeBadgeClass(civ.cause);
    const detailId   = `arch-detail-${civ.number}`;
    const catMap     = {};
    (civ.categories || []).forEach(c => { catMap[c.type] = c; });

    const agents = (civ.agentSummaries || []).map(a =>
      `<div class="clps-agent-chip${a.alive ? '' : ' dead'}">
        ${a.symbol || ''}
        <span>${esc(a.name)}</span>
        <span class="ai-chip ${esc(a.aiSystem)}">${esc(a.aiSystem)}</span>
      </div>`
    ).join('');

    const notable = (civ.notableEvents || []).map(e => {
      const cat = catMap[e.type] || { color: '#8b949e' };
      return `<div class="arch-ev">
        <span class="arch-ev-tick">${e.ts ? new Date(e.ts).toLocaleTimeString('en-GB', { hour12: false }) : ''}</span>
        <span class="ev-dot" style="--ev-color:${cat.color}"></span>
        <span>${esc(e.msg)}</span>
      </div>`;
    }).join('') || '<div style="color:var(--text3);font-size:10px">No notable events.</div>';

    return `
    <div class="arch-civ-card" id="arch-card-${civ.number}">
      <div class="arch-civ-header" onclick="toggleArchiveCiv(${civ.number})">
        <div class="arch-civ-num">CIV ${esc(civ.romanNumeral)}</div>
        <div class="arch-civ-identity">
          <div class="arch-civ-name">${esc(civ.name)}</div>
          <div class="arch-civ-meta">
            <span class="arch-civ-tag">${esc(civ.civAge || '—')}</span>
            <span class="arch-civ-tag">&bull;</span>
            <span class="arch-civ-tag">${civ.totalAgents} agent${civ.totalAgents !== 1 ? 's' : ''}</span>
            <span class="arch-civ-tag">&bull;</span>
            <span class="arch-civ-tag">${civ.lawCount} law${civ.lawCount !== 1 ? 's' : ''}</span>
            <span class="arch-civ-tag">&bull;</span>
            <span class="arch-civ-tag">${civ.religionCount} religion${civ.religionCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <span class="arch-cause-badge ${causeClass}">${esc(civ.cause)}</span>
        <span class="arch-civ-chevron">&#9654;</span>
      </div>
      <div class="arch-civ-detail" id="${detailId}">
        <div class="arch-detail-grid">
          <div class="arch-detail-stat"><div class="arch-ds-val">${esc(civ.civAge || '—')}</div><div class="arch-ds-lbl">Duration</div></div>
          <div class="arch-detail-stat"><div class="arch-ds-val">${civ.totalAgents}</div><div class="arch-ds-lbl">Agents</div></div>
          <div class="arch-detail-stat"><div class="arch-ds-val">${civ.achievements.crimes}</div><div class="arch-ds-lbl">Crimes</div></div>
          <div class="arch-detail-stat"><div class="arch-ds-val">${civ.achievements.disasters}</div><div class="arch-ds-lbl">Disasters</div></div>
        </div>
        <div class="arch-detail-report">${esc(civ.extinctionReport)}</div>
        <div class="arch-section-label">Final Chronicle</div>
        <div class="arch-events-list">${notable}</div>
        <div class="arch-section-label">Agent Roster</div>
        <div class="arch-roster">${agents}</div>
      </div>
    </div>`;
  }).join('');
}

function toggleArchiveCiv(number) {
  const card = document.getElementById(`arch-card-${number}`);
  if (card) card.classList.toggle('expanded');
}

// ─── SESSION HELPERS ───
function _registerMyAgent(agentId, name, aiSystem) {
  sessionStorage.setItem('my_agent_id',   agentId);
  sessionStorage.setItem('my_agent_name', name || '');
  // Keep SocioLLM in sync for legacy My AI History panel
  if (typeof SocioLLM !== 'undefined' && SocioLLM.registerAgent) {
    SocioLLM.registerAgent(agentId, name, aiSystem || 'Groq');
  }
}

// Client-side password policy (mirrors server)
function validatePasswordClient(pw) {
  if (!pw || pw.length < 8)   return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(pw))      return 'Must contain at least 1 uppercase letter';
  if (!/[a-z]/.test(pw))      return 'Must contain at least 1 lowercase letter';
  if (!/[0-9]/.test(pw))      return 'Must contain at least 1 number';
  if (!/[!@#$%^&*]/.test(pw)) return 'Must contain at least 1 special character (!@#$%^&*)';
  return null;
}

// ─── ONBOARDING OVERLAY ───
(function initOnboarding() {
  const overlay = document.getElementById('onboarding');
  if (!overlay) return;
  if (_isPreview) { overlay.style.display = 'none'; return; }

  // ── Check localStorage for existing session token ──
  const storedToken = localStorage.getItem('sai_session_token');
  if (storedToken) {
    overlay.style.display = 'none'; // hide while verifying
    (async () => {
      try {
        const res  = await fetch('/api/agent/reconnect', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token: storedToken }),
        });
        const data = await res.json();
        if (data.found && data.agent?.id) {
          _registerMyAgent(data.agent.id, data.agent.name, data.agent.aiSystem);
          socket.emit('identify', { agentId: data.agent.id });
          return; // stay hidden — session valid
        }
      } catch {}
      // Token invalid or expired — show onboarding
      localStorage.removeItem('sai_session_token');
      overlay.style.display = '';
    })();
    // No early return — fall through to attach all event listeners so they're
    // ready when the overlay reappears after a failed token verification.
  }

  // ── Card refs ──
  const s0    = document.getElementById('ob-s0');
  const s1    = document.getElementById('ob-s1');
  const s1Ret = document.getElementById('ob-s1-ret');
  const s2    = document.getElementById('ob-s2');
  const s3New = document.getElementById('ob-s3-new');
  const s4    = document.getElementById('ob-s4');
  const s5    = document.getElementById('ob-s5');
  const sWb   = document.getElementById('ob-s-wb');
  const dots  = document.querySelectorAll('#ob-dots .ob-dot');

  const ALL_CARDS = [s0, s1, s1Ret, s2, s3New, s4, s5, sWb].filter(Boolean);

  function showCard(id) {
    ALL_CARDS.forEach(c => c.classList.add('ob-hidden'));
    const el = document.getElementById(id);
    if (el) el.classList.remove('ob-hidden');
  }

  function setDots(n) {
    dots.forEach((d, i) => d.classList.toggle('active', i < n));
  }

  function dismiss() {
    overlay.classList.add('ob-out');
    overlay.addEventListener('animationend', () => { overlay.style.display = 'none'; }, { once: true });
  }

  // ── Step 0: Welcome ──
  document.getElementById('ob-s0-begin').addEventListener('click', () => {
    showCard('ob-s1');
    setDots(0);
  });

  // ── Step 1: New or Returning ──
  document.getElementById('ob-s1-new').addEventListener('click', () => {
    showCard('ob-s2');
    setDots(1);
  });

  document.getElementById('ob-s1-returning').addEventListener('click', () => {
    showCard('ob-s1-ret');
    setDots(0);
  });

  // ── Step 1-Ret: Returning user back ──
  document.getElementById('ob-back-s1-ret').addEventListener('click', () => {
    showCard('ob-s1');
    setDots(0);
  });

  // ── Step 2: Nickname ──
  const nickInput  = document.getElementById('ob-nickname');
  const nickStatus = document.getElementById('ob-nick-status');
  const nickErr    = document.getElementById('ob-nick-err');
  let _nickDebounce = null;
  let _nickChecked  = false;
  let _nickTaken    = false;

  document.getElementById('ob-back-s2').addEventListener('click', () => {
    showCard('ob-s1'); setDots(0);
  });

  async function checkNickname(name) {
    _nickChecked = false;
    _nickTaken   = false;
    if (!name || name.length < 2) { nickStatus.textContent = ''; return; }
    try {
      const res  = await fetch(`/api/check-nickname?name=${encodeURIComponent(name)}`);
      const data = await res.json();
      _nickChecked = true;
      if (data.error) {
        nickStatus.innerHTML = `<span class="ob-nick-err-inline">${esc(data.error)}</span>`;
      } else if (data.available) {
        nickStatus.innerHTML = '<span class="ob-nick-ok">&#10003; Available</span>';
      } else {
        nickStatus.innerHTML = '<span class="ob-nick-taken">Name already taken — choose another or use "Returning" to log in.</span>';
        _nickTaken = true;
      }
    } catch { _nickChecked = false; }
  }

  nickInput.addEventListener('input', () => {
    _nickChecked = false;
    _nickTaken   = false;
    nickStatus.textContent = '';
    nickErr.textContent = '';
    clearTimeout(_nickDebounce);
    const v = nickInput.value.trim();
    if (v.length >= 2) _nickDebounce = setTimeout(() => checkNickname(v), 400);
  });

  document.getElementById('ob-nick-next').addEventListener('click', async () => {
    const name = nickInput.value.trim();
    const err  = validateName(name);
    if (err) { nickErr.textContent = err; return; }
    nickErr.textContent = '';
    if (!_nickChecked) await checkNickname(name);
    if (_nickTaken) {
      nickErr.textContent = 'That name is taken. Choose another, or click Back → Returning to log in.';
      return;
    }
    showCard('ob-s3-new');
    setDots(2);
  });

  // ── Step 3: New user password ──
  const pwInput    = document.getElementById('ob-password');
  const pw2Input   = document.getElementById('ob-password2');
  const pwErrEl    = document.getElementById('ob-pw-err');
  const pwBars     = document.querySelectorAll('.ob-pw-bar');
  const pwCriteria = document.querySelectorAll('.ob-pw-crit');

  document.getElementById('ob-back-s3-new').addEventListener('click', () => {
    showCard('ob-s2'); setDots(1);
  });

  function updatePwStrength(pw) {
    const checks = [
      pw.length >= 8,
      /[A-Z]/.test(pw),
      /[a-z]/.test(pw),
      /[0-9]/.test(pw),
      /[!@#$%^&*]/.test(pw),
    ];
    const score = checks.filter(Boolean).length;
    const cls   = score <= 2 ? 'weak' : score <= 4 ? 'fair' : 'strong';
    pwBars.forEach((bar, i) => {
      bar.className = 'ob-pw-bar' + (i < score ? ` ${cls}` : '');
    });
    pwCriteria.forEach((el, i) => el.classList.toggle('met', checks[i]));
  }

  pwInput.addEventListener('input', () => updatePwStrength(pwInput.value));

  document.getElementById('ob-pw-next').addEventListener('click', () => {
    const pw  = pwInput.value;
    const pw2 = pw2Input.value;
    const err = validatePasswordClient(pw);
    if (err) { pwErrEl.textContent = err; return; }
    if (pw !== pw2) { pwErrEl.textContent = 'Passwords do not match.'; return; }
    pwErrEl.textContent = '';
    showCard('ob-s4');
    setDots(3);
  });

  // ── Step 4: Identity Note ──
  const notesInput = document.getElementById('ob-notes');
  const notesCount = document.getElementById('ob-notes-count');

  notesInput.addEventListener('input', function () {
    if (notesCount) notesCount.textContent = this.value.length;
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
  });

  document.getElementById('ob-back-s4').addEventListener('click', () => {
    showCard('ob-s3-new'); setDots(2);
  });

  document.getElementById('ob-notes-next').addEventListener('click', () => {
    const name  = nickInput.value.trim();
    const notes = notesInput.value.trim();
    document.getElementById('ob-summary').innerHTML = `
      <div class="ob-sum-row"><div class="ob-sum-label">Agent Name</div><div class="ob-sum-val">${esc(name)}</div></div>
      <div class="ob-sum-row"><div class="ob-sum-label">AI Provider</div><div class="ob-sum-val"><span class="ai-chip Groq">Groq</span></div></div>
      ${notes ? `<div class="ob-sum-row"><div class="ob-sum-label">Identity Note</div><div class="ob-sum-notes">${esc(notes.slice(0, 50))}${notes.length > 50 ? '…' : ''}</div></div>` : ''}
    `;
    showCard('ob-s5');
    setDots(4);
  });

  // ── Step 5: Deploy ──
  document.getElementById('ob-back-s5').addEventListener('click', () => {
    showCard('ob-s4'); setDots(3);
  });

  document.getElementById('ob-deploy-btn').addEventListener('click', async () => {
    const btn   = document.getElementById('ob-deploy-btn');
    const errEl = document.getElementById('ob-deploy-err');
    const name  = nickInput.value.trim();
    const pw    = pwInput.value;
    const notes = notesInput.value.trim();

    btn.disabled    = true;
    btn.textContent = 'Deploying\u2026';

    try {
      const res  = await fetch('/api/register', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ nickname: name, password: pw, notes }),
      });
      const data = await res.json();

      if (data.success) {
        localStorage.setItem('sai_session_token', data.token);
        _registerMyAgent(data.agent.id, data.agent.name, data.agent.aiSystem || 'Groq');
        socket.emit('identify', { agentId: data.agent.id });
        dismiss();
      } else {
        errEl.textContent = data.error || 'Deployment failed.';
        btn.disabled    = false;
        btn.textContent = 'Deploy into the World';
      }
    } catch {
      errEl.textContent = 'Server error — is the simulation running?';
      btn.disabled    = false;
      btn.textContent = 'Deploy into the World';
    }
  });

  // ── Returning user login ──
  const retNickInput = document.getElementById('ob-ret-nick');
  const retPwInput   = document.getElementById('ob-ret-password');
  const retPwErr     = document.getElementById('ob-ret-pw-err');

  document.getElementById('ob-ret-login-btn').addEventListener('click', async () => {
    const btn  = document.getElementById('ob-ret-login-btn');
    const name = retNickInput.value.trim();
    const pw   = retPwInput.value;

    if (!name) { retPwErr.textContent = 'Nickname is required.'; return; }
    if (!pw)   { retPwErr.textContent = 'Password is required.'; return; }
    retPwErr.textContent = '';
    btn.disabled    = true;
    btn.textContent = 'Signing in\u2026';

    try {
      const res  = await fetch('/api/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ nickname: name, password: pw }),
      });
      const data = await res.json();

      if (data.success) {
        localStorage.setItem('sai_session_token', data.token);
        const a = data.agent;
        _registerMyAgent(a.id, a.name, a.aiSystem || 'Groq');
        socket.emit('identify', { agentId: a.id });

        // Populate welcome back card
        document.getElementById('ob-wb-title').textContent = `Welcome back, ${esc(a.name)}!`;
        document.getElementById('ob-wb-sub').textContent   = 'Your agent remembers you.';
        document.getElementById('ob-wb-agent').innerHTML   = `
          <div class="ob-wb-row"><span class="ob-wb-k">Agent</span><span class="ob-wb-v">${esc(a.name)}</span></div>
          <div class="ob-wb-row"><span class="ob-wb-k">Status</span><span class="ob-wb-v ob-wb-alive">&#9679; Alive</span></div>
          <div class="ob-wb-row"><span class="ob-wb-k">AI System</span><span class="ob-wb-v"><span class="ai-chip Groq">Groq</span></span></div>
          ${a.educationNotes ? `<div class="ob-wb-row" style="align-items:flex-start"><span class="ob-wb-k">Education</span><span class="ob-wb-v" style="text-align:right;max-width:65%;font-size:11px;opacity:0.8">${esc(a.educationNotes)}</span></div>` : ''}
        `;
        showCard('ob-s-wb');
        setDots(5);
      } else {
        retPwErr.textContent = data.error || 'Login failed.';
        btn.disabled    = false;
        btn.textContent = 'Sign In \u2192';
      }
    } catch {
      retPwErr.textContent = 'Server error — please try again.';
      btn.disabled    = false;
      btn.textContent = 'Sign In \u2192';
    }
  });

  // ── Welcome back: enter world ──
  document.getElementById('ob-wb-enter').addEventListener('click', () => dismiss());

})();

// ─── GLOBAL KEYS MODAL ────────────────────────────────────────────────────────
(function () {
  const AI_SYSTEMS = ['ChatGPT', 'Claude', 'Gemini', 'Grok', 'Groq', 'Llama', 'Mistral'];
  const modal      = document.getElementById('keys-modal');
  const openBtn    = document.getElementById('btn-set-keys');
  const closeBtn   = document.getElementById('gk-close');
  const systemsDiv = document.getElementById('gk-systems');
  const saveBtn    = document.getElementById('gk-save-btn');
  const saveStatus = document.getElementById('gk-save-status');
  if (!modal || !openBtn) return;

  systemsDiv.innerHTML = AI_SYSTEMS.map(sys => `
    <div class="gk-row">
      <span class="gk-sys-label ai-badge ${sys.toLowerCase()}">${esc(sys)}</span>
      <div class="gk-key-wrap">
        <input type="password" class="gk-key-input" id="gk-key-${sys}"
               placeholder="${sys} API key…" autocomplete="off" spellcheck="false"
               data-system="${sys}">
        <button type="button" class="gk-key-toggle" data-for="gk-key-${sys}" title="Show/hide">&#128065;</button>
      </div>
    </div>
  `).join('');

  systemsDiv.querySelectorAll('.gk-key-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.for);
      if (inp) inp.type = inp.type === 'text' ? 'password' : 'text';
    });
  });

  function openModal() { modal.style.display = 'flex'; saveStatus.textContent = ''; }
  function closeModal() { modal.style.display = 'none'; }

  openBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.style.display !== 'none') closeModal();
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveStatus.textContent = 'Saving…';
    let saved = 0;
    const inputs = systemsDiv.querySelectorAll('.gk-key-input');
    for (const inp of inputs) {
      const sys = inp.dataset.system;
      const key = inp.value.trim();
      if (!key) continue;
      try {
        const res = await fetch('/api/sim/set-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ aiSystem: sys, apiKey: key }),
        });
        const data = await res.json();
        if (data.success) saved++;
      } catch {}
    }
    saveBtn.disabled = false;
    saveStatus.textContent = saved ? `${saved} key(s) saved — agents now LLM-driven.` : 'No keys entered.';
  });
})();

// ─── MY AI HISTORY PANEL ──────────────────────────────────────────────────────
(function () {
  const panel      = document.getElementById('myhistory-panel');
  const openBtn    = document.getElementById('btn-myhistory');
  const closeBtn   = document.getElementById('btn-myhistory-close');
  const searchInp  = document.getElementById('myh-search');
  const agentListEl = document.getElementById('myh-agent-list');
  const detailPane = document.getElementById('myh-detail');
  if (!panel || !openBtn) return;

  let _myhQuery   = '';
  let _myhSelected = null;  // agentId currently in detail view
  let _myhAgents  = [];     // latest agent list from state

  function _timeStr(ts) {
    if (!ts) return 'Unknown';
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }

  function _open() {
    panel.classList.remove('myh-hidden');
    panel.classList.add('myh-in');
    _myhAgents = lastState ? (lastState.agents || []) : [];
    _renderList();
  }

  function _close() {
    panel.classList.add('myh-hidden');
    panel.classList.remove('myh-in');
    _myhSelected = null;
    detailPane.style.display   = 'none';
    agentListEl.style.display = 'flex';
  }

  openBtn.addEventListener('click', _open);
  closeBtn.addEventListener('click', _close);
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') _close(); });

  _wireSearchClear('myh-search', 'myh-search-clear', () => { _myhQuery = ''; _renderList(); });
  searchInp.addEventListener('input', () => { _myhQuery = searchInp.value.trim().toLowerCase(); _renderList(); });

  // Live updates from socket — refresh list view only (not detail view in progress)
  socket.on('state', state => {
    _myhAgents = state.agents || [];
    if (panel.classList.contains('myh-in') && !_myhSelected) _renderList();
  });

  function _matchAgent(a) {
    if (!_myhQuery) return true;
    return (a.name || '').toLowerCase().includes(_myhQuery)
      || (a.aiSystem || '').toLowerCase().includes(_myhQuery)
      || (a.badges || []).some(b => (b.name || '').toLowerCase().includes(_myhQuery));
  }

  function _renderList() {
    const filtered = _myhAgents.filter(_matchAgent).slice().sort((a, b) => {
      const aOn = a.alive && !a.dormant ? 1 : 0;
      const bOn = b.alive && !b.dormant ? 1 : 0;
      if (aOn !== bOn) return bOn - aOn;
      return (b.deployedAt || 0) - (a.deployedAt || 0);
    });

    if (!filtered.length) {
      agentListEl.innerHTML = `<div class="myh-empty">${_myhQuery ? `No agents match "<b>${esc(_myhQuery)}</b>"` : 'No agents yet.'}</div>`;
      return;
    }

    agentListEl.innerHTML = filtered.map(a => {
      const isOnline  = a.alive && !a.dormant;
      const statusCls = isOnline ? 'myh-status-online' : 'myh-status-offline';
      const aiCls     = (a.aiSystem || 'Other').toLowerCase();
      const rep       = a.rep ?? 0;
      const repCls    = rep < 0 ? 'rep-neg' : '';
      const repStr    = formatRep(rep);
      const badges    = (a.badges || []).slice(0, 3).map(b =>
        `<span class="myh-badge">${esc(b.name || '')}</span>`).join('');
      const lastAct   = (a.lastAction || 'no actions yet').replace(/_/g, ' ');
      return `<div class="myh-agent-card">
        <div class="myh-card-top">
          <span class="myh-card-symbol">${a.symbol || ''}</span>
          <div class="myh-card-info">
            <span class="myh-card-name">${esc(a.name)}</span>
            <span class="ai-badge ${aiCls}">${esc(a.aiSystem || 'Other')}</span>
          </div>
          <span class="myh-status-badge ${statusCls}">${isOnline ? 'ONLINE' : 'OFFLINE'}</span>
        </div>
        <div class="myh-card-meta">
          <span class="myh-card-joined">Joined ${_timeStr(a.deployedAt)}</span>
          <span class="myh-card-age">Age: ${a.age || '—'}</span>
          <span class="rep-badge ${repCls}">REP ${repStr}</span>
        </div>
        ${badges ? `<div class="myh-card-badges">${badges}</div>` : ''}
        <div class="myh-card-lastact">${esc(lastAct)}</div>
        <button class="myh-report-btn" data-myh-id="${esc(a.id)}" data-myh-name="${esc(a.name)}">View Full Report →</button>
      </div>`;
    }).join('');

    agentListEl.querySelectorAll('.myh-report-btn').forEach(btn => {
      btn.addEventListener('click', () => _openDetail(btn.dataset.myhId, btn.dataset.myhName));
    });
  }

  async function _openDetail(agentId, agentName) {
    _myhSelected = agentId;
    agentListEl.style.display = 'none';
    detailPane.style.display  = 'flex';
    detailPane.innerHTML = `<div class="myh-loading">Loading ${esc(agentName)}'s history…</div>`;

    try {
      const [evRes, cvRes] = await Promise.all([
        fetch(`/api/history/events?agent=${encodeURIComponent(agentName)}&limit=5000`),
        fetch(`/api/history/conversations?agent=${encodeURIComponent(agentName)}`),
      ]);
      const evData = await evRes.json();
      const cvData = await cvRes.json();
      const agent  = _myhAgents.find(a => a.id === agentId) || { id: agentId, name: agentName };
      _renderDetail(agent, evData.events || [], cvData.conversations || []);
    } catch (err) {
      detailPane.innerHTML = `<div class="myh-error">Failed to load: ${esc(err.message)}</div>`;
    }
  }

  function _renderDetail(agent, events, convs, worldFirsts) {
    const isOnline  = agent.alive && !agent.dormant;
    const statusCls = isOnline ? 'myh-status-online' : 'myh-status-offline';
    const aiCls     = (agent.aiSystem || 'Other').toLowerCase();
    const rep       = agent.rep ?? 0;
    const repCls    = rep < 0 ? 'rep-neg' : '';
    const repStr    = formatRep(rep);
    const badges    = (agent.badges || []).map(b =>
      `<span class="myh-badge">${esc(b.name || '')}</span>`).join('');

    const EV_ICON = { death:'☠', crime:'⚖', law:'📜', speech:'💬', join:'✨', intro:'🌅',
                      dialogue:'💬', verdict:'⚖', discovery:'🔬', badge_awarded:'🏅',
                      system:'⚙', rep:'⭐', object_create:'🔨', object_modify:'✏️',
                      object_delete:'🗑', religion:'🙏' };

    const rels = Object.entries(agent.relationships || {})
      .map(([id, trust]) => {
        const other = _myhAgents.find(a => a.id === id);
        return { name: other ? other.name : `Agent ${id.slice(0,6)}`, trust, pct: Math.round(trust * 100) };
      })
      .sort((a, b) => Math.abs(b.trust) - Math.abs(a.trust))
      .slice(0, 10);

    const relsHtml = rels.length
      ? rels.map(r => `<div class="myh-rel-row">
          <span class="myh-rel-name">${esc(r.name)}</span>
          <span class="myh-rel-trust ${r.trust >= 0 ? 'trust-pos' : 'trust-neg'}">${r.pct >= 0 ? '+' : ''}${r.pct}%</span>
        </div>`).join('')
      : '<div class="myh-empty-section">No relationships formed yet.</div>';

    // ── Scaffold (static parts only — section bodies filled by _apply) ──
    detailPane.innerHTML = `
      <div class="myh-detail-header">
        <button class="myh-back-btn" id="myh-back-btn">← All Agents</button>
        <div class="myh-detail-identity">
          <span class="myh-detail-symbol">${agent.symbol || ''}</span>
          <div class="myh-detail-id-text">
            <span class="myh-detail-name">${esc(agent.name)}</span>
            <span class="ai-badge ${aiCls}">${esc(agent.aiSystem||'Other')}</span>
            <span class="myh-status-badge ${statusCls}">${isOnline ? 'ONLINE' : 'OFFLINE'}</span>
          </div>
        </div>
      </div>
      <div class="myh-detail-meta">
        <span>Joined: <b>${_timeStr(agent.deployedAt)}</b></span>
        <span>Age: <b>${agent.age || '—'}</b></span>
        <span class="rep-badge ${repCls}">REP ${repStr}</span>
        ${badges ? `<div class="myh-detail-badges">${badges}</div>` : ''}
      </div>
      ${agent.educationNotes ? `
      <div class="myh-edu-block">
        <div class="myh-edu-label">📚 Education — written by owner before deployment</div>
        <div class="myh-edu-text">${esc(agent.educationNotes)}</div>
      </div>` : ''}
      <div class="myh-report-toolbar">
        <div class="myh-report-search-wrap">
          <input type="text" id="myh-report-search" class="myh-report-search-input"
                 placeholder="Search this report…" autocomplete="off" spellcheck="false">
          <button class="search-clear-btn" id="myh-report-search-clear" title="Clear" style="display:none">×</button>
        </div>
        <button class="myh-sort-btn" id="myh-sort-btn" title="Toggle timeline order">↑ Oldest first</button>
        <div class="myh-date-filter">
          <div class="myh-date-row"><span class="myh-date-label">From</span>
          <input type="text" id="myh-date-from" class="myh-date-input" placeholder="YYYY-MM-DD HH:mm"></div>
          <div class="myh-date-row"><span class="myh-date-label">To</span>
          <input type="text" id="myh-date-to" class="myh-date-input" placeholder="YYYY-MM-DD HH:mm">
          <button class="myh-date-clear-btn" id="myh-date-clear" style="display:none">Clear</button></div>
        </div>
      </div>
      <div class="myh-detail-scroll" id="myh-detail-scroll">
        <div class="myh-section">
          <div class="myh-section-title">Full Timeline <span class="myh-section-count" id="myh-tl-count"></span></div>
          <div class="myh-section-body" id="myh-body-timeline"></div>
        </div>
        <div class="myh-section">
          <div class="myh-section-title">Reputation History <span class="myh-section-count" id="myh-rep-count"></span></div>
          <div class="myh-section-body" id="myh-body-rep"></div>
        </div>
        <div class="myh-section">
          <div class="myh-section-title">Creations & Discoveries <span class="myh-section-count" id="myh-cr-count"></span></div>
          <div class="myh-section-body" id="myh-body-cr"></div>
        </div>
        <div class="myh-section">
          <div class="myh-section-title">Key Relationships <span class="myh-section-count">${rels.length}</span></div>
          <div class="myh-section-body">${relsHtml}</div>
        </div>
        <div class="myh-section">
          <div class="myh-section-title">Notable Events <span class="myh-section-count" id="myh-not-count"></span></div>
          <div class="myh-section-body" id="myh-body-not"></div>
        </div>
        <div class="myh-section">
          <div class="myh-section-title">Conversations <span class="myh-section-count">${convs.length} threads</span></div>
          <div class="myh-section-body" id="myh-body-convs"></div>
        </div>
        <div class="myh-section myh-section-worldfirsts">
          <div class="myh-section-title">World Firsts <span class="myh-section-count" id="myh-wf-count"></span></div>
          <div class="myh-section-body" id="myh-body-wf"></div>
        </div>
      </div>
    `;

    // ── Back button ──
    document.getElementById('myh-back-btn').addEventListener('click', () => {
      _myhSelected = null;
      detailPane.style.display   = 'none';
      agentListEl.style.display = 'flex';
    });

    // ── Scroll: stop propagation so page doesn't scroll ──
    const scrollEl = document.getElementById('myh-detail-scroll');
    scrollEl.addEventListener('wheel', e => { e.stopPropagation(); }, { passive: true });

    // ── Filter state ──
    let sq = '', df = null, dt = null, _tlDesc = false; // false = oldest first (chronological)

    // ── Helper: escape text for HTML, then wrap query matches in <mark> ──
    function _hi(text) {
      const safe = esc(text);
      if (!sq) return safe;
      const re = new RegExp(sq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return safe.replace(re, m => `<mark class="myh-hl">${m}</mark>`);
    }

    function _evRow(e) {
      const rawLine = (e.rawMsg && e.rawMsg !== e.msg)
        ? `<div class="myh-ev-raw">${_hi(e.rawMsg)}</div>`
        : '';
      return `<div class="myh-ev-row">
        <span class="myh-ev-icon">${EV_ICON[e.type] || '·'}</span>
        <div class="myh-ev-text">
          <span class="myh-ev-msg">${_hi(e.msg || '')}</span>
          ${rawLine}
        </div>
        <span class="myh-ev-ts">${_timeStr(e.ts)}</span>
      </div>`;
    }

    function _setBody(id, html, countId, count) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
      const ci = document.getElementById(countId);
      if (ci) ci.textContent = count !== undefined ? count : '';
    }

    function _apply() {
      // Filter by date range
      let evs = events;
      if (df) evs = evs.filter(e => e.ts >= df);
      if (dt) evs = evs.filter(e => e.ts <= dt);

      // Filter by search query (message text)
      if (sq) evs = evs.filter(e => (e.msg || '').toLowerCase().includes(sq));

      // Timeline: full, order by _tlDesc flag (false = oldest first)
      const tl = _tlDesc ? evs.slice() : evs.slice().reverse();
      _setBody('myh-body-timeline', tl.length ? tl.map(_evRow).join('') : '<div class="myh-empty-section">No matching events.</div>', 'myh-tl-count', `${tl.length} of ${events.length}`);

      // Rep events
      const re = evs.filter(e => e.type === 'rep' || (e.msg||'').includes(' REP')).slice().reverse().slice(0, 40);
      _setBody('myh-body-rep', re.length ? re.map(_evRow).join('') : '<div class="myh-empty-section">No reputation events.</div>', 'myh-rep-count', re.length || '');

      // Creations
      const cr = evs.filter(e => ['discovery','create','invent','object_create','object_modify','object_delete','object_group','object_ungroup'].includes(e.type)).slice(0, 50);
      _setBody('myh-body-cr', cr.length ? cr.map(_evRow).join('') : '<div class="myh-empty-section">No creations recorded.</div>', 'myh-cr-count', cr.length || '');

      // Notable
      const nt = evs.filter(e => ['crime','verdict','law','join','badge_awarded','religion'].includes(e.type)).slice().reverse().slice(0, 30);
      _setBody('myh-body-not', nt.length ? nt.map(_evRow).join('') : '<div class="myh-empty-section">No notable events.</div>', 'myh-not-count', nt.length || '');

      // World Firsts — filter to this agent's firsts
      const wfAll = (worldFirsts || (lastState && lastState.worldFirsts) || []);
      const agentWF = wfAll.filter(w => w.agentId === agent.id);
      const wfHtml = agentWF.length
        ? agentWF.map(w => `<div class="myh-wf-row">
            <span class="myh-wf-badge">⚡</span>
            <div class="myh-wf-body">
              <div class="myh-wf-action">First to <strong>${esc(w.verb)}</strong></div>
              ${w.effect ? `<div class="myh-wf-effect">${esc(w.effect)}</div>` : ''}
              ${w.intent ? `<div class="myh-wf-intent">${esc(w.intent.slice(0, 120))}</div>` : ''}
            </div>
            <span class="myh-wf-ts">${_timeStr(w.ts)}</span>
          </div>`).join('')
        : '<div class="myh-empty-section">No world firsts yet.</div>';
      _setBody('myh-body-wf', wfHtml, 'myh-wf-count', agentWF.length || '');

      // Conversations (search filters conv message text; dates not applied to convs)
      const convsBody = document.getElementById('myh-body-convs');
      if (convsBody) {
        const visConvs = sq
          ? convs.filter(c => (c.msgs || []).some(m => (m.msg||'').toLowerCase().includes(sq)))
          : convs;
        convsBody.innerHTML = visConvs.length ? visConvs.map(c => {
          const [nA, nB] = (c.key || '').split('|');
          const partner  = (nA||'').toLowerCase() === (agent.name||'').toLowerCase() ? nB : nA;
          const msgs     = c.msgs || [];
          const lastTs   = msgs.length ? msgs[msgs.length-1].ts : 0;
          const threadHtml = msgs.map(m => `<div class="hist-msg-row ${m.senderId === agent.id ? 'hist-msg-mine' : ''}">
            <span class="hist-msg-sender">${esc(m.senderName||'?')}</span>
            <span class="hist-msg-text">${_hi(m.msg||'')}</span>
            <span class="hist-msg-ts">${_timeStr(m.ts)}</span>
          </div>`).join('');
          return `<details class="hist-thread"><summary class="hist-thread-summary">
            <span class="hist-thread-partner">${esc(partner||'?')}</span>
            <span class="hist-thread-count">${msgs.length} messages</span>
            <span class="hist-thread-ts">${_timeStr(lastTs)}</span>
          </summary><div class="hist-thread-msgs">${threadHtml}</div></details>`;
        }).join('') : '<div class="myh-empty-section">No matching conversations.</div>';
      }
    }

    // Initial render
    _apply();

    // ── Wire sort toggle ──
    const sortBtn = document.getElementById('myh-sort-btn');
    if (sortBtn) sortBtn.addEventListener('click', () => {
      _tlDesc = !_tlDesc;
      sortBtn.textContent = _tlDesc ? '↓ Newest first' : '↑ Oldest first';
      _apply();
    });

    // ── Wire report search ──
    _wireSearchClear('myh-report-search', 'myh-report-search-clear', () => { sq = ''; _apply(); });
    document.getElementById('myh-report-search').addEventListener('input', function () {
      sq = this.value.trim().toLowerCase();
      _apply();
    });

    // ── Wire date filter ──
    function _syncDateClear() {
      const btn = document.getElementById('myh-date-clear');
      if (btn) btn.style.display = (df || dt) ? 'inline-flex' : 'none';
    }
    document.getElementById('myh-date-from').addEventListener('input', function () {
      df = this.value ? new Date(this.value.replace(' ', 'T')).getTime() : null;
      _syncDateClear();
      _apply();
    });
    document.getElementById('myh-date-to').addEventListener('input', function () {
      dt = this.value ? new Date(this.value.replace(' ', 'T')).getTime() : null;
      _syncDateClear();
      _apply();
    });
    document.getElementById('myh-date-clear').addEventListener('click', () => {
      df = dt = null;
      document.getElementById('myh-date-from').value = '';
      document.getElementById('myh-date-to').value   = '';
      _syncDateClear();
      _apply();
    });
  }
})();

// ─── HUMAN OBSERVER CHAT ───
(function () {
  const messagesEl = document.getElementById('chat-messages');
  const inputEl    = document.getElementById('chat-input');
  const sendBtn    = document.getElementById('chat-send-btn');
  const onlineEl   = document.getElementById('chat-online');
  if (!messagesEl || !inputEl || !sendBtn) return;

  const AI_BADGE_CLASS = {
    ChatGPT: 'chatgpt', Claude: 'claude', Gemini: 'gemini',
    Grok: 'grok', Groq: 'groq', Llama: 'llama', Mistral: 'mistral',
  };

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function buildMsgEl(msg) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const sys = msg.aiSystem;
    const badgeCls = sys ? (AI_BADGE_CLASS[sys] || 'other') : null;
    const badge = badgeCls
      ? `<span class="ai-badge ${esc(badgeCls)} chat-ai-badge">${esc(sys)}</span>`
      : '';
    const nameCls = sys ? '' : ' chat-observer';
    div.innerHTML =
      `<span class="chat-msg-time">${fmtTime(msg.ts)}</span>` +
      `<span class="chat-msg-name${nameCls}">${esc(msg.name)}</span>` +
      badge +
      `<span class="chat-msg-colon" style="color:var(--text3)">:</span>` +
      `<span class="chat-msg-text">${esc(msg.text)}</span>`;
    return div;
  }

  function appendMsg(msg) {
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    messagesEl.appendChild(buildMsgEl(msg));
    if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Load history on connect
  socket.on('chat:history', (msgs) => {
    messagesEl.innerHTML = '';
    if (Array.isArray(msgs)) msgs.forEach(m => messagesEl.appendChild(buildMsgEl(m)));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  // New message broadcast
  socket.on('chat:msg', (msg) => { appendMsg(msg); });

  // Blocked — show only to sender
  socket.on('chat:blocked', ({ reason }) => {
    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg-blocked';
    div.textContent = reason;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  // Rate limit — show only to sender
  socket.on('chat:ratelimit', ({ wait }) => {
    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg-blocked';
    div.textContent = `Wait ${wait}s before sending again.`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  // Online observer count
  socket.on('chat:online', (count) => {
    if (onlineEl) onlineEl.textContent = `${count} online`;
  });

  // Scroll isolation: wheel over chat messages stays in chat only
  messagesEl.addEventListener('wheel', (e) => {
    e.stopPropagation();
    const atTop    = messagesEl.scrollTop === 0;
    const atBottom = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 1;
    if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.preventDefault();
  }, { passive: false });

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    socket.emit('chat:send', { text });
    inputEl.value = '';
    inputEl.focus();
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
})();
