'use strict';

/*
 * 故事接龍 · main.js
 *
 * Architecture: Firebase Realtime Database handles ALL communication.
 *   WebRTC removed entirely — was failing on symmetric NAT / mobile networks.
 *
 * Firebase DB paths:
 *   rooms/{code}/info          { host, createdAt }
 *   rooms/{code}/players/{pid} { name, joinedAt, isSpectator }
 *   rooms/{code}/game          { full game state — written by host only }
 *   rooms/{code}/actions/{key} { type, playerId, text?, ts — consumed by host }
 */

// ═══════════════════════════════════════════════════════════════════════
// LAYER 1 ─ Global Configuration & Constants
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
  MAX_PLAYERS       : 8,
  MIN_PLAYERS       : 2,
  DEFAULT_ROUNDS    : 2,
  DEFAULT_TURN_TIME : 90,
  FIREBASE: {
    apiKey           : 'AIzaSyBzzMXBgVXvUw2V8tRXw7sEFNQRg-zQEeY',
    authDomain       : 'manyp-a838a.firebaseapp.com',
    databaseURL      : 'https://manyp-a838a-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId        : 'manyp-a838a',
    storageBucket    : 'manyp-a838a.firebasestorage.app',
    messagingSenderId: '763662604590',
    appId            : '1:763662604590:web:e79e0f56e5fa31963a82bf',
  },
};

const ACTION = {
  LOCK        : 'lock',
  UNLOCK      : 'unlock',
  REVEAL_NEXT : 'reveal_next',
  RETURN_LOBBY: 'return_lobby',
};

const PHASE = {
  WAITING  : 'waiting',
  WRITING  : 'writing',
  REVEALING: 'revealing',
  FINISHED : 'finished',
};

const EVT = {
  PLAYER_JOINED     : 'player:joined',
  PLAYER_LEFT       : 'player:left',
  GAME_STATE_UPDATED: 'game:state_updated',
  ACTION_RECEIVED   : 'action:received',
  ROOM_JOINED       : 'room:joined',
  TOAST             : 'ui:toast',
  RETURN_LOBBY      : 'ui:return_lobby',
};

// ═══════════════════════════════════════════════════════════════════════
// LAYER 2 ─ Utility Functions
// ═══════════════════════════════════════════════════════════════════════

const Utils = {
  genId      : ()      => Math.random().toString(36).slice(2, 11),
  genRoomCode: ()      => Math.random().toString(36).slice(2, 8).toUpperCase(),
  clamp      : (n,a,b) => Math.max(a, Math.min(b, n)),
  deepClone  : (o)     => JSON.parse(JSON.stringify(o)),

  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  avatarColor(name) {
    const palette = ['#c9a84c','#4ac0a0','#9b85e8','#e07050','#60b0e8','#d4807a','#80c870','#c080c8'];
    let h = 0;
    for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
    return palette[h % palette.length];
  },

  escapeHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },

  computeReveal(stories, step) {
    const result = [];
    let rem = step;
    for (const story of stories) {
      const n = Math.min(rem, story.length);
      result.push(story.slice(0, n));
      rem -= n;
      if (rem <= 0) { while (result.length < stories.length) result.push([]); break; }
    }
    while (result.length < stories.length) result.push([]);
    return result;
  },

  activeRevealStory(stories, step) {
    let rem = step;
    for (let i = 0; i < stories.length; i++) {
      if (rem < stories[i].length) return i;
      rem -= stories[i].length;
    }
    return stories.length - 1;
  },

  maxRevealSteps: (stories) => (stories || []).reduce((s, st) => s + st.length, 0),
};

// ═══════════════════════════════════════════════════════════════════════
// LAYER 3 ─ Event Bus
// ═══════════════════════════════════════════════════════════════════════

class EventBus {
  constructor() { this._m = {}; }

  on(event, cb) {
    if (!this._m[event]) this._m[event] = new Set();
    this._m[event].add(cb);
    return () => { if (this._m[event]) this._m[event].delete(cb); };
  }

  once(event, cb) {
    const off = this.on(event, d => { cb(d); off(); });
  }

  emit(event, data) {
    if (!this._m[event]) return;
    this._m[event].forEach(cb => {
      try { cb(data); } catch(e) { console.error('[Bus]', event, e); }
    });
  }
}

const bus = new EventBus();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 4 ─ Global State Store
// ═══════════════════════════════════════════════════════════════════════

const makeGame = () => ({
  phase        : PHASE.WAITING,
  currentTurn  : 0,
  totalTurns   : 0,
  turnsPerRound: 0,
  totalRounds  : CONFIG.DEFAULT_ROUNDS,
  mode         : 'round',
  turnTime     : CONFIG.DEFAULT_TURN_TIME,
  timeLeft     : 0,
  assignments  : {},
  stories      : [],
  locked       : {},
  submissions  : {},
  reveal       : { step: 0 },
});

class Store {
  constructor(init) { this._s = Utils.deepClone(init); this._subs = new Set(); }

  get()             { return this._s; }
  subscribe(fn)     { this._subs.add(fn); return () => this._subs.delete(fn); }
  _notify()         { this._subs.forEach(fn => { try { fn(this._s); } catch(_){} }); }

