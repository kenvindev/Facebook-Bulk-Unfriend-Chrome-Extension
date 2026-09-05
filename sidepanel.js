(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    sessionCard: $("sessionCard"),
    sessionDot: $("sessionDot"),
    sessionTitle: $("sessionTitle"),
    sessionMessage: $("sessionMessage"),
    sessionUserId: $("sessionUserId"),
    sessionToken: $("sessionToken"),
    btnRefreshSession: $("btnRefreshSession"),
    loadCard: $("loadCard"),
    loadDot: $("loadDot"),
    loadTitle: $("loadTitle"),
    loadMessage: $("loadMessage"),
    statTotal: $("statTotal"),
    statSelected: $("statSelected"),
    statExcluded: $("statExcluded"),
    statDone: $("statDone"),
    btnSelectAll: $("btnSelectAll"),
    btnUnselectAll: $("btnUnselectAll"),
    btnClearExcluded: $("btnClearExcluded"),
    btnStart: $("btnStart"),
    btnStop: $("btnStop"),
    btnRescan: $("btnRescan"),
    btnClearLog: $("btnClearLog"),
    logList: $("logList"),
    friendsList: $("friendsList"),
    friendFilter: $("friendFilter"),
  };

  let isRunning = false;
  let sessionOk = false;
  let isLoadingFriends = false;
  let friends = [];
  let listView = "all"; // all | selected | excluded

  function getDelayMs() {
    const checked = document.querySelector('input[name="delay"]:checked');
    return Number(checked?.value || 5000);
  }

  function maskToken(token) {
    if (!token) return "missing";
    if (token.length <= 10) return `${token.slice(0, 2)}…`;
    return `${token.slice(0, 6)}…${token.slice(-4)}`;
  }

  function updateSessionUI(session) {
    if (!session) {
      sessionOk = false;
      els.sessionCard.className = "session-card is-err";
      els.sessionDot.className = "dot err";
      els.sessionTitle.textContent = "Session unknown";
      els.sessionMessage.textContent = "Open facebook.com/friends/list and refresh";
      els.sessionUserId.textContent = "—";
      els.sessionToken.textContent = "—";
      syncActionButtons();
      return;
    }

    sessionOk = Boolean(session.ok);
    const status = session.status || (session.ok ? "ok" : "err");
    els.sessionCard.className = `session-card is-${status === "ok" ? "ok" : status === "warn" ? "warn" : "err"}`;
    els.sessionDot.className = `dot ${status === "ok" ? "ok" : status === "warn" ? "warn" : "err"}`;
    els.sessionTitle.textContent =
      status === "ok" ? "Session OK" : status === "warn" ? "Session warning" : "Session failed";
    els.sessionMessage.textContent = session.message || "";
    els.sessionUserId.textContent = session.userId || "—";
    els.sessionToken.textContent = session.fbDtsg ? maskToken(session.fbDtsg) : "missing";
    syncActionButtons();
  }

  function updateLoadUI(load) {
    if (!load) return;
    isLoadingFriends = Boolean(load.loading) || load.status === "loading";
    const status = load.status || "idle";
    els.loadCard.className =
      "load-card" +
      (status === "loading"
        ? " is-loading"
        : status === "complete"
          ? " is-complete"
          : status === "error"
            ? " is-error"
            : "");
    els.loadDot.className =
      "dot " +
      (status === "complete" ? "ok" : status === "error" ? "err" : "warn");
    els.loadTitle.textContent =
      status === "loading"
        ? "Loading friends…"
        : status === "complete"
          ? "Friends loaded"
          : status === "error"
            ? "Load failed"
            : "Waiting for Rescan";
    els.loadMessage.textContent = load.message || "";
    syncActionButtons();
  }

  function updateStats(stats = {}) {
    els.statTotal.textContent = String(stats.total ?? friends.length ?? 0);
    els.statSelected.textContent = String(stats.selected ?? friends.filter((f) => f.selected).length);
    els.statExcluded.textContent = String(stats.excluded ?? friends.filter((f) => f.excluded).length);
    els.statDone.textContent = String(stats.done ?? friends.filter((f) => f.done).length);
  }

  function syncActionButtons() {
    els.btnStart.disabled = isRunning || !sessionOk || isLoadingFriends;
    els.btnStop.disabled = !isRunning;
    els.btnSelectAll.disabled = isRunning || isLoadingFriends;
    els.btnUnselectAll.disabled = isRunning;
    els.btnClearExcluded.disabled = isRunning;
    els.btnRescan.disabled = isRunning || isLoadingFriends;
    els.btnRefreshSession.disabled = isRunning;
  }

  function setRunning(running) {
    isRunning = running;
    syncActionButtons();
  }

  function addLog(message, level = "info") {
    const li = document.createElement("li");
    li.className = level;
    const time = new Date().toLocaleTimeString();
    li.textContent = `[${time}] ${message}`;
    els.logList.prepend(li);
  }

  function renderFriends() {
    const q = (els.friendFilter.value || "").trim().toLowerCase();
    let list = friends;
    if (listView === "selected") list = list.filter((f) => f.selected);
    if (listView === "excluded") list = list.filter((f) => f.excluded);
    if (q) list = list.filter((f) => (f.name || "").toLowerCase().includes(q));

    els.friendsList.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "friends-empty";
      empty.textContent = isLoadingFriends
        ? "Loading friends from API…"
        : listView === "excluded"
          ? "No excluded friends yet. Tick Keep on people you want to protect."
          : "Click Reload friends to scan the list.";
      els.friendsList.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const friend of list) {
      const row = document.createElement("div");
      row.className =
        "friend-row" +
        (friend.excluded ? " is-excluded" : "") +
        (friend.done ? " is-done" : "");
      row.dataset.id = friend.id;

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = Boolean(friend.selected);
      check.disabled = Boolean(friend.excluded || friend.done || isRunning);
      check.title = "Select to unfriend";
      check.addEventListener("change", () => {
        runAction("SET_FRIEND_SELECTED", {
          id: friend.id,
          selected: check.checked,
        });
      });

      const name = document.createElement("div");
      name.className = "friend-name";
      name.title = friend.name;
      name.innerHTML = `${escapeHtml(friend.name)}${
        friend.excluded
          ? `<small>Protected (Keep)</small>`
          : friend.numericId
            ? `<small>${escapeHtml(String(friend.numericId))}</small>`
            : ""
      }`;

      const keep = document.createElement("input");
      keep.type = "checkbox";
      keep.className = "friend-keep";
      keep.checked = Boolean(friend.excluded);
      keep.disabled = Boolean(friend.done || isRunning);
      keep.title = "Keep — never unfriend (skipped by Select All)";
      keep.addEventListener("change", () => {
        runAction("SET_FRIEND_EXCLUDED", {
          id: friend.id,
          excluded: keep.checked,
        });
      });

      row.appendChild(check);
      row.appendChild(name);
      row.appendChild(keep);
      frag.appendChild(row);
    }
    els.friendsList.appendChild(frag);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function applyFriends(nextFriends, stats, load) {
    if (Array.isArray(nextFriends)) {
      friends = nextFriends;
      renderFriends();
    }
    if (stats) updateStats(stats);
    else updateStats();
    if (load) updateLoadUI(load);
  }

  async function getFriendsListTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const active = tabs[0];
    if (active?.url?.includes("facebook.com")) return active;
    const fbTabs = await chrome.tabs.query({ url: ["https://www.facebook.com/*"] });
    return fbTabs.find((t) => t.url?.includes("/friends")) || fbTabs[0] || null;
  }

  async function sendToContent(payload) {
    const tab = await getFriendsListTab();
    if (!tab?.id) {
      updateSessionUI(null);
      updateLoadUI({
        status: "error",
        message: "Open facebook.com/friends/list first",
        loading: false,
      });
      throw new Error("No Facebook friends tab found");
    }

    try {
      return await chrome.tabs.sendMessage(tab.id, payload);
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      return await chrome.tabs.sendMessage(tab.id, payload);
    }
  }

  async function refreshStatus() {
    try {
      const res = await sendToContent({ type: "GET_STATUS" });
      if (!res?.ok) {
        updateSessionUI(null);
        updateLoadUI({ status: "error", message: res?.error || "Page not ready", loading: false });
        return;
      }
      updateSessionUI(res.session);
      applyFriends(res.friends || [], res.stats || {}, res.load);
      setRunning(Boolean(res.running));
    } catch (err) {
      updateSessionUI(null);
      updateLoadUI({ status: "error", message: err.message, loading: false });
    }
  }

  async function runAction(type, extra = {}) {
    try {
      const res = await sendToContent({ type, ...extra });
      if (res?.session) updateSessionUI(res.session);
      if (res?.friends || res?.stats || res?.load) {
        applyFriends(res.friends, res.stats, res.load);
      }
      if (!res?.ok) {
        addLog(res?.error || "Action failed", "err");
        return;
      }
      if (res.message) addLog(res.message, res.level || "info");
      if (typeof res.running === "boolean") setRunning(res.running);
    } catch (err) {
      addLog(err.message || "Action failed", "err");
    }
  }

  els.btnSelectAll.addEventListener("click", () => runAction("SELECT_ALL"));
  els.btnUnselectAll.addEventListener("click", () => runAction("UNSELECT_ALL"));
  els.btnClearExcluded.addEventListener("click", () => runAction("CLEAR_ALL_EXCLUDED"));
  els.btnRescan.addEventListener("click", () => {
    runAction("RESCAN", { restart: true });
  });
  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      listView = tab.dataset.view || "all";
      renderFriends();
    });
  });
  els.btnRefreshSession.addEventListener("click", async () => {
    try {
      const res = await sendToContent({ type: "GET_SESSION" });
      updateSessionUI(res?.session);
      if (res?.load) updateLoadUI(res.load);
      addLog(res?.session?.message || "Session refreshed", res?.session?.ok ? "ok" : "err");
    } catch (err) {
      addLog(err.message || "Session refresh failed", "err");
    }
  });
  els.btnStart.addEventListener("click", () => {
    if (!sessionOk) {
      addLog("Session not OK — cannot start", "err");
      return;
    }
    if (isLoadingFriends) {
      addLog("Still loading friends — wait", "err");
      return;
    }
    runAction("START_UNFRIEND", { delayMs: getDelayMs() });
  });
  els.btnStop.addEventListener("click", () => runAction("STOP_UNFRIEND"));
  els.btnClearLog.addEventListener("click", () => {
    els.logList.innerHTML = "";
  });
  els.friendFilter.addEventListener("input", () => renderFriends());

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.source !== "fbu-content") return;
    if (message.type === "STATS") {
      updateStats(message.stats || {});
      if (message.load) updateLoadUI(message.load);
    }
    if (message.type === "FRIENDS" || message.type === "LOAD_STATE") {
      applyFriends(message.friends, message.stats, message.load);
    }
    if (message.type === "LOG") addLog(message.message, message.level || "info");
    if (message.type === "RUNNING") setRunning(Boolean(message.running));
    if (message.type === "SESSION") updateSessionUI(message.session);
    if (message.type === "DONE_BATCH") {
      setRunning(false);
      addLog(message.message || "Batch finished", "ok");
      applyFriends(message.friends, message.stats, message.load);
    }
  });

  refreshStatus();
  setInterval(refreshStatus, 3000);
})();
