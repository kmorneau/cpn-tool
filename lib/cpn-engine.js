/**
 * CPN Engine — Colored Petri Net core logic.
 *
 * Works as a UMD module: CommonJS (Node.js tests) or browser global.
 * No DOM dependencies. All state is encapsulated per createEngine() call.
 *
 * Usage (Node.js):
 *   const { createEngine, EXAMPLES } = require('./lib/cpn-engine');
 *   const { S, parseCPN, getEnabled, ... } = createEngine();
 *
 * Usage (browser):
 *   <script src="/lib/cpn-engine.js"></script>
 *   const engine = createEngine({ render: () => renderDOM(), log: myLog });
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    const exp = factory();
    global.createEngine = exp.createEngine;
    global.EXAMPLES = exp.EXAMPLES;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────
  const PLACE_R = 46, TW = 90, TH = 40, GRID = 24;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── Example models ───────────────────────────────────────────────
  const EXAMPLES = {
    producer: `// Producer-Consumer CPN
colorset JOBS = {job1, job2, job3}
colorset WORKERS = {w1, w2}

place Ready    : JOBS    = {job1, job2, job3}
place Idle     : WORKERS = {w1, w2}
place Busy     : JOBS*WORKERS = {}
place Done     : JOBS    = {}

transition Assign   [guard: j in JOBS, w in WORKERS]
transition Complete [guard: true]

arc Ready    --> Assign   : j
arc Idle     --> Assign   : w
arc Assign   --> Busy     : (j,w)
arc Busy     --> Complete : (j,w)
arc Complete --> Done     : j
arc Complete --> Idle     : w`,

    philosophers: `// Dining Philosophers
colorset PHIL = {p1, p2}
colorset FORK = {f1, f2}

place Thinking : PHIL      = {p1, p2}
place Eating   : PHIL*FORK = {}
place Forks    : FORK      = {f1, f2}

transition PickUp  [guard: p in PHIL, f in FORK]
transition PutDown [guard: true]

arc Thinking --> PickUp  : p
arc Forks    --> PickUp  : f
arc PickUp   --> Eating  : (p,f)
arc Eating   --> PutDown : (p,f)
arc PutDown  --> Thinking: p
arc PutDown  --> Forks   : f`,

    pipeline: `// Token Pipeline
colorset DATA = {a, b, c}

place Input   : DATA = {a, b, c}
place Buffer  : DATA = {}
place Output  : DATA = {}

transition Push [guard: true]
transition Pop  [guard: true]

arc Input  --> Push   : x
arc Push   --> Buffer : x
arc Buffer --> Pop    : x
arc Pop    --> Output : x`,

    mutex: `// Mutual Exclusion
colorset PROC = {p1, p2}
colorset SEM  = {s}

place Ready     : PROC = {p1, p2}
place Critical  : PROC = {}
place Done      : PROC = {}
place Semaphore : SEM  = {s}

transition Enter [guard: p in PROC]
transition Exit  [guard: true]

arc Ready     --> Enter     : p
arc Semaphore --> Enter     : s
arc Enter     --> Critical  : p
arc Critical  --> Exit      : p
arc Exit      --> Done      : p
arc Exit      --> Semaphore : s`,
  };

  // ── Factory ──────────────────────────────────────────────────────
  function createEngine({ render: renderCb = () => {}, log: logCb = null } = {}) {

    // Application state — one object per engine instance
    const S = {
      places: [], transitions: [], arcs: [], colorsets: {},
      selected: null,
      tool: 'select',
      mode: 'visual',
      snap: true,
      tx: 0, ty: 0, scale: 1,
      arcSrc: null,
      simStep: 0, playing: false, playTimer: null,
      history: [], histIdx: -1,
      nc: 0, ac: 0,
      stateSpace: null,
      log: [],
      ctxTarget: null,
    };

    function render() { renderCb(); }

    function log(msg, kind = 'system') {
      S.log.push({ msg, kind });
      if (logCb) logCb(msg, kind);
    }

    // ── Commands ─────────────────────────────────────────────────
    function execCmd(cmd) {
      cmd.do();
      S.history.splice(S.histIdx + 1);
      S.history.push(cmd);
      S.histIdx = S.history.length - 1;
      render();
    }
    function undo() {
      if (S.histIdx < 0) return;
      S.history[S.histIdx].undo();
      S.histIdx--;
      render();
    }
    function redo() {
      if (S.histIdx >= S.history.length - 1) return;
      S.histIdx++;
      S.history[S.histIdx].do();
      render();
    }

    const Cmd = {
      addPlace(x, y) {
        const id = 'P' + (++S.nc);
        const node = { id, x, y, label: id, colorSet: 'TOKEN', initTokens: [], tokens: [] };
        return {
          do()   { S.places.push(node); S.selected = { type: 'place', id }; },
          undo() { S.places = S.places.filter(p => p.id !== id); S.arcs = S.arcs.filter(a => a.src !== id && a.tgt !== id); if (S.selected?.id === id) S.selected = null; },
        };
      },
      addTransition(x, y) {
        const id = 'T' + (++S.nc);
        const node = { id, x, y, label: id, guard: 'true' };
        return {
          do()   { S.transitions.push(node); S.selected = { type: 'transition', id }; },
          undo() { S.transitions = S.transitions.filter(t => t.id !== id); S.arcs = S.arcs.filter(a => a.src !== id && a.tgt !== id); if (S.selected?.id === id) S.selected = null; },
        };
      },
      addArc(srcId, tgtId, expr) {
        const arc = { id: 'arc' + (++S.ac), src: srcId, tgt: tgtId, expr: expr || 'x' };
        return {
          do()   { S.arcs.push(arc); },
          undo() { S.arcs = S.arcs.filter(a => a.id !== arc.id); },
        };
      },
      deleteNode(type, id) {
        const node = findNode(id);
        const removedArcs = S.arcs.filter(a => a.src === id || a.tgt === id);
        return {
          do() {
            if (type === 'place') S.places = S.places.filter(p => p.id !== id);
            else S.transitions = S.transitions.filter(t => t.id !== id);
            S.arcs = S.arcs.filter(a => a.src !== id && a.tgt !== id);
            if (S.selected?.id === id) S.selected = null;
          },
          undo() {
            if (type === 'place') S.places.push(node);
            else S.transitions.push(node);
            removedArcs.forEach(a => S.arcs.push(a));
          },
        };
      },
      moveNode(id, fromX, fromY, toX, toY) {
        const node = findNode(id);
        if (!node) return { do() {}, undo() {} };
        return {
          do()   { node.x = toX; node.y = toY; },
          undo() { node.x = fromX; node.y = fromY; },
        };
      },
      editProp(id, field, oldVal, newVal) {
        const node = findNode(id);
        if (!node) return { do() {}, undo() {} };
        return {
          do()   { node[field] = newVal; if (field === 'initTokens') node.tokens = [...newVal]; },
          undo() { node[field] = oldVal; if (field === 'initTokens') node.tokens = [...oldVal]; },
        };
      },
    };

    // ── Parser ───────────────────────────────────────────────────
    function parseCPN(src) {
      const cs = {}, places = [], transitions = [], arcs = [], errors = [];
      src.split('\n').forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith('//') || line.startsWith('#')) return;
        let m;
        if ((m = line.match(/^colorset\s+(\w+)\s*=\s*\{([^}]*)\}/))) {
          cs[m[1]] = m[2].split(',').map(s => s.trim()).filter(Boolean); return;
        }
        if ((m = line.match(/^place\s+(\w+)\s*:\s*([\w*×]+)\s*=\s*\{([^}]*)\}/))) {
          const toks = (function (str) {
            const out = []; let cur = '', depth = 0;
            for (const ch of str) {
              if (ch === '(') depth++; else if (ch === ')') depth--;
              if (ch === ',' && depth === 0) { const t = cur.trim(); if (t) out.push(t); cur = ''; } else cur += ch;
            }
            const t = cur.trim(); if (t) out.push(t); return out;
          })(m[3]);
          places.push({ id: m[1], label: m[1], colorSet: m[2], initTokens: [...toks], tokens: [...toks] }); return;
        }
        if ((m = line.match(/^transition\s+(\w+)(?:\s*\[guard:\s*([^\]]*)\])?/))) {
          transitions.push({ id: m[1], label: m[1], guard: m[2] ? m[2].trim() : 'true' }); return;
        }
        if ((m = line.match(/^arc\s+(\w+)\s*-->\s*(\w+)\s*:\s*(.+)/))) {
          arcs.push({ src: m[1], tgt: m[2], expr: m[3].trim() }); return;
        }
        errors.push(`Line ${i + 1}: "${line.slice(0, 40)}"`);
      });
      return { cs, places, transitions, arcs, errors };
    }

    // ── Serializers ──────────────────────────────────────────────
    function serializeCPN() {
      const lines = ['// CPN Tool — Professional Edition'];
      if (Object.keys(S.colorsets).length) {
        lines.push('');
        for (const [n, v] of Object.entries(S.colorsets))
          lines.push(`colorset ${n} = {${v.join(', ')}}`);
      }
      if (S.places.length) {
        lines.push('');
        S.places.forEach(p => lines.push(`place ${p.label} : ${p.colorSet || 'TOKEN'} = {${p.initTokens.join(', ')}}`));
      }
      if (S.transitions.length) {
        lines.push('');
        S.transitions.forEach(t => {
          const g = (t.guard && t.guard !== 'true') ? ` [guard: ${t.guard}]` : '';
          lines.push(`transition ${t.label}${g}`);
        });
      }
      if (S.arcs.length) {
        lines.push('');
        S.arcs.forEach(a => {
          const sn = findNode(a.src), tn = findNode(a.tgt);
          if (sn && tn) lines.push(`arc ${sn.label} --> ${tn.label} : ${a.expr}`);
        });
      }
      return lines.join('\n');
    }

    function serializePNML() {
      const e = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      let x = `<?xml version="1.0" encoding="UTF-8"?>\n<pnml xmlns="http://www.pnml.org/version-2009/grammar/pnml">\n<net id="net0" type="http://www.pnml.org/version-2009/grammar/ptnet">\n<name><text>CPN Model</text></name>\n<page id="page0">\n`;
      S.places.forEach(p => {
        x += `<place id="${e(p.id)}"><name><text>${e(p.label)}</text></name>`;
        x += `<graphics><position x="${Math.round(p.x || 0)}" y="${Math.round(p.y || 0)}"/></graphics>`;
        if (p.initTokens.length) x += `<initialMarking><text>${e(p.initTokens.join(','))}</text></initialMarking>`;
        x += `<toolspecific tool="cpntool" version="1.0"><colorset>${e(p.colorSet || 'TOKEN')}</colorset></toolspecific>`;
        x += `</place>\n`;
      });
      S.transitions.forEach(t => {
        x += `<transition id="${e(t.id)}"><name><text>${e(t.label)}</text></name>`;
        x += `<graphics><position x="${Math.round(t.x || 0)}" y="${Math.round(t.y || 0)}"/></graphics>`;
        if (t.guard && t.guard !== 'true') x += `<condition><text>${e(t.guard)}</text></condition>`;
        x += `</transition>\n`;
      });
      S.arcs.forEach((a, i) => {
        x += `<arc id="arc${i}" source="${e(a.src)}" target="${e(a.tgt)}">`;
        x += `<inscription><text>${e(a.expr)}</text></inscription></arc>\n`;
      });
      x += `</page></net></pnml>`;
      return x;
    }

    // ── State Space ──────────────────────────────────────────────
    class StateSpace {
      constructor() {
        this.nodes = new Map();
        this.nodeList = [];
        this.edges = [];
        this.truncated = false;
      }
      markingKey(m) {
        return JSON.stringify(Object.fromEntries(
          Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()])
        ));
      }
      cloneM(m) { const r = {}; for (const [k, v] of Object.entries(m)) r[k] = [...v]; return r; }

      _tryBind(inArcs, idx, binding, marking) {
        if (idx === inArcs.length) return binding;
        const arc = inArcs[idx];
        const tokens = marking[arc.src] || [];
        const expr = arc.expr.trim();
        if (/^\w+$/.test(expr)) {
          for (const tok of tokens) {
            const nb = { ...binding, [expr]: tok };
            const res = this._tryBind(inArcs, idx + 1, nb, marking);
            if (res !== null) return res;
          }
          return null;
        }
        const tm = expr.match(/^\((\w+),(\w+)\)$/);
        if (tm) {
          for (const tok of tokens) {
            const parts = tok.replace(/[()]/g, '').split(',').map(s => s.trim());
            if (parts.length === 2) {
              const nb = { ...binding, [tm[1]]: parts[0], [tm[2]]: parts[1] };
              const res = this._tryBind(inArcs, idx + 1, nb, marking);
              if (res !== null) return res;
            }
          }
          return null;
        }
        if (tokens.includes(expr)) return this._tryBind(inArcs, idx + 1, binding, marking);
        return null;
      }
      _resolve(expr, binding) {
        const t = expr.trim();
        if (binding[t] !== undefined) return binding[t];
        const tm = t.match(/^\((\w+),(\w+)\)$/);
        if (tm) return `(${binding[tm[1]] || tm[1]},${binding[tm[2]] || tm[2]})`;
        return t;
      }
      getEnabled(marking) {
        const res = [];
        for (const t of S.transitions) {
          const inArcs = S.arcs.filter(a => a.tgt === t.id);
          if (!inArcs.length) continue;
          const b = this._tryBind(inArcs, 0, {}, marking);
          if (b !== null) res.push({ t, binding: b });
        }
        return res;
      }
      fire(marking, item) {
        const m = this.cloneM(marking);
        S.arcs.filter(a => a.tgt === item.t.id).forEach(arc => {
          const tok = this._resolve(arc.expr, item.binding);
          const i = m[arc.src].indexOf(tok);
          if (i !== -1) m[arc.src].splice(i, 1);
        });
        S.arcs.filter(a => a.src === item.t.id).forEach(arc => {
          const tok = this._resolve(arc.expr, item.binding);
          if (m[arc.tgt] !== undefined) m[arc.tgt].push(tok);
        });
        return m;
      }
      explore(initMarking, maxStates = 1000) {
        const t0 = Date.now();
        const init = this.cloneM(initMarking);
        const initKey = this.markingKey(init);
        const initNode = { id: 0, key: initKey, marking: init, isDeadlock: false };
        this.nodes.set(initKey, initNode);
        this.nodeList.push(initNode);
        const queue = [initNode]; let nid = 1;
        while (queue.length) {
          if (this.nodeList.length >= maxStates) { this.truncated = true; break; }
          const node = queue.shift();
          const enabled = this.getEnabled(node.marking);
          if (!enabled.length) { node.isDeadlock = true; continue; }
          for (const item of enabled) {
            const nm = this.fire(node.marking, item);
            const key = this.markingKey(nm);
            let tgt = this.nodes.get(key);
            if (!tgt) { tgt = { id: nid++, key, marking: nm, isDeadlock: false }; this.nodes.set(key, tgt); this.nodeList.push(tgt); queue.push(tgt); }
            const bstr = Object.entries(item.binding).map(([k, v]) => `${k}=${v}`).join(',');
            this.edges.push({ from: node.id, to: tgt.id, transId: item.t.id, transLabel: item.t.label, binding: bstr });
          }
        }
        return { nodeCount: this.nodeList.length, edgeCount: this.edges.length, deadlocks: this.nodeList.filter(n => n.isDeadlock), truncated: this.truncated, timeMs: Date.now() - t0 };
      }
      boundedness() {
        const max = {}; S.places.forEach(p => { max[p.id] = 0; });
        for (const node of this.nodeList)
          for (const [pid, toks] of Object.entries(node.marking))
            if (toks.length > (max[pid] || 0)) max[pid] = toks.length;
        return max;
      }
      liveness() {
        const fires = new Set(this.edges.map(e => e.transId));
        const r = {}; S.transitions.forEach(t => { r[t.id] = fires.has(t.id); });
        return r;
      }
      isReachable(targetM) {
        const key = this.markingKey(targetM);
        if (!this.nodes.has(key)) return { reachable: false, path: null };
        const initKey = this.nodeList[0]?.key;
        if (!initKey || initKey === key) return { reachable: true, path: [] };
        const visited = new Map([[initKey, null]]);
        const q = [initKey];
        while (q.length) {
          const cur = q.shift();
          if (cur === key) {
            const path = []; let k = cur;
            while (visited.get(k) !== null) { const e = visited.get(k); path.unshift(e); k = this.nodeList[e.from].key; }
            return { reachable: true, path };
          }
          const cNode = this.nodes.get(cur);
          this.edges.filter(e => e.from === cNode.id).forEach(e => {
            const nk = this.nodeList[e.to]?.key;
            if (nk && !visited.has(nk)) { visited.set(nk, e); q.push(nk); }
          });
        }
        return { reachable: false, path: null };
      }
      sccCount() {
        const n = this.nodeList.length;
        const adj = Array.from({ length: n }, () => []);
        this.edges.forEach(e => adj[e.from].push(e.to));
        let idx = 0, count = 0;
        const indices = new Array(n).fill(-1), low = new Array(n).fill(0), onStk = new Array(n).fill(false), stk = [];
        const sc = (v) => {
          indices[v] = low[v] = idx++; stk.push(v); onStk[v] = true;
          for (const w of (adj[v] || [])) {
            if (indices[w] === -1) { sc(w); low[v] = Math.min(low[v], low[w]); }
            else if (onStk[w]) low[v] = Math.min(low[v], indices[w]);
          }
          if (low[v] === indices[v]) { let w; do { w = stk.pop(); onStk[w] = false; } while (w !== v); count++; }
        };
        for (let v = 0; v < n; v++) if (indices[v] === -1) sc(v);
        return count;
      }
    }

    // ── Simulation ───────────────────────────────────────────────
    function getEnabled() {
      const ss = new StateSpace();
      const m = {}; S.places.forEach(p => { m[p.id] = [...p.tokens]; });
      return ss.getEnabled(m);
    }

    function resolveExpr(expr, binding) {
      const t = expr.trim();
      if (binding[t] !== undefined) return binding[t];
      const tm = t.match(/^\((\w+),(\w+)\)$/);
      if (tm) return `(${binding[tm[1]] || tm[1]},${binding[tm[2]] || tm[2]})`;
      return t;
    }

    function fireItem(item) {
      const { t, binding } = item;
      S.arcs.filter(a => a.tgt === t.id).forEach(arc => {
        const place = S.places.find(p => p.id === arc.src);
        const tok = resolveExpr(arc.expr, binding);
        const i = place.tokens.indexOf(tok);
        if (i !== -1) place.tokens.splice(i, 1);
      });
      S.arcs.filter(a => a.src === t.id).forEach(arc => {
        const place = S.places.find(p => p.id === arc.tgt);
        if (place) place.tokens.push(resolveExpr(arc.expr, binding));
      });
      S.simStep++;
      const bs = Object.entries(binding).map(([k, v]) => `${k}↦${v}`).join(' ');
      log(`Fired: ${t.label}${bs ? ' [' + bs + ']' : ''}`, 'fire');
      render();
    }

    // ── Geometry (browser-meaningful but pure math) ───────────────
    function findNode(id) { return S.places.find(p => p.id === id) || S.transitions.find(t => t.id === id); }
    function nodeKind(id) { return S.places.find(p => p.id === id) ? 'place' : S.transitions.find(t => t.id === id) ? 'transition' : null; }
    function snapGrid(v) { return S.snap ? Math.round(v / GRID) * GRID : v; }

    function getEdgePt(id, tx, ty) {
      const n = findNode(id); if (!n) return { x: 0, y: 0 };
      const dx = tx - n.x, dy = ty - n.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / len, uy = dy / len;
      if (nodeKind(id) === 'place') return { x: n.x + ux * PLACE_R, y: n.y + uy * PLACE_R };
      const hw = TW / 2, hh = TH / 2;
      const s = Math.min(hw / Math.abs(ux || 0.001), hh / Math.abs(uy || 0.001));
      return { x: n.x + ux * s, y: n.y + uy * s };
    }

    // ── Syntax highlighter ───────────────────────────────────────
    function hlLine(line) {
      if (!line.trim()) return '<br>';
      const e = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (line.trim().startsWith('//') || line.trim().startsWith('#')) return `<span class="hl-cm">${e(line)}</span>`;
      let m;
      m = line.match(/^(\s*)(colorset)(\s+)(\w+)(\s*=\s*)(\{)([^}]*)(\})(.*)/);
      if (m) { const toks = m[7].split(',').map(t => `<span class="hl-tk">${e(t.trim())}</span>`).join('<span class="hl-pt">, </span>'); return `${e(m[1])}<span class="hl-kw">${m[2]}</span>${e(m[3])}<span class="hl-nm">${m[4]}</span><span class="hl-pt">${e(m[5])}{</span>${toks}<span class="hl-pt">}</span>${e(m[9])}`; }
      m = line.match(/^(\s*)(place)(\s+)(\w+)(\s*:\s*)([\w*×]+)(\s*=\s*)(\{)([^}]*)(\})(.*)/);
      if (m) { const toks = m[9].split(',').map(t => `<span class="hl-tk">${e(t.trim())}</span>`).join('<span class="hl-pt">, </span>'); return `${e(m[1])}<span class="hl-kw">${m[2]}</span>${e(m[3])}<span class="hl-nm">${m[4]}</span><span class="hl-pt">:</span><span class="hl-cs">${m[6]}</span><span class="hl-pt">${e(m[7])}{</span>${toks}<span class="hl-pt">}</span>${e(m[11])}`; }
      m = line.match(/^(\s*)(transition)(\s+)(\w+)(\s*)(\[guard:\s*)?([^\]]*)?(\])?/);
      if (m) { let o = `${e(m[1])}<span class="hl-kw">${m[2]}</span>${e(m[3])}<span class="hl-nm">${m[4]}</span>`; if (m[6]) o += `<span class="hl-pt">${e(m[5] + m[6])}</span><span class="hl-gd">${e(m[7] || '')}</span><span class="hl-pt">${m[8] || '}'}</span>`; return o; }
      m = line.match(/^(\s*)(arc)(\s+)(\w+)(\s*-->\s*)(\w+)(\s*:\s*)(.*)/);
      if (m) return `${e(m[1])}<span class="hl-kw">${m[2]}</span>${e(m[3])}<span class="hl-nm">${m[4]}</span><span class="hl-pt">${e(m[5])}</span><span class="hl-nm">${m[6]}</span><span class="hl-pt">${e(m[7])}</span><span class="hl-ex">${e(m[8])}</span>`;
      return e(line);
    }

    return {
      S,
      PLACE_R, TW, TH, GRID, SVG_NS,
      parseCPN, serializeCPN, serializePNML,
      StateSpace, getEnabled, fireItem, resolveExpr,
      execCmd, undo, redo, Cmd,
      findNode, nodeKind, snapGrid, getEdgePt,
      hlLine, log,
    };
  }

  return { createEngine, EXAMPLES };
}));
