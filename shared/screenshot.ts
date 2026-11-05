import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Largest screenshot the plugin reads into a turn, so a stray large image cannot stall the chat. */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export const readScreenshot = defineRpc({
  name: "screenshot.read",
  input: z.object({
    cwd: z.string(),
    path: z.string(),
    /** Longest edge to scale the image to, for thumbnails. Full size when omitted. */
    maxEdge: z.number().int().positive().optional(),
  }),
  output: z.object({ mime: z.string(), base64: z.string() }),
});
