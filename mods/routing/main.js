import { View, div, svg, image, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, shared, setShared, agents, focused, terminals, spaces } from "herdr";

const TRACE_URL = "http://127.0.0.1:3425/v1/magpie/trace";
const WIDTH = 400;
const SOURCE_X = 8, SOURCE_W = 90, SOURCE_H = 28;
const DEST_X = 292, DEST_W = 94, DEST_H = 58;
const HUB_X = 154, HUB_SIZE = 42;
const LEG_MS = 480, STEPS = 4;
const BEE_SIZE = 32;
const LINGER_MS = 12000;
const STALE_FEED_MS = 15000;
const MAX_STAGE_SOURCES = 4;

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function currentAgent() {
  const focus = focused();
  const list = agents();
  const agent = (focus?.agent && list.find((item) => item.address === focus.agent)) || list.find((item) => item.focused);
  if (!agent) return null;
  const terminal = terminals().find((item) => item.address === agent.address);
  return { agent, terminal, focus };
}

function pathTail(value) {
  const parts = String(value || "").replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/").toLowerCase();
}

function sourceMatchesAgent(route, current) {
  if (!current) return false;
  const agent = current.agent;
  const routeAgent = text(route.agent).toLowerCase();
  const app = text(agent.app, text(agent.program?.key, text(agent.program?.name))).toLowerCase();
  const routeSession = text(route.session);
  const knownSessions = [agent.session, current.terminal?.session, current.focus?.session].filter(Boolean).map((value) => String(value));
  if (routeSession && knownSessions.includes(routeSession)) return true;
  if (!app || routeAgent !== app) return false;
  const routeFolder = pathTail(route.folder || route.workDir || route.cwd);
  const currentFolder = pathTail(current.focus?.cwd || current.terminal?.cwd);
  return Boolean(routeFolder && currentFolder && routeFolder === currentFolder);
}

function highlightedSources(sources) {
  const current = currentAgent();
  if (!current) return new Set();
  const matches = [...sources.entries()].filter(([, routes]) => routes.some((route) => sourceMatchesAgent(route, current)));
  return matches.length === 1 ? new Set([matches[0][0]]) : new Set();
}
function routeKey(route, origin = route.traceOrigin || "local") {
  return `${origin}:${route.id}`;
}
function sourceKey(route) {
  return JSON.stringify([route.traceOrigin || "local", route.agent, route.callerKey || ""]);
}
function routeAt(route) { return Date.parse(route.time) || 0; }
function routeRecent(route, now) {
  const clock = route.traceNow || now;
  return !route.done || routeAt(route) + Number(route.ms || route.millis || 0) > clock - LINGER_MS;
}
function routeCompare(a, b) {
  const ai = Number(a.traceId ?? a.id), bi = Number(b.traceId ?? b.id);
  if ((a.traceOrigin || "local") === (b.traceOrigin || "local")) return ai - bi;
  return routeAt(a) - routeAt(b) || ai - bi;
}
function routeNewest(routes) {
  return [...routes.values()].sort(routeCompare).pop() || null;
}
function toldRoute(routes, currentId) {
  const newest = routeNewest(routes);
  const current = currentId == null ? null : routes.get(currentId);
  if (!current || !newest || current.id === newest.id) return newest;
  if (!current.done) return current;
  return newest.done || (newest.tries || []).length || !(current.tries || []).length ? newest : current;
}
function tryOk(tr) { return Boolean(tr) && Number(tr.status) < 400 && !tr.fail; }
function retryTry(tr) { return Boolean(tr.rest || tr.credits || (tr.again && !tr.gone)); }
function stagedRoutes(routes, flights, currentRouteId, now) {
  const all = [...routes.values()].sort(routeCompare);
  const last = new Map();
  for (const route of all) last.set(sourceKey(route), route);
  const selected = all.filter((route) => flights.has(route.id) || (last.get(sourceKey(route)) === route && routeRecent(route, now)));
  const current = routes.get(currentRouteId);
  if (current && !selected.includes(current)) selected.push(current);
  const sources = [...new Set(selected.map(sourceKey))].slice(-MAX_STAGE_SOURCES);
  return selected.filter((route) => sources.includes(sourceKey(route))).sort(routeCompare);
}
function sourceName(route) {
  const agent = text(route.agent, "agent");
  const origin = route.traceOrigin && route.traceOrigin !== "local" ? "远程" : "本机";
  return `${agent} · ${origin}`;
}
function sourceTooltip(route) {
  const session = text(route.session, text(route.conv, ""));
  const subagent = text(route.subagentId, text(route.sub, ""));
  const origin = route.traceOrigin && route.traceOrigin !== "local" ? route.traceOrigin : "local";
  return `${text(route.agent, "agent")} · ${origin}${session ? `\n会话: ${session}` : ""}${subagent ? `\n子会话: ${subagent}` : ""}`;
}

