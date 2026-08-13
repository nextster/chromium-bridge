const DEFAULT_COMMIT_TIMEOUT_MS = 2000;

export async function createTabAndWait(tabs, createProperties, timeoutMs = DEFAULT_COMMIT_TIMEOUT_MS) {
  const requestedUrl = String(createProperties.url || "");
  const tab = await tabs.create(createProperties);
  if (!requestedUrl || !Number.isInteger(tab?.id)) return tab;

  const watcher = watchTabCommit(tabs, {
    tabId: tab.id,
    requestedUrl,
    previousUrl: "",
    timeoutMs
  });
  return watcher.wait(tab);
}

export async function navigateTabAndWait(tabs, tabId, requestedUrl, timeoutMs = DEFAULT_COMMIT_TIMEOUT_MS) {
  const previous = await tabs.get(tabId);
  const watcher = watchTabCommit(tabs, {
    tabId,
    requestedUrl,
    previousUrl: previous.url || "",
    timeoutMs
  });

  try {
    return await watcher.wait(await tabs.update(tabId, { url: requestedUrl }));
  } catch (error) {
    watcher.cancel();
    throw error;
  }
}

function watchTabCommit(tabs, { tabId, requestedUrl, previousUrl, timeoutMs }) {
  let settled = false;
  let sawLoading = false;
  let timer;
  let resolveCommit;
  let rejectCommit;

  const committed = new Promise((resolve, reject) => {
    resolveCommit = resolve;
    rejectCommit = reject;
  });

  const cleanup = () => {
    clearTimeout(timer);
    tabs.onUpdated.removeListener(onUpdated);
  };
  const finish = (error, tab) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectCommit(error);
    else resolveCommit(tab);
  };
  const inspect = (tab, urlChanged = false) => {
    if (tab?.status === "loading") sawLoading = true;
    if (navigationCommitted(tab, requestedUrl, previousUrl, sawLoading, urlChanged)) {
      finish(null, tab);
      return true;
    }
    return false;
  };
  const onUpdated = (updatedTabId, changeInfo, tab) => {
    if (updatedTabId !== tabId) return;
    if (changeInfo.status === "loading") sawLoading = true;
    inspect(tab, Boolean(changeInfo.url));
  };

  tabs.onUpdated.addListener(onUpdated);
  timer = setTimeout(async () => {
    try {
      const current = await tabs.get(tabId);
      if (!inspect(current)) {
        finish(new Error(`Timed out waiting for tab ${tabId} to commit ${requestedUrl}`));
      }
    } catch (error) {
      finish(error);
    }
  }, timeoutMs);

  return {
    async wait(candidate) {
      if (!settled && !inspect(candidate)) {
        try {
          inspect(await tabs.get(tabId));
        } catch (error) {
          finish(error);
        }
      }
      return committed;
    },
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
    }
  };
}

function navigationCommitted(tab, requestedUrl, previousUrl, sawLoading, urlChanged) {
  const currentUrl = String(tab?.url || "");
  if (!currentUrl) return false;
  if (sameUrl(currentUrl, requestedUrl)) {
    return !sameUrl(previousUrl, requestedUrl) || sawLoading || urlChanged;
  }
  if (isPlaceholderUrl(currentUrl)) {
    return isPlaceholderUrl(requestedUrl);
  }
  return Boolean(previousUrl ? !sameUrl(currentUrl, previousUrl) : currentUrl);
}

function sameUrl(left, right) {
  if (!left || !right) return left === right;
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

function isPlaceholderUrl(url) {
  return url === "about:blank" || /^chrome:\/\/(?:newtab|new-tab-page)(?:\/|$)/i.test(url);
}
