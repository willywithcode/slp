import { rename, writeFile } from "node:fs/promises";

/** Write via a temp file and rename, so readers never see a partial file. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}
