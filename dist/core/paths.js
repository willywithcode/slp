import { homedir } from "node:os";
import { join } from "node:path";
export function slpHome(env) {
    return env.SLP_HOME?.trim() || join(homedir(), ".slp");
}
export function projectsDir(env) {
    return join(slpHome(env), "projects");
}
export function projectDir(env, id) {
    return join(projectsDir(env), id);
}
export function configPath(env) {
    return join(slpHome(env), "config.json");
}
