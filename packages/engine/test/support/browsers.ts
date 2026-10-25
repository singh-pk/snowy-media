// SPDX-FileCopyrightText: 2026 The Snowy Authors
// SPDX-License-Identifier: LicenseRef-Snowy-License-1.0
//
// Chromium with WebGPU on a GPU, for the tests and the benchmarks: headless, it uses the GPU
// only when told to (docs/architecture.md#testing). With SNOWY_PROFILE=low-end, as on a budget
// laptop (docs/architecture.md#low-end).

import { $ } from "bun";
import { type Browser, type BrowserContext, chromium, type LaunchOptions } from "playwright";

// On a machine without a GPU, as CI's Windows and Linux runners, WebGPU renders in software
// with SNOWY_GPU: `swiftshader` on Linux, Chromium's software Vulkan, with ANGLE and the
// compositor on it too, without which a canvas cannot be read back nor a frame imported as an
// external texture; `warp` on Windows, its own software Direct3D 11, the software adapter Chromium's WebGPU
// takes there.
const ARGS: Record<string, string[]> = {
  "": ["--enable-gpu", "--ignore-gpu-blocklist"],
  swiftshader: [
    "--enable-unsafe-webgpu",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--use-gl=angle",
    "--enable-features=Vulkan",
    "--use-vulkan=swiftshader",
  ],
  warp: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-webgpu-adapter=d3d11",
  ],
};
const gpu = process.env.SNOWY_GPU ?? "";
const args = ARGS[gpu];
if (!args) throw new Error(`SNOWY_GPU=${gpu}: not a GPU`);
const GPU: LaunchOptions = { args };
/** Whether WebGPU runs in software here (SNOWY_GPU), as on CI's Linux and Windows runners. */
export const SOFTWARE_GPU = gpu !== "";

// The fixtures of `expected` (test/fixtures/expected.json) Chromium decodes here. With WebGPU in
// software there is no hardware video decoder either, so no HEVC, which Chromium decodes only in
// hardware; macOS, on a GPU, tests it.
export function decodable<T extends { video?: { codec: string } }>(expected: Record<string, T>) {
  const entries = Object.entries(expected).filter(
    ([, e]) => !SOFTWARE_GPU || e.video?.codec !== "hevc",
  );
  return Object.fromEntries(entries);
}

/**
 * Whether Chromium draws slower than real time here: on CI's macOS runners, virtual machines
 * whose pages get 30 animation frames a second, video falls behind the clock (test/play.test.ts).
 * CI's Linux and Windows runners draw in software, in real time.
 */
export const SLOW_DRAWING = process.env.CI === "true" && process.platform === "darwin";

/** The machine the tests and benchmarks stand for: "" for this one, or "low-end". */
export const PROFILE = process.env.SNOWY_PROFILE ?? "";

if (PROFILE !== "" && PROFILE !== "low-end") {
  throw new Error(`SNOWY_PROFILE=${PROFILE}: not a profile`);
}

if (PROFILE === "low-end" && process.platform !== "darwin") {
  throw new Error("SNOWY_PROFILE=low-end needs a Mac with efficiency cores");
}

if (PROFILE === "low-end") {
  const levels = await $`sysctl -n hw.nperflevels`.text();
  // Efficiency cores to run on, apart from the performance cores.
  if (Number(levels) < 2)
    throw new Error("SNOWY_PROFILE=low-end needs a Mac with efficiency cores");
}

// The processes of `browser` that are running, with the CPU time each has used, in seconds.
async function processes(browser: Browser) {
  const session = await browser.newBrowserCDPSession();

  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    return processInfo;
  } finally {
    await session.detach();
  }
}

/**
 * The CPU time the processes of `browser` running now have used, in seconds. A process that
 * exits takes its time with it.
 */
export async function cpuTime(browser: Browser) {
  const running = await processes(browser);
  return running.reduce((sum, p) => sum + p.cpuTime, 0);
}

// Puts every renderer of `browser` on the efficiency cores at background priority, for CPU and
// I/O. The renderer runs the page and its workers, so all the engine's own work; the browser and
// GPU processes, which composite and drive the hardware decoders, keep their speed, as on a slow
// laptop.
async function confine(browser: Browser) {
  const running = await processes(browser);

  for (const p of running) {
    if (p.type !== "renderer") continue;
    const result = await $`taskpolicy -b -p ${p.id}`.nothrow().quiet();

    // One that exited since, as a renderer swapped out by a navigation, has nothing to confine.
    if (result.exitCode !== 0 && !result.stderr.toString().includes("No such process")) {
      throw new Error(`taskpolicy -b -p ${p.id}: ${result.stderr.toString()}`);
    }
  }
}

// Options replace the GPU ones: with them, Chromium keeps WebGPU on through
// --disable-features=WebGPU.
export async function launch(options: LaunchOptions = {}) {
  const browser = await chromium.launch({ ...GPU, ...options });
  if (PROFILE !== "low-end") return browser;
  // Confinements one after another; close waits for them, so a failure comes out there.
  const confined = { last: Promise.resolve() };

  // Confines once the confinement before has finished.
  function again() {
    const before = confined.last;

    confined.last = (async () => {
      await before;
      await confine(browser);
    })();

    return confined.last;
  }

  // From an event, which nothing awaits: a failure comes out at close, which awaits the last.
  async function later() {
    try {
      await again();
    } catch {
      // Kept in confined.last.
    }
  }

  function watch(context: BrowserContext) {
    // A page gets a renderer of its own, and a new one when it navigates to another site; a
    // service worker may get one too.
    context.on("page", (page) => {
      const goto = page.goto.bind(page);
      page.on("domcontentloaded", () => void later());

      // Confined before its caller runs anything in it.
      page.goto = async (...gotoArgs) => {
        const response = await goto(...gotoArgs);
        await again();
        return response;
      };
    });
    context.on("serviceworker", () => void later());
  }

  // browser.newPage makes its context with newContext too.
  const newContext = browser.newContext.bind(browser);

  browser.newContext = async (contextOptions) => {
    const context = await newContext(contextOptions);
    watch(context);
    return context;
  };

  const close = browser.close.bind(browser);

  browser.close = async (closeOptions) => {
    await confined.last;
    return close(closeOptions);
  };

  return browser;
}
