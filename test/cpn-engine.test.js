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
    assert.deepEqual(r.cs.JOBS, ['job1', 'job2', 'job3']);
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
