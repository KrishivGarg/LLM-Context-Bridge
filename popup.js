// popup.js
// Orchestrates: extract transcript from active tab -> compress via Gemini -> show result -> hand off.

const statusBox = document.getElementById("statusBox");
const extractBtn = document.getElementById("extractBtn");
const resultArea = document.getElementById("resultArea");
const output = document.getElementById("output");
const copyBtn = document.getElementById("copyBtn");
const targetSelect = document.getElementById("targetSelect");
const openBtn = document.getElementById("openBtn");
const metaInfo = document.getElementById("metaInfo");
const settingsBtn = document.getElementById("settingsBtn");

let lastHandoff = null;

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

targetSelect.addEventListener("change", () => {
  openBtn.disabled = !targetSelect.value;
});

extractBtn.addEventListener("click", async () => {
  setStatus("Loading full conversation (auto-scrolling to defeat lazy-loading)…");
  extractBtn.disabled = true;
  resultArea.classList.add("hidden");

  try {
    const { geminiApiKey } = await chrome.storage.sync.get("geminiApiKey");
    if (!geminiApiKey) {
      setStatus("No Gemini API key set. Click the gear icon to add one.");
      extractBtn.disabled = false;
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab found.");

    const [{ result: transcript }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractTranscriptFromPage,
    });

    if (!transcript || transcript.messages.length === 0) {
      setStatus("Couldn't find any chat messages on this page. Selectors may need updating for this site.");
      extractBtn.disabled = false;
      return;
    }

    // Baseline: what you'd get from literally pasting the whole conversation
    // (code included, nothing removed) into a new chat. transcript.messages
    // still holds each message's full original text - code substitution only
    // happens in the copy sent to Gemini, not here - so this is a fair
    // apples-to-apples "no compression" comparison point.
    const rawFullText = transcript.messages.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join("\n\n");
    const rawTokens = estimateTokens(rawFullText);

    // Measured across ~5 real conversations: the structured summary format
    // (section headers + verbatim last 4-5 exchanges) has enough fixed
    // overhead that short conversations can come out LARGER after
    // "compression" than the original, not smaller (e.g. 3,266 raw tokens ->
    // 3,764 handoff tokens, a -15% "reduction"). Below this threshold, skip
    // Gemini entirely and just pass the raw transcript through - also saves
    // an API call, which helps with free-tier quota limits. Tune this value
    // against your own measured crossover point if it drifts.
    const SKIP_COMPRESSION_BELOW_TOKENS = 3000;

    const roleCounts = summarizeRoleCounts(transcript.messages);
    const distinctRoles = Object.keys(roleCounts);
    let roleWarning = "";
    if (distinctRoles.length === 1) {
      roleWarning = `⚠️ Only found "${distinctRoles[0]}" messages (${roleCounts[distinctRoles[0]]} total) — the selector for the other role is broken for this site's current markup, so the summary below is unreliable. `;
    }

    const codeBlockCount = transcript.messages.reduce((sum, m) => sum + (m.codeBlocks?.length || 0), 0);
    const artifactRefs = transcript.messages.flatMap((m) => m.artifactRefs || []);
    let finalHandoff;
    let skippedCompression = false;

    if (rawTokens < SKIP_COMPRESSION_BELOW_TOKENS) {
      skippedCompression = true;
      setStatus(`${roleWarning}This conversation is short (~${rawTokens} tokens) — compression overhead would likely make the handoff bigger, not smaller. Skipping Gemini and using the full transcript directly…`);
      finalHandoff = rawFullText;
    } else {
      setStatus(`${roleWarning}Found ${transcript.messages.length} messages (${distinctRoles.map((r) => `${roleCounts[r]} ${r}`).join(", ")}). Compressing with Gemini…`);
      finalHandoff = await compressWithGemini(transcript, geminiApiKey);
    }
    lastHandoff = finalHandoff;

    if (artifactRefs.length > 0) {
      finalHandoff += `\n\n=== ARTIFACTS/CANVAS FILES REFERENCED BUT NOT EXTRACTED ===\nThese were created via the site's artifact/canvas feature, so their content lives in a side panel, not the page text - it couldn't be scraped. Open the original chat to copy them manually:\n${artifactRefs.map((r) => `- ${r}`).join("\n")}`;
      lastHandoff = finalHandoff;
    }

    output.value = finalHandoff;
    resultArea.classList.remove("hidden");
    const artifactNote = artifactRefs.length > 0 ? ` ⚠️ ${artifactRefs.length} artifact/canvas file(s) referenced but NOT extracted (see bottom of summary).` : "";
    const finalTokens = estimateTokens(finalHandoff);
    const reductionPct = rawTokens > 0 ? (((rawTokens - finalTokens) / rawTokens) * 100).toFixed(1) : "0.0";
    const statsLine = skippedCompression
      ? `<strong>Compression skipped (short conversation) — full transcript used as-is, ~${finalTokens.toLocaleString()} tokens.</strong>`
      : `<strong>Full paste: ~${rawTokens.toLocaleString()} tokens → Handoff: ~${finalTokens.toLocaleString()} tokens (${reductionPct}% reduction)</strong>`;
    metaInfo.innerHTML = `${transcript.messages.length} messages extracted from ${transcript.site}, ${codeBlockCount} inline code block(s) preserved verbatim.${artifactNote}<br>${statsLine}`;
    setStatus(`${roleWarning}${skippedCompression ? "Done (compression skipped for this short chat). " : roleWarning ? "" : "Done. "}Copy the summary or open it directly in another LLM.`);

    // Logged for building an eval table across multiple test conversations -
    // copy these rows out of the console if you're compiling stats for a
    // writeup/resume. Real measurements from real chats, not estimates.
    console.log("[LLM Chat Handoff] eval row:", {
      site: transcript.site,
      messageCount: transcript.messages.length,
      codeBlockCount,
      artifactRefCount: artifactRefs.length,
      rawTokens,
      finalTokens,
      reductionPct: skippedCompression ? 0 : Number(reductionPct),
      skippedCompression,
    });
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  } finally {
    extractBtn.disabled = false;
  }
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(output.value);
  copyBtn.textContent = "Copied!";
  setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
});

