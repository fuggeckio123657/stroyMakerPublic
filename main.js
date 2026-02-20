'use strict';

// ═══════════════════════════════════════════════════════════════════════
// LAYER 1 ─ Global Configuration & Constants
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
  HEARTBEAT_INTERVAL : 2000,
  PEER_TIMEOUT       : 8000,
  MAX_PLAYERS        : 8,
  MIN_PLAYERS        : 2,
  DEFAULT_ROUNDS     : 2,
  DEFAULT_TURN_TIME  : 90,
  ICE_SERVERS: [
    // STUN – discover public IPs
    { urls: 'stun:stun.l.google.com:19302'        },
    { urls: 'stun:stun1.l.google.com:19302'       },
    { urls: 'stun:stun2.l.google.com:19302'       },
    { urls: 'stun:stun.stunprotocol.org:3478'     },
    // TURN – relay traffic through symmetric NAT (different home / mobile networks)
    { urls: 'turn:openrelay.metered.ca:80',          username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',         username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
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

// Wire-protocol message types
const MSG = {
  HB         : 'hb',
  HB_ACK     : 'hb_ack',
  GAME_STATE : 'game_state',
  ACTION     : 'action',
};

// Player action types
const ACTION = {
  LOCK        : 'lock',
  UNLOCK      : 'unlock',
  REVEAL_NEXT : 'reveal_next',
  RETURN_LOBBY: 'return_lobby',
};

// Game phases
const PHASE = {
  WAITING   : 'waiting',
  WRITING   : 'writing',
  REVEALING : 'revealing',
  FINISHED  : 'finished',
};

// Internal event names
const EVT = {
  PLAYER_JOINED      : 'player:joined',
  PLAYER_LEFT        : 'player:left',
  PEER_CONNECTED     : 'peer:connected',
  PEER_DISCONNECTED  : 'peer:disconnected',
  GAME_STATE_UPDATED : 'game:state_updated',
  ACTION_RECEIVED    : 'action:received',
  ROOM_JOINED        : 'room:joined',
  TOAST              : 'ui:toast',
  RETURN_LOBBY       : 'ui:return_lobby',
  _ICE               : '_webrtc:ice',
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
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  avatarColor(name = '') {
    const p = ['#c9a84c','#4ac0a0','#9b85e8','#e07050','#60b0e8','#d4807a','#80c870','#c080c8'];
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
    return p[h % p.length];
  },

  escapeHtml(s = '') {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },

  /**
   * For the reveal phase: given all stories and a step number,
   * return how many segments are visible for each story.
   * Stories are revealed sequentially (story 0 all, then story 1 all, …).
   */
  computeReveal(stories, step) {
    const out = stories.map(() => []);
    let rem   = step;
    for (let i = 0; i < stories.length && rem > 0; i++) {
      const n    = Math.min(rem, stories[i].length);
      out[i]     = stories[i].slice(0, n);
      rem       -= n;
    }
    return out;
  },

  /** Index of the story currently being filled by the reveal cursor. */
  activeRevealStory(stories, step) {
    let rem = step;
    for (let i = 0; i < stories.length; i++) {
      if (rem <= stories[i].length) return i;
      rem -= stories[i].length;
    }
    return stories.length - 1;
  },

  maxRevealSteps: (stories) => stories.reduce((s, st) => s + st.length, 0),
};

// ═══════════════════════════════════════════════════════════════════════
// LAYER 3 ─ Event Bus
// ═══════════════════════════════════════════════════════════════════════

class EventBus {
  constructor() { this._m = {}; }

  on(ev, cb) {
    (this._m[ev] ??= new Set()).add(cb);
    return () => this._m[ev]?.delete(cb);
  }

  emit(ev, data) {
    this._m[ev]?.forEach(cb => { try { cb(data); } catch(e) { console.error(`[Bus:${ev}]`, e); } });
  }
}

const bus = new EventBus();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 4 ─ Global State Store  (single source of truth)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Round definition:
 *   turnsPerRound = N players  →  each player writes every story once per round
 *   totalTurns    = turnsPerRound × totalRounds
 *
 * Displayed round   = ceil(currentTurn / turnsPerRound)
 * Turn within round = ((currentTurn - 1) % turnsPerRound) + 1
 */
const makeGame = () => ({
  phase        : PHASE.WAITING,
  currentTurn  : 0,
  totalTurns   : 0,
  turnsPerRound: 0,
  totalRounds  : CONFIG.DEFAULT_ROUNDS,
  mode         : 'round',
  turnTime     : CONFIG.DEFAULT_TURN_TIME,
  timeLeft     : 0,
  assignments  : {},   // { playerId: storyIndex }
  stories      : [],   // Array of story arrays: [ [{authorId,authorName,text}] ]
  locked       : {},   // { playerId: true }
  submissions  : {},   // { playerId: text }
  reveal       : { step: 0 },
});

class Store {
  constructor(init) { this._s = Utils.deepClone(init); this._subs = new Set(); }

  get()           { return this._s; }
  subscribe(fn)   { this._subs.add(fn); return () => this._subs.delete(fn); }
  _notify()       { this._subs.forEach(fn => { try { fn(this._s); } catch(_){} }); }

  set(partial) {
    this._s = { ...this._s, ...partial };
    this._notify();
  }

  // Merge partial into the game sub-object only
  patchGame(partial) {
    this._s = { ...this._s, game: { ...this._s.game, ...partial } };
    this._notify();
  }

  // Replace entire game object (used when receiving host broadcast)
  replaceGame(game) {
    this._s = { ...this._s, game };
    this._notify();
  }
}

const store = new Store({
  myId    : null,
  myName  : '',
  roomCode: '',
  isHost  : false,
  hostId  : null,
  players : {},
  settings: { mode: 'round', rounds: CONFIG.DEFAULT_ROUNDS, turnTime: CONFIG.DEFAULT_TURN_TIME },
  game    : makeGame(),
});

// ═══════════════════════════════════════════════════════════════════════
// LAYER 5 ─ WebRTC Connection Manager
// ═══════════════════════════════════════════════════════════════════════

class WebRTCManager {
  constructor() {
    this._pcs      = new Map();   // peerId → RTCPeerConnection
    this._channels = new Map();   // peerId → RTCDataChannel
    this._hbTimers = new Map();   // peerId → intervalId
    this._lastSeen = new Map();   // peerId → timestamp
    this._iceQueue = new Map();   // peerId → pending candidates
  }

  async createOffer(peerId) {
    const pc  = this._newPC(peerId);
    const ch  = pc.createDataChannel('relay', { ordered: true });
    this._wireChannel(peerId, ch);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(peerId, sdp) {
    const pc = this._newPC(peerId);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await this._flushICE(peerId, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(peerId, sdp) {
    const pc = this._pcs.get(peerId);
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
    // ← CRITICAL: flush ICE candidates that arrived before remote description was set
    await this._flushICE(peerId, pc);
  }

  async addICE(peerId, candidate) {
    const pc = this._pcs.get(peerId);
    if (pc?.remoteDescription) {
      try { await pc.addIceCandidate(candidate); } catch(_){}
    } else {
      if (!this._iceQueue.has(peerId)) this._iceQueue.set(peerId, []);
      this._iceQueue.get(peerId).push(candidate);
    }
  }

  sendTo(peerId, msg) {
    const ch = this._channels.get(peerId);
    if (ch?.readyState === 'open') { ch.send(JSON.stringify(msg)); return true; }
    return false;
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    this._channels.forEach(ch => { if (ch.readyState === 'open') ch.send(raw); });
  }

  closeAll() {
    this._hbTimers.forEach(clearInterval); this._hbTimers.clear();
    this._pcs.forEach(pc => pc.close());   this._pcs.clear();
    this._channels.clear(); this._lastSeen.clear(); this._iceQueue.clear();
  }

  /* ── Private ── */
  _newPC(peerId) {
    this._pcs.get(peerId)?.close();
    const pc = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
    this._pcs.set(peerId, pc);
    this._iceQueue.set(peerId, []);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) bus.emit(EVT._ICE, { peerId, candidate });
    };

    pc.ondatachannel = ({ channel }) => this._wireChannel(peerId, channel);

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      // PEER_CONNECTED is now handled by DataChannel onopen (no race condition)
      if (['disconnected','failed','closed'].includes(s)) {
        this._drop(peerId);
      }
    };
    return pc;
  }

  _wireChannel(peerId, ch) {
    ch.onopen = () => {
      this._channels.set(peerId, ch);
      // Emit PEER_CONNECTED here — channel is guaranteed open and in _channels
      bus.emit(EVT.PEER_CONNECTED, { peerId });
      this._startHB(peerId);
    };
    ch.onmessage = ({ data }) => { try { this._route(peerId, JSON.parse(data)); } catch(_){} };
    ch.onclose   = () => this._channels.delete(peerId);
  }

  _route(peerId, msg) {
    switch (msg.type) {
      case MSG.HB:         this.sendTo(peerId, { type: MSG.HB_ACK }); break;
      case MSG.HB_ACK:     this._lastSeen.set(peerId, Date.now()); break;
      case MSG.GAME_STATE: bus.emit(EVT.GAME_STATE_UPDATED, { from: peerId, state: msg.payload }); break;
      case MSG.ACTION:     bus.emit(EVT.ACTION_RECEIVED,    { from: peerId, action: msg.payload }); break;
    }
  }

  _startHB(peerId) {
    this._lastSeen.set(peerId, Date.now());
    const t = setInterval(() => {
      if (Date.now() - (this._lastSeen.get(peerId) || 0) > CONFIG.PEER_TIMEOUT) {
        this._drop(peerId); return;
      }
      this.sendTo(peerId, { type: MSG.HB });
    }, CONFIG.HEARTBEAT_INTERVAL);
    this._hbTimers.set(peerId, t);
  }

  _drop(peerId) {
    clearInterval(this._hbTimers.get(peerId)); this._hbTimers.delete(peerId);
    this._pcs.get(peerId)?.close();            this._pcs.delete(peerId);
    this._channels.delete(peerId);             this._lastSeen.delete(peerId);
    bus.emit(EVT.PEER_DISCONNECTED, { peerId });
  }

  async _flushICE(peerId, pc) {
    for (const c of (this._iceQueue.get(peerId) || []))
      try { await pc.addIceCandidate(c); } catch(_){}
    this._iceQueue.set(peerId, []);
  }
}

const webrtc = new WebRTCManager();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 6 ─ Signaling Communication Layer  (Firebase Realtime DB)
// ═══════════════════════════════════════════════════════════════════════

class SignalingLayer {
  constructor() { this._db = null; this._off = []; this._iceIdx = new Map(); }

  init() {
    if (!firebase.apps.length) firebase.initializeApp(CONFIG.FIREBASE);
    this._db = firebase.database();
  }

  ref(path) { return this._db.ref(path); }

  async createRoom(code, hostId, hostName) {
    await this.ref(`rooms/${code}/info`).set({ host: hostId, status: 'waiting', createdAt: Date.now() });
    await this._addPlayer(code, hostId, hostName);
  }

  async roomExists(code) { return (await this.ref(`rooms/${code}/info`).get()).exists(); }
  async getPlayers(code) { return (await this.ref(`rooms/${code}/players`).get()).val() || {}; }
  async getHostId (code) { return (await this.ref(`rooms/${code}/info/host`).get()).val(); }
  async setHostId (code, id) { await this.ref(`rooms/${code}/info/host`).set(id); }

  async joinRoom(code, pid, name) { await this._addPlayer(code, pid, name); }

  async removePlayer(code, pid) {
    await Promise.all([
      this.ref(`rooms/${code}/players/${pid}`).remove(),
      this.ref(`rooms/${code}/offers/${pid}`).remove(),
      this.ref(`rooms/${code}/answers/${pid}`).remove(),
      this.ref(`rooms/${code}/ice/${pid}`).remove(),
    ]);
  }

  watchPlayers(code, onJoin, onLeave) {
    const r = this.ref(`rooms/${code}/players`);
    const h1 = r.on('child_added',   s => onJoin(s.key, s.val()));
    const h2 = r.on('child_removed', s => onLeave(s.key));
    this._off.push(() => { r.off('child_added', h1); r.off('child_removed', h2); });
  }

  async pubOffer(code, to, from, sdp) {
    await this.ref(`rooms/${code}/offers/${to}/${from}`).set({ sdp, ts: Date.now() });
  }

  async pubAnswer(code, to, from, sdp) {
    await this.ref(`rooms/${code}/answers/${to}/${from}`).set({ sdp, ts: Date.now() });
  }

  watchOffers(code, myId, cb) {
    const r = this.ref(`rooms/${code}/offers/${myId}`);
    const h = r.on('child_added', s => { const { sdp } = s.val(); cb(s.key, sdp); s.ref.remove(); });
    this._off.push(() => r.off('child_added', h));
  }

  watchAnswers(code, myId, cb) {
    const r = this.ref(`rooms/${code}/answers/${myId}`);
    const h = r.on('child_added', s => { const { sdp } = s.val(); cb(s.key, sdp); s.ref.remove(); });
    this._off.push(() => r.off('child_added', h));
  }

  async pubICE(code, to, from, candidate) {
    const key = `${to}_${from}`;
    const idx = this._iceIdx.get(key) || 0;
    this._iceIdx.set(key, idx + 1);
    await this.ref(`rooms/${code}/ice/${to}/${from}/${idx}`).set({
      candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex,
    });
  }

  watchICE(code, myId, cb) {
    const r = this.ref(`rooms/${code}/ice/${myId}`);
    const h = r.on('child_added', snap => {
      const from = snap.key;
      const ri   = this.ref(`rooms/${code}/ice/${myId}/${from}`);
      ri.on('child_added', cs => {
        const d = cs.val();
        cb(from, { candidate: d.candidate, sdpMid: d.sdpMid, sdpMLineIndex: d.sdpMLineIndex });
        cs.ref.remove();
      });
    });
    this._off.push(() => r.off('child_added', h));
  }

  teardown() { this._off.forEach(fn => fn()); this._off = []; }

  /* private */
  async _addPlayer(code, pid, name) {
    await this.ref(`rooms/${code}/players/${pid}`).set({ name, joinedAt: Date.now() });
    this.ref(`rooms/${code}/players/${pid}`).onDisconnect().remove();
  }
}

const signaling = new SignalingLayer();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 7 ─ Room Management System
// ═══════════════════════════════════════════════════════════════════════

class RoomManager {

  async createRoom(playerName) {
    const myId     = Utils.genId();
    const roomCode = Utils.genRoomCode();
    store.set({ myId, myName: playerName, roomCode, isHost: true, hostId: myId });
    await signaling.createRoom(roomCode, myId, playerName);
    this._listen(roomCode, myId);
    bus.emit(EVT.ROOM_JOINED, { roomCode });
    return roomCode;
  }

  async joinRoom(rawCode, playerName) {
    const roomCode = rawCode.trim().toUpperCase();
    if (!(await signaling.roomExists(roomCode))) throw new Error('找不到此房間，請確認代碼是否正確');
    const existing = await signaling.getPlayers(roomCode);
    if (Object.keys(existing).length >= CONFIG.MAX_PLAYERS) throw new Error('房間已達人數上限');

    const myId   = Utils.genId();
    const hostId = await signaling.getHostId(roomCode);
    store.set({ myId, myName: playerName, roomCode, isHost: false, hostId });
    await signaling.joinRoom(roomCode, myId, playerName);
    this._listen(roomCode, myId);

    // Send offers to all current members
    for (const peerId of Object.keys(existing)) {
      try {
        const offer = await webrtc.createOffer(peerId);
        await signaling.pubOffer(roomCode, peerId, myId, offer.sdp);
      } catch(e) { console.warn('offer→', peerId, e); }
    }

    bus.emit(EVT.ROOM_JOINED, { roomCode });
    return roomCode;
  }

  /** Soft reset: keep WebRTC alive, just reset game state */
  returnToLobby() {
    store.replaceGame(makeGame());
    const { isHost } = store.get();
    if (isHost) gameEngine.broadcastState();
    bus.emit(EVT.RETURN_LOBBY);
  }

  /** Hard disconnect: close everything */
  async hardLeave() {
    const { roomCode, myId } = store.get();
    webrtc.closeAll();
    signaling.teardown();
    try { await signaling.removePlayer(roomCode, myId); } catch(_){}
    store.set({
      myId: null, myName: '', roomCode: '', isHost: false, hostId: null,
      players: {}, game: makeGame(),
    });
  }

  _listen(roomCode, myId) {
    // Incoming WebRTC offers
    signaling.watchOffers(roomCode, myId, async (fromId, sdp) => {
      try {
        const answer = await webrtc.handleOffer(fromId, sdp);
        await signaling.pubAnswer(roomCode, fromId, myId, answer.sdp);
      } catch(e) { console.warn('answer→', fromId, e); }
    });

    // Answers to our offers
    signaling.watchAnswers(roomCode, myId, async (fromId, sdp) => {
      try { await webrtc.handleAnswer(fromId, sdp); }
      catch(e) { console.warn('setAnswer from', fromId, e); }
    });

    // ICE candidates for us
    signaling.watchICE(roomCode, myId, async (fromId, c) => {
      try { await webrtc.addICE(fromId, c); } catch(_){}
    });

    // Publish our own ICE candidates
    bus.on(EVT._ICE, async ({ peerId, candidate }) => {
      try { await signaling.pubICE(roomCode, peerId, myId, candidate); } catch(_){}
    });

    // Player list changes
    signaling.watchPlayers(
      roomCode,
      (pid, data) => bus.emit(EVT.PLAYER_JOINED, { id: pid, name: data.name }),
      (pid)       => bus.emit(EVT.PLAYER_LEFT,   { id: pid }),
    );
  }
}

const roomManager = new RoomManager();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 8 ─ Player Synchronization System
// ═══════════════════════════════════════════════════════════════════════

class PlayerSync {
  constructor() {
    bus.on(EVT.PLAYER_JOINED,     d => this._onJoin(d));
    bus.on(EVT.PLAYER_LEFT,       d => this._onLeave(d));
    bus.on(EVT.PEER_CONNECTED,    d => this._onPeerUp(d));
    bus.on(EVT.PEER_DISCONNECTED, d => this._onPeerDown(d));
  }

  _onJoin({ id, name }) {
    const { players, myId, myName, hostId } = store.get();
    store.set({
      players: {
        ...players,
        [id]: { name: id === myId ? myName : name, status: 'connected', isHost: id === hostId },
      },
    });
    if (id !== myId) bus.emit(EVT.TOAST, { msg: `${name} 加入了房間`, type: 'info' });
  }

  _onLeave({ id }) {
    const { players, hostId } = store.get();
    const name = players[id]?.name || id;
    const upd  = { ...players };
    delete upd[id];
    store.set({ players: upd });
    bus.emit(EVT.TOAST, { msg: `${name} 離開了房間`, type: 'info' });

    // ── Bug-fix 1: Host migration ──────────────────────────
    if (id === hostId) this._electHost();
  }

  _onPeerUp({ peerId }) {
    const { players } = store.get();
    if (players[peerId])
      store.set({ players: { ...players, [peerId]: { ...players[peerId], status: 'connected' } } });
    if (store.get().isHost) setTimeout(() => gameEngine.broadcastState(), 600);
  }

  _onPeerDown({ peerId }) {
    const { players } = store.get();
    if (players[peerId])
      store.set({ players: { ...players, [peerId]: { ...players[peerId], status: 'disconnected' } } });
    if (store.get().isHost) storyRelay.checkAllLocked();
  }

  /**
   * Deterministic host election: sort remaining IDs alphabetically,
   * pick the first one. All peers compute the same result.
   */
  _electHost() {
    const { players, myId, roomCode } = store.get();
    const remaining = Object.keys(players).sort();
    if (!remaining.length) return;

    const newHostId     = remaining[0];
    const updatedPlayers = {};
    for (const [id, p] of Object.entries(players))
      updatedPlayers[id] = { ...p, isHost: id === newHostId };

    store.set({ hostId: newHostId, players: updatedPlayers });

    if (myId === newHostId) {
      store.set({ isHost: true });
      bus.emit(EVT.TOAST, { msg: '👑 你已成為新的主持人！', type: 'success' });
      try { signaling.ref(`rooms/${roomCode}/info/host`).set(newHostId); } catch(_){}

      const { game } = store.get();
      if (game.phase === PHASE.WRITING) {
        setTimeout(() => { storyRelay.checkAllLocked(); gameEngine.broadcastState(); }, 500);
      } else if (game.phase !== PHASE.WAITING) {
        setTimeout(() => gameEngine.broadcastState(), 500);
      }
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

    bus.on(EVT.GAME_STATE_UPDATED, ({ from, state }) => {
      // Bug-fix 4: only accept state from current host; ignore invalid states
      const { hostId } = store.get();
      if (from !== hostId) return;
      if (!state?.phase || state.phase === PHASE.WAITING) return;
      store.replaceGame(state);
    });

    bus.on(EVT.ACTION_RECEIVED, ({ from, action }) => {
      if (!store.get().isHost) return;
      switch (action.type) {
        case ACTION.LOCK:         storyRelay.handleLock(from, action.text); break;
        case ACTION.UNLOCK:       storyRelay.handleUnlock(from); break;
        case ACTION.REVEAL_NEXT:  storyRelay.revealNext(); break;
        case ACTION.RETURN_LOBBY: roomManager.returnToLobby(); break;
      }
    });
  }

  /**
   * Bug-fix 2: totalTurns = N × rounds so every player writes every story per round.
   */
  startGame(settings) {
    const { players } = store.get();
    const pids         = Object.keys(players);
    const N            = pids.length;
    const shuffled     = Utils.shuffle([...pids]);
    const stories      = shuffled.map(() => []);
    const assignments  = {};
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

  _startTimer(seconds) {
    this.stopTimer();
    let t = seconds;
    this._timer = setInterval(() => {
      t -= 1;
      store.patchGame({ timeLeft: t });
      this.broadcastState();
      if (t <= 0) { this.stopTimer(); storyRelay.advance(); }
    }, 1000);
  }

  stopTimer() { clearInterval(this._timer); this._timer = null; }

  broadcastState() {
    if (!store.get().isHost) return;
    webrtc.broadcast({ type: MSG.GAME_STATE, payload: store.get().game });
  }

  /** Dispatch an action: host processes locally, non-host sends to host via WebRTC. */
  sendAction(action) {
    const { isHost, myId, hostId } = store.get();
    if (isHost) {
      bus.emit(EVT.ACTION_RECEIVED, { from: myId, action });
    } else {
      if (!webrtc.sendTo(hostId, { type: MSG.ACTION, payload: action }))
        bus.emit(EVT.TOAST, { msg: '尚未連接到主持人，請稍候', type: 'error' });
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
    if (!text?.trim()) return;
    const { game } = store.get();
    store.patchGame({
      submissions: { ...game.submissions, [playerId]: text.trim() },
      locked     : { ...game.locked,      [playerId]: true },
    });
    gameEngine.broadcastState();
    this.checkAllLocked();
  }

  handleUnlock(playerId) {
    const { game } = store.get();
    const locked = { ...game.locked };
    delete locked[playerId];
    store.patchGame({ locked });
    gameEngine.broadcastState();
  }

  /** If all *in-game* connected players are locked, schedule advance. */
  checkAllLocked() {
    const { game, players } = store.get();
    if (game.phase !== PHASE.WRITING) return;

    // ← CRITICAL: only consider players who were part of this game (have an assignment)
    // Mid-game joiners have no assignment and must never block the advance.
    const active = Object.entries(players)
      .filter(([id, p]) => p.status !== 'disconnected' && id in (game.assignments || {}))
      .map(([id]) => id);

    if (active.length > 0 && active.every(pid => game.locked[pid])) {
      clearTimeout(this._advTimer);
      this._advTimer = setTimeout(() => this.advance(), 900);
    }
  }

  /** Advance one turn (host only). When all turns done, enter REVEALING. */
  advance() {
    gameEngine.stopTimer();
    const { game, players } = store.get();

    // Commit submissions into their assigned stories
    const stories = Utils.deepClone(game.stories);
    for (const [pid, text] of Object.entries(game.submissions)) {
      const idx = game.assignments[pid];
      if (idx !== undefined && text)
        stories[idx].push({ authorId: pid, authorName: players[pid]?.name || '???', text });
    }

    const nextTurn = game.currentTurn + 1;

    if (nextTurn > game.totalTurns) {
      store.patchGame({ phase: PHASE.REVEALING, stories, locked: {}, submissions: {}, reveal: { step: 0 } });
      gameEngine.broadcastState();
      return;
    }

    // Rotate assignments: each player moves to the next story cyclically
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
      submissions : {},
      timeLeft    : game.mode === 'time' ? game.turnTime : 0,
    });
    gameEngine.broadcastState();
    if (game.mode === 'time') gameEngine._startTimer(game.turnTime);
  }

  /** Bug-fix 5: host-controlled dramatic reveal, one segment at a time. */
  revealNext() {
    const { game } = store.get();
    if (game.phase !== PHASE.REVEALING) return;
    const maxSteps = Utils.maxRevealSteps(game.stories);
    const newStep  = Math.min((game.reveal?.step || 0) + 1, maxSteps);
    store.patchGame({ reveal: { step: newStep } });
    gameEngine.broadcastState();
    // Auto-transition to FINISHED after final reveal
    if (newStep >= maxSteps)
      setTimeout(() => { store.patchGame({ phase: PHASE.FINISHED }); gameEngine.broadcastState(); }, 1400);
  }

  /** Return the last segment of the story currently assigned to a player. */
  getContext(playerId) {
    const { game } = store.get();
    const idx   = game.assignments?.[playerId];
    if (idx === undefined) return null;
    const story = game.stories?.[idx];
    return story?.length ? story[story.length - 1] : null;
  }
}

const storyRelay = new StoryRelay();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 11 ─ UI Controller
// ═══════════════════════════════════════════════════════════════════════

class UIController {
  constructor() {
    this._screen     = 'home';
    this._toastTimer = null;
    this._lastTurn   = -1;
    this._prevPhase  = PHASE.WAITING;

    store.subscribe(s => this._sync(s));
    bus.on(EVT.TOAST,        d => this.toast(d.msg, d.type));
    bus.on(EVT.ROOM_JOINED,  ({ roomCode }) => { this._setText('display-room-code', roomCode); this.show('room'); });
    bus.on(EVT.RETURN_LOBBY, () => this.show('room'));

    // Non-host: navigate to game when host starts
    bus.on(EVT.GAME_STATE_UPDATED, ({ state }) => {
      if (!state?.phase) return;
      if (this._prevPhase === PHASE.WAITING && state.phase === PHASE.WRITING && this._screen === 'room')
        this.show('game');
      if (state.phase === PHASE.WAITING && this._screen === 'game')
        this.show('room');
      this._prevPhase = state.phase;
    });
  }

  /* ── Lifecycle ──────────────────────────────────────── */
  init() {
    this._bindHome();
    this._bindRoom();
    this._bindGame();
    this.show('home');
  }

  show(name) {
    document.querySelectorAll('.screen').forEach(el => { el.classList.add('hidden'); el.classList.remove('active'); });
    const el = document.getElementById(`screen-${name}`);
    if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
    this._screen = name;
  }

  toast(msg, type = 'info') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className   = `toast ${type}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.add('hidden'), 3400);
  }

  overlay(msg) {
    this._setText('overlay-msg', msg);
    document.getElementById('overlay')?.classList.remove('hidden');
  }

  hideOverlay() { document.getElementById('overlay')?.classList.add('hidden'); }

  /* ── Store sync ─────────────────────────────────────── */
  _sync(s) {
    if (this._screen === 'room') {
      this._renderPlayers(s.players, s.myId, s.hostId);
      this._renderRoomControls(s);
    }
    if (this._screen === 'game') {
      const { game } = s;
      // Bug-fix 4: never render for WAITING or missing phase
      if (!game?.phase || game.phase === PHASE.WAITING) return;
      this._renderGame(s);
    }
  }

  /* ── Room rendering ─────────────────────────────────── */
  _renderPlayers(players, myId, hostId) {
    const list = document.getElementById('players-list');
    const cnt  = document.getElementById('player-count');
    if (!list || !cnt) return;
    const n    = Object.keys(players).length;
    cnt.textContent = `${n} / ${CONFIG.MAX_PLAYERS}`;
    list.innerHTML  = Object.entries(players).map(([id, p]) => {
      const isMe   = id === myId;
      const isHost = id === hostId;
      const disc   = p.status === 'disconnected';
      return `
        <li class="player-item ${isHost ? 'is-host' : ''}">
          <div class="player-avatar" style="background:${Utils.avatarColor(p.name)}">${(p.name||'?')[0]}</div>
          <span class="player-name">${Utils.escapeHtml(p.name)}</span>
          <div class="player-badges">
            ${isHost ? `<span class="p-badge p-badge-host">👑 主持人</span>` : ''}
            ${isMe   ? `<span class="p-badge p-badge-you">你</span>`         : ''}
            <span class="p-badge ${disc ? 'p-badge-disc':'p-badge-conn'}">${disc?'離線':'在線'}</span>
          </div>
        </li>`;
    }).join('');
  }

  _renderRoomControls(s) {
    this._show('settings-panel', s.isHost);
    this._show('waiting-panel', !s.isHost);
    if (s.isHost) {
      const mode = s.settings?.mode || 'round';
      document.querySelectorAll('input[name="game-mode"]').forEach(r => { r.checked = r.value === mode; });
      this._show('time-setting', mode === 'time');
    }
  }

  /* ── Game rendering ─────────────────────────────────── */
  _renderGame(s) {
    const { game, players, myId, isHost } = s;

    // Phase panel visibility (null-safe)
    this._show('phase-writing',   game.phase === PHASE.WRITING);
    this._show('phase-revealing', game.phase === PHASE.REVEALING);
    this._show('phase-finished',  game.phase === PHASE.FINISHED);

    // Header
    this._renderHeader(game, players);

    // Content per phase
    if (game.phase === PHASE.WRITING)   this._renderWriting(game, myId);
    if (game.phase === PHASE.REVEALING) this._renderRevealing(game, players, isHost);
    if (game.phase === PHASE.FINISHED)  this._renderFinished(game);

    // Reset input when a new turn begins
    if (game.phase === PHASE.WRITING && game.currentTurn !== this._lastTurn) {
      this._lastTurn = game.currentTurn;
      const inp  = document.getElementById('story-input');
      if (inp) { inp.value = ''; inp.disabled = false; }
      this._setText('char-count', '0 / 500');
      this._show('btn-lock',       true);
      this._show('btn-unlock',     false);
      this._show('waiting-locked', false);
    }
  }

  _renderHeader(game, players) {
    const { turnsPerRound, currentTurn, totalRounds, mode, timeLeft, phase } = game;

    if (phase === PHASE.WRITING) {
      // Bug-fix 4: guard against zero/undefined
      if (!turnsPerRound || !currentTurn) return;
      const round       = Math.ceil(currentTurn / turnsPerRound);
      const turnWithin  = ((currentTurn - 1) % turnsPerRound) + 1;
      this._setText('game-round-label', `第 ${round} / ${totalRounds} 回合`);
      this._setText('game-turn-label',  `第 ${turnWithin} / ${turnsPerRound} 輪`);
      this._setBadge('game-phase-badge', '寫作中', 'writing');
      this._show('header-lock-info', true);
      // Only count players who are actually in the game (have an assignment)
      const inGame     = Object.keys(players).filter(id => id in (game.assignments || {}));
      const lockedInGame = inGame.filter(id => game.locked?.[id]);
      this._setText('lock-count', `已鎖定 ${lockedInGame.length} / ${inGame.length}`);

      // Timer
      const timerEl = document.getElementById('game-timer');
      if (timerEl) {
        if (mode === 'time') {
          timerEl.classList.remove('hidden');
          this._setText('timer-value', String(Math.max(0, timeLeft)));
          timerEl.classList.toggle('urgent', timeLeft <= 10);
        } else {
          timerEl.classList.add('hidden');
        }
      }

    } else if (phase === PHASE.REVEALING) {
      this._setText('game-round-label', '🎭 故事揭示時刻');
      this._setText('game-turn-label',  '');
      this._setBadge('game-phase-badge', '揭示中', 'revealing');
      const max  = Utils.maxRevealSteps(game.stories);
      const step = game.reveal?.step || 0;
      this._show('header-lock-info', true);
      this._setText('lock-count', `已揭示 ${step} / ${max} 段`);
      document.getElementById('game-timer')?.classList.add('hidden');

    } else if (phase === PHASE.FINISHED) {
      this._setText('game-round-label', '🎉 遊戲結束');
      this._setText('game-turn-label',  '');
      this._setBadge('game-phase-badge', '完結', 'finished');
      this._show('header-lock-info', false);
      document.getElementById('game-timer')?.classList.add('hidden');
    }
  }

  _renderWriting(game, myId) {
    const isSpectator = myId && !(myId in (game.assignments || {}));

    // Show spectator notice for mid-game joiners, hide writing UI
    this._show('spectator-notice', !!isSpectator);
    this._show('writing-area',     !isSpectator);

    if (isSpectator) return;   // nothing else to render for spectators

    const ctx       = storyRelay.getContext(myId);
    const ctxEl     = document.getElementById('story-context-text');
    const inp       = document.getElementById('story-input');
    const isLocked  = !!game.locked?.[myId];

    if (ctxEl) {
      if (ctx) {
        ctxEl.innerHTML = `<strong>${Utils.escapeHtml(ctx.authorName)}</strong> 寫道：\n\n${Utils.escapeHtml(ctx.text)}`;
        ctxEl.classList.add('has-content');
      } else {
        ctxEl.innerHTML = `<span class="context-placeholder">（故事的開端，由你來書寫！）</span>`;
        ctxEl.classList.remove('has-content');
      }
    }

    if (inp) inp.disabled = isLocked;
    this._show('btn-lock',       !isLocked);
    this._show('btn-unlock',      isLocked);
    this._show('waiting-locked',  isLocked);
  }

  /** Bug-fix 5: dramatic sequential reveal */
  _renderRevealing(game, players, isHost) {
    const step     = game.reveal?.step || 0;
    const stories  = game.stories  || [];
    const maxSteps = Utils.maxRevealSteps(stories);
    const isDone   = step >= maxSteps;

    // Progress bar
    const fill = document.getElementById('reveal-progress-fill');
    if (fill) fill.style.width = maxSteps ? `${(step / maxSteps) * 100}%` : '0%';

    // Subtitle
    if (!isDone) {
      const active = Utils.activeRevealStory(stories, step);
      this._setText('reveal-subtitle', step === 0 ? '主持人將逐段揭示眾人合力創作的故事' : `正在揭示故事 ${active + 1}…`);
    } else {
      this._setText('reveal-subtitle', '所有故事已完整揭示！');
    }

    // Buttons
    this._show('btn-reveal-next',      isHost && !isDone);
    this._show('reveal-watching-text', !isHost && !isDone);
    this._show('btn-reveal-done',      isDone);

    // Story cards
    const revealedPerStory = Utils.computeReveal(stories, step);
    const activeIdx        = isDone ? -1 : Utils.activeRevealStory(stories, step);
    const cont             = document.getElementById('reveal-stories-container');
    if (!cont) return;

    cont.innerHTML = stories.map((story, si) => {
      const revealed = revealedPerStory[si];
      const isActive = si === activeIdx;
      const isUnrev  = revealed.length === 0;

      const segsHtml = isUnrev
        ? `<div class="reveal-seg-empty">尚未揭示</div>`
        : revealed.map((seg, i) => {
            const isNew = i === revealed.length - 1 && isActive;
            return `
              <div class="reveal-seg ${isNew ? 'r-new' : ''}">
                <div class="reveal-seg-meta">第 ${i+1} 段 &nbsp;
                  <span class="reveal-seg-author">${Utils.escapeHtml(seg.authorName)}</span>
                </div>
                <div class="reveal-seg-text">${Utils.escapeHtml(seg.text)}</div>
              </div>`;
          }).join('');

      return `
        <div class="reveal-story-card ${isActive ? 'r-active' : ''} ${isUnrev ? 'r-unrevealed' : ''}">
          <div class="reveal-story-header">
            <span class="reveal-story-num">📖 故事 ${si+1}</span>
            <span class="reveal-seg-count">${revealed.length} / ${story.length} 段</span>
          </div>
          <div class="reveal-segs">${segsHtml}</div>
        </div>`;
    }).join('');
  }

  _renderFinished(game) {
    const cont = document.getElementById('final-stories');
    if (!cont) return;
    cont.innerHTML = game.stories.map((story, si) => {
      const segs = story.length === 0
        ? `<p style="color:var(--txt2);padding:16px 20px;font-style:italic">（這個故事沒有任何內容）</p>`
        : story.map((seg, i) => `
            <div class="story-seg">
              <div class="story-seg-meta">
                第 ${i+1} 段
                <span class="story-seg-rnd">回合 ${Math.ceil((i+1) / (game.turnsPerRound||1))}</span>
                ${Utils.escapeHtml(seg.authorName)}
              </div>
              <div class="story-seg-text">${Utils.escapeHtml(seg.text)}</div>
            </div>`).join('');
      return `
        <div class="story-card">
          <div class="story-card-header">📖 故事 ${si+1}</div>
          <div class="story-card-body">${segs}</div>
        </div>`;
    }).join('');
  }

  /* ── Bindings ────────────────────────────────────────── */
  _bindHome() {
    const go = async (join) => {
      const name = document.getElementById('input-name')?.value.trim() || '';
      if (!name) return this._err('home-error', '請先輸入暱稱');
      if (join) {
        const code = document.getElementById('input-room-code')?.value.trim() || '';
        if (!code) return this._err('home-error', '請輸入房間代碼');
        try { this.overlay('加入房間中…'); await roomManager.joinRoom(code, name); this.hideOverlay(); }
        catch(e) { this.hideOverlay(); this._err('home-error', `加入失敗：${e.message}`); }
      } else {
        try { this.overlay('建立房間中…'); await roomManager.createRoom(name); this.hideOverlay(); }
        catch(e) { this.hideOverlay(); this._err('home-error', `建立失敗：${e.message}`); }
      }
    };

    this._on('btn-create-room', 'click', () => go(false));
    this._on('btn-join-room',   'click', () => go(true));
    this._on('input-room-code', 'keydown', e => { if (e.key === 'Enter') go(true); });
    this._on('input-name',      'keydown', e => {
      if (e.key === 'Enter')
        document.getElementById('input-room-code')?.value.trim() ? go(true) : go(false);
    });
  }

  _bindRoom() {
    this._on('btn-copy-code', 'click', () => {
      const code = document.getElementById('display-room-code')?.textContent || '';
      navigator.clipboard?.writeText(code)
        .then(() => this.toast('房間代碼已複製！', 'success'))
        .catch(()  => this.toast(`代碼：${code}`, 'info'));
    });

    this._on('btn-leave-room', 'click', async () => {
      await roomManager.hardLeave();
      this.show('home');
    });

    this._on('btn-start-game', 'click', () => {
      const { players } = store.get();
      if (Object.keys(players).length < CONFIG.MIN_PLAYERS)
        return this._err('room-error', `至少需要 ${CONFIG.MIN_PLAYERS} 名玩家才能開始`);

      const mode     = document.querySelector('input[name="game-mode"]:checked')?.value || 'round';
      const rounds   = Utils.clamp(parseInt(document.getElementById('input-rounds')?.value    || 2),  1, 10);
      const turnTime = Utils.clamp(parseInt(document.getElementById('input-turn-time')?.value || 90), 15, 300);

      store.set({ settings: { mode, rounds, turnTime } });
      gameEngine.startGame({ mode, rounds, turnTime });
      this._prevPhase = PHASE.WAITING;
      this.show('game');
    });

    document.querySelectorAll('input[name="game-mode"]').forEach(r => {
      r.addEventListener('change', e => {
        store.set({ settings: { ...store.get().settings, mode: e.target.value } });
        this._show('time-setting', e.target.value === 'time');
      });
    });
  }

  _bindGame() {
    // Char counter + Enter-to-lock
    this._on('story-input', 'input', () => {
      const inp = document.getElementById('story-input');
      this._setText('char-count', `${inp?.value.length || 0} / 500`);
    });
    this._on('story-input', 'keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('btn-lock')?.click(); }
    });

    // Lock / Unlock
    this._on('btn-lock', 'click', () => {
      const text = document.getElementById('story-input')?.value.trim() || '';
      if (!text) return this.toast('請先輸入故事內容再鎖定', 'error');
      gameEngine.sendAction({ type: ACTION.LOCK, text });
    });
    this._on('btn-unlock', 'click', () => {
      gameEngine.sendAction({ type: ACTION.UNLOCK });
    });

    // Reveal controls
    this._on('btn-reveal-next', 'click', () => {
      gameEngine.sendAction({ type: ACTION.REVEAL_NEXT });
    });
    this._on('btn-reveal-done', 'click', () => {
      // Everyone can see finished state (host authoritative, others just navigate locally)
      if (store.get().isHost) {
        store.patchGame({ phase: PHASE.FINISHED });
        gameEngine.broadcastState();
      } else {
        store.patchGame({ phase: PHASE.FINISHED });
      }
    });

    // Bug-fix 3: return to lobby WITHOUT disconnecting
    this._on('btn-back-to-lobby', 'click', () => {
      roomManager.returnToLobby();
    });
  }

  /* ── Safe DOM helpers ────────────────────────────────── */

  /** getElementById + null-safe addEventListener */
  _on(id, ev, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
    else    console.warn(`[UI] Element not found: #${id}`);
  }

  /** Show/hide by id (null-safe) */
  _show(id, visible) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden', !visible);
  }

  /** Set textContent by id (null-safe) */
  _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  _setBadge(id, text, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className   = `phase-badge ${cls}`;
  }

  _err(elId, msg) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 5000);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// LAYER 12 ─ App Bootstrap
// ═══════════════════════════════════════════════════════════════════════

class App {
  constructor() { this._ui = new UIController(); }

  async init() {
    try {
      signaling.init();
    } catch(e) {
      console.error('Firebase init error:', e);
      return;
    }

    this._ui.init();

    window.addEventListener('beforeunload', () => {
      const { roomCode, myId } = store.get();
      if (roomCode && myId)
        try { signaling.ref(`rooms/${roomCode}/players/${myId}`).remove(); } catch(_){}
    });

    console.log('%c📖 故事接龍 已啟動', 'color:#c9a84c;font-weight:bold;font-size:14px');
  }
}

document.addEventListener('DOMContentLoaded', () => new App().init());
