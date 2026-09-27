import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import * as cmd from "../src/commands.js";
import { Herdr } from "../src/herdr.js";
import { MAX_ASSESSMENTS_PER_PASS } from "../src/watcher.js";
import { readEvents, type SplEvent } from "../src/log.js";
import { deps, FakeHerdrCli, tempHome } from "./helpers.js";

type Choice3 = "satisfied" | "drift" | "unknown";
type Choice4 = "handled" | "pending" | "drift" | "unknown";

/** A schema-valid Jev response: the chosen option gets `p`, the rest share the remainder. */
function jevResponse(brief: Choice3, peer: Choice3, handling: Choice4, p = 0.97) {
  const answer = (choice: string, options: string[]) => {
    const rest = (1 - p) / (options.length - 1);
    return { type: "choice", choice, confidence: p, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? p : rest])) };
  };
  return {
    model: "jev-1.13.0",
    answers: {
      leadBrief: answer(brief, ["satisfied", "drift", "unknown"]),
      peerResponse: answer(peer, ["satisfied", "drift", "unknown"]),
      leadHandling: answer(handling, ["handled", "pending", "drift", "unknown"]),
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

async function setup(env: Record<string, string> = { JEV_API_KEY: "test-key" }) {
  const home = await tempHome();
  const cli = new FakeHerdrCli();
  const room = await cmd.up(deps(home, undefined, cli), { room: "demo", cwd: home, lead: "claude", peers: ["codex", "codex"], supervisor: "claude" });
  for (const m of Object.values(room.members)) cli.agents.set(m.paneId, { status: "working", seq: 1, kind: m.kind });
  const requests: { url: string; body: any; auth: string | null; notificationsSoFar: number }[] = [];
  const replies: unknown[] = [];
  const fetchFake = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization"), notificationsSoFar: cli.notifications.length });
    await cli.onFetch?.();
    const next = replies.shift() ?? (cli.onFetch ? jevResponse("satisfied", "drift", "pending") : undefined);
    return next === undefined ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(next));
  }) as unknown as typeof fetch;
  const d = { herdr: new Herdr(cli.exec, "herdr"), out: () => undefined, now: () => Date.now(), fetch: fetchFake };
  const as = (m: string) => deps(home, room.members[m]!.paneId, cli);
  const watch = (...flags: string[]) => main(["watch", "--once", "--room", "demo", ...flags], { SLP_HOME: home, ...env }, d);
  const events = async () => readEvents({ SLP_HOME: home }, "demo");
  return { cli, room, requests, replies, as, watch, events };
}

const kinds = (events: SplEvent[], kind: SplEvent["kind"]) => events.filter((e) => e.kind === kind);

describe("slp watch with Jev", () => {
  it("is off by default even when JEV_API_KEY is set (ADR 0005)", async () => {
    const { as, watch, requests, events } = await setup();
    await cmd.send(as("lead"), undefined, "p1", "brief");
    await cmd.handback(as("p1"), undefined, "c1", "handback");
    expect(await watch()).toBe(0);
    expect(requests).toEqual([]);
    expect(kinds(await events(), "assessment")).toEqual([]);
  });

  it("refuses to run Jev without a key or with an unpinned model", async () => {
    await expect((await setup({})).watch("--jev", "shadow")).rejects.toThrow(/JEV_API_KEY/);
    await expect((await setup({ JEV_API_KEY: "k", JEV_MODEL: "jev-latest" })).watch("--jev", "shadow")).rejects.toThrow(/JEV_MODEL/);
  });

  it("waits for a handback, then sends the case evidence once per new message (shadow: record only)", async () => {
    const { as, watch, requests, replies, events, cli } = await setup();
    await cmd.send(as("lead"), undefined, "p1", "Fix login; scope src/auth; evidence: npm test");
    await watch("--jev", "shadow");
    expect(requests).toEqual([]); // nothing to judge before a handback

    await cmd.handback(as("p1"), undefined, "c1", "Done, tests pass");
    replies.push(jevResponse("satisfied", "drift", "pending"));
    cli.prompts = [];
    await watch("--jev", "shadow");
    await watch("--jev", "shadow"); // same evidence: not sent again

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(requests[0]!.auth).toBe("Bearer test-key");
    expect(requests[0]!.body.model).toBe("jev-1.13.0");
    expect(requests[0]!.body.state).toMatchObject({
      case: "c1", leadId: "lead", peerId: "p1",
      brief: "Fix login; scope src/auth; evidence: npm test", handback: "Done, tests pass",
      roomMessages: [], uncertainRoomMessages: [], incompleteCommunication: false,
    });
    const [assessment] = kinds(await events(), "assessment");
    expect(assessment).toMatchObject({ case: "c1", upTo: 3, verdict: "drift", mode: "shadow" });
    expect(kinds(await events(), "alert")).toEqual([]);
    expect(cli.prompts).toEqual([]);
  });

  it("alert mode raises one jev-drift alert to the supervisor per assessed state", async () => {
    const { as, watch, replies, events, cli, room } = await setup();
    await cmd.send(as("lead"), undefined, "p1", "brief");
    await cmd.handback(as("p1"), undefined, "c1", "done");
    replies.push(jevResponse("satisfied", "drift", "pending"));
    cli.prompts = [];
    await watch("--jev", "alert");
    await watch("--jev", "alert");
    const alerts = kinds(await events(), "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: "jev-drift", case: "c1", key: "jev:c1:3" });
    expect(cli.prompts.map((p) => p.target)).toEqual([room.members.sup!.paneId]);
    expect(cli.prompts[0]!.text).toContain("peerResponse: drift");
  });

  it("re-assesses when the lead replies, passing replies after the handback as roomMessages", async () => {
    const { as, watch, requests, replies, events } = await setup();
    await cmd.send(as("lead"), undefined, "p1", "implement");
    await cmd.handback(as("p1"), undefined, "c1", "implemented");
    replies.push(jevResponse("satisfied", "satisfied", "pending"));
    await watch("--jev", "alert");
    const reply = await cmd.reply(as("lead"), undefined, "c1", "p2", "Accepted; p2 please review src/auth");
    replies.push(jevResponse("satisfied", "satisfied", "handled"));
    await watch("--jev", "alert");

    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.state.roomMessages).toEqual([{ seq: reply.seq, from: "lead", to: "p2", text: "Accepted; p2 please review src/auth" }]);
    expect(kinds(await events(), "assessment").map((a) => a.kind === "assessment" && a.verdict)).toEqual(["unknown", "handled"]);
    expect(kinds(await events(), "alert")).toEqual([]);
  });

  it("judges the latest handback against the message it answers", async () => {
    const { as, watch, requests, replies } = await setup();
    await cmd.send(as("lead"), undefined, "p1", "implement");
    await cmd.handback(as("p1"), undefined, "c1", "implemented");
    await cmd.reply(as("lead"), undefined, "c1", "p2", "review it");
    await cmd.handback(as("p2"), undefined, "c1", "review findings");
    replies.push(jevResponse("satisfied", "satisfied", "pending"));
    await watch("--jev", "shadow");
    expect(requests[0]!.body.state).toMatchObject({ peerId: "p2", brief: "review it", handback: "review findings", roomMessages: [] });
  });

  it("records a failed request as unknown and does not retry it", async () => {
    const { as, watch, requests, events } = await setup();
    await cmd.send(as("lead"), undefined, "p1", "brief");
    await cmd.handback(as("p1"), undefined, "c1", "done");
    await watch("--jev", "alert"); // fake returns HTTP 500
    await watch("--jev", "alert");
    expect(requests).toHaveLength(1);
    expect(kinds(await events(), "assessment")).toMatchObject([{ verdict: "unknown", answers: null }]);
  });
});

