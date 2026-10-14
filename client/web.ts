import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}
interface DomElement {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly parentElement: DomElement | null;
  readonly previousElementSibling: DomElement | null;
  readonly nextElementSibling: DomElement | null;
  readonly firstElementChild: DomElement | null;
  readonly children: ArrayLike<DomElement>;
  readonly innerText: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): Box;
  contains(other: unknown): boolean;
  closest(selector: string): DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  dispatchEvent(event: unknown): boolean;
}
type PointerListener = (event: { target: unknown }) => void;
interface StyleElement {
  textContent: string;
  remove(): void;
}
declare const document: {
  readonly head: { appendChild(element: StyleElement): void };
  createElement(tag: "style"): StyleElement;
  createRange(): { selectNodeContents(node: DomElement): void; getBoundingClientRect(): Box };
  addEventListener(type: "pointerdown", listener: PointerListener, capture: boolean): void;
  removeEventListener(type: "pointerdown", listener: PointerListener, capture: boolean): void;
};
declare class WheelEvent {
  constructor(type: "wheel", init: { deltaY: number });
}
declare class ResizeObserver {
  constructor(callback: () => void);
  observe(target: DomElement): void;
  disconnect(): void;
}
declare function requestAnimationFrame(callback: () => void): number;
declare function getComputedStyle(element: DomElement): { backgroundColor: string };

const isWeb = Platform.OS === "web";
const CHAT_SCROLLER = '[data-testid="agent-chat-scroll"]';

/** Test ID on every item row, so rows can find the other rows of their turn. */
export const ITEM_ROW_TEST_ID = "thinkingzigzag-item";

// Each item is its own timeline row, and a row cannot see its neighbors. So every row
// publishes its data here, and the row that draws a turn's line gathers the rest from the page.
const published = new Map<DomElement, unknown>();
const listeners = new Set<() => void>();
let frame = 0;

function changed() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    listeners.forEach((listener) => listener());
  });
}

/** Shares this row's data with the row that draws its turn. Web only; returns the cleanup. */
export function publishItem(node: unknown, data: unknown): () => void {
  if (!isWeb || !node) return () => {};
  const row = node as DomElement;
  published.set(row, data);
  changed();
  return () => {
    published.delete(row);
    changed();
  };
}

const USER_MESSAGE_TEST_ID = "user-message";
const AGENT_MESSAGE_TEST_ID = "assistant-message";
const ROW_ID = "data-history-row-id";
const MESSAGE_ID = "data-message-id";
const OPEN_ATTRIBUTE = "data-thinkingzigzag-open";

function isItemRow(element: DomElement) {
  return element.getAttribute("data-testid") === ITEM_ROW_TEST_ID;
}

/** One block of an agent message, which Paseo renders as its own row. */
interface Prose {
  text: string;
  messageId: string | null;
  rowId: string | null;
}

type Found = DomElement | "user" | Prose;

// A folded message is hidden, and hidden text loses its line breaks, so a block's text is kept
// from when it was last shown.
const foldedText = new Map<string, string>();

function readProse(element: DomElement): Prose {
  const row = element.closest(`[${ROW_ID}]`);
  const rowId = row?.getAttribute(ROW_ID) ?? null;
  const messageId = row?.getAttribute(MESSAGE_ID) ?? null;
  const text =
    (rowId && foldedText.get(rowId)) ||
    timelineText(messageId, rowId) ||
    (element.innerText ?? "").trim();
  return { text, messageId, rowId };
}

// Visits the item rows, user messages, and agent messages in `element`, in reading order or in
// reverse, until `visit` returns false. Returns false when it stopped.
function scan(element: DomElement, reverse: boolean, visit: (found: Found) => boolean): boolean {
  if (isItemRow(element)) return visit(element);
  const testId = element.getAttribute("data-testid");
  if (testId === USER_MESSAGE_TEST_ID) return visit("user");
  if (testId === AGENT_MESSAGE_TEST_ID) return visit(readProse(element));
  const children = element.children;
  for (let step = 0; step < children.length; step += 1) {
    const child = children[reverse ? children.length - 1 - step : step]!;
    if (!scan(child, reverse, visit)) return false;
  }
  return true;
}

