import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
/** Write via a temp file and rename, so readers never see a partial file. */
export async function writeAtomic(path, content) {
    // Unique per write: two writes of one file in the same millisecond must not share a temp file.
    const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
}
