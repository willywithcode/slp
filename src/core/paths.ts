import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export function slpHome(env: Env): string {
  return env.SLP_HOME?.trim() || join(homedir(), ".slp");
}

export function projectsDir(env: Env): string {
  return join(slpHome(env), "projects");
}

export function projectDir(env: Env, id: string): string {
  return join(projectsDir(env), id);
}

export function configPath(env: Env): string {
  return join(slpHome(env), "config.json");
}