function target(route, attempt = (route.tries || []).length - 1) {
  const tries = route.tries || [];
  const index = attempt == null || attempt < 0 ? tries.length - 1 : attempt;
  const tr = tries[index];
  const order = route.order || [];
  const seat = tr && (order.find((w) => w.id === tr.id && w.model === tr.model && (w.fixed || "") === (tr.fixed || ""))
    || order.find((w) => w.id === tr.id && w.model === tr.model)
    || order.find((w) => w.id === tr.id));
  const provider = text(seat?.provider, text(route.provider, "?"));
  const model = text(tr?.served, text(tr?.model, text(seat?.model, text(route.model))));
  const requestedModel = text(route.model);
  const groupRef = text(route.group?.id, text(route.group?.ref, requestedModel.startsWith("group/") ? requestedModel.slice(6) : ""));
  const origin = route.traceOrigin || "local";
  return { key: JSON.stringify([origin, provider, model, groupRef]), name: text(seat?.name, provider), provider, model, groupRef, origin };
}

function targetColor(t, destination) {
  const value = destination.groupRef || `${destination.provider}:${destination.model}`;
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6][Math.abs(hash) % 6] || t.accent;
}

function place(previous, wanted, limit = 3) {
  const selected = wanted.slice(0, limit);
  const slots = previous.map((key) => selected.includes(key) ? key : null);
  for (const key of selected) {
    if (slots.includes(key)) continue;
    const gap = slots.indexOf(null);
    if (gap < 0) slots.push(key);
    else slots[gap] = key;
  }
  return slots.filter(Boolean);
}

function statusColor(t, status) {
  if (status.kind === "stale") return t.dim;
  if (status.kind === "bad") return t.blocked;
  if (status.kind === "retry") return t.ansi3 || t.working || t.accent;
  if (status.kind === "done") return t.done;
  return t.working || t.accent;
}

function statusKindForFlight(flight) {
  if (flight?.state === "bad") return "bad";
  if (flight?.state === "ok") return "done";
  return flight?.attempt > 0 ? "retry" : "active";
}


function activeCount(routes) { return routes.filter((route) => !route.done).length; }