  set(partial)      { this._s = Object.assign({}, this._s, partial); this._notify(); }
  patchGame(p)      { this._s = Object.assign({}, this._s, { game: Object.assign({}, this._s.game, p) }); this._notify(); }
  replaceGame(game) { this._s = Object.assign({}, this._s, { game }); this._notify(); }
}

const store = new Store({
  myId       : null,
  myName     : '',
  roomCode   : '',
  isHost     : false,
  hostId     : null,
  isSpectator: false,
  players    : {},
  settings   : { mode: 'round', rounds: CONFIG.DEFAULT_ROUNDS, turnTime: CONFIG.DEFAULT_TURN_TIME },
  game       : makeGame(),
});

// ═══════════════════════════════════════════════════════════════════════
// LAYER 5 ─ Firebase Transport
//
//  Replaces WebRTC + Signaling entirely.
//  All game messages travel through Firebase Realtime Database.
//  Works on all networks — zero NAT traversal required.
// ═══════════════════════════════════════════════════════════════════════

class FirebaseTransport {
  constructor() {
    this._db  = null;
    this._off = [];
  }

  init() {
    if (!firebase.apps.length) firebase.initializeApp(CONFIG.FIREBASE);
    this._db = firebase.database();
  }

  ref(path) { return this._db.ref(path); }

  // ── Room operations ───────────────────────────────────

  async roomExists(code) {
    return (await this.ref('rooms/' + code + '/info').get()).exists();
  }

  async getPlayers(code) {
    const snap = await this.ref('rooms/' + code + '/players').get();
    return snap.val() || {};
  }

  async getHostId(code) {
    const snap = await this.ref('rooms/' + code + '/info/host').get();
    return snap.val();
  }

  async setHostId(code, hostId) {
    await this.ref('rooms/' + code + '/info/host').set(hostId);
  }

  async createRoom(code, hostId, hostName) {
    await this.ref('rooms/' + code).set({
      info   : { host: hostId, createdAt: Date.now() },
      players: { [hostId]: { name: hostName, joinedAt: Date.now(), isSpectator: false } },
    });
    this.ref('rooms/' + code + '/players/' + hostId).onDisconnect().remove();
    this.ref('rooms/' + code + '/info/host').onDisconnect().set(null);
  }

  async addPlayer(code, pid, name, isSpectator) {
    await this.ref('rooms/' + code + '/players/' + pid).set({
      name, joinedAt: Date.now(), isSpectator: !!isSpectator,
    });
    this.ref('rooms/' + code + '/players/' + pid).onDisconnect().remove();
  }

  async removePlayer(code, pid) {
    await this.ref('rooms/' + code + '/players/' + pid).remove();
    const remaining = await this.getPlayers(code);
    if (Object.keys(remaining).length === 0) {
      this.ref('rooms/' + code).remove().catch(() => {});
    }
  }

  // ── Player presence ───────────────────────────────────

  watchPlayers(code, onJoin, onLeave) {
    const r  = this.ref('rooms/' + code + '/players');
    const h1 = r.on('child_added',   s => onJoin(s.key, s.val()));
    const h2 = r.on('child_removed', s => onLeave(s.key));
    this._off.push(() => { r.off('child_added', h1); r.off('child_removed', h2); });
  }

  // ── Game state: host writes, everyone reads ───────────

  pushGameState(code, game) {
    const safe = JSON.parse(JSON.stringify(game));
    this.ref('rooms/' + code + '/game').set(safe).catch(e => console.warn('[transport] push:', e));
  }

  watchGameState(code, cb) {
    const r = this.ref('rooms/' + code + '/game');
    const h = r.on('value', snap => { if (snap.exists()) cb(snap.val()); });
    this._off.push(() => r.off('value', h));
  }

  // ── Player actions: players write, host reads ─────────

  pushAction(code, action) {
    this.ref('rooms/' + code + '/actions').push(
      Object.assign({}, action, { ts: Date.now() })
    ).catch(e => console.warn('[transport] action:', e));
  }

  watchActions(code, cb) {
    const r = this.ref('rooms/' + code + '/actions');
    const h = r.on('child_added', snap => {
      const val = snap.val();
      if (val) { cb(val); snap.ref.remove().catch(() => {}); }
    });
    this._off.push(() => r.off('child_added', h));
  }

  // ── Cleanup ───────────────────────────────────────────

  teardown() {
    this._off.forEach(fn => fn());
    this._off = [];
  }
}

const transport = new FirebaseTransport();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 6 ─ (Merged into FirebaseTransport)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// LAYER 7 ─ Room Management System
// ═══════════════════════════════════════════════════════════════════════

class RoomManager {

  async createRoom(playerName) {
    const myId     = Utils.genId();
    const roomCode = Utils.genRoomCode();
    store.set({ myId, myName: playerName, roomCode, isHost: true, hostId: myId, isSpectator: false });
    await transport.createRoom(roomCode, myId, playerName);
    this._listen(roomCode, myId, true);
    bus.emit(EVT.ROOM_JOINED, { roomCode });
    return roomCode;
  }

