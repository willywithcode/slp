import { describe, expect, it } from "vitest";
import type { SplEvent } from "../src/log.js";
import type { Room } from "../src/room.js";
import { DEFAULT_WATCH, evaluate, type Observation } from "../src/watch.js";

const MIN = 60_000;
const T0 = Date.parse("2026-09-26T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const room: Room = {
  version: 1, name: "demo", cwd: "/work", workspaceId: "w9", createdAt: at(0),
  members: {
    lead: { role: "lead", kind: "claude", herdrName: "demo-lead", paneId: "w9:p1" },
    p1: { role: "peer", kind: "codex", herdrName: "demo-p1", paneId: "w9:p2" },
    p2: { role: "peer", kind: "codex", herdrName: "demo-p2", paneId: "w9:p3" },
    sup: { role: "supervisor", kind: "claude", herdrName: "demo-sup", paneId: "w9:p4" },
  },
};

/** Build a log where every message is delivered 1s after it is recorded, unless listed in `undelivered`. */
function log(messages: [kind: "brief" | "handback" | "reply" | "close", caseId: string, from: string, to: string, atMs: number][], undelivered: number[] = []): SplEvent[] {
  const events: SplEvent[] = [];
  let seq = 0;
  for (const [kind, caseId, from, to, t] of messages) {
    const ref = ++seq;
    events.push(kind === "close"
      ? { kind: "reply", closes: true, seq: ref, ts: at(t), case: caseId, from, to, text: "accepted, closing" }
      : { kind, seq: ref, ts: at(t), case: caseId, from, to, text: `${kind} text` });
    if (!undelivered.includes(ref)) events.push({ kind: "delivery", seq: ++seq, ts: at(t + 1000), ref, ok: true, error: null });
  }
  return events;
}

const obs = (status: Observation["status"], sinceMs: number, stateChangeSeq = 1): Observation => ({ status, stateChangeSeq, since: T0 + sinceMs });
const allIdle = (sinceMs = 0): Record<string, Observation> =>
  Object.fromEntries(Object.keys(room.members).map((m) => [m, obs("idle", sinceMs)]));
const run = (events: SplEvent[], observed: Record<string, Observation>, nowMs: number) =>
  evaluate({ room, events, observed, now: T0 + nowMs }, DEFAULT_WATCH);

describe("peer idle without handback", () => {
  const briefed = log([["brief", "c1", "lead", "p1", 0]]);

  it("alerts once the briefed peer has been idle for 3 minutes, counted from the later of delivery and state change", () => {
    // Delivered at 1s; p1 went done at 30s, so the 3 minutes start at 30s.
    const observed = { ...allIdle(), p1: obs("done", 30_000) };
    expect(run(briefed, observed, 30_000 + 3 * MIN)).toEqual([]);
    const alerts = run(briefed, observed, 30_000 + 3 * MIN + 1);
    expect(alerts.map((a) => [a.rule, a.case, a.member])).toEqual([["peer-idle-without-handback", "c1", "p1"]]);
    expect(alerts[0]!.text).toContain("spl log c1");
  });

  it("does not alert while the peer is working or after it handed back", () => {
    expect(run(briefed, { ...allIdle(), p1: obs("working", 0) }, 30 * MIN)).toEqual([]);
    const handedBack = log([["brief", "c1", "lead", "p1", 0], ["handback", "c1", "p1", "lead", MIN]]);
    expect(run(handedBack, { ...allIdle(), lead: obs("working", 0) }, 30 * MIN)).toEqual([]);
  });

  it("re-arms for a reply addressed to a peer, which again owes a handback", () => {
    const events = log([["brief", "c1", "lead", "p1", 0], ["handback", "c1", "p1", "lead", MIN], ["reply", "c1", "lead", "p2", 2 * MIN]]);
    const alerts = run(events, allIdle(), 6 * MIN);
    expect(alerts.map((a) => [a.rule, a.member])).toEqual([["peer-idle-without-handback", "p2"]]);
  });

  it("tracks each addressed peer: a later handback by one peer does not hide another's", () => {
    // Lead asks p2 to review; p1 then sends a correction. p2 still owes a handback.
    const events = log([
      ["brief", "c1", "lead", "p1", 0], ["handback", "c1", "p1", "lead", MIN],
      ["reply", "c1", "lead", "p2", 2 * MIN], ["handback", "c1", "p1", "lead", 3 * MIN],
    ]);
    const alerts = run(events, { ...allIdle(), lead: obs("working", 0) }, 2 * MIN + 1000 + 3 * MIN + 1);
    expect(alerts.map((a) => [a.rule, a.member, a.key])).toEqual([["peer-idle-without-handback", "p2", "peer-idle:c1:5"]]);
  });

  it("asks the lead to disposition a handback that arrived after its last message", () => {
    const events = log([
      ["brief", "c1", "lead", "p1", 0], ["handback", "c1", "p1", "lead", MIN],
      ["reply", "c1", "lead", "p2", 2 * MIN], ["handback", "c1", "p1", "lead", 3 * MIN],
    ]);
    const observed = { ...allIdle(), p2: obs("working", 0) };
    const alerts = run(events, observed, 3 * MIN + 1000 + 10 * MIN + 1);
    expect(alerts.map((a) => [a.rule, a.member, a.key])).toEqual([["lead-no-disposition", "lead", "lead-idle:c1:7"]]);
  });

  it("fires once per trigger: an alert event with the same key suppresses it", () => {
    const [alert] = run(briefed, allIdle(), 10 * MIN);
    const recorded: SplEvent[] = [...briefed, { kind: "alert", seq: 99, ts: at(10 * MIN), key: alert!.key, rule: alert!.rule, case: alert!.case, member: alert!.member, text: alert!.text }];
    expect(run(recorded, allIdle(), 20 * MIN)).toEqual([]);
  });
});

