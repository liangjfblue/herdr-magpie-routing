'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// These are pure-function parity tests. Never start the Herdr view or its timers.
const modPath = path.join(__dirname, '../mods/routing/main.js');
const magpieRoots = [process.env.MAGPIE_ROOT, process.cwd()].filter(Boolean);
const nativePath = magpieRoots.map((root) => path.join(root, 'internal/gui/assets/plugins/routing/client.js'))
  .find((file) => fs.existsSync(file));
assert.ok(nativePath, 'Set MAGPIE_ROOT to the Magpie checkout containing routing/client.js');
const nativeSource = fs.readFileSync(nativePath, 'utf8');
const modSource = fs.readFileSync(modPath, 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default class Routing', 'class Routing');

function nativeFunction(name) {
  const match = nativeSource.match(new RegExp(`^  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, 'm'));
  assert.ok(match, `Cannot extract native ${name}; review the oracle after upstream changes`);
  return match[0];
}
function nativeConstant(name) {
  const match = nativeSource.match(new RegExp(`^  const ${name} = [^\\n]+;`, 'm'));
  assert.ok(match, `Cannot extract native ${name}; review the oracle after upstream changes`);
  return match[0];
}
const terminalFailure = nativeSource.match(/if \((!tr\.rest && !tr\.credits && \(!tr\.again \|\| tr\.gone\))\) \{/);
assert.ok(terminalFailure, 'Cannot extract native full-stage failure branch');
const nativeScope = {
  pinned: null, day: '', rp: null, cur: null, routes: new Map(), playing: new Map(),
  LINGER: 12000, clock: 100000,
  src() { return nativeScope.routes; },
  now() { return nativeScope.clock; },
  at: Date.parse,
  matchesPurpose() { return true; },
};
vm.createContext(nativeScope);
vm.runInContext([
  nativeConstant('srcOf'), nativeConstant('newest'), nativeConstant('tryOk'),
  nativeFunction('staged'), nativeFunction('told'),
  `function retryTry(tr) { return !(${terminalFailure[1]}); }`,
  'this.API = { staged, told, tryOk, retryTry, srcOf };',
].join('\n'), nativeScope, { filename: nativePath });

const modScope = { View: class {}, console };
vm.createContext(modScope);
vm.runInContext(modSource + '\nthis.API = { Routing, stagedRoutes, toldRoute, routeCompare, tryOk, retryTry, routeStatus, onCurve, sourceKey, target };',
  modScope, { filename: modPath });
const api = modScope.API;
const NOW = 100000;
function route(id, extra = {}) {
  return { id, agent: 'omp', session: `session-${id}`, time: new Date(NOW - 1000).toISOString(),
    ms: 0, done: false, provider: 'provider', model: 'model', status: 0, order: [], tries: [], ...extra };
}
function compactRoute(r, origin = 'local') {
  return { ...r, id: `${origin}:${r.id}`, traceId: r.id, traceOrigin: origin };
}
function fixture(rs, playing = [], currentId = null, now = NOW) {
  nativeScope.routes = new Map(rs.map((r) => [r.id, r]));
  nativeScope.playing = new Map(playing.map((id) => [id, 0]));
  nativeScope.cur = currentId == null ? null : nativeScope.routes.get(currentId);
  nativeScope.clock = now;
  const routes = new Map(rs.map((r) => { const compact = compactRoute(r); return [compact.id, compact]; }));
  const flights = new Map(playing.map((id) => [`local:${id}`, {}]));
  return { routes, flights, current: currentId == null ? null : `local:${currentId}` };
}
function stageParity(rs, playing = [], currentId = null, now = NOW) {
  const f = fixture(rs, playing, currentId, now);
  const expected = Array.from(nativeScope.API.staged(), (r) => r.id);
  const actual = Array.from(api.stagedRoutes(f.routes, f.flights, f.current, now), (r) => r.traceId);
  assert.deepEqual(actual, expected);
  return actual;
}
function toldParity(rs, currentId) {
  const f = fixture(rs, [], currentId);
  const expected = nativeScope.API.told()?.id ?? null;
  const actual = api.toldRoute(f.routes, f.current)?.traceId ?? null;
  assert.equal(actual, expected);
  return actual;
}

test('staged: strict 12s end-time boundary comes from native staged()', () => {
  for (const delta of [-1, 0, 1]) {
    const r = route(1, { done: true, time: new Date(NOW - 13000 + delta).toISOString(), ms: 1000 });
    assert.deepEqual(stageParity([r]), delta > 0 ? [1] : []);
  }
  assert.deepEqual(stageParity([route(1, { time: new Date(0).toISOString() })]), [1]);
});

test('staged: cur is appended before source capping, not inserted in route order', () => {
  const expiredCurrent = route(1, { agent: 'current', done: true, time: new Date(0).toISOString() });
  const rs = [expiredCurrent, ...[2, 3, 4, 5].map((id) => route(id, { agent: `agent-${id}` }))];
  assert.deepEqual(stageParity(rs, [], 1), [1, 3, 4, 5]);
});

test('staged: all playing requests survive per-source latest selection, but only four sources survive', () => {
  const rs = Array.from({ length: 10 }, (_, i) => route(i + 1, { agent: `agent-${Math.floor(i / 2)}` }));
  assert.deepEqual(stageParity(rs, rs.map((r) => r.id)), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(stageParity([route(1), route(2), route(3)], [1, 2]), [1, 2, 3]);
});

test('staged: session/folder/subagent do not split a source; gateway keys do', () => {
  const rs = [route(1, { session: 'one', folder: '/one', subagentId: 'one' }),
    route(2, { session: 'two', folder: '/two', subagentId: 'two' }),
    route(3, { callerKey: 'key-a' }), route(4, { callerKey: 'key-b' })];
  assert.deepEqual(stageParity(rs), [2, 3, 4]);
  assert.equal(api.sourceKey(compactRoute(rs[0])), api.sourceKey(compactRoute(rs[1])));
  assert.notEqual(api.sourceKey(compactRoute(rs[2])), api.sourceKey(compactRoute(rs[3])));
});

test('staged: deterministic combinations match real native selection regardless of map insertion order', () => {
  for (let mask = 0; mask < 64; mask++) {
    const rs = Array.from({ length: 6 }, (_, i) => route(i + 1, {
      agent: `agent-${i % 5}`, done: Boolean(mask & (1 << i)),
      time: new Date(NOW - (i % 2 ? 13000 : 1000)).toISOString(),
    }));
    if (mask % 2) rs.reverse();
    stageParity(rs, rs.filter((r) => (r.id + mask) % 3 === 0).map((r) => r.id), mask % 7 || null);
  }
});

test('told: empty, missing current, unfinished current and routed-current handoff match native told()', () => {
  assert.equal(toldParity([], null), null);
  assert.equal(toldParity([route(2)], 99), 2);
  assert.equal(toldParity([route(1), route(2)], 1), 1);
  const routed = route(1, { done: true, tries: [{ done: true, status: 200 }] });
  assert.equal(toldParity([routed, route(2)], 1), 1);
  assert.equal(toldParity([routed, route(2, { tries: [{ done: false, status: 0 }] })], 1), 2);
  assert.equal(toldParity([routed, route(2, { done: true })], 1), 2);
  assert.equal(toldParity([route(1, { done: true }), route(2)], 1), 2);
  assert.equal(toldParity([route(2), route(1, { done: true })], 2), 2);
});

test('tryOk: status/fail alone decide success, including informational error notes', () => {
  const cases = [
    [{ status: 200, error: 'No title was requested' }, true],
    [{ status: 200, fail: 'other', error: 'stream broke off' }, false],
    [{ status: 200, fail: 'canceled' }, false],
    [{ status: 0 }, true], [{ status: 199 }, true], [{ status: 399 }, true],
    [{ status: 400 }, false], [{ status: 503 }, false],
  ];
  for (const [tr, expected] of cases) {
    assert.equal(nativeScope.API.tryOk(tr), expected);
    assert.equal(api.tryOk(tr), nativeScope.API.tryOk(tr));
  }
});

test('retryTry: full-stage rest/credits/again/gone failure branch matches native for all combinations', () => {
  for (let mask = 0; mask < 16; mask++) {
    const tr = { status: 503, fail: 'other', rest: mask & 1 ? { until: 'later' } : null,
      credits: Boolean(mask & 2), again: Boolean(mask & 4), gone: Boolean(mask & 8) };
    assert.equal(Boolean(api.retryTry(tr)), Boolean(nativeScope.API.retryTry(tr)), JSON.stringify(tr));
  }
});

test('routeStatus: a successful informational note is done; canceled is not an ordinary failure', () => {
  const answered = route(1, { done: true, status: 200, error: 'Titles disabled',
    tries: [{ done: true, status: 200, error: 'Titles disabled' }] });
  assert.equal(api.routeStatus(answered, null, NOW).kind, 'done');
  const canceled = route(2, { done: true, canceled: true, status: 499, error: 'Canceled by agent',
    tries: [{ done: true, status: 499, fail: 'canceled' }] });
  const status = api.routeStatus(canceled, null, NOW);
  assert.notEqual(status.kind, 'bad');
  assert.match(status.label, /取消|cancell?ed/i);
  const broken = route(3, { done: true, status: 200, tries: [{ done: true, status: 200, fail: 'other' }] });
  assert.equal(api.routeStatus(broken, null, NOW).kind, 'bad');
});

test('multi-machine extension: equal numeric IDs keep independent source and provider identities', () => {
  const local = compactRoute(route(7));
  const remote = compactRoute(route(7), 'remote');
  assert.notEqual(local.id, remote.id);
  assert.notEqual(api.sourceKey(local), api.sourceKey(remote));
  assert.notEqual(api.target(local).key, api.target(remote).key);
  const routes = new Map([[local.id, local], [remote.id, remote]]);
  assert.deepEqual(Array.from(api.stagedRoutes(routes, new Map(), null, NOW), (r) => r.id).sort(), ['local:7', 'remote:7']);
});

test('routeCompare: same-machine sequence wins; unrelated machine sequences compare by time', () => {
  const early = new Date(NOW - 2000).toISOString(), late = new Date(NOW - 1000).toISOString();
  const first = compactRoute(route(2, { time: late }));
  const second = compactRoute(route(10, { time: early }));
  assert.ok(api.routeCompare(first, second) < 0);
  assert.ok(api.routeCompare(second, first) > 0);
  const remote = compactRoute(route(1, { time: late }), 'remote');
  assert.ok(api.routeCompare(second, remote) < 0);
  assert.ok(api.routeCompare(remote, second) > 0);
  assert.equal(api.routeCompare(first, first), 0);
});

test('onCurve: finite clamped endpoints and midpoint follow the rendered cubic', () => {
  const a = { x: 10, y: 20 }, b = { x: 90, y: 100 };
  for (const [progress, x, y] of [[-1, 10, 20], [0, 10, 20], [0.5, 50, 60], [1, 90, 100], [2, 90, 100]]) {
    const point = api.onCurve(a, b, progress);
    assert.equal(point.x, x);
    assert.equal(point.y, y);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
});