describe("slp watch with Jev: round-2 safeguards", () => {
  it("delivers pending alerts before spending time on Jev", async () => {
    const { as, watch, requests, replies, cli, room } = await setup();
    await cmd.send(as("lead"), undefined, "p1", "brief");
    await cmd.handback(as("p1"), undefined, "c1", "done");
    cli.agents.delete(room.members.p2!.paneId); // member-gone alert this pass
    replies.push(jevResponse("satisfied", "satisfied", "pending"));
    await watch("--jev", "shadow");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.notificationsSoFar).toBe(1);
  });

  it(`assesses at most ${MAX_ASSESSMENTS_PER_PASS} cases per pass`, async () => {
    const { as, watch, requests } = await setup();
    for (let i = 1; i <= MAX_ASSESSMENTS_PER_PASS + 1; i++) {
      await cmd.send(as("lead"), undefined, "p1", `brief ${i}`);
      await cmd.handback(as("p1"), undefined, `c${i}`, `done ${i}`);
    }
    await watch("--jev", "shadow");
    expect(requests).toHaveLength(MAX_ASSESSMENTS_PER_PASS);
    await watch("--jev", "shadow");
    expect(requests).toHaveLength(MAX_ASSESSMENTS_PER_PASS + 1);
  });

  it("alerts on a recorded drift for the current state that has no alert yet (shadow, then alert)", async () => {
    const { as, watch, requests, replies, events } = await setup();
    await cmd.send(as("lead"), undefined, "p1", "brief");
    await cmd.handback(as("p1"), undefined, "c1", "done");
    replies.push(jevResponse("satisfied", "drift", "pending"));
    await watch("--jev", "shadow");
    await watch("--jev", "alert");
    await watch("--jev", "alert");
    expect(requests).toHaveLength(1); // no new Jev request for the same state
    expect(kinds(await events(), "alert")).toMatchObject([{ rule: "jev-drift", key: "jev:c1:3" }]);
  });
});

describe("slp watch with Jev: round-3 safeguards", () => {
  it("serves the oldest pending state first, so busy cases cannot starve others", async () => {
    const { as, watch, requests, replies } = await setup();
    const cases = MAX_ASSESSMENTS_PER_PASS + 1;
    for (let i = 1; i <= cases; i++) {
      await cmd.send(as("lead"), undefined, "p1", `brief ${i}`);
      await cmd.handback(as("p1"), undefined, `c${i}`, `done ${i}`);
    }
    for (let i = 0; i < cases * 3; i++) replies.push(jevResponse("satisfied", "satisfied", "pending"));
    await watch("--jev", "shadow");
    // The first cases keep changing before every pass.
    for (let i = 1; i < cases; i++) await cmd.reply(as("lead"), undefined, `c${i}`, "p1", `more ${i}`);
    await watch("--jev", "shadow");
    expect(requests.slice(MAX_ASSESSMENTS_PER_PASS).map((r) => r.body.state.case)).toContain(`c${cases}`);
  });

  it("does not raise a drift alert for a state that changed while Jev was answering", async () => {
    const { as, watch, events, cli } = await setup();
    await cmd.send(as("lead"), undefined, "p1", "brief");
    await cmd.handback(as("p1"), undefined, "c1", "done");
    cli.onFetch = async () => { await cmd.reply(as("lead"), undefined, "c1", "p1", "fix the tests first"); };
    await watch("--jev", "alert");
    expect(kinds(await events(), "alert")).toEqual([]);
  });
});