function heightOf(count) { return DEST_H + 20 + Math.max(0, count - 1) * 78; }
function centerY(index, count, height) { return height / 2 + (index - (count - 1) / 2) * 78; }
function elapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 1 ? "<1s" : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function routeStatus(route, flight, now) {
  const tries = route.tries || [];
  const tryCount = tries.length;
  const attempt = flight?.attempt ?? tryCount - 1;
  const tr = attempt >= 0 ? tries[attempt] : null;
  const started = flight?.startedAt || Date.parse(route.time) || now;
  // Finished requests keep trace duration, even while retained or animating home.
  const time = route.done ? (Number.isFinite(route.ms) ? elapsed(route.ms) : "—") : elapsed(now - started);
  if (route.traceStale) return { kind: "stale", label: "连接中断", time };
  if (route.canceled || tr?.fail === "canceled") return { kind: "gone", label: "已取消", time };
  if (route.done && route.status < 400 && (!tries.length || tries.some(tryOk))) return { kind: "done", label: "已完成", time };
  if (flight?.state === "bad" || (route.done && (route.status >= 400 || tries.every((item) => !tryOk(item))))) return { kind: "bad", label: "失败", time };
  if (flight?.state === "ok") return { kind: "done", label: "已完成", time };
  if (flight?.moving) return { kind: attempt > 0 ? "retry" : "active", label: flight.reverse ? "返回中" : attempt > 0 ? "重试中" : "路由中", time };
  if (flight?.state === "waiting") {
    const hasContent = route.contentAt > 0 || tr?.ttft > 0 || tr?.firstText > 0;
    return { kind: "active", label: hasContent ? "生成中" : "等待首字", time };
  }
  if (tryCount > 1 || attempt > 0) return { kind: "retry", label: "重试中", time };
  return { kind: "active", label: "处理中", time };
}
// Both the painted wire and the native motion waypoints use this same cubic.
function onCurve(a, b, progress) {
  const p = Math.max(0, Math.min(1, progress)), q = 1 - p, mid = (a.x + b.x) / 2;
  return {
    x: q * q * q * a.x + 3 * q * q * p * mid + 3 * q * p * p * mid + p * p * p * b.x,
    y: q * q * q * a.y + 3 * q * q * p * a.y + 3 * q * p * p * b.y + p * p * p * b.y,
  };
}

export default class Routing extends View {
  init(_props, cx) {
    this.clock = Date.now();
    this.routes = new Map();
    this.feeds = new Map();
    this.flights = new Map();
    this.waiters = new Set();
    this.sourceSlots = [];
    this.targetSlots = [];
    this.currentRouteId = null;
    this.paths = new Map();
    this.loaded = false;
    this.connected = false;
    this.closed = false;
    this.wasOpen = false;
    this.generation = 0;
    if (shared("routing.open") === undefined) setShared("routing.open", false);
    cx.timer.every(1000, (cx) => { this.clock = Date.now(); cx.notify(); });
    this.pollFeeds(cx);
    cx.timer.every(650, (cx) => this.pollFeeds(cx));
  }

  pollFeeds(cx) {
    const machines = [...new Set(spaces().map((space) => space.machine).filter(Boolean))];
    const origins = [{ name: "local", machine: null }, ...machines.map((machine) => ({ name: machine, machine }))];
    const wanted = new Set(origins.map((origin) => origin.name));
    for (const name of this.feeds.keys()) if (!wanted.has(name)) this.feeds.delete(name);
    for (const origin of origins) {
      let feed = this.feeds.get(origin.name);
      if (!feed) {
        feed = { ...origin, after: 0, pid: null, routes: new Map(), fresh: [], loaded: false, connected: false, pending: false, failedAt: 0 };
        this.feeds.set(origin.name, feed);
      }
      if (feed.failedAt && Date.now() - feed.failedAt >= STALE_FEED_MS) {
        feed.routes.clear();
        feed.after = 0;
        feed.pid = null;
        feed.loaded = false;
        this.rebuildRoutes();
      }
      if (feed.pending) continue;
      feed.pending = true;
      cx.spawn(async (cx) => {
        try {
          await this.pullFeed(origin);
          this.rebuildRoutes();
          this.connected = [...this.feeds.values()].some((item) => item.connected);
          this.loaded = [...this.feeds.values()].some((item) => item.loaded);
          const open = shared("routing.open") === true;
          if (!open && this.flights.size) this.cancelFlights();
          if (open) {
            const live = [...this.routes.values()].filter((route) => !route.done).sort((a, b) => Number(a.traceId ?? a.id) - Number(b.traceId ?? b.id)).slice(-MAX_STAGE_SOURCES);
            for (const route of live) if (!this.flights.has(route.id)) this.startFlight(route.id, cx);
          }
          this.wasOpen = open;
          this.wake();
          cx.notify();
        } finally {
          if (this.feeds.get(origin.name) === feed) feed.pending = false;
        }
      });
    }
  }
  cancelFlights() {
    this.generation++;
    this.flights.clear();
    this.wake();
  }

  wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async pullFeed(origin) {
    let feed = this.feeds.get(origin.name);
    if (!feed) {
      feed = { ...origin, after: 0, pid: null, routes: new Map(), fresh: [], loaded: false, connected: false, failedAt: 0 };
      this.feeds.set(origin.name, feed);
    }
    feed.fresh = [];
    if (feed.failedAt && Date.now() - feed.failedAt >= STALE_FEED_MS) {
      feed.routes.clear();
      feed.after = 0;
      feed.pid = null;
      feed.loaded = false;
    }
    try {
      const query = `${TRACE_URL}?after=${feed.after}${feed.loaded ? "&wait=1" : ""}`;
      const options = origin.machine ? { on: origin.machine, timeout: 30000 } : { timeout: 30000 };
      const result = await exec("curl", ["-fsS", "--max-time", "28", query], options);
      const data = JSON.parse(result.stdout);
      if (data.object !== "trace" || !Array.isArray(data.routes) || !Array.isArray(data.ids) || !Number.isFinite(data.seq)) throw new Error("Invalid trace response");
      const reset = feed.pid !== data.pid || data.seq < feed.after;
      if (reset) feed.routes.clear();
      const traceNow = Date.parse(data.now) || Date.now();
      const initial = !feed.loaded;
      for (const route of data.routes) {
        const id = routeKey(route, origin.name);
        const known = feed.routes.has(id);
        feed.routes.set(id, { ...route, id, traceId: route.id, traceOrigin: origin.name, traceNow, traceStale: false });
        if (!known && (!route.done || (!initial && this.wasOpen))) feed.fresh.push(id);
      }
      const ids = new Set(data.ids.map((id) => `${origin.name}:${id}`));
      for (const [id, route] of feed.routes) {
        if (!route.done && !ids.has(id)) feed.routes.delete(id);
        else feed.routes.set(id, { ...route, traceNow });
      }
      for (const id of [...feed.routes.keys()].sort((a, b) => Number(feed.routes.get(a).traceId) - Number(feed.routes.get(b).traceId)).slice(0, -60)) feed.routes.delete(id);
      feed.after = data.seq;
      feed.pid = data.pid;
      feed.loaded = true;
      feed.connected = true;
      feed.failedAt = 0;
      const serverNow = Date.parse(data.now);
      if (Number.isFinite(serverNow)) feed.skew = serverNow - Date.now();
    } catch {
      if (!feed.failedAt) feed.failedAt = Date.now();
      if (Date.now() - feed.failedAt >= STALE_FEED_MS) {
        feed.routes.clear();
        feed.after = 0;
        feed.pid = null;
        feed.loaded = false;
      } else {
        for (const [id, route] of feed.routes) feed.routes.set(id, { ...route, traceStale: true });
      }
      feed.connected = false;
    }
  }
  rebuildRoutes() {
    this.routes.clear();
    for (const feed of this.feeds.values()) for (const [id, route] of feed.routes) this.routes.set(id, route);
    for (const [id, flight] of this.flights) {
      if (this.routes.has(id)) flight.route = this.routes.get(id);
      else this.flights.delete(id);
    }
    this.currentRouteId = toldRoute(this.routes, this.currentRouteId)?.id ?? null;
  }

