import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, saveConfig } from "./core/config.js";
import type { Deps } from "./core/deps.js";
import { GoneError, SlpError } from "./core/errors.js";
import { append, readLedger, Role } from "./core/ledger.js";
import { acquireLock, releaseLock } from "./core/lock.js";
import { configPath, type Env } from "./core/paths.js";
import { dotenvPath, withDotenv } from "./core/dotenv.js";
import { contextPath, loadProject, rootFor } from "./core/project.js";
import { guide } from "./guide.js";
import { Herdr } from "./herdr.js";
import { calibrate } from "./jev/calibrate.js";
import { projectHere, whoAmI, type Me } from "./identity.js";
import { repoSkills, skillsSection } from "./skills.js";
import { amendLane, openLane, type Home } from "./lanes.js";
import { cleanSlots } from "./slots.js";
import { redeliver, watchLockPath } from "./letters.js";
import { writeAtomic } from "./core/fsutil.js";
import { permit } from "./permit.js";
import { mayRun, ROLE_SPECS } from "./roles.js";
import { answer, ask, findings, message, parseCritique, report } from "./talk.js";
import { acceptTask, cutTask, diffOf, testOf, finishReview, handBack, parseFinding, reworkTask, startReview, startTask, type Actor } from "./tasks.js";
import { closeLane, moveSeatVerb, render, resendIntro, setProject, start, stop } from "./team.js";
import { update } from "./update.js";
import { Watcher } from "./watcher.js";

const USAGE = `slp: a Supervisor, Leads and Peers working on your repository through Herdr

The Human (in a Herdr pane, inside the repository):
  slp start                 open the Supervisor beside you and a watcher below
  slp status                where the work stands
  slp stop [--force]        close every seat
  slp clean [--force]       remove working copies slp kept (--force: even with uncommitted changes)
  slp intro <seat>          resend a seat's introduction (after a trust dialog)
  slp redeliver <seq> [--force]
  slp watch [--project ID] [--once] [--interval SECONDS]
  slp config                where the accounts and models are configured
  slp incidents             what the watch found; mark one: slp ack <id> useful|noise|unknown
  slp calibrate [--dry-run] set Jev's thresholds from those marks
  slp update [--dry-run]    install the latest slp (or --version v0.3.3)

Seats run \`slp guide\` for their own verbs. State lives in ~/.slp (SLP_HOME).`;

const OPTIONS = {
  title: { type: "string" }, outcome: { type: "string" }, accept: { type: "string", multiple: true },
  out: { type: "string", multiple: true }, write: { type: "string", multiple: true }, human: { type: "string" },
  isolate: { type: "boolean" }, home: { type: "string" }, carry: { type: "boolean" }, after: { type: "string" }, why: { type: "string" }, land: { type: "boolean" }, drop: { type: "boolean" },
  "over-gate": { type: "boolean" }, "over-risk": { type: "boolean" }, reason: { type: "string" }, base: { type: "string" }, gate: { type: "string" },
  "no-gate": { type: "boolean" }, "gate-timeout": { type: "string" }, goal: { type: "string" },
  own: { type: "string", multiple: true }, context: { type: "string" }, preset: { type: "string" },
  parallel: { type: "boolean" }, task: { type: "string" }, lane: { type: "boolean" }, focus: { type: "string" },
  check: { type: "string", multiple: true }, left: { type: "string" }, finding: { type: "string", multiple: true },
  default: { type: "string" }, force: { type: "boolean" }, project: { type: "string" }, once: { type: "boolean" },
  interval: { type: "string" }, file: { type: "string" }, skill: { type: "string", multiple: true }, help: { type: "boolean", short: "h" }, "dry-run": { type: "boolean" }, version: { type: "string" },
} as const;

export class UsageError extends Error {}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];
type TextArg = (arg: string | undefined) => Promise<string>;
type Arity = (n: number, m?: number) => void;

/** Commands only the Human runs, never a seat. */
const HUMAN_ONLY = new Set(["start", "stop", "intro", "watch", "calibrate", "update", "clean"]);
/** Seat verbs the Human may run too. */
const HUMAN_TOO = new Set(["incidents", "ack"]);

