// background.js
// Currently minimal — the popup drives extraction/compression directly.
// Reserved here for future work: e.g. auto-detecting "limit reached" banners
// via a content script + chrome.runtime.sendMessage, instead of the manual
// click trigger used in this MVP.

chrome.runtime.onInstalled.addListener(() => {
  console.log("LLM Chat Handoff installed.");
});