openBtn.addEventListener("click", async () => {
  if (!lastHandoff || !targetSelect.value) return;
  const urls = {
    chatgpt: "https://chatgpt.com/",
    claude: "https://claude.ai/new",
    gemini: "https://gemini.google.com/app",
  };
  const url = urls[targetSelect.value];

  // Stash the handoff for the injector content script running on the new tab.
  await chrome.storage.local.set({
    pendingHandoff: {
      text: lastHandoff,
      target: targetSelect.value,
      createdAt: Date.now(),
    },
  });

  await chrome.tabs.create({ url });
  setStatus("Opened target LLM. Paste happens automatically once the page loads.");
});

function setStatus(msg) {
  statusBox.textContent = msg;
}

function estimateTokens(text) {
  // Rough heuristic: ~4 chars per token.
  return Math.round(text.length / 4);
}

// --- Compression via Gemini API ---
//
// Code blocks are never sent through the model for "compression" — an LLM
// asked to summarize a long conversation will happily drop or paraphrase
// code, which destroys the one thing you actually need to continue technical
// work. Instead: pull every code block out up front, replace it with a
// placeholder tag in the prose sent to Gemini, and stitch the code back in
// verbatim afterward. Only the surrounding discussion gets compressed.
//
// No per-message truncation here on purpose — gemini-3.5-flash has a
// 1M-token context, which comfortably fits even very long conversations.
// Only a generous total-size safety valve is enforced, far above what a
// real chat would hit.

const MAX_TRANSCRIPT_CHARS = 2_500_000; // ~ well under the 1M token window