/** Verbs only a seat runs; everything else is the Human's. */
const SEAT_VERBS = new Set([
  "whoami", "context", "diff", "test", "permit", "message", "open-lane", "amend-lane", "close-lane", "set-project", "answer", "incidents", "ack", "move-seat",
  "start-task", "start-review", "accept", "rework", "cut", "report", "ask", "done", "findings",
]);

export async function main(argv: string[], deps: Deps, cwd: string = process.cwd(), stdin: () => Promise<Buffer> = readStdin): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  const [command, ...args] = positionals;
  if (!command || values.help || command === "help") {
    // A seat asking for help gets its own guide, not the Human's usage.
    const me = await whoAmI(deps.env).catch(() => null);
    deps.out(me ? await guideFor(me) : USAGE);
    return command || values.help ? 0 : 2;
  }
  const text: TextArg = async (arg) => {
    if (values.file !== undefined) {
      if (arg !== undefined) throw new UsageError("Pass either TEXT or --file, not both");
      return decodeText(await readFile(values.file));
    }
    if (arg === "-") return decodeText(await stdin());
    if (arg === undefined) throw new UsageError(`"${command}" needs text: TEXT, - (stdin) or --file PATH`);
    return arg;
  };
  const arity: Arity = (n, m = n) => {
    if (args.length < n || args.length > m) throw new UsageError(`Wrong number of arguments for "${command}"`);
  };

  if (SEAT_VERBS.has(command)) {
    // The Human may also list and mark incidents, from any terminal.
    const me = HUMAN_TOO.has(command) ? await whoAmI(deps.env).catch(() => null) : await whoAmI(deps.env);
    if (!me) return humanIncidents(deps, cwd, command, args, arity);
    if (!mayRun(me.seat.role, command)) throw new SlpError(`The ${me.seat.role} does not run \`slp ${command}\`; see \`slp guide\`.`);
    return seatVerb(command, args, values, { deps, project: me.project, state: me.state, seat: me.seat }, text, arity);
  }
  // The Human's own commands are not for seats: an agent could stop the whole team.
  if (HUMAN_ONLY.has(command)) {
    const me = await whoAmI(deps.env).catch(() => null);
    if (me) throw new SlpError(`\`slp ${command}\` is the Human's command; the ${me.seat.role} does not run it. See \`slp guide\`.`);
  }

  switch (command) {
    case "guide": {
      arity(0, 1);
      if (args[0] !== undefined) {
        const role = Role.safeParse(args[0]);
        if (!role.success) throw new UsageError(`Role must be one of ${Role.options.join(", ")}`);
        deps.out(withSkills(guide(role.data), role.data, await repoSkills(await rootFor(cwd))));
        return 0;
      }
      const me = await whoAmI(deps.env).catch(() => null);
      deps.out(me ? await guideFor(me) : USAGE);
      return 0;
    }
    case "status": {
      arity(0);
      const me = await whoAmI(deps.env).catch(() => null);
      const { project, state } = me ?? await projectHere(deps.env, cwd);
      deps.out(render(project, state, deps.now?.() ?? Date.now(), contextPath(deps.env, project.id)));
      return 0;
    }
    case "start": arity(0); await start(deps, cwd, await loadConfig(deps.env)); return 0;
    case "stop": {
      arity(0);
      const { project, state } = await projectHere(deps.env, cwd);
      await stop(deps, project, state, values.force === true);
      return 0;
    }
    case "intro": {
      arity(1);
      const { project, state } = await projectHere(deps.env, cwd);
      await resendIntro(deps, project, state, args[0]!);
      return 0;
    }
    case "redeliver": {
      arity(1);
      const seq = positiveInt(args[0]!, "seq");
      const me = await whoAmI(deps.env).catch(() => null);
      const project = me?.project ?? (await projectHere(deps.env, cwd)).project;
      await redeliver(deps, project.id, me ? me.seat.name : null, seq, values.force === true);
      return 0;
    }
    case "clean": {
      arity(0);
      const { project } = await projectHere(deps.env, cwd);
      await cleanSlots(deps, project, values.force === true);
      return 0;
    }
    case "update": arity(0); await update(deps, { check: values["dry-run"] === true, version: values.version }); return 0;
    case "config": arity(0); await loadConfig(deps.env); deps.out(configPath(deps.env)); deps.out(`${dotenvPath(deps.env)} (keys such as JEV_API_KEY)`); return 0;
    case "calibrate": {
      arity(0);
      const { project } = await projectHere(deps.env, cwd);
      const config = await loadConfig(deps.env);
      const results = calibrate(await readLedger(deps.env, project.id), config.watch.budgetPerDay);
      if (!results.length) {
        deps.out("No Jev readings have been marked yet. Mark incidents with `slp ack <id> useful|noise`, then calibrate again.");
        return 0;
      }
      const thresholds = { ...config.jev.thresholds };
      for (const r of results) {
        deps.out(`${r.key.padEnd(36)} useful ${String(r.useful).padStart(3)} noise ${String(r.noise).padStart(3)} ` +
          `separation ${r.separation === null ? "  -  " : r.separation.toFixed(2)}  ${r.threshold !== null ? `threshold ${r.threshold.toFixed(2)}` : r.reason}`);
        if (r.threshold !== null) thresholds[r.key] = r.threshold;
        else delete thresholds[r.key];
      }
      if (values["dry-run"]) return 0;
      await saveConfig(deps.env, { ...config, jev: { ...config.jev, thresholds } });
      deps.out(`thresholds saved to ${configPath(deps.env)}` +
        (config.jev.mode === "on" ? "" : `; Jev is in ${config.jev.mode} mode, so they act only once "jev.mode" is "on"`));
      return 0;
    }
    case "watch": {
      arity(0);
      const id = values.project ?? deps.env.SLP_PROJECT ?? (await projectHere(deps.env, cwd)).project.id;
      if (!(await loadProject(deps.env, id))) throw new SlpError(`No slp project ${id}`);
      const interval = values.interval === undefined ? 5 : Number(values.interval);
      if (!Number.isFinite(interval) || interval < 1) throw new UsageError("--interval must be at least 1 second");
      return watch(deps, id, interval, values.once === true);
    }
    default:
      throw new UsageError(`Unknown command "${command}"`);
  }
}

