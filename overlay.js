(function(){
  const statusEl = document.getElementById('status');
  const messagesEl = document.getElementById('messages');
  const urlSelect = document.getElementById('url-select');
  let gotFirstEvent = false;
  let lastDpsHtml = null;
  // Optional host override from query or user input (ws://...)
  let hostOverride = null;

  function getHostFromQuery() {
    try {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of params.entries()) {
        if (!v) continue;
        const key = (k || '').toLowerCase();
        if (key === 'host_port' || key === 'hostport' || key === 'host') return v;
      }
    } catch (e) {}
    return null;
  }

  // Parse freeform input: accepts ws://... or '?HOST_PORT=ws://...'
  function parseHostInput(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (!s) return null;
    if (s.startsWith('?')) {
      try {
        const params = new URLSearchParams(s.slice(1));
        for (const [k, v] of params.entries()) {
          if (!v) continue;
          const key = (k || '').toLowerCase();
          if (key === 'host_port' || key === 'hostport' || key === 'host') return v;
        }
      } catch (e) {}
      return null;
    }
    // Accept plain HOST_PORT=... text
    const m = s.match(/host_port=([^&\s]+)/i);
    if (m && m[1]) return decodeURIComponent(m[1]);
    // Accept raw ws:// or wss:// URL
    if (s.startsWith('ws://') || s.startsWith('wss://')) return s;
    // Accept host:port and prepend ws://
    if (/^[\w\.-]+:\d+$/.test(s)) return 'ws://' + s;
    return null;
  }

  function setHostOverride(url) {
    if (!url) return;
    hostOverride = url;
    appendMessage('info', 'Host override set: ' + hostOverride);
    try { statusEl.textContent = 'Host: ' + hostOverride; } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    // start connection attempts immediately
    try { autoConnect(); } catch (e) {}
  }

  // initialize hostOverride from page query if present
  try {
    const qh = getHostFromQuery();
    if (qh) {
      hostOverride = qh;
      appendMessage('info', 'Host override from URL: ' + hostOverride);
      try { statusEl.textContent = 'Host: ' + hostOverride; } catch (e) {}
    }
  } catch (e) {}

  // Allow clicking the status text to change the host via prompt
  try {
    if (statusEl) {
      statusEl.style.cursor = 'pointer';
      statusEl.title = 'Click to change WS host';
      statusEl.addEventListener('click', () => {
        const cur = hostOverride || '';
        const input = prompt('Enter WebSocket URL or ?HOST_PORT=ws://host:port', cur);
        const parsed = parseHostInput(input);
        if (parsed) setHostOverride(parsed);
        else if (input !== null) appendMessage('error', 'No valid host found in input');
      });
    }
  } catch (e) {}

  // Update header location when a zone/location is detected
  function updateLocation(name) {
    try {
      const el = document.getElementById('location');
      if (!el) return;
      el.textContent = String(name || '').trim() || 'Unknown Location';
      // expose as title for easy hover-reading
      el.parentElement && (el.parentElement.title = String(name || ''));
    } catch (e) { /* ignore DOM errors */ }
  }

  // Heuristic search for zone/location strings in incoming event payloads
  function findZoneInData(data) {
    if (!data) return null;
    // If an array was provided (e.g. onLogLine often supplies arrays), scan each item
    if (Array.isArray(data)) {
      for (const item of data) {
        const found = findZoneInData(item);
        if (found) return found;
      }
      return null;
    }

    if (typeof data === 'string') {
      // common ACT/FFXIV log text patterns (cover several formats)
      const patterns = [
        /Changed Zone to\s+['"]?(.+?)['"]?\.?$/i,
        /You (?:have )?entered\s+['"]?(.+?)['"]?[\.\!]?$/i,
        /You (?:have )?entered the\s+['"]?(.+?)['"]?[\.\!]?$/i,
        /Zone\s*[:\-]\s*['"]?(.+?)['"]?\.?$/i,
        /zone[:\s-]+(.+)$/i,
        /^(?:\d{2}:){2}\d{2}.*Changed Zone to ['"]?(.+?)['"]?\.?$/i
      ];
      for (const re of patterns) {
        const m = data.match(re);
        if (m && m[1]) return m[1].trim();
      }
      return null;
    }

    if (typeof data === 'object') {
      const keys = ['CurrentZoneName','currentZoneName','CurrentZone','currentZone','current_zone','zone','Zone','ZoneName','zoneName','zone_name','Map','Location','Territory','TerritoryName','mapName','ZoneText','Area','area','MapName','zoneTitle','zone_title'];
      for (const k of keys) {
        if (k in data && typeof data[k] === 'string' && data[k].trim()) return data[k].trim();
      }
      // Recurse into object properties
      for (const k in data) {
        try {
          const v = data[k];
          const found = findZoneInData(v);
          if (found) return found;
        } catch (e) {}
      }
    }
    return null;
  }

  function appendMessage(kind, content) {
    const ts = new Date().toLocaleTimeString();
    let body = content;
    if (typeof content === 'object') {
      try { body = JSON.stringify(content, null, 2); } catch(e) { body = String(content); }
    }
    const text = `[${ts}] ${body}`;
    if (messagesEl) {
      const el = document.createElement('div');
      el.className = 'message ' + (kind || '');
      el.textContent = text;
      messagesEl.insertBefore(el, messagesEl.firstChild);
      // keep list short
      const max = 300;
      while (messagesEl.children.length > max) messagesEl.removeChild(messagesEl.lastChild);
    } else {
      if (kind === 'error') console.error(text); else console.log(text);
    }
  }

  function handleEvent(name, data) {
    appendMessage('event', { event: name, data: data });
    // mark that we've seen an event (used by retry logic)
    gotFirstEvent = true;
    // try to detect zone/location from the payload or event name/log line
    try {
      const zone = findZoneInData(data) || (typeof name === 'string' && findZoneInData(name));
      if (zone) updateLocation(zone);
    } catch (e) { /* ignore detection errors */ }
    // If this looks like combat data, update the DPS panel
    try {
      if (!data) return;
      const lname = (String(name || '')).toLowerCase();
      if (lname.includes('combat') || data.CombatData || data.Combatants || data.Players || data.PlayersList) {
        updateDpsPanel(data);
      }
    } catch (e) {
      // ignore
    }
  }

  // --- DPS panel helpers ---
  function parseNumber(v) {
    if (v === undefined || v === null) return NaN;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      // remove commas
      const n = parseFloat(v.replace(/,/g, ''));
      return isNaN(n) ? NaN : n;
    }
    return NaN;
  }

  function getDpsValue(obj) {
    if (!obj || typeof obj !== 'object') return NaN;
    const keys = ['ENCDPS','EncDPS','encdps','DPS','dps','dps_1','Damage'];
    for (const k of keys) {
      if (k in obj) {
        const n = parseNumber(obj[k]);
        if (!isNaN(n)) return n;
      }
    }
    // try nested fields
    for (const k in obj) {
      if (obj[k] && typeof obj[k] === 'object') {
        const n = getDpsValue(obj[k]);
        if (!isNaN(n)) return n;
      }
    }
    return NaN;
  }

  function getName(obj) {
    if (!obj || typeof obj !== 'object') return undefined;
    const keys = ['Name','name','player','Player','displayName','DisplayName'];
    for (const k of keys) if (k in obj && obj[k]) return String(obj[k]);
    return undefined;
  }

  function normalizeJob(s) {
    if (!s) return '';
    const v = String(s).trim();
    const up = v.toUpperCase();
    if (/^[A-Z]{1,4}$/.test(up)) return up;
    const map = {
      'WHITE MAGE':'WHM','SCHOLAR':'SCH','ASTROLOGIAN':'AST','SAGE':'SGE',
      'PALADIN':'PLD','WARRIOR':'WAR','DARK KNIGHT':'DRK','GUNBREAKER':'GNB',
      'MONK':'MNK','DRAGOON':'DRG','NINJA':'NIN','SAMURAI':'SAM','REAPER':'RPR',
      'BARD':'BRD','MACHINIST':'MCH','DANCER':'DNC','BLACK MAGE':'BLM','SUMMONER':'SMN','RED MAGE':'RDM','BLUE MAGE':'BLU'
    };
    const key = up.replace(/[^A-Z ]+/g, '').replace(/\s+/g, ' ').trim();
    if (map[key]) return map[key];
    const words = v.match(/\b[A-Za-z]/g);
    if (words && words.length) return words.join('').slice(0,3).toUpperCase();
    return up;
  }

  function getJob(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const keys = ['Job','job','ClassJob','ClassJobName','JobName','classJob','jobName','class_job','job_name'];
    for (const k of keys) {
      if (k in obj && obj[k]) {
        const val = String(obj[k]).trim();
        const norm = normalizeJob(val);
        if (norm) return norm;
        return val;
      }
    }
    return '';
  }

  function getRole(obj) {
    // Return 'support' for tanks/healers, 'dps' otherwise
    if (!obj || typeof obj !== 'object') return 'dps';
    const job = (getJob(obj) || '').toUpperCase().trim();
    const tanks = new Set(['PLD','WAR','DRK','GNB']);
    const healers = new Set(['WHM','SCH','AST','SGE']);
    if (tanks.has(job) || healers.has(job)) return 'support';

    // Fallback: explicit flags/role fields some wrappers provide
    if ('IsTank' in obj && (obj.IsTank === true || obj.IsTank === 1 || String(obj.IsTank).toLowerCase() === 'true')) return 'support';
    if ('IsHealer' in obj && (obj.IsHealer === true || obj.IsHealer === 1 || String(obj.IsHealer).toLowerCase() === 'true')) return 'support';
    if ('Role' in obj && typeof obj.Role === 'string') {
      const r = String(obj.Role).toLowerCase();
      if (r.includes('tank') || r.includes('heal')) return 'support';
    }

    // generic fallback: treat as DPS
    return 'dps';
  }

  function isLikelyPlayer(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if ('Job' in obj || 'job' in obj) return true;
    if ('IsPlayer' in obj || 'isPlayer' in obj) return true;
    // fallback: has a name and a non-zero DPS
    const name = getName(obj);
    const dps = getDpsValue(obj);
    if (name && !isNaN(dps)) return true;
    return false;
  }

  function findCombatantsArray(data) {
    if (!data) return null;
    // If payload wraps CombatData
    if (data.CombatData && typeof data.CombatData === 'object') data = data.CombatData;
    const candidateKeys = ['Combatants','combatants','Combatant','combatant','Players','players','Party','party','CombatantList','CombatantsList','CombatantDetails','CombinedCombatant'];
    for (const k of candidateKeys) {
      if (k in data) {
        const v = data[k];
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object') return Object.values(v);
      }
    }
    // If the data itself is an array of objects
    if (Array.isArray(data) && data.length && typeof data[0] === 'object') return data;
    // If it's an object mapping names to objects, try values
    if (typeof data === 'object') {
      const vals = Object.values(data).filter(x => x && typeof x === 'object');
      if (vals.length && vals.every(v => getName(v) || getDpsValue(v))) return vals;
    }
    return null;
  }

  function formatNumber(n) { return (isNaN(n) ? '-' : (Math.round(n*10)/10).toLocaleString()); }

  function updateDpsPanel(data) {
    const panel = document.getElementById('dps-list');
    if (!panel) return;
    const arr = findCombatantsArray(data);
    if (!arr || arr.length === 0) {
      // If we've previously rendered DPS, keep that until a new valid payload arrives.
      if (lastDpsHtml) return;
      panel.innerHTML = '<div class="dps-empty">No combat data</div>';
      return;
    }
    // prefer likely players
    let players = arr.filter(isLikelyPlayer);
    if (!players.length) players = arr.slice(0, 8);
    // map to name/job/dps/role
    const rows = players.map(p => ({ name: getName(p) || 'Unknown', job: getJob(p), dps: getDpsValue(p), role: getRole(p) }));
    // sort by dps desc
    rows.sort((a,b) => (isNaN(b.dps)?0:b.dps) - (isNaN(a.dps)?0:a.dps));
    const total = rows.reduce((s,r) => s + (isNaN(r.dps)?0:r.dps), 0);
    // render two-column layout: Support (tanks/healers) | DPS
    const parts = [];
    parts.push(`<div class="dps-total">Party DPS: ${formatNumber(total)}</div>`);
    parts.push('<div class="dps-columns">');

    const maxDps = rows.length && !isNaN(rows[0].dps) ? rows[0].dps : 1;

    // Support column
    parts.push('<div class="dps-column support"><div class="column-title">Support</div>');
    const supportRows = rows.filter(r => r.role === 'support');
    if (!supportRows.length) {
      parts.push('<div class="dps-empty">No supports</div>');
    } else {
      for (const r of supportRows) {
        const pct = isNaN(r.dps) || maxDps <= 0 ? 0 : Math.round((r.dps / maxDps) * 100);
        const jobHtml = r.job ? `<span class="player-job"> ${escapeHtml(r.job)}</span>` : '';
        parts.push(`<div class="dps-row" style="--bar-pct:${pct}%"><div class="dps-name">${escapeHtml(r.name)}${jobHtml}</div><div class="dps-value">${formatNumber(r.dps)}</div></div>`);
      }
    }
    parts.push('</div>');

    // DPS column
    parts.push('<div class="dps-column dps"><div class="column-title">DPS</div>');
    const dpsRows = rows.filter(r => r.role !== 'support');
    if (!dpsRows.length) {
      parts.push('<div class="dps-empty">No DPS</div>');
    } else {
      for (const r of dpsRows) {
        const pct = isNaN(r.dps) || maxDps <= 0 ? 0 : Math.round((r.dps / maxDps) * 100);
        const jobHtml = r.job ? `<span class="player-job"> ${escapeHtml(r.job)}</span>` : '';
        parts.push(`<div class="dps-row" style="--bar-pct:${pct}%"><div class="dps-name">${escapeHtml(r.name)}${jobHtml}</div><div class="dps-value">${formatNumber(r.dps)}</div></div>`);
      }
    }
    parts.push('</div>');

    parts.push('</div>');
    panel.innerHTML = parts.join('');
    // remember last rendered HTML so we can keep it when no new data is present
    lastDpsHtml = panel.innerHTML;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }

  // Diagnostics: indicate script loaded
  appendMessage('info', 'Overlay script loaded — checking for OverlayPlugin API');

  // Attach handlers when OverlayPlugin API becomes available. Some setups inject
  // the API slightly after the page loads, so poll for it for a few seconds.
  function attachOverlayPlugin() {
    statusEl.textContent = 'OverlayPlugin environment';
    appendMessage('info', 'OverlayPlugin API detected');
    try {
      addOverlayListener('CombatData', (d) => handleEvent('CombatData', d));
      addOverlayListener('onLogLine', (d) => handleEvent('onLogLine', d));
    } catch(e) {
      appendMessage('error', 'addOverlayListener threw: ' + e);
    }
    if (typeof startOverlayEvents === 'function') {
      try { startOverlayEvents(); appendMessage('info','Called startOverlayEvents()'); } catch(e) { appendMessage('error', 'startOverlayEvents() failed: '+e); }
      // retry a few times if we don't see events (some setups need repeated calls)
      let attempts = 0;
      const maxAttempts = 10;
      const interval = setInterval(() => {
        if (gotFirstEvent) {
          appendMessage('info','Received events from OverlayPlugin');
          clearInterval(interval);
          return;
        }
        attempts += 1;
        if (attempts > maxAttempts) {
          appendMessage('error','No events after multiple start attempts');
          clearInterval(interval);
          return;
        }
        try { startOverlayEvents(); appendMessage('info','Re-called startOverlayEvents() (attempt '+attempts+')'); } catch(e) { appendMessage('error','startOverlayEvents() failed: '+e); }
      }, 1000);
    } else {
      appendMessage('info', 'startOverlayEvents() not available on this host');
    }
    // nothing more to do — the OverlayPlugin will push events
  }

  // Poll for the OverlayPlugin API for up to ~10s, then fall back to WS auto-connect
  (function waitForOverlayApi() {
    let checks = 0;
    const maxChecks = 20;
    const intervalMs = 500;
    const id = setInterval(() => {
      checks += 1;
      if (window.addOverlayListener && typeof window.addOverlayListener === 'function') {
        clearInterval(id);
        attachOverlayPlugin();
        return;
      }
      if (checks === 1 || checks % 5 === 0) appendMessage('info', 'Waiting for OverlayPlugin API... (' + checks + ')');
      if (checks >= maxChecks) {
        clearInterval(id);
        appendMessage('info', 'OverlayPlugin API not found; falling back to WebSocket auto-connect');
        autoConnect();
      }
    }, intervalMs);
  })();

  // Otherwise connect directly to ACT WebSocket
  let ws = null;
  let connectedUrl = null;
  let sendStartInterval = null;

  function wsSendStart(socket) {
    // Backwards-compatible legacy attempts (kept for old hosts)
    try { socket.send('startOverlayEvents'); } catch(e){}
    try { socket.send(JSON.stringify({ call: 'startOverlayEvents' })); } catch(e){}
    try { socket.send(JSON.stringify({ call: 'StartOverlayEvents' })); } catch(e){}
  }

  // Preferred subscribe + optional start for ACT/OverlayPlugin WebSocket
  function wsSendSubscribe(socket) {
    try {
      const sub = { call: 'subscribe', events: ['LogLine', 'CombatData'] };
      socket.send(JSON.stringify(sub));
      appendMessage('info', 'Sent subscribe: ' + JSON.stringify(sub));
    } catch (e) {}
    // Some hosts require an explicit start after subscribing
    try {
      const startMsg = { call: 'start' };
      socket.send(JSON.stringify(startMsg));
      appendMessage('info', 'Sent start: ' + JSON.stringify(startMsg));
    } catch (e) {}
  }

  function parseAndDispatch(raw) {
    // handle ping dot protocol used by some ACT websocket proxies
    if (raw === '.') {
      try { if (ws && ws.readyState === 1) ws.send('.'); } catch (e) {}
      return;
    }

    // try parse JSON and handle known wrapper formats (MiniParse / overlay websocket)
    try {
      const json = JSON.parse(raw);
      // If any descendant contains Combatant(s), treat it as CombatData and dispatch.
      try {
        const candidate = findCombatantsArray(json) ? json : (json.data && findCombatantsArray(json.data)) ? json.data : (json.msg && findCombatantsArray(json.msg)) ? json.msg : null;
        if (candidate) {
          handleEvent('CombatData', candidate);
          return;
        }
      } catch (e) {
        // ignore helper errors
      }
      if (json && typeof json === 'object') {
        // MiniParse-style wrapper: { type: 'broadcast'|'send', msgtype: 'CombatData', msg: {...} }
        if (json.type === 'broadcast' || json.type === 'send') {
          const msgtype = json.msgtype || json.msgType || json.msg_type;
          const msg = json.msg;
          if (msgtype) {
            if (String(msgtype).toLowerCase().includes('combat')) {
              handleEvent('CombatData', msg);
            } else {
              handleEvent(msgtype, msg);
            }
            return;
          }
        }

        // Some servers wrap the real payload inside a `data` object, e.g.
        // { event: 'message', data: { type: 'CombatData', Combatant: {...} } }
        if (json.data && typeof json.data === 'object') {
          const inner = json.data;
          const innerType = inner.type || inner.msgtype || inner.msgType || inner.msg_type;
          if (innerType) {
            if (String(innerType).toLowerCase().includes('combat')) {
              handleEvent('CombatData', inner);
            } else {
              handleEvent(innerType, inner);
            }
            return;
          }
          // If inner has combatant lists, treat as CombatData
          if (inner.CombatData || inner.Combatants || inner.Combatant || inner.Players || inner.players) {
            handleEvent('CombatData', inner);
            return;
          }
        }

        // common wrappers may use `call` or `event` fields; otherwise forward whole
        const eventName = json.call || json.event || (json.CombatData ? 'CombatData' : 'message');
        handleEvent(eventName, json);
        return;
      }
    } catch(e) {
      // not JSON — fallthrough
    }

    // not JSON — just display raw
    appendMessage('info', String(raw));
  }

  function tryConnect(url, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      let done = false;
      let socket;
      try {
        socket = new WebSocket(url);
      } catch(err) {
        return reject(err);
      }
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { socket.close(); } catch(e){}
        reject(new Error('timeout'));
      }, timeoutMs);
      socket.onopen = () => {
        if (done) return;
        clearTimeout(timer);
        done = true;
        ws = socket;
        connectedUrl = url;
          // expose for debugging
          try { window.overlayWs = ws; } catch (e) {}
        statusEl.textContent = 'Connected: ' + url;
        appendMessage('info', 'Connected to ' + url);
        ws.onmessage = (ev) => { parseAndDispatch(ev.data); };
        ws.onerror = (ev) => { appendMessage('error', 'WebSocket error'); };
        ws.onclose = () => {
          appendMessage('info', 'WebSocket closed');
          statusEl.textContent = 'Closed';
          try { window.overlayWs = null; } catch (e) {}
          ws = null; connectedUrl = null;
          if (sendStartInterval) { clearInterval(sendStartInterval); sendStartInterval = null; }
        };
        // request overlay events by subscribing to LogLine and CombatData.
        try { wsSendSubscribe(ws); } catch (e) {}
        if (sendStartInterval) { clearInterval(sendStartInterval); sendStartInterval = null; }
        let startAttempts = 0;
        const maxStartAttempts = 10;
        sendStartInterval = setInterval(() => {
          startAttempts += 1;
          if (!ws || ws.readyState !== 1) {
            clearInterval(sendStartInterval); sendStartInterval = null; return;
          }
          if (gotFirstEvent) { clearInterval(sendStartInterval); sendStartInterval = null; appendMessage('info','Received events; stopped subscribe/start attempts'); return; }
          if (startAttempts > maxStartAttempts) { appendMessage('error','No events after repeated subscribe/start attempts'); clearInterval(sendStartInterval); sendStartInterval = null; return; }
          appendMessage('info', 'Sending subscribe/start (attempt ' + startAttempts + ')');
          try { wsSendSubscribe(ws); } catch (e) { appendMessage('error','wsSendSubscribe failed: '+e); }
        }, 1000);
        resolve(ws);
      };
      socket.onerror = (e) => {
        if (done) return;
        clearTimeout(timer);
        done = true;
        try { socket.close(); } catch(e){}
        reject(new Error('error'));
      };
    });
  }

  async function autoConnect() {
    const defaults = [ (urlSelect && urlSelect.value) || 'ws://127.0.0.1:10501', 'ws://127.0.0.1:10501/ws', 'ws://127.0.0.1:10501/socket', 'ws://127.0.0.1:10501/overlay', 'ws://127.0.0.1:10501/watch' ];
    const candidates = hostOverride ? [hostOverride, ...defaults.filter(u => u !== hostOverride)] : defaults;
    for (const url of candidates) {
      appendMessage('info', 'Trying ' + url);
      try {
        // reset event flag for this candidate
        gotFirstEvent = false;
        await tryConnect(url);
        // Wait briefly for the first event; if none arrive, try next candidate
        const waitStart = Date.now();
        const waitMs = 3000;
        while (!gotFirstEvent && Date.now() - waitStart < waitMs) {
          await new Promise(r => setTimeout(r, 150));
        }
        if (gotFirstEvent) {
          appendMessage('info', 'Events received from ' + url);
          return;
        }
        appendMessage('info', 'No events from ' + url + '; closing and trying next');
        try { if (ws) ws.close(); } catch(e) {}
        ws = null; connectedUrl = null;
      } catch(e) {
        appendMessage('info', 'Failed to connect: ' + url + ' (' + e + ')');
      }
    }
    statusEl.textContent = 'No WS connection';
  }

  // Start/Stop controls removed — autoConnect + OverlayPlugin API handle connections

  // try automatically when not inside overlay plugin
  setTimeout(() => { if (!window.addOverlayListener) autoConnect(); }, 250);
})();
