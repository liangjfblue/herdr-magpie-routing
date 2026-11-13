const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../mods/routing/main.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default class Routing', 'class Routing');
function harness() {
  let now = 100000, reply, reject;
  const jobs = [], timers = [];
  const NativeDate = Date;
  class Clock extends NativeDate { static now() { return now; } }
  const scope = {
    Date: Clock, View: class {}, console,
    spaces: () => [{ machine: 'remote' }],
    shared: () => true, setShared() {}, agents: () => [], terminals: () => [], focused: () => null,
    exec: async () => { if (reject) throw Error('timeout'); return { code: 0, stdout: JSON.stringify(reply) }; },
  };
  vm.createContext(scope);
  vm.runInContext(source + '\nthis.API = { Routing, routeStatus, sourceName, sourceTooltip, sourceKey, target, statusColor, statusKindForFlight };', scope);
  const cx = { notify() {}, spawn(fn) { jobs.push(fn); }, timer: { every(ms, fn) { timers.push([ms, fn]); } } };
  const view = new scope.API.Routing(); view.init({}, cx);
  const origin = { name: 'remote', machine: 'remote' };
  return { view, cx, origin, jobs, api: scope.API,
    time(value) { now = value; view.clock = value; }, fail(value = true) { reject = value; },
    response(value) { reject = false; reply = value; } };
}
const route = (id, done = false) => ({ id, done, agent: 'omp', session: 'session-' + id,
  time: new Date(90000).toISOString(), provider: 'p', model: 'p/m', contentAt: 95000,
  tries: [{ id: 'account', model: 'm', done, status: done ? 200 : undefined }], order: [] });
const trace = (seq, routes, ids = routes.map(r => r.id)) => ({ object: 'trace', seq, pid: 1, routes, ids });

test('failed poll preserves a bounded snapshot, marks it disconnected, then expires even while pending', async () => {
  const h = harness(); h.response(trace(10, [route(1)]));
  await h.view.pullFeed(h.origin); h.view.rebuildRoutes();
  assert.equal(h.view.stageData().routes.length, 1);
  h.time(101000); h.fail(); await h.view.pullFeed(h.origin); h.view.rebuildRoutes();
  const stale = h.view.stageData().routes[0];
  assert.equal(stale.traceStale, true);
  assert.equal(h.api.routeStatus(stale, { state: 'waiting' }, 101000).label, '连接中断');
  h.time(116001); h.view.pollFeeds(h.cx);
  const feed = h.view.feeds.get("remote");
  assert.equal(feed.routes.size, 0);
  assert.equal(feed.after, 0);
  assert.equal(h.view.stageData().routes.length, 0);
});

test('staged follows Magpie: latest per source, playing routes, and twelve-second linger', () => {
  const h = harness();
  const done = { ...route(1, true), traceOrigin: 'remote', traceId: 1 };
  h.view.routes = new Map([['remote:1', done]]);
  h.time(100000);
  assert.equal(h.view.stageData().routes.map((r) => r.traceId).join(','), '1');
  h.time(103001);
  assert.equal(h.view.stageData().routes.length, 0);
  const oldActive = { ...route(2), id: 'remote:2', traceOrigin: 'remote', traceId: 2 };
  const latestActive = { ...route(3), id: 'remote:3', traceOrigin: 'remote', traceId: 3 };
  h.view.routes = new Map([['remote:2', oldActive], ['remote:3', latestActive]]);
  h.time(100000);
  assert.equal(h.view.stageData().routes.map((r) => r.traceId).join(','), '3');
  h.view.flights.set('remote:2', { id: 'remote:2', route: oldActive });
  assert.equal(h.view.stageData().routes.map((r) => r.traceId).join(','), '2,3');
});

test('slow remote does not prevent local update, removed machine cannot reinsert a late response', async () => {
  const h = harness(); h.response(trace(10, [route(1)]));
  await h.jobs[0](h.cx);
  assert.equal(h.view.stageData().routes[0].traceOrigin, 'local');
  const remote = h.view.feeds.get('remote');
  h.view.feeds.delete('remote');
  // pullFeed must ignore replies for an origin no longer registered while it was pending.
  h.view.feeds.set('remote', remote);
  h.response(trace(10, [route(2)]));
  const pending = h.view.pullFeed(h.origin); h.view.feeds.delete('remote'); await pending;
  assert.equal(h.view.feeds.has('remote'), false);
});

