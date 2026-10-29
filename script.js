(() => {
  'use strict';

  /* =====================================================
     TONIN CONECT - client
     ===================================================== */

  const $ = (id) => document.getElementById(id);

  const state = {
    token: localStorage.getItem('tc_token'),
    me: null,
    contacts: [],
    current: null,
    cache: {},          // id contact -> messages[]
    unread: {},         // id contact -> nombre de non lus
    online: new Set(),
    socket: null,
    avatarValue: '',    // avatar en cours d'édition dans les réglages
    unreadInit: false,
    appearance: { theme: 'dark', accent: 'violet' },
  };

  /* ---------------- Apparence (thème + couleur) ---------------- */

  const ACCENTS = {
    violet: ['#7c5cff', '#4da3ff'],
    ocean: ['#2f80ed', '#2dd4bf'],
    menthe: ['#10b981', '#84cc16'],
    rose: ['#ec4899', '#f97316'],
    pink: ['#ff4fa3', '#ff8fc7'],
    orange: ['#f59e0b', '#ef4444'],
  };

  function markAppearanceButtons() {
    document.querySelectorAll('[data-theme-choice]').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeChoice === state.appearance.theme);
    });
    document.querySelectorAll('.swatch').forEach((b) => {
      b.classList.toggle('active', b.dataset.accent === state.appearance.accent);
    });
  }

  function applyAppearance(a) {
    const ap = { theme: 'dark', accent: 'violet', ...(a || {}) };
    if (!['dark', 'light'].includes(ap.theme)) ap.theme = 'dark';
    if (!ACCENTS[ap.accent]) ap.accent = 'violet';
    const root = document.documentElement;
    root.dataset.theme = ap.theme;
    root.style.setProperty('--accent', ACCENTS[ap.accent][0]);
    root.style.setProperty('--accent-2', ACCENTS[ap.accent][1]);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = ap.theme === 'light' ? '#f2f4fb' : '#0f1220';
    state.appearance = ap;
    try { localStorage.setItem('tc_appearance', JSON.stringify(ap)); } catch (e) { /* ignore */ }
    markAppearanceButtons();
  }

  function setAppearance(partial) {
    const ap = { ...state.appearance, ...partial };
    applyAppearance(ap);
    if (state.token && state.me) {
      state.me.appearance = ap;
      api('/api/me', 'PUT', { appearance: ap }).catch(() => {});
    }
  }

  // Pastilles de couleur
  Object.keys(ACCENTS).forEach((key) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.accent = key;
    b.title = key;
    b.style.background = `linear-gradient(135deg, ${ACCENTS[key][0]}, ${ACCENTS[key][1]})`;
    b.addEventListener('click', () => setAppearance({ accent: key }));
    $('accent-row').appendChild(b);
  });
  document.querySelectorAll('[data-theme-choice]').forEach((b) => {
    b.addEventListener('click', () => setAppearance({ theme: b.dataset.themeChoice }));
  });

  // Applique tout de suite le dernier thème connu (évite le flash)
  try { applyAppearance(JSON.parse(localStorage.getItem('tc_appearance'))); } catch (e) { applyAppearance(null); }

  /* ---------------- Utilitaires ---------------- */

  // Lien GitHub « blob » => fichier brut (sinon ce n'est pas une image)
  function fixImageUrl(u) {
    u = (u || '').trim();
    if (/^https?:\/\/github\.com\/.+\/blob\//i.test(u) && !/[?&]raw=true/i.test(u)) {
      u += (u.includes('?') ? '&' : '?') + 'raw=true';
    }
    return u;
  }

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 3200);
  }

  async function api(path, method = 'GET', body) {
    const res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* pas de JSON */ }
    if (!res.ok) {
      if (res.status === 401 && state.token && path !== '/api/login' && path !== '/api/admin/login') {
        forceLogout(data.error || 'Session expirée, reconnecte-toi.');
      }
      throw new Error(data.error || 'Erreur ' + res.status);
    }
    return data;
  }

  function colorFor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return `hsl(${h}, 55%, 45%)`;
  }

  function makeAvatar(user, big = false) {
    const el = document.createElement('div');
    el.className = 'avatar' + (big ? ' big' : '');
    const fallback = () => {
      el.innerHTML = '';
      if (user.isGroup) {
        el.style.background = colorFor(user.name || '?');
        el.textContent = '👥';
      } else if (user.isSystem) {
        el.style.background = 'linear-gradient(135deg,#4da3ff,#7c5cff)';
        el.textContent = '🔔';
      } else if (user.isAdmin) {
        el.style.background = 'linear-gradient(135deg,#f5a623,#f76b1c)';
        el.textContent = '👑';
      } else {
        const nm = user.name || user.pseudo || '?';
        el.style.background = colorFor(nm);
        el.textContent = nm.trim().charAt(0).toUpperCase();
      }
    };
    if (user.avatar) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = user.avatar;
      img.onerror = fallback;
      el.appendChild(img);
    } else {
      fallback();
    }
    return el;
  }

  function avatarWithDot(user) {
    const wrap = document.createElement('div');
    wrap.className = 'avatar-wrap';
    wrap.appendChild(makeAvatar(user));
    if (state.online.has(user.id)) {
      const d = document.createElement('span');
      d.className = 'dot';
      wrap.appendChild(d);
    }
    return wrap;
  }

  const fmtTime = (ts) =>
    new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ts) =>
    new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('fr-FR');
  const EDIT_WINDOW = 15 * 60 * 1000; // modification possible 15 minutes
  const isGroupId = (x) => typeof x === 'string' && x.startsWith('g_');

  function readMap() {
    try { return JSON.parse(localStorage.getItem('tc_read_' + state.me.id)) || {}; } catch (e) { return {}; }
  }
  function markRead(id) {
    const list = state.cache[id];
    const map = readMap();
    map[id] = list && list.length ? list[list.length - 1].ts : Date.now();
    localStorage.setItem('tc_read_' + state.me.id, JSON.stringify(map));
    state.unread[id] = 0;
  }

  const previewText = (m) =>
    m.audio ? '🎤 Message vocal' : m.image ? (m.text ? '📷 ' + m.text : '📷 Photo') : m.text;

  /* ---------------- Images (redimensionnement) ---------------- */

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image illisible.'));
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderToDataUrl(img, { max, square, quality }) {
    let sw = img.width, sh = img.height, sx = 0, sy = 0, w, h;
    if (square) {
      const m = Math.min(sw, sh);
      sx = (sw - m) / 2;
      sy = (sh - m) / 2;
      sw = sh = m;
      w = h = max;
    } else {
      const k = Math.min(1, max / Math.max(sw, sh));
      w = Math.round(sw * k);
      h = Math.round(sh * k);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  }

  /* ---------------- Connexion ---------------- */

  const authError = (m) => { $('auth-error').textContent = m || ''; };

  $('toggle-admin').addEventListener('click', () => {
    const adminMode = $('admin-form').classList.toggle('hidden');
    $('login-form').classList.toggle('hidden', !adminMode);
    $('toggle-admin').textContent = adminMode ? 'Compte administrateur' : '← Retour à la connexion';
    authError('');
  });

  $('login-pin').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError('');
    try {
      const r = await api('/api/login', 'POST', {
        pseudo: $('login-pseudo').value,
        pin: $('login-pin').value,
      });
      await onAuth(r);
    } catch (err) {
      authError(err.message);
    }
  });

  $('admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    authError('');
    try {
      const r = await api('/api/admin/login', 'POST', { pin: $('admin-pin').value });
      await onAuth(r);
    } catch (err) {
      authError(err.message);
    }
  });

  async function onAuth(r) {
    state.token = r.token;
    localStorage.setItem('tc_token', r.token);
    state.me = r.me;
    await startApp();
    if (r.created) toast('Compte créé ! Ton code de partage : ' + r.me.shareCode);
  }

  async function startApp() {
    $('auth-screen').classList.add('hidden');
    $('app-screen').classList.remove('hidden');
    applyAppearance(state.me.appearance);
    renderMe();
    connectSocket();
    await loadContacts();
    afterStart();
  }

  function forceLogout(message) {
    localStorage.removeItem('tc_token');
    if (message) sessionStorage.setItem('tc_msg', message);
    location.reload();
  }

  $('btn-logout').addEventListener('click', async () => {
    try { await api('/api/logout', 'POST'); } catch (e) { /* ignore */ }
    forceLogout();
  });

  function renderMe() {
    const me = state.me;
    const holder = $('me-avatar');
    holder.innerHTML = '';
    holder.appendChild(makeAvatar(me));
    $('me-name').textContent = me.name || me.pseudo;
    $('me-sub').textContent = me.isAdmin ? 'Administrateur suprême' : me.staff ? 'Administrateur' : 'Connecté';
    $('btn-admin').classList.toggle('hidden', !me.staff);
    $('btn-add').classList.toggle('hidden', !!me.isAdmin);
  }

  /* ---------------- Socket.io ---------------- */

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const socket = io({ auth: { token: state.token } });
    state.socket = socket;

    socket.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') forceLogout('Session expirée, reconnecte-toi.');
      if (err && /^banned:/.test(err.message)) forceLogout(err.message.slice(7));
    });

    socket.on('kicked', () => forceLogout('Ton compte a été supprimé par l\'administrateur.'));
    bindExtraSocket(socket);

    socket.on('presence:list', (ids) => {
      state.online = new Set(ids);
      renderContacts();
      renderChatHeader();
    });

    socket.on('presence', ({ id, online }) => {
      if (online) state.online.add(id); else state.online.delete(id);
      renderContacts();
      renderChatHeader();
    });

    socket.on('contacts:update', async () => {
      try {
        await loadContacts();
        if (state.me && !state.me.isAdmin) {
          state.me = await api('/api/me');
          renderMe();
        }
        if (!$('modal-admin').classList.contains('hidden')) loadAdminUsers();
        if (!$('modal-account').classList.contains('hidden')) refreshAccountScreen();
      } catch (e) { /* ignore */ }
    });

    socket.on('message', async (msg) => {
      const other = isGroupId(msg.to) ? msg.to : msg.from === state.me.id ? msg.to : msg.from;
      const known = state.contacts.some((c) => c.id === other);
      if (!known) await loadContacts();

      if (state.cache[other]) state.cache[other].push(msg);

      const c = state.contacts.find((x) => x.id === other);
      if (c) c.last = msg;

      if (state.current === other) {
        if (!state.cache[other]) await loadHistory(other);
        else appendMessage(msg);
        scrollBottom();
        markRead(other);
      } else if (msg.from !== state.me.id) {
        state.unread[other] = (state.unread[other] || 0) + 1;
      }
      renderContacts();
    });
  }

  /* ---------------- Contacts ---------------- */

  async function loadContacts() {
    state.contacts = await api('/api/contacts');
    state.contacts.forEach((c) => { if (c.online) state.online.add(c.id); });
    if (state.current && !state.contacts.some((c) => c.id === state.current)) $('btn-back').click();

    if (!state.unreadInit) {
      const map = readMap();
      state.contacts.forEach((c) => {
        const l = c.last;
        state.unread[c.id] = l && (c.isGroup ? l.from !== state.me.id : l.from === c.id) && l.ts > (map[c.id] || 0) ? 1 : 0;
      });
      state.unreadInit = true;
    }
    renderContacts();
    renderChatHeader();
  }

  function renderContacts() {
    const box = $('contact-list');
    const q = $('search').value.trim().toLowerCase();
    box.innerHTML = '';

    const list = state.contacts
      .filter((c) => (c.name + ' ' + c.pseudo).toLowerCase().includes(q))
      .sort((a, b) => {
        // seules les conversations épinglées par la personne remontent en haut
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        const ta = a.last ? a.last.ts : 0;
        const tb = b.last ? b.last.ts : 0;
        if (ta !== tb) return tb - ta;
        return a.name.localeCompare(b.name);
      });

    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'empty-list';
      e.textContent = state.me.isAdmin
        ? 'Aucun utilisateur pour le moment.'
        : 'Aucun contact. Clique sur « Ajouter » et entre le code de partage d\'un ami.';
      box.appendChild(e);
      return;
    }

    list.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'contact' + (state.current === c.id ? ' active' : '');
      item.appendChild(avatarWithDot(c));

      const meta = document.createElement('div');
      meta.className = 'meta';

      const name = document.createElement('div');
      name.className = 'name';
      const nm = document.createElement('span');
      nm.textContent = (c.staff ? '🛠️ ' : '') + c.name;
      name.appendChild(nm);
      if (c.last) {
        const t = document.createElement('time');
        t.textContent = fmtTime(c.last.ts);
        name.appendChild(t);
      }

      const prev = document.createElement('div');
      prev.className = 'preview';
      prev.textContent = c.last
        ? (c.last.from === state.me.id ? 'Vous : ' : c.isGroup ? ((c.members.find((x) => x.id === c.last.from) || {}).name || '?') + ' : ' : '') + previewText(c.last)
        : 'Aucun message';

      meta.appendChild(name);
      meta.appendChild(prev);
      item.appendChild(meta);

      if (state.unread[c.id] > 0) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = state.unread[c.id];
        item.appendChild(b);
      }

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'pin-btn' + (c.pinned ? ' on' : '');
      pin.textContent = '📌';
      pin.title = c.pinned ? 'Désépingler' : 'Épingler';
      pin.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const next = !c.pinned;
        try {
          await api('/api/contacts/' + encodeURIComponent(c.id) + '/pin', 'PUT', { value: next });
          c.pinned = next;
          renderContacts();
        } catch (err) { toast(err.message); }
      });
      item.appendChild(pin);

      item.addEventListener('click', () => openChat(c.id));
      box.appendChild(item);
    });
  }

  $('search').addEventListener('input', renderContacts);

  /* ---------------- Chat ---------------- */

  function renderChatHeader() {
    const c = state.contacts.find((x) => x.id === state.current);
    if (!c) return;
    const holder = $('chat-avatar');
    holder.innerHTML = '';
    holder.appendChild(avatarWithDot(c));
    $('chat-name').textContent = (c.staff ? '🛠️ ' : '') + c.name;
    $('btn-call').classList.toggle('hidden', !!(c.isAdmin || c.isSystem));
    $('btn-video').classList.toggle('hidden', !!(c.isAdmin || c.isSystem));
    $('send-form').classList.toggle('hidden', !!c.isSystem);
    $('chat-status').textContent = c.isSystem
      ? 'Notifications automatiques'
      : c.isGroup ? c.members.length + ' membres' : state.online.has(c.id) ? 'En ligne' : 'Hors ligne';
  }

  async function openChat(id) {
    if (state.rec) stopRec(false);
    state.current = id;
    $('chat-empty').classList.add('hidden');
    $('chat-panel').classList.remove('hidden');
    $('app-screen').classList.add('chat-open');
    renderChatHeader();
    try {
      if (!state.cache[id]) await loadHistory(id);
      else renderMessages(state.cache[id]);
    } catch (err) {
      toast(err.message);
    }
    markRead(id);
    renderContacts();
    $('msg-input').focus();
  }

  async function loadHistory(id) {
    state.cache[id] = await api('/api/messages/' + id);
    if (state.current === id) renderMessages(state.cache[id]);
  }

  function renderMessages(list) {
    const box = $('messages');
    box.innerHTML = '';
    box.dataset.lastDay = '';
    list.forEach(appendMessage);
    scrollBottom();
  }

  function appendMessage(m) {
    const box = $('messages');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const day = fmtDate(m.ts);
    if (box.dataset.lastDay !== day) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = fmtDay(m.ts);
      box.appendChild(sep);
      box.dataset.lastDay = day;
    }
    const row = document.createElement('div');
    row.className = 'msg ' + (m.from === state.me.id ? 'mine' : 'theirs');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    row.dataset.id = m.id;
    const curChat = state.contacts.find((x) => x.id === state.current);
    if (curChat && curChat.isGroup && m.from !== state.me.id) {
      const lab = document.createElement('div');
      lab.className = 'sender';
      lab.textContent = (curChat.members.find((x) => x.id === m.from) || {}).name || 'Ancien membre';
      bubble.appendChild(lab);
    }

    if (m.image) {
      bubble.classList.add('has-img');
      const img = document.createElement('img');
      img.className = 'chat-img';
      img.alt = 'Photo';
      img.loading = 'lazy';
      img.src = m.image;
      img.addEventListener('load', () => { if (stick) scrollBottom(); });
      img.addEventListener('click', () => {
        $('photo-full').src = m.image;
        openModal('modal-photo');
      });
      bubble.appendChild(img);
    }
    if (m.audio) {
      bubble.classList.add('has-audio');
      const au = document.createElement('audio');
      au.className = 'chat-audio';
      au.controls = true;
      au.preload = 'metadata';
      au.src = m.audio;
      bubble.appendChild(au);
    }
    if (m.text) {
      const txt = document.createElement('div');
      txt.textContent = m.text;
      bubble.appendChild(txt);
    }
    const t = document.createElement('time');
    t.textContent = (m.edited ? 'modifié · ' : '') + fmtTime(m.ts);
    bubble.appendChild(t);
    if (m.from === state.me.id) {
      const acts = document.createElement('div');
      acts.className = 'msg-actions';
      if (m.text && Date.now() - m.ts < EDIT_WINDOW) {
        const ed = document.createElement('button');
        ed.type = 'button';
        ed.title = 'Modifier';
        ed.textContent = '✏️';
        ed.addEventListener('click', () => editMessage(m));
        acts.appendChild(ed);
      }
      const del = document.createElement('button');
      del.type = 'button';
      del.title = 'Supprimer';
      del.textContent = '🗑';
      del.addEventListener('click', () => deleteMessage(m));
      acts.appendChild(del);
      row.appendChild(acts);
    }
    row.appendChild(bubble);
    box.appendChild(row);
  }

  async function editMessage(m) {
    if (Date.now() - m.ts >= EDIT_WINDOW) return toast('Tu ne peux plus modifier ce message (15 minutes maximum).');
    const text = prompt('Modifier le message :', m.text);
    if (text === null) return;
    try { await api('/api/messages/' + m.id, 'PUT', { text }); } catch (err) { toast(err.message); }
  }

  async function deleteMessage(m) {
    if (!confirm('Supprimer ce message pour tout le monde ?')) return;
    try { await api('/api/messages/' + m.id, 'DELETE'); } catch (err) { toast(err.message); }
  }

  function rerenderCurrent(other) {
    if (state.current !== other || !state.cache[other]) return;
    const box = $('messages');
    const top = box.scrollTop;
    renderMessages(state.cache[other]);
    box.scrollTop = top;
  }

  function scrollBottom() {
    const box = $('messages');
    box.scrollTop = box.scrollHeight;
  }

  $('btn-back').addEventListener('click', () => {
    if (state.rec) stopRec(false);
    $('app-screen').classList.remove('chat-open');
    state.current = null;
    $('chat-panel').classList.add('hidden');
    $('chat-empty').classList.remove('hidden');
    renderContacts();
  });

  $('send-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('msg-input').value.trim();
    if (!text || !state.current) return;
    state.socket.emit('message:send', { to: state.current, text }, (res) => {
      if (res && res.error) toast(res.error);
    });
    $('msg-input').value = '';
  });

  // Envoi de photos
  $('btn-photo').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !state.current) return;
    const to = state.current;
    try {
      toast('Envoi de la photo…');
      const img = await readImage(file);
      const data = renderToDataUrl(img, { max: 1280, quality: 0.82 });
      const { url } = await api('/api/upload', 'POST', { data });
      const text = $('msg-input').value.trim();
      $('msg-input').value = '';
      state.socket.emit('message:send', { to, text, image: url }, (res) => {
        if (res && res.error) toast(res.error);
      });
    } catch (err) {
      toast(err.message);
    }
  });

  /* ---------------- Messages vocaux ---------------- */

  function recUi(on) {
    ['msg-input', 'btn-photo'].forEach((id) => $(id).classList.toggle('hidden', on));
    $('send-form').querySelector('button[type="submit"]').classList.toggle('hidden', on);
    $('rec-timer').classList.toggle('hidden', !on);
    $('btn-mic-cancel').classList.toggle('hidden', !on);
    $('btn-mic').textContent = on ? '⬆️' : '🎤';
    $('btn-mic').title = on ? 'Envoyer le vocal' : 'Message vocal';
  }

  async function startRec() {
    if (!state.current) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      return toast('Les vocaux ne sont pas disponibles ici (connexion HTTPS requise).');
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { return toast('Autorise le micro pour envoyer un vocal.'); }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    let mr;
    try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); return toast('Enregistrement impossible sur cet appareil.'); }
    const rec = { mr, stream, chunks: [], to: state.current, started: Date.now(), send: false, timer: null };
    mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    mr.onstop = () => finishRec(rec);
    state.rec = rec;
    mr.start();
    recUi(true);
    const tick = () => {
      const s = Math.round((Date.now() - rec.started) / 1000);
      $('rec-timer').textContent = '🔴 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
    tick();
    rec.timer = setInterval(tick, 500);
  }

  function stopRec(send) {
    const r = state.rec;
    if (!r) return;
    r.send = send;
    clearInterval(r.timer);
    state.rec = null;
    recUi(false);
    try { r.mr.stop(); } catch (e) { r.stream.getTracks().forEach((t) => t.stop()); }
  }

  async function finishRec(rec) {
    rec.stream.getTracks().forEach((t) => t.stop());
    if (!rec.send || !rec.chunks.length) return;
    const type = (rec.mr.mimeType || 'audio/webm').split(';')[0];
    try {
      toast('Envoi du vocal…');
      const res = await fetch('/api/upload-audio', {
        method: 'POST',
        headers: { 'Content-Type': type, Authorization: 'Bearer ' + state.token },
        body: new Blob(rec.chunks, { type }),
      });
      let data = {};
      try { data = await res.json(); } catch (x) { /* pas de JSON */ }
      if (!res.ok) throw new Error(data.error || 'Envoi du vocal impossible.');
      state.socket.emit('message:send', { to: rec.to, text: '', audio: data.url }, (r) => { if (r && r.error) toast(r.error); });
    } catch (err) { toast(err.message); }
  }

  $('btn-mic').addEventListener('click', () => (state.rec ? stopRec(true) : startRec()));
  $('btn-mic-cancel').addEventListener('click', () => stopRec(false));

  /* ---------------- Modales ---------------- */

  const openModal = (id) => $(id).classList.remove('hidden');
  const closeModal = (id) => $(id).classList.add('hidden');

  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.hasAttribute('data-close')) m.classList.add('hidden');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
  });

  /* ---------------- Ajout de contact ---------------- */

  $('btn-add').addEventListener('click', () => openModal('modal-addmenu'));
  $('menu-add-contact').addEventListener('click', () => {
    closeModal('modal-addmenu');
    $('add-code').value = '';
    $('add-error').textContent = '';
    openModal('modal-add');
    $('add-code').focus();
  });
  $('menu-add-group').addEventListener('click', () => { closeModal('modal-addmenu'); openGroupNew(); });

  /* ---------------- Comptes publics ---------------- */

  state.publicUsers = [];

  function renderPublicList() {
    const box = $('public-list');
    const q = $('public-search').value.trim().toLowerCase();
    box.innerHTML = '';
    const list = state.publicUsers.filter((u) => !q || u.name.toLowerCase().includes(q) || u.pseudo.toLowerCase().includes(q));
    if (!list.length) {
      box.appendChild(emptyDiv(state.publicUsers.length ? 'Aucun résultat.' : 'Aucun compte public à ajouter pour le moment.'));
      return;
    }
    list.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'contact';
      row.appendChild(avatarWithDot(u));
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = u.name + (u.name !== u.pseudo ? ' (' + u.pseudo + ')' : '');
      row.appendChild(meta);
      const btn = document.createElement('button');
      btn.className = 'btn small primary';
      btn.type = 'button';
      btn.textContent = 'Ajouter';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        $('public-error').textContent = '';
        try {
          const c = await api('/api/contacts/public', 'POST', { id: u.id });
          closeModal('modal-public');
          toast(c.pseudo + ' a été ajouté à tes contacts !');
          await loadContacts();
          openChat(c.id);
        } catch (err) {
          btn.disabled = false;
          $('public-error').textContent = err.message;
          loadPublicUsers();
        }
      });
      row.appendChild(btn);
      box.appendChild(row);
    });
  }

  async function loadPublicUsers() {
    try {
      state.publicUsers = await api('/api/public-users');
      renderPublicList();
    } catch (err) { $('public-error').textContent = err.message; }
  }

  $('menu-add-public').addEventListener('click', () => {
    closeModal('modal-addmenu');
    $('public-search').value = '';
    $('public-error').textContent = '';
    $('public-list').innerHTML = '';
    $('public-list').appendChild(emptyDiv('Chargement…'));
    openModal('modal-public');
    loadPublicUsers();
  });
  $('public-search').addEventListener('input', renderPublicList);

  $('add-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('add-error').textContent = '';
    try {
      const c = await api('/api/contacts', 'POST', { code: $('add-code').value });
      closeModal('modal-add');
      toast(c.pseudo + ' a été ajouté à tes contacts !');
      await loadContacts();
      openChat(c.id);
    } catch (err) {
      $('add-error').textContent = err.message;
    }
  });

  /* ---------------- Réglages (utilisateur ET administrateur) ---------------- */

  function renderSettingsPreview() {
    const holder = $('settings-preview');
    holder.innerHTML = '';
    const isAdmin = !!state.me.isAdmin;
    const av = makeAvatar(
      {
        pseudo: isAdmin ? 'Administrateur' : ($('settings-nickname').value || state.me.pseudo),
        avatar: state.avatarValue,
        isAdmin,
      },
      true
    );
    state.avatarBroken = false;
    const im = av.querySelector('img');
    if (im && /^https?:/i.test(state.avatarValue)) {
      im.addEventListener('error', () => {
        state.avatarBroken = true;
        $('settings-error').textContent = 'Cette adresse ne donne pas une image. Utilise plutôt « Importer une photo ».';
      });
      im.addEventListener('load', () => {
        state.avatarBroken = false;
        if ($('settings-error').textContent.startsWith('Cette adresse')) $('settings-error').textContent = '';
      });
    }
    holder.appendChild(av);
  }

  $('btn-settings').addEventListener('click', async () => {
    $('settings-error').textContent = '';
    try {
      state.me = await api('/api/me');
    } catch (err) {
      return toast(err.message);
    }
    const me = state.me;
    const isAdmin = !!me.isAdmin;

    $('field-pseudo').classList.toggle('hidden', isAdmin);
    $('field-nickname').classList.toggle('hidden', isAdmin);
    $('share-section').classList.toggle('hidden', isAdmin);
    $('field-desc').classList.toggle('hidden', !isAdmin);
    $('privacy-section').classList.toggle('hidden', isAdmin);
    if (isAdmin) $('settings-desc').value = me.description || '';
    else $('settings-public').checked = !!me.isPublic;

    const code = $('settings-code');
    code.type = 'password';
    if (isAdmin) {
      $('code-label').textContent = 'Nouveau code administrateur (laisser vide pour ne pas changer)';
      code.value = '';
      code.maxLength = 40;
      code.placeholder = 'Nouveau code (4 caractères minimum)';
      code.inputMode = 'text';
    } else {
      $('code-label').textContent = 'Code secret (PIN à 4 chiffres)';
      code.value = me.pin || '';
      code.maxLength = 4;
      code.placeholder = '••••';
      code.inputMode = 'numeric';
      $('settings-pseudo').value = me.pseudo;
      $('settings-nickname').value = me.nickname || '';
      $('settings-share').textContent = me.shareCode;
    }

    state.avatarValue = me.avatar || '';
    $('settings-avatar-url').value = /^https?:/i.test(state.avatarValue) ? state.avatarValue : '';
    $('settings-avatar-url').placeholder = state.avatarValue.startsWith('data:')
      ? '(photo importée)'
      : 'https://…';
    state.avatarBroken = false;
    renderSettingsPreview();
    markAppearanceButtons();
    openModal('modal-settings');
  });

  $('settings-nickname').addEventListener('input', renderSettingsPreview);

  $('settings-code').addEventListener('input', (e) => {
    if (!state.me.isAdmin) e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });
  $('settings-code-toggle').addEventListener('click', () => {
    const i = $('settings-code');
    i.type = i.type === 'password' ? 'text' : 'password';
  });

  $('settings-avatar-url').addEventListener('input', (e) => {
    state.avatarValue = fixImageUrl(e.target.value);
    renderSettingsPreview();
  });

  $('settings-avatar-clear').addEventListener('click', () => {
    state.avatarValue = '';
    $('settings-avatar-url').value = '';
    $('settings-avatar-url').placeholder = 'https://…';
    renderSettingsPreview();
  });

  $('settings-avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const img = await readImage(file);
      state.avatarValue = renderToDataUrl(img, { max: 160, square: true, quality: 0.85 });
      $('settings-avatar-url').value = '';
      $('settings-avatar-url').placeholder = '(photo importée)';
      renderSettingsPreview();
    } catch (err) {
      toast(err.message);
    }
  });

  $('settings-share-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('settings-share').textContent);
      toast('Code de partage copié !');
    } catch (e) {
      toast('Copie impossible, note le code manuellement.');
    }
  });

  $('settings-share-reset').addEventListener('click', async () => {
    if (!confirm('Réinitialiser ton code de partage ? L\'ancien code ne fonctionnera plus.')) return;
    try {
      const r = await api('/api/me/reset-code', 'POST');
      state.me.shareCode = r.shareCode;
      $('settings-share').textContent = r.shareCode;
      toast('Nouveau code de partage : ' + r.shareCode);
    } catch (err) {
      $('settings-error').textContent = err.message;
    }
  });

  $('settings-save').addEventListener('click', async () => {
    $('settings-error').textContent = '';
    const isAdmin = !!state.me.isAdmin;
    const code = $('settings-code').value;
    const body = { avatar: state.avatarValue, appearance: state.appearance };

    if (state.avatarBroken && /^https?:/i.test(state.avatarValue)) {
      $('settings-error').textContent = 'La photo n\'est pas valide : importe-la depuis ton appareil ou retire-la.';
      return;
    }

    if (isAdmin) {
      body.description = $('settings-desc').value;
      if (code !== '') {
        if (code.length < 4) {
          $('settings-error').textContent = 'Le code administrateur doit faire au moins 4 caractères.';
          return;
        }
        body.pin = code;
      }
    } else {
      if (!/^\d{4}$/.test(code)) {
        $('settings-error').textContent = 'Le code PIN doit contenir exactement 4 chiffres.';
        return;
      }
      body.pin = code;
      body.nickname = $('settings-nickname').value;
      body.isPublic = $('settings-public').checked;
    }

    const saveBtn = $('settings-save');
    saveBtn.disabled = true;
    try {
      state.me = await api('/api/me', 'PUT', body);
      renderMe();
      closeModal('modal-settings');
      toast(isAdmin && body.pin ? 'Réglages enregistrés. Nouveau code administrateur actif.' : 'Réglages enregistrés !');
    } catch (err) {
      $('settings-error').textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  /* ---------------- Administration ---------------- */

  $('btn-admin').addEventListener('click', () => {
    document.querySelectorAll('[data-hub="broadcast"],[data-hub="requests"],[data-hub="accounts"]').forEach((b) => b.classList.toggle('hidden', !state.me.isAdmin));
    refreshReportsBadge();
    openModal('modal-hub');
  });
  $('admin-refresh').addEventListener('click', loadAdminUsers);

  async function loadAdminUsers() {
    let data;
    try {
      data = await api('/api/admin/users');
    } catch (err) {
      return toast(err.message);
    }
    const users = data.users;

    const info = $('admin-storage');
    info.textContent = data.storage.warning
      ? '⚠️ Stockage : ' + data.storage.label + ' — ton hébergeur semble effacer le disque ! Configure DATABASE_URL (PostgreSQL) ou DATA_DIR.'
      : '💾 Stockage : ' + data.storage.label;
    info.classList.toggle('warn', !!data.storage.warning);

    $('admin-count').textContent = users.length;
    const body = $('admin-table').querySelector('tbody');
    body.innerHTML = '';

    if (!users.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.textContent = 'Aucun compte pour le moment.';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    users.forEach((u) => {
      const tr = document.createElement('tr');
      const cell = (child) => {
        const td = document.createElement('td');
        if (typeof child === 'string') td.textContent = child; else td.appendChild(child);
        tr.appendChild(td);
        return td;
      };

      const who = document.createElement('div');
      who.className = 'who';
      who.appendChild(makeAvatar(u));
      const nm = document.createElement('span');
      nm.textContent = (u.admin ? '👑 ' : '') + (u.nickname ? u.nickname + ' (' + u.pseudo + ')' : u.pseudo);
      who.appendChild(nm);
      cell(who);

      cell(u.isPublic ? '🌍 Public' : '🔒 Privé');

      const pin = document.createElement('code');
      pin.textContent = u.pin;
      cell(pin);

      const shareWrap = document.createElement('div');
      shareWrap.style.cssText = 'display:flex;align-items:center;gap:6px';
      const share = document.createElement('code');
      share.textContent = u.shareCode;
      const editShare = document.createElement('button');
      editShare.className = 'btn small';
      editShare.style.cssText = 'width:auto;margin:0;padding:2px 8px';
      editShare.title = 'Modifier le code de partage';
      editShare.textContent = '✏️';
      editShare.addEventListener('click', async () => {
        const v = prompt('Nouveau code de partage (4 chiffres) pour « ' + u.pseudo + ' ».\nLaisse vide pour en générer un au hasard :', u.shareCode);
        if (v === null) return;
        try {
          const r = await api('/api/admin/users/' + u.id + '/share-code', 'POST', { code: v.trim() });
          toast('Code de partage de ' + u.pseudo + ' : ' + r.shareCode);
          loadAdminUsers();
        } catch (err) { toast(err.message); }
      });
      shareWrap.appendChild(share);
      if (state.me.isAdmin) shareWrap.appendChild(editShare);
      cell(shareWrap);

      cell(String(u.contacts));
      cell(String(u.reports || 0));
      cell(fmtDate(u.createdAt));

      const st = document.createElement('span');
      st.className = u.online ? 'status-on' : 'status-off';
      st.textContent = u.online ? '● En ligne' : '○ Hors ligne';
      if (u.bannedUntil) {
        st.className = 'status-off';
        st.style.color = 'var(--danger)';
        st.textContent = u.bannedUntil >= 32503680000000 ? '⛔ Banni définitivement' : '⛔ Banni jusqu\'au ' + fmtDate(u.bannedUntil) + ' ' + fmtTime(u.bannedUntil);
      }
      if (u.channelBan) st.textContent += ' · 🚫 chaînes';
      cell(st);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const chat = document.createElement('button');
      chat.className = 'btn small primary';
      chat.style.width = 'auto';
      chat.style.margin = '0';
      chat.textContent = 'Discuter';
      chat.addEventListener('click', () => {
        closeModal('modal-admin');
        openChat(u.id);
      });
      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = 'Supprimer';
      del.addEventListener('click', async () => {
        if (!confirm('Supprimer définitivement le compte « ' + u.pseudo + ' » et ses messages ?')) return;
        try {
          await api('/api/admin/users/' + u.id, 'DELETE');
          if (state.current === u.id) $('btn-back').click();
          toast('Compte supprimé.');
        } catch (err) {
          toast(err.message);
        }
      });
      const openAcc = document.createElement('button');
      openAcc.className = 'btn small';
      openAcc.style.width = 'auto';
      openAcc.style.margin = '0';
      openAcc.textContent = '👁️ Ouvrir';
      openAcc.addEventListener('click', () => openAccountScreen(u.id));
      actions.appendChild(openAcc);
      if (state.me.isAdmin) actions.appendChild(chat);
      if (state.me.isAdmin) {
        const adm = document.createElement('button');
        adm.className = 'btn small' + (u.admin ? ' danger' : '');
        adm.textContent = u.admin ? 'Retirer admin' : 'Nommer admin';
        adm.addEventListener('click', async () => {
          if (!confirm((u.admin ? 'Retirer les droits d\'administrateur à « ' : 'Donner les droits d\'administrateur à « ') + u.pseudo + ' » ?')) return;
          try {
            await api('/api/admin/users/' + u.id + '/admin', 'POST', { value: !u.admin });
            toast(u.admin ? 'Administrateur retiré.' : u.pseudo + ' est maintenant administrateur.');
            loadAdminUsers();
          } catch (err) { toast(err.message); }
        });
        actions.appendChild(adm);
      }
      const ban = document.createElement('button');
      ban.className = 'btn small' + (u.bannedUntil ? '' : ' danger');
      ban.textContent = u.bannedUntil ? 'Débannir' : (state.me.isAdmin ? 'Bannir' : 'Demander un ban');
      ban.addEventListener('click', async () => {
        if (!u.bannedUntil) return openBan(u.id, u.pseudo, loadAdminUsers);
        try { await api('/api/admin/users/' + u.id + '/unban', 'POST'); toast('Compte débanni.'); loadAdminUsers(); }
        catch (err) { toast(err.message); }
      });
      if (state.me.isAdmin || (!u.bannedUntil && !u.admin)) actions.appendChild(ban);
      if (u.channelBan) {
        const cb = document.createElement('button');
        cb.className = 'btn small';
        cb.textContent = 'Autoriser les chaînes';
        cb.addEventListener('click', async () => {
          try { await api('/api/admin/users/' + u.id + '/channel-ban', 'POST', { value: false }); toast('Chaînes autorisées.'); loadAdminUsers(); }
          catch (err) { toast(err.message); }
        });
        actions.appendChild(cb);
      }
      if (state.me.isAdmin) actions.appendChild(del);
      cell(actions);

      body.appendChild(tr);
    });
  }


  /* ---------------- Fenêtre plein écran : compte d'un utilisateur ---------------- */

  const accState = { users: [], sel: null, q: '' };
  const PERM_BAN_TS = 32503680000000;

  function accEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const plural = (n, a, b) => n + ' ' + (n > 1 ? b : a);
  const accName = (u) => u.nickname || u.pseudo;
  const accBanText = (until) => (until >= PERM_BAN_TS ? '⛔ Banni définitivement' : '⛔ Banni jusqu\'au ' + fmtDate(until) + ' ' + fmtTime(until));

  async function openAccountScreen(id) {
    accState.q = '';
    accState.sel = null;
    $('acc-search').value = '';
    $('acc-screen').classList.remove('show-detail');
    $('acc-detail').innerHTML = '';
    $('acc-detail').appendChild(accEl('p', 'hint acc-placeholder', 'Choisis un compte dans la liste pour l\'ouvrir.'));
    openModal('modal-account');
    await loadAccountList();
    if (id) showAccount(id);
  }

  async function loadAccountList() {
    try {
      accState.users = (await api('/api/admin/users')).users;
    } catch (err) {
      return toast(err.message);
    }
    renderAccountList();
  }

  function renderAccountList() {
    const box = $('acc-list');
    box.innerHTML = '';
    const q = accState.q.trim().toLowerCase();
    const list = accState.users
      .filter((u) => !q || (u.pseudo + ' ' + (u.nickname || '')).toLowerCase().includes(q))
      .sort((a, b) => accName(a).localeCompare(accName(b), 'fr'));
    if (!list.length) {
      box.appendChild(accEl('p', 'hint', q ? 'Aucun compte ne correspond.' : 'Aucun compte pour le moment.'));
      return;
    }
    list.forEach((u) => {
      const row = accEl('button', 'acc-row' + (u.id === accState.sel ? ' active' : ''));
      row.type = 'button';
      row.appendChild(makeAvatar({ avatar: u.avatar, name: accName(u) }));
      const t = accEl('div', 'acc-row-text');
      t.appendChild(accEl('b', '', (u.admin ? '👑 ' : '') + accName(u)));
      let sub = u.online ? '● En ligne' : '○ Hors ligne';
      if (u.nickname) sub = '@' + u.pseudo + ' · ' + sub;
      if (u.bannedUntil) sub = '⛔ Banni · ' + sub;
      t.appendChild(accEl('small', '', sub));
      row.appendChild(t);
      row.addEventListener('click', () => showAccount(u.id));
      box.appendChild(row);
    });
  }

  async function showAccount(id, silent) {
    accState.sel = id;
    const box = $('acc-detail');
    if (!silent) {
      $('acc-screen').classList.add('show-detail');
      box.innerHTML = '';
      box.appendChild(accEl('p', 'hint acc-placeholder', 'Chargement…'));
    }
    renderAccountList();
    let d;
    try {
      d = await api('/api/admin/users/' + id + '/overview');
    } catch (err) {
      toast(err.message);
      if (accState.sel === id) {
        accState.sel = null;
        $('acc-screen').classList.remove('show-detail');
        box.innerHTML = '';
        box.appendChild(accEl('p', 'hint acc-placeholder', 'Choisis un compte dans la liste pour l\'ouvrir.'));
        renderAccountList();
      }
      return;
    }
    if (accState.sel !== id) return;
    renderAccountDetail(d);
  }

  async function refreshAccountScreen() {
    await loadAccountList();
    if (accState.sel) showAccount(accState.sel, true);
  }

  function renderAccountDetail(d) {
    const box = $('acc-detail');
    const u = d.user;
    const supreme = !!state.me.isAdmin;
    const reload = async () => { await loadAccountList(); await showAccount(u.id, true); };
    box.innerHTML = '';

    // En-tête
    const head = accEl('div', 'acc-card acc-head');
    head.appendChild(makeAvatar({ avatar: u.avatar, name: accName(u) }, true));
    const ht = accEl('div', 'acc-head-text');
    ht.appendChild(accEl('h3', '', (u.admin ? '👑 ' : '') + accName(u)));
    if (u.nickname) ht.appendChild(accEl('div', 'acc-sub', '@' + u.pseudo));
    const badges = accEl('div', 'acc-badges');
    const badge = (t, k) => badges.appendChild(accEl('span', 'acc-badge' + (k ? ' ' + k : ''), t));
    badge(u.online ? '● En ligne' : '○ Hors ligne', u.online ? 'ok' : '');
    badge(u.isPublic ? '🌍 Public' : '🔒 Privé');
    if (u.admin) badge('Administrateur');
    if (u.bannedUntil) badge(accBanText(u.bannedUntil), 'bad');
    if (u.channelBan) badge('🚫 Chaînes interdites', 'bad');
    ht.appendChild(badges);
    head.appendChild(ht);
    box.appendChild(head);

    // Informations
    const info = accEl('div', 'acc-card');
    info.appendChild(accEl('h4', '', 'Informations'));
    const row = (label, value, onEdit, mono) => {
      const r = accEl('div', 'acc-info-row');
      r.appendChild(accEl('span', 'acc-label', label));
      r.appendChild(accEl(mono ? 'code' : 'span', 'acc-value', value));
      if (onEdit) {
        const b = accEl('button', 'btn small', '✏️');
        b.type = 'button';
        b.title = 'Modifier';
        b.addEventListener('click', onEdit);
        r.appendChild(b);
      }
      info.appendChild(r);
    };
    const saveNames = async (body, okText) => {
      try { await api('/api/admin/users/' + u.id + '/names', 'PUT', body); toast(okText); reload(); }
      catch (err) { toast(err.message); }
    };
    row('Pseudo (identifiant de connexion)', u.pseudo, supreme ? () => {
      const v = prompt('Nouveau pseudo pour « ' + u.pseudo + ' » (2 à 20 caractères).\nC\'est aussi l\'identifiant qu\'il utilise pour se connecter :', u.pseudo);
      if (v === null || v.trim() === u.pseudo) return;
      saveNames({ pseudo: v }, 'Pseudo modifié.');
    } : null);
    row('Surnom', u.nickname || '—', supreme ? () => {
      const v = prompt('Nouveau surnom pour « ' + u.pseudo + ' » (20 caractères max).\nLaisse vide pour l\'enlever :', u.nickname || '');
      if (v === null || v.trim() === (u.nickname || '')) return;
      saveNames({ nickname: v }, 'Surnom modifié.');
    } : null);
    row('Code secret', u.pin, null, true);
    row('Code de partage', u.shareCode, supreme ? async () => {
      const v = prompt('Nouveau code de partage (4 chiffres) pour « ' + u.pseudo + ' ».\nLaisse vide pour en générer un au hasard :', u.shareCode);
      if (v === null) return;
      try {
        const r = await api('/api/admin/users/' + u.id + '/share-code', 'POST', { code: v.trim() });
        toast('Code de partage de ' + u.pseudo + ' : ' + r.shareCode);
        reload();
      } catch (err) { toast(err.message); }
    } : null, true);
    row('Créé le', fmtDate(u.createdAt));
    row('Messages envoyés / reçus', d.stats.sent + ' / ' + d.stats.received);
    row('Avertissements', String(u.warnings));
    row('Signalements reçus / envoyés', d.stats.reportsReceived + ' / ' + d.stats.reportsSent);
    box.appendChild(info);

    // Actions
    const act = accEl('div', 'acc-card');
    act.appendChild(accEl('h4', '', 'Actions'));
    const bar = accEl('div', 'acc-actions');
    const btn = (label, cls, fn) => {
      const b = accEl('button', 'btn small' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.addEventListener('click', fn);
      bar.appendChild(b);
    };
    const run = async (fn, okText) => {
      try { await fn(); if (okText) toast(okText); reload(); } catch (err) { toast(err.message); }
    };
    if (supreme) btn('🔎 Voir en profondeur', 'primary', () => openDeep(u));
    if (supreme) btn('💬 Discuter', '', () => { closeModal('modal-account'); closeModal('modal-admin'); openChat(u.id); });
    if (supreme || (!u.bannedUntil && !u.admin)) {
      btn(u.bannedUntil ? 'Débannir' : (supreme ? 'Bannir' : 'Demander un ban'), u.bannedUntil ? '' : 'danger', () => {
        if (!u.bannedUntil) return openBan(u.id, u.pseudo, reload);
        run(() => api('/api/admin/users/' + u.id + '/unban', 'POST'), 'Compte débanni.');
      });
    }
    if (supreme || !u.admin) {
      btn(u.channelBan ? 'Autoriser les chaînes' : 'Interdire les chaînes', '', () =>
        run(() => api('/api/admin/users/' + u.id + '/channel-ban', 'POST', { value: !u.channelBan }), u.channelBan ? 'Chaînes autorisées.' : 'Chaînes interdites.'));
    }
    if (supreme) {
      btn(u.admin ? 'Retirer admin' : 'Nommer admin', u.admin ? 'danger' : '', () => {
        if (!confirm((u.admin ? 'Retirer les droits d\'administrateur à « ' : 'Donner les droits d\'administrateur à « ') + u.pseudo + ' » ?')) return;
        run(() => api('/api/admin/users/' + u.id + '/admin', 'POST', { value: !u.admin }), u.admin ? 'Administrateur retiré.' : u.pseudo + ' est maintenant administrateur.');
      });
      btn('Supprimer le compte', 'danger', async () => {
        if (!confirm('Supprimer définitivement le compte « ' + u.pseudo + ' » et ses messages ?')) return;
        try {
          await api('/api/admin/users/' + u.id, 'DELETE');
          if (state.current === u.id) $('btn-back').click();
          toast('Compte supprimé.');
          accState.sel = null;
          $('acc-screen').classList.remove('show-detail');
          $('acc-detail').innerHTML = '';
          $('acc-detail').appendChild(accEl('p', 'hint acc-placeholder', 'Choisis un compte dans la liste pour l\'ouvrir.'));
          loadAccountList();
        } catch (err) { toast(err.message); }
      });
    }
    act.appendChild(bar);
    box.appendChild(act);

    // Sections
    const section = (title, count) => {
      const s = accEl('div', 'acc-card');
      s.appendChild(accEl('h4', '', title + (count !== undefined ? ' (' + count + ')' : '')));
      box.appendChild(s);
      return s;
    };
    const none = (s, t) => s.appendChild(accEl('p', 'hint', t));
    const line = (s, { avatar, text, sub, onClick }) => {
      const r = accEl(onClick ? 'button' : 'div', 'acc-line');
      if (onClick) { r.type = 'button'; r.addEventListener('click', onClick); }
      if (avatar) r.appendChild(makeAvatar(avatar));
      const t = accEl('div', 'acc-line-text');
      t.appendChild(accEl('span', '', text));
      if (sub) t.appendChild(accEl('small', '', sub));
      r.appendChild(t);
      s.appendChild(r);
    };

    const sc = section('Contacts', d.contacts.length);
    if (!d.contacts.length) none(sc, 'Aucun contact.');
    d.contacts.forEach((ct) => line(sc, {
      avatar: { avatar: ct.avatar, name: accName(ct) },
      text: accName(ct),
      sub: (ct.nickname ? '@' + ct.pseudo + ' · ' : '') + (ct.online ? '● En ligne' : '○ Hors ligne'),
      onClick: () => showAccount(ct.id),
    }));

    const sg = section('Groupes', d.groups.length);
    if (!d.groups.length) none(sg, 'Aucun groupe.');
    d.groups.forEach((g) => line(sg, { avatar: { name: g.name, isGroup: true }, text: g.name, sub: plural(g.members, 'membre', 'membres') + (g.owner ? ' · créateur' : '') }));

    const sch = section('Chaînes', d.channels.owned.length);
    if (!d.channels.owned.length) none(sch, 'Aucune chaîne créée.');
    d.channels.owned.forEach((ch) => line(sch, { text: '📢 ' + ch.name, sub: plural(ch.subscribers, 'abonné', 'abonnés') + ' · ' + plural(ch.posts, 'publication', 'publications') }));
    if (d.channels.following) sch.appendChild(accEl('p', 'hint', 'Abonné à ' + plural(d.channels.following, 'autre chaîne', 'autres chaînes') + '.'));

    const ss = section('Stories des dernières 24 h', d.stories.length);
    if (!d.stories.length) none(ss, 'Aucune story en ce moment.');
    else {
      const grid = accEl('div', 'acc-stories');
      d.stories.forEach((st) => {
        const it = accEl('div', 'acc-story');
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.src = st.image;
        it.appendChild(img);
        it.appendChild(accEl('small', '', '❤ ' + st.likes + ' · 👁 ' + st.views + ' · ' + fmtTime(st.ts)));
        if (st.text) it.appendChild(accEl('small', '', st.text));
        grid.appendChild(it);
      });
      ss.appendChild(grid);
    }

    const REPORT_ST = { open: 'En attente', warned: 'Averti', dismissed: 'Classé', banned: 'Banni', forwarded: 'Transmis à l\'admin suprême' };
    const sr = section('Signalements reçus', d.reports.length);
    if (!d.reports.length) none(sr, 'Aucun signalement.');
    d.reports.forEach((r) => line(sr, { text: r.reason, sub: 'Par ' + r.reporterName + ' · ' + fmtDate(r.ts) + ' · ' + (REPORT_ST[r.status] || r.status) }));

    const BAN_ST = { active: 'En cours', ended: 'Terminé', expired: 'Expiré' };
    const sb = section('Historique des bans', d.bans.length);
    if (!d.bans.length) none(sb, 'Jamais banni.');
    d.bans.forEach((b) => {
      let sub = fmtDate(b.ts) + ' ' + fmtTime(b.ts) + ' · par ' + b.byName + (b.requestedBy ? ' (demandé par ' + b.requestedBy + ')' : '') + ' · ' + (BAN_ST[b.status] || b.status);
      if (b.endedBy) sub += ' · ' + b.endedBy;
      line(sb, { text: (b.permanent ? 'Définitif' : plural(b.minutes, 'minute', 'minutes')) + (b.reason ? ' — ' + b.reason : ''), sub });
    });
  }

  $('acc-search').addEventListener('input', (e) => { accState.q = e.target.value; renderAccountList(); });
  $('acc-back').addEventListener('click', () => $('acc-screen').classList.remove('show-detail'));

  /* ---------------- Compte en profondeur (administrateur suprême, lecture seule) ---------------- */

  const deep = { id: null, tab: 'messages', data: null, conv: null };

  function viewImage(url, onDelete, onSend) {
    $('viewer-img').src = url;
    const del = $('viewer-del');
    del.classList.toggle('hidden', !onDelete);
    del.onclick = onDelete || null;
    const snd = $('viewer-send');
    snd.classList.toggle('hidden', !onSend);
    snd.onclick = onSend || null;
    openModal('modal-viewer');
  }

  async function openDeep(u) {
    deep.id = u.id;
    deep.tab = 'messages';
    deep.conv = null;
    deep.data = null;
    $('deep-title').textContent = '🔎 ' + accName(u);
    $('modal-deep').classList.remove('in-thread');
    $('deep-body').innerHTML = '';
    $('deep-body').appendChild(accEl('p', 'hint acc-placeholder', 'Chargement…'));
    openModal('modal-deep');
    renderDeepTabs();
    try {
      deep.data = await api('/api/admin/users/' + u.id + '/deep');
    } catch (err) {
      toast(err.message);
      closeModal('modal-deep');
      return;
    }
    renderDeep();
  }

  function renderDeepTabs() {
    document.querySelectorAll('[data-deep-tab]').forEach((b) => b.classList.toggle('active', b.dataset.deepTab === deep.tab));
  }

  document.querySelectorAll('[data-deep-tab]').forEach((b) => b.addEventListener('click', () => {
    deep.tab = b.dataset.deepTab;
    deep.conv = null;
    $('modal-deep').classList.remove('in-thread');
    renderDeepTabs();
    renderDeep();
  }));

  $('deep-back').addEventListener('click', () => {
    deep.conv = null;
    $('modal-deep').classList.remove('in-thread');
    renderDeep();
  });

  function renderDeep() {
    const box = $('deep-body');
    const d = deep.data;
    box.innerHTML = '';
    if (!d) return;
    if (deep.tab === 'messages') return renderDeepConversations(box, d);
    if (deep.tab === 'calls') return renderDeepCalls(box, d);
    renderDeepPhotos(box, d);
  }

  function deepPreview(l) {
    const who = l.mine ? 'Lui : ' : '';
    return who + (l.audio ? '🎤 Message vocal' : l.image ? (l.text ? '📷 ' + l.text : '📷 Photo') : l.text);
  }

  function renderDeepConversations(box, d) {
    const card = accEl('div', 'acc-card');
    card.appendChild(accEl('h4', '', 'Conversations (' + d.conversations.length + ')'));
    if (!d.conversations.length) card.appendChild(accEl('p', 'hint', 'Aucune conversation.'));
    d.conversations.forEach((c) => {
      const r = accEl('button', 'acc-line');
      r.type = 'button';
      r.appendChild(makeAvatar({ avatar: c.avatar, name: c.name, pseudo: c.name, isGroup: c.group }));
      const t = accEl('div', 'acc-line-text');
      t.appendChild(accEl('span', '', (c.group ? '👥 ' : '') + c.name));
      t.appendChild(accEl('small', '', deepPreview(c.last) + ' · ' + fmtDate(c.last.ts) + ' ' + fmtTime(c.last.ts) + ' · ' + plural(c.count, 'message', 'messages')));
      r.appendChild(t);
      r.addEventListener('click', () => openDeepConversation(c));
      card.appendChild(r);
    });
    box.appendChild(card);
  }

  async function openDeepConversation(c) {
    deep.conv = c.id;
    $('modal-deep').classList.add('in-thread');
    const box = $('deep-body');
    box.innerHTML = '';
    box.appendChild(accEl('p', 'hint acc-placeholder', 'Chargement…'));
    let r;
    try {
      r = await api('/api/admin/users/' + deep.id + '/deep/conversation/' + encodeURIComponent(c.id));
    } catch (err) {
      toast(err.message);
      return;
    }
    if (deep.conv !== c.id) return;
    box.innerHTML = '';
    box.appendChild(accEl('h4', 'deep-conv-title', (c.group ? '👥 ' : '') + c.name));
    const th = accEl('div', 'deep-thread');
    if (!r.messages.length) th.appendChild(accEl('p', 'hint', 'Aucun message.'));
    let lastDay = '';
    r.messages.forEach((m) => {
      const day = fmtDate(m.ts);
      if (day !== lastDay) {
        lastDay = day;
        const sep = accEl('p', 'hint', day);
        sep.style.cssText = 'text-align:center;margin:8px 0 2px';
        th.appendChild(sep);
      }
      const b = accEl('div', 'deep-msg' + (m.mine ? ' mine' : ''));
      if (c.group && !m.mine) b.appendChild(accEl('div', 'sender', m.fromName));
      if (m.image) {
        const img = document.createElement('img');
        img.src = m.image;
        img.alt = 'Photo';
        img.loading = 'lazy';
        img.addEventListener('click', () => viewImage(m.image));
        b.appendChild(img);
      }
      if (m.audio) {
        const au = document.createElement('audio');
        au.controls = true;
        au.preload = 'metadata';
        au.src = m.audio;
        b.appendChild(au);
      }
      if (m.text) b.appendChild(accEl('div', '', m.text));
      b.appendChild(accEl('time', '', (m.edited ? 'modifié · ' : '') + fmtTime(m.ts)));
      th.appendChild(b);
    });
    box.appendChild(th);
    const main = box.parentElement;
    main.scrollTop = main.scrollHeight;
  }

  function renderDeepCalls(box, d) {
    const card = accEl('div', 'acc-card');
    card.appendChild(accEl('h4', '', 'Derniers appels (' + d.calls.length + ')'));
    if (!d.calls.length) card.appendChild(accEl('p', 'hint', 'Aucun appel.'));
    const dur = (s) => Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
    d.calls.forEach((c) => {
      let label;
      if (c.outgoing) label = c.status === 'ended' ? '↗ Sortant' : c.status === 'declined' ? '↗ Refusé' : '↗ Sans réponse';
      else label = c.status === 'ended' ? '↙ Reçu' : c.status === 'declined' ? '↙ Refusé' : '↙ Manqué';
      const r = accEl('div', 'acc-line');
      const t = accEl('div', 'acc-line-text');
      t.appendChild(accEl('span', '', (c.video ? '🎥 ' : '📞 ') + (c.group ? '👥 ' : '') + c.name));
      t.appendChild(accEl('small', '', label + ' · ' + fmtDate(c.ts) + ' ' + fmtTime(c.ts) + (c.duration ? ' · ' + dur(c.duration) : '')));
      r.appendChild(t);
      card.appendChild(r);
    });
    box.appendChild(card);
  }

  function renderDeepPhotos(box, d) {
    const SRC = { gallery: '🖼 Galerie', story: '📸 Story', sent: '↗ Envoyée', received: '↙ Reçue' };
    const card = accEl('div', 'acc-card');
    card.appendChild(accEl('h4', '', 'Photos (' + d.photos.length + ')'));
    if (!d.photos.length) card.appendChild(accEl('p', 'hint', 'Aucune photo.'));
    const grid = accEl('div', 'acc-stories');
    d.photos.forEach((p) => {
      const it = accEl('div', 'acc-story');
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = '';
      img.loading = 'lazy';
      img.style.cursor = 'pointer';
      img.addEventListener('click', () => viewImage(p.url));
      it.appendChild(img);
      it.appendChild(accEl('small', '', (SRC[p.source] || p.source) + (p.context && p.source !== 'story' ? ' · ' + p.context : '') + ' · ' + fmtDate(p.ts)));
      grid.appendChild(it);
    });
    card.appendChild(grid);
    box.appendChild(card);
  }

  /* ---------------- Appareil photo & galerie personnelle ---------------- */

  const cam = { stream: null, facing: 'environment', shot: '', gallery: [] };

  function camMessage(text) {
    const m = $('cam-msg');
    m.textContent = text || '';
    m.classList.toggle('hidden', !text);
  }

  function stopCamera() {
    if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    $('cam-video').srcObject = null;
  }

  async function startCamera() {
    stopCamera();
    camMessage('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return camMessage('Caméra indisponible ici : appuie sur le bouton rond pour prendre ou choisir une photo.');
    }
    try {
      cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: cam.facing }, audio: false });
      if ($('modal-camera').classList.contains('hidden')) return stopCamera();
      const v = $('cam-video');
      v.srcObject = cam.stream;
      v.classList.toggle('mirror', cam.facing === 'user');
    } catch (e) {
      camMessage('Accès à la caméra impossible : appuie sur le bouton rond pour prendre ou choisir une photo.');
    }
  }

  function camLiveMode() {
    cam.shot = '';
    $('cam-shot').classList.add('hidden');
    $('cam-video').classList.remove('hidden');
    $('cam-bar').classList.remove('hidden');
    $('cam-review').classList.add('hidden');
    $('cam-send').classList.add('hidden');
    $('cam-title').classList.remove('hidden');
  }

  function camReviewMode(dataUrl) {
    cam.shot = dataUrl;
    $('cam-shot').src = dataUrl;
    $('cam-shot').classList.remove('hidden');
    $('cam-video').classList.add('hidden');
    $('cam-bar').classList.add('hidden');
    $('cam-review').classList.remove('hidden');
    $('cam-send').classList.remove('hidden');
    $('cam-title').classList.add('hidden');
  }

  function renderThumb() {
    const first = cam.gallery[0];
    $('cam-thumb').classList.toggle('hidden', !first);
    $('cam-thumb-empty').classList.toggle('hidden', !!first);
    if (first) $('cam-thumb').src = first.url;
  }

  async function loadGallery() {
    cam.gallery = await api('/api/gallery');
    renderThumb();
  }

  $('btn-camera').addEventListener('click', async () => {
    camLiveMode();
    openModal('modal-camera');
    startCamera();
    try { await loadGallery(); } catch (e) { /* ignore */ }
  });

  // La caméra s'éteint dès que la fenêtre se ferme (croix, Échap ou clic à côté)
  new MutationObserver(() => {
    if ($('modal-camera').classList.contains('hidden')) stopCamera();
  }).observe($('modal-camera'), { attributes: true, attributeFilter: ['class'] });

  $('cam-flip').addEventListener('click', () => {
    cam.facing = cam.facing === 'user' ? 'environment' : 'user';
    startCamera();
  });

  $('cam-shutter').addEventListener('click', () => {
    const v = $('cam-video');
    if (!cam.stream || !v.videoWidth) return $('cam-file').click();
    const k = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * k);
    c.height = Math.round(v.videoHeight * k);
    const ctx = c.getContext('2d');
    if (cam.facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(v, 0, 0, c.width, c.height);
    camReviewMode(c.toDataURL('image/jpeg', 0.85));
  });

  $('cam-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const img = await readImage(f);
      camReviewMode(renderToDataUrl(img, { max: 1600, quality: 0.85 }));
    } catch (err) { toast(err.message); }
  });


  // Envoyer une photo (celle qu'on vient de prendre, ou une de la galerie) à des amis
  let sendSrc = null; // { dataUrl } ou { url }

  function openSendPicker(src) {
    sendSrc = src;
    const box = $('cam-send-list');
    box.innerHTML = '';
    $('cam-send-error').textContent = '';
    const people = state.contacts.filter((c) => !c.isAdmin && !c.isSystem);
    if (!people.length) box.appendChild(accEl('p', 'hint', 'Aucun contact pour le moment.'));
    people.forEach((c) => {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = c.id;
      lab.appendChild(cb);
      lab.appendChild(makeAvatar(c));
      lab.appendChild(accEl('span', '', (c.isGroup ? '👥 ' : '') + c.name));
      box.appendChild(lab);
    });
    openModal('modal-cam-send');
  }

  const camSendShot = () => { if (cam.shot) openSendPicker({ dataUrl: cam.shot }); };
  $('cam-send').addEventListener('click', camSendShot);
  $('cam-review-send').addEventListener('click', camSendShot);

  async function urlToDataUrl(url) {
    const blob = await (await fetch(url)).blob();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('Lecture de la photo impossible.'));
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
  }

  $('cam-send-go').addEventListener('click', async () => {
    const ids = [...$('cam-send-list').querySelectorAll('input:checked')].map((i) => i.value);
    if (!ids.length) { $('cam-send-error').textContent = 'Choisis au moins un contact.'; return; }
    if (!sendSrc) return;
    const btn = $('cam-send-go');
    btn.disabled = true;
    try {
      // on envoie toujours une copie : supprimer le message ne supprime pas la photo de la galerie (et inversement)
      const data = sendSrc.dataUrl || (await urlToDataUrl(sendSrc.url));
      const { url } = await api('/api/upload', 'POST', { data });
      let fails = 0;
      await Promise.all(ids.map((to) => new Promise((resolve) => {
        state.socket.emit('message:send', { to, text: '', image: url }, (r) => { if (r && r.error) fails++; resolve(); });
      })));
      closeModal('modal-cam-send');
      if (sendSrc.dataUrl) camLiveMode(); else closeModal('modal-viewer');
      sendSrc = null;
      toast(fails ? 'Envoyée, mais ' + plural(fails, 'envoi a échoué', 'envois ont échoué') + '.' : 'Photo envoyée à ' + plural(ids.length, 'contact', 'contacts') + ' !');
    } catch (err) { $('cam-send-error').textContent = err.message; }
    finally { btn.disabled = false; }
  });

  $('cam-save').addEventListener('click', async () => {
    if (!cam.shot) return;
    const btn = $('cam-save');
    btn.disabled = true;
    try {
      await api('/api/gallery', 'POST', { data: cam.shot });
      await loadGallery();
      toast('Photo enregistrée dans ta galerie.');
      camLiveMode();
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; }
  });

  function renderGallery() {
    $('gal-count').textContent = cam.gallery.length ? plural(cam.gallery.length, 'photo', 'photos') : 'Ta galerie est vide. Prends une photo avec l\'appareil photo !';
    const grid = $('gal-grid');
    grid.innerHTML = '';
    cam.gallery.forEach((g) => {
      const b = document.createElement('button');
      b.type = 'button';
      const img = document.createElement('img');
      img.src = g.url;
      img.alt = '';
      img.loading = 'lazy';
      b.appendChild(img);
      b.addEventListener('click', () => viewImage(g.url, async () => {
        if (!confirm('Supprimer cette photo de ta galerie ?')) return;
        try {
          await api('/api/gallery/' + g.id, 'DELETE');
          closeModal('modal-viewer');
          await loadGallery();
          renderGallery();
        } catch (err) { toast(err.message); }
      }, () => openSendPicker({ url: g.url })));
      grid.appendChild(b);
    });
  }

  async function openGallery() {
    try { await loadGallery(); } catch (err) { return toast(err.message); }
    renderGallery();
    openModal('modal-gallery');
  }
  $('cam-gallery').addEventListener('click', openGallery);
  $('cam-gallery-top').addEventListener('click', openGallery);


  /* ---------------- Onglets : Discussions / Stories / Appels ---------------- */

  state.tab = 'chats';
  state.stories = [];
  state.viewer = null;
  state.storyImg = '';
  state.call = null;

  function showTab(tab) {
    state.tab = tab;
    ['chats', 'stories', 'channels', 'calls'].forEach((t) => {
      $('pane-' + t).classList.toggle('hidden', t !== tab);
      document.querySelector('[data-tab="' + t + '"]').classList.toggle('active', t === tab);
    });
    if (tab === 'stories') loadStories().catch((e) => toast(e.message));
    if (tab === 'channels') loadChannels().catch((e) => toast(e.message));
    if (tab === 'calls') loadCalls();
  }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function afterStart() {
    const admin = !!state.me.isAdmin;
    $('tabbar').classList.toggle('hidden', admin);
    showTab('chats');
    if (state.me.staff) refreshReportsBadge();
    if (!admin) loadStories().catch(() => {});
  }

  const emptyDiv = (text) => {
    const e = document.createElement('div');
    e.className = 'empty-list';
    e.textContent = text;
    return e;
  };

  function bindExtraSocket(socket) {
    socket.on('banned', ({ message }) => forceLogout(message));
    socket.on('requests:update', () => {
      if (!state.me || !state.me.isAdmin) return;
      if (!$('modal-requests').classList.contains('hidden')) loadRequests(); else refreshReportsBadge();
    });
    socket.on('message:edited', (msg) => {
      const other = isGroupId(msg.to) ? msg.to : msg.from === state.me.id ? msg.to : msg.from;
      const list = state.cache[other];
      const i = list ? list.findIndex((x) => x.id === msg.id) : -1;
      if (i !== -1) list[i] = msg;
      const c = state.contacts.find((x) => x.id === other);
      if (c && c.last && c.last.id === msg.id) c.last = msg;
      rerenderCurrent(other);
      renderContacts();
    });
    socket.on('message:deleted', async ({ id, from, to }) => {
      const other = isGroupId(to) ? to : from === state.me.id ? to : from;
      const list = state.cache[other];
      if (list) { const i = list.findIndex((x) => x.id === id); if (i !== -1) list.splice(i, 1); }
      rerenderCurrent(other);
      try { await loadContacts(); } catch (e) { /* ignore */ }
    });
    socket.on('me:update', async () => {
      try {
        state.me = await api('/api/me');
        renderMe();
        if (state.me.staff) refreshReportsBadge();
        toast(state.me.staff ? 'Tu es maintenant administrateur.' : 'Tu n\'es plus administrateur.');
      } catch (e) { /* ignore */ }
    });
    socket.on('channels:update', () => {
      if (!state.me || state.me.isAdmin) return;
      loadChannels().catch(() => {});
      if (!$('modal-channel').classList.contains('hidden') && state.chan) loadChanPosts(state.chan).catch(() => {});
    });
    socket.on('stories:update', () => {
      if (state.me && !state.me.isAdmin) loadStories().catch(() => {});
    });
    socket.on('calls:update', () => { if (state.tab === 'calls') loadCalls(); });
    socket.on('reports:update', () => {
      if (!state.me || !state.me.staff) return;
      if (!$('modal-reports').classList.contains('hidden')) loadReports(); else refreshReportsBadge();
    });

    socket.on('call:incoming', ({ callId, from, name, video, groupName }) => {
      if (state.call) { socket.emit('call:end', { callId }); return; }
      const c = state.contacts.find((x) => x.id === from);
      state.call = { id: callId, group: !!groupName, video: !!video, dir: 'in', local: null, peers: {}, joined: false, known: {}, ice: null };
      openCallUi(groupName || name, (groupName ? name + ' appelle le groupe' : 'Appel') + (video ? ' vidéo' : '') + ' entrant…');
      callTile('caller', name, { name, pseudo: name, avatar: c ? c.avatar : '' }, false);
      setCallButtons('ringing');
    });
    socket.on('call:joined', ({ callId, peers }) => {
      const call = state.call;
      if (!call || call.id !== callId) return;
      call.joined = true;
      peers.forEach((p) => { call.known[p.id] = p; offerTo(call, p).catch(() => toast('Connexion impossible avec ' + p.name + '.')); });
    });
    socket.on('call:peer-joined', ({ callId, peer }) => {
      const call = state.call;
      if (!call || call.id !== callId) return;
      call.known[peer.id] = peer;
      makePeer(call, peer);
      setCallStatus('Connexion…');
    });
    socket.on('call:peer-left', ({ callId, id }) => {
      const call = state.call;
      if (!call || call.id !== callId) return;
      const p = call.peers[id];
      if (p) toast((call.known[id] ? call.known[id].name : 'Un participant') + ' a quitté l\'appel.');
      removePeer(call, id);
    });
    socket.on('call:media', ({ callId, from, cam, mic }) => {
      const call = state.call;
      const p = call && call.id === callId && call.peers[from];
      if (!p) return;
      p.cam = cam;
      p.mic = mic;
      refreshTile(p);
    });
    socket.on('call:signal', async ({ callId, from, data }) => {
      const call = state.call;
      if (!call || call.id !== callId || !call.joined || !data) return;
      const peer = call.peers[from] || makePeer(call, call.known[from] || { id: from, name: 'Participant', avatar: '' });
      const pc = peer.pc;
      try {
        if (data.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
          else peer.pending.push(data.candidate);
        } else if (data.sdp) {
          await pc.setRemoteDescription(data.sdp);
          for (const cand of peer.pending.splice(0)) await pc.addIceCandidate(cand).catch(() => {});
          if (data.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('call:signal', { callId, to: from, data: { sdp: pc.localDescription } });
          }
        }
      } catch (e) { /* ignore */ }
    });
    socket.on('call:ended', ({ callId, reason }) => {
      const call = state.call;
      if (!call || call.id !== callId) return;
      const msgs = { declined: 'Appel refusé.', offline: 'Un participant s\'est déconnecté.', missed: 'Appel manqué.', hangup: 'Appel terminé.' };
      cleanupCall();
      toast(msgs[reason] || 'Appel terminé.');
    });
  }

  /* ---------------- Profil du contact ---------------- */

  function openProfile() {
    const c = state.contacts.find((x) => x.id === state.current);
    if (!c) return;
    if (c.isGroup) return openGroupProfile(c);
    const av = $('profile-avatar');
    av.innerHTML = '';
    av.appendChild(makeAvatar(c, true));
    $('profile-name').textContent = (c.staff ? '🛠️ ' : '') + c.name;
    $('profile-pseudo').textContent = c.pseudo;
    $('profile-visibility').textContent = c.isPublic ? '🌍 Public' : '🔒 Privé';
    $('profile-nick').textContent = c.nickname || '—';
    $('profile-code').textContent = !c.isAdmin && c.shareCode ? c.shareCode : '—';
    $('profile-since').textContent = c.since ? fmtDate(c.since) : '—';
    $('profile-alias').value = c.alias || '';
    $('profile-actions').classList.toggle('hidden', !!c.isAdmin || !!c.isSystem || !!state.me.isAdmin);
    const special = !!(c.isAdmin || c.isSystem);
    $('profile-dl').classList.toggle('hidden', special);
    $('profile-desc').textContent = c.description || '';
    $('profile-desc').classList.toggle('hidden', !special || !c.description);
    openModal('modal-profile');
  }
  $('chat-id').addEventListener('click', openProfile);

  $('profile-alias-save').addEventListener('click', async () => {
    try {
      const r = await api('/api/contacts/' + state.current + '/alias', 'PUT', { alias: $('profile-alias').value });
      await loadContacts();
      openProfile();
      toast(r.alias ? 'Surnom enregistré.' : 'Surnom retiré.');
    } catch (err) { toast(err.message); }
  });

  $('profile-delete').addEventListener('click', async () => {
    const c = state.contacts.find((x) => x.id === state.current);
    if (!c || !confirm('Supprimer « ' + c.name + ' » de tes contacts ?')) return;
    try {
      await api('/api/contacts/' + c.id, 'DELETE');
      closeModal('modal-profile');
      $('btn-back').click();
      delete state.cache[c.id];
      await loadContacts();
      toast('Contact supprimé.');
    } catch (err) { toast(err.message); }
  });

  $('profile-report').addEventListener('click', () => {
    $('report-reason').value = '';
    $('report-error').textContent = '';
    closeModal('modal-profile');
    openModal('modal-report');
    $('report-reason').focus();
  });

  $('report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('report-error').textContent = '';
    try {
      await api('/api/contacts/' + state.current + '/report', 'POST', { reason: $('report-reason').value });
      closeModal('modal-report');
      toast('Signalement envoyé à l\'administrateur.');
    } catch (err) { $('report-error').textContent = err.message; }
  });

  /* ---------------- Groupes ---------------- */

  function openGroupNew() {
    $('group-new-name').value = '';
    $('group-new-error').textContent = '';
    const box = $('group-new-members');
    box.innerHTML = '';
    const people = state.contacts.filter((c) => !c.isAdmin && !c.isSystem && !c.isGroup);
    if (!people.length) box.appendChild(emptyDiv('Ajoute d\'abord des contacts pour créer un groupe.'));
    people.forEach((c) => {
      const row = document.createElement('label');
      row.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = c.id;
      row.appendChild(cb);
      row.appendChild(makeAvatar(c));
      const nm = document.createElement('span');
      nm.textContent = c.name;
      row.appendChild(nm);
      box.appendChild(row);
    });
    openModal('modal-group-new');
  }

  $('group-new-create').addEventListener('click', async () => {
    const members = [...$('group-new-members').querySelectorAll('input:checked')].map((x) => x.value);
    $('group-new-error').textContent = '';
    if (!members.length) { $('group-new-error').textContent = 'Choisis au moins un membre.'; return; }
    if (members.length > 7) { $('group-new-error').textContent = '7 membres maximum (8 avec toi).'; return; }
    try {
      const g = await api('/api/groups', 'POST', { name: $('group-new-name').value, members });
      closeModal('modal-group-new');
      await loadContacts();
      toast('Groupe créé !');
      openChat(g.id);
    } catch (err) { $('group-new-error').textContent = err.message; }
  });

  function openGroupProfile(c) {
    state.groupView = c.id;
    const av = $('group-avatar');
    av.innerHTML = '';
    av.appendChild(makeAvatar(c, true));
    $('group-name').textContent = c.name;
    $('group-count').textContent = c.members.length + ' membres';
    const box = $('group-members');
    box.innerHTML = '';
    c.members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'contact';
      row.appendChild(makeAvatar({ name: m.name, pseudo: m.name, avatar: m.avatar }));
      const nm = document.createElement('div');
      nm.className = 'meta';
      nm.textContent = (m.id === state.me.id ? 'Toi' : m.name) + (m.id === c.ownerId ? ' · créateur' : '');
      row.appendChild(nm);
      box.appendChild(row);
    });
    $('group-delete').classList.toggle('hidden', c.ownerId !== state.me.id);
    $('group-error').textContent = '';
    renderGroupOwnerTools(c);
    openModal('modal-group');
  }

  /* Outils du créateur : nom, photo, membres */
  state.groupAvatar = '';

  function renderGroupEditPreview() {
    const c = state.contacts.find((x) => x.id === state.groupView);
    const holder = $('group-edit-preview');
    holder.innerHTML = '';
    holder.appendChild(makeAvatar({ isGroup: true, name: $('group-edit-name').value || (c ? c.name : '?'), avatar: state.groupAvatar }, true));
  }

  function renderGroupOwnerTools(c) {
    const owner = c.ownerId === state.me.id;
    $('group-edit').classList.toggle('hidden', !owner);
    $('group-add-box').classList.toggle('hidden', !owner);
    if (!owner) return;
    state.groupAvatar = c.avatar || '';
    $('group-edit-name').value = c.name;
    renderGroupEditPreview();

    // retirer des membres
    const rows = $('group-members').children;
    [...rows].forEach((row, i) => {
      const m = c.members[i];
      if (!m || m.id === state.me.id) return;
      const b = document.createElement('button');
      b.className = 'btn small danger';
      b.type = 'button';
      b.title = 'Retirer du groupe';
      b.textContent = '✕';
      b.addEventListener('click', async () => {
        if (!confirm('Retirer « ' + m.name + ' » du groupe ?')) return;
        try {
          await api('/api/groups/' + c.id + '/members/' + m.id, 'DELETE');
          await loadContacts();
          const fresh = state.contacts.find((x) => x.id === c.id);
          if (fresh) openGroupProfile(fresh); else closeModal('modal-group');
          toast('Membre retiré.');
        } catch (err) { $('group-error').textContent = err.message; }
      });
      row.appendChild(b);
    });

    // ajouter des membres
    const box = $('group-add-list');
    box.innerHTML = '';
    const inGroup = new Set(c.members.map((m) => m.id));
    const people = state.contacts.filter((x) => !x.isAdmin && !x.isSystem && !x.isGroup && !inGroup.has(x.id));
    if (!people.length) box.appendChild(emptyDiv('Tous tes contacts sont déjà dans le groupe.'));
    people.forEach((p) => {
      const row = document.createElement('label');
      row.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = p.id;
      row.appendChild(cb);
      row.appendChild(makeAvatar(p));
      const nm = document.createElement('span');
      nm.textContent = p.name;
      row.appendChild(nm);
      box.appendChild(row);
    });
    $('group-add-btn').classList.toggle('hidden', !people.length);
  }

  $('group-edit-name').addEventListener('input', renderGroupEditPreview);
  $('group-edit-clear').addEventListener('click', () => { state.groupAvatar = ''; renderGroupEditPreview(); });
  $('group-edit-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const img = await readImage(file);
      const { url } = await api('/api/upload', 'POST', { data: renderToDataUrl(img, { max: 256, square: true, quality: 0.85 }) });
      state.groupAvatar = url;
      renderGroupEditPreview();
    } catch (err) { $('group-error').textContent = err.message; }
  });

  $('group-edit-save').addEventListener('click', async () => {
    $('group-error').textContent = '';
    const id = state.groupView;
    try {
      await api('/api/groups/' + id, 'PUT', { name: $('group-edit-name').value, avatar: state.groupAvatar });
      await loadContacts();
      const fresh = state.contacts.find((x) => x.id === id);
      if (fresh) openGroupProfile(fresh);
      toast('Groupe modifié !');
    } catch (err) { $('group-error').textContent = err.message; }
  });

  $('group-add-btn').addEventListener('click', async () => {
    $('group-error').textContent = '';
    const id = state.groupView;
    const members = [...$('group-add-list').querySelectorAll('input:checked')].map((x) => x.value);
    if (!members.length) { $('group-error').textContent = 'Coche au moins un contact.'; return; }
    try {
      await api('/api/groups/' + id + '/members', 'POST', { members });
      await loadContacts();
      const fresh = state.contacts.find((x) => x.id === id);
      if (fresh) openGroupProfile(fresh);
      toast('Membres ajoutés !');
    } catch (err) { $('group-error').textContent = err.message; }
  });

  async function leaveOrDeleteGroup(del) {
    const id = state.groupView;
    if (!id || !confirm(del ? 'Supprimer définitivement ce groupe et ses messages ?' : 'Quitter ce groupe ?')) return;
    try {
      await (del ? api('/api/groups/' + id, 'DELETE') : api('/api/groups/' + id + '/leave', 'POST'));
      closeModal('modal-group');
      delete state.cache[id];
      await loadContacts();
      toast(del ? 'Groupe supprimé.' : 'Tu as quitté le groupe.');
    } catch (err) { toast(err.message); }
  }
  $('group-leave').addEventListener('click', () => leaveOrDeleteGroup(false));
  $('group-delete').addEventListener('click', () => leaveOrDeleteGroup(true));

  /* ---------------- Stories ---------------- */

  async function loadStories() {
    state.stories = await api('/api/stories');
    renderStories();
    updateStoriesDot();
    refreshViewer();
  }

  function groupStories() {
    const g = {};
    state.stories.forEach((s) => { (g[s.userId] = g[s.userId] || []).push(s); });
    return g;
  }

  function updateStoriesDot() {
    const n = state.stories.filter((s) => !s.seen).length;
    const d = $('stories-dot');
    d.textContent = n > 9 ? '9+' : String(n);
    d.classList.toggle('hidden', !n);
  }

  function storyUser(userId, fallbackName) {
    if (state.me && userId === state.me.id) return { pseudo: state.me.pseudo, name: state.me.name || state.me.pseudo, avatar: state.me.avatar };
    const c = state.contacts.find((x) => x.id === userId);
    return c || { pseudo: fallbackName, name: fallbackName, avatar: '' };
  }

  function storyRow(user, title, sub, seen, onClick, extra) {
    const item = document.createElement('div');
    item.className = 'contact';
    const ring = document.createElement('div');
    ring.className = 'ring' + (seen ? ' seen' : '');
    ring.appendChild(makeAvatar(user));
    item.appendChild(ring);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('div');
    n.className = 'name';
    n.textContent = title;
    const p = document.createElement('div');
    p.className = 'preview';
    p.textContent = sub;
    meta.appendChild(n);
    meta.appendChild(p);
    item.appendChild(meta);
    if (extra) item.appendChild(extra);
    item.addEventListener('click', onClick);
    return item;
  }

  function renderStories() {
    const box = $('stories-list');
    box.innerHTML = '';
    const g = groupStories();
    const mine = g[state.me.id] || [];

    const add = document.createElement('button');
    add.className = 'btn small primary';
    add.textContent = '＋ Ajouter';
    add.addEventListener('click', (e) => { e.stopPropagation(); openNewStory(); });
    box.appendChild(
      storyRow(
        storyUser(state.me.id), 'Ma story',
        mine.length ? mine.length + ' story' + (mine.length > 1 ? 's' : '') + ' · ' + fmtTime(mine[mine.length - 1].ts) : 'Partage une photo avec tes amis',
        true,
        () => (mine.length ? openViewer(state.me.id, 0) : openNewStory()),
        add
      )
    );

    const lab = document.createElement('div');
    lab.className = 'section-label';
    lab.textContent = 'Stories de tes amis';
    box.appendChild(lab);

    const others = Object.keys(g).filter((id) => id !== state.me.id).map((id) => g[id])
      .sort((a, b) => b[b.length - 1].ts - a[a.length - 1].ts);
    if (!others.length) box.appendChild(emptyDiv('Aucune story pour le moment.'));
    others.forEach((list) => {
      const first = list.findIndex((s) => !s.seen);
      const last = list[list.length - 1];
      const u = storyUser(last.userId, last.authorName);
      box.appendChild(
        storyRow(u, u.name, list.length + ' story' + (list.length > 1 ? 's' : '') + ' · ' + fmtTime(last.ts), first === -1,
          () => openViewer(last.userId, first === -1 ? 0 : first))
      );
    });
  }

  function openNewStory() {
    state.storyImg = '';
    $('story-preview').classList.add('hidden');
    $('story-text').value = '';
    $('story-error').textContent = '';
    openModal('modal-story-new');
  }

  async function pickStoryFile(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const img = await readImage(f);
      state.storyImg = renderToDataUrl(img, { max: 1280, quality: 0.82 });
      $('story-preview').src = state.storyImg;
      $('story-preview').classList.remove('hidden');
      $('story-error').textContent = '';
    } catch (err) { $('story-error').textContent = err.message; }
  }
  $('story-cam').addEventListener('change', pickStoryFile);
  $('story-file').addEventListener('change', pickStoryFile);

  $('story-publish').addEventListener('click', async () => {
    if (!state.storyImg) { $('story-error').textContent = 'Prends ou choisis d\'abord une photo.'; return; }
    const btn = $('story-publish');
    btn.disabled = true;
    try {
      const { url } = await api('/api/upload', 'POST', { data: state.storyImg });
      await api('/api/stories', 'POST', { image: url, text: $('story-text').value });
      closeModal('modal-story-new');
      toast('Story publiée !');
      await loadStories();
    } catch (err) { $('story-error').textContent = err.message; }
    finally { btn.disabled = false; }
  });

  function curStory() {
    const v = state.viewer;
    if (!v) return null;
    return (groupStories()[v.userId] || [])[v.index] || null;
  }

  function openViewer(userId, index) {
    if (!(groupStories()[userId] || []).length) return;
    state.viewer = { userId, index, storyId: null };
    $('story-viewers').classList.add('hidden');
    showStory();
    openModal('modal-story');
  }

  function showStory() {
    const s = curStory();
    if (!s) return closeModal('modal-story');
    const list = groupStories()[s.userId];
    state.viewer.storyId = s.id;
    $('story-img').src = s.image;
    $('story-caption').textContent = s.text;
    $('story-caption').classList.toggle('hidden', !s.text);
    $('story-author').textContent = (s.mine ? 'Ma story' : storyUser(s.userId, s.authorName).name) + ' (' + (state.viewer.index + 1) + '/' + list.length + ')';
    $('story-time').textContent = fmtDay(s.ts) + ' ' + fmtTime(s.ts);
    $('story-delete').classList.toggle('hidden', !s.mine);
    $('story-viewers-btn').classList.toggle('hidden', !s.mine);
    $('story-views').textContent = s.viewsCount;
    $('story-like').textContent = (s.liked ? '❤️ ' : '🤍 ') + s.likes;
    $('story-like').disabled = !!s.mine;
    $('story-prev').disabled = state.viewer.index === 0;

    const vb = $('story-viewers');
    vb.innerHTML = '';
    if (s.mine) {
      if (!s.viewers.length) vb.textContent = 'Personne n\'a encore vu cette story.';
      s.viewers.forEach((v) => {
        const line = document.createElement('div');
        line.textContent = '👁 ' + v.name + ' · ' + fmtTime(v.ts) + (v.liked ? ' · ❤️' : '');
        vb.appendChild(line);
      });
    }
    if (!s.mine && !s.seen) {
      s.seen = true;
      api('/api/stories/' + s.id + '/view', 'POST').catch(() => {});
      updateStoriesDot();
      renderStories();
    }
  }

  function refreshViewer() {
    if ($('modal-story').classList.contains('hidden') || !state.viewer) return;
    const list = groupStories()[state.viewer.userId] || [];
    const i = list.findIndex((s) => s.id === state.viewer.storyId);
    if (i === -1) return closeModal('modal-story');
    state.viewer.index = i;
    showStory();
  }

  $('story-prev').addEventListener('click', () => { if (state.viewer.index > 0) { state.viewer.index--; showStory(); } });
  $('story-next').addEventListener('click', () => {
    const list = groupStories()[state.viewer.userId] || [];
    if (state.viewer.index < list.length - 1) { state.viewer.index++; showStory(); } else closeModal('modal-story');
  });
  $('story-viewers-btn').addEventListener('click', () => $('story-viewers').classList.toggle('hidden'));
  $('story-like').addEventListener('click', async () => {
    const s = curStory();
    if (!s || s.mine) return;
    try {
      const r = await api('/api/stories/' + s.id + '/like', 'POST');
      s.liked = r.liked;
      s.likes = r.likes;
      showStory();
    } catch (err) { toast(err.message); }
  });
  $('story-delete').addEventListener('click', async () => {
    const s = curStory();
    if (!s || !confirm('Supprimer cette story ?')) return;
    try {
      await api('/api/stories/' + s.id, 'DELETE');
      toast('Story supprimée.');
      await loadStories();
    } catch (err) { toast(err.message); }
  });

  /* ---------------- Appels (voix + vidéo, à deux ou en groupe) ---------------- */

  const fmtDur = (s) => Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';

  async function loadCalls() {
    let list;
    try { list = await api('/api/calls'); } catch (e) { return; }
    const box = $('calls-list');
    box.innerHTML = '';
    if (!list.length) { box.appendChild(emptyDiv('Aucun appel pour le moment.')); return; }
    list.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'contact';
      item.appendChild(makeAvatar({ pseudo: r.name, name: r.name, avatar: r.avatar, isGroup: r.group }));
      const meta = document.createElement('div');
      meta.className = 'meta';
      const n = document.createElement('div');
      n.className = 'name';
      n.textContent = r.name;
      const bad = !r.outgoing && r.status !== 'ended';
      if (bad) n.style.color = 'var(--danger)';
      const p = document.createElement('div');
      p.className = 'preview';
      let label;
      if (r.outgoing) label = r.status === 'ended' ? '↗ Sortant' : r.status === 'declined' ? '↗ Refusé' : '↗ Sans réponse';
      else label = r.status === 'ended' ? '↙ Reçu' : r.status === 'declined' ? '↙ Refusé' : '↙ Manqué';
      p.textContent = (r.video ? '🎥 ' : '') + label + ' · ' + fmtDay(r.ts) + ' ' + fmtTime(r.ts) + (r.duration ? ' · ' + fmtDur(r.duration) : '');
      meta.appendChild(n);
      meta.appendChild(p);
      item.appendChild(meta);
      if (r.callable) {
        const b = document.createElement('button');
        b.className = 'icon-btn';
        b.textContent = r.video ? '🎥' : '📞';
        b.title = 'Rappeler';
        b.addEventListener('click', () => startCall(r.other, r.video));
        item.appendChild(b);
      }
      box.appendChild(item);
    });
  }

  function setCallStatus(t) { $('call-status').textContent = t; }

  async function iceServers() {
    try { return await api('/api/ice'); } catch (e) { return [{ urls: 'stun:stun.l.google.com:19302' }]; }
  }

  function callTile(id, name, who, local) {
    const t = document.createElement('div');
    t.className = 'tile novid' + (local ? ' local' : '');
    t.dataset.id = id;
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    if (local) v.muted = true;
    const av = document.createElement('div');
    av.className = 'tile-av';
    av.appendChild(makeAvatar(who, true));
    const lab = document.createElement('div');
    lab.className = 'tile-name';
    lab.textContent = local ? 'Toi' : name;
    t.appendChild(v);
    t.appendChild(av);
    t.appendChild(lab);
    $('call-grid').appendChild(t);
    return t;
  }

  function setCallButtons(mode) {
    const call = state.call;
    const ringing = mode === 'ringing';
    $('call-accept').classList.toggle('hidden', !ringing);
    $('call-accept-video').classList.toggle('hidden', !(ringing && call && call.video));
    const hasVideo = !!(call && call.local && call.local.getVideoTracks().length);
    $('call-mic').classList.toggle('hidden', ringing);
    $('call-cam').classList.toggle('hidden', ringing || !hasVideo);
    $('call-mic').textContent = call && call.mic === false ? '🔇' : '🎙️';
    $('call-cam').textContent = call && call.cam === false ? '🚫' : '📷';
  }

  function openCallUi(title, status) {
    $('call-grid').innerHTML = '';
    $('call-name').textContent = title;
    setCallStatus(status);
    $('call-overlay').classList.remove('hidden');
  }

  function setLocal(call, stream) {
    call.local = stream;
    call.mic = true;
    call.cam = true;
    call.localTile = callTile('me', 'Toi', state.me, true);
    call.localTile.querySelector('video').srcObject = stream;
    call.localTile.classList.toggle('novid', !stream.getVideoTracks().length);
  }

  function refreshTile(peer) {
    const has = !!peer.stream && peer.stream.getVideoTracks().length > 0 && peer.cam !== false;
    peer.tile.classList.toggle('novid', !has);
    peer.tile.classList.toggle('mic-off', peer.mic === false);
  }

  function makePeer(call, info) {
    if (call.peers[info.id]) return call.peers[info.id];
    const pc = new RTCPeerConnection({ iceServers: call.ice });
    const who = { name: info.name, pseudo: info.name, avatar: info.avatar || '' };
    const peer = { id: info.id, pc, pending: [], stream: null, cam: info.cam, mic: info.mic, tile: callTile(info.id, info.name, who, false) };
    call.peers[info.id] = peer;
    if (call.local) call.local.getTracks().forEach((t) => pc.addTrack(t, call.local));
    if (call.video && !(call.local && call.local.getVideoTracks().length)) pc.addTransceiver('video', { direction: 'recvonly' });
    pc.onicecandidate = (e) => {
      if (e.candidate) state.socket.emit('call:signal', { callId: call.id, to: info.id, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) peer.stream = e.streams[0];
      else { peer.stream = peer.stream || new MediaStream(); peer.stream.addTrack(e.track); }
      const v = peer.tile.querySelector('video');
      if (v.srcObject !== peer.stream) v.srcObject = peer.stream;
      v.play().catch(() => {});
      peer.stream.onaddtrack = () => refreshTile(peer);
      refreshTile(peer);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') callConnected();
      if (pc.connectionState === 'failed') {
        toast('Connexion perdue avec ' + info.name + '.');
        removePeer(call, info.id);
        if (!Object.keys(call.peers).length) hangup();
      }
    };
    refreshTile(peer);
    return peer;
  }

  function removePeer(call, id) {
    const p = call.peers[id];
    if (!p) return;
    try { p.pc.close(); } catch (e) { /* ignore */ }
    p.tile.remove();
    delete call.peers[id];
  }

  async function offerTo(call, info) {
    const peer = makePeer(call, info);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    state.socket.emit('call:signal', { callId: call.id, to: info.id, data: { sdp: peer.pc.localDescription } });
  }

  function cleanupCall() {
    const c = state.call;
    if (c) {
      clearInterval(c.timer);
      Object.keys(c.peers).forEach((id) => { try { c.peers[id].pc.close(); } catch (e) { /* ignore */ } });
      if (c.local) c.local.getTracks().forEach((t) => t.stop());
    }
    state.call = null;
    $('call-grid').innerHTML = '';
    $('call-overlay').classList.add('hidden');
    if (state.tab === 'calls') loadCalls();
  }

  function hangup() {
    const c = state.call;
    if (!c) return;
    state.socket.emit('call:end', { callId: c.id });
    cleanupCall();
  }

  function callConnected() {
    const c = state.call;
    if (!c || c.startedAt) return;
    c.startedAt = Date.now();
    const tick = () => {
      const n = Object.keys(c.peers).length + 1;
      setCallStatus('En communication · ' + fmtDur(Math.round((Date.now() - c.startedAt) / 1000)) + (n > 2 ? ' · ' + n + ' participants' : ''));
    };
    tick();
    c.timer = setInterval(tick, 1000);
  }

  async function getMedia(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Micro / caméra indisponibles (il faut une connexion HTTPS).');
      return null;
    }
    if (video) {
      try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } }); }
      catch (e) { toast('Caméra refusée ou absente : appel sans vidéo.'); }
    }
    try { return await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast('Autorise le micro pour pouvoir appeler.'); return null; }
  }

  async function startCall(id, video) {
    if (state.call) return toast('Un appel est déjà en cours.');
    const c = state.contacts.find((x) => x.id === id);
    if (!c || c.isAdmin || c.isSystem) return;
    const stream = await getMedia(!!video);
    if (!stream) return;
    const ice = await iceServers();
    state.socket.emit('call:invite', { to: id, video: !!video }, (res) => {
      if (!res || res.error || state.call) {
        stream.getTracks().forEach((t) => t.stop());
        return toast((res && res.error) || 'Appel impossible.');
      }
      const call = { id: res.callId, group: !!c.isGroup, video: !!video, dir: 'out', local: null, peers: {}, joined: true, known: {}, ice };
      state.call = call;
      openCallUi(c.name, c.isGroup ? 'Appel du groupe en cours…' : 'Appel en cours…');
      setLocal(call, stream);
      setCallButtons('active');
    });
  }

  async function acceptCall(withVideo) {
    const call = state.call;
    if (!call || call.joined) return;
    const stream = await getMedia(!!withVideo && call.video);
    if (!stream) return hangup();
    call.ice = await iceServers();
    $('call-grid').innerHTML = '';
    setLocal(call, stream);
    setCallStatus('Connexion…');
    setCallButtons('active');
    state.socket.emit('call:accept', { callId: call.id });
  }

  function sendMedia() {
    const c = state.call;
    if (c) state.socket.emit('call:media', { callId: c.id, cam: c.cam !== false, mic: c.mic !== false });
  }

  $('btn-call').addEventListener('click', () => startCall(state.current, false));
  $('btn-video').addEventListener('click', () => startCall(state.current, true));
  $('call-hangup').addEventListener('click', hangup);
  $('call-accept').addEventListener('click', () => acceptCall(false));
  $('call-accept-video').addEventListener('click', () => acceptCall(true));
  $('call-mic').addEventListener('click', () => {
    const c = state.call;
    if (!c || !c.local) return;
    c.mic = c.mic === false;
    c.local.getAudioTracks().forEach((t) => { t.enabled = c.mic; });
    c.localTile.classList.toggle('mic-off', !c.mic);
    setCallButtons('active');
    sendMedia();
  });
  $('call-cam').addEventListener('click', () => {
    const c = state.call;
    if (!c || !c.local) return;
    c.cam = c.cam === false;
    c.local.getVideoTracks().forEach((t) => { t.enabled = c.cam; });
    c.localTile.classList.toggle('novid', !c.cam);
    setCallButtons('active');
    sendMedia();
  });

  /* ---------------- Signalements (administrateur) ---------------- */

  function setBadges(rep, req) {
    [['reports-badge', rep + req], ['hub-reports-badge', rep], ['hub-requests-badge', req]].forEach(([id, n]) => {
      const b = $(id);
      b.textContent = n;
      b.classList.toggle('hidden', !n);
    });
  }

  async function refreshReportsBadge() {
    try {
      const d = await api('/api/admin/reports');
      let req = 0;
      if (state.me && state.me.isAdmin) {
        try { req = (await api('/api/admin/ban-requests')).open; } catch (e) { /* ignore */ }
      }
      setBadges(d.open, req);
      return d;
    } catch (e) { return null; }
  }


  async function loadReports() {
    const d = await refreshReportsBadge();
    if (!d) return;
    const box = $('reports-list');
    box.innerHTML = '';
    const open = d.reports.filter((r) => r.status === 'open');
    const done = d.reports.filter((r) => r.status !== 'open');
    if (!open.length) box.appendChild(emptyDiv('Aucun signalement en attente.'));

    open.forEach((r) => {
      const card = document.createElement('div');
      card.className = 'report-card';
      const h = document.createElement('strong');
      h.textContent = r.targetName + ' a été signalé(e) par ' + r.reporterName;
      const p = document.createElement('p');
      p.textContent = '« ' + r.reason + ' »';
      const m = document.createElement('small');
      m.textContent = fmtDay(r.ts) + ' ' + fmtTime(r.ts) + ' · ' + r.total + ' signalement(s) au total · ' + r.warnings + ' avertissement(s) déjà envoyé(s)';
      const row = document.createElement('div');
      row.className = 'row';

      const mk = (label, cls, fn) => {
        const b = document.createElement('button');
        b.className = 'btn small ' + cls;
        b.textContent = label;
        b.addEventListener('click', fn);
        row.appendChild(b);
        return b;
      };
      const act = async (fn, okMsg) => {
        try { await fn(); toast(okMsg); await loadReports(); } catch (err) { toast(err.message); }
      };

      const warn = mk('⚠️ Avertir', 'primary', () => {
        const def = 'Attention ' + r.targetPseudo + ', vous avez été jugé(e) par un signalement. Faites attention : la prochaine fois, c\'est le bannissement définitif de votre compte. Si vous ne comprenez pas pourquoi, discutez avec l\'Administrateur.';
        const text = prompt('Avertissement envoyé à ' + r.targetPseudo + ' (tu peux le modifier) :', def);
        if (text === null) return;
        act(() => api('/api/admin/reports/' + r.id + '/warn', 'POST', { text }), 'Avertissement envoyé.');
      });
      mk('🙈 Ne rien faire', '', () => act(() => api('/api/admin/reports/' + r.id + '/dismiss', 'POST'), 'Signalement classé.'));
      const banB = mk(state.me.isAdmin ? '⛔ Bannir' : '📨 Demander un ban', 'danger', () => openBan(r.targetId, r.targetPseudo, () => loadReports(), r.id));
      const del = mk('🗑 Supprimer le compte', 'danger', () => {
        if (!confirm('Supprimer définitivement le compte « ' + r.targetPseudo + ' » et ses messages ?')) return;
        act(() => api('/api/admin/users/' + r.targetId, 'DELETE'), 'Compte supprimé.');
      });
      if (!r.targetExists) { warn.disabled = true; del.disabled = true; banB.disabled = true; }
      if (!state.me.isAdmin) del.remove();

      [h, p, m, row].forEach((x) => card.appendChild(x));
      box.appendChild(card);
    });

    if (done.length) {
      const lab = document.createElement('div');
      lab.className = 'section-label';
      lab.textContent = 'Déjà traités';
      box.appendChild(lab);
      done.slice(0, 30).forEach((r) => {
        const line = document.createElement('div');
        line.className = 'report-done';
        line.textContent = ({ warned: '⚠️ Avertissement envoyé', banned: '⛔ Ban appliqué', forwarded: '📨 Transmis à l\'administration' }[r.status] || '✔ Classé sans suite') + ' · ' + r.targetName + ' (par ' + r.reporterName + ') · ' + fmtDate(r.ts);
        box.appendChild(line);
      });
    }
  }

  /* ---------------- Chaînes ---------------- */

  state.channels = [];
  state.chan = null;
  state.chanEdit = null;
  state.chanAvatar = '';

  const chanUser = (c) => ({ pseudo: c.name, name: c.name, avatar: c.avatar });
  const subsText = (n) => n + ' abonné' + (n > 1 ? 's' : '');

  async function loadChannels() {
    state.channels = await api('/api/channels');
    renderChannels();
    if (!$('modal-chan-reco').classList.contains('hidden')) renderReco();
  }

  function chanRow(c, extra, rank) {
    const item = document.createElement('div');
    item.className = 'contact';
    if (rank) {
      const r = document.createElement('span');
      r.className = 'rank';
      r.textContent = rank;
      item.appendChild(r);
    }
    item.appendChild(makeAvatar(chanUser(c)));
    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('div');
    n.className = 'name';
    n.textContent = c.name + (c.mine ? ' (ma chaîne)' : '');
    const p = document.createElement('div');
    p.className = 'preview';
    p.textContent = subsText(c.subscribers) + (c.description ? ' · ' + c.description : '');
    meta.appendChild(n);
    meta.appendChild(p);
    item.appendChild(meta);
    if (extra) item.appendChild(extra);
    item.addEventListener('click', () => openChannel(c.id));
    return item;
  }

  function renderChannels() {
    const box = $('channels-list');
    box.innerHTML = '';
    const list = state.channels.filter((c) => c.subscribed || c.mine).sort((a, b) => b.lastTs - a.lastTs);
    if (!list.length) {
      box.appendChild(emptyDiv('Tu ne suis aucune chaîne. Clique sur « Recommandations » pour en découvrir, ou crée la tienne.'));
      return;
    }
    list.forEach((c) => box.appendChild(chanRow(c)));
  }

  async function toggleFollow(id) {
    try {
      await api('/api/channels/' + id + '/follow', 'POST');
      await loadChannels();
      if (state.chan === id && !$('modal-channel').classList.contains('hidden')) loadChanPosts(id);
    } catch (err) { toast(err.message); }
  }

  function renderReco() {
    const box = $('reco-list');
    box.innerHTML = '';
    if (!state.channels.length) { box.appendChild(emptyDiv('Aucune chaîne pour le moment. Crée la première !')); return; }
    const top = document.createElement('div');
    top.className = 'section-label';
    top.textContent = '▲ Les plus suivies';
    box.appendChild(top);
    state.channels.forEach((c, i) => {
      let extra = null;
      if (!c.mine) {
        extra = document.createElement('button');
        extra.className = 'btn small' + (c.subscribed ? '' : ' primary');
        extra.style.width = 'auto';
        extra.style.margin = '0';
        extra.textContent = c.subscribed ? '✓ Suivie' : 'Suivre';
        extra.addEventListener('click', (e) => { e.stopPropagation(); toggleFollow(c.id); });
      }
      box.appendChild(chanRow(c, extra, i + 1));
    });
    const bottom = document.createElement('div');
    bottom.className = 'section-label';
    bottom.textContent = '▼ Les moins suivies';
    box.appendChild(bottom);
  }

  $('btn-chan-reco').addEventListener('click', async () => {
    try { await loadChannels(); } catch (e) { return toast(e.message); }
    renderReco();
    openModal('modal-chan-reco');
  });

  function renderPosts(box, posts, mine) {
    box.innerHTML = '';
    if (!posts.length) { box.appendChild(emptyDiv('Aucune publication pour le moment.')); return; }
    posts.forEach((p) => {
      const card = document.createElement('div');
      card.className = 'chan-post';
      if (p.image) {
        const img = document.createElement('img');
        img.className = 'chat-img';
        img.alt = 'Photo';
        img.loading = 'lazy';
        img.src = p.image;
        img.addEventListener('click', () => { $('photo-full').src = p.image; openModal('modal-photo'); });
        card.appendChild(img);
      }
      if (p.video) {
        const v = document.createElement('video');
        v.className = 'chan-video';
        v.src = p.video;
        v.controls = true;
        v.preload = 'metadata';
        v.playsInline = true;
        card.appendChild(v);
      }
      if (p.audio) {
        const au = document.createElement('audio');
        au.controls = true;
        au.preload = 'metadata';
        au.src = p.audio;
        card.appendChild(au);
      }
      if (p.text) {
        const t = document.createElement('p');
        t.textContent = p.text;
        card.appendChild(t);
      }
      const meta = document.createElement('small');
      const when = document.createElement('span');
      when.textContent = fmtDay(p.ts) + ' ' + fmtTime(p.ts);
      meta.appendChild(when);
      if (mine) {
        const del = document.createElement('button');
        del.className = 'icon-btn chan-del';
        del.textContent = '🗑 Supprimer';
        del.title = 'Supprimer cette publication';
        del.addEventListener('click', async () => {
          if (!confirm('Supprimer cette publication ?')) return;
          try { await api('/api/channels/' + state.chan + '/posts/' + p.id, 'DELETE'); } catch (err) { toast(err.message); }
        });
        meta.appendChild(del);
      }
      card.appendChild(meta);
      box.appendChild(card);
    });
  }

  async function openChannel(id) {
    state.chan = id;
    closeModal('modal-chan-reco');
    openModal('modal-channel');
    try { await loadChanPosts(id); } catch (err) { toast(err.message); closeModal('modal-channel'); }
  }

  async function loadChanPosts(id) {
    const d = await api('/api/channels/' + id + '/posts');
    if (state.chan !== id) return;
    const c = d.channel;
    state.chanData = c;
    const av = $('chan-avatar');
    av.innerHTML = '';
    av.appendChild(makeAvatar(chanUser(c), true));
    $('chan-name').textContent = c.name;
    $('chan-subs').textContent = subsText(c.subscribers);
    $('chan-desc').textContent = c.description;
    $('chan-desc').classList.toggle('hidden', !c.description);
    const f = $('chan-follow');
    f.classList.toggle('hidden', c.mine);
    f.textContent = c.subscribed ? '✓ Abonné(e)' : 'S\'abonner';
    $('chan-edit').classList.toggle('hidden', !c.mine);
    $('chan-delete').classList.toggle('hidden', !c.mine);
    $('chan-compose').classList.toggle('hidden', !c.mine);
    const box = $('chan-posts');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    renderPosts(box, d.posts, c.mine);
    if (stick) box.scrollTop = box.scrollHeight;
  }

  $('chan-follow').addEventListener('click', () => toggleFollow(state.chan));

  $('chan-delete').addEventListener('click', async () => {
    if (!confirm('Supprimer définitivement cette chaîne et toutes ses publications ?')) return;
    try {
      await api('/api/channels/' + state.chan, 'DELETE');
      closeModal('modal-channel');
      state.chan = null;
      toast('Chaîne supprimée.');
      loadChannels();
    } catch (err) { toast(err.message); }
  });

  async function postToChannel(body) {
    await api('/api/channels/' + state.chan + '/posts', 'POST', body);
    await loadChanPosts(state.chan);
    const box = $('chan-posts');
    box.scrollTop = box.scrollHeight;
  }

  $('chan-compose').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('chan-text').value.trim();
    if (!text) return;
    try { await postToChannel({ text }); $('chan-text').value = ''; } catch (err) { toast(err.message); }
  });

  $('chan-photo-btn').addEventListener('click', () => $('chan-photo').click());
  $('chan-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      toast('Envoi de la photo…');
      const img = await readImage(file);
      const { url } = await api('/api/upload', 'POST', { data: renderToDataUrl(img, { max: 1280, quality: 0.82 }) });
      const text = $('chan-text').value.trim();
      await postToChannel({ text, image: url });
      $('chan-text').value = '';
    } catch (err) { toast(err.message); }
  });

  $('chan-video-btn').addEventListener('click', () => $('chan-video').click());
  $('chan-video').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) return toast('Vidéo trop lourde (30 Mo maximum).');
    try {
      toast('Envoi de la vidéo… (peut prendre un moment)');
      const res = await fetch('/api/upload-video', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'video/mp4', Authorization: 'Bearer ' + state.token },
        body: file,
      });
      let data = {};
      try { data = await res.json(); } catch (x) { /* pas de JSON */ }
      if (!res.ok) throw new Error(data.error || 'Envoi de la vidéo impossible.');
      const text = $('chan-text').value.trim();
      await postToChannel({ text, video: data.url });
      $('chan-text').value = '';
    } catch (err) { toast(err.message); }
  });


  /* Vocaux dans les chaînes : 🎤 pour démarrer, ⬆️ pour publier, 🗑 pour annuler */
  const chanRec = { mr: null, stream: null, chunks: [], send: false, started: 0, timer: null };

  function chanRecUi(on) {
    ['chan-photo-btn', 'chan-video-btn', 'chan-text'].forEach((id) => $(id).classList.toggle('hidden', on));
    $('chan-compose').querySelector('button[type="submit"]').classList.toggle('hidden', on);
    $('chan-rec-timer').classList.toggle('hidden', !on);
    $('chan-mic-cancel').classList.toggle('hidden', !on);
    $('chan-mic-btn').textContent = on ? '⬆️' : '🎤';
    $('chan-mic-btn').title = on ? 'Publier le vocal' : 'Message vocal';
  }

  async function startChanRec() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      return toast('Les vocaux ne sont pas disponibles ici (connexion HTTPS requise).');
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { return toast('Autorise le micro pour publier un vocal.'); }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    let mr;
    try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); return toast('Enregistrement impossible sur cet appareil.'); }
    Object.assign(chanRec, { mr, stream, chunks: [], send: false, started: Date.now() });
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chanRec.chunks.push(e.data); };
    const chanId = state.chan;
    mr.onstop = () => finishChanRec(chanId, mr, stream, chanRec.chunks.slice(), chanRec.send);
    mr.start();
    chanRecUi(true);
    const tick = () => {
      const s = Math.round((Date.now() - chanRec.started) / 1000);
      $('chan-rec-timer').textContent = '🔴 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    };
    tick();
    chanRec.timer = setInterval(tick, 500);
  }

  function stopChanRec(send) {
    if (!chanRec.mr) return;
    chanRec.send = send;
    clearInterval(chanRec.timer);
    chanRecUi(false);
    const mr = chanRec.mr;
    chanRec.mr = null;
    try { mr.stop(); } catch (e) { chanRec.stream.getTracks().forEach((t) => t.stop()); }
  }

  async function finishChanRec(chanId, mr, stream, chunks, send) {
    stream.getTracks().forEach((t) => t.stop());
    if (!send || !chunks.length) return;
    const type = (mr.mimeType || 'audio/webm').split(';')[0];
    try {
      toast('Publication du vocal…');
      const res = await fetch('/api/upload-audio', {
        method: 'POST',
        headers: { 'Content-Type': type, Authorization: 'Bearer ' + state.token },
        body: new Blob(chunks, { type }),
      });
      let data = {};
      try { data = await res.json(); } catch (x) { /* pas de JSON */ }
      if (!res.ok) throw new Error(data.error || 'Envoi du vocal impossible.');
      if (state.chan !== chanId) return toast('Vocal non publié : tu as changé de chaîne.');
      await postToChannel({ text: '', audio: data.url });
    } catch (err) { toast(err.message); }
  }

  // Fermer la chaîne pendant un enregistrement l'annule (le micro s'éteint)
  new MutationObserver(() => {
    if ($('modal-channel').classList.contains('hidden')) stopChanRec(false);
  }).observe($('modal-channel'), { attributes: true, attributeFilter: ['class'] });

  $('chan-mic-btn').addEventListener('click', () => (chanRec.mr ? stopChanRec(true) : startChanRec()));
  $('chan-mic-cancel').addEventListener('click', () => stopChanRec(false));

  function renderChanPreview() {
    const h = $('chan-edit-preview');
    h.innerHTML = '';
    const n = $('chan-edit-name').value || '?';
    h.appendChild(makeAvatar({ pseudo: n, name: n, avatar: state.chanAvatar }, true));
  }

  function openChanEdit(c) {
    state.chanEdit = c ? c.id : null;
    state.chanAvatar = c ? c.avatar : '';
    $('chan-edit-title').textContent = c ? 'Modifier la chaîne' : 'Créer une chaîne';
    $('chan-edit-name').value = c ? c.name : '';
    $('chan-edit-desc').value = c ? c.description : '';
    $('chan-edit-error').textContent = '';
    renderChanPreview();
    openModal('modal-chan-edit');
  }

  $('btn-chan-new').addEventListener('click', () => openChanEdit(null));
  $('chan-edit').addEventListener('click', () => openChanEdit(state.chanData));
  $('chan-edit-name').addEventListener('input', renderChanPreview);
  $('chan-edit-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const img = await readImage(file);
      const { url } = await api('/api/upload', 'POST', { data: renderToDataUrl(img, { max: 256, square: true, quality: 0.85 }) });
      state.chanAvatar = url;
      renderChanPreview();
    } catch (err) { $('chan-edit-error').textContent = err.message; }
  });

  $('chan-edit-save').addEventListener('click', async () => {
    $('chan-edit-error').textContent = '';
    const body = { name: $('chan-edit-name').value, description: $('chan-edit-desc').value, avatar: state.chanAvatar };
    try {
      const c = state.chanEdit
        ? await api('/api/channels/' + state.chanEdit, 'PUT', body)
        : await api('/api/channels', 'POST', body);
      closeModal('modal-chan-edit');
      await loadChannels();
      if (state.chanEdit) loadChanPosts(c.id); else openChannel(c.id);
    } catch (err) { $('chan-edit-error').textContent = err.message; }
  });

  /* ---------------- Administration : hub, bans, sanctions ---------------- */

  document.querySelectorAll('[data-hub]').forEach((b) => {
    b.addEventListener('click', () => {
      closeModal('modal-hub');
      const k = b.dataset.hub;
      if (k === 'reports') { openModal('modal-reports'); loadReports(); }
      else if (k === 'accounts') openAccountScreen();
      else if (k === 'users') { openModal('modal-admin'); loadAdminUsers(); }
      else if (k === 'broadcast') openModal('modal-bc-menu');
      else if (k === 'requests') { openModal('modal-requests'); loadRequests(); }
      else if (k === 'banlog') { openModal('modal-banlog'); loadBanLog(); }
      else if (k === 'stories') { openModal('modal-admin-stories'); loadAdminStories(); }
      else { openModal('modal-admin-channels'); loadAdminChannels(); }
    });
  });


  $('bc-new').addEventListener('click', () => {
    closeModal('modal-bc-menu');
    $('broadcast-text').value = '';
    $('broadcast-error').textContent = '';
    openModal('modal-broadcast');
  });

  $('bc-old').addEventListener('click', () => {
    closeModal('modal-bc-menu');
    openModal('modal-bc-list');
    loadBroadcasts();
  });

  async function loadBroadcasts() {
    const box = $('bc-list');
    box.innerHTML = '';
    let list;
    try { list = await api('/api/admin/broadcasts'); } catch (err) { return toast(err.message); }
    if (!list.length) { box.appendChild(emptyDiv('Aucune notification envoyée pour le moment.')); return; }
    list.forEach((n) => {
      const it = document.createElement('div');
      it.className = 'bc-item';
      const p = document.createElement('p');
      p.textContent = n.text;
      const meta = document.createElement('small');
      meta.textContent = fmtDay(n.ts) + ' ' + fmtTime(n.ts) + ' · ' + plural(n.recipients, 'destinataire', 'destinataires') + (n.edited ? ' · modifiée' : '');
      const row = document.createElement('div');
      row.className = 'row';
      const ed = document.createElement('button');
      ed.type = 'button';
      ed.className = 'btn small';
      ed.textContent = '✏️ Modifier';
      ed.addEventListener('click', async () => {
        const v = prompt('Nouveau texte de la notification :', n.text);
        if (v === null || !v.trim() || v.trim() === n.text) return;
        try { await api('/api/admin/broadcasts/' + n.id, 'PUT', { text: v.trim() }); toast('Notification modifiée.'); loadBroadcasts(); }
        catch (err) { toast(err.message); }
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn small danger';
      del.textContent = '🗑 Supprimer';
      del.addEventListener('click', async () => {
        if (!confirm('Supprimer cette notification chez ' + plural(n.recipients, 'compte', 'comptes') + ' ?')) return;
        try { await api('/api/admin/broadcasts/' + n.id, 'DELETE'); toast('Notification supprimée.'); loadBroadcasts(); }
        catch (err) { toast(err.message); }
      });
      row.appendChild(ed);
      row.appendChild(del);
      it.appendChild(p);
      it.appendChild(meta);
      it.appendChild(row);
      box.appendChild(it);
    });
  }

  $('broadcast-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('broadcast-error').textContent = '';
    const text = $('broadcast-text').value.trim();
    if (!text) { $('broadcast-error').textContent = 'Écris le texte de la notification.'; return; }
    if (!confirm('Envoyer cette notification à tous les comptes ?')) return;
    try {
      const r = await api('/api/admin/broadcast', 'POST', { text });
      closeModal('modal-broadcast');
      toast('Notification envoyée à ' + r.sent + ' compte(s).');
    } catch (err) { $('broadcast-error').textContent = err.message; }
  });

  function markBanPreset() {
    document.querySelectorAll('.ban-presets .btn').forEach((b) => {
      const v = b.dataset.min === 'perm' ? 'perm' : Number(b.dataset.min);
      b.classList.toggle('active', state.ban && state.ban.sel === v);
    });
  }

  function openBan(userId, name, done, reportId, requestId) {
    state.ban = { userId, done, reportId, requestId, sel: 1440 };
    const supreme = !!state.me.isAdmin;
    $('ban-title').textContent = supreme ? '⛔ Bannir' : '📨 Demander le ban de';
    $('ban-confirm').textContent = supreme ? 'Bannir' : 'Envoyer à l\'administration';
    $('ban-reason-label').textContent = supreme ? 'Raison (facultative, gardée dans l\'historique des bans)' : 'Raison (visible par l\'administrateur)';
    $('ban-reason').value = '';
    $('ban-target').textContent = name;
    $('ban-num').value = '';
    $('ban-error').textContent = '';
    markBanPreset();
    openModal('modal-ban');
  }

  document.querySelectorAll('.ban-presets .btn').forEach((b) => {
    b.addEventListener('click', () => {
      state.ban.sel = b.dataset.min === 'perm' ? 'perm' : Number(b.dataset.min);
      $('ban-num').value = '';
      markBanPreset();
    });
  });
  $('ban-num').addEventListener('input', () => { state.ban.sel = null; markBanPreset(); });

  $('ban-confirm').addEventListener('click', async () => {
    const b = state.ban;
    const body = { reportId: b.reportId, requestId: b.requestId };
    if (b.sel === 'perm') body.permanent = true;
    else body.minutes = b.sel || Number($('ban-num').value) * Number($('ban-unit').value);
    if (!body.permanent && !(body.minutes >= 1)) { $('ban-error').textContent = 'Choisis une durée.'; return; }
    try {
      if (state.me.isAdmin) {
        body.reason = $('ban-reason').value.trim();
        await api('/api/admin/users/' + b.userId + '/ban', 'POST', body);
        toast('Compte banni.');
      } else {
        body.targetId = b.userId;
        body.reason = $('ban-reason').value.trim();
        if (!body.reason) { $('ban-error').textContent = 'Explique la raison de la demande.'; return; }
        await api('/api/admin/ban-requests', 'POST', body);
        toast('Demande envoyée à l\'administration.');
      }
      closeModal('modal-ban');
      if (b.done) b.done();
    } catch (err) { $('ban-error').textContent = err.message; }
  });

  function openSanction(o) {
    state.sanction = o;
    $('sanction-title').textContent = o.title;
    $('sanction-sub').textContent = o.sub;
    $('sanction-warn').checked = true;
    $('sanction-text').disabled = false;
    $('sanction-text').value = o.defaultText;
    $('sanction-block-row').classList.toggle('hidden', !o.block);
    $('sanction-block').checked = true;
    $('sanction-error').textContent = '';
    openModal('modal-sanction');
  }
  $('sanction-warn').addEventListener('change', (e) => { $('sanction-text').disabled = !e.target.checked; });
  $('sanction-confirm').addEventListener('click', async () => {
    const o = state.sanction;
    const warn = $('sanction-warn').checked ? $('sanction-text').value.trim() : '';
    try {
      await o.onConfirm({ warn, block: o.block && $('sanction-block').checked });
      closeModal('modal-sanction');
    } catch (err) { $('sanction-error').textContent = err.message; }
  });

  function adminCard(parts) {
    const card = document.createElement('div');
    card.className = 'report-card';
    parts.forEach((p) => card.appendChild(p));
    return card;
  }
  const el = (tag, text, cls) => {
    const x = document.createElement(tag);
    if (text !== undefined) x.textContent = text;
    if (cls) x.className = cls;
    return x;
  };
  const btnEl = (label, cls, fn) => {
    const b = el('button', label, 'btn small ' + cls);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };

  const durText = (m) => [Math.floor(m / 1440) && Math.floor(m / 1440) + ' j', Math.floor((m % 1440) / 60) && Math.floor((m % 1440) / 60) + ' h', m % 60 && (m % 60) + ' min'].filter(Boolean).join(' ') || '0 min';

  async function loadBanLog() {
    let d;
    try { d = await api('/api/admin/ban-log'); } catch (e) { return toast(e.message); }
    const box = $('banlog-list');
    box.innerHTML = '';
    if (!d.log.length) { box.appendChild(emptyDiv('Aucun bannissement enregistré pour le moment.')); return; }
    const when = (ts) => fmtDate(ts) + ' à ' + fmtTime(ts);
    d.log.forEach((e) => {
      const dur = e.permanent ? 'définitivement' : 'pendant ' + durText(e.minutes);
      const who = e.requestedBy ? e.byName + ' (demandé par ' + e.requestedBy + ')' : e.byName;
      let st;
      if (e.status === 'active') st = e.permanent ? '⛔ En cours · définitif' : '⛔ En cours · se termine le ' + when(e.until);
      else if (e.status === 'ended') st = '✅ ' + e.endedBy + ' le ' + when(e.endedAt);
      else st = '✅ Terminé le ' + when(e.until);
      box.appendChild(adminCard([
        el('strong', e.targetPseudo + (e.targetExists ? '' : ' (compte supprimé)')),
        el('div', 'Banni le ' + when(e.ts) + ' ' + dur, 'hint'),
        el('div', 'Par : ' + who, 'hint'),
        el('div', 'Raison : ' + (e.reason || 'non précisée'), 'hint'),
        el('div', st, 'hint'),
      ]));
    });
  }

  async function loadRequests() {
    let d;
    try { d = await api('/api/admin/ban-requests'); } catch (e) { return toast(e.message); }
    const box = $('requests-list');
    box.innerHTML = '';
    const open = d.requests.filter((r) => r.status === 'open');
    const done = d.requests.filter((r) => r.status !== 'open');
    if (!open.length) box.appendChild(emptyDiv('Aucune demande en attente.'));
    open.forEach((r) => {
      const dur = r.permanent ? 'définitivement' : 'pendant ' + durText(r.minutes);
      const row = el('div', undefined, 'row');
      const ok = btnEl('✅ Accepter', 'primary', async () => {
        try {
          await api('/api/admin/users/' + r.targetId + '/ban', 'POST', { requestId: r.id, permanent: r.permanent, minutes: r.minutes });
          toast('Compte banni.');
          loadRequests();
        } catch (err) { toast(err.message); }
      });
      const other = btnEl('⏱ Autre durée', '', () => openBan(r.targetId, r.targetPseudo, () => loadRequests(), r.reportId, r.id));
      const no = btnEl('❌ Refuser', 'danger', async () => {
        try { await api('/api/admin/ban-requests/' + r.id + '/refuse', 'POST'); toast('Demande refusée.'); loadRequests(); }
        catch (err) { toast(err.message); }
      });
      if (!r.targetExists) { ok.disabled = true; other.disabled = true; }
      [ok, other, no].forEach((b) => row.appendChild(b));
      box.appendChild(adminCard([
        el('strong', r.requesterName + ' demande de bannir ' + r.targetName + ' ' + dur),
        el('p', '« ' + r.reason + ' »'),
        el('small', fmtDay(r.ts) + ' ' + fmtTime(r.ts)),
        row,
      ]));
    });
    if (done.length) {
      box.appendChild(el('div', 'Déjà traitées', 'section-label'));
      done.slice(0, 30).forEach((r) => {
        box.appendChild(el('div', (r.status === 'approved' ? '✅ Acceptée' : '❌ Refusée') + ' · ' + r.targetName + ' (par ' + r.requesterName + ') · ' + fmtDate(r.ts), 'report-done'));
      });
    }
    refreshReportsBadge();
  }

  async function loadAdminStories() {
    let list;
    try { list = await api('/api/admin/stories'); } catch (e) { return toast(e.message); }
    const box = $('admin-stories-list');
    box.innerHTML = '';
    if (!list.length) { box.appendChild(emptyDiv('Aucune story en ce moment.')); return; }
    list.forEach((s) => {
      const img = el('img', undefined, 'admin-thumb');
      img.src = s.image;
      img.alt = 'Story';
      img.addEventListener('click', () => { $('photo-full').src = s.image; openModal('modal-photo'); });
      const row = el('div', undefined, 'row');
      row.appendChild(btnEl('🗑 Supprimer…', 'danger', () => openSanction({
        title: 'Supprimer la story',
        sub: 'Auteur : ' + s.authorName,
        block: false,
        defaultText: 'Attention ' + s.authorPseudo + ', une de vos stories a été supprimée car elle ne respectait pas les règles. Faites attention : la prochaine fois, c\'est le bannissement définitif de votre compte. Si vous ne comprenez pas pourquoi, discutez avec l\'Administrateur.',
        onConfirm: async ({ warn }) => {
          await api('/api/admin/stories/' + s.id + '/delete', 'POST', { warn });
          toast('Story supprimée.');
          loadAdminStories();
        },
      })));
      const parts = [el('strong', s.authorName), img];
      if (s.text) parts.push(el('p', s.text));
      parts.push(el('small', fmtDay(s.ts) + ' ' + fmtTime(s.ts) + ' · ❤️ ' + s.likes + ' · 👁 ' + s.views), row);
      box.appendChild(adminCard(parts));
    });
  }

  async function loadAdminChannels() {
    let list;
    try { list = await api('/api/admin/channels'); } catch (e) { return toast(e.message); }
    const box = $('admin-channels-list');
    box.innerHTML = '';
    if (!list.length) { box.appendChild(emptyDiv('Aucune chaîne pour le moment.')); return; }
    list.forEach((c) => {
      const head = el('div', undefined, 'row');
      head.appendChild(makeAvatar(chanUser(c)));
      head.appendChild(el('strong', c.name));
      const postsBox = el('div', undefined, 'chan-posts hidden');
      const row = el('div', undefined, 'row');
      row.appendChild(btnEl('👁 Voir le contenu', '', async () => {
        if (!postsBox.childElementCount) {
          try { const d = await api('/api/channels/' + c.id + '/posts'); renderPosts(postsBox, d.posts, false); }
          catch (err) { return toast(err.message); }
        }
        postsBox.classList.toggle('hidden');
      }));
      row.appendChild(btnEl('🗑 Supprimer…', 'danger', () => openSanction({
        title: 'Supprimer la chaîne « ' + c.name + ' »',
        sub: 'Créée par ' + c.ownerName,
        block: c.ownerExists,
        defaultText: 'Attention ' + c.ownerPseudo + ', votre chaîne « ' + c.name + ' » a été supprimée car elle ne respectait pas les règles. Faites attention : la prochaine fois, c\'est le bannissement définitif de votre compte. Si vous ne comprenez pas pourquoi, discutez avec l\'Administrateur.',
        onConfirm: async ({ warn, block }) => {
          await api('/api/admin/channels/' + c.id + '/delete', 'POST', { warn, block });
          toast('Chaîne supprimée.');
          loadAdminChannels();
        },
      })));
      const parts = [head];
      if (c.description) parts.push(el('p', c.description));
      parts.push(el('small', 'Créée par ' + c.ownerName + ' · ' + fmtDate(c.createdAt) + ' · ' + subsText(c.subscribers) + ' · ' + c.posts + ' publication(s)'), row, postsBox);
      box.appendChild(adminCard(parts));
    });
  }

  /* ---------------- Démarrage ---------------- */

  (async function init() {
    // Application installable (iPhone, Samsung, ordinateur)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const pending = sessionStorage.getItem('tc_msg');
    if (pending) {
      sessionStorage.removeItem('tc_msg');
      authError(pending);
    }
    if (!state.token) return;
    try {
      state.me = await api('/api/me');
      await startApp();
    } catch (e) {
      localStorage.removeItem('tc_token');
      state.token = null;
    }
  })();
})();