// Older history is virtualized: Paseo only mounts the rows near the viewport. A row it has not
// mounted still counts toward the list's height, so mounted rows that start after the list does,
// or end before it does, mean more rows lie beyond them.
function moreRowsBeyond(virtualRow: DomElement, forward: boolean) {
  const list = virtualRow.parentElement;
  if (!list) return false;
  const rows = Array.from(list.children).filter((child) => child.getAttribute("data-index") !== null);
  const edge = forward ? rows[rows.length - 1] : rows[0];
  if (!edge) return false;
  const outer = list.getBoundingClientRect();
  const inner = edge.getBoundingClientRect();
  return forward ? outer.bottom - inner.bottom > 1 : inner.top - outer.top > 1;
}

// Visits what sits before or after `row` in the chat, nearest first, until `visit` stops.
// Reports whether it stopped, met rows that are not mounted, or reached the end.
function walk(
  row: DomElement,
  scroller: DomElement,
  forward: boolean,
  visit: (found: Found) => boolean,
): "stopped" | "unmounted" | "end" {
  for (let ancestor: DomElement | null = row; ancestor && ancestor !== scroller; ) {
    let sibling = forward ? ancestor.nextElementSibling : ancestor.previousElementSibling;
    while (sibling) {
      if (!scan(sibling, !forward, visit)) return "stopped";
      sibling = forward ? sibling.nextElementSibling : sibling.previousElementSibling;
    }
    if (ancestor.getAttribute("data-index") !== null && moreRowsBeyond(ancestor, forward)) {
      return "unmounted";
    }
    ancestor = ancestor.parentElement;
  }
  return "end";
}

// Agent messages before the turn's latest one fold into its line. A stylesheet collapses them by
// message ID, so a message Paseo mounts again later stays folded from its first frame. Folded
// rows keep their place at zero height rather than leaving the layout: Paseo keeps the reader's
// place by measuring every row, and a row with no layout box measures at the top of the page.
const folded = new Set<string>();
const foldedKeyLists = new WeakSet<object>();
let foldStyle: StyleElement | null = null;

const quote = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

function addFolds(selectors: string[]) {
  const added = selectors.filter((selector) => !folded.has(selector));
  if (!added.length || !foldStyle) return;
  for (const selector of added) folded.add(selector);
  // One rule per selector, so a selector a browser rejects drops only itself.
  foldStyle.textContent = Array.from(
    folded,
    (selector) =>
      `${selector} { height: 0 !important; overflow: hidden !important; visibility: hidden !important; }`,
  ).join("\n");
}

function fold(messageIds: string[]) {
  addFolds(messageIds.map((id) => `[${ROW_ID}][${MESSAGE_ID}=${quote(id)}]`));
}

/**
 * A message from the agent's timeline: its ID when the provider gave one, otherwise when it was
 * created, which is how Paseo names the rows of a message without an ID. Its text stands in for
 * the rows', which fold before they can be read.
 */
export type FoldKey = ({ messageId: string } | { createdAt: number }) & { text: string };

const supersededText = new Map<string, string>();

// Paseo names a message's rows after the message: its ID, `<ID>:segment:<n>` for later
// segments, or `assistant_<created>_<hash>_<n>` without an ID; and splits one into rows
// `<row>:block:<n>`, of which the first carries the whole message here.
function timelineText(messageId: string | null, rowId: string | null) {
  if (!messageId || /:block:[1-9]\d*$/.test(rowId ?? "")) return undefined;
  const created = /^assistant_(\d+)_/.exec(messageId)?.[1];
  return supersededText.get(created ? `created:${created}` : messageId.split(":segment:")[0]!);
}

/** Folds messages read from the timeline, before Paseo mounts their rows. Web only. */
export function foldMessages(keys: FoldKey[]) {
  if (!isWeb || foldedKeyLists.has(keys)) return;
  foldedKeyLists.add(keys);
  for (const key of keys) {
    supersededText.set("messageId" in key ? key.messageId : `created:${key.createdAt}`, key.text);
  }
  addFolds(
    keys.flatMap((key) =>
      "messageId" in key
        ? [
            `[${ROW_ID}][${MESSAGE_ID}=${quote(key.messageId)}]`,
            // Paseo names a message's later segments after it.
            `[${ROW_ID}][${MESSAGE_ID}^=${quote(`${key.messageId}:segment:`)}]`,
          ]
        : [`[${ROW_ID}][${MESSAGE_ID}^=${quote(`assistant_${key.createdAt}_`)}]`],
    ),
  );
}