  startFlight(id, cx) {
    if (this.flights.has(id)) return;
    const route = this.routes.get(id);
    if (!route) return;
    const flight = { id, route, attempt: -1, leg: "source", progress: 0, reverse: false, state: "request", moving: false, startedAt: Date.parse(route.time) || Date.now() };
    this.flights.set(id, flight);
    const generation = this.generation;
    cx.spawn(async (cx) => {
      const alive = () => !this.closed && generation === this.generation && this.flights.get(id) === flight && this.routes.has(id) && shared("routing.open") === true;
      const current = () => this.routes.get(id);
      const until = async (predicate) => {
        while (alive() && !predicate()) await new Promise((resolve) => this.waiters.add(resolve));
        return alive();
      };
      const move = async (leg, reverse = false) => {
        flight.leg = leg;
        flight.reverse = reverse;
        flight.progress = reverse ? 1 : 0;
        flight.moving = true;
        cx.notify();
        // Mount at the start before supplying native transition targets.
        await cx.sleep(32);
        for (let step = 1; step <= STEPS && alive(); step++) {
          flight.progress = reverse ? 1 - step / STEPS : step / STEPS;
          cx.notify();
          await cx.sleep(LEG_MS / STEPS);
        }
        flight.moving = false;
        return alive();
      };
      try {
        if (!await move("source")) return;
        for (let index = 0; alive(); index++) {
          if (!await until(() => (current().tries || []).length > index || current().done)) return;
          const tr = (current().tries || [])[index];
          if (!tr) {
            flight.state = "bad";
            await move("source", true);
            return;
          }
          flight.attempt = index;
          flight.route = current();
          flight.state = "request";
          if (!await move("target")) return;
          flight.state = "waiting";
          cx.notify();
          if (!await until(() => current().tries?.[index]?.done || current().done)) return;
          const result = current().tries?.[index];
          if (tryOk(result)) {
            if (!await until(() => current().done)) return;
            flight.state = "ok";
            if (!await move("target", true)) return;
            await move("source", true);
            return;
          }
          flight.state = "bad";
          if (!await move("target", true)) return;
          if (!result || !retryTry(result)) {
            await move("source", true);
            return;
          }
        }
      } finally {
        if (this.flights.get(id) === flight) this.flights.delete(id);
        cx.notify();
      }
    });
  }

  stageData() {
    const now = this.clock || Date.now();
    const routes = stagedRoutes(this.routes, this.flights, this.currentRouteId, now);
    const sources = new Map(), targets = new Map();
    for (const route of routes) {
      const source = sourceKey(route), flight = this.flights.get(route.id);
      const destination = target(route, flight && flight.attempt >= 0 ? flight.attempt : undefined);
      if (!sources.has(source)) sources.set(source, []);
      sources.get(source).push(route);
      if ((route.tries || []).length) {
        if (!targets.has(destination.key)) targets.set(destination.key, { ...destination, routes: [] });
        targets.get(destination.key).routes.push(route);
      }
    }
    const sourceLimit = MAX_STAGE_SOURCES;
    const targetLimit = this.expanded ? targets.size : MAX_STAGE_SOURCES;
    this.sourceSlots = place(this.sourceSlots, [...sources.keys()], sourceLimit);
    this.targetSlots = place(this.targetSlots, [...targets.keys()], targetLimit);
    const hiddenSources = Math.max(0, sources.size - this.sourceSlots.length);
    const hiddenTargets = Math.max(0, targets.size - this.targetSlots.length);
    return { routes, sources, targets, height: heightOf(Math.max(this.sourceSlots.length, this.targetSlots.length, 1)), now: this.clock || Date.now(), hiddenSources, hiddenTargets };
  }

  wireGeometry(data, leg, key) {
    const hubY = data.height / 2;
    if (leg === "source") {
      const index = this.sourceSlots.indexOf(key);
      if (index < 0) return null;
      return [{ x: SOURCE_X + SOURCE_W + 3, y: centerY(index, this.sourceSlots.length, data.height) }, { x: HUB_X - 3, y: hubY }];
    }
    const index = this.targetSlots.indexOf(key);
    if (index < 0) return null;
    return [{ x: HUB_X + HUB_SIZE + 3, y: hubY }, { x: DEST_X - 3, y: centerY(index, this.targetSlots.length, data.height) }];
  }

  wire(t, geometry, height) {
    if (!geometry) return div().w(0).h(0);
    const [a, b] = geometry;
    const mid = (a.x + b.x) / 2;
    const key = `${a.x},${a.y},${b.x},${b.y}`;
    let path = this.paths.get(key);
    if (!path) {
      path = PathBuilder.stroke(1).move_to(a.x, a.y).cubic_bezier_to(b.x, b.y, mid, a.y, mid, b.y).build();
      if (this.paths.size >= 24) this.paths.clear();
      this.paths.set(key, path);
    }
    return window.paint_path(path, Background.solid(t.muted).opacity(0.48)).absolute().left(0).top(0).w(WIDTH).h(height);
  }

