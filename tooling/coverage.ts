// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: MIT
//
// Line coverage of a package's `src/` from every thread its tests run code in, when
// SNOWY_COVERAGE=1: each page, the workers it starts and theirs, and its AudioWorklet. V8's
// block coverage starts in each through the page's DevTools session, and is taken from all of
// them whenever one may end: before a page closes or navigates, and when code ends a worker,
// which the page and each wrapped worker pause on (`debugger` in Worker.prototype.terminate).
//
// Chromium runs a new thread at once, before coverage can start in it. So the workers a test
// starts are wrapped (wrapWorkers, tooling/coverage-worker.ts) to wait for it, and the first
// module of each AudioWorklet is an empty one, after which the page waits for the worklet's
// coverage to start. Each take is mapped through the bundles' source maps to the lines that ran
// (tooling/coverage-map.ts), written to coverage/ran/ as a file of its own, named by the test
// process; tooling/check-coverage.ts adds up the last process's files.

import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { counter, mappedLines, type Ran, type ScriptCoverage } from "./coverage-map";

export const COVERAGE = process.env.SNOWY_COVERAGE === "1";

// Sent to each thread once its coverage has started (tooling/coverage-worker.ts).
const GO = "globalThis.__snowyCovered = true; globalThis.__snowyGo?.();";

interface Params {
  sessionId?: string;
  message?: string;
  targetInfo?: { type: string; url?: string };
}

interface Reply {
  result?: ScriptCoverage[];
}

/** A DevTools session: the page's own, or a thread's inside it, one message inside another. */
interface Session {
  send: (method: string, params?: object) => Promise<Reply>;
  on: (method: string, listener: (params: Params) => void) => void;
}

function pageSession(cdp: CDPSession): Session {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Playwright types every DevTools method; this file sends and hears only the few it names
  const untyped = cdp as unknown as Session;

  return {
    send: async (method, params) => await untyped.send(method, params),
    on: (method, listener) => untyped.on(method, listener),
  };
}

interface Message {
  id?: number;
  method?: string;
  params?: Params;
  result?: Reply;
  error?: { message: string };
}

// The session of the thread attached as `sessionId` in `parent`, which hands it what the
// thread sends (`receive`) and tells it when the thread has gone (`end`).
function threadSession(parent: Session, sessionId: string) {
  const replies = new Map<number, PromiseWithResolvers<Reply>>();
  const listeners = new Map<string, Array<(params: Params) => void>>();
  const state = { id: 0 };

  async function post(message: string, reply: PromiseWithResolvers<Reply>) {
    try {
      await parent.send("Target.sendMessageToTarget", { sessionId, message });
    } catch (error) {
      reply.reject(error);
    }
  }

  function send(method: string, params = {}) {
    const id = ++state.id;
    const reply = Promise.withResolvers<Reply>();
    replies.set(id, reply);
    void post(JSON.stringify({ id, method, params }), reply);
    return reply.promise;
  }

  function on(method: string, listener: (params: Params) => void) {
    listeners.set(method, [...(listeners.get(method) ?? []), listener]);
  }

  function receive(text: string) {
    const message: Message = JSON.parse(text);

    if (message.id === undefined) {
      for (const listener of listeners.get(message.method ?? "") ?? [])
        listener(message.params ?? {});
      return;
    }

    const reply = replies.get(message.id);
    replies.delete(message.id);
    if (message.error) reply?.reject(new Error(`coverage: ${message.error.message}`));
    else reply?.resolve(message.result ?? {});
  }

  function end() {
    for (const reply of replies.values()) reply.reject(new Error("coverage: the thread ended"));
    replies.clear();
  }

  return { send, on, receive, end };
}

/**
 * Where the positions each take mapped and ran go, for the package at `dir`: a file per take, so
 * the takes of every page and browser add up without any state shared between them. A line is
 * judged only in `report`, once every take is in, since a take may end between two branches of it.
 */
async function save(dir: string, scripts: ScriptCoverage[]) {
  const ran: Ran = {};

  for (const script of scripts) {
    // A script made by `eval` or `new Function` has no URL, and no bundle to map it through.
    if (!URL.canParse(script.url) || !script.url.startsWith("http")) continue;
    const js = join(dir, decodeURIComponent(new URL(script.url).pathname));
    // The package's bundles only: not another package served beside it, nor a wrapper.
    if (!existsSync(`${js}.map`)) continue;
    const mapped = await mappedLines(dir, js, counter(script));

    for (const [file, positions] of mapped) {
      const of = (ran[file] ??= {});
      for (const [key, wasRun] of positions) of[key] = (of[key] ?? false) || wasRun;
    }
  }

  if (Object.keys(ran).length === 0) return;
  const name = `${process.pid}-${crypto.randomUUID()}.json`;
  await Bun.write(join(dir, "coverage/ran", name), JSON.stringify(ran));
}

