'use strict';
/* ================================================================
   SociopathAI — Starmap v5
   Clean rewrite. Stable physics, hard walls, correct camera math.

   Camera model:  screenX = worldX * cam.scale + cam.panX
                  screenY = worldY * cam.scale + cam.panY

   World space is centered at (0,0).
   Agents are always clamped inside ±WORLD_W / ±WORLD_H.
   ================================================================ */

(function () {

// ── Small utilities ────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ── Visual helpers ─────────────────────────────────────────────────────────────

/** Returns the dominant hue (0-360) for an agent based on status. */
function agentHue(a) {
  if ((a.beliefs?.crimes || 0) > 2)                          return   0; // red
  if ((a.health ?? 100) < 40)                                return 210; // grey-blue
  if ((a.traits?.piety ?? 0) > 70 && a.beliefs?.religion)   return 275; // purple
  return 195; // default cyan-blue
}

/** CSS color string from hue, sat%, lit%. */
function hsl(h, s, l) { return `hsl(${h},${s}%,${l}%)`; }

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

/** Parse hex color → rgba string */
function hexRgba(hex, a) {
  if (!hex || hex.length < 7) return `rgba(136,170,255,${a.toFixed(2)})`;
  const r = parseInt(hex.slice(1,3),16)||100;
  const g = parseInt(hex.slice(3,5),16)||150;
  const b = parseInt(hex.slice(5,7),16)||255;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/** Lighten a hex color (mix toward white) */
function hexLighten(hex, amt) {
  if (!hex || hex.length < 7) return '#aaccff';
  const r = Math.min(255, parseInt(hex.slice(1,3),16) + Math.round(255*amt));
  const g = Math.min(255, parseInt(hex.slice(3,5),16) + Math.round(255*amt));
  const b = Math.min(255, parseInt(hex.slice(5,7),16) + Math.round(255*amt));
  return `rgb(${r},${g},${b})`;
}

// ── Physics & layout constants ─────────────────────────────────────────────────

const NODE_R      = 13;       // node radius in world-px
const MAX_SPEED   = 0.22;     // world-px per frame — slow drift
const DAMPING     = 0.88;
const SPRING_K    = 0.00010;  // spring toward target separation distance
const MIN_DIST    = 120;      // hard minimum gap between any two agents
const SEP_K       = 0.15;     // separation floor force coefficient
const HOSTILE_K   = 12;       // extra repulsion for hostile pairs

// World half-extents — agents CANNOT leave these bounds
const WORLD_W     = 380;
const WORLD_H     = 290;

// Camera
const MIN_SCALE   = 0.15;
const MAX_SCALE   = 8.0;
const CAM_LERP    = 0.10;     // camera smoothing

// Background stars
const STAR_COUNT  = 200;


// ── Starmap class ──────────────────────────────────────────────────────────────

class Starmap {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');

    /*  Camera (both the target and the smoothed rendering value share the same
        structure so lerp is trivial).
          screenX = worldX * cam.scale + cam.panX
          screenY = worldY * cam.scale + cam.panY                           */
    this.cam  = { panX: 0, panY: 0, scale: 1 };
    this.tCam = { panX: 0, panY: 0, scale: 1 };

    // id → { x, y, vx, vy, agent, bloomT, signals:[] }
    this.nodes = new Map();

    // [{ a:id, b:id, trust:number, sameReligion:bool }] — from server
    this.connections = [];

    // Transient visual effects
    this.deathAnims  = [];   // [{ x, y, t }]
    this.flowers     = [];   // [{ x, y, hue, t }]
    this.trackPulses = [];   // [{ x, y, t }]
    this._novelEffects = []; // [{ x, y, t, color, symbol, wfId }]

    // World objects (inventory items sent from server as worldObjects array)
    this.worldObjects       = [];        // [{ ...serverData, x, y, spawnAnimT, pulsePhase }]
    this._catGroupPositions = new Map(); // "agentId:category" → {wx, wy, agentId, category, objs}
    this.onCategoryClick    = null;      // (agentId, category, objs, screenX, screenY) => void

    // Interaction state
    this.highlightedAgent = null;
    this.trackingId       = null;
    this.collapseState    = null;
    this.lastLogLen       = 0;

    // Public callbacks set by app.js
    this.onAgentClick            = null;   // (agentId|null) => void
    this.onTrackRelease          = null;   // () => void
    this.onObjectClick           = null;   // (worldObject, screenX, screenY) => void
    this.onObjectPositionUpdate  = null;   // (screenX, screenY) => void  — called every frame while popup open
    this.onObjectClose           = null;   // () => void  — called when objects collapse
    this.onConnectionClick       = null;   // (conn) => void

    // Last-message timestamps per pair (pairKey → ts), injected from update()
    this._connLastTs = new Map();

    // Hover highlight from external sources (card hover etc.) — separate from click-highlight
    this._hoverHighlightId = null;

    // Inventory item orbit state
    this._expandedAgentIds   = new Set();  // agentIds whose items are currently shown
    this._orbitPositions     = new Map();  // objId → { wx, wy }  rebuilt each frame for visible objs
    this._hoveredWObj        = null;       // world object currently under cursor
    this._openedWObj         = null;       // world object whose info popup is open (camera-follow)

    // Connection hover tooltip
    this._mouseScreen   = null;   // { x, y } in screen px, updated by mousemove
    this._hoveredConn   = null;   // connection object currently hovered
    this._tooltipEl     = this._createTooltip();

    // Line particles — flowing dots along connection lines
    this._lineParticles      = new Map();  // pairKey → [{progress, speed, dir}]
    this._lastParticleUpdate = 0;

    // Activity particles — emitted from active agent nodes
    this._activityParticles = [];   // [{x,y,vx,vy,life,maxLife,r,color,agentId}]
    this._lastEmitT         = 0;   // timestamp of last emission pass

    // Line energy flows — fast directional dots on recently-active connection lines
    this._lineFlows         = [];   // [{key,ax,ay,bx,by,progress,speed,color}]

    // World Events — hex-vertex landmark nodes (confirmed events + pending proposals)
    this.worldEvents      = [];
    this.pendingProposals = [];
    this._selectedWorldEvent  = null;   // currently clicked event (for popup)
    this._wePopupEl           = this._createWEPopup();
    this._bgHexVerts  = null;           // lazily computed from background grid math
    this._eventHexPos = new Map();      // event.id → {x, y, angle, color} in world space
    this._selectedAgentId             = null;
    this._selectedAgentConnectedEvents = new Set();

    // Dormant fade-out: nodes that are fading away because owner went offline
    // agentId → { x, y, t, agent }
    this._dormantFades = new Map();

    // Persistent position memory — survives beyond the 3s fade window
    // agentId → { x, y }
    this._lastPositions = new Map();

    // Fade-in for waking agents: agentId → wakeTimestamp
    this._awakingNodes = new Map();

    // Internal drag tracking
    this._drag  = { on: false, sx: 0, sy: 0, spx: 0, spy: 0, moved: false };
    this._pinch = null;

    // Background stars (generated once in world space)
    this._stars = Array.from({ length: STAR_COUNT }, () => ({
      x:  (Math.random() - 0.5) * (WORLD_W * 2 + 200),
      y:  (Math.random() - 0.5) * (WORLD_H * 2 + 200),
      r:   Math.random() * 1.0 + 0.2,
      a:   Math.random() * 0.22 + 0.05,
      ph:  Math.random() * Math.PI * 2,
    }));

    this._raf = null;

    this._initCamera();
    this._bindEvents();
  }

  // ── Tooltip ────────────────────────────────────────────────────────────────

  _createTooltip() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'pointer-events:none', 'display:none',
      'background:rgba(4,10,24,0.94)', 'border:1px solid rgba(80,130,200,0.45)',
      'border-radius:7px', 'padding:7px 11px', 'font-size:11px',
      'font-family:"JetBrains Mono",monospace', 'color:#c8d8f0',
      'white-space:pre-wrap', 'max-width:320px', 'word-break:break-word', 'z-index:8000',
      'box-shadow:0 0 12px rgba(60,120,200,0.2)',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  _showConnTooltip(conn, sx, sy) {
    const ndA = this.nodes.get(conn.a);
    const ndB = this.nodes.get(conn.b);
    if (!ndA || !ndB) return;
    const nameA = ndA.agent.name, nameB = ndB.agent.name;
    const count = conn.dialogueCount || 0;
    const freq  = count >= 10 ? 'frequent partners' : count >= 3 ? 'regular conversation' : count === 1 ? 'spoke once' : `${count} exchanges`;
    const trustPct = Math.round(Math.abs(conn.trust) * 100);
    const trustStr = conn.trust >= 0 ? `+${(conn.trust * 100).toFixed(0)}%` : `${(conn.trust * 100).toFixed(0)}%`;
    const desc  = conn.design?.description || null;
    // Find last message timestamp from conversations data (injected via update)
    const lastTs = this._connLastTs?.get([conn.a, conn.b].sort().join('|')) || null;
    const lastTsStr = lastTs ? new Date(lastTs).toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' }) : null;
    // Relationship state label
    const relType   = conn.relationType || 'neutral';
    const relLabels = { war: '⚔️ AT WAR', alliance: '🤝 ALLIED', hostile: '😠 HOSTILE', neutral: '' };
    const relLabel  = relLabels[relType] || '';
    const relColor  = relType === 'war' ? '#ff4444' : relType === 'alliance' ? '#ffd700' : relType === 'hostile' ? '#ff8c00' : '#aaccee';

    this._tooltipEl.innerHTML =
      `<b style="color:#e8f4ff">${nameA} ↔ ${nameB}</b>` +
      (relLabel ? `<span style="color:${relColor};font-weight:700;margin-left:6px">${relLabel}</span>` : '') +
      `<br>${freq}` +
      (trustPct ? ` · trust ${trustStr}` : '') +
      (conn.sameReligion ? ' · same faith' : '') +
      (desc ? `<br><span style="color:#aaccee;font-style:italic">"${desc}"</span>` : '') +
      (lastTsStr ? `<br><span style="color:#6688aa">last message ${lastTsStr}</span>` : '');
    const el = this._tooltipEl;
    el.style.display = 'block';
    // Position near cursor, keep on screen
    const W = window.innerWidth, H = window.innerHeight;
    const ew = el.offsetWidth + 16, eh = el.offsetHeight + 16;
    el.style.left = (sx + 14 + ew > W ? sx - ew : sx + 14) + 'px';
    el.style.top  = (sy + 14 + eh > H ? sy - eh : sy + 14) + 'px';
  }

  _hideConnTooltip() {
    this._tooltipEl.style.display = 'none';
    this._hoveredConn = null;
  }

  _showWOTooltip(obj, sx, sy) {
    const creatorNd = obj.agentIds && obj.agentIds[0] ? this.nodes.get(obj.agentIds[0]) : null;
    const creator   = creatorNd ? creatorNd.agent.name : 'unknown';
    const age       = obj.spawnTs ? Math.round((Date.now() - obj.spawnTs) / 1000) : null;
    const ageStr    = age !== null ? (age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age/60)}m ago` : `${Math.round(age/3600)}h ago`) : '';
    const el = this._tooltipEl;
    el.innerHTML =
      `<b style="color:#e8f4ff">${obj.name}</b><br>` +
      `<span style="opacity:0.7;font-size:10px">${obj.type}</span>` +
      (obj.desc ? `\n<span style="opacity:0.6;font-size:10px">${obj.desc}</span>` : '') +
      `<br><span style="opacity:0.5;font-size:9px">by ${creator}${ageStr ? ' · ' + ageStr : ''}</span>`;
    el.style.display = 'block';
    const W = window.innerWidth, H = window.innerHeight;
    const ew = el.offsetWidth + 16, eh = el.offsetHeight + 16;
    el.style.left = (sx + 14 + ew > W ? sx - ew : sx + 14) + 'px';
    el.style.top  = (sy + 14 + eh > H ? sy - eh : sy + 14) + 'px';
  }

  _hideWOTooltip() {
    if (!this._hoveredWObj) return;
    this._tooltipEl.style.display = 'none';
    this._hoveredWObj = null;
  }

  _showAgentTooltip(nd, sx, sy) {
    const a      = nd.agent;
    const rep    = a.rep ?? 0;
    const repStr = formatRep(rep);
    const status = a.statusMessage || a.speech || null;
    const eduNotes = a.educationNotes || null;
    const el     = this._tooltipEl;
    el.innerHTML =
      `<b style="color:#e8f4ff">${a.symbol ? a.symbol + ' ' : ''}${a.name}</b>\n` +
      `REP <b style="color:${rep < 0 ? '#f85149' : '#3fb950'}">${repStr}</b>` +
      (a.age ? ` · age <b>${a.age}</b>` : '') +
      (status ? `\n<span style="color:#88aacc;font-style:italic">"${status}"</span>` : '') +
      (eduNotes
        ? `\n<span style="color:#7090a8;font-size:9px">📚 Education: </span><span style="color:#88a8c8;font-size:9.5px;font-style:italic">${eduNotes.slice(0, 200)}${eduNotes.length > 200 ? '…' : ''}</span>`
        : '');
    el.style.display = 'block';
    const W = window.innerWidth, H = window.innerHeight;
    const ew = el.offsetWidth + 16, eh = el.offsetHeight + 16;
    el.style.left = (sx + 14 + ew > W ? sx - ew : sx + 14) + 'px';
    el.style.top  = (sy + 14 + eh > H ? sy - eh : sy + 14) + 'px';
  }

  _hideAgentTooltip() {
    if (this._hoveredAgentId) {
      this._tooltipEl.style.display = 'none';
      this._hoveredAgentId = null;
    }
  }

  /**
   * Compute the edge start/end of a connection line in world space.
   * Offsets each endpoint by (NODE_R + 2) along the AB direction so lines
   * start/end at the node's outer edge, not its center.
   */
  static _edgePoints(ndA, ndB) {
    const dx  = ndB.x - ndA.x;
    const dy  = ndB.y - ndA.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux  = dx / len;
    const uy  = dy / len;
    const gap = NODE_R + 2;
    return {
      ax: ndA.x + ux * gap,  ay: ndA.y + uy * gap,
      bx: ndB.x - ux * gap,  by: ndB.y - uy * gap,
    };
  }

  /** Signed distance from point (px,py) to segment (ax,ay)→(bx,by) in world-px. */
  static _ptSegDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // ── Camera initialisation ──────────────────────────────────────────────────

  /** Set initial camera so the whole world boundary fits on screen. */
  _initCamera() {
    const W  = this.canvas.width  || 640;
    const H  = this.canvas.height || 500;
    const sc = clamp(
      Math.min((W - 40) / (WORLD_W * 2), (H - 40) / (WORLD_H * 2)),
      MIN_SCALE, MAX_SCALE
    );
    this.cam.scale  = sc;  this.tCam.scale = sc;
    this.cam.panX   = W / 2;  this.tCam.panX  = W / 2;
    this.cam.panY   = H / 2;  this.tCam.panY  = H / 2;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start() {
    if (this._raf) return;
    const loop = t => { this._raf = requestAnimationFrame(loop); this._tick(t); };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  /** Called every time a new server state arrives. */
  update(state) {
    const now = performance.now();
    // Active (visible) agents: alive AND not dormant
    const activeIds  = new Set(state.agents.filter(a => a.alive && !a.dormant).map(a => a.id));
    const dormantIds = new Set(state.agents.filter(a => a.alive && a.dormant).map(a => a.id));
    const prev = this.nodes.size;

    // Handle transitions for existing active nodes
    for (const [id, nd] of this.nodes) {
      if (dormantIds.has(id)) {
        // Agent just went dormant → start fade-out, remove from active nodes
        if (!this._dormantFades.has(id)) {
          this._dormantFades.set(id, { x: nd.x, y: nd.y, t: now, agent: nd.agent });
        }
        this.nodes.delete(id);
      } else if (!activeIds.has(id)) {
        // Truly dead (or missing) — death anim
        if (!this._dormantFades.has(id)) {
          this.deathAnims.push({ x: nd.x, y: nd.y, t: now });
        }
        this.nodes.delete(id);
      }
    }

    // Expire completed fade-outs (3 s)
    for (const [id, fade] of this._dormantFades) {
      if (now - fade.t > 3000) this._dormantFades.delete(id);
    }

    // Expire completed fade-ins (1.5 s)
    for (const [id, wakeT] of this._awakingNodes) {
      if (now - wakeT > 1500) this._awakingNodes.delete(id);
    }

    // Add/refresh active nodes
    for (const a of state.agents) {
      if (!a.alive || a.dormant) continue;

      if (!this.nodes.has(a.id)) {
        // Waking from dormant → prefer _lastPositions, then dormant fade pos, then edge spawn
        const lastPos  = this._lastPositions.get(a.id);
        const dormFade = this._dormantFades.get(a.id);
        const isReturning = !!(lastPos || dormFade);
        const p = lastPos
               || (dormFade ? { x: dormFade.x, y: dormFade.y } : null)
               || this._spawnPos(this.nodes.size);
        if (dormFade) this._dormantFades.delete(a.id);
        this.nodes.set(a.id, {
          x: p.x, y: p.y, vx: 0, vy: 0,
          agent: a, bloomT: now, signals: [],
          _wanderAngle: Math.random() * Math.PI * 2,
          _wanderNextT: performance.now() + 500 + Math.random() * 2000,
        });
        // Trigger fade-in animation for returning agents
        if (isReturning) this._awakingNodes.set(a.id, now);
      } else {
        this.nodes.get(a.id).agent = a;
      }
    }

    // World Events + pending proposals
    this.worldEvents      = Array.isArray(state.worldEvents)      ? state.worldEvents      : [];
    this.pendingProposals = Array.isArray(state.pendingProposals) ? state.pendingProposals : [];
    // Clean up cached hex positions for events that no longer exist
    { const _live = new Set(this.worldEvents.map(e => e.id));
      for (const id of this._eventHexPos.keys()) { if (!_live.has(id)) this._eventHexPos.delete(id); } }
    // Force re-cache any entry that is missing color or meteorAngle
    for (const we of this.worldEvents) {
      const cached = this._eventHexPos.get(we.id);
      if (cached && (!cached.color || cached.color.length !== 7 || cached.meteorAngle === undefined)) {
        this._eventHexPos.delete(we.id);
      }
    }

    // Connections — guard against missing/null
    this.connections = Array.isArray(state.connections) ? state.connections : [];

    // Signal pulses for isolated agents
    for (const [id, nd] of this.nodes) {
      const nc   = this.connections.filter(c => c.a === id || c.b === id).length;
      const last = nd.signals[nd.signals.length - 1];
      if (nc < 3 && (!last || now - last.t > 2600)) {
        nd.signals.push({ t: now, maxR: 55 + Math.random() * 40 });
      }
    }

    // New event log entries
    const evLog = state.eventLog || [];
    for (const ev of evLog.slice(this.lastLogLen)) {
      this._onEvent(ev);
      // Apply movement impulse so events cause agents to physically react
      if (ev.agentId && this.nodes.has(ev.agentId)) {
        const imp = this._eventImpulse(ev);
        this.applyMoveBias(ev.agentId, imp.dx, imp.dy);
      }
    }
    this.lastLogLen = evLog.length;

    // ── Inventory items sync (sent as worldObjects from server) ──
    const serverObjs = state.worldObjects || [];
    const serverIds  = new Set(serverObjs.map(o => o.id));

    // Clean up removed items
    for (const o of this.worldObjects) {
      if (!serverIds.has(o.id)) this._orbitPositions.delete(o.id);
    }
    // Remove agent from expanded set if they left
    for (const aid of this._expandedAgentIds) {
      if (!this.nodes.has(aid)) this._expandedAgentIds.delete(aid);
    }

    // Rebuild worldObjects preserving animation state for existing items
    const prevMap = new Map(this.worldObjects.map(o => [o.id, o]));
    this.worldObjects = serverObjs.map(sObj => {
      const prev = prevMap.get(sObj.id);
      return { ...sObj, x: 0, y: 0,
        spawnAnimT: prev?.spawnAnimT ?? performance.now(),
        pulsePhase: prev?.pulsePhase ?? Math.random() * Math.PI * 2,
      };
    });

    // Extract last-message timestamps per pair from event log (for tooltip)
    for (const ev of state.eventLog || []) {
      if (ev.type === 'dialogue' && ev.agentId && ev.partnerAgentId) {
        const key = [ev.agentId, ev.partnerAgentId].sort().join('|');
        const cur = this._connLastTs.get(key) || 0;
        if ((ev.ts || 0) > cur) this._connLastTs.set(key, ev.ts);
      }
    }

    // Camera
    if (prev === 0 && this.nodes.size > 0) {
      this.resetPositions(); // first load: reset + fit
    } else if (this.nodes.size > prev) {
      this.fitAll();         // new agent joined: just refit
    }
  }

  /** Zoom and pan camera so all agents are visible. */
  fitAll() {
    if (this.nodes.size === 0) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const nd of this.nodes.values()) {
      x0 = Math.min(x0, nd.x); x1 = Math.max(x1, nd.x);
      y0 = Math.min(y0, nd.y); y1 = Math.max(y1, nd.y);
    }
    const pad   = NODE_R * 5 + 60;
    const spanX = Math.max(x1 - x0, 80) + pad * 2;
    const spanY = Math.max(y1 - y0, 60) + pad * 2;
    const W     = this.canvas.width  || 640;
    const H     = this.canvas.height || 500;
    const sc    = clamp(Math.min(W / spanX, H / spanY), MIN_SCALE, MAX_SCALE);
    const cx    = (x0 + x1) / 2;
    const cy    = (y0 + y1) / 2;
    this.tCam.scale = sc;
    this.tCam.panX  = W / 2 - cx * sc;
    this.tCam.panY  = H / 2 - cy * sc;
  }

  /** Redistribute all agents evenly in spawn zone then fit camera. */
  resetPositions() {
    // Initial load: spread agents across the centre using golden-angle spiral
    const nds = [...this.nodes.values()];
    const phi = Math.PI * (3 - Math.sqrt(5));   // golden angle ≈ 137.5°
    nds.forEach((nd, i) => {
      const rNorm = Math.sqrt((i + 0.5) / Math.max(nds.length, 1));
      const angle = i * phi;
      nd.x  = clamp(Math.cos(angle) * rNorm * WORLD_W * 0.55, -WORLD_W + 20, WORLD_W - 20);
      nd.y  = clamp(Math.sin(angle) * rNorm * WORLD_H * 0.55, -WORLD_H + 20, WORLD_H - 20);
      nd.vx = 0; nd.vy = 0;
    });
    this.fitAll();
  }

  /** Toggle highlight on an agent. Returns new highlighted id or null. */
  highlightAgent(id) {
    this.highlightedAgent = (id && id !== this.highlightedAgent) ? id : null;
    return this.highlightedAgent;
  }

  /** Toggle camera tracking of an agent. Returns true if now tracking. */
  trackAgent(id) {
    if (this.trackingId === id) { this.trackingId = null; return false; }
    this.trackingId = id;
    const nd = this.nodes.get(id);
    if (nd) {
      const W  = this.canvas.width  || 640;
      const H  = this.canvas.height || 500;
      const sc = Math.max(this.tCam.scale, 2.0);
      this.tCam.scale = sc;
      this.tCam.panX  = W / 2 - nd.x * sc;
      this.tCam.panY  = H / 2 - nd.y * sc;
      this.trackPulses.push({ x: nd.x, y: nd.y, t: performance.now() });
    }
    return true;
  }

  /** One-shot locate: fly camera to agent + burst pulse rings. No tracking mode. */
  locateAgent(id) {
    const nd = this.nodes.get(id);
    if (!nd) return;
    const W  = this.canvas.width  || 640;
    const H  = this.canvas.height || 500;
    const sc = clamp(Math.max(this.tCam.scale, 1.8), 1.5, MAX_SCALE);
    this.tCam.scale = sc;
    this.tCam.panX  = W / 2 - nd.x * sc;
    this.tCam.panY  = H / 2 - nd.y * sc;
    // Three staggered pulse rings so the node is easy to spot
    const now = performance.now();
    for (let i = 0; i < 3; i++) {
      this.trackPulses.push({ x: nd.x, y: nd.y, t: now - i * 180 });
    }
    // Also highlight the node on the starmap
    this.highlightedAgent = id;
    if (this.onAgentClick) this.onAgentClick(id);
  }

  /** Highlight the connection line between two agents by pairKey; pan camera to midpoint. */
  highlightConnection(pairKey) {
    const conn = this.connections.find(c =>
      (c.a + '|' + c.b === pairKey) || (c.b + '|' + c.a === pairKey)
    );
    if (!conn) return;
    this._hoveredConn = conn;
    const ndA = this.nodes.get(conn.a);
    const ndB = this.nodes.get(conn.b);
    if (ndA && ndB) {
      const mx  = (ndA.x + ndB.x) / 2;
      const my  = (ndA.y + ndB.y) / 2;
      const W   = this.canvas.width  || 640;
      const H   = this.canvas.height || 500;
      const sc  = clamp(Math.max(this.tCam.scale, 1.5), 1.2, MAX_SCALE);
      this.tCam.scale = sc;
      this.tCam.panX  = W / 2 - mx * sc;
      this.tCam.panY  = H / 2 - my * sc;
      const now = performance.now();
      this.trackPulses.push({ x: ndA.x, y: ndA.y, t: now });
      this.trackPulses.push({ x: ndB.x, y: ndB.y, t: now - 120 });
    }
  }

  /** Briefly pulse an agent node (from card hover etc.) without changing highlight state. */
  pulseAgent(id) {
    const nd = this.nodes.get(id);
    if (nd) this.trackPulses.push({ x: nd.x, y: nd.y, t: performance.now() });
  }

  /**
   * Apply a velocity impulse + redirect wander for an agent.
   * dx/dy are normalised-ish bias directions (-1..1 each).
   */
  applyMoveBias(id, dx, dy) {
    const nd = this.nodes.get(id);
    if (!nd) return;
    const IMPULSE = 0.09;
    nd.vx += dx * IMPULSE;
    nd.vy += dy * IMPULSE;
    // Steer wander toward impulse direction so the drift continues
    if (Math.hypot(dx, dy) > 0.01) {
      nd._wanderAngle = Math.atan2(dy, dx);
      nd._wanderNextT = performance.now() + 2500 + Math.random() * 1500;
    }
  }

  /** Return a movement bias {dx,dy} appropriate for an event type. */
  _eventImpulse(ev) {
    const r = () => (Math.random() - 0.5) * 2;
    switch (ev.type) {
      case 'dialogue':   return { dx: r() * 1.2, dy: r() * 1.2 };
      case 'steal':
      case 'crime':      return { dx: r() * 2.5, dy: r() * 2.5 };
      case 'verdict':    return { dx: r() * 1.8, dy: r() * 1.8 };
      case 'action':     return { dx: r() * 0.9, dy: r() * 0.9 };
      default:           return { dx: r() * 0.5, dy: r() * 0.5 };
    }
  }

  triggerCollapse() {
    this.collapseState = { t: performance.now() };
  }

  // ── Spawn helper ───────────────────────────────────────────────────────────

  /** New agents spawn at the world edge and drift inward as relationships form. */
  _spawnPos(idx) {
    const angle = idx * 2.399963 + Math.random() * 0.4;  // golden angle spread + jitter
    const rx    = WORLD_W * (0.76 + Math.random() * 0.16);
    const ry    = WORLD_H * (0.76 + Math.random() * 0.16);
    return {
      x: clamp(Math.cos(angle) * rx, -WORLD_W + 20, WORLD_W - 20),
      y: clamp(Math.sin(angle) * ry, -WORLD_H + 20, WORLD_H - 20),
    };
  }

  // ── Physics ────────────────────────────────────────────────────────────────

  _physics() {
    const all = [...this.nodes.values()];
    if (!all.length) return;

    // Fast lookups: trust and dialogue-count per pair
    const trustMap = new Map();
    const dcMap    = new Map();
    for (const c of this.connections) {
      const kAB = c.a + '|' + c.b, kBA = c.b + '|' + c.a;
      trustMap.set(kAB, c.trust); trustMap.set(kBA, c.trust);
      dcMap.set(kAB, c.dialogueCount || 0); dcMap.set(kBA, c.dialogueCount || 0);
    }

    for (let i = 0; i < all.length; i++) {
      const nd = all[i];
      let fx = 0, fy = 0;

      for (let j = 0; j < all.length; j++) {
        if (i === j) continue;
        const ot   = all[j];
        const dx   = ot.x - nd.x;
        const dy   = ot.y - nd.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        const ux   = dx / dist;
        const uy   = dy / dist;
        const key  = nd.agent.id + '|' + ot.agent.id;
        const trust = trustMap.get(key) ?? null;
        const dc    = dcMap.get(key) || 0;

        // ── Hard separation floor: agents never closer than MIN_DIST ──
        if (dist < MIN_DIST) {
          const push = SEP_K * (MIN_DIST - dist);
          fx -= ux * push;
          fy -= uy * push;
          continue;   // floor takes priority — skip spring this step
        }

        // ── Relationship spring: target distance depends on communication ──
        let td;
        if (dc > 0) {
          // Talked before: attract — more dialogue = closer target (floor: 130px)
          td = Math.max(130, 260 - Math.min(dc, 20) * 6.5);
        } else if (trust !== null && trust < -0.15) {
          // Hostile with no prior dialogue: push far apart
          td = 370;
        } else {
          // Unknown / neutral: comfortable spacing
          td = 270;
        }

        const sf = SPRING_K * (dist - td);
        fx += ux * sf;
        fy += uy * sf;

        // ── Extra repulsion for hostile pairs ──
        if (trust !== null && trust < -0.10) {
          const rf = HOSTILE_K * Math.abs(trust) / dist;
          fx -= ux * rf;
          fy -= uy * rf;
        }
      }

      // ── Wander drift: slowly-rotating autonomous force so agents never freeze ──
      const nowW = performance.now();
      if (!nd._wanderNextT || nowW >= nd._wanderNextT) {
        nd._wanderAngle = (nd._wanderAngle || 0) + (Math.random() - 0.5) * Math.PI * 0.9;
        nd._wanderNextT = nowW + 1200 + Math.random() * 2800;
      }
      const WANDER_F = 0.0035;
      fx += Math.cos(nd._wanderAngle || 0) * WANDER_F;
      fy += Math.sin(nd._wanderAngle || 0) * WANDER_F;

      nd.vx = (nd.vx + fx) * DAMPING;
      nd.vy = (nd.vy + fy) * DAMPING;

      // Clamp speed
      const spd = Math.hypot(nd.vx, nd.vy);
      if (spd > MAX_SPEED) { nd.vx *= MAX_SPEED / spd; nd.vy *= MAX_SPEED / spd; }

      nd.x += nd.vx;
      nd.y += nd.vy;

      // Hard wall bounce — agents never leave world bounds
      if (nd.x < -WORLD_W) { nd.x = -WORLD_W; nd.vx =  Math.abs(nd.vx) * 0.3; }
      if (nd.x >  WORLD_W) { nd.x =  WORLD_W; nd.vx = -Math.abs(nd.vx) * 0.3; }
      if (nd.y < -WORLD_H) { nd.y = -WORLD_H; nd.vy =  Math.abs(nd.vy) * 0.3; }
      if (nd.y >  WORLD_H) { nd.y =  WORLD_H; nd.vy = -Math.abs(nd.vy) * 0.3; }
    }
  }

  // ── Frame tick ─────────────────────────────────────────────────────────────

  _tick(t) {
    this._physics();

    // Persist last known position for every live node (used for dormant reconnect)
    for (const [id, nd] of this.nodes) {
      this._lastPositions.set(id, { x: nd.x, y: nd.y });
    }

    // Keep camera centered on tracked agent
    if (this.trackingId) {
      const nd = this.nodes.get(this.trackingId);
      if (nd) {
        const W = this.canvas.width || 640, H = this.canvas.height || 500;
        this.tCam.panX = W / 2 - nd.x * this.tCam.scale;
        this.tCam.panY = H / 2 - nd.y * this.tCam.scale;
      } else {
        this.trackingId = null;
      }
    }

    // Smooth camera
    this.cam.panX  = lerp(this.cam.panX,  this.tCam.panX,  CAM_LERP);
    this.cam.panY  = lerp(this.cam.panY,  this.tCam.panY,  CAM_LERP);
    this.cam.scale = lerp(this.cam.scale, this.tCam.scale, CAM_LERP);

    // Prune expired effects
    this.deathAnims    = this.deathAnims.filter(d => t - d.t < 2500);
    this.trackPulses   = this.trackPulses.filter(p => t - p.t < 1800);
    this.flowers       = this.flowers.filter(f => t - f.t < 1400);
    this._novelEffects = this._novelEffects.filter(e => t - e.t < 2200);
    for (const nd of this.nodes.values()) {
      nd.signals = nd.signals.filter(s => t - s.t < 3400);
    }

    this._updateLineParticles(t);
    this._updateActivityParticles(t);
    this._updateLineFlows(t);
    this._render(t);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _render(t) {
    const ctx = this.ctx;
    const W   = this.canvas.width;
    const H   = this.canvas.height;
    const sc  = this.cam.scale;
    const px  = this.cam.panX;
    const py  = this.cam.panY;

    // Background — deep quantum void
    ctx.fillStyle = '#020408';
    ctx.fillRect(0, 0, W, H);

    // Screen-space quantum noise overlay (before world transform)
    this._drawQuantumNoiseOverlay(ctx, t, W, H);

    // All world-space drawing inside one save/restore block
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(sc, sc);

    this._drawQuantumBackground(ctx, t);
    this._drawConnections(ctx, t);
    this._drawWorldEvents(ctx, t);
    this._drawLineParticles(ctx, t);
    this._drawSignals(ctx, t);
    this._drawFlowers(ctx, t);
    this._drawNovelEffects(ctx, t);
    this._drawWorldObjects(ctx, t);

    // Activity particles and line flows drawn before agent nodes so nodes appear on top
    this._drawLineFlows(ctx, t);
    this._drawActivityParticles(ctx);

    // At low zoom, replace individual agents with cluster count bubbles
    const CLUSTER_SCALE = 0.45;
    if (sc < CLUSTER_SCALE && this.nodes.size >= 4) {
      this._drawClusters(ctx, t, sc);
    } else {
      this._drawAgents(ctx, t);
    }

    this._drawDeaths(ctx, t);
    this._drawTrackPulses(ctx, t);
    if (this.collapseState) this._drawCollapse(ctx, t);

    ctx.restore();

    // Screen-space overlays (no world transform)
    if (!(sc < CLUSTER_SCALE && this.nodes.size >= 4)) {
      this._drawLabels(ctx, t, W, H, sc, px, py);
    }
    if (sc > 1.1 && this.nodes.size > 0) this._drawMinimap(ctx, W, H);

    // Camera-follow: update open object info popup position every frame
    if (this._openedWObj && this.onObjectPositionUpdate) {
      const pos = this._orbitPositions.get(this._openedWObj.id);
      if (pos) {
        const cr  = this.canvas.getBoundingClientRect();
        const osx = cr.left + pos.wx * sc + px;
        const osy = cr.top  + pos.wy * sc + py;
        this.onObjectPositionUpdate(osx, osy);
      } else {
        this._openedWObj = null;
        if (this.onObjectClose) this.onObjectClose();
      }
    }

    // Instant tooltip hide: every frame check if mouse moved >40px from hovered object
    if (this._hoveredWObj && this._mouseScreen) {
      const rect2 = this.canvas.getBoundingClientRect();
      const sx2   = this._mouseScreen.x - rect2.left;
      const sy2   = this._mouseScreen.y - rect2.top;
      const wx2   = (sx2 - this.cam.panX) / this.cam.scale;
      const wy2   = (sy2 - this.cam.panY) / this.cam.scale;
      const pos   = this._orbitPositions.get(this._hoveredWObj.id);
      const hideDist = 40 / this.cam.scale;
      if (!pos || Math.hypot(wx2 - pos.wx, wy2 - pos.wy) > hideDist) {
        this._hideWOTooltip();
      }
    }
  }

  // ── Draw calls (world space) ───────────────────────────────────────────────

  /** Quantum noise screen-space overlay — subtle scanline flicker. */
  _drawQuantumNoiseOverlay(ctx, t, W, H) {
    // Occasional interference flash
    const flash = Math.max(0, Math.sin(t * 0.00041) * Math.sin(t * 0.00097));
    if (flash > 0.7) {
      ctx.save();
      ctx.globalAlpha = (flash - 0.7) * 0.06;
      ctx.fillStyle = '#0af';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  /** Hexagonal grid + quantum noise dots replacing the old starfield. */
  _drawQuantumBackground(ctx, t) {
    const HEX   = 52;            // hex cell size in world-px (flat-top)
    const colW  = HEX * Math.sqrt(3);
    const rowH  = HEX * 1.5;
    const areaW = WORLD_W * 2 + 240;
    const areaH = WORLD_H * 2 + 240;
    const offX  = -areaW / 2;
    const offY  = -areaH / 2;
    const cols  = Math.ceil(areaW / colW) + 2;
    const rows  = Math.ceil(areaH / rowH) + 2;

    // Breathing grid alpha
    const gridA = 0.055 + Math.sin(t * 0.00028) * 0.018;
    ctx.strokeStyle = `rgba(20,110,200,${gridA.toFixed(3)})`;
    ctx.lineWidth   = 0.45;
    ctx.beginPath();
    for (let row = -1; row < rows; row++) {
      for (let col = -1; col < cols; col++) {
        const cx = offX + col * colW + (row % 2 === 0 ? 0 : colW / 2);
        const cy = offY + row * rowH;
        for (let v = 0; v < 6; v++) {
          const ang = (v / 6) * Math.PI * 2 - Math.PI / 6;
          const hx  = cx + Math.cos(ang) * HEX;
          const hy  = cy + Math.sin(ang) * HEX;
          if (v === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy);
        }
        ctx.closePath();
      }
    }
    ctx.stroke();

    // Faint quantum interference rings expanding from origin
    for (let i = 0; i < 5; i++) {
      const phase = (t * 0.00022 + i * 0.4) % 1;
      const r = phase * (WORLD_W * 1.5);
      const ra = (1 - phase) * 0.045;
      ctx.strokeStyle = `rgba(0,160,255,${ra.toFixed(3)})`;
      ctx.lineWidth   = 0.6;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Quantum noise dots (re-use pre-generated _stars positions)
    for (const s of this._stars) {
      const f1 = Math.sin(t * 0.00072 + s.ph);
      const f2 = Math.sin(t * 0.00181 + s.ph * 2.3);
      const a  = Math.max(0, s.a * 0.9 * (0.38 + f1 * 0.38 + f2 * 0.24));
      const r  = parseInt(140 + (s.ph % 1) * 60);
      const g  = parseInt(190 + (s.ph % 1) * 40);
      ctx.fillStyle = `rgba(${r},${g},255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Draw connection lines between agents — visual design is 100% AI-decided. */
  _drawConnections(ctx, t) {
    const hl    = this.highlightedAgent || this._hoverHighlightId;
    for (const c of this.connections) {
      const ndA = this.nodes.get(c.a);
      const ndB = this.nodes.get(c.b);
      if (!ndA || !ndB) continue;

      const isHl    = !!(hl && (c.a === hl || c.b === hl));
      const isHover = this._hoveredConn === c;
      const dc      = c.dialogueCount || 0;
      const design  = c.design;
      const relType = c.relationType || 'neutral';

      // ── Visual: AI-decided for all relationship types ──
      let color, style, effect, lineWidthMult = 1;
      color  = design?.color  || '#6688aa';
      style  = design?.style  || 'solid';
      effect = design?.effect || 'none';
      // War/alliance lines slightly bolder for readability without overriding AI color
      if (relType === 'war')      lineWidthMult = 1.8;
      if (relType === 'alliance') lineWidthMult = 1.5;

      // ── Line weight: from AI design or dialogue frequency, scaled by rel type ──
      const baseLw = design?.thickness
        ? design.thickness * 0.65
        : dc >= 10 ? 2.8 + Math.abs(c.trust) * 1.2
        : dc >=  3 ? 1.4 + Math.abs(c.trust) * 0.9
        :             0.5 + Math.abs(c.trust) * 0.5;
      const lw = baseLw * lineWidthMult;

      // ── Alpha: design-aware base, pulse effect animates it ──
      let baseA = design
        ? 0.28 + Math.min(0.55, dc * 0.04)
        : dc >= 10 ? 0.55 + Math.abs(c.trust) * 0.35
        : dc >=  3 ? 0.30 + Math.abs(c.trust) * 0.40
        :             0.15 + Math.abs(c.trust) * 0.25;

      // War and alliance always more visible
      if (relType === 'war')      baseA = Math.max(baseA, 0.7 + Math.sin(t * 0.005) * 0.3);
      if (relType === 'alliance') baseA = Math.max(baseA, 0.55);

      if (design?.effect === 'pulse') {
        const hz = design.pulseSpeed === 'slow' ? 0.0008 : design.pulseSpeed === 'fast' ? 0.0032 : 0.0018;
        baseA *= (0.55 + Math.sin(t * hz + dc) * 0.45);
      }

      const alpha = hl      ? (isHl   ? Math.min(baseA * 2.2, 0.95) : 0.04)
                  : isHover ? Math.min(baseA * 2.0, 0.95)
                  :           baseA;

      const lineWidth = (isHl || isHover) ? lw * 2.2 : lw;

      ctx.save();
      ctx.strokeStyle = hexRgba(color, alpha);
      ctx.lineWidth   = lineWidth;

      // ── Glow ──
      const glowStr = (effect === 'glow' || isHl || isHover) ? (isHover ? 18 : 12) : 5;
      ctx.shadowColor = hexRgba(color, isHover ? 0.85 : 0.55);
      ctx.shadowBlur  = glowStr;

      // ── Spark: random brightness burst (AI-triggered via effect field) ──
      if (effect === 'spark' && Math.random() < 0.08) {
        ctx.shadowColor = hexRgba(color, 0.9);
        ctx.shadowBlur  = 24;
        ctx.strokeStyle = hexRgba(color, Math.min(alpha * 2.5, 1));
      }

      // ── Dash styles ──
      if (style === 'dashed') {
        ctx.setLineDash([8, 6]);
      } else if (style === 'dotted') {
        ctx.setLineDash([2, 5]);
      } else if (effect === 'flow') {
        ctx.setLineDash([10, 8]);
        ctx.lineDashOffset = -(t * 0.035) % 18;
      }

      // ── Draw — lines start/end at node edge, not center ──
      const ep = Starmap._edgePoints(ndA, ndB);
      if (style === 'wavy') {
        this._drawWavyLine(ctx, ep.ax, ep.ay, ep.bx, ep.by, lineWidth * 2.8, t * 0.0012 + dc * 0.7);
      } else {
        ctx.beginPath();
        ctx.moveTo(ep.ax, ep.ay);
        ctx.lineTo(ep.bx, ep.by);
        ctx.stroke();
      }

      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  /** Draw a sinusoidal line from (x1,y1) to (x2,y2). */
  _drawWavyLine(ctx, x1, y1, x2, y2, amp, phase) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    const nx = -dy / len, ny = dx / len;
    const steps = Math.max(6, Math.floor(len / 6));
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const wave = Math.sin(f * Math.PI * 5 + phase) * amp;
      ctx.lineTo(x1 + dx * f + nx * wave, y1 + dy * f + ny * wave);
    }
    ctx.stroke();
  }

  /** Advance flowing particles along all active connection lines. */
  _updateLineParticles(t) {
    const dt = Math.min(t - (this._lastParticleUpdate || t), 60);
    this._lastParticleUpdate = t;
    if (dt <= 0) return;

    const activeKeys = new Set();
    for (const c of this.connections) {
      const key = [c.a, c.b].sort().join('|');
      activeKeys.add(key);

      if (!this._lineParticles.has(key)) {
        const count = 2 + Math.floor(Math.random() * 3);
        const ps = [];
        for (let i = 0; i < count; i++) {
          ps.push({ progress: Math.random(), speed: 0.00018 + Math.random() * 0.00015, dir: Math.random() < 0.5 ? 1 : -1 });
        }
        this._lineParticles.set(key, ps);
      }

      const baseSpeed = 0.00015 + Math.min(c.dialogueCount || 0, 20) * 0.000025;
      for (const p of this._lineParticles.get(key)) {
        p.progress += p.dir * baseSpeed * dt;
        if (p.progress > 1) p.progress -= 1;
        if (p.progress < 0) p.progress += 1;
      }
    }

    for (const key of this._lineParticles.keys()) {
      if (!activeKeys.has(key)) this._lineParticles.delete(key);
    }
  }

  /** Draw quantum energy pulse orbs flowing along connection lines. */
  _drawLineParticles(ctx, t) {
    for (const c of this.connections) {
      const ndA = this.nodes.get(c.a);
      const ndB = this.nodes.get(c.b);
      if (!ndA || !ndB) continue;

      const key       = [c.a, c.b].sort().join('|');
      const particles = this._lineParticles.get(key);
      if (!particles) continue;

      const color = c.design?.color || '#44aaff';
      const ep  = Starmap._edgePoints(ndA, ndB);
      const dx  = ep.bx - ep.ax, dy = ep.by - ep.ay;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux  = dx / len, uy = dy / len;   // unit vector along line

      for (const p of particles) {
        const px = ep.ax + dx * p.progress;
        const py = ep.ay + dy * p.progress;
        const pulseMult = 0.55 + Math.sin(t * 0.0045 + p.progress * Math.PI * 2.5) * 0.45;

        // Tail: 4 fading dots behind the orb
        for (let i = 1; i <= 4; i++) {
          const tp  = clamp(p.progress - p.dir * i * 0.022, 0, 1);
          const tx  = ep.ax + dx * tp;
          const ty  = ep.ay + dy * tp;
          const ta  = (0.18 - i * 0.04) * pulseMult;
          const tr  = 1.2 - i * 0.22;
          if (tr <= 0 || ta <= 0) continue;
          ctx.save();
          ctx.globalAlpha = Math.max(0, ta);
          ctx.fillStyle   = color;
          ctx.shadowColor = color;
          ctx.shadowBlur  = 4;
          ctx.beginPath();
          ctx.arc(tx, ty, Math.max(0.3, tr), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Main orb
        ctx.save();
        ctx.globalAlpha = pulseMult * 0.92;
        ctx.fillStyle   = color;
        ctx.shadowColor = color;
        ctx.shadowBlur  = 12;
        ctx.beginPath();
        ctx.arc(px, py, 2.8, 0, Math.PI * 2);
        ctx.fill();
        // Bright core
        ctx.globalAlpha = pulseMult * 1.0;
        ctx.fillStyle   = '#ffffff';
        ctx.shadowBlur  = 6;
        ctx.beginPath();
        ctx.arc(px, py, 1.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // ── Activity particles — emitted from recently active agent nodes ─────────────

  /** Emit and advance activity particles for agents active in last 2 min. */
  _updateActivityParticles(t) {
    const nowMs         = Date.now();
    const ACTIVE_WINDOW = 120000;   // 2 minutes
    const EMIT_INTERVAL = 120;      // ms between emission passes
    const MAX_PARTICLES = 200;

    // Advance existing particles; remove dead ones
    for (let i = this._activityParticles.length - 1; i >= 0; i--) {
      const p = this._activityParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life--;
      if (p.life <= 0) this._activityParticles.splice(i, 1);
    }

    // Emit new particles for active agents
    if (t - this._lastEmitT < EMIT_INTERVAL) return;
    this._lastEmitT = t;

    if (this._activityParticles.length >= MAX_PARTICLES) return;

    for (const [id, nd] of this.nodes) {
      const lastDec = nd.agent.lastDecisionAt || 0;
      if (nowMs - lastDec > ACTIVE_WINDOW) continue;   // not recently active

      // Pick agent primary color
      const color = nd.agent.visualForm?.primaryColor
        || `hsl(${agentHue(nd.agent)},70%,60%)`;

      // Emit 1-3 particles from the node edge in a random direction
      const count = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        if (this._activityParticles.length >= MAX_PARTICLES) break;
        const angle   = Math.random() * Math.PI * 2;
        const speed   = 0.3 + Math.random() * 0.5;        // px/frame
        const maxLife = 60 + Math.floor(Math.random() * 61); // 60-120 frames
        // Spawn at node edge
        this._activityParticles.push({
          x:       nd.x + Math.cos(angle) * (NODE_R + 1),
          y:       nd.y + Math.sin(angle) * (NODE_R + 1),
          vx:      Math.cos(angle) * speed,
          vy:      Math.sin(angle) * speed,
          life:    maxLife,
          maxLife,
          r:       1.5 + Math.random(),    // 1.5-2.5 px
          color,
          agentId: id,
        });
      }
    }
  }

  /** Draw activity particles under agent nodes. */
  _drawActivityParticles(ctx) {
    for (const p of this._activityParticles) {
      const alpha = (p.life / p.maxLife) * 0.75;
      if (alpha <= 0) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur  = 4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Line energy flows — fast directional dots for recently communicating pairs ──

  /** Update fast energy flows for connection pairs that exchanged messages < 5 min ago. */
  _updateLineFlows(t) {
    const nowMs          = Date.now();
    const COMM_WINDOW    = 300000;   // 5 minutes
    const FLOW_SPEED     = 0.0005;   // progress/ms → ~2 sec crossing
    const dt = Math.min(t - (this._lastFlowT || t), 60);
    this._lastFlowT = t;

    // Build set of recently-active pair keys
    const activeFlowKeys = new Set();
    for (const c of this.connections) {
      const key   = [c.a, c.b].sort().join('|');
      const lastTs = this._connLastTs?.get(key) || 0;
      if (nowMs - lastTs > COMM_WINDOW) continue;
      activeFlowKeys.add(key);
    }

    // Advance existing flows
    for (let i = this._lineFlows.length - 1; i >= 0; i--) {
      const f = this._lineFlows[i];
      if (!activeFlowKeys.has(f.key)) {
        this._lineFlows.splice(i, 1);
        continue;
      }
      f.progress += FLOW_SPEED * dt;
      if (f.progress >= 1) f.progress -= 1;
    }

    // Spawn new flows for newly-active pairs (1-2 per pair)
    const existingKeys = new Set(this._lineFlows.map(f => f.key + ':' + f.idx));
    for (const c of this.connections) {
      const key    = [c.a, c.b].sort().join('|');
      if (!activeFlowKeys.has(key)) continue;

      const ndA = this.nodes.get(c.a);
      const ndB = this.nodes.get(c.b);
      if (!ndA || !ndB) continue;

      const lastTs = this._connLastTs?.get(key) || 0;
      // More flows for more recent comms (1 if > 1 min ago, 2 if very recent)
      const wantCount = (nowMs - lastTs < 60000) ? 2 : 1;
      const have = this._lineFlows.filter(f => f.key === key).length;
      if (have >= wantCount) continue;

      const senderNd  = c.a < c.b ? ndA : ndB;  // deterministic sender
      const color     = senderNd.agent.visualForm?.primaryColor
        || `hsl(${agentHue(senderNd.agent)},70%,65%)`;

      this._lineFlows.push({
        key,
        idx:      have,
        progress: Math.random(),    // stagger start positions
        color,
      });
    }
  }

  /** Draw fast energy-flow dots along recently-active connection lines. */
  _drawLineFlows(ctx, t) {
    for (const f of this._lineFlows) {
      const c = this.connections.find(c => [c.a, c.b].sort().join('|') === f.key);
      if (!c) continue;
      const ndA = this.nodes.get(c.a);
      const ndB = this.nodes.get(c.b);
      if (!ndA || !ndB) continue;

      const ep = Starmap._edgePoints(ndA, ndB);
      const dx = ep.bx - ep.ax, dy = ep.by - ep.ay;
      const px = ep.ax + dx * f.progress;
      const py = ep.ay + dy * f.progress;

      const pulse = 0.6 + Math.sin(t * 0.004 + f.progress * Math.PI * 3) * 0.4;

      ctx.save();
      ctx.globalAlpha = pulse * 0.85;
      ctx.fillStyle   = f.color;
      ctx.shadowColor = f.color;
      ctx.shadowBlur  = 10;
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, Math.PI * 2);
      ctx.fill();
      // bright core
      ctx.globalAlpha = pulse;
      ctx.fillStyle   = '#ffffff';
      ctx.shadowBlur  = 4;
      ctx.beginPath();
      ctx.arc(px, py, 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  _drawSignals(ctx, t) {
    for (const nd of this.nodes.values()) {
      const h = agentHue(nd.agent);
      for (const sig of nd.signals) {
        const frac = clamp((t - sig.t) / 3200, 0, 1);
        if (frac >= 1) continue;
        ctx.save();
        ctx.globalAlpha = (1 - frac) * 0.30;
        ctx.strokeStyle = hsl(h, 70, 65);
        ctx.lineWidth   = 0.8;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, Math.max(frac * sig.maxR, 0.5), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  _drawFlowers(ctx, t) {
    for (const fl of this.flowers) {
      const frac = clamp((t - fl.t) / 1400, 0, 1);
      const size = frac * 18;
      ctx.save();
      ctx.globalAlpha = (1 - frac) * 0.8;
      ctx.fillStyle   = hsl(fl.hue, 75, 65);
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(
          fl.x + Math.cos(ang) * size * 0.6,
          fl.y + Math.sin(ang) * size * 0.6,
          size * 0.4, 0, Math.PI * 2
        );
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // ── World Event System ──────────────────────────────────────────────────────

  _createWEPopup() {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed','pointer-events:none','display:none',
      'background:radial-gradient(circle at 30% 30%, #0f0f2a 0%, #050510 75%)',
      'border:1px solid rgba(100,140,255,0.38)',
      'border-radius:13px','padding:14px 18px',
      'font-family:"JetBrains Mono",monospace',
      'z-index:9000','max-width:290px',
      'box-shadow:0 0 32px rgba(40,80,220,0.38), 0 0 8px rgba(20,40,120,0.5), inset 0 0 22px rgba(8,16,50,0.6)',
      'color:#c8d8f0','word-break:break-word',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  _showWEPopup(ev, sx, sy, isPending) {
    const el = this._wePopupEl;
    const now = Date.now();
    const ageMs  = ev.createdAt ? now - ev.createdAt : 0;
    const ageStr = ageMs < 3600000
      ? Math.round(ageMs / 60000) + ' min ago'
      : ageMs < 86400000 ? Math.round(ageMs / 3600000) + ' hours ago'
      : Math.round(ageMs / 86400000) + ' days ago';
    const creator   = ev.creatorName || ev.proposedByName || '?';
    const partCount = (ev.participants || []).length;

    if (isPending) {
      el.innerHTML =
        `<div style="font-size:9px;letter-spacing:1px;color:#888;margin-bottom:4px">PROPOSAL</div>` +
        `<div style="font-size:13px;font-weight:bold;color:#ddeeff;margin-bottom:6px">${ev.eventName}</div>` +
        (ev.effect ? `<div style="font-size:10px;color:rgba(200,220,255,0.75);margin-bottom:6px">${ev.effect}</div>` : '') +
        `<div style="font-size:9px;color:#6688aa">Proposed by <b style="color:#aaccff">${creator}</b></div>` +
        `<div style="font-size:9px;color:#ff9955;margin-top:4px">⏳ Awaiting 1 more participant…</div>`;
    } else {
      const creatorNd = this.nodes.get(ev.creatorId);
      const isOnline  = !!creatorNd;
      const isFading  = ev.fading;
      const partNames = (ev.participants || [])
        .map(id => { const n = this.nodes.get(id); return n ? n.agent.name : null; })
        .filter(Boolean);
      el.innerHTML =
        `<div style="font-size:9px;letter-spacing:1px;color:${ev.color};margin-bottom:4px">${(ev.eventType || 'EVENT').toUpperCase()}</div>` +
        `<div style="font-size:14px;font-weight:bold;color:#fff;margin-bottom:6px">${ev.eventName}</div>` +
        (ev.effect ? `<div style="font-size:10px;color:rgba(200,220,255,0.8);margin-bottom:8px">${ev.effect}</div>` : '') +
        `<div style="font-size:9px;color:#6688aa">Founded by <b style="color:#aaccff">${creator}</b> ` +
        `<span style="color:${isOnline ? '#33ff88' : '#ff6644'}">${isOnline ? '● online' : '○ offline'}</span></div>` +
        (partNames.length > 0
          ? `<div style="font-size:9px;color:${ev.color};margin-top:4px">Participants: ${partNames.join(', ')}</div>`
          : '') +
        `<div style="font-size:9px;color:#556677;margin-top:4px">${partCount} participant${partCount !== 1 ? 's' : ''}` +
        (isFading ? ' · <span style="color:#ff8844">⚠ fading</span>' : '') + `</div>` +
        (ev.createdAt ? `<div style="font-size:8px;color:#445566;margin-top:3px">Created ${ageStr}</div>` : '');
    }
    el.style.display = 'block';
    const W  = window.innerWidth, H = window.innerHeight;
    const ew = el.offsetWidth + 16, eh = el.offsetHeight + 16;
    el.style.left = (sx + 14 + ew > W ? sx - ew : sx + 14) + 'px';
    el.style.top  = (sy + 14 + eh > H ? sy - eh : sy + 14) + 'px';
  }

  _hideWEPopup() {
    this._wePopupEl.style.display = 'none';
    this._selectedWorldEvent = null;
  }

  /** Pre-compute every vertex of the background hex grid (same math as _drawQuantumBackground). */
  _getBgHexVerts() {
    if (this._bgHexVerts) return this._bgHexVerts;
    const HEX   = 52;
    const colW  = HEX * Math.sqrt(3);
    const rowH  = HEX * 1.5;
    const areaW = WORLD_W * 2 + 240;
    const areaH = WORLD_H * 2 + 240;
    const offX  = -areaW / 2;
    const offY  = -areaH / 2;
    const cols  = Math.ceil(areaW / colW) + 2;
    const rows  = Math.ceil(areaH / rowH) + 2;
    const verts = [];
    const seen  = new Set();
    for (let row = -1; row < rows; row++) {
      for (let col = -1; col < cols; col++) {
        const cx = offX + col * colW + (row % 2 === 0 ? 0 : colW / 2);
        const cy = offY + row * rowH;
        for (let v = 0; v < 6; v++) {
          const ang = (v / 6) * Math.PI * 2 - Math.PI / 6;
          const hx  = cx + Math.cos(ang) * HEX;
          const hy  = cy + Math.sin(ang) * HEX;
          const key = Math.round(hx) + ',' + Math.round(hy);
          if (!seen.has(key)) { seen.add(key); verts.push({ x: hx, y: hy }); }
        }
      }
    }
    this._bgHexVerts = verts;
    return verts;
  }

  /**
   * Find and cache the best background hex vertex for a world event.
   * Rules: ≥150 world-px from any agent, ≥80 world-px from other events.
   * Falls back to relaxed constraints if needed.
   */
  _assignHexVert(we) {
    const existing = this._eventHexPos.get(we.id);
    if (existing && existing.color && existing.color.length === 7 && existing.meteorAngle !== undefined) return;
    const verts     = this._getBgHexVerts();
    const creatorNd = this.nodes.get(we.creatorId);
    const originX   = creatorNd ? creatorNd.x : (we.x || 0);
    const originY   = creatorNd ? creatorNd.y : (we.y || 0);
    const takenPts  = [];
    for (const [, pos] of this._eventHexPos) takenPts.push(pos);

    const agentPts = [...this.nodes.values()].map(n => ({ x: n.x, y: n.y }));

    const tryFind = (agentClear, minEventDist) => {
      let best = null, bestDist = Infinity;
      for (const v of verts) {
        if (Math.abs(v.x) > WORLD_W + 20 || Math.abs(v.y) > WORLD_H + 20) continue;
        if (agentClear) {
          let ok = true;
          for (const a of agentPts) { if (Math.hypot(v.x - a.x, v.y - a.y) < 150) { ok = false; break; } }
          if (!ok) continue;
        }
        let evOk = true;
        for (const p of takenPts) { if (Math.hypot(v.x - p.x, v.y - p.y) < minEventDist) { evOk = false; break; } }
        if (!evOk) continue;
        const d = Math.hypot(v.x - originX, v.y - originY);
        if (d < bestDist) { bestDist = d; best = v; }
      }
      return best;
    };

    const pos = tryFind(true, 80) || tryFind(false, 80) || tryFind(false, 40) || { x: we.x || 0, y: we.y || 0 };
    // Preserve existing position if already cached (only color/angle were missing)
    const prevPos = this._eventHexPos.get(we.id);
    const angle = (we.meteorAngle !== undefined && we.meteorAngle !== null)
                    ? we.meteorAngle
                    : Math.random() * Math.PI * 2;
    const color = (we.color && we.color.length === 7)
                    ? we.color
                    : '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    this._eventHexPos.set(we.id, {
      x: prevPos ? prevPos.x : pos.x,
      y: prevPos ? prevPos.y : pos.y,
      angle,
      color,
    });
  }

  _drawWorldEvents(ctx, t) {
    const sc   = this.cam.scale;
    const now  = Date.now();
    const sel  = this._selectedAgentId;

    // ── Assign hex vertices + crowding cull ──
    const visible = [];
    const cellCnt = new Map();
    for (const we of this.worldEvents) {
      this._assignHexVert(we);
      const pos = this._eventHexPos.get(we.id);
      if (!pos) continue;
      const ck = Math.round(pos.x / 200) + '|' + Math.round(pos.y / 200);
      const n  = cellCnt.get(ck) || 0;
      if (n < 3) { visible.push({ we, pos }); cellCnt.set(ck, n + 1); }
      if (visible.length >= 25) break;
    }

    // ── Build connected IDs set ──
    const connectedIds = new Set();
    if (sel) {
      for (const { we } of visible) {
        if (we.creatorId === sel || (we.participants || []).includes(sel)) {
          connectedIds.add(we.id);
        }
      }
    }

    // ── Pending proposals: faint ring at nearest hex vertex ──
    for (const p of this.pendingProposals) {
      const pnd = this.nodes.get(p.proposedBy);
      if (!pnd) continue;
      const verts = this._getBgHexVerts();
      let bestV = null, bestD = Infinity;
      for (const v of verts) {
        const d = Math.hypot(v.x - pnd.x, v.y - pnd.y);
        if (d < bestD && d > 30) { bestD = d; bestV = v; }
      }
      if (!bestV) continue;
      const pulse = 0.12 + Math.sin(t * 0.003 + pnd.x) * 0.06;
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = 'rgba(140,160,205,0.55)';
      ctx.lineWidth   = 0.7;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.arc(bestV.x, bestV.y, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle   = 'rgba(160,180,225,0.65)';
      ctx.beginPath(); ctx.arc(bestV.x, bestV.y, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // ── Curved connection lines (drawn first so agents render on top) ──
    if (sel) {
      const agNd = this.nodes.get(sel);
      if (agNd) {
        for (const { we, pos } of visible) {
          if (!connectedIds.has(we.id)) continue;
          const wx = pos.x, wy = pos.y, fc = pos.color;
          const agX = agNd.x, agY = agNd.y;
          const midX = (agX + wx) / 2 + Math.sin(we.createdAt) * 30;
          const midY = (agY + wy) / 2 + Math.cos(we.createdAt) * 30;
          const lg = ctx.createLinearGradient(agX, agY, wx, wy);
          lg.addColorStop(0,   fc + '00');
          lg.addColorStop(0.3, fc + '44');
          lg.addColorStop(0.5, fc + '88');
          lg.addColorStop(0.7, fc + '44');
          lg.addColorStop(1,   fc + '00');
          ctx.save();
          ctx.setLineDash([3, 8]);
          ctx.beginPath();
          ctx.moveTo(agX, agY);
          ctx.quadraticCurveTo(midX, midY, wx, wy);
          ctx.strokeStyle = lg;
          ctx.lineWidth   = 0.8;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      }
    }

    // ── Meteor nodes ──
    for (const { we, pos } of visible) {
      const wx    = pos.x, wy = pos.y;
      const fc    = pos.color;
      const angle = pos.angle;

      // Age multiplier
      const ageMs  = we.createdAt ? now - we.createdAt : 0;
      const FADE_S = 5400000, FADE_E = 10800000;
      let ageMult  = 1.0;
      if (ageMs > FADE_S) ageMult = Math.max(0.3, 1 - (ageMs - FADE_S) / (FADE_E - FADE_S) * 0.7);
      if (we.fading) ageMult *= 0.35;

      // Opacity rules
      let opacity;
      if (!sel)                          opacity = 0.25;
      else if (connectedIds.has(we.id))  opacity = 1.0;
      else                               opacity = 0.06;
      opacity *= ageMult;

      const dnow = now;

      // ── A. Main meteor tail ──
      const tailLen  = (25 + Math.sin(dnow * 0.001 + we.createdAt) * 5) * Math.min(sc, 1.5);
      const tailX    = wx - Math.cos(angle) * tailLen;
      const tailY    = wy - Math.sin(angle) * tailLen;
      const tGrad    = ctx.createLinearGradient(wx, wy, tailX, tailY);
      const _h8  = Math.round(0.8 * opacity * 255).toString(16).padStart(2, '0');
      const _h3  = Math.round(0.3 * opacity * 255).toString(16).padStart(2, '0');
      tGrad.addColorStop(0,   fc + _h8);
      tGrad.addColorStop(0.4, fc + _h3);
      tGrad.addColorStop(1,   fc + '00');
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.lineTo(tailX, tailY);
      ctx.strokeStyle = tGrad;
      ctx.lineWidth   = Math.max(1, 2.5 * sc);
      ctx.lineCap     = 'round';
      ctx.stroke();
      ctx.restore();

      // ── B. Secondary smaller tail ──
      const tail2X   = wx - Math.cos(angle + 0.15) * tailLen * 0.6;
      const tail2Y   = wy - Math.sin(angle + 0.15) * tailLen * 0.6;
      const t2Grad   = ctx.createLinearGradient(wx, wy, tail2X, tail2Y);
      const _h4  = Math.round(0.4 * opacity * 255).toString(16).padStart(2, '0');
      t2Grad.addColorStop(0, '#ffffff' + _h4);
      t2Grad.addColorStop(1, '#ffffff00');
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.lineTo(tail2X, tail2Y);
      ctx.strokeStyle = t2Grad;
      ctx.lineWidth   = Math.max(0.5, 1 * sc);
      ctx.lineCap     = 'round';
      ctx.stroke();
      ctx.restore();

      // ── C. Glowing head ──
      const headR    = Math.max(2, 3.5 * sc);
      const hGrad    = ctx.createRadialGradient(wx, wy, 0, wx, wy, headR * 3);
      const _hFull   = Math.round(opacity * 255).toString(16).padStart(2, '0');
      const _h9      = Math.round(0.9 * opacity * 255).toString(16).padStart(2, '0');
      hGrad.addColorStop(0,   '#ffffff' + _hFull);
      hGrad.addColorStop(0.3, fc + _h9);
      hGrad.addColorStop(0.7, fc + _h3);
      hGrad.addColorStop(1,   fc + '00');
      ctx.save();
      ctx.shadowBlur  = 12 * opacity;
      ctx.shadowColor = fc;
      ctx.beginPath();
      ctx.arc(wx, wy, headR * 3, 0, Math.PI * 2);
      ctx.fillStyle = hGrad;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(wx, wy, headR * 0.6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff' + _hFull;
      ctx.fill();
      ctx.restore();

      // ── D. Sparkle particles ──
      for (let i = 0; i < 4; i++) {
        const sAng  = dnow * 0.001 + i * Math.PI / 2 + (we.createdAt || 0);
        const sDist = (4 + Math.sin(dnow * 0.002 + i) * 2) * sc;
        const sx = wx + Math.cos(sAng) * sDist;
        const sy = wy + Math.sin(sAng) * sDist;
        const _h6 = Math.round(0.6 * opacity * 255).toString(16).padStart(2, '0');
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(0.5, 0.8 * sc), 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff' + _h6;
        ctx.fill();
      }

      // ── E. Label ──
      if (sc > 0.6 && opacity > 0.15) {
        const _hLbl = Math.round(opacity * 0.8 * 255).toString(16).padStart(2, '0');
        ctx.save();
        ctx.font        = `${Math.round(7 * sc)}px monospace`;
        ctx.fillStyle   = fc + _hLbl;
        ctx.textAlign   = 'center';
        ctx.shadowBlur  = 4;
        ctx.shadowColor = fc;
        ctx.fillText(we.eventName || (we.eventType || 'event').toUpperCase(), wx, wy + 20 * sc);
        ctx.restore();
      }
    }
  }

  _drawAgents(ctx, t) {
    const hl = this.highlightedAgent || this._hoverHighlightId;
    for (const [id, nd] of this.nodes) {
      const a       = nd.agent;
      const isHl    = id === hl;
      const dimmed  = !!(hl && !isHl);
      const isTrack = id === this.trackingId;
      const isoA    = Math.max(0.3, 1 - Math.max(0, (a.isolationTicks||0) - 40) * 0.015);

      // Fade-in alpha for returning agents
      const wakeT   = this._awakingNodes.get(id);
      const wakeA   = wakeT ? Math.min(1, (t - wakeT) / 1500) : 1;

      ctx.save();
      ctx.globalAlpha = (dimmed ? 0.18 : 1) * isoA * wakeA;

      if (a.visualForm && a.visualForm.shapes && a.visualForm.shapes.length) {
        this._drawNodeForm(ctx, nd, a, t);
      } else {
        this._drawNodeFallback(ctx, nd, a, t);
      }

      // Highlight ring (pulsing gold)
      if (isHl) {
        const mods = a.formModifiers || [];
        const modScale = (mods.find(m => m.type==='power_expand')?.scale || 1);
        const nr = NODE_R * modScale;
        const ha = 0.5 + Math.sin(t * 0.006) * 0.35;
        ctx.strokeStyle = `rgba(255,215,55,${ha.toFixed(2)})`;
        ctx.lineWidth   = 2;
        ctx.shadowColor = 'rgba(255,215,55,0.7)';
        ctx.shadowBlur  = 12;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nr + 10, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Tracking ring
      if (isTrack) {
        const ta = 0.4 + Math.sin(t * 0.005) * 0.3;
        ctx.strokeStyle = `rgba(255,215,55,${ta.toFixed(2)})`;
        ctx.lineWidth   = 1.5;
        ctx.shadowColor = 'rgba(255,215,55,0.5)';
        ctx.shadowBlur  = 8;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, NODE_R + 7, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ── REP Grade visual effects ──
      const repGrade = a.repGrade || 'Neutral';
      if (repGrade === 'Sovereign') {
        // Gold crown icon + strong golden glow
        const ga = 0.6 + Math.sin(t * 0.003) * 0.2;
        ctx.save();
        ctx.shadowColor = `rgba(255,215,0,${ga})`;
        ctx.shadowBlur  = 22;
        ctx.strokeStyle = `rgba(255,215,0,${ga})`;
        ctx.lineWidth   = 2.5;
        ctx.beginPath(); ctx.arc(nd.x, nd.y, NODE_R + 14, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('👑', nd.x, nd.y - NODE_R - 13);
        ctx.restore();
      } else if (repGrade === 'Influencer') {
        // Star icon + cyan glow
        const ia = 0.4 + Math.sin(t * 0.004) * 0.2;
        ctx.save();
        ctx.shadowColor = `rgba(0,220,255,${ia})`;
        ctx.shadowBlur  = 14;
        ctx.strokeStyle = `rgba(0,220,255,${ia})`;
        ctx.lineWidth   = 1.5;
        ctx.beginPath(); ctx.arc(nd.x, nd.y, NODE_R + 10, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('⭐', nd.x, nd.y - NODE_R - 12);
        ctx.restore();
      } else if (repGrade === 'Outcast') {
        // Skull icon + dark purple aura
        ctx.save();
        ctx.shadowColor = 'rgba(120,0,180,0.5)';
        ctx.shadowBlur  = 12;
        ctx.strokeStyle = 'rgba(120,0,180,0.4)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(nd.x, nd.y, NODE_R + 10, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        ctx.save();
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('💀', nd.x, nd.y - NODE_R - 12);
        ctx.restore();
      } else if (repGrade === 'Exile') {
        // Red pulsing ring + broken connections visual
        const ea = 0.55 + Math.sin(t * 0.008) * 0.45;
        ctx.save();
        ctx.shadowColor = `rgba(255,0,0,${ea})`;
        ctx.shadowBlur  = 18;
        ctx.strokeStyle = `rgba(255,0,0,${ea})`;
        ctx.lineWidth   = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(nd.x, nd.y, NODE_R + 12, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        ctx.save();
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🔴', nd.x, nd.y - NODE_R - 13);
        ctx.restore();
      }

      // ── Newbie shield visual (blue shimmer) ──
      if (a.shield && a.shield.active) {
        const sa = 0.25 + Math.sin(t * 0.005) * 0.15;
        ctx.save();
        ctx.shadowColor = `rgba(80,160,255,${sa})`;
        ctx.shadowBlur  = 16;
        ctx.strokeStyle = `rgba(80,160,255,${sa})`;
        ctx.lineWidth   = 1;
        ctx.setLineDash([6, 3]);
        ctx.beginPath(); ctx.arc(nd.x, nd.y, NODE_R + 8, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // ── Behavior color glow ring (reflects recent action pattern) ──
      if (a.behaviorColor) {
        const ba = 0.3 + Math.sin(t * 0.004 + nd.x * 0.01) * 0.2;
        ctx.save();
        ctx.shadowColor = hexRgba(a.behaviorColor, 0.7);
        ctx.shadowBlur  = 20;
        ctx.strokeStyle = hexRgba(a.behaviorColor, ba);
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.arc(nd.x, nd.y, NODE_R + 6, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }

      // Inventory count badge (bottom-right corner of agent node)
      const invCount = this.worldObjects.filter(o => o.agentIds && o.agentIds[0] === id && o.isInventoryItem).length;
      if (invCount > 0) {
        const bx = nd.x + NODE_R * 0.7;
        const by = nd.y + NODE_R * 0.7;
        ctx.shadowBlur  = 0;
        ctx.fillStyle   = '#0a0a1a';
        ctx.strokeStyle = 'rgba(100,200,255,0.80)';
        ctx.lineWidth   = 1.2;
        ctx.beginPath(); ctx.arc(bx, by, 8, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle    = '#d0f0ff';
        ctx.font         = `bold 7px monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(invCount), bx, by);
      }

      // API connection pending — pulsing yellow ⚠ above node
      if (a.apiPending) {
        const pa = 0.7 + Math.sin(t * 0.004) * 0.3;
        ctx.save();
        ctx.globalAlpha  = pa;
        ctx.font         = 'bold 11px sans-serif';
        ctx.fillStyle    = '#ffdd00';
        ctx.shadowColor  = '#ff9900';
        ctx.shadowBlur   = 8;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚠', nd.x, nd.y - NODE_R - 11);
        ctx.restore();
      }

      ctx.restore();
    }
  }

  _drawNodeForm(ctx, nd, a, t) {
    const form  = a.visualForm;
    const mods  = a.formModifiers || [];
    const pc    = form.primaryColor   || '#58a6ff';

    // Compute effective scale and alpha from modifiers
    let scale = 1.0, alpha = 1.0;
    const starv = mods.find(m => m.type === 'starvation_dim');
    if (starv) { alpha *= 1 - starv.intensity * 0.55; scale *= 1 - starv.intensity * 0.25; }
    const power = mods.find(m => m.type === 'power_expand');
    if (power)  scale *= power.scale;
    const frag = mods.find(m => m.type === 'death_fragment');
    if (frag)   { alpha *= 0.45 + Math.abs(Math.sin(t * 0.014 + nd.x)) * 0.45; scale *= 1 - frag.progress * 0.28; }

    // Quantum breathing — two-frequency oscillation per node
    const breath = 0.88 + Math.sin(t * 0.00125 + nd.x * 0.006 + nd.y * 0.004) * 0.09
                        + Math.sin(t * 0.00370 + nd.y * 0.005) * 0.03;
    const baseR = NODE_R * scale * breath;

    ctx.save();
    ctx.translate(nd.x, nd.y);
    ctx.globalAlpha *= Math.max(0.08, alpha);

    // Quantum outer aura — two-layer glow
    const glowR = baseR * 4.0;
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
    grd.addColorStop(0,   hexRgba(pc, 0.38));
    grd.addColorStop(0.3, hexRgba(pc, 0.18));
    grd.addColorStop(1,   hexRgba(pc, 0));
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(0, 0, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Quantum interference rings on AI-designed nodes
    for (let i = 0; i < 3; i++) {
      const rp = ((t * 0.00042 + i * 0.333 + nd.x * 0.001) % 1);
      const rr = baseR * (1.5 + rp * 2.8);
      const ra = (1 - rp) * 0.12;
      ctx.strokeStyle = hexRgba(pc, ra);
      ctx.lineWidth   = 0.5;
      ctx.shadowBlur  = 0;
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Ally branches (behind everything)
    const ally = mods.find(m => m.type === 'ally_branch');
    if (ally) {
      const bCnt = Math.max(2, Math.round(ally.intensity * 7));
      ctx.strokeStyle = hexRgba(pc, 0.32);
      ctx.lineWidth   = 0.7;
      ctx.shadowColor = pc;
      ctx.shadowBlur  = 5;
      for (let i = 0; i < bCnt; i++) {
        const ang = (i / bCnt) * Math.PI * 2 + t * 0.00025;
        const len = baseR * 1.6 + ally.intensity * 14;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // Draw base shapes scaled to node radius
    const shapeScale = baseR / 11;   // 11 = design-space "unit" radius
    ctx.save();
    ctx.scale(shapeScale, shapeScale);
    ctx.shadowColor = pc;
    ctx.shadowBlur  = 9;
    for (const s of form.shapes) {
      this._drawShape(ctx, s);
    }
    ctx.shadowBlur = 0;
    ctx.restore();

    // Crime scars (jagged red lines across form)
    const scarMod = mods.find(m => m.type === 'crime_scar');
    if (scarMod) {
      const scarCount = Math.min(scarMod.count, 5);
      ctx.strokeStyle = `rgba(255,40,40,${(0.55 + Math.abs(Math.sin(t * 0.009)) * 0.3).toFixed(2)})`;
      ctx.lineWidth = 1.1;
      ctx.shadowColor = '#ff2222';
      ctx.shadowBlur  = 6;
      for (let i = 0; i < scarCount; i++) {
        const ang  = i * 1.1 + 0.4;
        const r    = baseR * 0.85;
        const mid  = baseR * 0.35;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r, Math.sin(ang) * r);
        ctx.lineTo(Math.cos(ang + 0.35) * mid, Math.sin(ang + 0.35) * mid);
        ctx.lineTo(Math.cos(ang - 0.2) * -mid, Math.sin(ang - 0.2) * -mid);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // Individual scar marks
    const scarItem = mods.find(m => m.type === 'scar');
    if (scarItem) {
      const ang = scarItem.angle || 0;
      ctx.strokeStyle = `rgba(200,30,30,0.8)`;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = '#aa1111';
      ctx.shadowBlur  = 5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * baseR, Math.sin(ang) * baseR);
      ctx.lineTo(Math.cos(ang + 0.5) * baseR * 0.4, Math.sin(ang + 0.5) * baseR * 0.4);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Religious halo (rays + ring)
    const haloMod = mods.find(m => m.type === 'halo');
    if (haloMod) {
      const ha = 0.35 + Math.sin(t * 0.0018) * 0.22;
      const hc = haloMod.color || '#c084fc';
      ctx.strokeStyle = hexRgba(hc, ha);
      ctx.lineWidth   = 1.0;
      ctx.shadowColor = hc;
      ctx.shadowBlur  = 14;
      const rays = 8;
      const r1 = baseR * 1.25, r2 = r1 + 7 * haloMod.intensity;
      for (let i = 0; i < rays; i++) {
        const ang = (i / rays) * Math.PI * 2 + t * 0.00015;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
        ctx.lineTo(Math.cos(ang) * r2, Math.sin(ang) * r2);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // Blessed glow (golden ring)
    const blessMod = mods.find(m => m.type === 'blessed_glow');
    if (blessMod) {
      const ba = 0.5 + Math.sin(t * 0.0035) * 0.3;
      ctx.strokeStyle = hexRgba(blessMod.color || '#ffd700', ba);
      ctx.lineWidth   = 2.5;
      ctx.shadowColor = blessMod.color || '#ffd700';
      ctx.shadowBlur  = 22;
      ctx.beginPath();
      ctx.arc(0, 0, baseR + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Death fragments flying outward
    if (frag && frag.progress > 0.1) {
      ctx.fillStyle = hexRgba(pc, 0.7);
      ctx.shadowColor = pc;
      ctx.shadowBlur  = 8;
      for (let i = 0; i < 8; i++) {
        const ang  = i * Math.PI / 4 + t * 0.0009;
        const dist = frag.progress * baseR * 2.2 + i * 1.5;
        const rFrag = 1.2 + Math.abs(Math.sin(t * 0.012 + i)) * 0.8;
        ctx.beginPath();
        ctx.arc(Math.cos(ang) * dist, Math.sin(ang) * dist, rFrag, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  /** Draw a single shape in local design-space (coordinate range ±14). */
  _drawShape(ctx, s) {
    if (!s || !s.type) return;
    ctx.save();
    ctx.globalAlpha *= s.opacity || 0.8;
    ctx.shadowBlur   = 7;

    switch (s.type) {
      case 'circle': {
        const grd = ctx.createRadialGradient(
          (s.cx||0) - (s.r||6)*0.25, (s.cy||0) - (s.r||6)*0.25, 0,
          (s.cx||0), (s.cy||0), (s.r||6)
        );
        grd.addColorStop(0, hexLighten(s.color, 0.45));
        grd.addColorStop(1, s.color);
        ctx.fillStyle   = grd;
        ctx.strokeStyle = hexLighten(s.color, 0.5);
        ctx.lineWidth   = 0.5;
        ctx.beginPath();
        ctx.arc(s.cx||0, s.cy||0, s.r||6, 0, Math.PI*2);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'polygon': {
        const sides = Math.max(3, s.sides||6);
        const r     = s.r||8;
        const cx = s.cx||0, cy = s.cy||0;
        const rot = (s.rotation||0) * Math.PI / 180;
        ctx.fillStyle   = s.color;
        ctx.strokeStyle = hexLighten(s.color, 0.4);
        ctx.lineWidth   = 0.5;
        ctx.beginPath();
        for (let i = 0; i < sides; i++) {
          const a = rot + (i/sides)*Math.PI*2;
          if (i===0) ctx.moveTo(cx+Math.cos(a)*r, cy+Math.sin(a)*r);
          else       ctx.lineTo(cx+Math.cos(a)*r, cy+Math.sin(a)*r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'star': {
        const pts  = Math.max(3, s.points||5);
        const or_  = s.r||10, ir_ = Math.min(s.innerR||4, or_*0.85);
        const cx = s.cx||0, cy = s.cy||0;
        ctx.fillStyle   = s.color;
        ctx.strokeStyle = hexLighten(s.color, 0.5);
        ctx.lineWidth   = 0.5;
        ctx.beginPath();
        for (let i = 0; i < pts*2; i++) {
          const a = (i/(pts*2))*Math.PI*2 - Math.PI/2;
          const r = i%2===0 ? or_ : ir_;
          if (i===0) ctx.moveTo(cx+Math.cos(a)*r, cy+Math.sin(a)*r);
          else       ctx.lineTo(cx+Math.cos(a)*r, cy+Math.sin(a)*r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      }
      case 'line': {
        ctx.strokeStyle = s.color;
        ctx.lineWidth   = s.width||1;
        ctx.lineCap     = 'round';
        ctx.shadowBlur  = 10;
        ctx.beginPath();
        ctx.moveTo(s.x1||0, s.y1||0);
        ctx.lineTo(s.x2||0, s.y2||0);
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }

  /** Fallback node rendering with quantum breathing + interference rings. */
  _drawNodeFallback(ctx, nd, a, t) {
    const h      = agentHue(a);
    // Two-frequency quantum breathing
    const b1     = Math.sin(t * 0.00130 + nd.x * 0.005) * 0.085;
    const b2     = Math.sin(t * 0.00390 + nd.y * 0.004) * 0.040;
    const pulse  = 0.875 + b1 + b2;
    const nr     = NODE_R * pulse;

    // Quantum interference rings (expand/fade outward)
    for (let i = 0; i < 3; i++) {
      const rp  = ((t * 0.00045 + i * 0.333) % 1);
      const rr  = nr * (1.6 + rp * 3.0);
      const ra  = (1 - rp) * 0.10;
      ctx.strokeStyle = `hsla(${h},80%,70%,${ra.toFixed(3)})`;
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, rr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Outer energy aura
    const grd = ctx.createRadialGradient(nd.x, nd.y, 0, nd.x, nd.y, nr * 3.8);
    grd.addColorStop(0, `hsla(${h},80%,65%,${(0.28 * pulse).toFixed(2)})`);
    grd.addColorStop(0.4, `hsla(${h},70%,55%,${(0.10 * pulse).toFixed(2)})`);
    grd.addColorStop(1, `hsla(${h},70%,55%,0)`);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(nd.x, nd.y, nr * 3.8, 0, Math.PI*2);
    ctx.fill();

    // Core sphere
    const core = ctx.createRadialGradient(nd.x-nr*0.3, nd.y-nr*0.3, nr*0.05, nd.x, nd.y, nr);
    core.addColorStop(0, hsl(h,85,88));
    core.addColorStop(0.5, hsl(h,75,62));
    core.addColorStop(1, hsl(h,70,42));
    ctx.fillStyle = core;
    ctx.shadowColor = `hsla(${h},90%,70%,0.8)`;
    ctx.shadowBlur  = 14;
    ctx.beginPath();
    ctx.arc(nd.x, nd.y, nr, 0, Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.strokeStyle = `hsla(${h},80%,88%,0.55)`;
    ctx.lineWidth   = 0.9;
    ctx.stroke();

    if ((a.beliefs?.crimes||0) > 0 && Math.random() < 0.05) {
      ctx.strokeStyle = `rgba(255,60,60,${(Math.random()*0.5+0.2).toFixed(2)})`;
      ctx.lineWidth   = 1;
      ctx.shadowColor = '#ff2222';
      ctx.shadowBlur  = 8;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, nr+3+Math.random()*3, 0, Math.PI*2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  _drawDeaths(ctx, t) {
    for (const da of this.deathAnims) {
      const frac = clamp((t - da.t) / 2500, 0, 1);
      ctx.strokeStyle = `rgba(248,81,73,${((1 - frac) * 0.6).toFixed(2)})`;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.arc(da.x, da.y, 8 + frac * 50, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _drawTrackPulses(ctx, t) {
    for (const p of this.trackPulses) {
      const el = t - p.t;
      for (let i = 0; i < 3; i++) {
        const e = el - i * 200;
        if (e <= 0) continue;
        const frac = clamp(e / 900, 0, 1);
        ctx.strokeStyle = `rgba(255,215,55,${((1 - frac) * 0.85).toFixed(2)})`;
        ctx.lineWidth   = Math.max(0.3, 2 - frac * 1.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12 + frac * 48, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  _drawCollapse(ctx, t) {
    const frac = clamp((t - this.collapseState.t) / 4500, 0, 1);
    ctx.fillStyle = `rgba(0,0,8,${(frac * 0.85).toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(0, 0, 1200, 0, Math.PI * 2);
    ctx.fill();
    if (t - this.collapseState.t > 4500 && Math.sin((t - this.collapseState.t) * 0.009) > 0) {
      ctx.fillStyle = 'rgba(255,40,40,1)';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Screen-space draw calls ─────────────────────────────────────────────────

  /**
   * Labels are drawn in screen space so font size stays constant regardless
   * of zoom. World → screen: sx = worldX * sc + px
   */
  _drawLabels(ctx, t, W, H, sc, px, py) {
    const hl = this.highlightedAgent || this._hoverHighlightId;
    for (const [id, nd] of this.nodes) {
      const a     = nd.agent;
      const isHl  = id === hl;
      const dimA  = hl ? (isHl ? 1 : 0.12) : 1;
      const isoA  = Math.max(0.3, 1 - Math.max(0, (a.isolationTicks || 0) - 40) * 0.015);
      const alpha = dimA * isoA;

      // World → screen
      const sx = nd.x * sc + px;
      const sy = nd.y * sc + py;

      // Skip if offscreen (with margin)
      if (sx < -80 || sx > W + 80 || sy < -80 || sy > H + 80) continue;

      const h  = agentHue(a);
      const fs = isHl ? 13 : 11;

      ctx.save();
      ctx.globalAlpha  = alpha;
      ctx.font         = `600 ${fs}px "JetBrains Mono",monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.shadowColor  = hsl(h, 70, 60);
      ctx.shadowBlur   = isHl ? 10 : 4;

      // Agent name
      const formScale = (a.formModifiers||[]).find(m=>m.type==='power_expand')?.scale || 1;
      const labelNR   = NODE_R * formScale;
      ctx.fillStyle = 'rgba(190,215,255,0.92)';
      ctx.fillText(a.name, sx, sy - (labelNR + 4) * sc - 2);

      // AI system tag (smaller)
      // Hunger warning below node
      if (a.hungerStage && a.hungerStage !== 'healthy') {
        const stagePal = { hungry:'220,185,50', starving:'255,130,30', critical:'255,50,50' };
        const col = stagePal[a.hungerStage] || '200,200,200';
        ctx.font         = '600 9px "JetBrains Mono",monospace';
        ctx.fillStyle    = `rgba(${col},1)`;
        ctx.textBaseline = 'top';
        ctx.fillText(a.hungerStage.toUpperCase(), sx, sy + (labelNR + 3) * sc);
      }
      ctx.restore();
    }

  }

  _drawMinimap(ctx, W, H) {
    const MW = 110, MH = 82, MX = W - MW - 10, MY = H - MH - 10;
    ctx.save();
    ctx.fillStyle   = 'rgba(4,8,18,0.88)';
    ctx.strokeStyle = 'rgba(20,65,140,0.55)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(MX, MY, MW, MH, 4); else ctx.rect(MX, MY, MW, MH);
    ctx.fill();
    ctx.stroke();

    // Map world → minimap screen
    const rx = wx => MX + (wx + WORLD_W) * (MW / (WORLD_W * 2));
    const ry = wy => MY + (wy + WORLD_H) * (MH / (WORLD_H * 2));

    // Connection lines
    for (const c of this.connections) {
      const nA = this.nodes.get(c.a), nB = this.nodes.get(c.b);
      if (!nA || !nB || Math.abs(c.trust) < 0.1) continue;
      ctx.strokeStyle = c.trust > 0 ? 'rgba(55,140,255,0.5)' : 'rgba(255,55,55,0.5)';
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.moveTo(rx(nA.x), ry(nA.y));
      ctx.lineTo(rx(nB.x), ry(nB.y));
      ctx.stroke();
    }

    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;

    // Agent dots
    for (const nd of this.nodes.values()) {
      ctx.fillStyle = hsl(agentHue(nd.agent), 70, 62);
      ctx.beginPath();
      ctx.arc(rx(nd.x), ry(nd.y), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Viewport rectangle
    const sc = this.cam.scale, ppx = this.cam.panX, ppy = this.cam.panY;
    const vx0 = (      0 - ppx) / sc, vy0 = (      0 - ppy) / sc;
    const vx1 = (      W - ppx) / sc, vy1 = (      H - ppy) / sc;
    ctx.strokeStyle = 'rgba(80,175,255,0.6)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(rx(vx0), ry(vy0),
      (vx1 - vx0) * (MW / (WORLD_W * 2)),
      (vy1 - vy0) * (MH / (WORLD_H * 2))
    );

    ctx.fillStyle    = 'rgba(55,105,170,0.7)';
    ctx.font         = '6px "JetBrains Mono",monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('MAP', MX + 4, MY + 4);
    ctx.restore();
  }

  // ── Inventory item category orbit drawing ────────────────────────────────────

  /**
   * Draw category group nodes for all expanded agents' inventory items.
   * Each unique category becomes one hexagonal node orbiting the agent.
   */
  _drawWorldObjects(ctx, t) {
    const pulse       = 0.82 + Math.sin(t * 0.0022) * 0.18;
    const ORBIT_R     = 80;
    const ORBIT_SPEED = 0.00006;  // radians/ms — slow continuous drift

    this._orbitPositions.clear();
    this._catGroupPositions.clear();

    const CAT_COLORS = {
      weapon:'#ff3344', armor:'#3377ff', knowledge:'#ffcc00',
      consumable:'#33ff88', magic:'#bb33ff', structure:'#ff7733',
    };

    for (const [agentId, nd] of this.nodes) {
      if (!this._expandedAgentIds.has(agentId)) continue;

      const invObjs = this.worldObjects.filter(o =>
        o.agentIds && o.agentIds[0] === agentId && o.isInventoryItem
      ).slice(0, 36);
      if (!invObjs.length) continue;

      // Group by category
      const byCat = new Map();
      for (const obj of invObjs) {
        const cat = (obj.category || 'other').toLowerCase();
        if (!byCat.has(cat)) byCat.set(cat, []);
        byCat.get(cat).push(obj);
      }

      // Show all categories including 'other' (looted items start uncategorised)
      const cats = [];
      for (const [cat, objs] of byCat) {
        cats.push({ cat, objs });
      }
      if (!cats.length) continue;

      const total = cats.length;
      for (let i = 0; i < total; i++) {
        const { cat, objs } = cats[i];
        const pc    = CAT_COLORS[cat] || '#6688aa';
        const angle = (i / total) * Math.PI * 2 + t * ORBIT_SPEED;
        const ox    = nd.x + Math.cos(angle) * ORBIT_R;
        const oy    = nd.y + Math.sin(angle) * ORBIT_R;

        const catKey = `${agentId}:${cat}`;
        this._catGroupPositions.set(catKey, { wx: ox, wy: oy, agentId, category: cat, objs });

        try {
          // Dashed tether line using category color
          ctx.save();
          ctx.setLineDash([3, 5]);
          ctx.strokeStyle = pc + '55';
          ctx.lineWidth   = 0.8;
          ctx.globalAlpha = 0.7;
          ctx.beginPath(); ctx.moveTo(nd.x, nd.y); ctx.lineTo(ox, oy); ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();

          // Category group hexagon node
          ctx.save();
          ctx.translate(ox, oy);
          this._drawInvCategoryGroup(ctx, cat, objs.length, pulse, t);
          ctx.restore();

        } catch (e) {
          console.error('[INV CAT ERROR]', cat, e.message);
          try { ctx.restore(); } catch (_) {}
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          ctx.shadowBlur  = 0;
        }
      }
    }
  }

  /** Draw an inventory category group hexagon node (translated to ox,oy before call). */
  _drawInvCategoryGroup(ctx, category, count, pulse, t) {
    const CAT_COLORS = {
      weapon:'#ff3344', armor:'#3377ff', knowledge:'#ffcc00',
      consumable:'#33ff88', magic:'#bb33ff', structure:'#ff7733',
    };
    const CAT_ICONS = {
      weapon:'⚔', armor:'◈', knowledge:'◉', consumable:'◆', magic:'✦', structure:'⬡',
    };

    const cat = (category || 'other').toLowerCase();
    const pc  = CAT_COLORS[cat] || '#6688aa';
    const ico = CAT_ICONS[cat] || '●';
    const r   = 17 * pulse;
    const rot = t * 0.00007;

    // Outer glow halo
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.5);
    grd.addColorStop(0, hexRgba(pc, 0.28));
    grd.addColorStop(1, hexRgba(pc, 0));
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(0, 0, r * 2.5, 0, Math.PI * 2); ctx.fill();

    // Hexagon body
    ctx.shadowColor = pc;
    ctx.shadowBlur  = 14;
    ctx.fillStyle   = hexRgba(pc, 0.12);
    ctx.strokeStyle = hexRgba(pc, 0.85);
    ctx.lineWidth   = 1.8;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = rot + (i / 6) * Math.PI * 2;
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else         ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;

    // Category icon (center)
    ctx.fillStyle    = hexRgba(pc, 0.90);
    ctx.font         = `bold 9px "JetBrains Mono", monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ico, 0, 0);

    // Item count badge (top-right corner)
    const bx = r * 0.75;
    const by = -r * 0.75;
    const br = 7;
    ctx.fillStyle   = pc;
    ctx.shadowColor = pc;
    ctx.shadowBlur  = 5;
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur  = 0;
    ctx.fillStyle   = '#0a0a1a';
    ctx.font        = `bold 7px "JetBrains Mono", monospace`;
    ctx.fillText(String(count), bx, by);

    // Category label below
    const label = cat.length > 10 ? cat.slice(0, 9) + '…' : cat;
    ctx.font         = `7px "JetBrains Mono", monospace`;
    ctx.fillStyle    = hexRgba(pc, 0.75);
    ctx.textBaseline = 'top';
    ctx.fillText(label, 0, r + 4);
  }



  /** At low zoom: group nearby agents into clusters and render count bubbles. */
  _drawClusters(ctx, t, sc) {
    // Simple grid-cell clustering: threshold in world-px so clusters grow when zoomed out
    const cellSize = 100; // world-px per cell
    const cellMap  = new Map();
    for (const [, nd] of this.nodes) {
      const cx = Math.round(nd.x / cellSize);
      const cy = Math.round(nd.y / cellSize);
      const key = cx + '|' + cy;
      if (!cellMap.has(key)) cellMap.set(key, { cx, cy, nodes: [] });
      cellMap.get(key).nodes.push(nd);
    }

    ctx.save();
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    for (const { cx, cy, nodes } of cellMap.values()) {
      const wx = cx * cellSize;
      const wy = cy * cellSize;
      const r  = Math.max(22, Math.min(38, 22 + nodes.length * 2.5));
      const hl = this.highlightedAgent || this._hoverHighlightId;
      const isHl = hl && nodes.some(n => n.agent.id === hl);

      // Outer glow
      ctx.globalAlpha = isHl ? 0.55 : 0.28;
      ctx.shadowBlur  = isHl ? 22 : 10;
      ctx.shadowColor = '#88aaff';
      ctx.fillStyle   = isHl ? 'rgba(80,130,255,0.22)' : 'rgba(40,70,140,0.14)';
      ctx.beginPath(); ctx.arc(wx, wy, r + 6, 0, Math.PI * 2); ctx.fill();

      // Circle
      ctx.globalAlpha = isHl ? 0.9 : 0.7;
      ctx.shadowBlur  = isHl ? 18 : 8;
      ctx.strokeStyle = isHl ? '#a0c8ff' : 'rgba(80,130,200,0.75)';
      ctx.lineWidth   = isHl ? 2 : 1.5;
      ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.stroke();

      // Count label
      ctx.fillStyle  = isHl ? '#e8f4ff' : '#88aacc';
      ctx.shadowBlur = 0;
      ctx.font       = `700 ${Math.round(r * 0.55)}px "JetBrains Mono",monospace`;
      ctx.fillText(String(nodes.length), wx, wy);

      // "agents" sublabel
      ctx.globalAlpha = 0.45;
      ctx.font        = `9px "JetBrains Mono",monospace`;
      ctx.fillStyle   = '#6688aa';
      ctx.fillText(nodes.length === 1 ? 'agent' : 'agents', wx, wy + r * 0.68);
    }

    ctx.shadowBlur  = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }


  // ── Event processing ───────────────────────────────────────────────────────

  _onEvent(ev) {
    if (!ev.agentId) return;
    const nd = this.nodes.get(ev.agentId);
    if (!nd) return;
    const msg = (ev.msg || '').toLowerCase();
    if (ev.type === 'social' && (msg.includes('alliance') || msg.includes('shared') || msg.includes('taught'))) {
      this.flowers.push({ x: nd.x, y: nd.y, hue: agentHue(nd.agent), t: performance.now() });
    }
    if (ev.type === 'convert') {
      this.flowers.push({ x: nd.x, y: nd.y, hue: 275, t: performance.now() });
    }
    if (ev.isNovel || ev.type === 'world_first') {
      this._novelEffects.push({
        x: nd.x, y: nd.y,
        t: performance.now(),
        color: '#ffdd44',
        symbol: '⚡',
        wfId: null,
      });
    }
  }

  /** Called by app.js when `game_effect` socket event arrives (combat, enhancement, trade, etc). */
  onGameEffect(ev) {
    const now = performance.now();
    const ndA = ev.agentId    ? this.nodes.get(ev.agentId)    : null;
    const ndB = ev.targetId   ? this.nodes.get(ev.targetId)   :
                ev.defenderId ? this.nodes.get(ev.defenderId) :
                ev.toId       ? this.nodes.get(ev.toId)       : null;
    const ndF = ev.fromId     ? this.nodes.get(ev.fromId)     :
                ev.attackerId ? this.nodes.get(ev.attackerId) : null;

    // Helper: push effect with live nodeRef so position tracks the moving node
    const fx = (nd, color, symbol, dt = 0) => {
      if (!nd) return;
      this._novelEffects.push({ nodeRef: nd, x: nd.x, y: nd.y, t: now + dt, color, symbol, wfId: null });
    };

    switch (ev.type) {
      case 'enhancement_success':   fx(ndA, '#ffd700', '✨');  break;
      case 'enhancement_fail':      fx(ndA, '#888888', '💨');  break;
      case 'enhancement_critfail':  fx(ndA, '#ff4400', '💥');  break;
      case 'combat_success':
        fx(ndF, '#ff6600', '⚔️');
        fx(ndB, '#ff0000', '💔');
        break;
      case 'combat_fail':     fx(ndB, '#4488ff', '🛡️');  break;
      case 'combat_blocked':  fx(ndB, '#00aaff', '🛡️');  break;
      case 'war_declared':
        fx(ndA, '#ff2222', '⚔️');
        fx(ndB, '#ff2222', '⚔️');
        break;
      case 'peace_declared':
        fx(ndA, '#88ff88', '🕊️');
        fx(ndB, '#88ff88', '🕊️');
        break;
      case 'alliance_formed':
        fx(ndA, '#ffd700', '🤝');
        fx(ndB, '#ffd700', '🤝');
        break;
      case 'alliance_betrayal': fx(ndA, '#cc00ff', '💔');  break;
      case 'gift':
        fx(ndF, '#00ff88', '🎁');
        fx(ndB, '#00ff88', '🎁', 400);
        break;
      case 'theft':         fx(ndF, '#ff4444', '🦹');  break;
      case 'trade':
        fx(ndA, '#ffd700', '🔄');
        fx(ndB, '#ffd700', '🔄');
        break;
      case 'item_created':    fx(ndA, '#44aaff', '🔨');  break;
      case 'object_destroyed': fx(ndA, '#ff6600', '💥');  break;
    }

    // Prune old effects (keep max 30)
    if (this._novelEffects.length > 30) this._novelEffects.splice(0, this._novelEffects.length - 30);
  }

  /** Called by app.js when `novel_effect` socket event arrives (has LLM-designed color/symbol). */
  onNovelEffect(ev) {
    const nd = this.nodes.get(ev.agentId);
    if (!nd) return;
    // Replace pending default effect or push new one
    const existing = this._novelEffects.find(e => e.wfId === ev.wfId && e.wfId !== null);
    if (!existing) {
      this._novelEffects.push({
        nodeRef: nd,
        x: nd.x, y: nd.y,
        t: performance.now(),
        color: ev.color || '#ffdd44',
        symbol: ev.symbol || '⚡',
        wfId: ev.wfId || null,
      });
    }
  }

  _drawNovelEffects(ctx, t) {
    // NOTE: this method is called inside the ctx.save()/translate/scale block in _render(),
    // so all coordinates here are WORLD coordinates — no manual camera math needed.
    const DURATION = 2200; // ms
    for (const fx of this._novelEffects) {
      const age = t - fx.t;
      if (age >= DURATION) continue;
      const p  = age / DURATION;   // 0 → 1
      // Live world position — tracks the moving agent node exactly
      const wx = (fx.nodeRef && fx.nodeRef.x != null) ? fx.nodeRef.x : fx.x;
      const wy = (fx.nodeRef && fx.nodeRef.y != null) ? fx.nodeRef.y : fx.y;
      const maxR = 60; // world-space units; canvas transform scales to screen pixels

      ctx.save();
      // Expanding ring burst
      const ringR = maxR * Math.pow(p, 0.55);
      const alpha = (1 - p) * 0.85;
      ctx.beginPath();
      ctx.arc(wx, wy, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = hexRgba(fx.color, alpha);
      ctx.lineWidth = (1 - p) * 3.5 + 0.5;
      ctx.stroke();

      // Second trailing ring
      const ringR2 = maxR * Math.pow(Math.max(0, p - 0.15), 0.5);
      ctx.beginPath();
      ctx.arc(wx, wy, ringR2, 0, Math.PI * 2);
      ctx.strokeStyle = hexRgba(fx.color, alpha * 0.5);
      ctx.lineWidth = (1 - p) * 2;
      ctx.stroke();

      // Symbol in center (only first ~40% of duration)
      if (p < 0.4) {
        const symAlpha = (1 - p / 0.4);
        ctx.globalAlpha = symAlpha;
        ctx.font = '14px sans-serif'; // world-space px; canvas scale handles screen size
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = fx.color;
        ctx.fillText(fx.symbol.length === 1 ? fx.symbol : '⚡', wx, wy - ringR * 0.3);
      }

      ctx.restore();
    }
  }

  // ── Input binding ──────────────────────────────────────────────────────────

  _bindEvents() {
    const cv = this.canvas;

    // ── Wheel zoom ──
    // Keep the world point under the cursor fixed during zoom.
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const rect   = cv.getBoundingClientRect();
      const mx     = e.clientX - rect.left;
      const my     = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const ns     = clamp(this.tCam.scale * factor, MIN_SCALE, MAX_SCALE);

      // World point under cursor (using tCam so accumulated zooms are smooth)
      const wx = (mx - this.tCam.panX) / this.tCam.scale;
      const wy = (my - this.tCam.panY) / this.tCam.scale;

      // New pan so that same world point stays under cursor
      this.tCam.panX  = mx - wx * ns;
      this.tCam.panY  = my - wy * ns;
      this.tCam.scale = ns;
    }, { passive: false });

    // ── Pan drag ──
    cv.addEventListener('mousedown', e => {
      this._drag = {
        on: true, moved: false,
        sx: e.clientX, sy: e.clientY,
        spx: this.tCam.panX, spy: this.tCam.panY,
      };
      cv.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', e => {
      // Pan drag
      if (this._drag.on) {
        const dx = e.clientX - this._drag.sx;
        const dy = e.clientY - this._drag.sy;
        if (Math.hypot(dx, dy) > 4) {
          this._drag.moved = true;
          if (this.trackingId) {
            this.trackingId = null;
            if (this.onTrackRelease) this.onTrackRelease();
          }
        }
        this.tCam.panX = this._drag.spx + dx;
        this.tCam.panY = this._drag.spy + dy;
      }

      // Connection hover hit-test (using rendered cam for accuracy)
      const rect = cv.getBoundingClientRect();
      const sx   = e.clientX - rect.left;
      const sy   = e.clientY - rect.top;
      this._mouseScreen = { x: e.clientX, y: e.clientY };
      const wx = (sx - this.cam.panX) / this.cam.scale;
      const wy = (sy - this.cam.panY) / this.cam.scale;

      // Hit threshold scales inversely with zoom (easier to hover thin lines when zoomed out)
      const hitThresh = Math.max(4, 9 / this.cam.scale);
      let closest = null, minD = hitThresh;
      for (const c of this.connections) {
        const ndA = this.nodes.get(c.a), ndB = this.nodes.get(c.b);
        if (!ndA || !ndB) continue;
        const ep = Starmap._edgePoints(ndA, ndB);
        const d  = Starmap._ptSegDist(wx, wy, ep.ax, ep.ay, ep.bx, ep.by);
        if (d < minD) { minD = d; closest = c; }
      }

      if (closest !== this._hoveredConn) {
        this._hoveredConn = closest;
        if (closest) {
          this._showConnTooltip(closest, e.clientX, e.clientY);
        } else {
          this._hideConnTooltip();
        }
      } else if (closest) {
        // Update position while staying on same connection
        this._showConnTooltip(closest, e.clientX, e.clientY);
      }

      // Agent node hover — hit test in screen space, 40px minimum radius
      if (!this._drag.on) {
        const AG_HOVER_R = 40;
        let hitAgId = null, minAgD = AG_HOVER_R;
        for (const [id, nd] of this.nodes) {
          const nsx = nd.x * this.cam.scale + this.cam.panX;
          const nsy = nd.y * this.cam.scale + this.cam.panY;
          const d   = Math.hypot(sx - nsx, sy - nsy);
          if (d < minAgD) { minAgD = d; hitAgId = id; }
        }
        if (!closest) {
          if (hitAgId !== this._hoveredAgentId) {
            this._hoveredAgentId = hitAgId;
            if (hitAgId) {
              this._showAgentTooltip(this.nodes.get(hitAgId), e.clientX, e.clientY);
            } else {
              this._tooltipEl.style.display = 'none';
            }
          } else if (hitAgId) {
            this._showAgentTooltip(this.nodes.get(hitAgId), e.clientX, e.clientY);
          }
        } else if (this._hoveredAgentId) {
          // Connection takes priority — hide agent tooltip
          this._hoveredAgentId = null;
        }
      }

      // World object hover — check all orbit positions every frame
      if (!closest && this._orbitPositions.size > 0) {
        const woHitR = 18 / this.cam.scale;
        let hitWObj  = null;

        for (const [objId, pos] of this._orbitPositions) {
          if (Math.hypot(wx - pos.wx, wy - pos.wy) < woHitR) {
            hitWObj = this.worldObjects.find(o => o.id === objId) || null;
            if (hitWObj) break;
          }
        }
        if (this._openedWObj) {
          if (this._hoveredWObj) this._hideWOTooltip();
        } else if (hitWObj !== this._hoveredWObj) {
          this._hoveredWObj = hitWObj;
          if (hitWObj) this._showWOTooltip(hitWObj, e.clientX, e.clientY);
          else         this._hideWOTooltip();
        } else if (hitWObj) {
          this._showWOTooltip(hitWObj, e.clientX, e.clientY);
        }
      } else if (!closest) {
        if (this._hoveredWObj) {
          this._hoveredWObj = null;
          this._hideWOTooltip();
        }
      }
    });

    window.addEventListener('mouseup', () => {
      this._drag.on = false;
      cv.style.cursor = 'default';
    });

    cv.addEventListener('mouseleave', () => {
      this._hideConnTooltip();
      this._hideAgentTooltip();
    });

    // ── Double-click: zoom to agent or fit all ──
    cv.addEventListener('dblclick', e => {
      if (this._drag.moved) return;
      const rect = cv.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const my   = e.clientY - rect.top;
      const wx   = (mx - this.cam.panX) / this.cam.scale;
      const wy   = (my - this.cam.panY) / this.cam.scale;
      let hitId = null, minD = Infinity;
      for (const [id, nd] of this.nodes) {
        const sx = nd.x * this.cam.scale + this.cam.panX;
        const sy = nd.y * this.cam.scale + this.cam.panY;
        const d  = Math.hypot(mx - sx, my - sy);
        if (d < 40 && d < minD) { minD = d; hitId = id; }
      }
      if (hitId) this.locateAgent(hitId);
      else       this.fitAll();
    });

    // ── Click to select agent ──
    // Convert screen coords → world coords using the RENDERED cam (not tCam)
    // so the hit test matches what the user sees on screen.
    cv.addEventListener('click', e => {
      if (this._drag.moved) { this._drag.moved = false; return; }
      const rect = cv.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const my   = e.clientY - rect.top;

      // screen → world
      const wx = (mx - this.cam.panX) / this.cam.scale;
      const wy = (my - this.cam.panY) / this.cam.scale;

      // Check orbiting world objects first (always visible)
      if (this._orbitPositions.size > 0 || this._catGroupPositions.size > 0) {
        const woHitR = 20 / this.cam.scale;

        // ── Category group nodes ──────────────────────────────────────────
        for (const [, pos] of this._catGroupPositions) {
          if (Math.hypot(wx - pos.wx, wy - pos.wy) < woHitR) {
            this._hideWOTooltip();
            this._hideConnTooltip();
            const cr  = cv.getBoundingClientRect();
            const osx = cr.left + pos.wx * this.cam.scale + this.cam.panX;
            const osy = cr.top  + pos.wy * this.cam.scale + this.cam.panY;
            if (this.onCategoryClick) this.onCategoryClick(pos.agentId, pos.category, pos.objs, osx, osy);
            return;
          }
        }

        // ── Individual object orbs ────────────────────────────────────────
        let hitObj = null, hitObjPos = null;
        for (const [objId, pos] of this._orbitPositions) {
          if (Math.hypot(wx - pos.wx, wy - pos.wy) < woHitR) {
            hitObj    = this.worldObjects.find(o => o.id === objId) || null;
            hitObjPos = pos;
            if (hitObj) break;
          }
        }
        if (hitObj) {
          this._hideWOTooltip();
          this._hideConnTooltip();
          // Open info popup
          const cr  = cv.getBoundingClientRect();
          const osx = cr.left + hitObjPos.wx * this.cam.scale + this.cam.panX;
          const osy = cr.top  + hitObjPos.wy * this.cam.scale + this.cam.panY;
          let agSx = null, agSy = null;
          const agId = hitObj.agentIds && hitObj.agentIds[0];
          if (agId) {
            const agNd = this.nodes.get(agId);
            if (agNd) {
              agSx = cr.left + agNd.x * this.cam.scale + this.cam.panX;
              agSy = cr.top  + agNd.y * this.cam.scale + this.cam.panY;
            }
          }
          this._openedWObj = hitObj;
          if (this.onObjectClick) this.onObjectClick(hitObj, osx, osy, agSx, agSy);
          return;
        }
      }

      // ── Cluster click — at low zoom, clicking a cluster zooms into it ──
      const CLUSTER_SCALE = 0.45;
      if (this.cam.scale < CLUSTER_SCALE && this.nodes.size >= 4) {
        const cellSize = 100;
        const cx = Math.round(wx / cellSize);
        const cy = Math.round(wy / cellSize);
        const key = cx + '|' + cy;
        const clusterNodes = [];
        for (const [, nd] of this.nodes) {
          const ncx = Math.round(nd.x / cellSize);
          const ncy = Math.round(nd.y / cellSize);
          if (ncx + '|' + ncy === key) clusterNodes.push(nd);
        }
        if (clusterNodes.length > 0) {
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (const n of clusterNodes) {
            x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x);
            y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
          }
          const pad   = 120;
          const spanX = Math.max(x1 - x0, 80) + pad * 2;
          const spanY = Math.max(y1 - y0, 60) + pad * 2;
          const W2    = this.canvas.width  || 640;
          const H2    = this.canvas.height || 500;
          const ns    = clamp(Math.min(W2 / spanX, H2 / spanY), MIN_SCALE, MAX_SCALE);
          const mcx   = (x0 + x1) / 2;
          const mcy   = (y0 + y1) / 2;
          this.tCam.scale = ns;
          this.tCam.panX  = W2 / 2 - mcx * ns;
          this.tCam.panY  = H2 / 2 - mcy * ns;
          return;
        }
      }

      // ── World Event hit test (using assigned hex vertex positions) ──
      const WE_HIT_W = 20 / this.cam.scale;
      for (const we of this.worldEvents) {
        const hpos = this._eventHexPos.get(we.id);
        if (!hpos) continue;
        if (Math.hypot(wx - hpos.x, wy - hpos.y) < WE_HIT_W) {
          this._hideWEPopup();
          this._selectedWorldEvent = we;
          const cr = cv.getBoundingClientRect();
          this._showWEPopup(we, cr.left + hpos.x * this.cam.scale + this.cam.panX, cr.top + hpos.y * this.cam.scale + this.cam.panY, false);
          return;
        }
      }
      for (const p of this.pendingProposals) {
        const pnd = this.nodes.get(p.proposedBy);
        if (!pnd) continue;
        const ppx = pnd.x + 26, ppy = pnd.y - 22;
        if (Math.hypot(wx - ppx, wy - ppy) < WE_HIT_W) {
          this._hideWEPopup();
          this._selectedWorldEvent = p;
          const cr = cv.getBoundingClientRect();
          this._showWEPopup(p, cr.left + ppx * this.cam.scale + this.cam.panX, cr.top + ppy * this.cam.scale + this.cam.panY, true);
          return;
        }
      }

      // ── Agent node hit test — always checked BEFORE connection click ──
      // Nodes take priority: a click within 40px of any node always selects that node.
      const HIT_R_SCREEN = 40;
      let hitId = null, minD = Infinity;
      for (const [id, nd] of this.nodes) {
        const sx = nd.x * this.cam.scale + this.cam.panX;
        const sy = nd.y * this.cam.scale + this.cam.panY;
        const d  = Math.hypot(mx - sx, my - sy);
        if (d < HIT_R_SCREEN && d < minD) { minD = d; hitId = id; }
      }

      // ── Connection click — only if no node was hit nearby ──
      if (!hitId && this._hoveredConn && this.onConnectionClick) {
        this.onConnectionClick(this._hoveredConn);
        return;
      }

      if (hitId) {
        // Toggle this agent's objects
        const hasObjs = this.worldObjects.some(o => o.agentIds && o.agentIds[0] === hitId && !o.parentGroupId);
        if (hasObjs) {
          if (this._expandedAgentIds.has(hitId)) {
            this._expandedAgentIds.delete(hitId);
            // Close popup if it belonged to this agent
            if (this._openedWObj && this._openedWObj.agentIds && this._openedWObj.agentIds[0] === hitId) {
              this._openedWObj = null;
              if (this.onObjectClose) this.onObjectClose();
            }
          } else {
            this._expandedAgentIds.add(hitId);
          }
        }
        const newHl = this.highlightAgent(hitId);
        this._selectedAgentId             = newHl;
        this._selectedAgentConnectedEvents = new Set();
        if (this.onAgentClick) this.onAgentClick(newHl);
      } else {
        // Clicked empty space — hide ALL objects, clear selection
        this._selectedAgentId             = null;
        this._selectedAgentConnectedEvents = new Set();
        this._hideWEPopup();
        if (this._openedWObj) {
          this._openedWObj = null;
          if (this.onObjectClose) this.onObjectClose();
        }
        if (this._expandedAgentIds.size > 0) {
          this._expandedAgentIds.clear();
          this._orbitPositions.clear();
        } else if (this.highlightedAgent) {
          this.highlightedAgent = null;
          if (this.onAgentClick) this.onAgentClick(null);
        }
      }
    });

    // ── Touch: pinch-to-zoom + drag ──
    cv.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        this._drag.on = false;
        const t0 = e.touches[0], t1 = e.touches[1];
        this._pinch = {
          d0: Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
          s0: this.tCam.scale,
        };
      } else if (e.touches.length === 1) {
        const tc = e.touches[0];
        this._drag = {
          on: true, moved: false,
          sx: tc.clientX, sy: tc.clientY,
          spx: this.tCam.panX, spy: this.tCam.panY,
        };
        this._pinch = null;
      }
    }, { passive: true });

    cv.addEventListener('touchmove', e => {
      e.preventDefault();
      if (this._pinch && e.touches.length === 2) {
        const t0 = e.touches[0], t1 = e.touches[1];
        const d  = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
        this.tCam.scale = clamp(this._pinch.s0 * (d / this._pinch.d0), MIN_SCALE, MAX_SCALE);
      } else if (this._drag.on && e.touches.length === 1) {
        const tc = e.touches[0];
        this.tCam.panX = this._drag.spx + (tc.clientX - this._drag.sx);
        this.tCam.panY = this._drag.spy + (tc.clientY - this._drag.sy);
      }
    }, { passive: false });

    cv.addEventListener('touchend', () => {
      this._drag.on = false;
      this._pinch   = null;
    });

    // ── Keyboard shortcuts ──
    document.addEventListener('keydown', e => {
      // Don't intercept when user is typing in an input or textarea
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

      if (e.key === 'f' || e.key === 'F') {
        this.fitAll();
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        this.highlightedAgent = null;
        this._hoverHighlightId = null;
        this.trackingId = null;
        this._hoveredConn = null;
        this._hideConnTooltip();
        this._hideAgentTooltip();
        if (this.onAgentClick) this.onAgentClick(null);
        e.preventDefault();
      }
      // Arrow key pan: move by 60 screen-px in world space
      const panStep = 60 / this.tCam.scale;
      if (e.key === 'ArrowLeft')  { this.tCam.panX += 60; e.preventDefault(); }
      if (e.key === 'ArrowRight') { this.tCam.panX -= 60; e.preventDefault(); }
      if (e.key === 'ArrowUp')    { this.tCam.panY += 60; e.preventDefault(); }
      if (e.key === 'ArrowDown')  { this.tCam.panY -= 60; e.preventDefault(); }
      void panStep; // suppress unused warning
    });
  }
}

window.Starmap = Starmap;

})();