  async joinRoom(rawCode, playerName) {
    const roomCode = rawCode.trim().toUpperCase();

    if (!(await transport.roomExists(roomCode)))
      throw new Error('找不到此房間，請確認代碼是否正確');

    const existingPlayers = await transport.getPlayers(roomCode);
    const hostId          = await transport.getHostId(roomCode);

    // Bug 2 fix: zombie room detection — exists but has no players/host
    if (!hostId || Object.keys(existingPlayers).length === 0) {
      transport.ref('rooms/' + roomCode).remove().catch(() => {});
      throw new Error('房間已解散，請重新建立一個新房間');
    }

    if (Object.keys(existingPlayers).length >= CONFIG.MAX_PLAYERS)
      throw new Error('房間已達人數上限（8人）');

    // Detect mid-game join → spectator
    const gameSnap    = await transport.ref('rooms/' + roomCode + '/game').get();
    const gd          = gameSnap.val();
    const isSpectator = !!(gd && gd.phase && gd.phase !== PHASE.WAITING);

    const myId = Utils.genId();
    store.set({ myId, myName: playerName, roomCode, isHost: false, hostId, isSpectator });
    await transport.addPlayer(roomCode, myId, playerName, isSpectator);
    this._listen(roomCode, myId, false);

    bus.emit(EVT.ROOM_JOINED, { roomCode, isSpectator });
    return { roomCode, isSpectator };
  }

  /** Soft reset — keep Firebase connection, just clear game state. */
  returnToLobby() {
    const { roomCode, isHost } = store.get();
    const fresh = makeGame();
    store.replaceGame(fresh);
    store.set({ isSpectator: false });
    if (isHost) transport.pushGameState(roomCode, fresh);
    bus.emit(EVT.RETURN_LOBBY);
  }

  /** Hard leave — disconnect and return to home. */
  async hardLeave() {
    const { roomCode, myId, isHost } = store.get();
    transport.teardown();
    try { await transport.removePlayer(roomCode, myId); } catch(_) {}
    if (isHost) transport.ref('rooms/' + roomCode + '/game').remove().catch(() => {});
    store.set({
      myId: null, myName: '', roomCode: '', isHost: false,
      hostId: null, isSpectator: false, players: {}, game: makeGame(),
    });
  }

  startWatchingActions() {
    const { roomCode } = store.get();
    transport.watchActions(roomCode, action => {
      if (!store.get().isHost) return;
      bus.emit(EVT.ACTION_RECEIVED, { action });
    });
  }

  _listen(roomCode, myId, isHost) {
    // Player presence (everyone)
    transport.watchPlayers(
      roomCode,
      (pid, data) => bus.emit(EVT.PLAYER_JOINED, { id: pid, name: data.name, isSpectator: !!data.isSpectator }),
      (pid)       => bus.emit(EVT.PLAYER_LEFT,   { id: pid }),
    );

    // Game state: non-hosts receive from Firebase; host is the source and ignores own writes
    transport.watchGameState(roomCode, game => {
      if (store.get().isHost) return;
      bus.emit(EVT.GAME_STATE_UPDATED, { state: game });
    });

    // Actions: only host processes
    if (isHost) this.startWatchingActions();
  }
}

const roomManager = new RoomManager();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 8 ─ Player Synchronization System
// ═══════════════════════════════════════════════════════════════════════

class PlayerSync {
  constructor() {
    bus.on(EVT.PLAYER_JOINED, d => this._onJoin(d));
    bus.on(EVT.PLAYER_LEFT,   d => this._onLeave(d));
  }

  _onJoin({ id, name, isSpectator }) {
    const { players, myId, myName, hostId } = store.get();
    store.set({
      players: Object.assign({}, players, {
        [id]: {
          name       : id === myId ? myName : name,
          isHost     : id === hostId,
          isSpectator: !!isSpectator,
          status     : 'online',
        },
      }),
    });
    if (id !== myId) bus.emit(EVT.TOAST, { msg: name + ' 加入了房間', type: 'info' });
  }

  _onLeave({ id }) {
    const { players, hostId } = store.get();
    const name = (players[id] || {}).name || id;
    const upd  = Object.assign({}, players);
    delete upd[id];
    store.set({ players: upd });
    bus.emit(EVT.TOAST, { msg: name + ' 離開了房間', type: 'info' });
    if (id === hostId) this._electHost();
  }

  /**
   * Deterministic host election: all remaining clients sort IDs alphabetically
   * and agree on the same first entry as the new host.
   */
  _electHost() {
    const { players, myId, roomCode } = store.get();
    const remaining = Object.keys(players).sort();
    if (remaining.length === 0) return;

    const newHostId = remaining[0];
    const updated   = {};
    for (const id of Object.keys(players))
      updated[id] = Object.assign({}, players[id], { isHost: id === newHostId });
    store.set({ hostId: newHostId, players: updated });

    if (myId === newHostId) {
      store.set({ isHost: true });
      bus.emit(EVT.TOAST, { msg: '👑 你已成為新的主持人！', type: 'success' });
      transport.setHostId(roomCode, newHostId).catch(() => {});
      transport.ref('rooms/' + roomCode + '/info/host').onDisconnect().set(null);
      roomManager.startWatchingActions();
      const { game } = store.get();
      if (game.phase !== PHASE.WAITING)
        setTimeout(() => gameEngine.broadcastState(), 300);
    }
  }
}

