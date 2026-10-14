# Thinking Zigzag

Folds everything a coding agent does in a turn, its thinking, tool calls, and in-between messages, into one quiet line in Paseo's chat, so each turn reads as your message, a summary line, and the agent's latest reply.

Plugins are made with 🤍 for the Paseo community. Free to use, fork, and hack on for <a href="LICENSE" target="_blank" rel="noopener noreferrer">non-commercial use</a>.

Plug-ins take effort, hours, and credits to build. If you find them helpful for you and your workflows, a star ⭐ on the repo, a <a href="https://buymeacoffee.com/akaready" target="_blank" rel="noopener noreferrer">coffee</a> ☕, and a link back to <a href="https://akaready.com" target="_blank" rel="noopener noreferrer">@akaready</a> 🔗 all go a long way. Optional of course, but always appreciated.

Enjoy! 🙏

<p align="left">
  <a href="https://buymeacoffee.com/akaready" target="_blank" rel="noopener noreferrer">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" height="40" alt="Buy me a coffee">
  </a>
</p>

&nbsp;

## 📦 Install

Plugins run trusted, unsandboxed code, so turn them on first under **Settings → Plugins → Enable plugins**. Then:

```bash
paseo plugin install github:akaready/paseo-thinking-zigzag
```

Update it later with `paseo plugin update thinking-zigzag`. Requires Paseo 0.11.2 or later.

&nbsp;

## ✨ What It Does

- **One line per turn.** A zig-zag from both edges meets a summary in the middle, such as `10 messages · 25 thoughts · 28 commands · 3 edits · 1 failed`. It sits just above the agent's latest reply, with even spacing above and below.
- **Folds the in-between.** Thinking, tool calls, and every message before the agent's latest one fold into the line. Only the latest reply stays in the chat.
- **Opens in place.** Click the line and the turn slides open below it. It starts as a table of contents: one section per stretch of work, titled with the sentence the agent used to announce it, with its own counts. Open a section to read the agent's message in full, followed by its thoughts and tool calls; open a tool call to see its output, diff, or log.
- **Holds the view.** While a turn is open, the chat stops following new output so the view stays put while the agent keeps working, and follows again when you close it. Click anywhere outside the open turn to close it.
- **Shows status.** The summary pulses while the agent is still working, and counts failed tool calls in red.

&nbsp;

## 📝 Notes

- If another plugin hides Thinking rows, such as Mono's "Hide Thinking in timeline" setting, turn that off, or thoughts are left out.
- Opening a chat reads the agent's timeline once from your Paseo host, so earlier messages fold before they appear.
- Folding, the one-line summary per turn, and closing by clicking outside work on desktop and the web app, including Safari on iPad. In Paseo's phone and tablet apps, messages stay in the chat, so each stretch of work between them gets its own line, and Paseo still leaves a small gap for every thought and tool call in it.
- Plan approvals and spoken messages keep Paseo's own rendering. Tool output is trimmed to 40 lines, and messages in an opened turn show as plain text.
- It works by reading and restyling Paseo's web chat, so a later Paseo release could change how it behaves.
