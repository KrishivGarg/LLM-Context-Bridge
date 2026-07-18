// injector.js
// Runs on chatgpt.com / claude.ai / gemini.google.com.
// Checks for a pending handoff in chrome.storage.local and, if this tab
// matches the intended target, injects the text into the chat input box.

(async function () {
  const { pendingHandoff } = await chrome.storage.local.get("pendingHandoff");
  if (!pendingHandoff) return;

  // Ignore stale handoffs (older than 2 minutes) so we don't re-paste on
  // every future visit to these sites.
  if (Date.now() - pendingHandoff.createdAt > 2 * 60 * 1000) {
    await chrome.storage.local.remove("pendingHandoff");
    return;
  }

  const host = location.hostname;
  const matchesTarget =
    (pendingHandoff.target === "chatgpt" && (host.includes("chatgpt.com") || host.includes("chat.openai.com"))) ||
    (pendingHandoff.target === "claude" && host.includes("claude.ai")) ||
    (pendingHandoff.target === "gemini" && host.includes("gemini.google.com"));

  if (!matchesTarget) return;

  const inputEl = await waitForInput(host);
  if (!inputEl) return;

  setNativeValue(inputEl, pendingHandoff.text);
  inputEl.focus();

  // One-time use: clear it so revisiting the site later doesn't re-paste.
  await chrome.storage.local.remove("pendingHandoff");
})();

function waitForInput(host, timeoutMs = 15000) {
  const selector = pickSelector(host);
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(document.querySelector(selector));
    }, timeoutMs);
  });
}

function pickSelector(host) {
  if (host.includes("chatgpt.com") || host.includes("chat.openai.com")) {
    return "#prompt-textarea";
  }
  if (host.includes("claude.ai")) {
    return 'div[contenteditable="true"]';
  }
  if (host.includes("gemini.google.com")) {
    return 'div.ql-editor[contenteditable="true"]';
  }
  return "textarea";
}

// Most of these chat UIs use React/controlled inputs, so a plain
// `el.value = text` (or innerText for contenteditable) won't register with
// the framework's internal state. We use the native setter + dispatch an
// input event, which React listens for.
function setNativeValue(el, text) {
  const isContentEditable = el.getAttribute("contenteditable") === "true";

  if (isContentEditable) {
    el.focus();
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    return;
  }

  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
