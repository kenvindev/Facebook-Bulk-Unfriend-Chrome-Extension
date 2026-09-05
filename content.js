(() => {
  const FBU_VERSION = "1.2.5";

  if (window.__FBU_ON_MESSAGE__) {
    try {
      chrome.runtime.onMessage.removeListener(window.__FBU_ON_MESSAGE__);
    } catch {
      /* ignore */
    }
  }
  if (window.__FBU_OBSERVER__) {
    try {
      window.__FBU_OBSERVER__.disconnect();
    } catch {
      /* ignore */
    }
  }

  window.__FBU_VERSION__ = FBU_VERSION;
  window.__FBU_LOADED__ = true;

  const STATE = {
    friends: new Map(),
    excludedIds: new Set(), // persisted keep-list
    nextSeq: 0, // lower = newer (Facebook friends list order)
    running: false,
    stopRequested: false,
    doneCount: 0,
    delayMs: 5000,
    sessionCache: null,
    friendsDocId: null,
    load: {
      status: "idle",
      message: "Waiting…",
      cursor: null,
      hasNextPage: true,
      pagesLoaded: 0,
      loading: false,
    },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isFriendsPage() {
    return /facebook\.com\/friends/i.test(location.href);
  }

  function broadcast(type, payload = {}) {
    chrome.runtime.sendMessage({ source: "fbu-content", type, ...payload }).catch(() => {});
  }

  function log(message, level = "info") {
    broadcast("LOG", { message, level });
  }

  function getStats() {
    let selected = 0;
    let excluded = 0;
    let numericIds = 0;
    for (const f of STATE.friends.values()) {
      if (f.selected) selected += 1;
      if (f.excluded) excluded += 1;
      if (/^\d+$/.test(String(f.numericId || f.id))) numericIds += 1;
    }
    return {
      total: STATE.friends.size,
      selected,
      excluded,
      done: STATE.doneCount,
      numericIds,
    };
  }

  function getFriendsPayload() {
    // Newest first (same as Facebook friends list) — seq ascending
    return [...STATE.friends.values()]
      .map((f) => ({
        id: f.id,
        numericId: f.numericId || null,
        name: f.name,
        selected: Boolean(f.selected),
        excluded: Boolean(f.excluded),
        done: Boolean(f.done),
        seq: f.seq ?? 0,
      }))
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  function getLoadState() {
    return { ...STATE.load, total: STATE.friends.size };
  }

  function setLoadState(patch) {
    Object.assign(STATE.load, patch);
    broadcast("LOAD_STATE", { load: getLoadState(), stats: getStats(), friends: getFriendsPayload() });
  }

  function pushFriendsUpdate(reason = "update") {
    broadcast("FRIENDS", {
      reason,
      friends: getFriendsPayload(),
      stats: getStats(),
      load: getLoadState(),
    });
  }

  function pushStats() {
    broadcast("STATS", { stats: getStats(), load: getLoadState() });
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function extractFbDtsgFromHtml(html) {
    const patterns = [
      /"DTSGInitialData",\[],\{"token":"([^"]+)"/,
      /"dtsg"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/,
      /"DTSGInitData",\[],\{"token":"([^"]+)"/,
      /name="fb_dtsg"\s+value="([^"]+)"/,
      /"token":"([A-Za-z0-9:_-]{10,})","async_get_token"/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
    return null;
  }

  function getFbDtsg() {
    const input = document.querySelector('input[name="fb_dtsg"]');
    if (input?.value) return input.value;
    const fromDom = extractFbDtsgFromHtml(document.documentElement.innerHTML);
    if (fromDom) return fromDom;
    for (const script of document.scripts) {
      const t = script.textContent || "";
      if (!t.includes("dtsg") && !t.includes("DTSG")) continue;
      const token = extractFbDtsgFromHtml(t);
      if (token) return token;
    }
    return null;
  }

  function getJazoest(dtsg) {
    let sum = 0;
    for (let i = 0; i < dtsg.length; i += 1) sum += dtsg.charCodeAt(i);
    return `2${sum}`;
  }

  function getSession(force = false) {
    if (!force && STATE.sessionCache && Date.now() - STATE.sessionCache.checkedAt < 5000) {
      return STATE.sessionCache;
    }

    const userId = getCookie("c_user");
    // xs is often HttpOnly — invisible to document.cookie, but still sent with fetch
    const fbDtsg = getFbDtsg();
    const loggedIn = Boolean(userId);
    const ok = Boolean(userId && fbDtsg);

    let status = "ok";
    let message = "Session OK — ready to unfriend via API";
    if (!loggedIn) {
      status = "err";
      message = "Not logged in — open Facebook and log in";
    } else if (!fbDtsg) {
      status = "warn";
      message = "Logged in but fb_dtsg missing — refresh the page";
    }

    STATE.sessionCache = {
      ok,
      status,
      message,
      loggedIn,
      userId: userId || null,
      fbDtsg: fbDtsg || null,
      checkedAt: Date.now(),
    };
    return STATE.sessionCache;
  }

  function parseFbAjax(text) {
    if (!text) return { raw: "", json: null, all: [] };
    const cleaned = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/gm, "").trim();
    const chunks = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
    const all = [];
    for (const chunk of chunks) {
      try {
        all.push(JSON.parse(chunk));
      } catch {
        /* skip */
      }
    }
    if (!all.length) {
      try {
        all.push(JSON.parse(cleaned));
      } catch {
        return { raw: text, json: null, all: [] };
      }
    }
    return { raw: text, json: all[0], all };
  }

  function discoverFriendsDocIds() {
    const found = new Set();
    const html = document.documentElement.innerHTML;
    const patterns = [
      /FriendingCometFriendsListPaginationQuery["'\s,\]]{0,160}?"(\d{15,20})"/g,
      /"id":"(\d{15,20})"[\s\S]{0,160}?FriendingCometFriendsListPaginationQuery/g,
      /FriendingCometAllFriendsAppCollectionPageContentQuery["'\s,\]]{0,160}?"(\d{15,20})"/g,
      /FriendsListContentPaginationQuery["'\s,\]]{0,160}?"(\d{15,20})"/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(html))) {
        if (m[1]) found.add(m[1]);
      }
    }
    // Historical fallbacks
    ["4268740419836267", "4846296485450722", "5093403020742540"].forEach((id) => found.add(id));
    if (STATE.friendsDocId) found.add(STATE.friendsDocId);
    return [...found];
  }

  function normalizeName(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function rekeyFriend(friend, newKey) {
    const oldKey = friend.id;
    if (!newKey || oldKey === newKey) return;
    STATE.friends.delete(oldKey);
    friend.id = newKey;
    STATE.friends.set(newKey, friend);
    if (STATE.excludedIds.has(oldKey)) {
      STATE.excludedIds.delete(oldKey);
      STATE.excludedIds.add(newKey);
      saveExcludedToStorage();
    }
  }

  function findFriendMatch({ id, numericId, name }) {
    const nid =
      numericId && /^\d+$/.test(String(numericId))
        ? String(numericId)
        : id && /^\d+$/.test(String(id))
          ? String(id)
          : null;
    const vanity = id && !/^\d+$/.test(String(id)) ? String(id) : null;

    if (nid) {
      if (STATE.friends.has(nid)) return STATE.friends.get(nid);
      for (const f of STATE.friends.values()) {
        if (String(f.numericId) === nid || String(f.id) === nid) return f;
      }
    }
    if (vanity && STATE.friends.has(vanity)) return STATE.friends.get(vanity);

    const n = normalizeName(name);
    if (n.length >= 2) {
      for (const f of STATE.friends.values()) {
        if (normalizeName(f.name) !== n) continue;
        // Same display name: merge vanity-only with numeric (or two nameless-id rows)
        if (nid && !f.numericId) return f;
        if (!nid && f.numericId) return f;
        if (!nid && !f.numericId) return f;
        if (nid && f.numericId && String(f.numericId) === nid) return f;
      }
    }
    return null;
  }

  function upsertFriend({ id, numericId, name, seq }) {
    if (!id && !numericId) return false;

    const nid =
      numericId && /^\d+$/.test(String(numericId))
        ? String(numericId)
        : id && /^\d+$/.test(String(id))
          ? String(id)
          : null;
    const rawId = id ? String(id) : null;
    const key = nid || rawId;
    if (!key) return false;

    let friend = findFriendMatch({ id: rawId, numericId: nid, name });
    const shouldExclude =
      STATE.excludedIds.has(key) ||
      (nid && STATE.excludedIds.has(nid)) ||
      (rawId && STATE.excludedIds.has(rawId));

    if (!friend) {
      const assignedSeq = typeof seq === "number" ? seq : STATE.nextSeq++;
      if (typeof seq === "number" && seq >= STATE.nextSeq) {
        STATE.nextSeq = seq + 1;
      }
      friend = {
        id: key,
        numericId: nid,
        name: name || key,
        selected: false,
        excluded: Boolean(shouldExclude),
        done: false,
        processing: false,
        seq: assignedSeq,
        row: null,
        checkEl: null,
      };
      STATE.friends.set(key, friend);
      return true;
    }

    // Merge into existing — prefer numeric id as canonical key
    if (nid) {
      friend.numericId = nid;
      if (friend.id !== nid) rekeyFriend(friend, nid);
    }
    if (name && normalizeName(name).length >= 2) {
      if (!friend.name || friend.name === friend.id || friend.name.length < name.length) {
        friend.name = name;
      }
    }
    // Keep the earliest seq (newer position in Facebook list)
    if (typeof seq === "number" && (friend.seq == null || seq < friend.seq)) {
      friend.seq = seq;
    }
    if (shouldExclude) {
      friend.excluded = true;
      friend.selected = false;
    }
    return false;
  }

  // Remove same-person duplicates (one with ID, one without / vanity)
  function dedupeFriends() {
    const byName = new Map();
    const removeKeys = [];

    for (const friend of STATE.friends.values()) {
      const n = normalizeName(friend.name);
      if (!n || n === normalizeName(friend.id)) {
        // Skip pure-id names for name-merge unless numeric
        if (friend.numericId) {
          // still index numeric-only later
        } else {
          continue;
        }
      }
      if (!n) continue;

      const existing = byName.get(n);
      if (!existing) {
        byName.set(n, friend);
        continue;
      }

      // Prefer the row that has numericId
      const preferNew =
        (!existing.numericId && friend.numericId) ||
        (Boolean(friend.numericId) &&
          Boolean(existing.numericId) &&
          String(friend.numericId) === String(existing.numericId));

      const keep = preferNew ? friend : existing;
      const drop = preferNew ? existing : friend;

      keep.selected = keep.selected || drop.selected;
      keep.excluded = keep.excluded || drop.excluded;
      keep.done = keep.done || drop.done;
      if (!keep.numericId && drop.numericId) keep.numericId = drop.numericId;
      // Keep newer position (smaller seq)
      keep.seq = Math.min(keep.seq ?? 1e15, drop.seq ?? 1e15);
      if (keep.numericId && keep.id !== keep.numericId) {
        rekeyFriend(keep, keep.numericId);
      }
      removeKeys.push(drop.id);
      byName.set(n, keep);
    }

    for (const key of removeKeys) {
      STATE.friends.delete(key);
    }

    // Second pass: same numericId stored under different map keys
    const byNumeric = new Map();
    const remove2 = [];
    for (const friend of STATE.friends.values()) {
      if (!friend.numericId) continue;
      const nid = String(friend.numericId);
      const existing = byNumeric.get(nid);
      if (!existing) {
        byNumeric.set(nid, friend);
        if (friend.id !== nid) rekeyFriend(friend, nid);
        continue;
      }
      existing.selected = existing.selected || friend.selected;
      existing.excluded = existing.excluded || friend.excluded;
      existing.done = existing.done || friend.done;
      existing.seq = Math.min(existing.seq ?? 1e15, friend.seq ?? 1e15);
      if (normalizeName(friend.name).length > normalizeName(existing.name).length) {
        existing.name = friend.name;
      }
      remove2.push(friend.id);
    }
    for (const key of remove2) STATE.friends.delete(key);

    return removeKeys.length + remove2.length;
  }

  async function loadExcludedFromStorage() {
    try {
      const data = await chrome.storage.local.get(["fbuExcludedIds"]);
      const ids = Array.isArray(data.fbuExcludedIds) ? data.fbuExcludedIds : [];
      STATE.excludedIds = new Set(ids.map(String));
      for (const f of STATE.friends.values()) {
        if (
          STATE.excludedIds.has(String(f.id)) ||
          (f.numericId && STATE.excludedIds.has(String(f.numericId)))
        ) {
          f.excluded = true;
          f.selected = false;
        }
      }
    } catch {
      /* ignore */
    }
  }

  async function saveExcludedToStorage() {
    try {
      await chrome.storage.local.set({ fbuExcludedIds: [...STATE.excludedIds] });
    } catch {
      /* ignore */
    }
  }

  function findAllFriendsConnection(obj, depth = 0) {
    if (!obj || depth > 10) return null;
    if (obj.all_friends?.edges) return obj.all_friends;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findAllFriendsConnection(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof obj === "object") {
      for (const value of Object.values(obj)) {
        const found = findAllFriendsConnection(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function seedFriendsFromHtml() {
    const html = document.documentElement.innerHTML;
    let added = 0;

    // Pattern: "id":"123","name":"Someone"
    const re = /"id":"(\d{5,})","(?:__typename":"User",)?"?name":"([^"\\]{1,120})"/g;
    let m;
    while ((m = re.exec(html))) {
      const id = m[1];
      const name = m[2].replace(/\\u([\dA-Fa-f]{4})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16))
      );
      if (upsertFriend({ id, numericId: id, name })) added += 1;
    }

    // all_friends edges style
    const re2 = /"node":\{"id":"(\d{5,})"[\s\S]{0,200}?"name":"([^"\\]{1,120})"/g;
    while ((m = re2.exec(html))) {
      const id = m[1];
      const name = m[2].replace(/\\u([\dA-Fa-f]{4})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16))
      );
      if (upsertFriend({ id, numericId: id, name })) added += 1;
    }

    return added;
  }

  function seedFriendsFromDom() {
    let added = 0;
    const roots = [
      document.querySelector('[role="main"]'),
      document.querySelector("#friends_center_main"),
      document.body,
    ].filter(Boolean);

    for (const root of roots) {
      const links = root.querySelectorAll('a[href*="facebook.com/"], a[href^="/"]');
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        if (/\/friends\b/i.test(href)) continue;
        if (/\/(photo|video|posts|photos|reel|watch|stories|groups|pages)\b/i.test(href)) continue;

        let id = null;
        try {
          const url = new URL(href, location.origin);
          if (/profile\.php/i.test(url.pathname)) id = url.searchParams.get("id");
          else {
            const parts = url.pathname.split("/").filter(Boolean);
            if (parts[0] && !["watch", "reel", "groups", "pages", "marketplace"].includes(parts[0])) {
              id = parts[0];
            }
          }
        } catch {
          continue;
        }
        if (!id) continue;

        const name = (
          a.getAttribute("aria-label") ||
          a.textContent ||
          a.querySelector("img, image")?.getAttribute("aria-label") ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ");
        if (!name || name.length < 2 || name.length > 120) continue;
        // Prefer rows that look like people (avatar or name link)
        const hasImg = Boolean(a.querySelector("img, image"));
        if (!hasImg && name.split(" ").length < 1) continue;

        const numericId = /^\d+$/.test(id) ? id : null;
        // Skip obvious non-person vanity paths
        if (!numericId && /^(privacy|help|settings|login|reg|recover)$/i.test(id)) continue;

        // If this name already exists with a numeric ID, skip vanity-only duplicate
        if (!numericId) {
          const n = normalizeName(name);
          let existsWithId = false;
          for (const f of STATE.friends.values()) {
            if (normalizeName(f.name) === n && f.numericId) {
              existsWithId = true;
              break;
            }
          }
          if (existsWithId) continue;
        }

        if (upsertFriend({ id: numericId || id, numericId, name })) added += 1;
      }
    }
    return added;
  }

  function findScrollableFriendsContainer() {
    const main = document.querySelector('[role="main"]') || document.body;
    const candidates = [main, ...main.querySelectorAll("div")].filter(Boolean);
    let best = document.scrollingElement || document.documentElement;
    let bestScore = 0;
    for (const el of candidates.slice(0, 400)) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (!/(auto|scroll)/.test(overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 80) continue;
      const score = el.scrollHeight + el.clientHeight;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  async function autoScrollAndScrapeFriends() {
    const scroller = findScrollableFriendsContainer();
    let stableRounds = 0;
    let lastCount = STATE.friends.size;

    for (let i = 0; i < 60 && stableRounds < 5; i += 1) {
      seedFriendsFromDom();
      dedupeFriends();
      setLoadState({
        status: "loading",
        message: `Auto-loading friends… ${STATE.friends.size} found (scan ${i + 1})`,
        loading: true,
      });
      pushFriendsUpdate("scroll-scan");

      try {
        scroller.scrollTop = scroller.scrollTop + Math.max(700, scroller.clientHeight * 0.9);
      } catch {
        window.scrollBy(0, 900);
      }
      await sleep(700);

      if (STATE.friends.size <= lastCount) stableRounds += 1;
      else {
        stableRounds = 0;
        lastCount = STATE.friends.size;
      }
    }
  }

  async function fetchFriendsPage(session, cursor, docId, friendlyName) {
    const variables = {
      count: 50,
      cursor: cursor || null,
      scale: 1,
    };

    const body = new URLSearchParams({
      fb_dtsg: session.fbDtsg,
      jazoest: getJazoest(session.fbDtsg),
      __user: session.userId,
      __a: "1",
      __req: Math.random().toString(36).slice(2, 5),
      dpr: "1",
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: friendlyName,
      variables: JSON.stringify(variables),
      doc_id: docId,
      server_timestamps: "true",
    });

    const res = await fetch("https://www.facebook.com/api/graphql/", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-FB-Friendly-Name": friendlyName,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
    });

    const text = await res.text();
    const parsed = parseFbAjax(text);
    if (!parsed.json && !parsed.all.length) {
      throw new Error(`Invalid GraphQL response (HTTP ${res.status})`);
    }

    for (const json of parsed.all.length ? parsed.all : [parsed.json]) {
      if (json?.errors?.length) {
        throw new Error(json.errors[0]?.message || "GraphQL error");
      }
      const conn = json?.data?.viewer?.all_friends || findAllFriendsConnection(json);
      if (!conn) continue;

      const edges = conn.edges || [];
      const pageInfo = conn.page_info || {};
      const friends = [];
      for (const edge of edges) {
        const node = edge?.node;
        if (!node) continue;
        const id = String(node.id || node.userID || "");
        if (!id) continue;
        friends.push({
          id,
          numericId: /^\d+$/.test(id) ? id : null,
          name: node.name || node.short_name || id,
        });
      }
      STATE.friendsDocId = docId;
      return {
        friends,
        cursor: pageInfo.end_cursor || null,
        hasNextPage: Boolean(pageInfo.has_next_page),
      };
    }

    throw new Error("Friends connection not found in API response");
  }

  async function tryGraphqlFriends(session) {
    const docIds = discoverFriendsDocIds();
    const names = [
      "FriendingCometFriendsListPaginationQuery",
      "FriendingCometAllFriendsAppCollectionPageContentQuery",
    ];
    let lastErr = "GraphQL failed";
    let cursor = STATE.load.cursor;
    let hasNext = true;
    let pages = 0;
    let working = null;

    // Discover a working doc_id on first page
    for (const name of names) {
      for (const docId of docIds) {
        try {
          const page = await fetchFriendsPage(session, null, docId, name);
          working = { docId, name };
          let added = 0;
          let seq = STATE.nextSeq;
          for (const f of page.friends) {
            if (upsertFriend({ ...f, seq })) added += 1;
            seq += 1;
          }
          STATE.nextSeq = seq;
          pages = 1;
          cursor = page.cursor;
          hasNext = page.hasNextPage && page.friends.length > 0;
          STATE.load.pagesLoaded = pages;
          STATE.load.cursor = cursor;
          STATE.load.hasNextPage = hasNext;
          dedupeFriends();
          pushFriendsUpdate("graphql-page");
          log(`GraphQL OK (${name}/${docId}): +${added}, total ${STATE.friends.size}`, "ok");
          break;
        } catch (err) {
          lastErr = err.message;
        }
      }
      if (working) break;
    }

    if (!working) throw new Error(lastErr);

    while (hasNext && pages < 200) {
      setLoadState({
        status: "loading",
        message: `Loading friends via API… page ${pages + 1} (${STATE.friends.size} found)`,
        loading: true,
      });
      const page = await fetchFriendsPage(session, cursor, working.docId, working.name);
      let added = 0;
      let seq = STATE.nextSeq;
      for (const f of page.friends) {
        if (upsertFriend({ ...f, seq })) added += 1;
        seq += 1;
      }
      STATE.nextSeq = seq;
      pages += 1;
      cursor = page.cursor;
      hasNext = page.hasNextPage && page.friends.length > 0;
      STATE.load.pagesLoaded = pages;
      STATE.load.cursor = cursor;
      STATE.load.hasNextPage = hasNext;
      dedupeFriends();
      pushFriendsUpdate("graphql-page");
      log(`API page ${pages}: +${added} (total ${STATE.friends.size})`, "info");
      if (!hasNext) break;
      await sleep(350);
    }
    return pages;
  }

  async function fetchFriendsTypeahead(session) {
    const url =
      `https://www.facebook.com/ajax/typeahead/first_degree.php` +
      `?viewer=${encodeURIComponent(session.userId)}` +
      `&token=v7&filter[0]=user&options[0]=friends_only&options[1]=nm` +
      `&__user=${encodeURIComponent(session.userId)}&__a=1`;

    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    const text = await res.text();
    const parsed = parseFbAjax(text);
    const entries = parsed.json?.payload?.entries || [];
    const list = Array.isArray(entries) ? entries : [];
    const friends = [];
    for (const entry of list) {
      const id = String(entry.uid || entry.id || "");
      if (!id) continue;
      friends.push({
        id,
        numericId: /^\d+$/.test(id) ? id : null,
        name: entry.text || entry.name || id,
      });
    }
    return friends;
  }

  async function autoLoadAllFriends(restart = false) {
    if (STATE.load.loading) {
      return {
        ok: true,
        load: getLoadState(),
        stats: getStats(),
        friends: getFriendsPayload(),
        session: getSession(),
      };
    }

    const session = getSession(true);
    if (!session.ok) {
      setLoadState({ status: "error", message: session.message, loading: false });
      return { ok: false, error: session.message, session, load: getLoadState(), friends: getFriendsPayload() };
    }

    if (restart) {
      STATE.friends.clear();
      STATE.nextSeq = 0;
      STATE.load.cursor = null;
      STATE.load.hasNextPage = true;
      STATE.load.pagesLoaded = 0;
      STATE.doneCount = 0;
      // Keep STATE.excludedIds so Select All still skips saved Keep list
    }

    STATE.load.loading = true;
    setLoadState({
      status: "loading",
      message: "Loading friends (newest first)…",
      loading: true,
    });

    try {
      // 1) GraphQL first — Facebook returns newest friends first
      try {
        await tryGraphqlFriends(session);
      } catch (err) {
        log(`GraphQL friends failed: ${err.message}`, "err");
        try {
          const fallback = await fetchFriendsTypeahead(session);
          let added = 0;
          let seq = STATE.nextSeq;
          for (const f of fallback) {
            if (upsertFriend({ ...f, seq })) added += 1;
            seq += 1;
          }
          STATE.nextSeq = seq;
          log(`Typeahead fallback: +${added}`, added ? "ok" : "err");
          pushFriendsUpdate("typeahead");
        } catch (err2) {
          log(`Typeahead failed: ${err2.message}`, "err");
        }
      }

      // 2) Fill gaps from page HTML / visible DOM (append only — keeps API order)
      const htmlAdded = seedFriendsFromHtml();
      dedupeFriends();
      const domAdded = seedFriendsFromDom();
      const removed = dedupeFriends();
      pushFriendsUpdate("seed");
      log(
        `Filled gaps: HTML +${htmlAdded}, DOM +${domAdded}, deduped -${removed} (total ${STATE.friends.size})`,
        "info"
      );

      // 3) Auto-scroll page for more (older friends further down)
      log("Auto-scanning friends page for more…", "info");
      await autoScrollAndScrapeFriends();
      const removedFinal = dedupeFriends();
      if (removedFinal) log(`Removed ${removedFinal} duplicate friend row(s)`, "info");
      pushFriendsUpdate("dedupe-final");

      STATE.load.loading = false;
      STATE.load.hasNextPage = false;
      const total = STATE.friends.size;
      setLoadState({
        status: total > 0 ? "complete" : "error",
        message:
          total > 0
            ? `Loaded ${total} friends`
            : "No friends found — open /friends/list, wait for list, then Reload",
        loading: false,
      });
      pushFriendsUpdate("load-complete");

      return {
        ok: total > 0,
        error: total > 0 ? undefined : "No friends found",
        load: getLoadState(),
        stats: getStats(),
        friends: getFriendsPayload(),
        session,
        message: total > 0 ? `Loaded ${total} friends` : "No friends found",
        level: total > 0 ? "ok" : "err",
      };
    } catch (err) {
      STATE.load.loading = false;
      setLoadState({ status: "error", message: `Load failed: ${err.message}`, loading: false });
      pushFriendsUpdate("load-error");
      return {
        ok: false,
        error: err.message,
        load: getLoadState(),
        stats: getStats(),
        friends: getFriendsPayload(),
        session,
      };
    }
  }

  function looksSuccessfulUnfriend(resText, httpOk) {
    if (!httpOk) return false;
    const lower = (resText || "").toLowerCase();
    if (lower.includes("checkpoint") || lower.includes("login_form")) return false;
    const parsed = parseFbAjax(resText);
    if (parsed.json?.error || parsed.json?.errors) return false;
    return true;
  }

  async function resolveNumericId(friend) {
    if (friend.numericId && /^\d+$/.test(String(friend.numericId))) {
      return String(friend.numericId);
    }
    if (/^\d+$/.test(String(friend.id))) {
      friend.numericId = String(friend.id);
      return friend.numericId;
    }
    return null;
  }

  async function apiUnfriend(numericId, session) {
    const common = {
      fb_dtsg: session.fbDtsg,
      jazoest: getJazoest(session.fbDtsg),
      __user: session.userId,
      __a: "1",
      __req: Math.random().toString(36).slice(2, 5),
      dpr: "1",
    };

    const attempts = [
      {
        name: "removefriendconfirm",
        url: "https://www.facebook.com/ajax/profile/removefriendconfirm.php",
        body: {
          ...common,
          friend_id: numericId,
          uid: numericId,
          unref: "bd_profile_button",
          confirmed: "1",
        },
      },
      {
        name: "remove_friend",
        url: "https://www.facebook.com/friends/ajax/remove_friend.php",
        body: {
          ...common,
          friend: numericId,
          type: "friend",
        },
      },
    ];

    let lastError = "All API endpoints failed";
    for (const attempt of attempts) {
      try {
        const res = await fetch(attempt.url, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: new URLSearchParams(attempt.body).toString(),
        });
        const text = await res.text();
        const parsed = parseFbAjax(text);
        if (parsed.json?.error || parsed.json?.errors) {
          lastError = `${attempt.name}: ${JSON.stringify(parsed.json.error || parsed.json.errors)}`;
          continue;
        }
        if (looksSuccessfulUnfriend(text, res.ok)) {
          return { ok: true, endpoint: attempt.name };
        }
        lastError = `${attempt.name}: HTTP ${res.status}`;
      } catch (err) {
        lastError = `${attempt.name}: ${err.message}`;
      }
    }
    return { ok: false, error: lastError };
  }

  function selectAll() {
    for (const f of STATE.friends.values()) {
      if (f.excluded || f.done) continue;
      f.selected = true;
    }
    pushFriendsUpdate("select-all");
    pushStats();
    return getStats();
  }

  function unselectAll() {
    for (const f of STATE.friends.values()) {
      f.selected = false;
    }
    pushFriendsUpdate("unselect-all");
    pushStats();
    return getStats();
  }

  function setFriendSelected(id, selected) {
    const friend = STATE.friends.get(String(id));
    if (!friend) return false;
    if (friend.excluded || friend.done) {
      friend.selected = false;
    } else {
      friend.selected = Boolean(selected);
    }
    pushFriendsUpdate("select-one");
    pushStats();
    return true;
  }

  function setFriendExcluded(id, excluded) {
    const friend = STATE.friends.get(String(id));
    if (!friend) return false;
    friend.excluded = Boolean(excluded);
    if (friend.excluded) {
      friend.selected = false;
      STATE.excludedIds.add(String(friend.id));
      if (friend.numericId) STATE.excludedIds.add(String(friend.numericId));
    } else {
      STATE.excludedIds.delete(String(friend.id));
      if (friend.numericId) STATE.excludedIds.delete(String(friend.numericId));
    }
    saveExcludedToStorage();
    pushFriendsUpdate("exclude-one");
    pushStats();
    return true;
  }

  function clearAllExcluded() {
    STATE.excludedIds.clear();
    for (const f of STATE.friends.values()) {
      f.excluded = false;
    }
    saveExcludedToStorage();
    pushFriendsUpdate("clear-excludes");
    pushStats();
    return getStats();
  }

  async function unfriendOne(friend, session) {
    friend.processing = true;
    const numericId = await resolveNumericId(friend);
    if (!numericId) {
      friend.processing = false;
      throw new Error(`Cannot resolve numeric ID for ${friend.name}`);
    }
    log(`API unfriend ${friend.name} (id=${numericId})`, "info");
    const result = await apiUnfriend(numericId, session);
    if (!result.ok) {
      friend.processing = false;
      throw new Error(result.error || "API unfriend failed");
    }
    log(`Done via ${result.endpoint}: ${friend.name}`, "ok");
    friend.done = true;
    friend.selected = false;
    friend.processing = false;
    STATE.doneCount += 1;
    pushFriendsUpdate("done-one");
  }

  async function startUnfriend(delayMs) {
    if (STATE.running) return { ok: false, error: "Already running" };
    if (STATE.load.loading) {
      return { ok: false, error: "Still loading friends — wait until load completes" };
    }

    const session = getSession(true);
    if (!session.ok) return { ok: false, error: session.message, session };

    STATE.delayMs = delayMs || 5000;
    STATE.stopRequested = false;
    STATE.running = true;
    broadcast("RUNNING", { running: true });
    broadcast("SESSION", { session });

    const queue = [...STATE.friends.values()].filter(
      (f) => f.selected && !f.excluded && !f.done
    );

    if (queue.length === 0) {
      STATE.running = false;
      broadcast("RUNNING", { running: false });
      return {
        ok: true,
        running: false,
        message: "No selected friends to unfriend",
        level: "err",
        stats: getStats(),
        friends: getFriendsPayload(),
        session,
      };
    }

    log(`API batch start: ${queue.length} friend(s), delay ${STATE.delayMs / 1000}s`, "info");

    (async () => {
      for (let i = 0; i < queue.length; i += 1) {
        if (STATE.stopRequested) {
          log("Stopped by user", "info");
          break;
        }
        const sess = getSession(i === 0 || i % 10 === 0);
        if (!sess.ok) {
          log(`Session lost: ${sess.message}`, "err");
          break;
        }
        const friend = queue[i];
        try {
          log(`Unfriending (${i + 1}/${queue.length}): ${friend.name}`, "info");
          await unfriendOne(friend, sess);
          pushStats();
        } catch (err) {
          friend.processing = false;
          log(`Failed: ${friend.name} — ${err.message}`, "err");
          pushFriendsUpdate("fail-one");
          pushStats();
        }
        if (i < queue.length - 1 && !STATE.stopRequested) {
          await sleep(STATE.delayMs);
        }
      }
      STATE.running = false;
      broadcast("RUNNING", { running: false });
      broadcast("DONE_BATCH", {
        message: "Batch finished (API)",
        stats: getStats(),
        friends: getFriendsPayload(),
      });
      pushStats();
    })();

    return {
      ok: true,
      running: true,
      message: `API unfriend started (${queue.length})`,
      level: "info",
      stats: getStats(),
      friends: getFriendsPayload(),
      session,
    };
  }

  function stopUnfriend() {
    STATE.stopRequested = true;
    log("Stop requested…", "info");
    return {
      ok: true,
      running: STATE.running,
      message: "Stopping after current request",
      level: "info",
      stats: getStats(),
      friends: getFriendsPayload(),
    };
  }

  const onMessage = (message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message?.type) {
          case "GET_STATUS": {
            const session = getSession(true);
            sendResponse({
              ok: true,
              onFriendsPage: isFriendsPage(),
              running: STATE.running,
              stats: getStats(),
              friends: getFriendsPayload(),
              load: getLoadState(),
              session,
              version: FBU_VERSION,
            });
            break;
          }
          case "GET_SESSION": {
            sendResponse({ ok: true, session: getSession(true), load: getLoadState() });
            break;
          }
          case "GET_FRIENDS": {
            sendResponse({
              ok: true,
              friends: getFriendsPayload(),
              stats: getStats(),
              load: getLoadState(),
            });
            break;
          }
          case "LOAD_FRIENDS": {
            sendResponse(await autoLoadAllFriends(Boolean(message.restart)));
            break;
          }
          case "SELECT_ALL": {
            const before = getStats().excluded;
            const stats = selectAll();
            sendResponse({
              ok: true,
              message:
                before > 0
                  ? `Selected ${stats.selected} (skipped ${before} excluded)`
                  : `Selected ${stats.selected}`,
              level: "ok",
              stats,
              friends: getFriendsPayload(),
              load: getLoadState(),
            });
            break;
          }
          case "UNSELECT_ALL": {
            const stats = unselectAll();
            sendResponse({
              ok: true,
              message: "Unselected all",
              level: "info",
              stats,
              friends: getFriendsPayload(),
              load: getLoadState(),
            });
            break;
          }
          case "CLEAR_ALL_EXCLUDED": {
            const stats = clearAllExcluded();
            sendResponse({
              ok: true,
              message: "Cleared all excludes",
              level: "info",
              stats,
              friends: getFriendsPayload(),
              load: getLoadState(),
            });
            break;
          }
          case "SET_FRIEND_SELECTED": {
            const ok = setFriendSelected(message.id, message.selected);
            sendResponse({
              ok,
              error: ok ? undefined : "Friend not found",
              stats: getStats(),
              friends: getFriendsPayload(),
            });
            break;
          }
          case "SET_FRIEND_EXCLUDED": {
            const ok = setFriendExcluded(message.id, message.excluded);
            sendResponse({
              ok,
              error: ok ? undefined : "Friend not found",
              stats: getStats(),
              friends: getFriendsPayload(),
            });
            break;
          }
          case "START_UNFRIEND": {
            sendResponse(await startUnfriend(message.delayMs));
            break;
          }
          case "STOP_UNFRIEND": {
            sendResponse(stopUnfriend());
            break;
          }
          case "RESCAN": {
            sendResponse(await autoLoadAllFriends(true));
            break;
          }
          default:
            sendResponse({ ok: false, error: "Unknown message" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  };

  window.__FBU_ON_MESSAGE__ = onMessage;
  chrome.runtime.onMessage.addListener(onMessage);

  // Only check session on load — do NOT auto-scan friends (wait for Rescan click)
  setTimeout(() => {
    const session = getSession(true);
    broadcast("SESSION", { session });
    loadExcludedFromStorage().then(() => {
      setLoadState({
        status: "idle",
        message: session.ok
          ? "Idle — click Reload friends to scan"
          : session.message,
        loading: false,
        hasNextPage: false,
      });
    });
  }, 400);
})();