const playerSync = new PlayerSync();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 9 ─ Game Engine Core
// ═══════════════════════════════════════════════════════════════════════

class GameEngine {
  constructor() {
    this._timer = null;

    bus.on(EVT.GAME_STATE_UPDATED, ({ state }) => {
      if (!state || !state.phase) return;
      store.replaceGame(state);
    });

    bus.on(EVT.ACTION_RECEIVED, ({ action }) => {
      if (!store.get().isHost) return;
      const pid = action.playerId;
      if (action.type === ACTION.LOCK)         storyRelay.handleLock(pid, action.text);
      else if (action.type === ACTION.UNLOCK)  storyRelay.handleUnlock(pid);
      else if (action.type === ACTION.REVEAL_NEXT)  storyRelay.revealNext();
      else if (action.type === ACTION.RETURN_LOBBY) roomManager.returnToLobby();
    });
  }

  startGame(settings) {
    const { players } = store.get();
    const activePids  = Object.entries(players)
      .filter(([, p]) => !p.isSpectator)
      .map(([id]) => id);

    const N           = activePids.length;
    const shuffled    = Utils.shuffle(activePids.slice());
    const stories     = shuffled.map(() => []);
    const assignments = {};
    shuffled.forEach((pid, i) => { assignments[pid] = i; });

    store.replaceGame({
      phase        : PHASE.WRITING,
      currentTurn  : 1,
      totalTurns   : N * settings.rounds,
      turnsPerRound: N,
      totalRounds  : settings.rounds,
      mode         : settings.mode,
      turnTime     : settings.turnTime,
      timeLeft     : settings.mode === 'time' ? settings.turnTime : 0,
      assignments,
      stories,
      locked       : {},
      submissions  : {},
      reveal       : { step: 0 },
    });

    this.broadcastState();
    if (settings.mode === 'time') this._startTimer(settings.turnTime);
  }

  _startTimer(sec) {
    this.stopTimer();
    let t = sec;
    this._timer = setInterval(() => {
      t = Math.max(0, t - 1);
      store.patchGame({ timeLeft: t });
      this.broadcastState();
      if (t <= 0) { this.stopTimer(); storyRelay.advance(); }
    }, 1000);
  }

  stopTimer() { clearInterval(this._timer); this._timer = null; }

  broadcastState() {
    const { isHost, game, roomCode } = store.get();
    if (!isHost) return;
    transport.pushGameState(roomCode, game);
  }

  sendAction(action) {
    const { isHost, myId, roomCode } = store.get();
    if (isHost) {
      bus.emit(EVT.ACTION_RECEIVED, { action: Object.assign({}, action, { playerId: myId }) });
    } else {
      transport.pushAction(roomCode, Object.assign({}, action, { playerId: myId }));
    }
  }
}

const gameEngine = new GameEngine();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 10 ─ Story Relay Game Logic
// ═══════════════════════════════════════════════════════════════════════

class StoryRelay {
  constructor() { this._advTimer = null; }

  handleLock(playerId, text) {
    if (!text || !text.trim()) return;
    const { game } = store.get();
    store.patchGame({
      submissions: Object.assign({}, game.submissions, { [playerId]: text.trim() }),
      locked     : Object.assign({}, game.locked,      { [playerId]: true }),
    });
    gameEngine.broadcastState();
    this.checkAllLocked();
  }

  handleUnlock(playerId) {
    const { game } = store.get();
    const locked = Object.assign({}, game.locked);
    delete locked[playerId];
    store.patchGame({ locked });
    gameEngine.broadcastState();
  }

  checkAllLocked() {
    const { game, players } = store.get();
    if (game.phase !== PHASE.WRITING) return;
    const assignments = game.assignments || {};
    const inGame      = Object.keys(players).filter(id => id in assignments);
    if (inGame.length > 0 && inGame.every(pid => game.locked[pid])) {
      clearTimeout(this._advTimer);
      this._advTimer = setTimeout(() => this.advance(), 900);
    }
  }

  advance() {
    gameEngine.stopTimer();
    const { game, players } = store.get();
    const stories = Utils.deepClone(game.stories);

    for (const pid of Object.keys(game.submissions)) {
      const text = game.submissions[pid];
      const idx  = game.assignments[pid];
      if (idx !== undefined && text)
        stories[idx].push({ authorId: pid, authorName: (players[pid] || {}).name || '???', text });
    }

    const nextTurn = game.currentTurn + 1;

    if (nextTurn > game.totalTurns) {
      store.patchGame({ phase: PHASE.REVEALING, stories, locked: {}, submissions: {}, reveal: { step: 0 } });
      gameEngine.broadcastState();
      return;
    }

    const storyCount     = stories.length;
    const newAssignments = {};
    for (const pid of Object.keys(game.assignments))
      newAssignments[pid] = (game.assignments[pid] + 1) % storyCount;

    store.patchGame({
      phase       : PHASE.WRITING,
      currentTurn : nextTurn,
      stories,
      assignments : newAssignments,
      locked      : {},
      submissions  : {},
      timeLeft    : game.mode === 'time' ? game.turnTime : 0,
    });
    gameEngine.broadcastState();
    if (game.mode === 'time') gameEngine._startTimer(game.turnTime);
  }

