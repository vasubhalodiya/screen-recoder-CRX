// ── Script injection on icon click ───────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  } catch (e) { console.error('[ScreenCraft]', e); }
});
