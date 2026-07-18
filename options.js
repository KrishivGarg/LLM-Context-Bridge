const apiKeyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("saveBtn");
const saved = document.getElementById("saved");

(async function init() {
  const { geminiApiKey } = await chrome.storage.sync.get("geminiApiKey");
  if (geminiApiKey) apiKeyInput.value = geminiApiKey;
})();

saveBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  await chrome.storage.sync.set({ geminiApiKey: key });
  saved.textContent = "Saved.";
  setTimeout(() => (saved.textContent = ""), 1500);
});
