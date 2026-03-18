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

    // World objects — persistent glowing markers
    this.worldObjects       = [];        // [{ ...serverData, x, y, spawnAnimT, pulsePhase }]
    this._serverWOMap       = new Map(); // id → server obj, for new-object detection
    this._svgImageCache     = new Map(); // id → { svg, img, loading, failed }
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

    // World object state
    this._expandedAgentIds = new Set();  // agentIds whose objects are currently shown
    this._orbitPositions   = new Map();  // objId → { wx, wy }  rebuilt each frame for visible objs
    this._expandedGroupIds = new Set();  // group objIds currently expanded (showing children)
    this._hoveredWObj      = null;       // world object currently under cursor
    this._openedWObj       = null;       // world object whose info popup is open (camera-follow)

    // Connection hover tooltip
    this._mouseScreen   = null;   // { x, y } in screen px, updated by mousemove
    this._hoveredConn   = null;   // connection object currently hovered
    this._tooltipEl     = this._createTooltip();

    // Line particles — flowing dots along connection lines
    this._lineParticles      = new Map();  // pairKey → [{progress, speed, dir}]
    this._lastParticleUpdate = 0;

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
    this._tooltipEl.innerHTML =
      `<b style="color:#e8f4ff">${nameA} ↔ ${nameB}</b><br>` +
      `${freq}` +
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
    const sys    = a.aiSystem || 'AI';
    const rep    = a.rep ?? 0;
    const repStr = (rep >= 0 ? '+' : '') + rep;
    const status = a.statusMessage || a.speech || null;
    const eduNotes = a.educationNotes || null;
    const el     = this._tooltipEl;
    el.innerHTML =
      `<b style="color:#e8f4ff">${a.symbol ? a.symbol + ' ' : ''}${a.name}</b>` +
      `<span style="margin-left:6px;font-size:9px;opacity:0.7">${sys}</span>\n` +
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

    // ── World objects sync ──
    const serverObjs = state.worldObjects || [];
    const serverMap  = new Map(serverObjs.map(o => [o.id, o]));

    // Remove objects no longer in server state
    this.worldObjects = this.worldObjects.filter(o => {
      if (!serverMap.has(o.id)) {
        this._orbitPositions.delete(o.id);
        this._expandedGroupIds.delete(o.id);
        return false;
      }
      return true;
    });

    // Remove agent from expanded set if they left
    for (const aid of this._expandedAgentIds) {
      if (!this.nodes.has(aid)) this._expandedAgentIds.delete(aid);
    }

    // Add newly arrived objects; update appearance if server just filled it
    for (const sObj of serverObjs) {
      if (!this._serverWOMap.has(sObj.id)) {
        const pos = this._computeWOPos(sObj);
        this.worldObjects.push({
          ...sObj,
          x:          pos.x,
          y:          pos.y,
          spawnAnimT: performance.now(),
          pulsePhase: Math.random() * Math.PI * 2,
        });
      } else {
        // Update appearance / visualSVG if they just arrived from server (async LLM)
        const cObj = this.worldObjects.find(o => o.id === sObj.id);
        if (cObj) {
          if (!cObj.appearance && sObj.appearance) {
            cObj.appearance = sObj.appearance;
          }
          if (!cObj.visualSVG && sObj.visualSVG) {
            cObj.visualSVG = sObj.visualSVG;
            this._svgImageCache.delete(sObj.id);
          }
          if (!cObj.purpose  && sObj.purpose)  cObj.purpose  = sObj.purpose;
          if (!cObj.category && sObj.category) cObj.category = sObj.category;
        }
      }
    }
    this._serverWOMap = serverMap;

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
    this._drawLineParticles(ctx, t);
    this._drawSignals(ctx, t);
    this._drawFlowers(ctx, t);
    this._drawNovelEffects(ctx, t);
    this._drawWorldObjects(ctx, t);

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

  /** Draw connection lines between agents — all visuals AI-decided, no hardcoded color meanings. */
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

      // ── Color: AI-decided only — neutral grey until AI responds ──
      const color = design?.color || '#6688aa';

      // ── Line weight: from AI design or dialogue frequency ──
      const lw = design?.thickness
        ? design.thickness * 0.65
        : dc >= 10 ? 2.8 + Math.abs(c.trust) * 1.2
        : dc >=  3 ? 1.4 + Math.abs(c.trust) * 0.9
        :             0.5 + Math.abs(c.trust) * 0.5;

      // ── Alpha: design-aware base, pulse effect animates it ──
      let baseA = design
        ? 0.28 + Math.min(0.55, dc * 0.04)
        : dc >= 10 ? 0.55 + Math.abs(c.trust) * 0.35
        : dc >=  3 ? 0.30 + Math.abs(c.trust) * 0.40
        :             0.15 + Math.abs(c.trust) * 0.25;

      if (design?.effect === 'pulse') {
        const hz = design.pulseSpeed === 'slow' ? 0.0008 : design.pulseSpeed === 'fast' ? 0.0032 : 0.0018;
        baseA *= (0.55 + Math.sin(t * hz + dc) * 0.45);
      }

      const alpha = hl      ? (isHl   ? Math.min(baseA * 2.2, 0.95) : 0.04)
                  : isHover ? Math.min(baseA * 2.0, 0.95)
                  :           baseA;

      const lineWidth = (isHl || isHover) ? lw * 2.2 : lw;
      const style  = design?.style  || 'solid';
      const effect = design?.effect || 'none';

      ctx.save();
      ctx.strokeStyle = hexRgba(color, alpha);
      ctx.lineWidth   = lineWidth;

      // ── Quantum glow — all connections emit some light ──
      const glowStr = (effect === 'glow' || isHl || isHover) ? (isHover ? 18 : 12) : 5;
      ctx.shadowColor = hexRgba(color, isHover ? 0.85 : 0.55);
      ctx.shadowBlur  = glowStr;

      // ── Spark: random brightness burst every few frames ──
      if (effect === 'spark' && Math.random() < 0.05) {
        ctx.shadowColor = hexRgba(color, 0.9);
        ctx.shadowBlur  = 20;
        ctx.strokeStyle = hexRgba(color, Math.min(alpha * 2.2, 1));
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

      // World-object count badge (top-right of node)
      const woCount = this.worldObjects.filter(o => o.agentIds && o.agentIds[0] === id && !o.parentGroupId).length;
      if (woCount > 0) {
        const bx = nd.x + NODE_R * 0.7;
        const by = nd.y - NODE_R * 0.7;
        const br = 5.5;
        ctx.shadowBlur  = 0;
        ctx.fillStyle   = 'rgba(68,136,255,0.92)';
        ctx.strokeStyle = 'rgba(140,180,255,0.85)';
        ctx.lineWidth   = 1;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle    = '#d0e8ff';
        ctx.font         = `600 5px "JetBrains Mono",monospace`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(woCount), bx, by);
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
      ctx.font      = '8px "JetBrains Mono",monospace';
      ctx.fillStyle = 'rgba(110,145,190,0.55)';
      ctx.fillText(a.aiSystem || '', sx, sy - (labelNR + 15) * sc - 2);

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

  // ── World object helpers ────────────────────────────────────────────────────

  _computeWOPos(sObj) {
    const agentNodes = (sObj.agentIds || []).map(id => this.nodes.get(id)).filter(Boolean);
    if (!agentNodes.length) {
      const ang = Math.random() * Math.PI * 2;
      const r   = 55 + Math.random() * 110;
      return { x: Math.cos(ang) * r, y: Math.sin(ang) * r };
    }
    const cx  = agentNodes.reduce((s, n) => s + n.x, 0) / agentNodes.length;
    const cy  = agentNodes.reduce((s, n) => s + n.y, 0) / agentNodes.length;
    const off = 38 + Math.random() * 28;
    const ang = Math.random() * Math.PI * 2;
    return {
      x: clamp(cx + Math.cos(ang) * off, -WORLD_W + 20, WORLD_W - 20),
      y: clamp(cy + Math.sin(ang) * off, -WORLD_H + 20, WORLD_H - 20),
    };
  }

  // ── World object orbit drawing ───────────────────────────────────────────────

  /**
   * Draw objects for all agents whose ids are in _expandedAgentIds.
   * Click agent to toggle; click empty space to hide all.
   * Groups orbit as larger orbs; clicking expands their children.
   */
  _drawWorldObjects(ctx, t) {
    const pulse       = 0.82 + Math.sin(t * 0.0022) * 0.18;
    const ORBIT_SPEED = 0.00010;  // radians/ms — slow continuous drift

    // Rebuild orbit positions only for currently visible objects
    this._orbitPositions.clear();
    this._catGroupPositions.clear();

    for (const [agentId, nd] of this.nodes) {
      if (!this._expandedAgentIds.has(agentId)) continue;

      // Top-level objects: belong to this agent AND are not a child inside a group
      const topObjs = this.worldObjects.filter(o =>
        o.agentIds && o.agentIds[0] === agentId && !o.parentGroupId
      );
      if (!topObjs.length) continue;

      // ── Group by AI-assigned category ────────────────────────────────────
      // Categories with 2+ objects → category group node on starmap
      // Categories with 1 object or no category → shown individually
      const byCategory = new Map(); // cat string → [obj]
      for (const obj of topObjs) {
        const cat = (obj.category || '').trim();
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat).push(obj);
      }
      const renderItems = []; // { type:'catGroup', category, objs } | { type:'obj', obj }
      for (const [cat, objs] of byCategory) {
        if (cat && objs.length >= 2) {
          renderItems.push({ type: 'catGroup', category: cat, objs });
        } else {
          for (const obj of objs) renderItems.push({ type: 'obj', obj });
        }
      }

      const count      = renderItems.length;
      const baseRadius = 46 + count * 10;

      for (let i = 0; i < count; i++) {
        const item    = renderItems[i];
        const isCat   = item.type === 'catGroup';
        const isGroup = !isCat && item.obj.type === 'group';
        const phase   = (i / count) * Math.PI * 2;
        const angle   = phase + t * ORBIT_SPEED;
        const r       = isCat ? baseRadius * 1.15 : (isGroup ? baseRadius * 1.2 : baseRadius);
        const ox      = nd.x + Math.cos(angle) * r;
        const oy      = nd.y + Math.sin(angle) * r;

        const gc = isCat
          ? (nd.agent?.visualForm?.primaryColor || '#58a6ff')
          : (item.obj.appearance?.glowColor || nd.agent?.visualForm?.primaryColor || this._woGlowColor(item.obj.type));

        // Dashed tether from agent to item
        ctx.save();
        const lg = ctx.createLinearGradient(nd.x, nd.y, ox, oy);
        lg.addColorStop(0, hexRgba(gc, 0));
        lg.addColorStop(1, hexRgba(gc, isCat ? 0.35 : 0.22));
        ctx.strokeStyle = lg;
        ctx.lineWidth   = isCat ? 0.9 : 0.6;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([2, 6]);
        ctx.beginPath(); ctx.moveTo(nd.x, nd.y); ctx.lineTo(ox, oy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        if (isCat) {
          // ── Category group node ──────────────────────────────────────────
          const key = `${agentId}:${item.category}`;
          this._catGroupPositions.set(key, { wx: ox, wy: oy, agentId, category: item.category, objs: item.objs });
          ctx.save();
          ctx.translate(ox, oy);
          this._drawCategoryGroup(ctx, item.category, item.objs.length, nd.agent, pulse, t);
          ctx.restore();
        } else {
          // ── Individual object orb (existing behaviour) ───────────────────
          const obj = item.obj;
          this._orbitPositions.set(obj.id, { wx: ox, wy: oy });

          ctx.save();
          ctx.translate(ox, oy);
          if (isGroup) ctx.scale(1.45, 1.45);
          this._drawAIDesignedObject(ctx, t, obj, pulse, nd.agent);
          ctx.restore();

          this._drawWOLabel(ctx, { ...obj, x: ox, y: oy }, 0.65);

          // If this is an expanded group, draw its children orbiting around it
          if (isGroup && this._expandedGroupIds.has(obj.id)) {
            const children = (obj.childIds || [])
              .map(cid => this.worldObjects.find(o => o.id === cid))
              .filter(Boolean);
            const cCount  = children.length;
            const childR  = 26;
            for (let ci = 0; ci < cCount; ci++) {
              const child   = children[ci];
              const cPhase  = (ci / cCount) * Math.PI * 2;
              const cAngle  = cPhase + t * ORBIT_SPEED * 2.4;
              const cx2     = ox + Math.cos(cAngle) * childR;
              const cy2     = oy + Math.sin(cAngle) * childR;
              this._orbitPositions.set(child.id, { wx: cx2, wy: cy2 });

              const cgc = child.appearance?.glowColor
                       || nd.agent?.visualForm?.primaryColor
                       || this._woGlowColor(child.type);
              ctx.save();
              const clg = ctx.createLinearGradient(ox, oy, cx2, cy2);
              clg.addColorStop(0, hexRgba(cgc, 0));
              clg.addColorStop(1, hexRgba(cgc, 0.3));
              ctx.strokeStyle = clg;
              ctx.lineWidth   = 0.5;
              ctx.globalAlpha = 0.45;
              ctx.setLineDash([2, 4]);
              ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(cx2, cy2);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.restore();

              ctx.save();
              ctx.translate(cx2, cy2);
              ctx.scale(0.65, 0.65);
              this._drawAIDesignedObject(ctx, t, child, pulse, nd.agent);
              ctx.restore();
              this._drawWOLabel(ctx, { ...child, x: cx2, y: cy2 }, 0.45);
            }
          }
        }
      }
    }
  }

  /** Draw a category group node (translated to ox,oy before call). */
  _drawCategoryGroup(ctx, category, count, agent, pulse, t) {
    const pc  = agent?.visualForm?.primaryColor  || '#58a6ff';
    const r   = 15 * pulse;
    const rot = t * 0.00007;

    // Glow halo
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 2.8);
    grd.addColorStop(0, hexRgba(pc, 0.40));
    grd.addColorStop(1, hexRgba(pc, 0));
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(0, 0, r * 2.8, 0, Math.PI * 2); ctx.fill();

    // Hexagon body
    ctx.shadowColor = pc; ctx.shadowBlur = 16;
    ctx.fillStyle   = hexRgba(pc, 0.15);
    ctx.strokeStyle = hexRgba(pc, 0.90);
    ctx.lineWidth   = 1.6;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = rot + (i / 6) * Math.PI * 2;
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else         ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;

    // Count badge in centre
    ctx.fillStyle    = hexRgba(pc, 0.95);
    ctx.font         = `bold 9px "JetBrains Mono", monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(count), 0, 0);

    // Category label below the hex
    const label = category.length > 12 ? category.slice(0, 11) + '…' : category;
    ctx.font      = `7.5px "JetBrains Mono", monospace`;
    ctx.fillStyle = hexRgba(pc, 0.80);
    ctx.fillText(label, 0, r + 10);
  }

  /**
   * Returns a ready HTMLImageElement for obj.visualSVG, or null if not yet loaded.
   * Kicks off async image creation on first call; subsequent frames get the cached result.
   */
  _getSVGImage(obj) {
    const cached = this._svgImageCache.get(obj.id);
    if (cached) {
      if (cached.svg !== obj.visualSVG) {
        // SVG changed — invalidate and recreate
        this._svgImageCache.delete(obj.id);
      } else {
        return cached.img || null; // null while loading or failed
      }
    }

    // Mark as loading immediately to avoid duplicate requests
    this._svgImageCache.set(obj.id, { svg: obj.visualSVG, img: null, loading: true });

    const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="80" height="80">${obj.visualSVG}</svg>`;
    const blob = new Blob([svgMarkup], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const img  = new Image(80, 80);
    img.onload = () => {
      URL.revokeObjectURL(url);
      this._svgImageCache.set(obj.id, { svg: obj.visualSVG, img, loading: false });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      this._svgImageCache.set(obj.id, { svg: obj.visualSVG, img: null, loading: false, failed: true });
    };
    img.src = url;
    return null; // not ready yet — caller uses fallback
  }

  /** Draw a world object using its AI-designed appearance, or agent-color fallback. */
  _drawAIDesignedObject(ctx, t, obj, pulse, agent) {

    // ── AI SVG visualization (highest priority) ──────────────────────────────
    if (obj.visualSVG) {
      const glowColor = obj.appearance?.glowColor
                     || agent?.visualForm?.primaryColor
                     || this._woGlowColor(obj.type);

      // Glow halo behind the SVG
      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, 48);
      grd.addColorStop(0, hexRgba(glowColor, 0.35 * pulse));
      grd.addColorStop(0.5, hexRgba(glowColor, 0.12));
      grd.addColorStop(1, hexRgba(glowColor, 0));
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(0, 0, 48, 0, Math.PI * 2); ctx.fill();

      const img = this._getSVGImage(obj);
      if (img) {
        // Clip to 80×80 circle so SVG content never overflows
        ctx.save();
        ctx.beginPath(); ctx.arc(0, 0, 40, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(img, -40, -40, 80, 80);
        ctx.restore();
      } else {
        // SVG loading or failed — draw fallback circle while waiting
        const fc = glowColor;
        ctx.shadowColor = fc; ctx.shadowBlur = 14;
        ctx.fillStyle   = hexRgba(fc, 0.4);
        ctx.beginPath(); ctx.arc(0, 0, 12 * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur  = 0;
      }
      return;
    }

    const ap = obj.appearance;

    // Fallback: use agent's primary color; vary shape by object type
    if (!ap) {
      const fc = agent?.visualForm?.primaryColor
              || agent?.visualForm?.secondaryColor
              || this._woGlowColor(obj.type);
      const r = 10 * pulse;

      // Outer glow halo
      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 3);
      grd.addColorStop(0, hexRgba(fc, 0.3));
      grd.addColorStop(1, hexRgba(fc, 0));
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(0, 0, r * 3, 0, Math.PI * 2); ctx.fill();

      // Shape varies by type so fallbacks aren't all identical circles
      ctx.shadowColor = fc; ctx.shadowBlur = 14;
      ctx.fillStyle   = hexRgba(fc, 0.15);
      ctx.strokeStyle = fc;
      ctx.lineWidth   = 1.5;

      const rot = t * 0.00014;
      if (obj.type === 'law') {
        // Square (rotated)
        ctx.save(); ctx.rotate(rot + Math.PI / 4);
        ctx.beginPath();
        ctx.rect(-r * 0.75, -r * 0.75, r * 1.5, r * 1.5);
        ctx.fill(); ctx.stroke();
        ctx.restore();
      } else if (obj.type === 'religion') {
        // 8-pointed star
        const ir = r * 0.38;
        ctx.beginPath();
        for (let i = 0; i < 16; i++) {
          const a = rot + (i / 16) * Math.PI * 2;
          const rv = i % 2 === 0 ? r : ir;
          if (i === 0) ctx.moveTo(Math.cos(a)*rv, Math.sin(a)*rv);
          else         ctx.lineTo(Math.cos(a)*rv, Math.sin(a)*rv);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      } else if (obj.type === 'verdict') {
        // Triangle
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = rot - Math.PI/2 + (i/3)*Math.PI*2;
          if (i === 0) ctx.moveTo(Math.cos(a)*r, Math.sin(a)*r);
          else         ctx.lineTo(Math.cos(a)*r, Math.sin(a)*r);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      } else {
        // Hexagon for discovery / concept
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = rot + (i/6)*Math.PI*2;
          if (i === 0) ctx.moveTo(Math.cos(a)*r, Math.sin(a)*r);
          else         ctx.lineTo(Math.cos(a)*r, Math.sin(a)*r);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.shadowBlur = 0;
      return;
    }

    // ── AI-designed appearance ──
    const pc  = ap.primaryColor   || '#58a6ff';
    const sc  = ap.secondaryColor || '#1e3a8a';
    const gc  = ap.glowColor      || '#88aaff';
    // Use size as radius (size 10-40 → r 8-33px after pulse)
    const r   = Math.max(6, ap.size * 0.82) * pulse;
    const rot = t * 0.00014;

    // Outer glow — large radial gradient halo
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 3.0);
    grd.addColorStop(0, hexRgba(gc, 0.42));
    grd.addColorStop(0.4, hexRgba(gc, 0.18));
    grd.addColorStop(1, hexRgba(gc, 0));
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(0, 0, r * 3.0, 0, Math.PI * 2); ctx.fill();

    ctx.shadowColor = gc;
    ctx.shadowBlur  = 18;

    switch (ap.shape) {
      case 'star': {
        // 5-pointed star with pronounced spikes (inner radius 30%)
        const npts = 5, ir = r * 0.30;
        ctx.fillStyle   = pc;
        ctx.strokeStyle = sc;
        ctx.lineWidth   = 1.4;
        ctx.beginPath();
        for (let i = 0; i < npts * 2; i++) {
          const a  = rot - Math.PI / 2 + (i / (npts * 2)) * Math.PI * 2;
          const rv = i % 2 === 0 ? r : ir;
          if (i === 0) ctx.moveTo(Math.cos(a) * rv, Math.sin(a) * rv);
          else         ctx.lineTo(Math.cos(a) * rv, Math.sin(a) * rv);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        // Bright inner ring
        ctx.strokeStyle = hexRgba(gc, 0.7);
        ctx.lineWidth   = 0.6;
        ctx.shadowBlur  = 0;
        ctx.beginPath(); ctx.arc(0, 0, ir * 0.9, 0, Math.PI * 2); ctx.stroke();
        break;
      }

      case 'diamond': {
        // Elongated diamond — taller than wide
        ctx.fillStyle   = pc;
        ctx.strokeStyle = sc;
        ctx.lineWidth   = 1.4;
        ctx.beginPath();
        ctx.moveTo(0,        -r);
        ctx.lineTo(r * 0.62,  0);
        ctx.lineTo(0,         r);
        ctx.lineTo(-r * 0.62, 0);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        // Inner highlight line
        ctx.strokeStyle = hexRgba(gc, 0.6);
        ctx.lineWidth   = 0.6;
        ctx.shadowBlur  = 0;
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.5); ctx.lineTo(0, r * 0.5);
        ctx.stroke();
        break;
      }

      case 'hexagon': {
        // Hexagon with inner smaller hexagon fill
        ctx.fillStyle   = pc;
        ctx.strokeStyle = sc;
        ctx.lineWidth   = 1.4;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = rot + (i / 6) * Math.PI * 2;
          if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else         ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        // Inner hexagon (secondaryColor tint)
        ctx.fillStyle   = hexRgba(sc, 0.45);
        ctx.strokeStyle = hexRgba(gc, 0.5);
        ctx.lineWidth   = 0.6;
        ctx.shadowBlur  = 0;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = rot + Math.PI/6 + (i / 6) * Math.PI * 2;
          const rv = r * 0.48;
          if (i === 0) ctx.moveTo(Math.cos(a)*rv, Math.sin(a)*rv);
          else         ctx.lineTo(Math.cos(a)*rv, Math.sin(a)*rv);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        break;
      }

      case 'triangle': {
        ctx.fillStyle   = pc;
        ctx.strokeStyle = sc;
        ctx.lineWidth   = 1.4;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = rot - Math.PI / 2 + (i / 3) * Math.PI * 2;
          if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else         ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        // Inner triangle (inverted)
        ctx.fillStyle   = hexRgba(sc, 0.4);
        ctx.strokeStyle = hexRgba(gc, 0.4);
        ctx.lineWidth   = 0.5;
        ctx.shadowBlur  = 0;
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = rot + Math.PI / 2 + (i / 3) * Math.PI * 2;
          const rv = r * 0.42;
          if (i === 0) ctx.moveTo(Math.cos(a)*rv, Math.sin(a)*rv);
          else         ctx.lineTo(Math.cos(a)*rv, Math.sin(a)*rv);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        break;
      }

      default: { // circle — most visually distinct from shapes by using ring + center dot
        ctx.fillStyle   = hexRgba(pc, 0.25);
        ctx.strokeStyle = pc;
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        // Second inner ring (sc)
        ctx.strokeStyle = sc;
        ctx.lineWidth   = 1;
        ctx.shadowBlur  = 0;
        ctx.beginPath(); ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2); ctx.stroke();
        // Center dot
        ctx.fillStyle = pc;
        ctx.beginPath(); ctx.arc(0, 0, r * 0.18, 0, Math.PI * 2); ctx.fill();
        break;
      }
    }

    // Symbol text inside shape
    if (ap.symbol) {
      ctx.shadowBlur   = 0;
      ctx.fillStyle    = hexRgba(gc, 0.95);
      const fs = Math.max(4, Math.min(r * 0.5, 9));
      ctx.font         = `700 ${fs}px "JetBrains Mono",monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ap.symbol.slice(0, 5), 0, 0);
    }

    ctx.shadowBlur = 0;
  }


  _drawWOLabel(ctx, obj, alpha) {
    // Draw label in world space (scales with zoom), positioned below the object
    if (alpha < 0.1) return;
    const maxLen = 22;
    const label  = obj.name.length > maxLen ? obj.name.slice(0, maxLen - 1) + '…' : obj.name;
    const objR   = obj.appearance ? obj.appearance.size / 2 : 11;
    const gc     = obj.appearance?.glowColor || this._woGlowColor(obj.type);
    ctx.save();
    ctx.globalAlpha = alpha * 0.9;
    ctx.translate(obj.x, obj.y);
    ctx.font         = '500 5.5px "JetBrains Mono",monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle    = obj.appearance?.primaryColor || this._woLabelColor(obj.type);
    ctx.shadowColor  = gc;
    ctx.shadowBlur   = 5;
    ctx.fillText(label, 0, objR + 5);
    ctx.restore();
  }

  _woLabelColor(type) {
    const map = { law: '#ffe680', religion: '#e5b8ff', discovery: '#a0ecff', verdict: '#ff9090', concept: '#96ffe0' };
    return map[type] || '#ccddff';
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

  _woGlowColor(type) {
    const map = { law: '#ffd700', religion: '#c084fc', discovery: '#64dcff', verdict: '#ff3030', concept: '#50c8a0' };
    return map[type] || '#88aaff';
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

  /** Called by app.js when `novel_effect` socket event arrives (has LLM-designed color/symbol). */
  onNovelEffect(ev) {
    const nd = this.nodes.get(ev.agentId);
    if (!nd) return;
    // Replace pending default effect or push new one
    const existing = this._novelEffects.find(e => e.wfId === ev.wfId && e.wfId !== null);
    if (!existing) {
      this._novelEffects.push({
        x: nd.x, y: nd.y,
        t: performance.now(),
        color: ev.color || '#ffdd44',
        symbol: ev.symbol || '⚡',
        wfId: ev.wfId || null,
      });
    }
  }

  _drawNovelEffects(ctx, t) {
    const DURATION = 2200; // ms
    for (const fx of this._novelEffects) {
      const age = t - fx.t;
      if (age >= DURATION) continue;
      const p   = age / DURATION;            // 0 → 1
      const sx  = fx.x * this.cam.scale + this.cam.panX;
      const sy  = fx.y * this.cam.scale + this.cam.panY;
      const maxR = 60 * this.cam.scale;

      ctx.save();
      // Expanding ring burst
      const ringR = maxR * Math.pow(p, 0.55);
      const alpha = (1 - p) * 0.85;
      ctx.beginPath();
      ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = hexRgba(fx.color, alpha);
      ctx.lineWidth = (1 - p) * 3.5 + 0.5;
      ctx.stroke();

      // Second trailing ring
      const ringR2 = maxR * Math.pow(Math.max(0, p - 0.15), 0.5);
      ctx.beginPath();
      ctx.arc(sx, sy, ringR2, 0, Math.PI * 2);
      ctx.strokeStyle = hexRgba(fx.color, alpha * 0.5);
      ctx.lineWidth = (1 - p) * 2;
      ctx.stroke();

      // Symbol in center (only first ~40% of duration)
      if (p < 0.4) {
        const symAlpha = (1 - p / 0.4);
        ctx.globalAlpha = symAlpha;
        ctx.font = `${Math.round(14 * this.cam.scale)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = fx.color;
        ctx.fillText(fx.symbol.length === 1 ? fx.symbol : '⚡', sx, sy - ringR * 0.3);
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
        let hitWObj = null;
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
      } else if (this._hoveredWObj) {
        this._hoveredWObj = null;
        this._hideWOTooltip();
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
          if (hitObj.type === 'group') {
            // Toggle group expansion
            if (this._expandedGroupIds.has(hitObj.id)) this._expandedGroupIds.delete(hitObj.id);
            else                                        this._expandedGroupIds.add(hitObj.id);
            return;
          }
          // Non-group: open info popup
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
        if (this.onAgentClick) this.onAgentClick(newHl);
      } else {
        // Clicked empty space — hide ALL objects
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