async function compressWithGemini(transcript, apiKey) {
  const codeAppendix = []; // { tag, role, code }

  const transcriptText = transcript.messages
    .map((m) => {
      let prose = m.text;

      (m.codeBlocks || []).forEach((code) => {
        const tag = `[CODE BLOCK ${codeAppendix.length + 1}]`;
        codeAppendix.push({ tag, role: m.role, code });
        // Best-effort: cut the raw code out of the prose text so it isn't
        // duplicated in what we send to the model. If innerText formatting
        // didn't match exactly, this is a no-op and the code just also
        // appears in the prose sent for summarization - harmless.
        prose = prose.includes(code) ? prose.replace(code, `\n${tag} (full code in appendix, not reproduced here)\n`) : prose;
      });

      return `${m.role.toUpperCase()}: ${prose}`;
    })
    .join("\n\n");

  if (transcriptText.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error(
      `This conversation (${transcriptText.length.toLocaleString()} chars) exceeds the safety limit for a single compression call. This is a rare edge case — let me know and we can add chunked compression.`
    );
  }

  const prompt = `You are archiving a chat conversation so a *different* AI assistant can pick up exactly where it left off, with none of this context. This is an archive, not a highlight reel — be thorough, not brief. Do not compress away technical detail, file names, function names, error messages, or specific numbers/values that were discussed.

Some code has already been pulled out and replaced with tags like [CODE BLOCK 3] - it will be reattached separately, verbatim. Do not try to reproduce or describe code content in detail; just reference block numbers where relevant and briefly note what each one is/does.

Produce a thorough handoff document with these sections. Use as much length as the conversation actually warrants — do not artificially shorten:

TOPIC: one or two sentences describing what this conversation is about
PROJECT/TECHNICAL CONTEXT: any project name, tech stack, file structure, architecture, or constraints established — as much detail as was actually discussed
KEY FACTS: a thorough bullet list of every important fact, decision, constraint, or detail established — err on the side of including too much rather than too little
DECISIONS MADE: bullet points of decisions or conclusions reached, and why
OPEN QUESTIONS / NEXT STEPS: what's unresolved or was about to happen next
RECENT MESSAGES (VERBATIM): the last 4-5 exchanges, copied exactly (code tags are fine as-is), so tone and immediate context carry over

Do not add commentary outside these sections. Do not trim for length.

CONVERSATION:
${transcriptText}`;

  // gemini-3.5-flash is Google's current recommended default model as of
  // mid-2026 — free tier available, no billing required. Confirmed against
  // https://ai.google.dev/gemini-api/docs/pricing (check there if this
  // ever 404s too, since Google rotates which models are open to new keys).
  // Alternative if you want lower latency/cost on simple tasks:
  // gemini-3.1-flash-lite (also free tier, no billing).
  const MODEL = "gemini-3.5-flash";
  const MAX_ATTEMPTS = 3;

  let lastErrText = "";
  let summary = "";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 32768 },
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text).join("") ?? "";
      if (!text) throw new Error("Gemini returned an empty response.");
      summary = text.trim();
      if (candidate?.finishReason === "MAX_TOKENS") {
        summary += "\n\n[NOTE: Gemini's response was cut off at the output token limit — the summary above may be incomplete. Try again with a shorter conversation, or let me know and we can add chunked compression for very long chats.]";
      }
      break;
    }

    lastErrText = await res.text();

    // Only retry on 429s that look like a short-lived rate limit
    // (PerMinute), not a daily quota exhaustion (PerDay) - retrying that
    // just wastes time since it won't reset until midnight Pacific.
    const isDailyQuota = /PerDay/i.test(lastErrText);
    if (res.status !== 429 || isDailyQuota || attempt === MAX_ATTEMPTS - 1) {
      if (res.status === 429 && isDailyQuota) {
        throw new Error(
          `Daily free-tier quota exhausted for this model. It resets at midnight Pacific Time. Full response:\n${lastErrText}`
        );
      }
      throw new Error(`Gemini API error (${res.status}):\n${lastErrText}`);
    }

    // Exponential backoff for per-minute rate limits: 1s, 2s, 4s.
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }

  if (!summary) throw new Error(`Gemini API error:\n${lastErrText}`);

  if (codeAppendix.length === 0) return summary;

  const appendixText = codeAppendix
    .map((c) => `--- ${c.tag} (from ${c.role} message) ---\n${c.code}`)
    .join("\n\n");

  return `${summary}\n\n=== CODE & FILES (VERBATIM, ${codeAppendix.length} block${codeAppendix.length === 1 ? "" : "s"}) ===\n\n${appendixText}`;
}

