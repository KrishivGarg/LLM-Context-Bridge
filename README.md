# LLM Chat Handoff

A Chrome extension that extracts your current chat, compresses it into a compact
handoff summary, and lets you continue the conversation on a different LLM once
you've hit your usage limit — without pasting the full transcript.

## How it works

1. **Manual trigger** — once you've hit your limit on the current chat, click the
   extension icon.
2. **Extraction** — a script scrapes the visible conversation directly from the
   page DOM (no new message is sent, since the chat is already maxed out). Code
   blocks (`<pre>`/`<code>` elements) are extracted **separately** from the
   surrounding prose for each message.
3. **Compression** — only the prose is sent to Gemini's free-tier API for
   summarization (topic, key facts, decisions, open questions, last few
   messages verbatim). Code is replaced with `[CODE BLOCK N]` placeholder tags
   before sending, so the model is never asked to reproduce or paraphrase it —
   LLM summarization is lossy by nature, and code is exactly the content you
   can't afford to lose.
4. **Reassembly** — the code blocks are stitched back onto the summary
   verbatim, byte-for-byte, in a `CODE & FILES (VERBATIM)` section. This step
   doesn't touch the model at all.
5. **Handoff** — the summary + code appendix is shown in the popup. You can
   copy it manually, or pick a target LLM (ChatGPT / Claude / Gemini) to
   auto-open in a new tab with the summary auto-pasted into its input box.

## Setup

1. Get a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)
   (no credit card required).
2. Load the extension:
   - Open `chrome://extensions`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked" and select this folder
3. Click the extension icon → gear icon → paste your Gemini API key → Save.

## Usage

1. Go to any supported chat (ChatGPT, Claude, or Gemini) and use it until you
   hit the usage limit.
2. Click the extension icon → "Extract & Compress".
3. Copy the summary, or select a target LLM and click "Open & Paste".

## Project structure

```
manifest.json              MV3 manifest
popup.html/.css/.js        Extension popup — extraction, compression, UI
background.js               Service worker (currently minimal)
options.html/.js            Settings page for the Gemini API key
content-scripts/
  injector.js                Runs on target LLM sites; pastes the handoff
                              into the input box once the page loads
```

Note: `popup.js` also contains `extractTranscriptFromPage`, which is injected
into the *source* tab via `chrome.scripting.executeScript` — it isn't a
separate content script because it only needs to run on demand.

## Known limitations (worth stating explicitly on a resume/in an interview)

- **DOM selectors are brittle.** Each site's chat UI can change its markup at
  any time, which breaks extraction/injection. The current selectors
  (`#prompt-textarea` for ChatGPT, `[data-testid="user-message"]` for Claude,
  `.query-text` for Gemini) were correct as of testing but are exactly the
  kind of thing that needs periodic maintenance — a good place to add
  automated selector-health checks if you extend this project.
- **Virtualized/lazy-loaded message lists.** Long conversations often only
  keep recently-visible messages mounted in the DOM for performance. The
  extractor auto-scrolls to the top before scraping to force everything to
  load (stopping once the message count stabilizes for 3 checks in a row),
  but this is a heuristic, not a guarantee, for extremely long chats.
- **Artifact/canvas files are not extractable at all — confirmed, not theoretical.** When Claude (or ChatGPT canvas) produces a file via its artifact feature, the page only shows a collapsed preview card (title + file type); the actual content loads into a side panel on click and never exists as text in the page DOM. No selector fix can scrape text that was never there. The extractor detects these cards and lists their titles in a clearly-labeled section at the bottom of the handoff so you know to go copy them manually, rather than silently dropping them. This was confirmed by inspecting real Claude markup: a chat that produced a "llm-chat-handoff.zip" artifact showed only an `artifact-block` preview card, zero code text, in the DOM.
- **Inline code fences (`<pre>`/`<code>`) work fine.** The above limitation is specific to the artifact/canvas *file* feature — code shown directly in the chat message body (most LLM responses, most of the time) extracts correctly.
- **Scraping a page's DOM to repurpose its content may conflict with a given
  site's Terms of Service.** Worth a line in any writeup/demo as an explicit
  known tradeoff, not something to route around silently.
- **Compression is lossy by design — for prose only.** Code and file content
  are pulled out and reattached verbatim, never sent through the model.
  Surrounding discussion is condensed by Gemini, with no artificial length
  cap on either the input transcript (aside from a generous 2.5M character
  safety valve) or Gemini's own output (32K tokens).
- **No auto-detection of "limit reached."** This MVP uses a manual click
  trigger deliberately, since sniffing every provider's rate-limit UI
  reliably is a much harder and flakier problem than the rest of the project
  combined.
- Persist extracted transcripts locally (`chrome.storage.local` or
  IndexedDB) so a follow-up question in the new chat can retrieve specific
  older details instead of relying solely on the compressed summary.
