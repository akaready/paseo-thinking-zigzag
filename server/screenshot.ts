import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import { MAX_SCREENSHOT_BYTES, readScreenshot } from "../shared/screenshot";

const run = promisify(execFile);

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_CACHED = 200;
const thumbnails = new Map<string, { mime: string; base64: string }>();

/** A scaled copy, made by macOS's sips. Cached by file and version so each thumbnail scales once. */
async function thumbnail(file: string, maxEdge: number, modified: number, size: number) {
  const key = `${file}:${modified}:${size}:${maxEdge}`;
  const cached = thumbnails.get(key);
  if (cached) return cached;
  const dir = await mkdtemp(join(tmpdir(), "zigzag-shot-"));
  try {
    const out = join(dir, "thumb.png");
    await run("sips", ["-Z", String(maxEdge), file, "--out", out]);
    const shot = { mime: "image/png", base64: (await readFile(out)).toString("base64") };
    if (thumbnails.size >= MAX_CACHED) thumbnails.delete(thumbnails.keys().next().value!);
    thumbnails.set(key, shot);
    return shot;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Reads an image a turn produced. Relative paths resolve against the agent's directory. */
export async function readScreenshotFile({ cwd, path, maxEdge }: RpcInput<typeof readScreenshot>) {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error("Not an image: " + path);
  const file = isAbsolute(path) ? path : resolve(cwd, path);
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Not a file: " + file);
  if (info.size > MAX_SCREENSHOT_BYTES) throw new Error("Larger than 8 MB: " + file);
  if (maxEdge && process.platform === "darwin") {
    try {
      return await thumbnail(file, maxEdge, info.mtimeMs, info.size);
    } catch {
      // Fall through to the full image when sips cannot read it.
    }
  }
  return { mime, base64: (await readFile(file)).toString("base64") };
}