  revealNext() {
    const { game } = store.get();
    if (game.phase !== PHASE.REVEALING) return;
    const max     = Utils.maxRevealSteps(game.stories);
    const newStep = Math.min(((game.reveal || {}).step || 0) + 1, max);
    store.patchGame({ reveal: { step: newStep } });
    gameEngine.broadcastState();
    if (newStep >= max)
      setTimeout(() => { store.patchGame({ phase: PHASE.FINISHED }); gameEngine.broadcastState(); }, 1400);
  }

  getContext(playerId) {
    const { game } = store.get();
    const idx   = (game.assignments || {})[playerId];
    if (idx === undefined) return null;
    const story = (game.stories || [])[idx];
    return story && story.length ? story[story.length - 1] : null;
  }
}

const storyRelay = new StoryRelay();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 11 ─ UI Controller
// ═══════════════════════════════════════════════════════════════════════

class UIController {
  constructor() {
    this._screen    = 'home';
    this._toastTmr  = null;
    this._lastTurn  = -1;
    this._prevPhase = PHASE.WAITING;

    store.subscribe(s => this._sync(s));
    bus.on(EVT.TOAST,       d  => this.toast(d.msg, d.type));
    bus.on(EVT.RETURN_LOBBY, () => this.show('room'));

    bus.on(EVT.ROOM_JOINED, ({ roomCode }) => {
      this._setText('display-room-code', roomCode);
      this.show('room');
    });

    bus.on(EVT.GAME_STATE_UPDATED, ({ state }) => {
      if (!state || !state.phase) return;
      if (this._prevPhase === PHASE.WAITING && state.phase === PHASE.WRITING && this._screen === 'room')
        this.show('game');
      if (state.phase === PHASE.WAITING && this._screen === 'game')
        this.show('room');
      this._prevPhase = state.phase;
    });
  }

  init() {
    this._bindHome();
    this._bindRoom();
    this._bindGame();
    this.show('home');
  }

  /**
   * Switch screens AND immediately re-render with current state.
   * Prevents blank screens when first displayed.
   */
  show(name) {
    document.querySelectorAll('.screen').forEach(el => {
      el.classList.add('hidden');
      el.classList.remove('active');
    });
    const el = document.getElementById('screen-' + name);
    if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
    this._screen = name;
    this._sync(store.get());   // force immediate render
  }

  toast(msg, type) {
    type = type || 'info';
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className   = 'toast ' + type;
    clearTimeout(this._toastTmr);
    this._toastTmr = setTimeout(() => t.classList.add('hidden'), 3600);
  }

  overlay(msg) {
    this._setText('overlay-msg', msg);
    const el = document.getElementById('overlay');
    if (el) el.classList.remove('hidden');
  }

  hideOverlay() {
    const el = document.getElementById('overlay');
    if (el) el.classList.add('hidden');
  }

  // ── Store sync ────────────────────────────────────────

  _sync(s) {
    if (this._screen === 'room') {
      this._renderPlayers(s.players, s.myId, s.hostId);
      this._renderRoomControls(s);
    }
    if (this._screen === 'game') {
      const g = s.game;
      if (!g || !g.phase || g.phase === PHASE.WAITING) return;
      this._renderGame(s);
    }
  }

  // ── Room rendering ────────────────────────────────────

  _renderPlayers(players, myId, hostId) {
    const cnt = document.getElementById('player-count');
    const lst = document.getElementById('players-list');
    if (!cnt || !lst) return;
    const n = Object.keys(players).length;
    cnt.textContent = n + ' / ' + CONFIG.MAX_PLAYERS;
    lst.innerHTML = Object.entries(players).map(function([id, p]) {
      const isHost = id === hostId;
      const isMe   = id === myId;
      return '<li class="player-item ' + (isHost ? 'is-host' : '') + '">' +
        '<div class="player-avatar" style="background:' + Utils.avatarColor(p.name) + '">' + (p.name || '?')[0] + '</div>' +
        '<span class="player-name">' + Utils.escapeHtml(p.name) + '</span>' +
        '<div class="player-badges">' +
          (isHost ? '<span class="p-badge p-badge-host">👑 主持人</span>' : '') +
          (isMe   ? '<span class="p-badge p-badge-you">你</span>' : '') +
          (p.isSpectator ? '<span class="p-badge p-badge-spec">觀戰中</span>' : '') +
          '<span class="p-badge p-badge-conn">在線</span>' +
        '</div></li>';
    }).join('');
  }

  _renderRoomControls(s) {
    this._show('settings-panel', s.isHost);
    this._show('waiting-panel', !s.isHost);
    if (s.isHost) {
      const mode = (s.settings || {}).mode || 'round';
      document.querySelectorAll('input[name="game-mode"]').forEach(r => { r.checked = r.value === mode; });
      this._show('time-setting', mode === 'time');
    }
  }