async function resume(session: Session) {
  try {
    await session.send("Debugger.resume");
  } catch {
    // Ended while paused: there is nothing left to let go.
  }
}

// The AudioWorklets whose coverage has started, for the page waiting on them.
function createStarts() {
  const worklets = { started: 0, waiting: [] as Array<{ count: number; go: () => void }> };

  function started(type: string) {
    if (type !== "worklet") return;
    worklets.started += 1;
    const ready = worklets.waiting.filter((w) => w.count <= worklets.started);
    worklets.waiting = worklets.waiting.filter((w) => w.count > worklets.started);
    for (const waiting of ready) waiting.go();
  }

  /** Resolves once `count` AudioWorklets have started their coverage. */
  async function workletsStarted(count: number) {
    if (worklets.started >= count) return;
    const go = Promise.withResolvers<void>();
    worklets.waiting.push({ count, go: go.resolve });
    await go.promise;
  }

  return { started, workletsStarted };
}

// Coverage in the page behind `root` and every thread under it, for the package at `dir`.
function createWatch(dir: string, root: Session) {
  const live = new Set<Session>();
  const starts = createStarts();

  // Coverage of every live thread since the last take, saved.
  async function take() {
    const taken = await Promise.all(
      [...live].map(async (session) => {
        try {
          const reply = await session.send("Profiler.takePreciseCoverage");
          return reply.result ?? [];
        } catch {
          // A thread that ended meanwhile took what it ran with it.
          return [];
        }
      }),
    );
    await save(dir, taken.flat());
  }

  // Code paused in `session` to end a worker: taken first, then let go.
  async function paused(session: Session) {
    try {
      await take();
    } finally {
      await resume(session);
    }
  }

  async function startThread(parent: Session, attached: Params, children: Map<string, Thread>) {
    const sessionId = attached.sessionId ?? "";
    const thread = threadSession(parent, sessionId);
    children.set(sessionId, thread);

    try {
      // A worklet starts no threads of its own, and has no Target domain to say so.
      await cover(thread, attached.targetInfo?.type === "worker");
    } catch (error) {
      // A thread that ended or failed before its coverage started reports nothing, which
      // lowers coverage; said here, since the floor that then fails may be another file's.
      console.warn(
        `coverage: none from ${attached.targetInfo?.type} ${attached.targetInfo?.url}:`,
        error,
      );
    }

    try {
      // Let go even if its coverage failed to start, so the thread runs rather than hangs.
      await thread.send("Runtime.evaluate", { expression: GO });
    } catch {
      // A thread that ended meanwhile has nothing to let go.
    } finally {
      starts.started(attached.targetInfo?.type ?? "");
    }
  }

  type Thread = ReturnType<typeof threadSession>;

  async function cover(session: Session, nests: boolean) {
    const children = new Map<string, Thread>();

    session.on("Target.attachedToTarget", (attached) => {
      const type = attached.targetInfo?.type;
      if (type !== "page" && type !== "iframe") void startThread(session, attached, children);
    });

    session.on("Target.receivedMessageFromTarget", ({ sessionId = "", message = "" }) => {
      children.get(sessionId)?.receive(message);
    });

    session.on("Target.detachedFromTarget", ({ sessionId = "" }) => {
      const child = children.get(sessionId);
      children.delete(sessionId);
      if (child) live.delete(child);
      child?.end();
    });

    session.on("Debugger.paused", () => void paused(session));
    await session.send("Profiler.enable");
    await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    live.add(session);
    await session.send("Debugger.enable");
    const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: false };
    if (nests) await session.send("Target.setAutoAttach", autoAttach);
  }

  return {
    start: () => cover(root, true),
    take,
    workletsStarted: starts.workletsStarted,
  };
}

declare global {
  /** Resolves once `count` AudioWorklets have started coverage (coverPage, in a page only). */
  var __snowyWorklets: (count: number) => Promise<void>;
}