/** Marks the row whose line is open, so it keeps the line while the turn changes. Web only. */
export function markRunOpen(node: unknown, open: boolean) {
  if (!isWeb || !node) return;
  const row = node as DomElement;
  if (open) row.setAttribute(OPEN_ATTRIBUTE, "true");
  else row.removeAttribute(OPEN_ATTRIBUTE);
  changed();
}

/**
 * An agent message or an item, in the order the turn produced them. A message is `shown` when it
 * is the turn's latest, which stays in the chat; the rest fold into the line.
 */
export type Step<T> = { prose: string; shown: boolean } | { item: T };

/** One turn: everything between two of the user's messages. */
export interface Run<T> {
  /** Whether this row draws the turn's line. */
  leads: boolean;
  /** The turn's agent messages and items in order, when this row leads. */
  steps: Step<T>[];
  /** Whether the turn starts above what is loaded, so steps are missing. */
  partial: boolean;
}

/**
 * Reports this row's turn now and whenever any row publishes. The turn's first row draws its
 * line, which keeps it in one place as the turn grows, and folds the turn's earlier messages.
 * An open line stays with its row. Reports null off the web, where each row is its own run.
 * Returns the cleanup.
 */
export function trackRun<T>(node: unknown, onChange: (run: Run<T> | null) => void) {
  const row = isWeb && node ? (node as DomElement) : null;
  const scroller = row?.closest(CHAT_SCROLLER);
  if (!row || !scroller) {
    onChange(null);
    return () => {};
  }
  const collect = (found: Exclude<Found, "user">[]) => (next: Found) => {
    if (next === "user") return false;
    found.push(next);
    return true;
  };
  const measure = () => {
    const before: Exclude<Found, "user">[] = [];
    const after: Exclude<Found, "user">[] = [];
    const start = walk(row, scroller, false, collect(before));
    walk(row, scroller, true, collect(after));
    const turn = [...before.reverse(), row, ...after];

    // Every message before the last one this row can see has a later one, so it folds. The last
    // one may be the turn's latest, so it stays until a later message is mounted. Messages that
    // are only an image have no text, and fold all the same.
    const prose = turn.filter((found): found is Prose => "text" in found);
    const latest = prose[prose.length - 1]?.messageId ?? null;
    const earlier = prose.filter((block) => block.messageId && block.messageId !== latest);
    for (const block of earlier) if (block.rowId && block.text) foldedText.set(block.rowId, block.text);
    fold(earlier.map((block) => block.messageId!));

    // The line belongs to the turn's first row, which is only known once the turn's start is
    // mounted; otherwise the line would move as Paseo mounts and unmounts history.
    const rows = turn.filter((found): found is DomElement => !("text" in found));
    const open = rows.find((member) => member.getAttribute(OPEN_ATTRIBUTE) === "true");
    const leader = open ?? (start === "unmounted" ? undefined : rows[0]);
    const leads = leader === row;
    if (!leads) return onChange({ leads, steps: [], partial: false });

    const steps = turn.flatMap((found): Step<T>[] => {
      if (!("text" in found)) {
        return published.has(found) ? [{ item: published.get(found) as T }] : [];
      }
      return found.text ? [{ prose: found.text, shown: found.messageId === latest }] : [];
    });
    onChange({ leads, steps, partial: start !== "stopped" });
  };
  listeners.add(measure);
  changed();
  return () => {
    listeners.delete(measure);
  };
}

// Paseo pads its rows unevenly, and with space that shows nothing, so a line measures the
// content around it instead of the rows.
function isPainted(element: DomElement) {
  const color = getComputedStyle(element).backgroundColor;
  return color !== "transparent" && !/,\s*0\)$/.test(color);
}

