import type { PluginTimelineTransformResult } from "@getpaseo/plugin";
import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { z } from "zod";

export const ITEM_KIND = "item";

/** What a run's summary counts each item as. */
export const CATEGORIES = ["thought", "command", "edit", "read", "search", "agent", "tool"] as const;

export const itemSchema = z.object({
  kind: z.enum(["thought", "tool"]),
  category: z.enum(CATEGORIES),
  /** The tool call's ID, which finds its turn in the agent's timeline; empty for a thought. */
  callId: z.string(),
  /** One-line summary of a tool call; empty for a thought. */
  title: z.string(),
  body: z.string(),
  phase: z.enum(["streaming", "complete"]),
  failed: z.boolean(),
  /** File the step touched, when it names one. Empty for thoughts and commands. */
  path: z.string(),
  /** Unified diff for an edit; empty otherwise. */
  diff: z.string(),
  /** Whether the step captures or opens an image, which agents use for screenshots. */
  screenshot: z.boolean(),
  /** When the step's row was created, in ms. Filled at render time, not by the transformer. */
  at: z.number().optional(),
});

export type ItemData = z.output<typeof itemSchema>;

type Phase = ItemData["phase"];
export type ToolCall = Parameters<
  PluginTimelineTransformerContribution<"tool_call">["transform"]
>[0]["item"];

const MAX_BODY_LINES = 40;
const MAX_BODY_CHARS = 4000;

function timelineItem(data: ItemData): PluginTimelineTransformResult {
  return { items: [{ type: "plugin", kind: ITEM_KIND, version: 2, data }] };
}

/** Keeps the start of long text, or its end for logs, where the latest output matters. */
function clip(text: string | undefined, keep: "start" | "end" = "start"): string {
  const lines = (text ?? "").trimEnd().split("\n");
  const kept = keep === "start" ? lines.slice(0, MAX_BODY_LINES) : lines.slice(-MAX_BODY_LINES);
  let clipped = kept.join("\n");
  if (clipped.length > MAX_BODY_CHARS) {
    clipped =
      keep === "start" ? clipped.slice(0, MAX_BODY_CHARS) : clipped.slice(-MAX_BODY_CHARS);
  }
  if (clipped.length === lines.join("\n").length) return clipped;
  return keep === "start" ? `${clipped}\n…` : `…\n${clipped}`;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function categorize(call: ToolCall): ItemData["category"] {
  switch (call.detail.type) {
    case "shell":
    case "worktree_setup":
      return "command";
    case "edit":
    case "write":
      return "edit";
    case "read":
      return "read";
    case "search":
    case "fetch":
      return "search";
    case "sub_agent":
      return "agent";
    default:
      return "tool";
  }
}

function describe(call: ToolCall): { title: string; body: string } {
  const detail = call.detail;
  switch (detail.type) {
    case "shell":
      return { title: `$ ${detail.command.split("\n", 1)[0]}`, body: clip(detail.output, "end") };
    case "read":
      return { title: `Read ${detail.filePath}`, body: "" };
    case "edit":
      return {
        title: `Edited ${detail.filePath}`,
        body: clip(detail.unifiedDiff ?? detail.newString),
      };
    case "write":
      return { title: `Wrote ${detail.filePath}`, body: clip(detail.content) };
    case "search":
      return {
        title: `Searched ${detail.query}`,
        body: clip(detail.content ?? detail.filePaths?.join("\n")),
      };
    case "fetch":
      return { title: `Fetched ${detail.url}`, body: clip(detail.result) };
    case "sub_agent":
      return {
        title: detail.description ?? `Ran ${detail.subAgentType ?? "a"} subagent`,
        body: clip(detail.log, "end"),
      };
    case "worktree_setup":
      return { title: `Set up worktree ${detail.branchName}`, body: clip(detail.log, "end") };
    case "plain_text":
      return { title: detail.label ?? call.name, body: clip(detail.text) };
    case "unknown":
      return { title: call.name, body: clip(stringify(detail.input)) };
    case "plan":
      return { title: call.name, body: clip(detail.text) };
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return stringify(error);
}

/** A finished thought with no text has nothing to reveal, so it is left out. */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)\b/i;
const IMAGE_TOKEN = /[^\s'"`]+\.(png|jpe?g|gif|webp)\b/i;
const CAPTURE = /\bscreencapture\b|\.screenshot\(|\bshot\.(m?js|ts|py)\b/i;

/**
 * A tool call that opens an image or captures the screen. Shell commands count only when they
 * name an image file or run a capture, not when they merely search for the word.
 */
function isScreenshot(call: ToolCall, path: string): boolean {
  if (IMAGE_FILE.test(path) || /screenshot/i.test(call.name)) return true;
  const detail = call.detail;
  return detail.type === "shell" && (IMAGE_FILE.test(detail.command) || CAPTURE.test(detail.command));
}

export function thoughtData(text: string, phase: Phase): ItemData | null {
  if (phase === "complete" && !text.trim()) return null;
  return {
    kind: "thought",
    category: "thought",
    callId: "",
    title: "",
    body: text,
    phase,
    failed: false,
    path: "",
    diff: "",
    screenshot: false,
  };
}

/** Plans and spoken messages keep Paseo's own rendering, which they need. */
export function toolData(call: ToolCall, phase: Phase): ItemData | null {
  if (call.detail.type === "plan" || call.name.trim().toLowerCase() === "speak") return null;
  const { title, body } = describe(call);
  const failed = call.status === "failed";
  const error = failed ? errorText(call.error) : "";
  const detail = call.detail;
  const named = "filePath" in detail && typeof detail.filePath === "string" ? detail.filePath : "";
  // A shell capture names its image in the command, which is where the panel finds it.
  const path =
    named || (detail.type === "shell" ? (IMAGE_TOKEN.exec(detail.command)?.[0] ?? "") : "");
  const diff = detail.type === "edit" ? (detail.unifiedDiff ?? detail.newString ?? "") : "";
  return {
    kind: "tool",
    category: categorize(call),
    callId: call.callId,
    title,
    body: [body, error].filter(Boolean).join("\n\n"),
    phase,
    failed,
    path,
    diff,
    screenshot: isScreenshot(call, path),
  };
}

export function thoughtItem(item: { text: string }, phase: Phase) {
  const data = thoughtData(item.text, phase);
  return data ? timelineItem(data) : { items: [] };
}

export function toolItem(call: ToolCall, phase: Phase) {
  const data = toolData(call, phase);
  return data ? timelineItem(data) : undefined;
}
