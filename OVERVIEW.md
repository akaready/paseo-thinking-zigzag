Thinking Zigzag folds everything an agent does in a turn into one quiet line, so each turn in the chat reads as your message, a summary line, and the agent's latest reply.

The line is a zig-zag from both edges that meets a summary in the middle, such as `10 messages · 25 thoughts · 28 commands · 3 edits`. It counts the agent's thinking, its tool calls, and the messages it wrote along the way; only its latest message stays in the chat. Hover the line to highlight it. Click it to open the turn in place, and the chat below slides down to make room. Click anywhere outside it, or the line again, to close it. The summary pulses while the agent is still working, and counts failed tool calls in red.

An opened turn starts as a table of contents. Each section is a stretch of work, titled with the sentence the agent used to announce it, with its own counts. Click a section to read the agent's message in full, followed by its thoughts and tool calls. Each tool call reads as one line, such as the command it ran or the file it edited; click it to show its output, diff, or log.

While a turn is open on desktop or web, the chat stops following new output, so the view stays put while the agent keeps working. Closing it follows the latest output again, unless you scrolled away in the meantime.

Opening a chat reads the agent's timeline once from your Paseo host, so earlier messages fold before they are shown rather than appearing and then collapsing as you scroll. A turn that starts above what the chat has loaded is read from the timeline too, so its counts and sections stay complete.

Plan approvals and spoken messages keep Paseo's own rendering. Tool output is trimmed to its last 40 lines for commands and logs, and its first 40 for everything else. Messages in an opened turn show as plain text.

If another plugin hides Thinking rows, such as Mono's "Hide Thinking in timeline" setting, turn that off. Otherwise thoughts are left out.

Folding messages, grouping a turn into one line, its table of contents, and closing it by clicking outside work on desktop and web. In the phone and tablet apps, every message stays in the chat, so each stretch of work between messages gets its own line, and Paseo still leaves a small gap for every thought and tool call in it; tap a line to open and close it. These behaviors depend on how Paseo's web chat lays out and scrolls its rows, so a later Paseo release could change them.