  node(t, name, subtitle, compact, working, highlighted = false, detail = "", status = "", accent = t.border, statusTint = null) {
    const node = v_flex().w(compact ? SOURCE_W : DEST_W).h(compact ? SOURCE_H : DEST_H)
      .px(8).py(compact ? 0 : 5).gap(1).justify_center().rounded(10).border_1().border_color(highlighted ? t.accent : accent).bg(highlighted ? t.accent + "18" : t.surface)
      .child(h_flex().items_center().gap(5)
        .child(div().size(5).flex_none().rounded_full().bg(statusTint || (working ? t.working : t.done)))
        .child(div().min_w(0).flex_1().text_size(12).line_height("15px").font_semibold().truncate().text_color(t.foreground).child(name)));
    if (!compact) {
      node.child(div().min_w(0).text_size(10.5).line_height("13px").truncate().text_color(t.muted).child(subtitle));
      if (detail) node.child(div().min_w(0).text_size(10).line_height("13px").truncate().text_color(t.dim).child(detail));
      node.child(div().min_w(0).text_size(9.5).line_height("12px").truncate().text_color(statusTint || t.dim).child(status));
    }
    return node;
  }

  routeTooltip(route, flight, now) {
    const status = routeStatus(route, flight, now);
    const destination = target(route, flight && flight.attempt >= 0 ? flight.attempt : undefined);
    const attempt = flight?.attempt >= 0 ? flight.attempt : (route.tries || []).length - 1;
    const tr = attempt >= 0 ? route.tries?.[attempt] : null;
    const lines = [
      sourceName(route),
      `状态: ${status.label} · ${status.time}`,
      `请求: ${text(route.model, "未知模型")}`,
      `目标: ${destination.name} · ${destination.model}`,
      `会话: ${text(route.session, text(route.conv, "-"))}`,
      `子会话: ${text(route.subagentId, text(route.sub, "-"))}`,
      `重试: ${attempt >= 0 ? `${attempt + 1} / ${(route.tries || []).length}` : "尚未尝试"}`,
      `响应: ${tr?.status ? String(tr.status) : "等待响应"}`,
    ];
    if (tr?.ttft > 0) lines.push(`首字: ${tr.ttft}ms`);
    if (tr?.firstText > 0) lines.push(`首文本: ${tr.firstText}ms`);
    const error = text(route.error, text(tr?.error, text(route.fail)));
    if (error) lines.push(`错误: ${error}`);
    return lines.join("\n");
  }