test('source names distinguish machines; tooltip includes session and subagent', () => {
  const { api } = harness(); const a = { ...route(1), traceOrigin: 'local' };
  const b = { ...a, traceOrigin: 'remote', subagentId: 'worker' };
  assert.notEqual(api.sourceKey(a), api.sourceKey(b));
  assert.equal(api.sourceName(a), 'omp · 本机'); assert.equal(api.sourceName(b), 'omp · 远程');
  assert.match(api.sourceTooltip(b), /session-1/); assert.match(api.sourceTooltip(b), /worker/);
  assert.notEqual(api.target(a).key, api.target(b).key);
});

test('hover details expose route identity, retry and latency without persistent state', () => {
  const h = harness();
  const r = { ...route(7), traceOrigin: 'local', subagentId: 'worker', error: 'upstream failed', tries: [
    { id: 'first', model: 'm1', done: true, status: 503, ttft: 120 },
    { id: 'second', model: 'm2', done: false, status: 0, firstText: 240 },
  ] };
  const tip = h.view.routeTooltip(r, { attempt: 1, state: 'waiting' }, 101000);
  assert.match(tip, /session-7/);
  assert.match(tip, /worker/);
  assert.match(tip, /重试: 2 \/ 2/);
  assert.match(tip, /首文本: 240ms/);
  assert.match(tip, /upstream failed/);
});

test('playing cannot bypass Magpie four-source cap, even when expanded', () => {
  const h = harness();
  const routes = Array.from({ length: 5 }, (_, i) => ({ ...route(i + 1), agent: 'pi-' + i, traceOrigin: 'local' }));
  h.view.routes = new Map(routes.map((r) => [r.id, r]));
  h.view.flights = new Map(routes.map((r) => [r.id, { id: r.id, route: r }]));
  const collapsed = h.view.stageData();
  assert.equal(collapsed.sources.size, 4);
  assert.equal(collapsed.routes.map((r) => r.id).join(','), '2,3,4,5');
  h.view.expanded = true;
  assert.equal(h.view.stageData().sources.size, 4);
});

test('status colors separate stale, failure, retry, active and done', () => {
  const h = harness();
  const t = { dim: 'dim', blocked: 'blocked', ansi3: 'retry', working: 'working', accent: 'accent', done: 'done' };
  assert.equal(h.api.statusColor(t, { kind: 'stale' }), 'dim');
  assert.equal(h.api.statusColor(t, { kind: 'bad' }), 'blocked');
  assert.equal(h.api.statusColor(t, { kind: 'retry' }), 'retry');
  assert.equal(h.api.statusColor(t, { kind: 'active' }), 'working');
  assert.equal(h.api.statusColor(t, { kind: 'done' }), 'done');
  assert.equal(h.api.statusKindForFlight({ state: 'bad' }), 'bad');
  assert.equal(h.api.statusKindForFlight({ state: 'ok' }), 'done');
  assert.equal(h.api.statusKindForFlight({ state: 'request', attempt: 1 }), 'retry');
});

test('finished success, failure and cancellation keep recorded duration as the clock advances', () => {
  const h = harness();
  const finished = [
    { ...route(1, true), status: 200, ms: 13029 },
    { ...route(2, true), status: 429, ms: 6891, tries: [{ done: true, status: 429, fail: 'quota', ms: 6842 }] },
    { ...route(3, true), canceled: true, ms: 2400 },
  ];
  for (const [index, r] of finished.entries()) {
    const expected = ['13s', '6s', '2s'][index];
    for (const flight of [null, { attempt: 0, state: 'bad', moving: true, startedAt: 91000 }]) {
      assert.equal(h.api.routeStatus(r, flight, 100000).time, expected);
      assert.equal(h.api.routeStatus(r, flight, 8400000).time, expected);
    }
  }
  assert.equal(h.api.routeStatus({ ...finished[1], traceStale: true }, null, 8400000).time, '6s');
});

test('unfinished requests keep timing through retries and stop at request completion', () => {
  const h = harness();
  const r = { ...route(4), tries: [
    { done: true, status: 503, fail: 'server', ms: 3000 },
    { done: false, status: 0 },
  ] };
  assert.equal(h.api.routeStatus(r, { attempt: 1, state: 'waiting' }, 100000).time, '10s');
  assert.equal(h.api.routeStatus(r, { attempt: 1, state: 'waiting' }, 105000).time, '15s');
  r.done = true; r.status = 200; r.ms = 16000;
  r.tries[1] = { done: true, status: 200, ms: 12000 };
  assert.equal(h.api.routeStatus(r, null, 8400000).time, '16s');
});

test('finished zero duration is recorded, missing duration stays unknown instead of ticking', () => {
  const h = harness();
  assert.equal(h.api.routeStatus({ ...route(5, true), status: 200, ms: 0 }, null, 8400000).time, '<1s');
  assert.equal(h.api.routeStatus({ ...route(6, true), status: 200 }, null, 8400000).time, '—');
});
