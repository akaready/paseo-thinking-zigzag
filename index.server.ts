import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readScreenshotFile } from "./server/screenshot";
import { readScreenshot } from "./shared/screenshot";

export default function contribute(server: PluginServerContext) {
  server.handle(readScreenshot, readScreenshotFile);
  return () => {};
}