describe("member blocked on a dialog", () => {
  it("alerts after 3 minutes blocked, once per Herdr state episode", () => {
    const observed = { ...allIdle(), lead: obs("blocked", MIN, 7) };
    expect(run([], observed, 4 * MIN)).toEqual([]);
    const [alert] = run([], observed, 4 * MIN + 1);
    expect([alert!.rule, alert!.member, alert!.case, alert!.key]).toEqual(["blocked", "lead", null, "blocked:lead:7"]);
    // A new blocked episode (new state_change_seq) is a new trigger.
    expect(run([], { ...allIdle(), lead: obs("blocked", 10 * MIN, 9) }, 13 * MIN + 1)[0]!.key).toBe("blocked:lead:9");
  });
});

describe("handback without disposition", () => {
  const handedBack = log([["brief", "c1", "lead", "p1", 0], ["handback", "c1", "p1", "lead", MIN]]);

  it("alerts when the lead stays idle for 10 minutes after the handback is delivered", () => {
    const observed = allIdle(); // delivered at 1 min + 1 s
    expect(run(handedBack, observed, MIN + 1000 + 10 * MIN)).toEqual([]);
    const alerts = run(handedBack, observed, MIN + 1000 + 10 * MIN + 1);
    expect(alerts.map((a) => [a.rule, a.case, a.member, a.key])).toEqual([["lead-no-disposition", "c1", "lead", "lead-idle:c1:3"]]);
  });

  it("stays silent while the lead is working, and once the lead replied", () => {
    expect(run(handedBack, { ...allIdle(), lead: obs("working", 0) }, 60 * MIN)).toEqual([]);
    const replied = log([["brief", "c1", "lead", "p1", 0], ["handback", "c1", "p1", "lead", MIN], ["reply", "c1", "lead", "p1", 2 * MIN]]);
    expect(run(replied, { ...allIdle(), p1: obs("working", 0) }, 60 * MIN)).toEqual([]);
  });
});