/** Where a row's visible content starts and ends, and where its hover-only controls end. */
interface Bounds {
  top: number;
  bottom: number;
  reservedBottom: number;
}

function visibleBounds(row: DomElement): Bounds | null {
  const box = row.getBoundingClientRect();
  if (!box.height) return null;
  const agent = row.querySelector(`[data-testid="${AGENT_MESSAGE_TEST_ID}"]`);
  if (agent) {
    const range = document.createRange();
    range.selectNodeContents(agent);
    const text = range.getBoundingClientRect();
    if (text.height) return { top: text.top, bottom: text.bottom, reservedBottom: text.bottom };
  }
  // A user message shows its bubble; the row of buttons under it appears only on hover, and a
  // line must not cover it.
  const user = row.querySelector(`[data-testid="${USER_MESSAGE_TEST_ID}"]`);
  const bubble = user && Array.from(user.querySelectorAll("*")).find(isPainted);
  if (user && bubble) {
    const shown = bubble.getBoundingClientRect();
    return { top: shown.top, bottom: shown.bottom, reservedBottom: user.getBoundingClientRect().bottom };
  }
  if (isItemRow(row) || row.querySelector(`[data-testid="${ITEM_ROW_TEST_ID}"]`)) return null;
  return { top: box.top, bottom: box.bottom, reservedBottom: box.bottom };
}

/** Room a line keeps below hover-only controls above it: half its height, and a little more. */
const CONTROLS_CLEARANCE = 18;

/**
 * Distances from the middle of `line` to the nearest content shown above and below its row, and
 * the least distance above that keeps the line clear of controls shown on hover.
 */
export interface Clearance {
  above: number | null;
  below: number | null;
  leastAbove: number;
}

/** Web only; null elsewhere. */
export function measureClearance(node: unknown, line: unknown): Clearance | null {
  if (!isWeb || !node || !line) return null;
  const own = (node as DomElement).closest(`[${ROW_ID}]`);
  const scroller = own?.closest(CHAT_SCROLLER);
  if (!own || !scroller) return null;
  const rows = Array.from(scroller.querySelectorAll(`[${ROW_ID}]`));
  const index = rows.indexOf(own);
  const box = (line as DomElement).getBoundingClientRect();
  const middle = box.top + box.height / 2;
  let above: number | null = null;
  let leastAbove = 0;
  for (let i = index - 1; i >= 0 && above === null; i -= 1) {
    const bounds = visibleBounds(rows[i]!);
    if (!bounds) continue;
    above = middle - bounds.bottom;
    leastAbove = bounds.reservedBottom - bounds.bottom + CONTROLS_CLEARANCE;
  }
  let below: number | null = null;
  for (let i = index + 1; i < rows.length && below === null; i += 1) {
    const bounds = visibleBounds(rows[i]!);
    if (bounds) below = bounds.top - middle;
  }
  return { above, below, leastAbove };
}

// Content around a line changes size as messages stream in, and while Paseo scrolls through
// history. Watchers hear about it once the chat's content has stopped resizing, so a line never
// adjusts to a layout Paseo is still moving.
const LAYOUT_SETTLE_MS = 150;
const layoutWatchers = new Set<() => void>();
const watchedContent = new Set<DomElement>();
let layoutTimer: ReturnType<typeof setTimeout> | null = null;
let contentObserver: ResizeObserver | null = null;

function layoutChanged() {
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    layoutTimer = null;
    layoutWatchers.forEach((watcher) => watcher());
  }, LAYOUT_SETTLE_MS);
}

/** Calls `watcher` soon and whenever the chat's content settles after resizing. Web only. */
export function watchLayout(node: unknown, watcher: () => void): () => void {
  const content = isWeb && node ? (node as DomElement).closest(CHAT_SCROLLER)?.firstElementChild : null;
  if (!content) return () => {};
  contentObserver ??= new ResizeObserver(layoutChanged);
  if (!watchedContent.has(content)) {
    watchedContent.add(content);
    contentObserver.observe(content);
  }
  layoutWatchers.add(watcher);
  layoutChanged();
  return () => {
    layoutWatchers.delete(watcher);
  };
}