async function seatVerb(command: string, args: string[], v: Values, a: Actor, text: TextArg, arity: Arity): Promise<number> {
  const { deps } = a;
  const list = (x: string[] | undefined) => (x ?? []).map((s) => s.trim()).filter(Boolean);
  switch (command) {
    case "context": {
      arity(0, 1);
      const path = contextPath(deps.env, a.project.id);
      if (args[0] === undefined && v.file === undefined) {
        deps.out(await readFile(path, "utf8").catch(() => "(no concept written yet)"));
        return 0;
      }
      if (!ROLE_SPECS[a.seat.role].editsContext) throw new SlpError("Only the Supervisor writes the concept; ask it with `slp ask`.");
      const body = await text(args[0]);
      if (!body.trim()) throw new SlpError("Refusing to write an empty concept.");
      const lines = body.trimEnd().split(/\r?\n/);
      await writeAtomic(path, `${lines.join("\n")}\n`);
      deps.out(`concept written (${lines.length} lines)`);
      return 0;
    }
    case "diff": arity(1); deps.out(await diffOf(a, args[0]!)); return 0;
    case "permit": {
      arity(2, 3);
      if (args[1] !== "allow" && args[1] !== "deny") throw new UsageError('permit <seat> allow|deny "why"');
      await permit(a, await loadConfig(deps.env), args[0]!, args[1] === "allow", args[2] ?? "");
      return 0;
    }
    case "test": arity(0, 1); deps.out(await testOf(a, args[0] ?? null)); return 0;
    case "whoami":
      arity(0);
      deps.out(`${a.seat.name}: ${a.seat.role}${a.seat.lane ? ` in lane ${a.seat.lane}` : ""}${a.seat.task ? `, task ${a.seat.task}` : ""}` +
        ` · project ${a.project.id} (${a.project.root})`);
      return 0;
    case "message": arity(1, 2); await message(a, args[0]!, await text(args[1])); return 0;
    case "open-lane":
      arity(0);
      await openLane(deps, a.project, await loadConfig(deps.env), {
        title: v.title ?? "", outcome: v.outcome ?? "", acceptance: list(v.accept), outOfScope: list(v.out),
        writeSet: list(v.write), humanWords: v.human ?? "", home: homeOf(v), carry: v.carry === true, after: v.after ?? null,
      });
      return 0;
    case "amend-lane":
      arity(1);
      await amendLane(deps, a.project, args[0]!, {
        why: v.why ?? "", ...(v.outcome !== undefined ? { outcome: v.outcome } : {}),
        ...(v.accept ? { acceptance: list(v.accept) } : {}), ...(v.out ? { outOfScope: list(v.out) } : {}),
        ...(v.write ? { writeSet: list(v.write) } : {}),
      });
      return 0;
    case "close-lane":
      arity(1);
      await closeLane(a, args[0]!, { land: v.land === true, drop: v.drop === true, overGate: v["over-gate"] === true, overRisk: v["over-risk"] === true, reason: v.reason ?? "" });
      return 0;
    case "set-project":
      arity(0);
      await setProject(a, { base: v.base, gate: v.gate, noGate: v["no-gate"] === true, timeout: v["gate-timeout"] });
      return 0;
    case "answer": arity(1, 2); await answer(a, args[0]!, await text(args[1])); return 0;
    case "incidents": {
      arity(0);
      const acked = new Set(a.state.acks.map((k) => k.incident));
      const open = a.state.incidents.filter((i) => !acked.has(i.incident) && (i.to === a.seat.name || a.seat.role === "supervisor"));
      deps.out(open.length ? open.map((i) => `${i.incident} [${i.level}] ${i.seat}: ${i.text}`).join("\n") : "No open incidents.");
      return 0;
    }
    case "ack": {
      arity(2, 3);
      const verdict = args[1];
      if (verdict !== "useful" && verdict !== "noise" && verdict !== "unknown") throw new UsageError("Verdict is useful, noise or unknown");
      if (!a.state.incidents.some((i) => i.incident === args[0])) throw new SlpError(`No incident ${args[0]}`);
      await append(deps.env, a.project.id, () => ({ kind: "ack" as const, incident: args[0]!, by: a.seat.name, verdict, note: args[2] ?? "" }));
      return 0;
    }
    case "move-seat": arity(2); await moveSeatVerb(a, await loadConfig(deps.env), args[0]!, args[1]!); return 0;
    case "start-task":
      arity(0);
      await startTask(a, await loadConfig(deps.env), {
        title: v.title ?? "", goal: v.goal ?? "", acceptance: list(v.accept), owned: list(v.own), outOfScope: list(v.out),
        context: v.context ?? "", preset: v.preset ?? null, parallel: v.parallel === true, skills: list(v.skill),
      });
      return 0;
    case "start-review":
      arity(0);
      await startReview(a, await loadConfig(deps.env), { task: v.task ?? null, lane: v.lane === true }, v.focus ?? "");
      return 0;
    case "accept": arity(1, 2); await acceptTask(a, args[0]!, args[1] ?? ""); return 0;
    case "rework": arity(1, 2); await reworkTask(a, args[0]!, await text(args[1])); return 0;
    case "cut": arity(1, 2); await cutTask(a, args[0]!, await text(args[1])); return 0;
    case "report": {
      arity(1, 2);
      const type = args[0];
      if (type !== "ready" && type !== "progress" && type !== "blocked") throw new UsageError("report ready|progress|blocked TEXT");
      await report(a, type, await text(args[1]));
      return 0;
    }
    case "ask": {
      arity(1, 2);
      const type = args[0];
      if (type !== "need" && type !== "blocked" && type !== "question") throw new UsageError("ask need|blocked|question TEXT [--default \"...\"]");
      await ask(a, type, await text(args[1]), v.default ?? "");
      return 0;
    }
    case "done": {
      arity(1, 2);
      const outcome = args[0];
      if (outcome !== "complete" && outcome !== "partial" && outcome !== "blocked") throw new UsageError("done complete|partial|blocked TEXT");
      const summary = await text(args[1]);
      if (a.seat.role === "reviewer") await finishReview(a, summary, list(v.finding).map(parseFinding));
      else await handBack(a, { outcome, summary, checks: list(v.check), left: v.left ?? "" });
      return 0;
    }
    case "findings": arity(0); await findings(a, list(v.finding).map(parseCritique)); return 0;
    default:
      throw new UsageError(`Unknown command "${command}"`);
  }
}

