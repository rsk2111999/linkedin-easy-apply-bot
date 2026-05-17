// Relay messages between content script and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Forward content script logs/status to the popup
  if (['log', 'done', 'error', 'status'].includes(msg.type)) {
    chrome.runtime.sendMessage(msg).catch(() => {
      // Popup may not be open — that's fine
    });
  }
  sendResponse({ ok: true });
  return true;
});