/**
 * Removes the gap Paseo leaves below every timeline row from item rows, so a turn takes only the
 * space its line needs. A stylesheet rule, because Paseo adds the gap again whenever a row gets
 * a new neighbor. The gap is a margin on Paseo's row wrapper, two levels above the plugin's view.
 * Also adds the stylesheet that folds messages. Web only; returns the cleanup.
 */
export function installStyles(): () => void {
  if (!isWeb) return () => {};
  const style = document.createElement("style");
  style.textContent = `:has(> * > [data-testid="${ITEM_ROW_TEST_ID}"]) { margin-bottom: 0 !important; }`;
  document.head.appendChild(style);
  const folds = document.createElement("style");
  document.head.appendChild(folds);
  foldStyle = folds;
  return () => {
    style.remove();
    folds.remove();
    foldStyle = null;
    folded.clear();
    foldedText.clear();
    supersededText.clear();
    contentObserver?.disconnect();
    contentObserver = null;
    watchedContent.clear();
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = null;
  };
}

/** Calls `onOutside` when a press starts outside `node`. Web only; returns the unsubscribe. */
export function onPressOutside(node: unknown, onOutside: () => void): () => void {
  if (!isWeb || !node) return () => {};
  const element = node as DomElement;
  const listener: PointerListener = (event) => {
    if (!element.contains(event.target)) onOutside();
  };
  document.addEventListener("pointerdown", listener, true);
  return () => document.removeEventListener("pointerdown", listener, true);
}

// Paseo's web chat follows new output while it sits at the bottom. It stops following when an
// upward wheel is followed by a scroll up, and follows again after a scroll down that lands on
// the bottom. Plugins have no API for this, so holding replays the first gesture, and releasing
// waits for new output and replays the second, which is the same jump following would make.
const FOLLOWING_PX = 64; // Paseo's AUTO_SCROLL_BOTTOM_THRESHOLD_PX
const NUDGE_PX = 2;

let holds = 0;
let paused: { scroller: DomElement; top: number } | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
let awaitingOutput: ResizeObserver | null = null;

function distanceFromBottom(scroller: DomElement): number {
  return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
}

function followOnNextOutput(scroller: DomElement, top: number) {
  const content = scroller.firstElementChild;
  // Far from the bottom, Paseo's own jump-to-latest button is the way back.
  if (!content || distanceFromBottom(scroller) > FOLLOWING_PX) return;
  const observer = new ResizeObserver(() => {
    // The reader scrolled away, so they are no longer following.
    if (Math.abs(scroller.scrollTop - top) > NUDGE_PX) return observer.disconnect();
    if (distanceFromBottom(scroller) <= NUDGE_PX) return;
    observer.disconnect();
    scroller.scrollTop = scroller.scrollHeight;
  });
  awaitingOutput = observer;
  observer.observe(content);
}

/**
 * Keeps the chat from following new output while any line is open, if it was following. The
 * returned release takes the collapse duration: once the last line has finished closing, the
 * chat follows the next output again, unless the reader scrolled since. Web only.
 */
export function holdChatScroll(node: unknown): (closeMs: number) => void {
  if (!isWeb || !node) return () => {};
  holds += 1;
  awaitingOutput?.disconnect();
  awaitingOutput = null;
  const scroller = (node as DomElement).closest(CHAT_SCROLLER);
  if (resumeTimer) {
    // Another line is still closing, so the chat is still paused.
    clearTimeout(resumeTimer);
    resumeTimer = null;
  } else if (
    !paused &&
    scroller &&
    scroller.scrollTop >= NUDGE_PX &&
    distanceFromBottom(scroller) <= FOLLOWING_PX
  ) {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    scroller.scrollTop -= NUDGE_PX;
    paused = { scroller, top: scroller.scrollTop };
  }

  let released = false;
  return (closeMs) => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds > 0 || !paused) return;
    const { scroller: pausedScroller, top } = paused;
    if (Math.abs(pausedScroller.scrollTop - top) > NUDGE_PX) {
      paused = null;
      return;
    }
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      paused = null;
      // Collapsing can clamp the view to the new bottom, which moves it without the reader.
      followOnNextOutput(pausedScroller, pausedScroller.scrollTop);
    }, closeMs);
  };
}