  // ── Game rendering ────────────────────────────────────

  _renderGame(s) {
    const { game, players, myId, isHost, isSpectator } = s;
    const phase       = game.phase;
    const amSpectator = isSpectator || (myId && !((game.assignments || {})[myId] !== undefined));

    // Show the correct phase panel
    this._show('phase-spectating', phase === PHASE.WRITING  &&  amSpectator);
    this._show('phase-writing',    phase === PHASE.WRITING  && !amSpectator);
    this._show('phase-revealing',  phase === PHASE.REVEALING);
    this._show('phase-finished',   phase === PHASE.FINISHED);

    this._renderHeader(game, players);

    if (phase === PHASE.WRITING) {
      if (amSpectator) this._renderSpectating(game, players);
      else             this._renderWriting(game, myId);
    }
    if (phase === PHASE.REVEALING) this._renderRevealing(game, players, isHost);
    if (phase === PHASE.FINISHED)  this._renderFinished(game);

    // Reset textarea on new turn
    if (phase === PHASE.WRITING && !amSpectator && game.currentTurn !== this._lastTurn) {
      this._lastTurn = game.currentTurn;
      const inp = document.getElementById('story-input');
      if (inp) { inp.value = ''; inp.disabled = false; }
      this._setText('char-count', '0 / 500');
      this._show('btn-lock',       true);
      this._show('btn-unlock',     false);
      this._show('waiting-locked', false);
    }
  }

  _renderHeader(game, players) {
    const phase = game.phase;

    if (phase === PHASE.WRITING) {
      const { turnsPerRound, currentTurn, totalRounds, mode, timeLeft, assignments } = game;
      if (!turnsPerRound || !currentTurn) return;
      const round = Math.ceil(currentTurn / turnsPerRound);
      const tw    = ((currentTurn - 1) % turnsPerRound) + 1;
      this._setText('game-round-label', '第 ' + round + ' / ' + totalRounds + ' 回合');
      this._setText('game-turn-label',  '第 ' + tw    + ' / ' + turnsPerRound + ' 輪');
      this._setBadge('game-phase-badge', '寫作中', 'writing');
      this._show('header-lock-info', true);

      const inGame  = Object.keys(players).filter(id => (assignments || {})[id] !== undefined);
      const locked  = inGame.filter(id => (game.locked || {})[id]);
      this._setText('lock-count', '已鎖定 ' + locked.length + ' / ' + inGame.length);

      const te = document.getElementById('game-timer');
      if (te) {
        if (mode === 'time') {
          te.classList.remove('hidden');
          this._setText('timer-value', String(Math.max(0, timeLeft || 0)));
          te.classList.toggle('urgent', (timeLeft || 0) <= 10);
        } else {
          te.classList.add('hidden');
        }
      }

    } else if (phase === PHASE.REVEALING) {
      this._setText('game-round-label', '🎭 故事揭示時刻');
      this._setText('game-turn-label',  '');
      this._setBadge('game-phase-badge', '揭示中', 'revealing');
      const max  = Utils.maxRevealSteps(game.stories);
      const step = (game.reveal || {}).step || 0;
      this._show('header-lock-info', true);
      this._setText('lock-count', '已揭示 ' + step + ' / ' + max + ' 段');
      const te = document.getElementById('game-timer');
      if (te) te.classList.add('hidden');

    } else if (phase === PHASE.FINISHED) {
      this._setText('game-round-label', '🎉 遊戲結束');
      this._setText('game-turn-label',  '');
      this._setBadge('game-phase-badge', '完結', 'finished');
      this._show('header-lock-info', false);
      const te = document.getElementById('game-timer');
      if (te) te.classList.add('hidden');
    }
  }

  _renderWriting(game, myId) {
    const ctx      = storyRelay.getContext(myId);
    const ctxEl    = document.getElementById('story-context-text');
    const inp      = document.getElementById('story-input');
    const isLocked = !!((game.locked || {})[myId]);

    if (ctxEl) {
      if (ctx) {
        ctxEl.innerHTML = '<strong>' + Utils.escapeHtml(ctx.authorName) + '</strong> 寫道：\n\n' + Utils.escapeHtml(ctx.text);
        ctxEl.classList.add('has-content');
      } else {
        ctxEl.innerHTML = '<span class="context-placeholder">（故事的開端，由你來書寫！）</span>';
        ctxEl.classList.remove('has-content');
      }
    }
    if (inp) inp.disabled = isLocked;
    this._show('btn-lock',       !isLocked);
    this._show('btn-unlock',      isLocked);
    this._show('waiting-locked',  isLocked);
  }

