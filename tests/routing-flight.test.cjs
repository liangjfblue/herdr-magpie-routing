'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modPath = path.join(__dirname, '../mods/routing/main.js');
const source = fs.readFileSync(modPath, 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default class Routing', 'class Routing');

const route = (extra = {}) => ({ id: 'local:1', traceId: 1, traceOrigin: 'local', agent: 'omp',
  provider: 'provider', model: 'model', done: false, status: 0, time: new Date(90000).toISOString(),
  tries: [{ id: 'account-a', model: 'model', done: false, status: 0 }], order: [], ...extra });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(initial = route(), rendering = {}) {
  let open = true;
  const scope = { View: class {}, shared: () => open, console, ...rendering };
  vm.createContext(scope);
  vm.runInContext(source + '\nthis.Routing = Routing;', scope, { filename: modPath });
  const view = new scope.Routing();
  Object.assign(view, { routes: new Map([[initial.id, initial]]), flights: new Map(), waiters: new Set(),
    closed: false, generation: 0 });
  const sleeps = [], jobs = [], snapshots = [];
  const cx = {
    notify() {
      for (const flight of view.flights.values()) snapshots.push({
        leg: flight.leg, reverse: flight.reverse, attempt: flight.attempt,
        state: flight.state, moving: flight.moving, progress: flight.progress,
      });
    },
    sleep(ms) { return new Promise((resolve) => sleeps.push({ ms, resolve })); },
    spawn(fn) { jobs.push(Promise.resolve().then(() => fn(cx))); },
  };
  const flight = () => view.flights.get(initial.id);
  const update = (change) => {
    const next = typeof change === 'function' ? change(view.routes.get(initial.id)) : change;
    view.routes.set(initial.id, next);
    view.wake();
  };
  const advance = async () => {
    await flush();
    assert.ok(sleeps.length, 'Expected a pending animation sleep');
    const next = sleeps.shift();
    next.resolve();
    await flush();
    return next.ms;
  };
  const reach = async (predicate, label) => {
    for (let step = 0; step < 80; step++) {
      await flush();
      if (predicate()) return;
      assert.ok(sleeps.length, `Flight stalled before ${label}`);
      await advance();
    }
    assert.fail(`Flight did not reach ${label} within 80 manual sleep steps`);
  };
  const finish = async () => {
    await reach(() => !view.flights.size, 'finally cleanup');
    await Promise.all(jobs);
    assert.equal(sleeps.length, 0, 'No animation sleep remains after completion');
    assert.equal(view.waiters.size, 0, 'No trace waiter remains after completion');
  };
  return { view, cx, sleeps, snapshots, flight, update, advance, reach, finish,
    start() { view.startFlight(initial.id, cx); },
    async waiting() { await reach(() => flight()?.state === 'waiting' && !flight()?.moving, 'waiting at target'); },
    setOpen(value) { open = value; view.wake(); },
  };
}

test('success: try.done waits motionless at target until route.done, then returns home and cleans up', async () => {
  const h = harness();
  h.start();
  await h.waiting();
  assert.equal(h.flight().leg, 'target');
  assert.equal(h.flight().progress, 1);
  h.update((r) => ({ ...r, tries: [{ ...r.tries[0], done: true, status: 200, error: 'informational note' }] }));
  await flush();
  assert.ok(h.flight(), 'The still-running route owns its flight');
  assert.equal(h.flight().state, 'waiting');
  assert.equal(h.flight().leg, 'target');
  assert.equal(h.flight().reverse, false);
  assert.equal(h.flight().moving, false);
  assert.equal(h.sleeps.length, 0, 'Success cannot start returning before route.done');
  assert.ok(h.view.waiters.size > 0);

  h.update((r) => ({ ...r, done: true, status: 200 }));
  await h.reach(() => h.flight()?.state === 'ok' && h.flight()?.leg === 'target' && h.flight()?.reverse, 'successful target-to-hub return');
  assert.ok(h.flight(), 'route.done does not prematurely remove its returning flight');
  await h.reach(() => h.flight()?.leg === 'source' && h.flight()?.reverse, 'hub-to-agent return');
  assert.ok(h.flight().moving);
  await h.finish();
});

test('retry: a resting failure returns only to hub, waits there, then forwards the next try', async () => {
  const h = harness();
  h.start();
  await h.waiting();
  h.update((r) => ({ ...r, tries: [{ ...r.tries[0], done: true, status: 429, fail: 'quota', rest: { until: 'later' } }] }));
  await h.reach(() => h.flight()?.state === 'bad' && h.flight()?.reverse, 'failed target-to-hub return');
  await h.reach(() => !h.flight()?.moving && h.sleeps.length === 0, 'hub waiting for next try');
  assert.equal(h.flight().leg, 'target');
  assert.equal(h.flight().progress, 0);
  assert.equal(h.flight().attempt, 0);
  assert.equal(h.snapshots.some((s) => s.leg === 'source' && s.reverse), false, 'Retry failure never reaches the agent');
  h.update((r) => ({ ...r, tries: [...r.tries, { id: 'account-b', model: 'model', done: false, status: 0 }] }));
  await h.reach(() => h.flight()?.attempt === 1 && h.flight()?.leg === 'target' && !h.flight()?.reverse, 'next try outbound');
  await h.waiting();
  h.update((r) => ({ ...r, done: true, status: 200,
    tries: [r.tries[0], { ...r.tries[1], done: true, status: 200 }] }));
  await h.finish();
});

test('terminal failure: no retry flags returns to agent without waiting for a later route.done', async () => {
  const h = harness();
  h.start();
  await h.waiting();
  h.update((r) => ({ ...r, tries: [{ ...r.tries[0], done: true, status: 400, fail: 'shape' }] }));
  await h.reach(() => h.flight()?.leg === 'source' && h.flight()?.reverse, 'terminal error delivery to agent');
  assert.equal(h.flight().state, 'bad');
  assert.equal(h.view.routes.get('local:1').done, false);
  await h.finish();
});

test('gone overrides again: a terminal canceled try returns home instead of waiting for retry', async () => {
  const h = harness();
  h.start();
  await h.waiting();
  h.update((r) => ({ ...r, tries: [{ ...r.tries[0], done: true, status: 499, fail: 'canceled', again: true, gone: true }] }));
  await h.reach(() => h.flight()?.leg === 'source' && h.flight()?.reverse, 'gone error delivery to agent');
  await h.finish();
});

test('route removed while waiting: wake exits and finally releases the flight with no ghost waiter', async () => {
  const h = harness();
  h.start();
  await h.waiting();
  h.view.routes.delete('local:1');
  h.view.wake();
  await h.finish();
});

test('route removed during flight: next manual animation step exits and cleans up', async () => {
  const h = harness();
  h.start();
  await flush();
  assert.ok(h.flight()?.moving);
  h.view.routes.delete('local:1');
  h.view.wake();
  await h.advance();
  await h.finish();
});

test('cancel generation: old finally must not remove a replacement flight for the same request', async () => {
  const h = harness();
  h.start();
  await h.waiting();
  const original = h.flight();
  h.view.cancelFlights();
  h.start();
  const replacement = h.flight();
  assert.notEqual(replacement, original);
  await flush();
  assert.equal(h.flight(), replacement, 'Stale play finally cannot erase the new generation');
  await h.waiting();
  h.update((r) => ({ ...r, done: true, status: 200, tries: [{ ...r.tries[0], done: true, status: 200 }] }));
  await h.finish();
});

test('close during target wait wakes and terminates instead of keeping a suspended flight', async () => {
  const h = harness();
  h.start();
  await h.waiting();
  h.view.close();
  await h.finish();
  assert.equal(h.view.closed, true);
});

test('one flower packet is delivered, held without a bee, collected on return, and removed at home', async () => {
  const element = (kind, value) => {
    const data = { kind, value, nodes: [], attrs: {} };
    let proxy;
    proxy = new Proxy(data, { get(object, key) {
      if (key in object) return object[key];
      if (key === 'child') return (child) => { data.nodes.push(child); return proxy; };
      if (key === 'children') return (children) => { data.nodes.push(...children); return proxy; };
      return (...args) => { data.attrs[key] = args; return proxy; };
    } });
    return proxy;
  };
  const h = harness(route(), { div: () => element('div'), image: (p) => element('image', p),
    svg: (p) => element('svg', p), focused: () => null, agents: () => [] });
  Object.assign(h.view, { sourceSlots: [], targetSlots: [], routeTooltip: () => '',
    wireGeometry: (_data, leg) => leg === 'target'
      ? [{ x: 100, y: 50 }, { x: 200, y: 50 }]
      : [{ x: 0, y: 50 }, { x: 100, y: 50 }] });
  const render = () => h.view.topology({}, { sources: new Map(), targets: new Map(), height: 100 });
  const marker = () => render().nodes.find((node) => node.attrs.id?.[0] === 'flight-local:1');
  const packet = () => marker()?.nodes.find((node) => node.kind === 'image' && node.value === 'mods/routing/flower.png');
  const carrier = () => marker()?.nodes.find((node) => node.kind === 'image' && node.value.includes('bee-'));
  h.start();
  await h.reach(() => h.flight()?.leg === 'target' && h.flight()?.moving, 'outbound packet');
  assert.equal(carrier().value, 'mods/routing/bee-out.png');
  const packetId = packet().attrs.id[0], packetLeft = packet().attrs.left[0], packetTop = packet().attrs.top[0];
  await h.waiting();
  assert.equal(carrier(), undefined, 'Only the flower waits at the provider');
  assert.equal(packet().attrs.id[0], packetId);
  const heldLeft = marker().attrs.left[0];
  h.update((r) => ({ ...r, done: true, status: 200, tries: [{ ...r.tries[0], done: true, status: 200 }] }));
  await h.reach(() => h.flight()?.reverse && h.flight()?.leg === 'target', 'return pickup');
  assert.equal(carrier().value, 'mods/routing/bee-back.png');
  assert.equal(packet().attrs.id[0], packetId);
  assert.equal(packet().attrs.left[0], packetLeft, 'Pickup never moves the petal within its carrier');
  assert.equal(packet().attrs.top[0], packetTop);
  assert.equal(marker().attrs.left[0], heldLeft, 'Return starts at the held packet');
  await h.advance();
  assert.ok(marker().attrs.left[0] < heldLeft, 'The held petal leaves the provider with the bee');
  await h.reach(() => h.flight()?.leg === 'source' && h.flight()?.reverse, 'agent return');
  assert.equal(packet().attrs.id[0], packetId);
  await h.finish();
  assert.equal(marker(), undefined, 'No packet remains after delivery home');
});
