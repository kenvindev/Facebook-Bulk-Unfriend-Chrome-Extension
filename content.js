(() => {
  const FBU_VERSION = "1.3.3";

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

  const isUpgrade = window.__FBU_VERSION__ !== FBU_VERSION;
  window.__FBU_VERSION__ = FBU_VERSION;
  window.__FBU_LOADED__ = true;

  // Always keep existing friends list across reinject (Start must never wipe scan results)
  const existingState = window.__FBU_STATE_;
  const hasScannedFriends =
    existingState &&
    existingState.friends instanceof Map &&
    existingState.friends.size > 0;

  const STATE = hasScannedFriends
    ? existingState
    : !isUpgrade && existingState
      ? existingState
      : {
          friends: new Map(),
          excludedIds: new Set(),
          nextSeq: 0,
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

  window.__FBU_STATE__ = STATE;

  // Only show idle hint on true first boot with empty list — never after a scan
  const shouldBootIdle =
    !window.__FBU_BOOTED__ && STATE.friends.size === 0 && STATE.load.status === "idle";
  window.__FBU_BOOTED__ = true;

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
        hasAvatar: f.hasAvatar === true,
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

  function upsertFriend({ id, numericId, name, seq, href, hasAvatar }) {
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
        href: href || null,
        hasAvatar: hasAvatar === true,
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
    if (href && !friend.href) friend.href = href;
    if (hasAvatar === true) friend.hasAvatar = true;
    if (hasAvatar === false && friend.hasAvatar !== true) friend.hasAvatar = false;
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

  function detectHasAvatar(root) {
    if (!root?.querySelectorAll) return false;
    const imgs = root.querySelectorAll("img, image");
    for (const img of imgs) {
      const src =
        img.getAttribute("src") ||
        img.getAttribute("xlink:href") ||
        img.getAttribute("href") ||
        "";
      if (!src) continue;
      // Static FB resources / silhouettes / loaders — not a real profile photo
      if (/rsrc\.php|static\.xx\.fbcdn|animated_loading|safe_image\.php\?d=|\/images\/icons/i.test(src)) {
        continue;
      }
      if (/scontent|fbcdn\.net/i.test(src)) return true;
      if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(src)) return true;
    }
    return false;
  }

  function shouldUseMoreUiOnly(friend) {
    const hasId = Boolean(friend.numericId && /^\d+$/.test(String(friend.numericId)));
    const hasAvatar = friend.hasAvatar === true;
    // Deleted/locked accounts: usually no avatar and/or no reliable ID
    return !hasId || !hasAvatar;
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

        // Climb to row and prefer numeric id from hovercard / profile.php?id=
        let row = a.parentElement;
        for (let i = 0; i < 8 && row; i += 1) {
          const h = row.getBoundingClientRect?.().height || 0;
          if (h >= 48 && h <= 360) break;
          row = row.parentElement;
        }
        const fromRow = extractNumericFromRow(row || a.parentElement);
        let numericId = /^\d+$/.test(id) ? id : fromRow;
        if (!numericId && /^\d+$/.test(id)) numericId = id;

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

        if (upsertFriend({
          id: numericId || id,
          numericId,
          name,
          href: a.href,
          hasAvatar: detectHasAvatar(row || a),
        })) {
          added += 1;
        }
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
        hasAvatar: Boolean(
          (node.profile_picture?.uri || node.profilePicture?.uri || "") &&
            !/rsrc\.php/i.test(node.profile_picture?.uri || node.profilePicture?.uri || "")
        ),
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
    const analysis = analyzeUnfriendResponse(resText, httpOk);
    return analysis.ok && !analysis.needVerify;
  }

  function analyzeUnfriendResponse(text, httpOk) {
    if (!httpOk) return { ok: false, needVerify: false, error: "HTTP request failed" };
    const raw = text || "";
    const lower = raw.toLowerCase();
    if (lower.includes("checkpoint") || lower.includes("login_form")) {
      return { ok: false, needVerify: false, error: "Facebook checkpoint / login required" };
    }

    const parsed = parseFbAjax(raw);
    const json = parsed.json;
    if (!json) {
      return { ok: false, needVerify: false, error: "Empty/non-JSON response" };
    }

    if (json.error || json.errors) {
      return {
        ok: false,
        needVerify: false,
        error: JSON.stringify(json.error || json.errors).slice(0, 180),
      };
    }
    if (json.errorSummary || json.errorDescription) {
      return {
        ok: false,
        needVerify: false,
        error: String(json.errorSummary || json.errorDescription),
      };
    }

    if (json.data) {
      const blob = JSON.stringify(json.data);
      if (/\"error_code\"|\"error_message\"/i.test(blob)) {
        return { ok: false, needVerify: false, error: "GraphQL data contains error" };
      }
      return { ok: true, needVerify: true, error: null };
    }

    // Classic AJAX often returns opaque {__ar:1,payload:null} even when nothing changed
    if ("payload" in json || "__ar" in json || "jsmods" in json) {
      if (json.payload === false) {
        return { ok: false, needVerify: false, error: "payload=false" };
      }
      return { ok: true, needVerify: true, error: null };
    }

    return { ok: false, needVerify: false, error: "Unrecognized response shape" };
  }

  async function verifyStillFriends(numericId) {
    const urls = [
      `https://www.facebook.com/profile.php?id=${encodeURIComponent(numericId)}`,
      `https://www.facebook.com/${encodeURIComponent(numericId)}`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          credentials: "include",
          headers: { Accept: "text/html" },
          redirect: "follow",
        });
        const html = await res.text();
        if (!html || html.length < 500) continue;

        if (/"friendship_status"\s*:\s*"ARE_FRIENDS"/i.test(html)) return true;
        if (/"friendship_status"\s*:\s*"CAN_REQUEST"/i.test(html)) return false;
        if (/"friendship_status"\s*:\s*"CANNOT_REQUEST"/i.test(html)) return false;
        if (/"friendship_status"\s*:\s*"OUTGOING_REQUEST"/i.test(html)) return false;
        if (/"friendship_status"\s*:\s*"INCOMING_REQUEST"/i.test(html)) return false;
        if (/"is_viewer_friend"\s*:\s*true/i.test(html)) return true;
        if (/"is_viewer_friend"\s*:\s*false/i.test(html)) return false;

        const hasAdd =
          /aria-label="Add friend"/i.test(html) ||
          /aria-label="Thêm bạn bè"/i.test(html) ||
          /aria-label="Add Friend"/i.test(html);
        const hasFriendsMenu =
          (/aria-label="Friends"/i.test(html) || /aria-label="Bạn bè"/i.test(html)) &&
          (/Unfriend/i.test(html) || /Hủy kết bạn/i.test(html));

        if (hasAdd && !hasFriendsMenu) return false;
        if (hasFriendsMenu) return true;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  function discoverUnfriendDocId() {
    const html = document.documentElement.innerHTML;
    const patterns = [
      /FriendingCometUnfriendMutation["'\s,\]]{0,160}?"(\d{15,20})"/,
      /"id":"(\d{15,20})"[\s\S]{0,120}?FriendingCometUnfriendMutation/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
    return "1000833884483722";
  }

  function extractNumericFromElement(el) {
    if (!el) return null;

    const attrs = [
      el.getAttribute?.("data-hovercard"),
      el.getAttribute?.("href"),
      el.getAttribute?.("ajaxify"),
      el.getAttribute?.("data-gt"),
    ].filter(Boolean);

    for (const val of attrs) {
      let m = String(val).match(/[?&]id=(\d{5,})/);
      if (m) return m[1];
      m = String(val).match(/profile\.php\?id=(\d{5,})/);
      if (m) return m[1];
      m = String(val).match(/user\.php\?id=(\d{5,})/);
      if (m) return m[1];
    }

    try {
      const href = el.getAttribute?.("href");
      if (href) {
        const u = new URL(href, location.origin);
        const id = u.searchParams.get("id");
        if (id && /^\d+$/.test(id)) return id;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function extractNumericFromRow(row) {
    if (!row) return null;
    let id = extractNumericFromElement(row);
    if (id) return id;

    for (const el of row.querySelectorAll("[href], [data-hovercard], [ajaxify], [data-id]")) {
      id = extractNumericFromElement(el);
      if (id) return id;
      const dataId = el.getAttribute("data-id");
      if (dataId && /^\d{5,}$/.test(dataId)) return dataId;
    }

    const html = row.outerHTML || "";
    const patterns = [
      /profile\.php\?id=(\d{5,})/,
      /user\.php\?id=(\d{5,})/,
      /data-hovercard="[^"]*[?&]id=(\d{5,})/,
      /"userID":"(\d{5,})"/,
      /"entity_id":"(\d{5,})"/,
      /friend_id[=:]"?(\d{5,})/,
      /"id":"(\d{5,})"/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
    return null;
  }

  function findRowByFriendName(name) {
    const target = normalizeName(name);
    if (!target) return null;

    const exact = [];
    const fuzzy = [];
    const nodes = document.querySelectorAll('a[href], [role="link"], span');
    for (const a of nodes) {
      const raw = (a.getAttribute("aria-label") || a.textContent || "").trim();
      if (!raw || raw.length > 80) continue;
      const label = normalizeName(raw);
      if (!label) continue;

      const isExact = label === target;
      const isFuzzy =
        !isExact &&
        label.length >= 4 &&
        target.length >= 4 &&
        (label.includes(target) || target.includes(label));
      if (!isExact && !isFuzzy) continue;

      let node = a;
      let best = null;
      for (let i = 0; i < 12 && node && node !== document.body; i += 1) {
        const rect = node.getBoundingClientRect?.();
        const h = rect?.height || 0;
        const w = rect?.width || 0;
        if (h >= 44 && h <= 220 && w > 160) {
          best = node;
          const hasAction = node.querySelector(
            '[aria-label="More"], [aria-label="Thêm"], [aria-label="Friends"], [aria-label="Bạn bè"], [role="button"]'
          );
          if (hasAction) break;
        }
        node = node.parentElement;
      }
      if (best) (isExact ? exact : fuzzy).push(best);
    }

    const pool = exact.length ? exact : fuzzy;
    pool.sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height);
    return pool[0] || null;
  }

  async function ensureFriendRowVisible(name) {
    let row = findRowByFriendName(name);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "auto" });
      await sleep(300);
      return row;
    }

    const scroller = findScrollableFriendsContainer();
    for (let i = 0; i < 25; i += 1) {
      try {
        scroller.scrollTop += Math.max(500, scroller.clientHeight * 0.8);
      } catch {
        window.scrollBy(0, 700);
      }
      await sleep(450);
      row = findRowByFriendName(name);
      if (row) {
        row.scrollIntoView({ block: "center", behavior: "auto" });
        await sleep(250);
        return row;
      }
    }
    return null;
  }

  function findNumericIdInPageHtml(name) {
    const escaped = String(name)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+");
    const html = document.documentElement.innerHTML;
    const patterns = [
      new RegExp(`"id":"(\\d{5,})"\\s*,\\s*"name":"${escaped}"`, "i"),
      new RegExp(`"name":"${escaped}"\\s*,\\s*"id":"(\\d{5,})"`, "i"),
      new RegExp(`"id":"(\\d{5,})"[\\s\\S]{0,180}?"name":"${escaped}"`, "i"),
      new RegExp(`"name":"${escaped}"[\\s\\S]{0,180}?"id":"(\\d{5,})"`, "i"),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
    return null;
  }

  async function fetchNumericIdFromProfile(vanityOrPath) {
    const vanity = String(vanityOrPath || "")
      .replace(/^https?:\/\/(www\.|m\.)?facebook\.com\//i, "")
      .replace(/\/+$/, "")
      .replace(/^\//, "");
    if (!vanity || /^\d+$/.test(vanity)) return /^\d+$/.test(vanity) ? vanity : null;

    const urls = [
      `https://www.facebook.com/${encodeURI(vanity)}`,
      `https://www.facebook.com/profile.php?id=${encodeURIComponent(vanity)}`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          credentials: "include",
          headers: { Accept: "text/html" },
          redirect: "follow",
        });
        const html = await res.text();
        const patterns = [
          /"userID":"(\d{5,})"/,
          /"userID":(\d{5,})/,
          /"profile_owner":\{"id":"(\d{5,})"/,
          /"entity_id":"(\d{5,})"/,
          /profile_id=(\d{5,})/,
          /"user_id":"(\d{5,})"/,
          /content="fb:\/\/profile\/(\d{5,})"/,
          /"actorID":"(\d{5,})"/,
        ];
        for (const re of patterns) {
          const m = html.match(re);
          if (m?.[1] && m[1] !== getCookie("c_user")) return m[1];
        }
      } catch {
        /* try next */
      }
    }
    return null;
  }

  async function resolveNumericId(friend) {
    if (friend.numericId && /^\d+$/.test(String(friend.numericId))) {
      return String(friend.numericId);
    }
    if (/^\d+$/.test(String(friend.id))) {
      friend.numericId = String(friend.id);
      return friend.numericId;
    }

    // 1) Find row on friends list page by name
    const row = findRowByFriendName(friend.name);
    if (row) {
      const fromRow = extractNumericFromRow(row);
      if (fromRow) {
        friend.numericId = fromRow;
        if (friend.id !== fromRow) {
          try {
            rekeyFriend(friend, fromRow);
          } catch {
            friend.id = fromRow;
          }
        }
        return fromRow;
      }
    }

    // 2) Search embedded page JSON by name
    const fromHtml = findNumericIdInPageHtml(friend.name);
    if (fromHtml) {
      friend.numericId = fromHtml;
      return fromHtml;
    }

    // 3) Vanity username / profile path → fetch profile HTML
    if (friend.id && !/^\d+$/.test(String(friend.id))) {
      const fromProfile = await fetchNumericIdFromProfile(friend.id);
      if (fromProfile) {
        friend.numericId = fromProfile;
        try {
          rekeyFriend(friend, fromProfile);
        } catch {
          friend.id = fromProfile;
        }
        return fromProfile;
      }
    }

    if (friend.href) {
      try {
        const u = new URL(friend.href, location.origin);
        const idParam = u.searchParams.get("id");
        if (idParam && /^\d+$/.test(idParam)) {
          friend.numericId = idParam;
          return idParam;
        }
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts[0] && !/^\d+$/.test(parts[0])) {
          const fromProfile = await fetchNumericIdFromProfile(parts[0]);
          if (fromProfile) {
            friend.numericId = fromProfile;
            return fromProfile;
          }
        }
      } catch {
        /* ignore */
      }
    }

    return null;
  }

  function clickEl(el) {
    if (!el) return false;
    try {
      el.focus?.();
    } catch {
      /* ignore */
    }
    if (typeof el.click === "function") {
      el.click();
      return true;
    }
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }

  async function dismissOverlaysLight() {
    for (let i = 0; i < 2; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
      );
      await sleep(120);
    }
  }

  // Fallback for accounts with no resolvable ID (placeholder avatar / limited profile)
  async function uiUnfriendByName(friend) {
    await dismissOverlaysLight();
    const row = findRowByFriendName(friend.name);
    if (!row) {
      throw new Error("Row not found — scroll so this person is visible on /friends/list");
    }

    row.scrollIntoView({ block: "center", behavior: "auto" });
    await sleep(350);

    let btn =
      row.querySelector('[aria-label="More"]') ||
      row.querySelector('[aria-label="Thêm"]') ||
      row.querySelector('[aria-label="Friends"]') ||
      row.querySelector('[aria-label="Bạn bè"]') ||
      row.querySelector('[aria-label="See options"]') ||
      row.querySelector('[aria-label="Tùy chọn"]');

    if (!btn) {
      const buttons = [...row.querySelectorAll('[role="button"], button')].filter((el) => {
        if (el.closest(".fbu-controls")) return false;
        const label = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
        if (
          label.includes("bạn chung") ||
          label.includes("mutual") ||
          label.includes("message") ||
          label.includes("nhắn")
        ) {
          return false;
        }
        return true;
      });
      btn = buttons[buttons.length - 1] || null;
    }

    if (!btn) throw new Error("No More/⋯ button in row");

    clickEl(btn);
    await sleep(700);

    const unfriendPatterns = [
      "unfriend",
      "hủy kết bạn",
      "huy ket ban",
      "remove friend",
      "xóa bạn",
      "xoa ban",
    ];

    let menuItem = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !menuItem) {
      const items = [
        ...document.querySelectorAll('[role="menuitem"]'),
        ...document.querySelectorAll('[role="menu"] [role="button"]'),
      ];
      for (const el of items) {
        const text = (el.getAttribute("aria-label") || el.textContent || "")
          .trim()
          .toLowerCase()
          .replace(/\s+/g, " ");
        if (unfriendPatterns.some((p) => text.includes(p))) {
          menuItem = el;
          break;
        }
      }
      if (!menuItem) await sleep(150);
    }

    if (!menuItem) {
      await dismissOverlaysLight();
      throw new Error("Unfriend not in ⋯ menu");
    }

    clickEl(menuItem);
    await sleep(500);

    const confirmDeadline = Date.now() + 2500;
    while (Date.now() < confirmDeadline) {
      const confirmBtn =
        document.querySelector('[aria-label="Confirm"], [aria-label="Xác nhận"]') ||
        [...document.querySelectorAll('[role="dialog"] [role="button"], [role="dialog"] button')].find(
          (el) => {
            const t = (el.textContent || "").trim().toLowerCase();
            return (
              t === "confirm" ||
              t === "xác nhận" ||
              t.includes("confirm") ||
              t.includes("hủy kết bạn")
            );
          }
        );
      if (confirmBtn) {
        clickEl(confirmBtn);
        break;
      }
      await sleep(120);
    }

    await sleep(400);
    await dismissOverlaysLight();
    return true;
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
        name: "graphql_unfriend",
        url: "https://www.facebook.com/api/graphql/",
        body: {
          ...common,
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: "FriendingCometUnfriendMutation",
          variables: JSON.stringify({
            input: {
              source: "friends_list",
              unfriended_user_id: String(numericId),
              actor_id: String(session.userId),
              client_mutation_id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
            },
            scale: 1,
          }),
          doc_id: discoverUnfriendDocId(),
          server_timestamps: "true",
        },
      },
      {
        name: "removefriendconfirm",
        url: "https://www.facebook.com/ajax/profile/removefriendconfirm.php",
        body: {
          ...common,
          friend_id: numericId,
          uid: numericId,
          unref: "bd_profile_button",
          confirmed: "1",
          norefresh: "true",
        },
      },
      {
        name: "remove_friend",
        url: "https://www.facebook.com/friends/ajax/remove_friend.php",
        body: {
          ...common,
          friend: numericId,
          type: "friend",
          confirmed: "1",
        },
      },
    ];

    let lastError = "All API endpoints failed verification";

    for (const attempt of attempts) {
      try {
        const res = await fetch(attempt.url, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-FB-Friendly-Name":
              attempt.name === "graphql_unfriend"
                ? "FriendingCometUnfriendMutation"
                : "XMLHttpRequest",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: new URLSearchParams(attempt.body).toString(),
        });
        const text = await res.text();
        const analysis = analyzeUnfriendResponse(text, res.ok);
        if (!analysis.ok) {
          lastError = `${attempt.name}: ${analysis.error}`;
          continue;
        }

        await sleep(900);
        const stillFriends = await verifyStillFriends(numericId);
        if (stillFriends === true) {
          lastError = `${attempt.name}: fake OK — profile still ARE_FRIENDS`;
          log(`Fake success from ${attempt.name} — still friends`, "err");
          continue;
        }
        if (stillFriends === false) {
          return { ok: true, endpoint: attempt.name, verified: true };
        }

        lastError = `${attempt.name}: could not verify friendship after call`;
        log(`Unverified response from ${attempt.name} — not marking done`, "err");
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
    pushFriendsUpdate("processing");

    // Refresh avatar flag from live row when possible
    const liveRow = findRowByFriendName(friend.name);
    if (liveRow) {
      const liveAvatar = detectHasAvatar(liveRow);
      if (liveAvatar) friend.hasAvatar = true;
      else if (friend.hasAvatar !== true) friend.hasAvatar = false;
    }

    const uiOnly = shouldUseMoreUiOnly(friend);

    if (uiOnly) {
      const reason = !friend.numericId
        ? "no ID"
        : "no avatar (likely deleted/locked)";
      log(`Unfriend via ⋯ More (${reason}): ${friend.name}`, "info");
      try {
        const row = await ensureFriendRowVisible(friend.name);
        if (!row) {
          throw new Error("Person not visible on friends list — scroll to them then retry");
        }
        await uiUnfriendByName(friend);
        friend.done = true;
        friend.selected = false;
        friend.processing = false;
        STATE.doneCount += 1;
        pushFriendsUpdate("done-one");
        log(`Done via More menu: ${friend.name}`, "ok");
        return;
      } catch (err) {
        friend.processing = false;
        throw new Error(err.message || "More menu unfriend failed");
      }
    }

    // Has avatar + numeric ID → API first; More only if API fails
    const numericId = String(friend.numericId);
    log(`API unfriend (avatar+ID): ${friend.name} (id=${numericId})`, "info");
    const result = await apiUnfriend(numericId, session);
    if (!result.ok) {
      log(`API failed for ${friend.name}: ${result.error} — trying ⋯ More`, "err");
      try {
        await ensureFriendRowVisible(friend.name);
        await uiUnfriendByName(friend);
        friend.done = true;
        friend.selected = false;
        friend.processing = false;
        STATE.doneCount += 1;
        pushFriendsUpdate("done-one");
        log(`Done via More menu: ${friend.name}`, "ok");
        return;
      } catch (err) {
        friend.processing = false;
        throw new Error(err.message || result.error || "Unfriend failed");
      }
    }

    log(`Done via ${result.endpoint} (verified): ${friend.name}`, "ok");
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

    log(`Batch start: ${queue.length} friend(s), delay ${STATE.delayMs / 1000}s (API if avatar+ID, else More UI)`, "info");

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
        message: "Batch finished",
        stats: getStats(),
        friends: getFriendsPayload(),
      });
      pushStats();
    })();

    return {
      ok: true,
      running: true,
      message: `Unfriend started (${queue.length})`,
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

  // Only check session on first boot / upgrade — do NOT auto-scan; do NOT reset after Rescan
  if (shouldBootIdle) {
    setTimeout(() => {
      const session = getSession(true);
      broadcast("SESSION", { session });
      loadExcludedFromStorage().then(() => {
        // Preserve completed load if reinjected mid-session after upgrade with empty state
        if (STATE.friends.size > 0) {
          setLoadState({
            status: "complete",
            message: `Loaded ${STATE.friends.size} friends`,
            loading: false,
          });
          return;
        }
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
  }
})();
