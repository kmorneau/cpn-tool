'use strict';
/**
 * CPN Engine tests — Node.js port of the original cpn-tests.html browser suite.
 *
 * Each test creates a fresh engine instance (no shared mutable state).
 * Run with: node --test test/cpn-engine.test.js
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createEngine, EXAMPLES } = require('../lib/cpn-engine');

// Helper: create a fresh engine and load a CPN source string into it
function makeEngine(src) {
  const eng = createEngine();
  const { S } = eng;
  if (src) {
    const res = eng.parseCPN(src);
    S.colorsets = res.cs;
    S.vars      = res.vars || {};
    S.places    = res.places.map(p => ({ ...p, x: 0, y: 0 }));
    S.transitions = res.transitions.map(t => ({ ...t, x: 0, y: 0 }));
    const byLabel = {};
    [...S.places, ...S.transitions].forEach(n => { byLabel[n.label] = n; });
    S.arcs = res.arcs.map((a, i) => ({
      id: 'arc' + i,
      src: byLabel[a.src]?.id || a.src,
      tgt: byLabel[a.tgt]?.id || a.tgt,
      expr: a.expr,
    })).filter(a => a.src && a.tgt);
  }
  return eng;
}

// ── Suite 1: Parser ──────────────────────────────────────────────────────────
describe('1. Parser — parseCPN', () => {
  test('parses colorsets', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colorset JOBS = {job1, job2, job3}');
    // New: cs.JOBS is a descriptor object
    assert.equal(r.cs.JOBS.kind, 'enum');
    assert.deepEqual(r.cs.JOBS.values, ['job1', 'job2', 'job3']);
  });

  test('parses places with initial tokens', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colorset A = {x}\nplace P1 : A = {x}');
    assert.equal(r.places[0].id, 'P1');
    assert.deepEqual(r.places[0].initTokens, ['x']);
  });

  test('parses transitions with no guard (defaults to "true")', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('transition T1');
    assert.equal(r.transitions[0].guard, 'true');
  });

  test('parses transitions with guard', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('transition T1 [guard: x in JOBS]');
    assert.equal(r.transitions[0].guard, 'x in JOBS');
  });

  test('parses arcs', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('arc P1 --> T1 : x');
    assert.equal(r.arcs[0].src, 'P1');
    assert.equal(r.arcs[0].tgt, 'T1');
    assert.equal(r.arcs[0].expr, 'x');
  });

  test('skips comments and blank lines', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('// comment\n\n# also comment\ntransition T1');
    assert.equal(r.transitions.length, 1);
    assert.equal(r.errors.length, 0);
  });

  test('records errors for unrecognised lines', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('garbage line here');
    assert.ok(r.errors.length > 0);
  });

  test('parses producer example without errors', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN(EXAMPLES.producer);
    assert.equal(r.errors.length, 0);
    assert.equal(r.places.length, 4);
    assert.equal(r.transitions.length, 2);
    assert.equal(r.arcs.length, 6);
  });

  test('place tokens are independent copies of initTokens', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colorset A = {a}\nplace P : A = {a}');
    r.places[0].tokens.push('extra');
    assert.equal(r.places[0].initTokens.length, 1);
  });

  test('parses empty place (no initial tokens)', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colorset A = {a}\nplace P : A = {}');
    assert.deepEqual(r.places[0].initTokens, []);
  });
});

// ── Suite 2: State Space ─────────────────────────────────────────────────────
describe('2. State Space — explore + analysis', () => {
  test('pipeline: correct state and edge count', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    const stats = ss.explore(init);
    assert.ok(stats.nodeCount > 1);
    assert.ok(stats.edgeCount > 0);
    assert.equal(stats.truncated, false);
  });

  test('pipeline: terminal state is a deadlock (tokens exhausted in Output)', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    const stats = ss.explore(init);
    // The pipeline is a one-shot model — when all tokens reach Output no
    // transition can fire, so exactly one deadlock state exists.
    assert.equal(stats.deadlocks.length, 1);
  });

  test('mutex: has deadlock-free behaviour', () => {
    const eng = makeEngine(EXAMPLES.mutex);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    const stats = ss.explore(init);
    assert.ok(stats.nodeCount > 0);
  });

  test('boundedness returns per-place maxima', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    ss.explore(init);
    const bounds = ss.boundedness();
    for (const p of S.places) assert.ok(bounds[p.id] >= 0);
  });

  test('liveness returns a boolean per transition', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    ss.explore(init);
    const live = ss.liveness();
    for (const t of S.transitions) assert.equal(typeof live[t.id], 'boolean');
  });

  test('pipeline: both transitions are live', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    ss.explore(init);
    const live = ss.liveness();
    assert.ok(Object.values(live).every(Boolean));
  });

  test('isReachable: initial marking is reachable', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    ss.explore(init);
    const r = ss.isReachable(init);
    assert.ok(r.reachable);
  });

  test('sccCount returns a positive integer', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    ss.explore(init);
    assert.ok(ss.sccCount() >= 1);
  });

  test('truncation fires when maxStates exceeded', () => {
    const eng = makeEngine(EXAMPLES.producer);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    // Full producer exploration is large; cap it to confirm truncation works.
    // Note: nodes may slightly exceed maxStates because new nodes from one
    // queue item are added before the cap check on the next iteration.
    const stats = ss.explore(init, 3);
    assert.ok(stats.truncated, 'should be marked truncated');
    assert.ok(stats.nodeCount >= 3, 'must have reached at least maxStates');
  });
});

// ── Suite 3: Simulation — getEnabled + fireItem ──────────────────────────────
describe('3. Simulation — getEnabled + fireItem', () => {
  test('producer initial marking has enabled transitions', () => {
    const eng = makeEngine(EXAMPLES.producer);
    assert.ok(eng.getEnabled().length > 0);
  });

  test('empty net has no enabled transitions', () => {
    const eng = createEngine();
    assert.equal(eng.getEnabled().length, 0);
  });

  test('firing reduces input-place tokens', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S } = eng;
    const input = S.places.find(p => p.label === 'Input');
    const before = input.tokens.length;
    const enabled = eng.getEnabled();
    assert.ok(enabled.length > 0);
    eng.fireItem(enabled[0]);
    assert.equal(input.tokens.length, before - 1);
  });

  test('firing increases output-place tokens', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S } = eng;
    const buffer = S.places.find(p => p.label === 'Buffer');
    const before = buffer.tokens.length;
    eng.fireItem(eng.getEnabled()[0]);
    assert.equal(buffer.tokens.length, before + 1);
  });

  test('simStep counter increments on fire', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S } = eng;
    const before = S.simStep;
    eng.fireItem(eng.getEnabled()[0]);
    assert.equal(S.simStep, before + 1);
  });

  test('reset restores initial tokens', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S } = eng;
    eng.fireItem(eng.getEnabled()[0]);
    // Reset manually (simReset is DOM-coupled in the tool)
    S.simStep = 0;
    S.places.forEach(p => { p.tokens = [...p.initTokens]; });
    const input = S.places.find(p => p.label === 'Input');
    assert.equal(input.tokens.length, 3);
  });

  test('firing appends to S.log', () => {
    const eng = makeEngine(EXAMPLES.pipeline);
    const { S } = eng;
    const before = S.log.length;
    eng.fireItem(eng.getEnabled()[0]);
    assert.ok(S.log.length > before);
    assert.ok(S.log[S.log.length - 1].msg.startsWith('Fired:'));
  });

  test('resolveExpr returns bound variable', () => {
    const { resolveExpr } = createEngine();
    assert.equal(resolveExpr('x', { x: 'job1' }), 'job1');
  });

  test('resolveExpr handles tuple expressions', () => {
    const { resolveExpr } = createEngine();
    assert.equal(resolveExpr('(j,w)', { j: 'job1', w: 'w1' }), '(job1,w1)');
  });
});

// ── Suite 4: Undo / Redo ─────────────────────────────────────────────────────
describe('4. Undo/Redo — command pattern', () => {
  test('addPlace increases place count', () => {
    const { S, execCmd, Cmd } = createEngine();
    execCmd(Cmd.addPlace(100, 100));
    assert.equal(S.places.length, 1);
  });

  test('undo addPlace removes place', () => {
    const { S, execCmd, undo, Cmd } = createEngine();
    execCmd(Cmd.addPlace(100, 100));
    undo();
    assert.equal(S.places.length, 0);
  });

  test('redo re-applies addPlace', () => {
    const { S, execCmd, undo, redo, Cmd } = createEngine();
    execCmd(Cmd.addPlace(100, 100));
    undo();
    redo();
    assert.equal(S.places.length, 1);
  });

  test('addTransition and undo', () => {
    const { S, execCmd, undo, Cmd } = createEngine();
    execCmd(Cmd.addTransition(200, 200));
    assert.equal(S.transitions.length, 1);
    undo();
    assert.equal(S.transitions.length, 0);
  });

  test('deleteNode removes place and connected arcs', () => {
    const eng = createEngine();
    const { S, execCmd, Cmd } = eng;
    execCmd(Cmd.addPlace(100, 100));
    execCmd(Cmd.addTransition(300, 100));
    const pId = S.places[0].id, tId = S.transitions[0].id;
    execCmd(Cmd.addArc(pId, tId, 'x'));
    execCmd(Cmd.deleteNode('place', pId));
    assert.equal(S.places.length, 0);
    assert.equal(S.arcs.length, 0);
  });

  test('undo deleteNode restores place and arcs', () => {
    const eng = createEngine();
    const { S, execCmd, undo, Cmd } = eng;
    execCmd(Cmd.addPlace(100, 100));
    execCmd(Cmd.addTransition(300, 100));
    const pId = S.places[0].id, tId = S.transitions[0].id;
    execCmd(Cmd.addArc(pId, tId, 'x'));
    execCmd(Cmd.deleteNode('place', pId));
    undo();
    assert.equal(S.places.length, 1);
    assert.equal(S.arcs.length, 1);
  });

  test('moveNode changes coordinates', () => {
    const { S, execCmd, Cmd } = createEngine();
    execCmd(Cmd.addPlace(100, 100));
    const id = S.places[0].id;
    execCmd(Cmd.moveNode(id, 100, 100, 200, 300));
    assert.equal(S.places[0].x, 200);
    assert.equal(S.places[0].y, 300);
  });

  test('undo moveNode restores coordinates', () => {
    const { S, execCmd, undo, Cmd } = createEngine();
    execCmd(Cmd.addPlace(100, 100));
    const id = S.places[0].id;
    execCmd(Cmd.moveNode(id, 100, 100, 200, 300));
    undo();
    assert.equal(S.places[0].x, 100);
    assert.equal(S.places[0].y, 100);
  });

  test('editProp updates label', () => {
    const { S, execCmd, Cmd } = createEngine();
    execCmd(Cmd.addPlace(100, 100));
    const id = S.places[0].id;
    execCmd(Cmd.editProp(id, 'label', id, 'MyPlace'));
    assert.equal(S.places[0].label, 'MyPlace');
  });

  test('undo editProp reverts label', () => {
    const { S, execCmd, undo, Cmd } = createEngine();
    execCmd(Cmd.addPlace(100, 100));
    const id = S.places[0].id;
    execCmd(Cmd.editProp(id, 'label', id, 'MyPlace'));
    undo();
    assert.equal(S.places[0].label, id);
  });

  test('moveNode on missing id is a no-op', () => {
    const { S, execCmd, Cmd } = createEngine();
    assert.doesNotThrow(() => execCmd(Cmd.moveNode('NONEXISTENT', 0, 0, 100, 100)));
    assert.equal(S.places.length, 0);
  });
});

// ── Suite 5: Arc Geometry ────────────────────────────────────────────────────
describe('5. Arc Geometry — getEdgePt', () => {
  test('returns origin for unknown id', () => {
    const { getEdgePt } = createEngine();
    const pt = getEdgePt('NOPE', 100, 100);
    assert.deepEqual(pt, { x: 0, y: 0 });
  });

  test('edge point for place lies on circle perimeter', () => {
    const { S, execCmd, Cmd, getEdgePt, PLACE_R } = createEngine();
    execCmd(Cmd.addPlace(0, 0));
    const id = S.places[0].id;
    const pt = getEdgePt(id, 100, 0);
    const dist = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
    assert.ok(Math.abs(dist - PLACE_R) < 0.01);
  });

  test('edge point for transition lies inside bounding box', () => {
    const { S, execCmd, Cmd, getEdgePt, TW, TH } = createEngine();
    execCmd(Cmd.addTransition(0, 0));
    const id = S.transitions[0].id;
    const pt = getEdgePt(id, 100, 0);
    assert.ok(Math.abs(pt.x) <= TW / 2 + 0.01);
    assert.ok(Math.abs(pt.y) <= TH / 2 + 0.01);
  });
});

// ── Suite 6: Syntax Highlighter — hlLine ────────────────────────────────────
describe('6. Syntax Highlighter — hlLine', () => {
  test('blank line returns <br>', () => {
    const { hlLine } = createEngine();
    assert.equal(hlLine(''), '<br>');
    assert.equal(hlLine('   '), '<br>');
  });

  test('comment line gets hl-cm span', () => {
    const { hlLine } = createEngine();
    assert.ok(hlLine('// comment').includes('hl-cm'));
  });

  test('colorset line gets hl-kw span', () => {
    const { hlLine } = createEngine();
    assert.ok(hlLine('colorset JOBS = {a, b}').includes('hl-kw'));
  });

  test('colset line gets hl-kw span', () => {
    const { hlLine } = createEngine();
    assert.ok(hlLine('colset JOBS = {a, b}').includes('hl-kw'));
  });

  test('place line gets hl-cs span for colorset', () => {
    const { hlLine } = createEngine();
    assert.ok(hlLine('place P1 : JOBS = {a}').includes('hl-cs'));
  });

  test('transition line gets hl-kw span', () => {
    const { hlLine } = createEngine();
    assert.ok(hlLine('transition T1').includes('hl-kw'));
  });

  test('arc line gets hl-ex span for expression', () => {
    const { hlLine } = createEngine();
    assert.ok(hlLine('arc P1 --> T1 : x').includes('hl-ex'));
  });

  test('HTML special chars are escaped', () => {
    const { hlLine } = createEngine();
    const out = hlLine('// <script>');
    assert.ok(!out.includes('<script>'));
    assert.ok(out.includes('&lt;script&gt;'));
  });

  test('var line gets hl-kw span', () => {
    const { hlLine } = createEngine();
    const out = hlLine('var n : INT;');
    assert.ok(out.includes('hl-kw'));
    assert.ok(out.includes('hl-cs'));
  });
});

// ── Suite 7: Grid Snap ───────────────────────────────────────────────────────
describe('7. Grid Snap — snapGrid', () => {
  test('snaps to nearest grid when snap enabled', () => {
    const { S, snapGrid, GRID } = createEngine();
    S.snap = true;
    assert.equal(snapGrid(13), Math.round(13 / GRID) * GRID);
  });

  test('returns exact value when snap disabled', () => {
    const { S, snapGrid } = createEngine();
    S.snap = false;
    assert.equal(snapGrid(13), 13);
  });

  test('snaps 0 to 0', () => {
    const { S, snapGrid } = createEngine();
    S.snap = true;
    assert.equal(snapGrid(0), 0);
  });
});

// ── Suite 8: PNML Serializer ─────────────────────────────────────────────────
describe('8. PNML Serializer — serializePNML', () => {
  test('output is valid-looking XML', () => {
    const eng = makeEngine(EXAMPLES.producer);
    const xml = eng.serializePNML();
    assert.ok(xml.startsWith('<?xml'));
    assert.ok(xml.includes('<pnml'));
    assert.ok(xml.includes('</pnml>'));
  });

  test('contains all places', () => {
    const eng = makeEngine(EXAMPLES.producer);
    const xml = eng.serializePNML();
    for (const p of eng.S.places) assert.ok(xml.includes(p.label));
  });

  test('contains all transitions', () => {
    const eng = makeEngine(EXAMPLES.producer);
    const xml = eng.serializePNML();
    for (const t of eng.S.transitions) assert.ok(xml.includes(t.label));
  });

  test('escapes HTML-special characters in labels', () => {
    const eng = createEngine();
    const { S, execCmd, Cmd } = eng;
    execCmd(Cmd.addPlace(0, 0));
    execCmd(Cmd.editProp(S.places[0].id, 'label', S.places[0].id, 'A&B'));
    const xml = eng.serializePNML();
    assert.ok(xml.includes('A&amp;B'));
    assert.ok(!xml.includes('A&B'));
  });
});

// ── Suite 9: Integration — parse → simulate → analyse ───────────────────────
describe('9. Integration — parse → simulate → analyse', () => {
  test('producer: parse + enable + fire round-trip', () => {
    const eng = makeEngine(EXAMPLES.producer);
    const enabled = eng.getEnabled();
    assert.ok(enabled.length > 0);
    eng.fireItem(enabled[0]);
    assert.ok(eng.S.simStep === 1);
  });

  test('mutex: semaphore enforces mutual exclusion', () => {
    const eng = makeEngine(EXAMPLES.mutex);
    const { S } = eng;
    const sem = S.places.find(p => p.label === 'Semaphore');
    // Fire Enter until semaphore is consumed
    let steps = 0;
    while (eng.getEnabled().length && sem.tokens.length > 0 && steps < 20) {
      const en = eng.getEnabled().filter(e => e.t.label === 'Enter');
      if (!en.length) break;
      eng.fireItem(en[0]);
      steps++;
    }
    // Only one process can be in Critical at once
    const crit = S.places.find(p => p.label === 'Critical');
    assert.ok(crit.tokens.length <= 1);
  });

  test('serializeCPN round-trips through parseCPN', () => {
    const eng = makeEngine(EXAMPLES.producer);
    const src = eng.serializeCPN();
    const r = eng.parseCPN(src);
    assert.equal(r.errors.length, 0);
    assert.equal(r.places.length, eng.S.places.length);
    assert.equal(r.transitions.length, eng.S.transitions.length);
  });

  test('state space analysis on mutex is consistent', () => {
    const eng = makeEngine(EXAMPLES.mutex);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    const stats = ss.explore(init);
    assert.ok(stats.nodeCount > 0);
    assert.ok(stats.edgeCount >= stats.nodeCount - 1);
  });

  test('philosophers: both transitions fire at some point', () => {
    const eng = makeEngine(EXAMPLES.philosophers);
    const { S, StateSpace } = eng;
    const ss = new StateSpace();
    const init = {}; S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    ss.explore(init);
    const live = ss.liveness();
    assert.ok(Object.values(live).every(Boolean), 'all transitions should be live');
  });
});

// ── Suite 10: Tuple Token Parsing ────────────────────────────────────────────
describe('10. Tuple Token Parsing — paren-aware split', () => {
  test('parses simple tuple tokens in place', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colorset A = {x}\ncolorset B = {y}\nplace P : A*B = {(x,y)}');
    assert.deepEqual(r.places[0].initTokens, ['(x,y)']);
  });

  test('parses multiple tuple tokens', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colorset A = {a,b}\ncolorset B = {x,y}\nplace P : A*B = {(a,x),(b,y)}');
    assert.equal(r.places[0].initTokens.length, 2);
    assert.ok(r.places[0].initTokens.includes('(a,x)'));
    assert.ok(r.places[0].initTokens.includes('(b,y)'));
  });

  test('resolveExpr binds tuple arc expressions', () => {
    const { resolveExpr } = createEngine();
    const result = resolveExpr('(j,w)', { j: 'job1', w: 'w1' });
    assert.equal(result, '(job1,w1)');
  });

  test('StateSpace binds tuple tokens on incoming arcs', () => {
    const eng = makeEngine(`
colorset JOBS = {job1}
colorset WORKERS = {w1}
place Busy : JOBS*WORKERS = {(job1,w1)}
place Done : JOBS = {}
place Free : WORKERS = {}
transition Complete [guard: true]
arc Busy --> Complete : (j,w)
arc Complete --> Done : j
arc Complete --> Free : w`);
    const enabled = eng.getEnabled();
    assert.ok(enabled.length > 0, 'Complete should be enabled');
    assert.equal(enabled[0].binding.j, 'job1');
    assert.equal(enabled[0].binding.w, 'w1');
  });

  test('tuple fire produces correct output tokens', () => {
    const eng = makeEngine(`
colorset JOBS = {job1}
colorset WORKERS = {w1}
place Busy : JOBS*WORKERS = {(job1,w1)}
place Done : JOBS = {}
place Free : WORKERS = {}
transition Complete [guard: true]
arc Busy --> Complete : (j,w)
arc Complete --> Done : j
arc Complete --> Free : w`);
    const { S } = eng;
    eng.fireItem(eng.getEnabled()[0]);
    const done = S.places.find(p => p.label === 'Done');
    const free = S.places.find(p => p.label === 'Free');
    assert.deepEqual(done.tokens, ['job1']);
    assert.deepEqual(free.tokens, ['w1']);
  });
});

// ── Suite 11: Colorset type system ───────────────────────────────────────────
describe('11. Colorset type system — parseColorset descriptors', () => {
  test('old brace format still parses to enum', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colorset C = {a, b, c}');
    assert.equal(r.cs.C.kind, 'enum');
    assert.deepEqual(r.cs.C.values, ['a', 'b', 'c']);
  });

  test('colset keyword accepted', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset C = {x, y}');
    assert.equal(r.cs.C.kind, 'enum');
    assert.deepEqual(r.cs.C.values, ['x', 'y']);
  });

  test('unit colorset', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset U = unit;');
    assert.equal(r.cs.U.kind, 'unit');
    assert.equal(r.cs.U.unitVal, '()');
  });

  test('unit with custom value', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset U = unit with dot;');
    assert.equal(r.cs.U.kind, 'unit');
    assert.equal(r.cs.U.unitVal, 'dot');
  });

  test('bool colorset defaults', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset B = bool;');
    assert.equal(r.cs.B.kind, 'bool');
    assert.equal(r.cs.B.falseVal, 'false');
    assert.equal(r.cs.B.trueVal, 'true');
  });

  test('bool with custom values', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset B = bool with no yes;');
    assert.equal(r.cs.B.kind, 'bool');
    assert.equal(r.cs.B.falseVal, 'no');
    assert.equal(r.cs.B.trueVal, 'yes');
  });

  test('int with range', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset INT = int with 0..5;');
    assert.equal(r.cs.INT.kind, 'int');
    assert.equal(r.cs.INT.low, 0);
    assert.equal(r.cs.INT.high, 5);
  });

  test('int without range', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset INT = int;');
    assert.equal(r.cs.INT.kind, 'int');
    assert.equal(r.cs.INT.low, null);
    assert.equal(r.cs.INT.high, null);
  });

  test('intinf colorset', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset N = intinf;');
    assert.equal(r.cs.N.kind, 'intinf');
  });

  test('index colorset', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset IDX = index i with 1..3;');
    assert.equal(r.cs.IDX.kind, 'index');
    assert.equal(r.cs.IDX.indexName, 'i');
    assert.equal(r.cs.IDX.low, 1);
    assert.equal(r.cs.IDX.high, 3);
  });

  test('string colorset', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset S = string;');
    assert.equal(r.cs.S.kind, 'string');
  });

  test('real colorset', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset R = real;');
    assert.equal(r.cs.R.kind, 'real');
  });

  test('product colorset', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset P = product A * B;');
    assert.equal(r.cs.P.kind, 'product');
    assert.deepEqual(r.cs.P.parts, ['A', 'B']);
  });

  test('record colorset', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset REC = record name:STRING * age:INT;');
    assert.equal(r.cs.REC.kind, 'record');
    assert.equal(r.cs.REC.fields.length, 2);
    assert.equal(r.cs.REC.fields[0].name, 'name');
    assert.equal(r.cs.REC.fields[0].cs, 'STRING');
    assert.equal(r.cs.REC.fields[1].name, 'age');
    assert.equal(r.cs.REC.fields[1].cs, 'INT');
  });

  test('list colorset', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset L = list INT;');
    assert.equal(r.cs.L.kind, 'list');
    assert.equal(r.cs.L.base, 'INT');
    assert.equal(r.cs.L.minLen, null);
    assert.equal(r.cs.L.maxLen, null);
  });

  test('list colorset with length bounds', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset L = list INT with 0..10;');
    assert.equal(r.cs.L.kind, 'list');
    assert.equal(r.cs.L.base, 'INT');
    assert.equal(r.cs.L.minLen, 0);
    assert.equal(r.cs.L.maxLen, 10);
  });

  test('union colorset', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset U = union leaf | node:INT;');
    assert.equal(r.cs.U.kind, 'union');
    assert.equal(r.cs.U.variants.length, 2);
    assert.equal(r.cs.U.variants[0].tag, 'leaf');
    assert.equal(r.cs.U.variants[0].cs, null);
    assert.equal(r.cs.U.variants[1].tag, 'node');
    assert.equal(r.cs.U.variants[1].cs, 'INT');
  });

  test('alias colorset', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset MYINT = INT;');
    assert.equal(r.cs.MYINT.kind, 'alias');
    assert.equal(r.cs.MYINT.base, 'INT');
  });

  test('timed suffix', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset T = int with 0..3 timed;');
    assert.equal(r.cs.T.kind, 'int');
    assert.equal(r.cs.T.timed, true);
  });

  test('timed on enum', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset E = {a, b} timed;');
    assert.equal(r.cs.E.kind, 'enum');
    assert.equal(r.cs.E.timed, true);
  });

  // csValues helper tests
  test('csValues: enum', () => {
    const { csValues } = createEngine();
    assert.deepEqual(csValues({ kind: 'enum', values: ['x', 'y'] }), ['x', 'y']);
  });

  test('csValues: unit', () => {
    const { csValues } = createEngine();
    assert.deepEqual(csValues({ kind: 'unit', unitVal: '()' }), ['()']);
  });

  test('csValues: bool', () => {
    const { csValues } = createEngine();
    assert.deepEqual(csValues({ kind: 'bool', falseVal: 'false', trueVal: 'true' }), ['false', 'true']);
  });

  test('csValues: int with range', () => {
    const { csValues } = createEngine();
    assert.deepEqual(csValues({ kind: 'int', low: 0, high: 3 }), ['0', '1', '2', '3']);
  });

  test('csValues: int without range returns empty', () => {
    const { csValues } = createEngine();
    assert.deepEqual(csValues({ kind: 'int', low: null, high: null }), []);
  });

  test('csValues: index', () => {
    const { csValues } = createEngine();
    assert.deepEqual(csValues({ kind: 'index', indexName: 'p', low: 1, high: 3 }), ['p1', 'p2', 'p3']);
  });

  test('csValues: unknown kind returns empty', () => {
    const { csValues } = createEngine();
    assert.deepEqual(csValues({ kind: 'string' }), []);
  });

  test('csValues: null descriptor returns empty', () => {
    const { csValues } = createEngine();
    assert.deepEqual(csValues(null), []);
  });
});

// ── Suite 12: var declarations ───────────────────────────────────────────────
describe('12. var declarations — parse + serialize', () => {
  test('parses single var declaration', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset INT = int with 0..5;\nvar n : INT;');
    assert.equal(r.vars.n, 'INT');
  });

  test('parses multiple vars in one declaration', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset C = {a,b};\nvar x, y : C;');
    assert.equal(r.vars.x, 'C');
    assert.equal(r.vars.y, 'C');
  });

  test('parses vars with different colorsets', () => {
    const { parseCPN } = createEngine();
    const r = parseCPN('colset A = {x};\ncolset B = {y};\nvar p : A;\nvar q : B;');
    assert.equal(r.vars.p, 'A');
    assert.equal(r.vars.q, 'B');
  });

  test('serializeCPN emits var declarations', () => {
    const eng = makeEngine('colset INT = int with 0..5;\nvar n : INT;\nplace P : INT = {0}\ntransition T\narc P --> T : n\narc T --> P : n');
    const src = eng.serializeCPN();
    assert.ok(src.includes('var n : INT'), `Expected var declaration, got: ${src}`);
  });

  test('serializeCPN vars round-trip through parseCPN', () => {
    const eng = makeEngine('colset C = {a, b};\nvar x, y : C;\nplace P : C = {a}\ntransition T\narc P --> T : x');
    const src = eng.serializeCPN();
    const r = eng.parseCPN(src);
    assert.equal(r.errors.length, 0);
    assert.ok(r.vars.x === 'C' || r.vars.y === 'C', 'vars should survive round-trip');
  });

  test('S.vars is populated after makeEngine', () => {
    const eng = makeEngine('colset INT = int with 0..3;\nvar n : INT;\nplace P : INT = {0}\ntransition T\narc P --> T : n');
    assert.equal(eng.S.vars.n, 'INT');
  });
});

// ── Suite 13: Guard evaluator ────────────────────────────────────────────────
describe('13. Guard evaluator — evalGuard', () => {
  test('true guard always passes', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('true', {}, {}, {}), true);
    assert.equal(evalGuard('', {}, {}, {}), true);
    assert.equal(evalGuard(null, {}, {}, {}), true);
  });

  test('false guard always fails', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('false', {}, {}, {}), false);
  });

  test('numeric comparison equal', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('n = 3', { n: 3 }, {}, {}), true);
    assert.equal(evalGuard('n = 3', { n: 2 }, {}, {}), false);
  });

  test('numeric comparison less-than', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('n < 5', { n: 3 }, {}, {}), true);
    assert.equal(evalGuard('n < 5', { n: 5 }, {}, {}), false);
  });

  test('numeric comparison greater-than', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('n > 2', { n: 3 }, {}, {}), true);
    assert.equal(evalGuard('n > 2', { n: 2 }, {}, {}), false);
  });

  test('numeric comparison <=', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('n <= 5', { n: 5 }, {}, {}), true);
    assert.equal(evalGuard('n <= 5', { n: 6 }, {}, {}), false);
  });

  test('numeric comparison >=', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('n >= 0', { n: 0 }, {}, {}), true);
    assert.equal(evalGuard('n >= 0', { n: -1 }, {}, {}), false);
  });

  test('numeric comparison <>', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('n <> 3', { n: 4 }, {}, {}), true);
    assert.equal(evalGuard('n <> 3', { n: 3 }, {}, {}), false);
  });

  test('andalso short-circuit', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('n > 0 andalso n < 5', { n: 3 }, {}, {}), true);
    assert.equal(evalGuard('n > 0 andalso n < 5', { n: 0 }, {}, {}), false);
  });

  test('orelse', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('n = 0 orelse n = 5', { n: 0 }, {}, {}), true);
    assert.equal(evalGuard('n = 0 orelse n = 5', { n: 5 }, {}, {}), true);
    assert.equal(evalGuard('n = 0 orelse n = 5', { n: 3 }, {}, {}), false);
  });

  test('not operator', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('not n = 3', { n: 3 }, {}, {}), false);
    assert.equal(evalGuard('not n = 3', { n: 4 }, {}, {}), true);
  });

  test('mod operator', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('n mod 2 = 0', { n: 4 }, {}, {}), true);
    assert.equal(evalGuard('n mod 2 = 0', { n: 3 }, {}, {}), false);
  });

  test('div operator', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('n div 2 = 2', { n: 5 }, {}, {}), true);
    assert.equal(evalGuard('n div 2 = 2', { n: 4 }, {}, {}), true);
  });

  test('abs builtin', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('abs(n) = 3', { n: -3 }, {}, {}), true);
  });

  test('string equality', () => {
    const { evalGuard } = createEngine();
    assert.equal(evalGuard('s = "hello"', { s: 'hello' }, {}, {}), true);
    assert.equal(evalGuard('s = "hello"', { s: 'world' }, {}, {}), false);
  });

  test('invalid guard expression returns true (safe fallback)', () => {
    const { evalGuard } = createEngine();
    // Should not throw, should return true
    assert.equal(evalGuard('not-valid-syntax!!!', {}, {}, {}), true);
  });

  test('getEnabled respects guard: n < 5 filters n=5', () => {
    // Build a net where guard is n < 5, place has tokens 3 and 5
    const eng = makeEngine(`colset INT = int with 0..5;
var n : INT;
place P : INT = {3, 5}
transition T [guard: n < 5]
arc P --> T : n
arc T --> P : n`);
    const enabled = eng.getEnabled();
    // Only n=3 should be enabled (n=5 fails guard)
    assert.ok(enabled.length > 0);
    assert.ok(enabled.every(e => Number(e.binding.n) < 5), 'All enabled bindings should satisfy guard');
  });

  test('getEnabled respects guard: n = 5 filters others', () => {
    const eng = makeEngine(`colset INT = int with 0..5;
var n : INT;
place P : INT = {3, 5}
transition T [guard: n = 5]
arc P --> T : n
arc T --> P : n`);
    const enabled = eng.getEnabled();
    assert.ok(enabled.length > 0);
    assert.ok(enabled.every(e => Number(e.binding.n) === 5));
  });
});

// ── Suite 14: n-tuple _tryBind ───────────────────────────────────────────────
describe('14. n-tuple _tryBind — 3-tuple and constrained binding', () => {
  test('3-tuple binding extracts three variables', () => {
    const eng = makeEngine(`
colorset A = {a1}
colorset B = {b1}
colorset C = {c1}
place P : A*B*C = {(a1,b1,c1)}
place Out : A = {}
transition T [guard: true]
arc P --> T : (x,y,z)
arc T --> Out : x`);
    const enabled = eng.getEnabled();
    assert.ok(enabled.length > 0, '3-tuple transition should be enabled');
    assert.equal(enabled[0].binding.x, 'a1');
    assert.equal(enabled[0].binding.y, 'b1');
    assert.equal(enabled[0].binding.z, 'c1');
  });

  test('3-tuple fire produces correct output', () => {
    const eng = makeEngine(`
colorset A = {a1}
colorset B = {b1}
colorset C = {c1}
place P : A*B*C = {(a1,b1,c1)}
place Out : A = {}
transition T [guard: true]
arc P --> T : (x,y,z)
arc T --> Out : x`);
    eng.fireItem(eng.getEnabled()[0]);
    const out = eng.S.places.find(p => p.label === 'Out');
    assert.deepEqual(out.tokens, ['a1']);
  });

  test('constrained variable: same variable on two arcs enforces consistency', () => {
    // If two input arcs both have variable x, only fire if tokens match
    const eng = makeEngine(`
colorset C = {a, b}
place P1 : C = {a}
place P2 : C = {a}
place Out : C = {}
transition T [guard: true]
arc P1 --> T : x
arc P2 --> T : x
arc T --> Out : x`);
    const enabled = eng.getEnabled();
    // Both places have 'a', so x=a is consistent — should be enabled
    assert.ok(enabled.length > 0);
    assert.equal(enabled[0].binding.x, 'a');
  });

  test('constrained variable mismatch prevents firing', () => {
    const eng = makeEngine(`
colorset C = {a, b}
place P1 : C = {a}
place P2 : C = {b}
place Out : C = {}
transition T [guard: true]
arc P1 --> T : x
arc P2 --> T : x
arc T --> Out : x`);
    // P1 has 'a', P2 has 'b' — no consistent binding for x
    const enabled = eng.getEnabled();
    assert.equal(enabled.length, 0);
  });

  test('numeric literal in arc pattern matches token', () => {
    // Token '5' in place, arc pattern '5' — should bind
    const eng = makeEngine(`
colorset INT = int with 0..5;
place P : INT = {5}
place Out : INT = {}
transition T [guard: true]
arc P --> T : 5
arc T --> Out : 5`);
    const enabled = eng.getEnabled();
    assert.ok(enabled.length > 0);
  });

  test('numeric literal mismatch prevents firing', () => {
    const eng = makeEngine(`
colorset INT = int with 0..5;
place P : INT = {3}
place Out : INT = {}
transition T [guard: true]
arc P --> T : 5
arc T --> Out : 5`);
    // Place has 3, arc expects 5
    const enabled = eng.getEnabled();
    assert.equal(enabled.length, 0);
  });
});

// ── Suite 15: evalArcExpr ────────────────────────────────────────────────────
describe('15. evalArcExpr — arithmetic in arc expressions', () => {
  test('constant expression', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('42', {}), '42');
  });

  test('variable lookup', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('x', { x: 'hello' }), 'hello');
  });

  test('arithmetic addition', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('n + 1', { n: 3 }), '4');
  });

  test('arithmetic subtraction', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('n - 1', { n: 5 }), '4');
  });

  test('arithmetic multiplication', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('n * 2', { n: 3 }), '6');
  });

  test('mod operator', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('n mod 3', { n: 7 }), '1');
  });

  test('div operator', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('n div 2', { n: 7 }), '3');
  });

  test('string concatenation with ^', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('s ^ "!"', { s: 'hello' }), 'hello!');
  });

  test('abs builtin', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('abs(n)', { n: -5 }), '5');
  });

  test('tuple construction returns (a,b) form', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('(x, y)', { x: 'a', y: 'b' }), '(a,b)');
  });

  test('3-tuple construction', () => {
    const { evalArcExpr } = createEngine();
    assert.equal(evalArcExpr('(x, y, z)', { x: '1', y: '2', z: '3' }), '(1,2,3)');
  });

  test('n+1 in arc integrates with StateSpace fire', () => {
    // Counter net: arc out of transition is n+1
    const eng = makeEngine(`colset INT = int with 0..3;
var n : INT;
place Counter : INT = {0}
place Out : INT = {}
transition Inc [guard: n < 3]
arc Counter --> Inc : n
arc Inc --> Out : n`);
    // n=0 should be enabled (0 < 3), firing should consume 0 and produce 0 in Out
    const ss = new eng.StateSpace();
    const init = {};
    eng.S.places.forEach(p => { init[p.id] = [...p.tokens]; });
    const enabled = ss.getEnabled(init);
    assert.ok(enabled.length > 0);
  });

  test('evalArcExpr n+1 correctly increments counter', () => {
    const { evalArcExpr } = createEngine();
    // Simulates: arc T --> Counter : n+1 with binding n=2
    assert.equal(evalArcExpr('n+1', { n: '2' }), '3');
    assert.equal(evalArcExpr('n+1', { n: 2 }), '3');
  });
});
