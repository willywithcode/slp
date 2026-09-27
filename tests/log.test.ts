import { appendFile, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, appendEvent, eventsPath, lockTiming, nextCaseId, readEvents, releaseLock } from "../src/log.js";
import { tempHome } from "./helpers.js";

/** An env whose room directory exists, as `slp up` would leave it. */
async function roomEnv() {
  const home = await tempHome();
  await mkdir(join(home, "rooms", "demo"), { recursive: true });
  return { SLP_HOME: home };
}

const draft = (text: string) => (events: unknown[]) =>
  ({ kind: "brief" as const, case: `c${events.length + 1}`, from: "lead", to: "p1", text });

describe("event log", () => {
  it("assigns gap-free sequence numbers under concurrent appends", async () => {
    const env = await roomEnv();
    await Promise.all(Array.from({ length: 25 }, (_, i) => appendEvent(env, "demo", draft(`m${i}`))));
    const events = await readEvents(env, "demo");
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(events.map((e) => (e.kind === "brief" ? e.case : ""))).size).toBe(25);
  });

  it("skips a torn trailing line instead of failing", async () => {
    const env = await roomEnv();
    await appendEvent(env, "demo", draft("ok"));
    await appendFile(eventsPath(env, "demo"), '{"kind":"brief","seq":2,"ts":"x","ca');
    expect((await readEvents(env, "demo")).map((e) => e.seq)).toEqual([1]);
  });

  it("does not write an event when validation inside the lock throws", async () => {
    const env = await roomEnv();
    await expect(appendEvent(env, "demo", () => { throw new Error("nope"); })).rejects.toThrow("nope");
    expect(await readEvents(env, "demo")).toEqual([]);
    await appendEvent(env, "demo", draft("after")); // lock was released
  });

  it("numbers cases from briefs only", () => {
    expect(nextCaseId([])).toBe("c1");
  });
});

describe("room lock", () => {
  const lockDir = (home: string) => join(home, "rooms", "demo", "events.lock");
  async function plantLock(home: string, owner: object | null, ageMs = 0) {
    await mkdir(lockDir(home), { recursive: true });
    if (owner) await writeFile(join(lockDir(home), "owner.json"), JSON.stringify(owner));
    if (ageMs) { const t = new Date(Date.now() - ageMs); await utimes(lockDir(home), t, t); }
  }

  it("reclaims a lock whose owner process is dead", async () => {
    const home = await tempHome();
    await plantLock(home, { token: "dead", pid: 2 ** 22 + 12345, host: hostname(), at: Date.now() });
    await appendEvent({ SLP_HOME: home }, "demo", draft("after crash"));
    expect(await readEvents({ SLP_HOME: home }, "demo")).toHaveLength(1);
  });

  it("never takes a lock from a live owner, however old", async () => {
    const home = await tempHome();
    await plantLock(home, { token: "live", pid: process.pid, host: hostname(), at: Date.now() - 3_600_000 }, 3_600_000);
    lockTiming.timeoutMs = 300;
    try {
      await expect(appendEvent({ SLP_HOME: home }, "demo", draft("x"))).rejects.toThrow(new RegExp(`held by pid ${process.pid}`));
    } finally {
      lockTiming.timeoutMs = 10_000;
    }
    expect(await readFile(join(lockDir(home), "owner.json"), "utf8")).toContain('"live"');
  });

  it("reclaims an ownerless lock only once it is old", async () => {
    const home = await tempHome();
    await plantLock(home, null, 60_000);
    await appendEvent({ SLP_HOME: home }, "demo", draft("x"));
    expect(await readEvents({ SLP_HOME: home }, "demo")).toHaveLength(1);
  });

  it("keeps later events after a torn trailing line", async () => {
    const env = await roomEnv();
    await appendEvent(env, "demo", draft("one"));
    await appendFile(eventsPath(env, "demo"), '{"kind":"brief","seq":2,"ts":"x","ca');
    await appendEvent(env, "demo", draft("two"));
    await appendEvent(env, "demo", draft("three"));
    expect((await readEvents(env, "demo")).map((e) => e.kind === "brief" && e.text)).toEqual(["one", "two", "three"]);
  });
});

describe("lock release and guard", () => {
  it("releasing a lock whose room was just archived is not an error", async () => {
    const env = await roomEnv();
    const lock = join(env.SLP_HOME, "rooms", "demo", "events.lock");
    const token = await acquireLock(lock);
    await rm(join(env.SLP_HOME, "rooms", "demo"), { recursive: true });
    await expect(releaseLock(lock, token)).resolves.toBeUndefined();
  });

  it("clears a reclaim guard left by a dead process without waiting for it to age", async () => {
    const env = await roomEnv();
    const dir = join(env.SLP_HOME, "rooms", "demo");
    await mkdir(join(dir, "events.lock"));
    await writeFile(join(dir, "events.lock", "owner.json"), JSON.stringify({ token: "dead", pid: 2 ** 22 + 12345, host: hostname(), at: Date.now() }));
    await mkdir(join(dir, "events.lock.reclaim"));
    await writeFile(join(dir, "events.lock.reclaim", "owner.json"), JSON.stringify({ token: "g", pid: 2 ** 22 + 12346, host: hostname(), at: Date.now() }));
    lockTiming.timeoutMs = 2_000;
    try {
      await appendEvent(env, "demo", draft("after dead reclaimer"));
    } finally {
      lockTiming.timeoutMs = 10_000;
    }
    expect(await readEvents(env, "demo")).toHaveLength(1);
  });

  it("never removes a reclaim guard held by a live process, however old", async () => {
    const env = await roomEnv();
    const dir = join(env.SLP_HOME, "rooms", "demo");
    await mkdir(join(dir, "events.lock"));
    await writeFile(join(dir, "events.lock", "owner.json"), JSON.stringify({ token: "dead", pid: 2 ** 22 + 12345, host: hostname(), at: Date.now() }));
    await mkdir(join(dir, "events.lock.reclaim"));
    await writeFile(join(dir, "events.lock.reclaim", "owner.json"), JSON.stringify({ token: "live", pid: process.pid, host: hostname(), at: Date.now() - 3_600_000 }));
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(dir, "events.lock.reclaim"), old, old);
    lockTiming.timeoutMs = 300;
    try {
      await expect(appendEvent(env, "demo", draft("x"))).rejects.toThrow(/Timed out/);
    } finally {
      lockTiming.timeoutMs = 10_000;
    }
    expect(await readFile(join(dir, "events.lock.reclaim", "owner.json"), "utf8")).toContain('"live"');
  });
});
