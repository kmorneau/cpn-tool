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

    counter: `// Counter with INT colorset
colset INT = int with 0..5;
var n : INT;

place Counter : INT = {0}

transition Increment [guard: n < 5]
transition Reset     [guard: n = 5]

arc Counter     --> Increment : n
arc Increment   --> Counter   : n+1
arc Counter     --> Reset     : n
arc Reset       --> Counter   : 0`,
  };

  // ── Colorset descriptor helpers ──────────────────────────────────

  /**
   * Parse a colorset body string (everything after '=' with trailing ';' stripped).
   * Returns a typed descriptor object.
   */
  function parseColorset(rest) {
    rest = rest.trim();

    // Handle timed suffix
    let timed = false;
    const timedMatch = rest.match(/^(.*)\s+timed\s*$/);
    if (timedMatch) {
      rest = timedMatch[1].trim();
      timed = true;
    }

    let desc = null;

    // 1. Brace-enclosed enum: {a, b, c}
    const braceMatch = rest.match(/^\{([^}]*)\}/);
    if (braceMatch) {
      desc = {
        kind: 'enum',
        values: braceMatch[1].split(',').map(s => s.trim()).filter(Boolean),
      };
      if (timed) desc.timed = true;
      return desc;
    }

    // 2. 'with' enum using pipes: with a | b | c
    if (rest.startsWith('with ') && rest.includes('|')) {
      const body = rest.slice(5).trim();
      desc = {
        kind: 'enum',
        values: body.split('|').map(s => s.trim()).filter(Boolean),
      };
      if (timed) desc.timed = true;
      return desc;
    }

    // 3. unit
    if (rest === 'unit' || rest.startsWith('unit with ')) {
      const wm = rest.match(/^unit\s+with\s+(.+)$/);
      desc = { kind: 'unit', unitVal: wm ? wm[1].trim() : '()' };
      if (timed) desc.timed = true;
      return desc;
    }

    // 4. bool
    if (rest === 'bool' || rest.startsWith('bool with ')) {
      const wm = rest.match(/^bool\s+with\s+(\w+)\s+(\w+)$/);
      desc = {
        kind: 'bool',
        falseVal: wm ? wm[1] : 'false',
        trueVal: wm ? wm[2] : 'true',
      };
      if (timed) desc.timed = true;
      return desc;
    }

    // 5. int/intinf with range
    const intRangeMatch = rest.match(/^(?:int(?:inf)?)\s+with\s+(-?\d+)\.\.(-?\d+)/);
    if (intRangeMatch) {
      desc = {
        kind: 'int',
        low: parseInt(intRangeMatch[1], 10),
        high: parseInt(intRangeMatch[2], 10),
      };
      if (timed) desc.timed = true;
      return desc;
    }

    // 6. int or intinf (no range)
    if (rest === 'int') {
      desc = { kind: 'int', low: null, high: null };
      if (timed) desc.timed = true;
      return desc;
    }
    if (rest === 'intinf') {
      desc = { kind: 'intinf' };
      if (timed) desc.timed = true;
      return desc;
    }

    // 7. index
    const indexMatch = rest.match(/^index\s+(\w+)\s+with\s+(-?\d+)\.\.(-?\d+)/);
    if (indexMatch) {
      desc = {
        kind: 'index',
        indexName: indexMatch[1],
        low: parseInt(indexMatch[2], 10),
        high: parseInt(indexMatch[3], 10),
      };
      if (timed) desc.timed = true;
      return desc;
    }

    // 8. string
    if (rest === 'string') {
      desc = { kind: 'string' };
      if (timed) desc.timed = true;
      return desc;
    }

    // 9. real
    if (rest === 'real') {
      desc = { kind: 'real' };
      if (timed) desc.timed = true;
      return desc;
    }

    // 10. product
    if (rest.startsWith('product ')) {
      const body = rest.slice(8).trim();
      const parts = body.split('*').map(s => s.trim()).filter(Boolean);
      desc = { kind: 'product', parts };
      if (timed) desc.timed = true;
      return desc;
    }

    // 11. record
    if (rest.startsWith('record ')) {
      const body = rest.slice(7).trim();
      const fieldParts = body.split('*').map(s => s.trim()).filter(Boolean);
      const fields = fieldParts.map(fp => {
        const cm = fp.match(/^(\w+)\s*:\s*(\w+)$/);
        return cm ? { name: cm[1], cs: cm[2] } : { name: fp, cs: fp };
      });
      desc = { kind: 'record', fields };
      if (timed) desc.timed = true;
      return desc;
    }

    // 12. list
    if (rest.startsWith('list ')) {
      const body = rest.slice(5).trim();
      const rangeMatch = body.match(/^(\w+)\s+with\s+(-?\d+)\.\.(-?\d+)$/);
      if (rangeMatch) {
        desc = {
          kind: 'list',
          base: rangeMatch[1],
          minLen: parseInt(rangeMatch[2], 10),
          maxLen: parseInt(rangeMatch[3], 10),
        };
      } else {
        desc = { kind: 'list', base: body.trim(), minLen: null, maxLen: null };
      }
      if (timed) desc.timed = true;
      return desc;
    }

    // 13. union
    if (rest.startsWith('union ')) {
      const body = rest.slice(6).trim();
      // Split on '+' or '|' at top-level
      const variantStrs = body.split(/[+|]/).map(s => s.trim()).filter(Boolean);
      const variants = variantStrs.map(vs => {
        const cm = vs.match(/^(\w+)\s*:\s*(\w+)$/);
        return cm ? { tag: cm[1], cs: cm[2] } : { tag: vs, cs: null };
      });
      desc = { kind: 'union', variants };
      if (timed) desc.timed = true;
      return desc;
    }

    // 14. alias (single identifier)
    if (/^(\w+)$/.test(rest)) {
      desc = { kind: 'alias', base: rest };
      if (timed) desc.timed = true;
      return desc;
    }

    // 15. fallback best-effort
    desc = { kind: 'enum', values: [rest] };
    if (timed) desc.timed = true;
    return desc;
  }

  /**
   * Returns the enumerable values for a colorset descriptor (for simple kinds).
   */
  function csValues(d) {
    if (!d) return [];
    switch (d.kind) {
      case 'enum':  return d.values;
      case 'unit':  return [d.unitVal || '()'];
      case 'bool':  return [d.falseVal || 'false', d.trueVal || 'true'];
      case 'int': {
        if (d.low == null || d.high == null) return [];
        const v = [];
        for (let i = d.low; i <= d.high; i++) v.push(String(i));
        return v;
      }
      case 'index': {
        const v = [];
        for (let i = d.low; i <= d.high; i++) v.push(d.indexName + i);
        return v;
      }
      default: return [];
    }
  }

  /**
   * Serialize a colorset descriptor back to body text.
   */
  function serializeColorsetBody(d) {
    if (!d) return '{}';
    let body = '';
    switch (d.kind) {
      case 'enum':    body = `{${d.values.join(', ')}}`; break;
      case 'unit':    body = d.unitVal && d.unitVal !== '()' ? `unit with ${d.unitVal}` : 'unit'; break;
      case 'bool':
        if (d.falseVal === 'false' && d.trueVal === 'true') body = 'bool';
        else body = `bool with ${d.falseVal} ${d.trueVal}`;
        break;
      case 'int':
        if (d.low != null && d.high != null) body = `int with ${d.low}..${d.high}`;
        else body = 'int';
        break;
      case 'intinf':  body = 'intinf'; break;
      case 'index':   body = `index ${d.indexName} with ${d.low}..${d.high}`; break;
      case 'string':  body = 'string'; break;
      case 'real':    body = 'real'; break;
      case 'product': body = `product ${d.parts.join(' * ')}`; break;
      case 'record':  body = `record ${d.fields.map(f => `${f.name}:${f.cs}`).join(' * ')}`; break;
      case 'list':
        if (d.minLen != null && d.maxLen != null) body = `list ${d.base} with ${d.minLen}..${d.maxLen}`;
        else body = `list ${d.base}`;
        break;
      case 'union':   body = `union ${d.variants.map(v => v.cs ? `${v.tag}:${v.cs}` : v.tag).join(' + ')}`; break;
      case 'alias':   body = d.base; break;
      default:        body = '{}';
    }
    if (d.timed) body += ' timed';
    return body;
  }

  // ── Tokenizer ────────────────────────────────────────────────────

  /**
   * Tokenize a CPN expression string.
   * Returns array of {type, val} tokens.
   * Types: NUM, STR, ID, OP, LPAREN, RPAREN, COMMA, DOT
   */
  function tokenize(expr) {
    const tokens = [];
    let i = 0;
    const s = expr;
    const n = s.length;

    while (i < n) {
      // Skip whitespace
      if (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r') {
        i++; continue;
      }

      // String literal
      if (s[i] === '"' || s[i] === '\'') {
        const q = s[i++];
        let str = '';
        while (i < n && s[i] !== q) {
          if (s[i] === '\\') { i++; str += s[i] || ''; } else str += s[i];
          i++;
        }
        i++; // closing quote
        tokens.push({ type: 'STR', val: str });
        continue;
      }

      // Number
      if (s[i] === '-' && i + 1 < n && s[i + 1] >= '0' && s[i + 1] <= '9' &&
          (tokens.length === 0 || tokens[tokens.length - 1].type === 'OP' ||
           tokens[tokens.length - 1].type === 'LPAREN' ||
           tokens[tokens.length - 1].type === 'COMMA')) {
        let num = '-';
        i++;
        while (i < n && (s[i] >= '0' && s[i] <= '9')) num += s[i++];
        if (i < n && s[i] === '.') { num += s[i++]; while (i < n && s[i] >= '0' && s[i] <= '9') num += s[i++]; }
        tokens.push({ type: 'NUM', val: num });
        continue;
      }
      if (s[i] >= '0' && s[i] <= '9') {
        let num = '';
        while (i < n && (s[i] >= '0' && s[i] <= '9')) num += s[i++];
        if (i < n && s[i] === '.') { num += s[i++]; while (i < n && s[i] >= '0' && s[i] <= '9') num += s[i++]; }
        tokens.push({ type: 'NUM', val: num });
        continue;
      }

      // Identifier or keyword
      if ((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z') || s[i] === '_') {
        let id = '';
        while (i < n && ((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z') || (s[i] >= '0' && s[i] <= '9') || s[i] === '_')) id += s[i++];
        tokens.push({ type: 'ID', val: id });
        continue;
      }

      // Two-char operators
      if (i + 1 < n) {
        const two = s[i] + s[i + 1];
        if (two === '<=' || two === '>=' || two === '<>' || two === '->') {
          tokens.push({ type: 'OP', val: two });
          i += 2; continue;
        }
      }

      // Single-char
      if (s[i] === '(') { tokens.push({ type: 'LPAREN', val: '(' }); i++; continue; }
      if (s[i] === ')') { tokens.push({ type: 'RPAREN', val: ')' }); i++; continue; }
      if (s[i] === ',') { tokens.push({ type: 'COMMA',  val: ',' }); i++; continue; }
      if (s[i] === '.') { tokens.push({ type: 'DOT',    val: '.' }); i++; continue; }
      if ('=<>+-*/^|'.includes(s[i])) { tokens.push({ type: 'OP', val: s[i] }); i++; continue; }

      // Skip unknown chars
      i++;
    }

    return tokens;
  }

  // ── Expression evaluator ─────────────────────────────────────────

  function isNumeric(v) {
    return typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)));
  }

  function coerce(a, b) {
    // If both look numeric, return numbers; otherwise strings
    if (isNumeric(a) && isNumeric(b)) return [Number(a), Number(b)];
    return [String(a), String(b)];
  }

  /**
   * Recursive descent evaluator. Returns {val, pos}.
   * binding is an object mapping variable names to values.
   */
  function evalExpr(tokens, pos, binding) {
    return parseOrExpr(tokens, pos, binding);
  }

  function parseOrExpr(tokens, pos, binding) {
    let { val, pos: p } = parseAndExpr(tokens, pos, binding);
    while (p < tokens.length && tokens[p].type === 'ID' && tokens[p].val === 'orelse') {
      p++;
      const right = parseAndExpr(tokens, p, binding);
      val = Boolean(val) || Boolean(right.val);
      p = right.pos;
    }
    return { val, pos: p };
  }

  function parseAndExpr(tokens, pos, binding) {
    let { val, pos: p } = parseNotExpr(tokens, pos, binding);
    while (p < tokens.length && tokens[p].type === 'ID' && tokens[p].val === 'andalso') {
      p++;
      const right = parseNotExpr(tokens, p, binding);
      val = Boolean(val) && Boolean(right.val);
      p = right.pos;
    }
    return { val, pos: p };
  }

  function parseNotExpr(tokens, pos, binding) {
    if (pos < tokens.length && tokens[pos].type === 'ID' && tokens[pos].val === 'not') {
      const r = parseNotExpr(tokens, pos + 1, binding);
      return { val: !Boolean(r.val), pos: r.pos };
    }
    return parseCmpExpr(tokens, pos, binding);
  }

  function parseCmpExpr(tokens, pos, binding) {
    let { val: left, pos: p } = parseAddExpr(tokens, pos, binding);
    if (p < tokens.length && tokens[p].type === 'OP') {
      const op = tokens[p].val;
      if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
        p++;
        const { val: right, pos: p2 } = parseAddExpr(tokens, p, binding);
        const [a, b] = coerce(left, right);
        switch (op) {
          case '=':  left = a === b; break;
          case '<>': left = a !== b; break;
          case '<':  left = a < b;   break;
          case '>':  left = a > b;   break;
          case '<=': left = a <= b;  break;
          case '>=': left = a >= b;  break;
        }
        p = p2;
      }
    }
    return { val: left, pos: p };
  }

  function parseAddExpr(tokens, pos, binding) {
    let { val, pos: p } = parseMulExpr(tokens, pos, binding);
    while (p < tokens.length && tokens[p].type === 'OP' &&
           (tokens[p].val === '+' || tokens[p].val === '-' || tokens[p].val === '^')) {
      const op = tokens[p].val;
      p++;
      const right = parseMulExpr(tokens, p, binding);
      if (op === '+') {
        if (isNumeric(val) && isNumeric(right.val)) val = Number(val) + Number(right.val);
        else val = String(val) + String(right.val);
      } else if (op === '-') {
        val = Number(val) - Number(right.val);
      } else if (op === '^') {
        // String concatenation
        val = String(val) + String(right.val);
      }
      p = right.pos;
    }
    return { val, pos: p };
  }

  function parseMulExpr(tokens, pos, binding) {
    let { val, pos: p } = parseUnary(tokens, pos, binding);
    while (p < tokens.length) {
      const tok = tokens[p];
      if (tok.type === 'OP' && (tok.val === '*' || tok.val === '/')) {
        p++;
        const right = parseUnary(tokens, p, binding);
        if (tok.val === '*') val = Number(val) * Number(right.val);
        else val = Number(val) / Number(right.val);
        p = right.pos;
      } else if (tok.type === 'ID' && (tok.val === 'div' || tok.val === 'mod')) {
        const op = tok.val;
        p++;
        const right = parseUnary(tokens, p, binding);
        const a = Number(val), b = Number(right.val);
        if (op === 'div') val = Math.trunc(a / b);
        else val = ((a % b) + b) % b;
        p = right.pos;
      } else break;
    }
    return { val, pos: p };
  }

  function parseUnary(tokens, pos, binding) {
    if (pos < tokens.length && tokens[pos].type === 'OP' && tokens[pos].val === '-') {
      const r = parseUnary(tokens, pos + 1, binding);
      return { val: -Number(r.val), pos: r.pos };
    }
    return parseAtom(tokens, pos, binding);
  }

  function parseArgList(tokens, pos, binding) {
    const args = [];
    if (pos < tokens.length && tokens[pos].type === 'RPAREN') return { args, pos };
    const r0 = evalExpr(tokens, pos, binding);
    args.push(r0.val);
    pos = r0.pos;
    while (pos < tokens.length && tokens[pos].type === 'COMMA') {
      pos++;
      const r = evalExpr(tokens, pos, binding);
      args.push(r.val);
      pos = r.pos;
    }
    return { args, pos };
  }

  function parseAtom(tokens, pos, binding) {
    if (pos >= tokens.length) return { val: undefined, pos };

    const tok = tokens[pos];

    // NUM
    if (tok.type === 'NUM') {
      return { val: Number(tok.val), pos: pos + 1 };
    }

    // STR
    if (tok.type === 'STR') {
      return { val: tok.val, pos: pos + 1 };
    }

    // LPAREN — grouped expr or tuple
    if (tok.type === 'LPAREN') {
      pos++;
      if (pos < tokens.length && tokens[pos].type === 'RPAREN') {
        // unit value ()
        return { val: '()', pos: pos + 1 };
      }
      const r0 = evalExpr(tokens, pos, binding);
      pos = r0.pos;
      if (pos < tokens.length && tokens[pos].type === 'COMMA') {
        // Tuple
        const elems = [r0.val];
        while (pos < tokens.length && tokens[pos].type === 'COMMA') {
          pos++;
          const r = evalExpr(tokens, pos, binding);
          elems.push(r.val);
          pos = r.pos;
        }
        if (pos < tokens.length && tokens[pos].type === 'RPAREN') pos++;
        return { val: elems, pos };
      }
      if (pos < tokens.length && tokens[pos].type === 'RPAREN') pos++;
      return { val: r0.val, pos };
    }

    // ID
    if (tok.type === 'ID') {
      const id = tok.val;
      pos++;

      // Boolean literals
      if (id === 'true')  return { val: true, pos };
      if (id === 'false') return { val: false, pos };

      // Check for dotted call: ID.ID(args)
      if (pos < tokens.length && tokens[pos].type === 'DOT') {
        pos++; // consume dot
        if (pos < tokens.length && tokens[pos].type === 'ID') {
          const method = tokens[pos].val;
          pos++;
          if (pos < tokens.length && tokens[pos].type === 'LPAREN') {
            pos++; // consume LPAREN
            const { args, pos: p2 } = parseArgList(tokens, pos, binding);
            pos = p2;
            if (pos < tokens.length && tokens[pos].type === 'RPAREN') pos++;
            const fullName = id + '.' + method;
            const val = applyBuiltin(fullName, args, binding);
            return { val, pos };
          }
        }
      }

      // Function call: ID(args)
      if (pos < tokens.length && tokens[pos].type === 'LPAREN') {
        pos++;
        const { args, pos: p2 } = parseArgList(tokens, pos, binding);
        pos = p2;
        if (pos < tokens.length && tokens[pos].type === 'RPAREN') pos++;
        const val = applyBuiltin(id, args, binding);
        return { val, pos };
      }

      // Variable or enum constant
      if (binding !== undefined && binding[id] !== undefined) {
        const bv = binding[id];
        return { val: isNumeric(bv) ? Number(bv) : bv, pos };
      }
      // Return as string (enum constant)
      return { val: id, pos };
    }

    return { val: undefined, pos: pos + 1 };
  }

  function applyBuiltin(name, args, binding) {
    switch (name) {
      case 'abs':         return Math.abs(Number(args[0]));
      case 'floor':       return Math.floor(Number(args[0]));
      case 'ceil':        return Math.ceil(Number(args[0]));
      case 'Int.min':
      case 'Real.min':    return Math.min(Number(args[0]), Number(args[1]));
      case 'Int.max':
      case 'Real.max':    return Math.max(Number(args[0]), Number(args[1]));
      case 'String.size': return String(args[0]).length;
      case 'not':         return !Boolean(args[0]);
      default:            return args[0];
    }
  }

  // ── Guard evaluator ──────────────────────────────────────────────

  /**
   * Evaluate a guard expression.
   * Returns true if the guard passes (or if it can't be evaluated).
   */
  function evalGuard(guardStr, binding, cs, vars) {
    if (!guardStr || guardStr.trim() === 'true') return true;
    if (guardStr.trim() === 'false') return false;
    try {
      const toks = tokenize(guardStr);
      const { val } = evalExpr(toks, 0, binding);
      return Boolean(val);
    } catch (e) {
      return true;
    }
  }

  // ── Arc expression evaluator ─────────────────────────────────────

  /**
   * Evaluate an arc expression given a binding.
   * Returns a string token value.
   */
  function evalArcExpr(expr, binding) {
    const t = expr.trim();
    try {
      const toks = tokenize(t);
      if (toks.length === 0) return t;
      const { val } = evalExpr(toks, 0, binding);
      if (Array.isArray(val)) {
        return '(' + val.join(',') + ')';
      }
      return String(val);
    } catch (e) {
      return t;
    }
  }

  // ── Tuple pattern helpers ────────────────────────────────────────

  /**
   * Parse a tuple expression like "(x,y,z)" into ['x','y','z'].
   * Returns null if not a tuple.
   */
  function parseTuplePattern(expr) {
    const m = expr.match(/^\((.+)\)$/);
    if (!m) return null;
    const parts = [];
    let cur = '', depth = 0;
    for (const ch of m[1]) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    parts.push(cur.trim());
    return parts.length >= 2 ? parts : null;
  }

  /**
   * Parse a tuple token value (same structure as parseTuplePattern).
   */
  function parseTupleValue(tok) {
    return parseTuplePattern(tok);
  }

  // ── Factory ──────────────────────────────────────────────────────
  function createEngine({ render: renderCb = () => {}, log: logCb = null } = {}) {

    // Application state — one object per engine instance
    const S = {
      places: [], transitions: [], arcs: [], colorsets: {}, vars: {},
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
      const cs = {}, vars = {}, places = [], transitions = [], arcs = [], errors = [];
      src.split('\n').forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith('//') || line.startsWith('#')) return;
        let m;

        // colset or colorset declaration
        if ((m = line.match(/^(colset|colorset)\s+(\w+)\s*=\s*(.+?)(?:;)?\s*$/))) {
          const name = m[2];
          const body = m[3].trim();
          cs[name] = parseColorset(body);
          return;
        }

        // var declaration
        if ((m = line.match(/^var\s+([\w\s,]+)\s*:\s*(\w+)\s*;?\s*$/))) {
          const csName = m[2].trim();
          const varNames = m[1].split(',').map(s => s.trim()).filter(Boolean);
          varNames.forEach(vn => { vars[vn] = csName; });
          return;
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
      return { cs, vars, places, transitions, arcs, errors };
    }

    // ── Serializers ──────────────────────────────────────────────
    function serializeCPN() {
      const lines = ['// CPN Tool — Professional Edition'];
      if (Object.keys(S.colorsets).length) {
        lines.push('');
        for (const [n, d] of Object.entries(S.colorsets)) {
          const body = serializeColorsetBody(d);
          lines.push(`colset ${n} = ${body};`);
        }
      }
      // Emit var declarations grouped by colorset
      if (Object.keys(S.vars).length) {
        lines.push('');
        const byCS = {};
        for (const [vn, csName] of Object.entries(S.vars)) {
          if (!byCS[csName]) byCS[csName] = [];
          byCS[csName].push(vn);
        }
        for (const [csName, varNames] of Object.entries(byCS)) {
          lines.push(`var ${varNames.join(', ')} : ${csName};`);
        }
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

        // Numeric literal (must come before identifier check since digits match \w)
        if (/^-?\d+(\.\d+)?$/.test(expr)) {
          if (tokens.includes(expr) || tokens.includes(String(Number(expr)))) {
            return this._tryBind(inArcs, idx + 1, binding, marking);
          }
          // Also try numeric comparison
          for (const tok of tokens) {
            if (Number(tok) === Number(expr)) {
              return this._tryBind(inArcs, idx + 1, binding, marking);
            }
          }
          return null;
        }

        // Single identifier (not a number)
        if (/^[a-zA-Z_]\w*$/.test(expr)) {
          // If already bound, enforce consistency
          if (binding[expr] !== undefined) {
            if (tokens.includes(binding[expr])) {
              return this._tryBind(inArcs, idx + 1, binding, marking);
            }
            return null;
          }
          for (const tok of tokens) {
            const nb = { ...binding, [expr]: tok };
            const res = this._tryBind(inArcs, idx + 1, nb, marking);
            if (res !== null) return res;
          }
          return null;
        }

        // Boolean literals
        if (expr === 'true' || expr === 'false') {
          if (tokens.includes(expr)) return this._tryBind(inArcs, idx + 1, binding, marking);
          return null;
        }

        // Unit value
        if (expr === '()') {
          if (tokens.includes('()')) return this._tryBind(inArcs, idx + 1, binding, marking);
          return null;
        }

        // Tuple pattern
        const tupleVars = parseTuplePattern(expr);
        if (tupleVars) {
          for (const tok of tokens) {
            const tupVals = parseTupleValue(tok);
            if (!tupVals || tupVals.length !== tupleVars.length) continue;
            let nb = { ...binding };
            let ok = true;
            for (let k = 0; k < tupleVars.length; k++) {
              const tv = tupleVars[k];
              if (/^\w+$/.test(tv)) {
                // Variable
                if (nb[tv] !== undefined) {
                  if (nb[tv] !== tupVals[k]) { ok = false; break; }
                } else {
                  nb[tv] = tupVals[k];
                }
              } else {
                // Constant pattern
                if (tv !== tupVals[k]) { ok = false; break; }
              }
            }
            if (!ok) continue;
            const res = this._tryBind(inArcs, idx + 1, nb, marking);
            if (res !== null) return res;
          }
          return null;
        }

        // Fallback: exact string match
        if (tokens.includes(expr)) return this._tryBind(inArcs, idx + 1, binding, marking);
        return null;
      }

      _resolve(expr, binding) {
        return evalArcExpr(expr, binding);
      }

      /**
       * Enumerate ALL possible bindings for the given arc list.
       * Returns an array of binding objects.
       */
      _tryBindAll(inArcs, idx, binding, marking) {
        if (idx === inArcs.length) return [binding];
        const arc = inArcs[idx];
        const tokens = marking[arc.src] || [];
        const expr = arc.expr.trim();
        const results = [];

        // Numeric literal
        if (/^-?\d+(\.\d+)?$/.test(expr)) {
          const matched = tokens.some(tok => tok === expr || tok === String(Number(expr)) || Number(tok) === Number(expr));
          if (matched) results.push(...this._tryBindAll(inArcs, idx + 1, binding, marking));
          return results;
        }

        // Single identifier
        if (/^[a-zA-Z_]\w*$/.test(expr)) {
          if (binding[expr] !== undefined) {
            if (tokens.includes(binding[expr])) {
              results.push(...this._tryBindAll(inArcs, idx + 1, binding, marking));
            }
            return results;
          }
          for (const tok of tokens) {
            const nb = { ...binding, [expr]: tok };
            results.push(...this._tryBindAll(inArcs, idx + 1, nb, marking));
          }
          return results;
        }

        // Boolean literals
        if (expr === 'true' || expr === 'false') {
          if (tokens.includes(expr)) results.push(...this._tryBindAll(inArcs, idx + 1, binding, marking));
          return results;
        }

        // Unit value
        if (expr === '()') {
          if (tokens.includes('()')) results.push(...this._tryBindAll(inArcs, idx + 1, binding, marking));
          return results;
        }

        // Tuple pattern
        const tupleVars = parseTuplePattern(expr);
        if (tupleVars) {
          for (const tok of tokens) {
            const tupVals = parseTupleValue(tok);
            if (!tupVals || tupVals.length !== tupleVars.length) continue;
            let nb = { ...binding };
            let ok = true;
            for (let k = 0; k < tupleVars.length; k++) {
              const tv = tupleVars[k];
              if (/^[a-zA-Z_]\w*$/.test(tv)) {
                if (nb[tv] !== undefined) {
                  if (nb[tv] !== tupVals[k]) { ok = false; break; }
                } else {
                  nb[tv] = tupVals[k];
                }
              } else {
                if (tv !== tupVals[k]) { ok = false; break; }
              }
            }
            if (!ok) continue;
            results.push(...this._tryBindAll(inArcs, idx + 1, nb, marking));
          }
          return results;
        }

        // Fallback: exact string match
        if (tokens.includes(expr)) results.push(...this._tryBindAll(inArcs, idx + 1, binding, marking));
        return results;
      }

      getEnabled(marking) {
        const res = [];
        for (const t of S.transitions) {
          const inArcs = S.arcs.filter(a => a.tgt === t.id);
          if (!inArcs.length) continue;
          const bindings = this._tryBindAll(inArcs, 0, {}, marking);
          // Deduplicate bindings by JSON key
          const seen = new Set();
          for (const b of bindings) {
            const key = JSON.stringify(b, Object.keys(b).sort());
            if (seen.has(key)) continue;
            seen.add(key);
            if (evalGuard(t.guard, b, S.colorsets, S.vars)) {
              res.push({ t, binding: b });
            }
          }
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
      // colset or colorset with brace syntax
      m = line.match(/^(\s*)(colset|colorset)(\s+)(\w+)(\s*=\s*)(\{)([^}]*)(\})(.*)/);
      if (m) { const toks = m[7].split(',').map(t => `<span class="hl-tk">${e(t.trim())}</span>`).join('<span class="hl-pt">, </span>'); return `${e(m[1])}<span class="hl-kw">${m[2]}</span>${e(m[3])}<span class="hl-nm">${m[4]}</span><span class="hl-pt">${e(m[5])}{</span>${toks}<span class="hl-pt">}</span>${e(m[9])}`; }
      // colset or colorset with type expression
      m = line.match(/^(\s*)(colset|colorset)(\s+)(\w+)(\s*=\s*)(.*)/);
      if (m) { return `${e(m[1])}<span class="hl-kw">${m[2]}</span>${e(m[3])}<span class="hl-nm">${m[4]}</span><span class="hl-pt">${e(m[5])}</span><span class="hl-cs">${e(m[6])}</span>`; }
      // var declaration
      m = line.match(/^(\s*)(var)(\s+)([\w\s,]+)(\s*:\s*)(\w+)(.*)/);
      if (m) { return `${e(m[1])}<span class="hl-kw">${m[2]}</span>${e(m[3])}<span class="hl-nm">${m[4].trim()}</span><span class="hl-pt">${e(m[5])}</span><span class="hl-cs">${m[6]}</span>${e(m[7])}`; }
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
      evalGuard, evalArcExpr, csValues,
      execCmd, undo, redo, Cmd,
      findNode, nodeKind, snapGrid, getEdgePt,
      hlLine, log,
    };
  }

  return { createEngine, EXAMPLES };
}));
