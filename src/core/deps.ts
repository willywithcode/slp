import type { Herdr } from "../herdr.js";
import type { Env } from "./paths.js";

/** What every slp operation needs from the outside world; faked in tests. */
export interface Deps {
  env: Env;
  herdr: Herdr;
  out: (line: string) => void;
  now?: () => number;
  fetch?: typeof fetch;
}