  /** Spectator view: live game progress overview */
  _renderSpectating(game, players) {
    const { turnsPerRound, currentTurn, totalRounds, assignments, locked } = game;
    if (!turnsPerRound || !currentTurn) return;

    const round = Math.ceil(currentTurn / turnsPerRound);
    const tw    = ((currentTurn - 1) % turnsPerRound) + 1;
    this._setText('spec-round', '第 ' + round + ' / ' + totalRounds + ' 回合 · 第 ' + tw + ' / ' + turnsPerRound + ' 輪');

    const inGame  = Object.keys(assignments || {});
    const lockedN = inGame.filter(id => (locked || {})[id]).length;
    this._setText('spec-lock-status', lockedN + ' / ' + inGame.length + ' 人已鎖定');

    const grid = document.getElementById('spec-players-grid');
    if (grid) {
      grid.innerHTML = inGame.map(pid => {
        const p      = players[pid] || {};
        const isLock = !!((locked || {})[pid]);
        const color  = Utils.avatarColor(p.name || pid);
        return '<div class="spec-player-chip ' + (isLock ? 'locked' : '') + '">' +
          '<div class="spec-avatar" style="background:' + color + '">' + (p.name || '?')[0] + '</div>' +
          '<span class="spec-pname">' + Utils.escapeHtml(p.name || '???') + '</span>' +
          '<span class="spec-lock-icon">' + (isLock ? '🔒' : '✏️') + '</span>' +
        '</div>';
      }).join('');
    }
  }

  _renderRevealing(game, players, isHost) {
    const step    = (game.reveal || {}).step || 0;
    const stories = game.stories || [];
    const max     = Utils.maxRevealSteps(stories);
    const isDone  = step >= max;

    const fill = document.getElementById('reveal-progress-fill');
    if (fill) fill.style.width = max ? (step / max * 100) + '%' : '0%';

    this._setText('reveal-subtitle',
      isDone ? '所有故事已完整揭示！'
             : step === 0 ? '主持人將逐段揭示眾人合力創作的故事'
                          : '正在揭示故事 ' + (Utils.activeRevealStory(stories, step) + 1) + '…');

    this._show('btn-reveal-next',      isHost && !isDone);
    this._show('reveal-watching-text', !isHost && !isDone);
    this._show('btn-reveal-done',      isDone);

    const revealedPerStory = Utils.computeReveal(stories, step);
    const activeIdx        = isDone ? -1 : Utils.activeRevealStory(stories, step);
    const cont             = document.getElementById('reveal-stories-container');
    if (!cont) return;

    cont.innerHTML = stories.map((story, si) => {
      const revealed = revealedPerStory[si];
      const isActive = si === activeIdx;
      const isUnrev  = revealed.length === 0;
      const segsHtml = isUnrev
        ? '<div class="reveal-seg-empty">尚未揭示</div>'
        : revealed.map((seg, i) => {
            const isNew = i === revealed.length - 1 && isActive;
            return '<div class="reveal-seg ' + (isNew ? 'r-new' : '') + '">' +
              '<div class="reveal-seg-meta">第 ' + (i+1) + ' 段 &nbsp;<span class="reveal-seg-author">' + Utils.escapeHtml(seg.authorName) + '</span></div>' +
              '<div class="reveal-seg-text">' + Utils.escapeHtml(seg.text) + '</div>' +
            '</div>';
          }).join('');
      return '<div class="reveal-story-card ' + (isActive ? 'r-active' : '') + ' ' + (isUnrev ? 'r-unrevealed' : '') + '">' +
        '<div class="reveal-story-header"><span class="reveal-story-num">📖 故事 ' + (si+1) + '</span>' +
        '<span class="reveal-seg-count">' + revealed.length + ' / ' + story.length + ' 段</span></div>' +
        '<div class="reveal-segs">' + segsHtml + '</div></div>';
    }).join('');
  }

  _renderFinished(game) {
    const cont = document.getElementById('final-stories');
    if (!cont) return;
    cont.innerHTML = (game.stories || []).map((story, si) => {
      const segs = story.length === 0
        ? '<p style="color:var(--txt2);padding:16px 20px;font-style:italic">（這個故事沒有任何內容）</p>'
        : story.map((seg, i) =>
            '<div class="story-seg">' +
              '<div class="story-seg-meta">第 ' + (i+1) + ' 段' +
                '<span class="story-seg-rnd">回合 ' + Math.ceil((i+1) / (game.turnsPerRound || 1)) + '</span>' +
                Utils.escapeHtml(seg.authorName) +
              '</div>' +
              '<div class="story-seg-text">' + Utils.escapeHtml(seg.text) + '</div>' +
            '</div>').join('');
      return '<div class="story-card">' +
        '<div class="story-card-header">📖 故事 ' + (si+1) + '</div>' +
        '<div class="story-card-body">' + segs + '</div>' +
      '</div>';
    }).join('');
  }

  // ── Bindings ──────────────────────────────────────────

