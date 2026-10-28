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
        forceLogout('Session expirée, reconnecte-toi.');
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
      if (user.isAdmin) {
        el.style.background = 'linear-gradient(135deg,#f5a623,#f76b1c)';
        el.textContent = '👑';
      } else {
        el.style.background = colorFor(user.pseudo || '?');
        el.textContent = (user.pseudo || '?').trim().charAt(0).toUpperCase();
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
    m.image ? (m.text ? '📷 ' + m.text : '📷 Photo') : m.text;

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
    $('me-name').textContent = me.pseudo;
    $('me-sub').textContent = me.isAdmin ? 'Compte administrateur' : 'Connecté';
    $('btn-admin').classList.toggle('hidden', !me.isAdmin);
    $('btn-add').classList.toggle('hidden', !!me.isAdmin);
  }

  /* ---------------- Socket.io ---------------- */

  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const socket = io({ auth: { token: state.token } });
    state.socket = socket;

    socket.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') forceLogout('Session expirée, reconnecte-toi.');
    });

    socket.on('kicked', () => forceLogout('Ton compte a été supprimé par l\'administrateur.'));

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
      } catch (e) { /* ignore */ }
    });

    socket.on('message', async (msg) => {
      const other = msg.from === state.me.id ? msg.to : msg.from;
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

    if (!state.unreadInit) {
      const map = readMap();
      state.contacts.forEach((c) => {
        const l = c.last;
        state.unread[c.id] = l && l.from === c.id && l.ts > (map[c.id] || 0) ? 1 : 0;
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
      .filter((c) => c.pseudo.toLowerCase().includes(q))
      .sort((a, b) => {
        const ta = a.last ? a.last.ts : 0;
        const tb = b.last ? b.last.ts : 0;
        if (ta !== tb) return tb - ta;
        if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
        return a.pseudo.localeCompare(b.pseudo);
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
      nm.textContent = c.pseudo + (c.isAdmin ? ' (admin)' : '');
      name.appendChild(nm);
      if (c.last) {
        const t = document.createElement('time');
        t.textContent = fmtTime(c.last.ts);
        name.appendChild(t);
      }

      const prev = document.createElement('div');
      prev.className = 'preview';
      prev.textContent = c.last
        ? (c.last.from === state.me.id ? 'Vous : ' : '') + previewText(c.last)
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
    $('chat-name').textContent = c.pseudo;
    $('chat-status').textContent = c.isAdmin
      ? 'Compte administrateur'
      : state.online.has(c.id) ? 'En ligne' : 'Hors ligne';
  }

  async function openChat(id) {
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
    if (m.text) {
      const txt = document.createElement('div');
      txt.textContent = m.text;
      bubble.appendChild(txt);
    }
    const t = document.createElement('time');
    t.textContent = fmtTime(m.ts);
    bubble.appendChild(t);
    row.appendChild(bubble);
    box.appendChild(row);
  }

  function scrollBottom() {
    const box = $('messages');
    box.scrollTop = box.scrollHeight;
  }

  $('btn-back').addEventListener('click', () => {
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

  $('btn-add').addEventListener('click', () => {
    $('add-code').value = '';
    $('add-error').textContent = '';
    openModal('modal-add');
    $('add-code').focus();
  });

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
    holder.appendChild(
      makeAvatar(
        {
          pseudo: isAdmin ? 'Administrateur' : ($('settings-pseudo').value || state.me.pseudo),
          avatar: state.avatarValue,
          isAdmin,
        },
        true
      )
    );
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
    $('share-section').classList.toggle('hidden', isAdmin);

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
      $('settings-share').textContent = me.shareCode;
    }

    state.avatarValue = me.avatar || '';
    $('settings-avatar-url').value = /^https?:/i.test(state.avatarValue) ? state.avatarValue : '';
    $('settings-avatar-url').placeholder = state.avatarValue.startsWith('data:')
      ? '(photo importée)'
      : 'https://…';
    renderSettingsPreview();
    markAppearanceButtons();
    openModal('modal-settings');
  });

  $('settings-pseudo').addEventListener('input', renderSettingsPreview);

  $('settings-code').addEventListener('input', (e) => {
    if (!state.me.isAdmin) e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });
  $('settings-code-toggle').addEventListener('click', () => {
    const i = $('settings-code');
    i.type = i.type === 'password' ? 'text' : 'password';
  });

  $('settings-avatar-url').addEventListener('input', (e) => {
    state.avatarValue = e.target.value.trim();
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

    if (isAdmin) {
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
      body.pseudo = $('settings-pseudo').value;
    }

    try {
      state.me = await api('/api/me', 'PUT', body);
      renderMe();
      closeModal('modal-settings');
      toast(isAdmin && body.pin ? 'Réglages enregistrés. Nouveau code administrateur actif.' : 'Réglages enregistrés !');
    } catch (err) {
      $('settings-error').textContent = err.message;
    }
  });

  /* ---------------- Administration ---------------- */

  $('btn-admin').addEventListener('click', () => {
    openModal('modal-admin');
    loadAdminUsers();
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
      td.colSpan = 7;
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
      nm.textContent = u.pseudo;
      who.appendChild(nm);
      cell(who);

      const pin = document.createElement('code');
      pin.textContent = u.pin;
      cell(pin);

      const share = document.createElement('code');
      share.textContent = u.shareCode;
      cell(share);

      cell(String(u.contacts));
      cell(fmtDate(u.createdAt));

      const st = document.createElement('span');
      st.className = u.online ? 'status-on' : 'status-off';
      st.textContent = u.online ? '● En ligne' : '○ Hors ligne';
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
      actions.appendChild(chat);
      actions.appendChild(del);
      cell(actions);

      body.appendChild(tr);
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