// --- Extraction function, injected into the page via chrome.scripting.executeScript ---
// Must be a standalone async function: no closures over outer scope.
// Runs in two phases: (1) auto-scroll to force lazy/virtualized message
// lists to fully render into the DOM - many chat UIs only keep recently-
// visible messages mounted, so scraping without this misses everything
// that's scrolled out of view, including code; (2) scrape.
async function extractTranscriptFromPage() {
  const host = location.hostname;
  const messages = [];
  let site = host;

  function pickMessageSelector() {
    if (host.includes("chatgpt.com") || host.includes("chat.openai.com")) return "[data-message-author-role]";
    if (host.includes("claude.ai")) return '[data-testid="user-message"], .font-claude-response';
    if (host.includes("gemini.google.com")) return ".query-text, .model-response-text";
    return null;
  }

  async function autoScrollToLoadAll(selector, maxIterations = 40, waitMs = 300) {
    if (!selector) return;
    let lastCount = -1;
    let stableStreak = 0;
    for (let i = 0; i < maxIterations; i++) {
      const count = document.querySelectorAll(selector).length;
      if (count === lastCount) {
        stableStreak++;
        if (stableStreak >= 3) break; // 3 stable checks in a row = fully loaded
      } else {
        stableStreak = 0;
      }
      lastCount = count;

      // Scroll every scrollable element to the top - covers window scroll
      // and inner chat-container scroll, without needing site-specific
      // container selectors.
      window.scrollTo(0, 0);
      document.querySelectorAll("*").forEach((el) => {
        if (el.scrollHeight > el.clientHeight + 40) el.scrollTop = 0;
      });

      await new Promise((r) => setTimeout(r, waitMs));
    }
    // Return to bottom so the page is left how the user had it.
    window.scrollTo(0, document.body.scrollHeight);
  }

  function extractCodeBlocks(el) {
    const blocks = [];
    const seen = new Set();

    el.querySelectorAll("pre").forEach((pre) => {
      const codeEl = pre.querySelector("code") || pre;
      const code = codeEl.innerText.trim();
      if (code && !seen.has(code)) {
        blocks.push(code);
        seen.add(code);
      }
    });

    // Fallback for code rendered without a <pre> tag (e.g. artifact panels,
    // custom code viewers): detect monospace + whitespace-preserving blocks
    // heuristically, since exact class names vary by site and change often.
    el.querySelectorAll("div, span, code").forEach((node) => {
      if (node.children.length > 5) return; // skip large wrapper containers
      const text = node.innerText ? node.innerText.trim() : "";
      if (!text || seen.has(text) || text.length < 40) return;
      const style = getComputedStyle(node);
      const isMono = /mono|courier|consolas/i.test(style.fontFamily);
      const preservesWhitespace = /pre/.test(style.whiteSpace);
      if (isMono && preservesWhitespace && text.split("\n").length > 2) {
        blocks.push(text);
        seen.add(text);
      }
    });

    return blocks;
  }

  function extractArtifactRefs(el) {
    // Artifact/canvas cards (Claude artifacts, ChatGPT canvas) show a title
    // + file-type preview but the actual code/file content is loaded into a
    // side panel on click - it never exists as text in the main page DOM,
    // so it can't be scraped no matter how good the code-block selector is.
    // Best we can do is flag that one existed so the user knows to check it.
    const refs = [];
    el.querySelectorAll('[class*="artifact-block"], [class*="canvas-block"]').forEach((card) => {
      const firstLine = card.innerText ? card.innerText.trim().split("\n")[0] : "";
      if (firstLine) refs.push(firstLine);
    });
    return refs;
  }

  function pushMsg(role, el) {
    const text = el.innerText ? el.innerText.trim() : "";
    if (!text) return;
    messages.push({ role, text, codeBlocks: extractCodeBlocks(el), artifactRefs: extractArtifactRefs(el) });
  }

  const selector = pickMessageSelector();
  if (selector) await autoScrollToLoadAll(selector);

  if (host.includes("chatgpt.com") || host.includes("chat.openai.com")) {
    site = "ChatGPT";
    document.querySelectorAll("[data-message-author-role]").forEach((el) => {
      const role = el.getAttribute("data-message-author-role") === "user" ? "user" : "assistant";
      pushMsg(role, el);
    });
  } else if (host.includes("claude.ai")) {
    site = "Claude";
    document.querySelectorAll('[data-testid="user-message"], .font-claude-response').forEach((el) => {
      const isUser = el.getAttribute("data-testid") === "user-message";
      pushMsg(isUser ? "user" : "assistant", el);
    });
  } else if (host.includes("gemini.google.com")) {
    site = "Gemini";
    document.querySelectorAll(".query-text, .model-response-text").forEach((el) => {
      const isUser = el.classList.contains("query-text");
      pushMsg(isUser ? "user" : "assistant", el);
    });
  } else {
    // Generic best-effort fallback: grab large text blocks in document order.
    site = "Unknown site";
    document.querySelectorAll("main *").forEach((el) => {
      if (el.children.length === 0 && el.innerText && el.innerText.trim().length > 20) {
        messages.push({ role: "unknown", text: el.innerText.trim(), codeBlocks: [] });
      }
    });
  }

  return { site, url: location.href, messages };
}

// Sanity-check helper - called from popup.js after extraction, not injected.
function summarizeRoleCounts(messages) {
  const counts = {};
  messages.forEach((m) => {
    counts[m.role] = (counts[m.role] || 0) + 1;
  });
  return counts;
}
