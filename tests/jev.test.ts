import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../src/core/config.js";
import { append } from "../src/core/ledger.js";
import { calibrate } from "../src/jev/calibrate.js";
import { jevFromEnv, parseAnswers, OPENROUTER_ENDPOINT, TYPESAFE_ENDPOINT } from "../src/jev/client.js";
import { deskTiming } from "../src/jev/desk.js";
import { consult } from "../src/jev/points.js";
import { SENSOR, TURN_END } from "../src/jev/questions.js";
import { Watcher } from "../src/watcher.js";
import { commitFile, sh, World } from "./helpers.js";

type Pick = (question: string, labels: string[]) => { choice: string; confidence: number } | undefined;

/** A fake Jev: answers each asked question with `pick`, or the first quiet label. */
function fakeJev(pick: Pick = () => undefined, calls: { url: string; body: any }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const answers = Object.fromEntries(Object.entries(body.questions as Record<string, { criteria: Record<string, string> }>).map(([q, spec]) => {
      const labels = Object.keys(spec.criteria);
      const chosen = pick(q, labels) ?? { choice: labels.includes("unsure") ? "unsure" : labels.at(-1)!, confidence: 0.9 };
      const rest = (1 - chosen.confidence) / (labels.length - 1);
      return [q, { type: "choice", choice: chosen.choice, confidence: chosen.confidence, probabilities: Object.fromEntries(labels.map((l) => [l, l === chosen.choice ? chosen.confidence : rest])) }];
    }));
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function configure(w: World, change: (c: Config) => void): Promise<void> {
  const c = defaultConfig("linux");
  change(c);
  await writeFile(join(w.home, "config.json"), JSON.stringify(c));
}

describe("the Jev client", () => {
  it("is off without a key, and picks the provider from the key", () => {
    expect(jevFromEnv({})).toBeNull();
    expect(jevFromEnv({ JEV_API_KEY: "k" })).toMatchObject({ provider: "typesafe", model: "jev-1.13.0" });
    expect(jevFromEnv({ OPENROUTER_API_KEY: "k" })).toMatchObject({ provider: "openrouter", model: "typesafe/jev-1.13" });
    expect(() => jevFromEnv({ JEV_API_KEY: "k", JEV_MODEL: "latest" })).toThrow(/pinned/);
  });

  it("sends typed questions to the right endpoint and validates answers", async () => {
    const calls: { url: string; body: any }[] = [];
    const jev = jevFromEnv({ OPENROUTER_API_KEY: "k" }, fakeJev(() => ({ choice: "stuck", confidence: 0.8 }), calls))!;
    const a = await jev.ask({ x: 1 }, TURN_END);
    expect(a?.turn_end_state).toMatchObject({ choice: "stuck", confidence: 0.8 });
    expect(calls[0]!.url).toBe(OPENROUTER_ENDPOINT);
    expect(calls[0]!.body.questions.turn_end_state.type).toBe("choice");
    const ts = jevFromEnv({ JEV_API_KEY: "k" }, fakeJev(undefined, calls))!;
    await ts.ask({}, TURN_END);
    expect(calls[1]!.url).toBe(TYPESAFE_ENDPOINT);
  });

  it("treats malformed answers, errors and timeouts as no answer", async () => {
    const q = { yes_no: { instructions: "i", criteria: { yes: "y", no: "n", unsure: "u" } } };
    expect(parseAnswers({ answers: { yes_no: { choice: "maybe", confidence: 0.9, probabilities: { maybe: 0.9, no: 0.1 } } } }, q)).toBeNull();
    expect(parseAnswers({ answers: { yes_no: { choice: "yes", confidence: 0.9, probabilities: { yes: 0.5, no: 0.2 } } } }, q)).toBeNull();
    expect(parseAnswers({ answers: { yes_no: { choice: "no", confidence: 0.6, probabilities: { yes: 0.6, no: 0.3, unsure: 0.1 } } } }, q)).toBeNull();
    expect(parseAnswers({ answers: {} }, q)).toBeNull();
    const failing = jevFromEnv({ JEV_API_KEY: "k" }, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)!;
    expect(await failing.ask({}, q)).toBeNull();
    const slow = jevFromEnv({ JEV_API_KEY: "k" }, ((_: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch, 50)!;
    expect(await slow.ask({}, q)).toBeNull();
  });
});

describe("decision points", () => {
  it("record every reading, ask once per subject, stay within the budget, and act only when calibrated and on", async () => {
    const w = await World.create();
    await w.slp(["start"]);
    const deps = { ...w.deps(null), env: { ...w.deps(null).env, JEV_API_KEY: "k" }, fetch: fakeJev(() => ({ choice: "yes", confidence: 0.9 })) };
    const config = defaultConfig("linux");
    const r1 = await consult(deps, w.project, config, "turn", "s1", {}, SENSOR);
    expect(r1?.trusted("goal_drift", "yes")).toBe(false); // shadow
    expect(await consult(deps, w.project, config, "turn", "s1", {}, SENSOR)).toBeNull(); // asked already
    config.jev.mode = "on";
    config.jev.thresholds["turn.goal_drift"] = 0.85;
    const r2 = await consult(deps, w.project, config, "turn", "s2", {}, SENSOR);
    expect(r2?.trusted("goal_drift", "yes")).toBe(true);
    expect(r2?.trusted("unsafe_action", "yes")).toBe(false); // no threshold
    config.jev.dailyCalls = 2;
    expect(await consult(deps, w.project, config, "turn", "s3", {}, SENSOR)).toBeNull();
    config.jev.mode = "off";
    config.jev.dailyCalls = 300;
    expect(await consult(deps, w.project, config, "turn", "s4", {}, SENSOR)).toBeNull();
    expect((await w.state()).incidents).toEqual([]);
  });
});

describe("turn ends (catalogue 9)", () => {
  const LANE = ["open-lane", "--title", "Greeting", "--outcome", "greets", "--accept", "a", "--write", "src/**"];

  async function peerWorking(w: World): Promise<string> {
    await w.slp(["start"]);
    w.cli.idleAll();
    await w.as("sup", LANE);
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "a", "--goal", "g", "--accept", "x", "--own", "src/a/**"]);
    const peer = await w.pane("L1-T1");
    w.cli.agents.get(peer)!.status = "working";
    return peer;
  }

  it("without Jev: one nudge after a quiet turn end, then the Lead", async () => {
    const w = await World.create();
    const peer = await peerWorking(w);
    let now = Date.now();
    const watcher = new Watcher(w.deps(null, () => now), w.project);
    await watcher.tick(); // sees it working
    w.cli.agents.get(peer)!.status = "idle";
    await watcher.tick(); // the turn ended
    const before = w.cli.promptsTo(peer).length;
    now += deskTiming.nudgeMs + 1;
    await watcher.tick();
    expect(w.cli.promptsTo(peer).at(-1)).toMatch(/\[SLP NUDGE[\s\S]*without handing L1-T1 back/);
    expect(w.cli.promptsTo(peer).length).toBe(before + 1);
    w.cli.idleAll();
    now += deskTiming.escalateMs;
    await watcher.tick();
    await watcher.tick();
    expect((await w.inbox("L1")).at(-1)).toMatch(/L1-T1 has been idle \d+ min without handing L1-T1 back/);
    expect(w.cli.promptsTo(peer).filter((p) => p.includes("NUDGE"))).toHaveLength(1);
  });

  it("with Jev calibrated: a finished-but-unreported turn is nudged at once; shadow readings stay unmailed", async () => {
    const w = await World.create();
    await configure(w, (c) => { c.watch.mail = true; c.jev.mode = "on"; c.jev.thresholds["turn.turn_end_state"] = 0.8; });
    w.env = { JEV_API_KEY: "k" };
    w.fetch = fakeJev((q) => (q === "turn_end_state" ? { choice: "finished_unreported", confidence: 0.92 } : q === "goal_drift" ? { choice: "yes", confidence: 0.7 } : undefined));
    const peer = await peerWorking(w);
    const watcher = new Watcher(w.deps(null), w.project);
    await watcher.tick();
    w.cli.agents.get(peer)!.status = "idle";
    await watcher.tick();
    expect(w.cli.promptsTo(peer).at(-1)).toContain("[SLP NUDGE");
    const s = await w.state();
    const drift = s.incidents.find((i) => i.fact === "jev:turn.goal_drift")!;
    expect(drift).toMatchObject({ level: "note", to: "L1" });
    expect(s.letters.some((l) => l.letter === "INCIDENT")).toBe(false);
  });
});

describe("calibration", () => {
  it("sets thresholds from marks, within the budget, and only with enough of them", () => {
    const events: any[] = [];
    let seq = 0;
    const at = (d: number) => new Date(Date.UTC(2026, 8, 1 + d)).toISOString();
    const reading = (subject: string, confidence: number, verdict: "useful" | "noise" | null, d: number) => {
      events.push({ kind: "jev", seq: ++seq, ts: at(d), point: "turn", subject, mode: "shadow", answers: { goal_drift: { choice: "yes", confidence } }, acted: false });
      const id = `I${seq}`;
      events.push({ kind: "incident", seq: ++seq, ts: at(d), incident: id, key: `jev:turn.goal_drift:${subject}`, seat: "L1-T1", fact: "jev:turn.goal_drift", level: "note", text: "", to: "L1" });
      if (verdict) events.push({ kind: "ack", seq: ++seq, ts: at(d), incident: id, by: "L1", verdict, note: "" });
    };
    [[0.95, "useful"], [0.9, "useful"], [0.88, "useful"], [0.7, "noise"], [0.65, "noise"], [0.6, "useful"], [0.55, "noise"]]
      .forEach(([c, v], i) => reading(`s${i}`, c as number, v as "useful" | "noise", i));
    const [r] = calibrate(events, 20);
    expect(r).toMatchObject({ key: "turn.goal_drift", useful: 4, noise: 3, threshold: 0.88 });
    expect(r!.separation).toBeGreaterThan(0);
    expect(calibrate(events.slice(0, 9), 20)[0]).toMatchObject({ threshold: null, reason: expect.stringMatching(/more mark/) });
    expect(calibrate(events, 0.1)[0]!.threshold).toBeNull();
    // Only useful marks: nothing to tell apart.
    events.length = 0;
    [0.95, 0.9, 0.88, 0.8, 0.7, 0.6].forEach((c, i) => reading(`u${i}`, c, "useful", i));
    expect(calibrate(events, 20)[0]).toMatchObject({ threshold: null, reason: expect.stringMatching(/noise mark/) });
  });

  it("slp calibrate saves them; the Human can list and mark incidents", async () => {
    const w = await World.create();
    await w.slp(["start"]);
    const env = { SLP_HOME: w.home };
    for (let i = 0; i < 7; i++) {
      const confidence = i < 5 ? 0.9 : 0.6;
      await append(env, w.project, () => ({ kind: "jev" as const, point: "turn", subject: `s${i}`, mode: "shadow" as const, answers: { stuck_q: { choice: "yes", confidence } }, acted: false }));
      await append(env, w.project, () => ({ kind: "incident" as const, incident: `I${i + 1}`, key: `jev:turn.stuck_q:s${i}`, seat: "sup", fact: "jev:turn.stuck_q", level: "note" as const, text: "t", to: null }));
    }
    expect(await w.slp(["incidents"], null)).toBe(0);
    expect(w.out.at(-1)).toContain("I7 [note] sup");
    for (let i = 1; i <= 7; i++) expect(await w.slp(["ack", `I${i}`, i <= 5 ? "useful" : "noise"], null)).toBe(0);
    expect((await w.state()).acks.every((a) => a.by === "human")).toBe(true);
    expect(await w.slp(["calibrate"], null)).toBe(0);
    const saved = JSON.parse(await readFile(join(w.home, "config.json"), "utf8")) as Config;
    expect(saved.jev.thresholds["turn.stuck_q"]).toBe(0.9);
    await expect(w.as("sup", ["calibrate"])).rejects.toThrow(/Human's command/);
  });
});

describe("landing holds (catalogue 6, 16)", () => {
  it("holds a high-risk lane until it is reviewed, and a destructive migration until the Human agrees", async () => {
    const w = await World.create();
    await w.slp(["start"]);
    w.cli.idleAll();
    await w.as("sup", ["open-lane", "--title", "Password reset", "--outcome", "users reset their password", "--accept", "a", "--write", "db/**"]);
    expect((await w.inbox("L1"))[0]).toContain("High-risk lane");
    w.cli.idleAll();
    await w.as("L1", ["start-task", "--title", "m", "--goal", "g", "--accept", "a", "--own", "db/**"]);
    await commitFile(w.repo, "db/migrations/002.sql", "ALTER TABLE users DROP COLUMN legacy;\n");
    w.cli.idleAll();
    await w.as("L1-T1", ["done", "complete", "--check", "ok", "done"]);
    await w.as("L1", ["accept", "L1-T1"]);
    await w.as("sup", ["close-lane", "L1", "--land"]);
    await w.slp(["watch", "--once", "--project", w.project]);
    const held = (await w.inbox("sup")).at(-1)!;
    expect(held).toMatch(/held for the Human: it is a high-risk lane[\s\S]*changes migrations[\s\S]*destructive SQL/);
    expect(w.cli.notifications.some((n) => n.title.includes("L1 held for you"))).toBe(true);
    expect((await w.state()).lanes.get("L1")!.open).toBe(true);
    w.cli.idleAll();
    await expect(w.as("sup", ["close-lane", "L1", "--land", "--over-risk"])).rejects.toThrow(/--reason/);
    // The Supervisor cannot lift a hold on its own: the Human must have spoken since.
    await expect(w.as("sup", ["close-lane", "L1", "--land", "--over-risk", "--reason", "the Human agreed"])).rejects.toThrow(/no words from the Human since L1 was held/);
    const sup = (await w.state()).seats.get("sup")!;
    const dir = join(w.home, "claude", "projects", "p");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sup.sessionId}.jsonl`), JSON.stringify({ type: "user", timestamp: new Date(Date.now() + 1000).toISOString(), message: { content: "yes, land it: the legacy column is unused" } }) + "\n");
    await w.as("sup", ["close-lane", "L1", "--land", "--over-risk", "--reason", "the Human agreed: legacy column is unused"]);
    await w.slp(["watch", "--once", "--project", w.project]);
    expect((await w.state()).lanes.get("L1")!.landed).toBe(true);
    expect(sh(w.repo, "log", "-1", "--format=%s", "main")).toBe("Password reset");
    expect(sh(w.repo, "log", "-1", "--format=%b", "main")).toContain("> yes, land it: the legacy column is unused");
  });
});