describe("undelivered message", () => {
  it("alerts 3 minutes after a message was recorded without a successful delivery", () => {
    const events = log([["brief", "c1", "lead", "p1", 0]], [1]);
    const observed = { ...allIdle(), p1: obs("working", 0) };
    expect(run(events, observed, 3 * MIN)).toEqual([]);
    const alerts = run(events, observed, 3 * MIN + 1);
    expect(alerts.map((a) => [a.rule, a.case, a.member, a.key])).toEqual([["undelivered", "c1", "p1", "undelivered:1"]]);
    expect(alerts[0]!.text).toContain("delivery outcome is unknown");
    expect(alerts[0]!.text).toContain("spl redeliver --force 1");
  });

  it("tells the sender to fix the cause when Herdr refused the delivery", () => {
    const events: SplEvent[] = [...log([["brief", "c1", "lead", "p1", 0]], [1]), { kind: "delivery", seq: 2, ts: at(1000), ref: 1, ok: false, error: "agent_blocked" }];
    const [alert] = run(events, { ...allIdle(), p1: obs("working", 0) }, 4 * MIN);
    expect(alert!.text).toContain("delivery failed (agent_blocked)");
    expect(alert!.text).toContain("spl redeliver 1");
  });

  it("is satisfied by a later successful redelivery", () => {
    const events: SplEvent[] = [
      ...log([["brief", "c1", "lead", "p1", 0]], [1]),
      { kind: "delivery", seq: 2, ts: at(1000), ref: 1, ok: false, error: "agent_blocked" },
      { kind: "delivery", seq: 3, ts: at(2 * MIN), ref: 1, ok: true, error: null },
    ];
    expect(run(events, { ...allIdle(), p1: obs("working", 0) }, 30 * MIN)).toEqual([]);
  });
});

describe("member gone", () => {
  it("alerts immediately when a member's pane no longer hosts its agent, once per disappearance", () => {
    const observed = { ...allIdle(), p2: obs("gone", 5 * MIN, 0) };
    const alerts = run([], { ...observed, p2: { status: "gone", stateChangeSeq: null, since: T0 + 5 * MIN } }, 5 * MIN);
    expect(alerts.map((a) => [a.rule, a.member, a.key])).toEqual([["member-gone", "p2", `gone:p2:${T0 + 5 * MIN}`]]);
    expect(alerts[0]!.text).toContain("w9:p3");
  });
});

describe("episodes without a Herdr state_change_seq", () => {
  it("keys blocked alerts by the observed start, so each episode still fires", () => {
    const first = run([], { ...allIdle(), lead: { status: "blocked", stateChangeSeq: null, since: T0 } }, 4 * MIN);
    const second = run([], { ...allIdle(), lead: { status: "blocked", stateChangeSeq: null, since: T0 + 10 * MIN } }, 14 * MIN);
    expect(first[0]!.key).not.toBe(second[0]!.key);
  });
});

describe("several pending handbacks", () => {
  it("does not let a newer, undelivered handback hide an older delivered one", () => {
    const events = log([
      ["brief", "c1", "lead", "p1", 0], ["reply", "c1", "lead", "p2", 0],
      ["handback", "c1", "p1", "lead", MIN], ["handback", "c1", "p2", "lead", 2 * MIN],
    ], [7]);
    const alerts = run(events, { ...allIdle(), p1: obs("working", 0), p2: obs("working", 0) }, MIN + 1000 + 10 * MIN + 1);
    expect(alerts.filter((a) => a.rule === "lead-no-disposition").map((a) => a.key)).toEqual(["lead-idle:c1:5"]);
  });
});

describe("closed cases", () => {
  it("owes nothing after the lead closes the case", () => {
    const events = log([["brief", "c1", "lead", "p1", 0], ["handback", "c1", "p1", "lead", MIN], ["close", "c1", "lead", "p1", 2 * MIN]]);
    expect(run(events, allIdle(), 60 * MIN)).toEqual([]);
  });

  it("reopens when a peer hands back again after the close", () => {
    const events = log([
      ["brief", "c1", "lead", "p1", 0], ["handback", "c1", "p1", "lead", MIN],
      ["close", "c1", "lead", "p1", 2 * MIN], ["handback", "c1", "p1", "lead", 3 * MIN],
    ]);
    const alerts = run(events, allIdle(), 3 * MIN + 1000 + 10 * MIN + 1);
    expect(alerts.map((a) => a.rule)).toEqual(["lead-no-disposition"]);
  });
});