  topology(t, data) {
    const children = [];
    const highlighted = highlightedSources(data.sources);
    for (const key of this.sourceSlots) children.push(this.wire(t, this.wireGeometry(data, "source", key), data.height));
    for (const key of this.targetSlots) children.push(this.wire(t, this.wireGeometry(data, "target", key), data.height));
    this.sourceSlots.forEach((key, index) => {
      const routes = data.sources.get(key);
      const route = routes.find((item) => !item.done) || routes[0];
      const flight = this.flights.get(route.id);
      const status = routeStatus(route, flight, data.now);
      children.push(this.node(t, sourceName(route), "", true, routes.some((r) => !r.done), highlighted.has(key), "", "", t.border, statusColor(t, status))
        .tooltip(this.routeTooltip(route, flight, data.now))
        .absolute().left(SOURCE_X).top(centerY(index, this.sourceSlots.length, data.height) - SOURCE_H / 2));
    });
    this.targetSlots.forEach((key, index) => {
      const destination = data.targets.get(key);
      const activeRoute = destination.routes.find((route) => !route.done) || destination.routes[0];
      const activeFlight = activeRoute && this.flights.get(activeRoute.id);
      const status = routeStatus(activeRoute, activeFlight, data.now);
      const count = activeCount(destination.routes);
      const countText = count > 1 ? ` · ${count} active` : "";
      const origin = destination.origin && destination.origin !== "local" ? ` · ${destination.origin}` : "";
      const statusText = `${status.label} · ${status.time}${countText}`;
      const accent = targetColor(t, destination);
      children.push(this.node(t, destination.name, `${destination.model}${origin}`, false, count > 0, false, "", statusText, accent, statusColor(t, status))
        .tooltip(this.routeTooltip(activeRoute, activeFlight, data.now))
        .absolute().left(DEST_X).top(centerY(index, this.targetSlots.length, data.height) - DEST_H / 2));
    });
    if (data.hiddenSources) children.push(div().absolute().left(SOURCE_X).top(data.height - 18).text_size(10).text_color(t.dim).cursor_pointer().tooltip("展开全部来源").on_click((_e, cx) => { this.expanded = true; cx.notify(); }).child(`+${data.hiddenSources} more sources`));
    if (data.hiddenTargets) children.push(div().absolute().left(DEST_X).top(data.height - 18).text_size(10).text_color(t.dim).cursor_pointer().tooltip("展开全部目标").on_click((_e, cx) => { this.expanded = true; cx.notify(); }).child(`+${data.hiddenTargets} more targets`));
    if (this.expanded) children.push(div().absolute().left(HUB_X + 2).top(data.height - 18).text_size(10).text_color(t.dim).cursor_pointer().tooltip("收起来源和目标").on_click((_e, cx) => { this.expanded = false; cx.notify(); }).child("收起"));
    children.push(image("mods/routing/magpie.png").absolute().left(HUB_X).top(data.height / 2 - HUB_SIZE / 2).size(HUB_SIZE));
    for (const flight of this.flights.values()) {
      // One packet stays on the wire while held, then leaves with its return carrier.
      const route = this.routes.get(flight.id) || flight.route;
      const key = flight.leg === "source" ? sourceKey(route) : target(route, flight.attempt).key;
      const geometry = this.wireGeometry(data, flight.leg, key);
      if (!geometry) continue;
      const p = onCurve(...geometry, flight.progress);
      const color = statusColor(t, { kind: statusKindForFlight(flight) });
      const targetRoutes = data.targets.get(key)?.routes || [];
      const offsetIndex = targetRoutes.findIndex((item) => item.id === flight.id);
      const offset = offsetIndex < 0 ? 0 : (offsetIndex % 5 - 2) * 6;
      const marker = div().id(`flight-${flight.id}`).absolute().left(p.x - BEE_SIZE / 2).top(p.y - BEE_SIZE / 2 + offset).w(BEE_SIZE).h(BEE_SIZE)
        .transition("left", { duration: LEG_MS / STEPS, easing: "linear" })
        .transition("top", { duration: LEG_MS / STEPS, easing: "linear" });
      if (flight.moving) {
        const direction = flight.reverse ? "back" : "out";
        marker.child(image(`mods/routing/bee-${direction}.png`).id(`carrier-${flight.id}`)
          .absolute().left(flight.reverse ? 16 : -6).top(-7).size(BEE_SIZE));
      }
      const packet = image("mods/routing/flower.png").id(`packet-${flight.id}`)
        .absolute().left(8).top(8).size(16);
      if (!flight.moving) packet.loop("opacity", { from: 0.45, to: 1, period: 1200 });
      marker.child(packet);
      children.push(marker.tooltip(this.routeTooltip(route, flight, data.now)));
    }
    return div().id("routing-stage").relative().w(WIDTH).h(data.height).max_h(420).overflow_y_scrollbar().cursor_grab().children(children);
  }

  render() {
    if (shared("routing.open") !== true) return div().w(0).h(0);
    const t = theme();
    const data = this.stageData();
    if (!data.routes.length) {
      return div().w(WIDTH).h(58).cursor_grab().flex().items_center().justify_center().text_size(11).text_color(t.muted)
        .child(!this.loaded ? "Connecting…" : this.connected ? "No active request" : "Gateway unavailable");
    }
    return this.topology(t, data);
  }

  close() {
    this.closed = true;
    this.cancelFlights();
  }
}