/** The Human's view of incidents, and marks (`by: human`). */
async function humanIncidents(deps: Deps, cwd: string, command: string, args: string[], arity: Arity): Promise<number> {
  const { project, state } = await projectHere(deps.env, cwd);
  const acked = new Set(state.acks.map((k) => k.incident));
  if (command === "incidents") {
    arity(0);
    const open = state.incidents.filter((i) => !acked.has(i.incident));
    deps.out(open.length ? open.map((i) => `${i.incident} [${i.level}] ${i.seat} → ${i.to ?? "you"}: ${i.text}`).join("\n") : "No unmarked incidents.");
    return 0;
  }
  arity(2, 3);
  const verdict = args[1];
  if (verdict !== "useful" && verdict !== "noise" && verdict !== "unknown") throw new UsageError("Verdict is useful, noise or unknown");
  if (!state.incidents.some((i) => i.incident === args[0])) throw new SlpError(`No incident ${args[0]}`);
  await append(deps.env, project.id, () => ({ kind: "ack" as const, incident: args[0]!, by: "human", verdict, note: args[2] ?? "" }));
  return 0;
}

function withSkills(text: string, role: Parameters<typeof guide>[0], present: ReadonlySet<string>): string {
  const section = skillsSection(role, present);
  return section ? `${text}\n\n${section}` : text;
}

