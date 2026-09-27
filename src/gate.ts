import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// The gate is the project's own test command (ADR 0008). slp runs it; it never
// judges the work, it only reports green or red with the output's tail.

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Best guess at the project's test command, or null. */
export async function detectGate(root: string): Promise<string | null> {
  const pkg = join(root, "package.json");
  if (await exists(pkg)) {
    try {
      const json = JSON.parse(await readFile(pkg, "utf8")) as { scripts?: Record<string, string> };
      const script = json.scripts?.test;
      if (script && !/no test specified/i.test(script)) return "npm test";
    } catch { /* unreadable package.json: keep looking */ }
  }
  if (await exists(join(root, "Cargo.toml"))) return "cargo test";
  if (await exists(join(root, "go.mod"))) return "go test ./...";
  if (await exists(join(root, "pyproject.toml")) || await exists(join(root, "pytest.ini"))) return "pytest";
  if (await exists(join(root, "mvnw"))) return "./mvnw -q test";
  if (await exists(join(root, "pom.xml"))) return "mvn -q test";
  if (await exists(join(root, "gradlew"))) return "./gradlew test";
  if (await exists(join(root, "Makefile"))) {
    const make = await readFile(join(root, "Makefile"), "utf8").catch(() => "");
    if (/^test:/m.test(make)) return "make test";
  }
  return null;
}

export interface GateResult { ok: boolean; tail: string; durationMs: number }

/** Kill a process and everything it started (the shell's children hold the pipes). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

/** Run the gate in `cwd` through the platform shell, bounded by `timeoutMs`. */
export function runGate(command: string, cwd: string, timeoutMs: number): Promise<GateResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Its own process group on POSIX, so a timeout can kill the whole tree.
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env, detached: process.platform !== "win32" });
    let output = "";
    let settled = false;
    const done = (ok: boolean, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = `${output}${extra}`.split(/\r?\n/).slice(-40).join("\n").trim();
      resolve({ ok, tail, durationMs: Date.now() - started });
    };
    const keep = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-20_000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      killTree(child);
      done(false, `\n[slp] gate timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} min`);
    }, timeoutMs);
    child.on("close", (code) => done(code === 0));
    child.on("error", (error) => done(false, `\n[slp] could not run the gate: ${error.message}`));
  });
}