// Run in the page before its own scripts: pauses as a worker is ended, and holds each
// AudioWorklet's first module until the worklet's coverage has started.
function hooks() {
  const seen = new WeakSet<AudioWorklet>();
  const worklets = { count: 0 };

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the page runs hooks() from its source text, so what it uses is inside it
  function terminate(end: Worker["terminate"], worker: Worker, args: []) {
    // oxlint-disable-next-line no-debugger -- the pause that has coverage taken before a worker ends
    debugger;
    Reflect.apply(end, worker, args);
  }

  async function addModule(add: AudioWorklet["addModule"], worklet: AudioWorklet, args: [string]) {
    if (!seen.has(worklet)) {
      seen.add(worklet);
      worklets.count += 1;
      // The worklet's thread starts with its first module, and could run code before coverage
      // started in it, so its first module is empty.
      const empty = URL.createObjectURL(new Blob([""], { type: "text/javascript" }));
      await Reflect.apply(add, worklet, [empty]);
      await globalThis.__snowyWorklets(worklets.count);
    }

    await Reflect.apply(add, worklet, args);
  }

  // oxlint-disable-next-line typescript/unbound-method -- the platform method, wrapped in place, is called with its receiver
  Worker.prototype.terminate = new Proxy(Worker.prototype.terminate, { apply: terminate });
  // oxlint-disable-next-line typescript/unbound-method -- the platform method, wrapped in place, is called with its receiver
  AudioWorklet.prototype.addModule = new Proxy(AudioWorklet.prototype.addModule, {
    apply: addModule,
  });
}

/**
 * Collects coverage in `tab`, for the package at `dir`, from before it loads anything: call it
 * before the first `goto`.
 */
export async function coverPage(dir: string, tab: Page) {
  const cdp = await tab.context().newCDPSession(tab);
  const watch = createWatch(dir, pageSession(cdp));
  await tab.exposeFunction("__snowyWorklets", (count: number) => watch.workletsStarted(count));
  await tab.addInitScript(hooks);
  await watch.start();
  const close = tab.close.bind(tab);
  const goto = tab.goto.bind(tab);

  tab.close = async (...args) => {
    if (!tab.isClosed()) await watch.take();
    await close(...args);
  };

  // What the page ran before it goes, as a new document starts its counts again.
  tab.goto = async (...args) => {
    if (tab.url() !== "about:blank") await watch.take();
    return await goto(...args);
  };

  return { take: watch.take };
}

/**
 * Has every page `browser` opens collect coverage for the package at `dir`, and takes what
 * they ran before a page, its context or the browser closes. Does nothing without
 * SNOWY_COVERAGE=1.
 */
export function coverBrowser(dir: string, browser: Browser) {
  if (!COVERAGE) return browser;
  const pages = new Map<Page, () => Promise<void>>();
  const newContext = browser.newContext.bind(browser);
  const newBrowserPage = browser.newPage.bind(browser);
  const closeBrowser = browser.close.bind(browser);

  async function takeAll(context?: BrowserContext) {
    const open = [...pages].filter(
      ([tab]) => !tab.isClosed() && (!context || tab.context() === context),
    );
    await Promise.all(open.map(([, take]) => take()));
  }

  // Once per page, whichever way it was opened.
  async function watch(tab: Page) {
    if (pages.has(tab)) return;
    const watched = await coverPage(dir, tab);
    pages.set(tab, watched.take);
  }

  function wrap(context: BrowserContext) {
    const newPage = context.newPage.bind(context);
    const closeContext = context.close.bind(context);

    context.newPage = async () => {
      const tab = await newPage();
      await watch(tab);
      return tab;
    };

    context.close = async (...args) => {
      await takeAll(context);
      await closeContext(...args);
    };
  }

  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    wrap(context);
    return context;
  };

  // Playwright opens it through newContext, but that is its own business.
  browser.newPage = async (...args) => {
    const tab = await newBrowserPage(...args);
    await watch(tab);
    return tab;
  };

  browser.close = async (...args) => {
    await takeAll();
    await closeBrowser(...args);
  };

  return browser;
}

/**
 * Wraps each worker bundle in `files` to wait for coverage to start before it runs: the bundle
 * moves to `X.covered.js`, with its source map, and tooling/coverage-worker.ts takes its place.
 */
export async function wrapWorkers(files: string[]) {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "coverage-worker.ts")],
    target: "browser",
    format: "esm",
  });
  const [output] = built.outputs;
  if (!built.success || !output)
    throw new AggregateError(built.logs, "coverage: wrapper build failed");
  const wrapper = await output.text();

  for (const js of files) {
    const covered = js.replace(/\.js$/, ".covered.js");
    const code = await Bun.file(js).text();
    // A bundle that names its map is pointed at the map's new name.
    const link = `${basename(js)}.map`;
    await Bun.write(covered, code.replace(link, `${basename(covered)}.map`));
    if (existsSync(`${js}.map`)) await rename(`${js}.map`, `${covered}.map`);
    await Bun.write(js, wrapper);
  }
}