  _bindHome() {
    var self = this;
    var go   = async function(join) {
      var name = (document.getElementById('input-name') || {}).value;
      name = name ? name.trim() : '';
      if (!name) return self._err('home-error', '請先輸入暱稱');
      if (join) {
        var code = (document.getElementById('input-room-code') || {}).value;
        code = code ? code.trim() : '';
        if (!code) return self._err('home-error', '請輸入房間代碼');
        try   { self.overlay('加入房間中…'); await roomManager.joinRoom(code, name); self.hideOverlay(); }
        catch (e) { self.hideOverlay(); self._err('home-error', '加入失敗：' + e.message); }
      } else {
        try   { self.overlay('建立房間中…'); await roomManager.createRoom(name); self.hideOverlay(); }
        catch (e) { self.hideOverlay(); self._err('home-error', '建立失敗：' + e.message); }
      }
    };
    this._on('btn-create-room', 'click', function() { go(false); });
    this._on('btn-join-room',   'click', function() { go(true);  });
    this._on('input-room-code', 'keydown', function(e) { if (e.key === 'Enter') go(true);  });
    this._on('input-name',      'keydown', function(e) {
      if (e.key === 'Enter') {
        var c = document.getElementById('input-room-code');
        (c && c.value.trim()) ? go(true) : go(false);
      }
    });
  }

  _bindRoom() {
    var self = this;
    this._on('btn-copy-code', 'click', function() {
      var code = (document.getElementById('display-room-code') || {}).textContent || '';
      if (navigator.clipboard) {
        navigator.clipboard.writeText(code)
          .then(function() { self.toast('房間代碼已複製！', 'success'); })
          .catch(function() { self.toast('代碼：' + code, 'info'); });
      } else {
        self.toast('代碼：' + code, 'info');
      }
    });

    this._on('btn-leave-room', 'click', async function() {
      await roomManager.hardLeave();
      self.show('home');
    });

    this._on('btn-start-game', 'click', function() {
      var players      = store.get().players;
      var activePlayers = Object.values(players).filter(function(p) { return !p.isSpectator; });
      if (activePlayers.length < CONFIG.MIN_PLAYERS)
        return self._err('room-error', '至少需要 ' + CONFIG.MIN_PLAYERS + ' 名玩家才能開始');

      var modeEl    = document.querySelector('input[name="game-mode"]:checked');
      var mode      = modeEl ? modeEl.value : 'round';
      var roundsEl  = document.getElementById('input-rounds');
      var timeEl    = document.getElementById('input-turn-time');
      var rounds    = Utils.clamp(parseInt((roundsEl || {}).value || 2), 1, 10);
      var turnTime  = Utils.clamp(parseInt((timeEl   || {}).value || 90), 15, 300);

      store.set({ settings: { mode, rounds, turnTime } });
      gameEngine.startGame({ mode, rounds, turnTime });
      self._prevPhase = PHASE.WAITING;
      self.show('game');
    });

    document.querySelectorAll('input[name="game-mode"]').forEach(function(r) {
      r.addEventListener('change', function(e) {
        var s = store.get().settings;
        store.set({ settings: Object.assign({}, s, { mode: e.target.value }) });
        self._show('time-setting', e.target.value === 'time');
      });
    });
  }

  _bindGame() {
    var self = this;
    this._on('story-input', 'input', function() {
      var inp = document.getElementById('story-input');
      self._setText('char-count', (inp ? inp.value.length : 0) + ' / 500');
    });
    this._on('story-input', 'keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var btn = document.getElementById('btn-lock');
        if (btn) btn.click();
      }
    });
    this._on('btn-lock', 'click', function() {
      var inp  = document.getElementById('story-input');
      var text = inp ? inp.value.trim() : '';
      if (!text) return self.toast('請先輸入故事內容再鎖定', 'error');
      gameEngine.sendAction({ type: ACTION.LOCK, text });
    });
    this._on('btn-unlock',      'click', function() { gameEngine.sendAction({ type: ACTION.UNLOCK      }); });
    this._on('btn-reveal-next', 'click', function() { gameEngine.sendAction({ type: ACTION.REVEAL_NEXT }); });
    this._on('btn-reveal-done', 'click', function() {
      if (store.get().isHost) {
        store.patchGame({ phase: PHASE.FINISHED });
        gameEngine.broadcastState();
      } else {
        store.patchGame({ phase: PHASE.FINISHED });
      }
    });
    this._on('btn-back-to-lobby', 'click', function() { roomManager.returnToLobby(); });
  }

  // ── DOM helpers ───────────────────────────────────────

  _on(id, ev, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
    else console.warn('[UI] #' + id + ' not found');
  }

  _show(id, visible) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
  }

  _setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  _setBadge(id, text, cls) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className   = 'phase-badge ' + cls;
  }

  _err(elId, msg) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(function() { el.classList.add('hidden'); }, 5000);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 12 ─ App Bootstrap
// ═══════════════════════════════════════════════════════════════════════

class App {
  constructor() { this._ui = new UIController(); }

  async init() {
    try {
      transport.init();
    } catch(e) {
      console.error('Firebase init error:', e);
      return;
    }
    this._ui.init();

    window.addEventListener('beforeunload', function() {
      var s = store.get();
      if (s.roomCode && s.myId) {
        try { transport.ref('rooms/' + s.roomCode + '/players/' + s.myId).remove(); } catch(_) {}
        if (s.isHost) try { transport.ref('rooms/' + s.roomCode + '/info/host').set(null); } catch(_) {}
      }
    });

    console.log('%c📖 故事接龍 已啟動 (Firebase Transport — 無 WebRTC)', 'color:#c9a84c;font-weight:bold;font-size:14px');
  }
}

document.addEventListener('DOMContentLoaded', function() { new App().init(); });