/** A seat's guide, with the skills its working copy has. */
async function guideFor(me: Me): Promise<string> {
  const task = me.seat.task ? me.state.tasks.get(me.seat.task) : undefined;
  const lane = me.seat.lane ? me.state.lanes.get(me.seat.lane) : undefined;
  return withSkills(guide(me.seat.role), me.seat.role, await repoSkills(task?.workdir ?? lane?.workdir ?? me.project.root));
}

async function watch(deps: Deps, id: string, interval: number, once: boolean): Promise<number> {
  // One watcher per project: two would deliver letters and land lanes twice.
  const lock = watchLockPath(deps.env, id);
  const token = await acquireLock(lock, {
    timeoutMs: 0, reclaimForeign: false,
    busy: (owner) => `Project ${id} is already watched by pid ${owner?.pid ?? "unknown"}${owner ? ` on ${owner.host}` : ""}`,
  });
  const watcher = new Watcher(deps, id);
  try {
    if (!once) deps.out(`slp watching ${id} every ${interval}s (Ctrl+C to stop)`);
    for (;;) {
      try {
        await watcher.tick();
      } catch (error) {
        if (error instanceof GoneError) { deps.out(`watch: ${error.message}; stopping`); return 0; }
        // Herdr may be restarting; keep watching.
        deps.out(`watch: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (once) { await watcher.settle(); return 0; }
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
  } finally {
    await watcher.settle().catch(() => undefined);
    await releaseLock(lock, token).catch(() => undefined);
  }
}

const HOMES = ["auto", "newBranch", "onBranch", "isolate"] as const;

function homeOf(v: Values): Home | null {
  if (v.isolate) return "isolate";
  if (v.home === undefined) return null;
  const home = HOMES.find((h) => h.toLowerCase() === v.home!.toLowerCase());
  if (!home) throw new UsageError(`--home is one of ${HOMES.join(", ")}`);
  return home;
}

function positiveInt(raw: string, name: string): number {
  const n = Number(raw.replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a positive integer`);
  return n;
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const BOM = String.fromCharCode(0xfeff);

/** UTF-8 (with or without BOM) or BOM-marked UTF-16, which Windows PowerShell 5.1 writes. */
export function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  const s = bytes.toString("utf8");
  return s.startsWith(BOM) ? s.slice(1) : s;
}

export async function run(argv: string[], env: Env): Promise<number> {
  const deps: Deps = { env, herdr: new Herdr(), out: (line) => console.log(line) };
  try {
    // slp's own keys (Jev) from ~/.slp/.env, under the environment.
    deps.env = await withDotenv(env);
    return await main(argv, deps);
  } catch (error) {
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(`slp: ${(error as Error).message}\nRun \`slp help\` or \`slp guide\`.`);
      return 2;
    }
    console.error(`slp: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
