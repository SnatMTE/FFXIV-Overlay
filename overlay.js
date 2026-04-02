(function(){
  const statusEl = document.getElementById('status');
  const messagesEl = document.getElementById('messages');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const urlSelect = document.getElementById('url-select');
  let gotFirstEvent = false;
  let lastDpsHtml = null;
  let lastDpsHtml = null;

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
    // map to name/dps
    const rows = players.map(p => ({ name: getName(p) || 'Unknown', dps: getDpsValue(p) }));
    // sort by dps desc
    rows.sort((a,b) => (isNaN(b.dps)?0:b.dps) - (isNaN(a.dps)?0:a.dps));
    const total = rows.reduce((s,r) => s + (isNaN(r.dps)?0:r.dps), 0);
    // render
    const parts = [];
    parts.push(`<div class="dps-total">Party DPS: ${formatNumber(total)}</div>`);
    parts.push('<div class="dps-rows">');
    for (const r of rows) {
      parts.push(`<div class="dps-row"><div class="dps-name">${escapeHtml(r.name)}</div><div class="dps-value">${formatNumber(r.dps)}</div></div>`);
    }
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
        statusEl.textContent = 'Connected: ' + url;
        appendMessage('info', 'Connected to ' + url);
        ws.onmessage = (ev) => { parseAndDispatch(ev.data); };
        ws.onerror = (ev) => { appendMessage('error', 'WebSocket error'); };
        ws.onclose = () => {
          appendMessage('info', 'WebSocket closed');
          statusEl.textContent = 'Closed';
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
    const candidates = [ urlSelect.value, 'ws://127.0.0.1:10501', 'ws://127.0.0.1:10501/ws', 'ws://127.0.0.1:10501/socket', 'ws://127.0.0.1:10501/overlay', 'ws://127.0.0.1:10501/watch' ];
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

  btnStart.addEventListener('click', async () => {
    if (typeof startOverlayEvents === 'function') {
      try { startOverlayEvents(); appendMessage('info','Called startOverlayEvents()'); } catch(e) { appendMessage('error', 'startOverlayEvents failed: '+e); }
      return;
    }
    const url = urlSelect.value || 'ws://127.0.0.1:10501';
    try {
      await tryConnect(url);
    } catch(e) {
      appendMessage('error', 'Connect failed: ' + e);
    }
  });

  btnStop.addEventListener('click', () => {
    if (typeof stopOverlayEvents === 'function') {
      try { stopOverlayEvents(); appendMessage('info','Called stopOverlayEvents()'); } catch(e) { appendMessage('error','stopOverlayEvents failed: '+e); }
    }
    if (ws) {
      try { ws.send('stopOverlayEvents'); } catch(e){}
      try { ws.close(); } catch(e){}
      ws = null;
      statusEl.textContent = 'Stopped';
      appendMessage('info','Stopped WebSocket');
    }
  });

  // try automatically when not inside overlay plugin
  setTimeout(() => { if (!window.addOverlayListener) autoConnect(); }, 250);
})();
