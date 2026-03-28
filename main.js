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
  MAX_PLAYERS       : 16,
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

// ── Werewolf: Role Definitions ────────────────────────
const ROLES = {
  wolf    : { id:'wolf',     name:'狼人',   team:'wolf',    icon:'🐺', desc:'每晚與同伴共同選擇獵殺一名村民。' },
  wolfking: { id:'wolfking', name:'狼王',   team:'wolf',    icon:'👑', desc:'狼人陣營。若在白天被投票出局，可指定帶走一名玩家。' },
  villager: { id:'villager', name:'村民',   team:'village', icon:'👨‍🌾', desc:'找出並放逐所有狼人，村民陣營即獲勝。' },
  seer    : { id:'seer',     name:'預言家', team:'village', icon:'🔮', desc:'每晚可查驗一名玩家的陣營（好人或狼人）。' },
  witch   : { id:'witch',    name:'女巫',   team:'village', icon:'🧙', desc:'擁有解藥（救人）與毒藥（殺人）各一瓶，每局限用一次。' },
  hunter  : { id:'hunter',  name:'獵人',   team:'village', icon:'🏹', desc:'每晚鎖定一名目標（可更換）。獵人出局時，被鎖定的目標也一同死亡。' },
  knight  : { id:'knight',  name:'騎士',   team:'village', icon:'⚔️', desc:'白天可向任意玩家發起決鬥——若對方是狼人則對方死；若是好人則自己死。每局限一次。' },
  bomber  : { id:'bomber',  name:'炸彈客', team:'bomber',  icon:'💣', desc:'第三方！目標：在白天被全員票出局，可單獨獲勝。被票出局時，所有投你的人一起陣亡。' },
  cupid   : { id:'cupid',   name:'邱比特', team:'village', icon:'💘', desc:'第一個夜晚指定兩名玩家為情侶（可包含自己）。若其中一位情侶死亡，另一位立刻殉情。若情侶分屬不同陣營，邱比特與兩位情侶成為第三方，勝利條件變為讓其餘所有玩家出局。' },
};

const WW_ACTION = {
  WOLF_VOTE        : 'ww_wolf_vote',
  WOLF_CONFIRM     : 'ww_wolf_confirm',
  SEER_CHECK       : 'ww_seer_check',
  WITCH_SAVE       : 'ww_witch_save',
  WITCH_POISON     : 'ww_witch_poison',
  WITCH_PASS       : 'ww_witch_pass',
  HUNTER_SHOOT     : 'ww_hunter_shoot',
  HUNTER_CONFIRM   : 'ww_hunter_confirm',
  WOLFKING_SHOOT   : 'ww_wolfking_shoot',
  KNIGHT_REVEAL    : 'ww_knight_reveal',  // knight reveals self before challenging
  KNIGHT_CHALLENGE : 'ww_knight_challenge',
  WOLFKING_SECRET  : 'ww_wolfking_secret',// wolfking picks secret target after death
  CUPID_SELECT     : 'ww_cupid_select',   // cupid toggles a lover candidate
  CUPID_CONFIRM    : 'ww_cupid_confirm',  // cupid locks in the pair
  LOVER_ACK        : 'ww_lover_ack',      // lover dismisses the notification
  VOTE             : 'ww_vote',           // select/change candidate (unlocked)
  VOTE_LOCK        : 'ww_vote_lock',      // lock your current selection
  VOTE_UNLOCK      : 'ww_vote_unlock',    // unlock to re-select
  VOTE_ABSTAIN     : 'ww_vote_abstain',   // abstain (auto-locks)
  DISCUSS_READY    : 'ww_discuss_ready',
  HOST_FORCE_VOTE  : 'ww_host_force_vote',// host forces vote phase
  START_NIGHT      : 'ww_start_night',
  START_DISCUSS    : 'ww_start_discuss',
  WW_RETURN_LOBBY  : 'ww_return_lobby',
};

// Sentinel value for abstain votes
const VOTE_ABSTAIN_ID = '__abstain__';

// Which roles have active night tasks (must confirm before night ends)
const NIGHT_ACTIVE_ROLES = new Set(['wolf','wolfking','seer','witch','cupid']);

const EVT = {
  PLAYER_JOINED     : 'player:joined',
  PLAYER_LEFT       : 'player:left',
  PLAYER_CHANGED    : 'player:changed',
  GAME_STATE_UPDATED: 'game:state_updated',
  ACTION_RECEIVED   : 'action:received',
  ROOM_JOINED       : 'room:joined',
  SETTINGS_UPDATED  : 'room:settings_updated',
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

// ── Werewolf game state factory ───────────────────────
const makeWerewolfGame = () => ({
  gameType             : 'werewolf',
  wwPhase              : 'role_reveal',  // role_reveal|night|day_announce|day_discuss|vote|vote_result|special|end
  wwRound              : 0,
  nightTime            : 30,
  nightTimeLeft        : 30,
  roleConfig           : {},
  roles                : {},             // { pid: roleId }
  alive                : {},             // { pid: true }
  // ── Night simultaneous actions ──────────────────────────
  wolfVotes            : {},             // { pid: targetPid } wolves' current votes
  wolfTarget           : null,           // finalized kill target
  wolfConfirmed        : false,
  seerResults          : {},             // { pid: 'good'|'bad' } — persists for seer memory
  seerCheckedThisRound : null,           // pid checked this night
  witchSave            : false,
  witchPoison          : null,
  witchAntidoteUsed    : false,
  witchPoisonUsed      : false,
  witchDone            : false,
  hunterLock           : null,
  hunterDone           : false,
  hunterCanShoot       : false,           // hunter gained ability (killed by wolves or voted out)
  hunterShootCause     : null,            // 'wolf' | 'vote' — why they can shoot
  hunterShot           : false,           // hunter already used their shot
  nightConfirmed       : {},             // { pid: true } once each role-player confirms done
  // ── Day ─────────────────────────────────────────────────
  announcement         : { peaceful: true, died: [] },
  discussReady         : {},
  knightUsed           : false,
  knightRevealed       : false,           // knight must亮牌 before challenging
  knightChallengeLog   : null,            // { knightId, targetId, result: 'hit'|'miss', targetRole }
  wolfkingSecretTarget : null,            // wolfking's pending secret shot (applies next day)
  wolfkingSecretReady  : false,           // wolfking has selected their secret target
  votes                : {},
  voteLocked           : {},             // { pid: true } — player has committed their vote
  voteTime             : 60,             // seconds for vote phase (configurable)
  voteTimeLeft         : 60,             // countdown
  voteEliminated       : null,
  voteVoters           : [],
  specialPending       : null,
  winner               : null,
  winReason            : '',
  deathLog             : {},  // { pid: causeString }
  // ── Cupid / Lovers ──────────────────────────────────────
  cupidDone            : false,           // cupid has fired arrow (only round 1)
  cupidSelected        : [],              // cupid's pending selections (up to 2)
  lovers               : null,           // [pid1, pid2] once set
  loverTeam            : null,           // 'village'|'wolf'|'third'
  cupidId              : null,           // who plays cupid
  loverAcks            : {},             // { pid: true } — lover dismissed notification
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
  settings   : {
    gameType   : 'story',
    mode       : 'round',
    rounds     : CONFIG.DEFAULT_ROUNDS,
    turnTime   : CONFIG.DEFAULT_TURN_TIME,
    maxPlayers : 12,
    wwConfig   : { roles: { wolf:2, wolfking:0, seer:1, witch:1, hunter:1, knight:0, bomber:0, cupid:0 }, nightTime: 30, voteTime: 60 },
  },
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

  watchPlayers(code, onJoin, onLeave, onChanged) {
    const r  = this.ref('rooms/' + code + '/players');
    const h1 = r.on('child_added',   s => onJoin(s.key, s.val()));
    const h2 = r.on('child_removed', s => onLeave(s.key));
    const h3 = onChanged ? r.on('child_changed', s => onChanged(s.key, s.val())) : null;
    this._off.push(() => {
      r.off('child_added', h1);
      r.off('child_removed', h2);
      if (h3) r.off('child_changed', h3);
    });
  }

  updatePlayerSpectator(code, pid, isSpectator) {
    // Track write time to suppress echo in _onChanged
    if (typeof roomManager !== 'undefined') roomManager._specWriteTime = Date.now();
    return this.ref('rooms/' + code + '/players/' + pid + '/isSpectator')
      .set(!!isSpectator).catch(e => console.warn('[transport] spec:', e));
  }

  /**
   * Bug 1 fix: Re-register presence on Firebase reconnect.
   * Firebase onDisconnect fires on ANY websocket drop (network blip, screen lock, etc.).
   * When the connection resumes, Firebase re-connects but does NOT re-add the player
   * unless we explicitly do so. This handler catches reconnects and restores presence.
   */
  watchReconnect(code, pid, name, isSpectator) {
    const connRef  = this.ref('.info/connected');
    const h = connRef.on('value', snap => {
      if (!snap.val()) return;  // offline — wait
      // Re-set presence and re-register onDisconnect
      const pRef = this.ref('rooms/' + code + '/players/' + pid);
      pRef.set({ name, joinedAt: Date.now(), isSpectator: !!isSpectator });
      pRef.onDisconnect().remove();
    });
    this._off.push(() => connRef.off('value', h));
  }

  // ── Settings sync: host writes, non-hosts read live ───

  pushSettings(code, settings) {
    const safe = JSON.parse(JSON.stringify(settings));
    this.ref('rooms/' + code + '/settings').set(safe).catch(() => {});
  }

  watchSettings(code, cb) {
    const r = this.ref('rooms/' + code + '/settings');
    const h = r.on('value', snap => { if (snap.exists()) cb(snap.val()); });
    this._off.push(() => r.off('value', h));
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
  constructor() { this._specWriteTime = 0; }

  async createRoom(playerName) {
    const myId     = Utils.genId();
    const roomCode = Utils.genRoomCode();
    store.set({ myId, myName: playerName, roomCode, isHost: true, hostId: myId, isSpectator: false });
    await transport.createRoom(roomCode, myId, playerName);
    transport.watchReconnect(roomCode, myId, playerName, false);
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

    // Check room capacity using host's settings
    const settingsSnap = await transport.ref('rooms/' + roomCode + '/settings').get();
    const roomSettings = settingsSnap.val() || {};
    const roomMax      = roomSettings.maxPlayers || 12;
    if (Object.keys(existingPlayers).length >= roomMax)
      throw new Error('房間已達人數上限（' + roomMax + '人）');

    // Detect mid-game join → spectator
    const gameSnap    = await transport.ref('rooms/' + roomCode + '/game').get();
    const gd          = gameSnap.val();
    const wwStarted   = gd && gd.gameType === 'werewolf' && gd.wwPhase && gd.wwPhase !== 'role_reveal';
    const storyStarted = gd && gd.phase && gd.phase !== PHASE.WAITING;
    const isSpectator = !!(wwStarted || storyStarted);

    const myId = Utils.genId();
    store.set({ myId, myName: playerName, roomCode, isHost: false, hostId, isSpectator });
    await transport.addPlayer(roomCode, myId, playerName, isSpectator);
    transport.watchReconnect(roomCode, myId, playerName, isSpectator);
    this._listen(roomCode, myId, false);

    bus.emit(EVT.ROOM_JOINED, { roomCode, isSpectator });
    return { roomCode, isSpectator };
  }

  /** Soft reset — keep Firebase connection, just clear game state. */
  returnToLobby() {
    const { roomCode, myId, isHost } = store.get();
    const fresh = makeGame();
    store.replaceGame(fresh);
    store.set({ isSpectator: false });
    // Clear spectator flag in Firebase so player re-joins as active
    transport.updatePlayerSpectator(roomCode, myId, false);
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
      (pid, data) => bus.emit(EVT.PLAYER_JOINED,  { id: pid, name: data.name, isSpectator: !!data.isSpectator }),
      (pid)       => bus.emit(EVT.PLAYER_LEFT,    { id: pid }),
      (pid, data) => bus.emit(EVT.PLAYER_CHANGED, { id: pid, name: data.name, isSpectator: !!data.isSpectator }),
    );

    // Game state: non-hosts receive from Firebase; host is the source and ignores own writes
    transport.watchGameState(roomCode, game => {
      if (store.get().isHost) return;
      bus.emit(EVT.GAME_STATE_UPDATED, { state: game });
    });

    // Settings sync: non-hosts watch live settings from host
    if (!isHost) {
      transport.watchSettings(roomCode, settings => {
        bus.emit(EVT.SETTINGS_UPDATED, { settings });
      });
    }

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
    bus.on(EVT.PLAYER_JOINED,  d => this._onJoin(d));
    bus.on(EVT.PLAYER_LEFT,    d => this._onLeave(d));
    bus.on(EVT.PLAYER_CHANGED, d => this._onChanged(d));
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

  _onChanged({ id, name, isSpectator }) {
    const { players, myId } = store.get();
    const existing = players[id];
    if (!existing) return;
    const updated = Object.assign({}, players, {
      [id]: Object.assign({}, existing, { isSpectator: !!isSpectator }),
    });
    store.set({ players: updated });
    // Sync our own spectator flag — but skip if we just wrote it ourselves (suppress Firebase echo)
    if (id === myId && store.get().isSpectator !== !!isSpectator) {
      var writeTime = (roomManager && roomManager._specWriteTime) ? roomManager._specWriteTime : 0;
      if (Date.now() - writeTime > 2000) {
        store.set({ isSpectator: !!isSpectator });
      }
    }
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

    // ── Receive game state from host (non-host clients only) ──
    bus.on(EVT.GAME_STATE_UPDATED, ({ state }) => {
      if (!state) return;
      // Accept both story relay (has .phase) and werewolf (has .gameType)
      if (!state.phase && !state.gameType) return;
      store.replaceGame(state);
    });

    bus.on(EVT.ACTION_RECEIVED, ({ action }) => {
      if (!store.get().isHost) return;
      const pid = action.playerId;
      if (action.type === ACTION.LOCK)              storyRelay.handleLock(pid, action.text);
      else if (action.type === ACTION.UNLOCK)       storyRelay.handleUnlock(pid);
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
      if (t <= 0) { this.stopTimer(); setTimeout(() => storyRelay.advance(), 3000); }
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

    // Auto-lock any players who haven't submitted yet (time ran out)
    const assignments = game.assignments || {};
    const submissions = Object.assign({}, game.submissions);
    const locked      = Object.assign({}, game.locked);
    Object.keys(assignments).forEach(pid => {
      if (!locked[pid]) {
        // Get their textarea content if any (host only), else mark empty placeholder
        submissions[pid] = submissions[pid] || '（時間到，未輸入）';
        locked[pid] = true;
      }
    });

    for (const pid of Object.keys(assignments)) {
      const text = submissions[pid];
      const idx  = assignments[pid];
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
// LAYER 10b ─ Werewolf Game Engine  (simultaneous night actions)
// ═══════════════════════════════════════════════════════════════════════

class WerewolfEngine {
  constructor() {
    this._timer = null; this._voteTimer = null;
    bus.on(EVT.ACTION_RECEIVED, ({ action }) => {
      if (!store.get().isHost) return;
      if ((store.get().game || {}).gameType !== 'werewolf') return;
      this._dispatch(action);
    });
  }

  _dispatch(a) {
    const t = a.type, pid = a.playerId;
    if      (t === WW_ACTION.WOLF_VOTE)        this._wolfVote(pid, a.targetId);
    else if (t === WW_ACTION.WOLF_CONFIRM)     this._wolfConfirm(pid);
    else if (t === WW_ACTION.SEER_CHECK)       this._seerCheck(pid, a.targetId);
    else if (t === WW_ACTION.WITCH_SAVE)       this._witchSave(pid);
    else if (t === WW_ACTION.WITCH_POISON)     this._witchPoison(pid, a.targetId);
    else if (t === WW_ACTION.WITCH_PASS)       this._witchPass(pid);
    else if (t === WW_ACTION.HUNTER_SHOOT)     this._hunterShoot(pid, a.targetId);
    else if (t === WW_ACTION.WOLFKING_SHOOT)   this._wolfkingShoot(pid, a.targetId);
    else if (t === WW_ACTION.KNIGHT_REVEAL)    this._knightReveal(pid);
    else if (t === WW_ACTION.KNIGHT_CHALLENGE) this._knightChallenge(pid, a.targetId);
    else if (t === WW_ACTION.WOLFKING_SECRET)  this._wolfkingSecret(pid, a.targetId);
    else if (t === WW_ACTION.CUPID_SELECT)     this._cupidSelect(pid, a.targetId);
    else if (t === WW_ACTION.CUPID_CONFIRM)    this._cupidConfirm(pid);
    else if (t === WW_ACTION.LOVER_ACK)        this._loverAck(pid);
    else if (t === WW_ACTION.VOTE)             this._voteSelect(pid, a.targetId);
    else if (t === WW_ACTION.VOTE_LOCK)        this._voteLock(pid);
    else if (t === WW_ACTION.VOTE_UNLOCK)      this._voteUnlock(pid);
    else if (t === WW_ACTION.VOTE_ABSTAIN)     this._voteSelect(pid, VOTE_ABSTAIN_ID), this._voteLock(pid);
    else if (t === WW_ACTION.DISCUSS_READY)    this._discussReady(pid);
    else if (t === WW_ACTION.HOST_FORCE_VOTE)  this._hostForceVote();
    else if (t === WW_ACTION.START_NIGHT)      this._startNight();
    else if (t === WW_ACTION.START_DISCUSS)    this._startDiscuss();
    else if (t === WW_ACTION.WW_RETURN_LOBBY)  roomManager.returnToLobby();
  }

  // ── Game Start ────────────────────────────────────────

  startGame(cfg) {
    const { players } = store.get();
    // Only non-spectator players get roles
    const pids = Object.keys(players).filter(pid => !players[pid].isSpectator);
    const N    = pids.length;

    const deck = [];
    for (const [roleId, count] of Object.entries(cfg.roles))
      for (let i = 0; i < (count || 0); i++) deck.push(roleId);
    while (deck.length < N) deck.push('villager');

    const shuffledRoles = Utils.shuffle(deck.slice(0, N));
    const shuffledPids  = Utils.shuffle([...pids]);
    const roles = {}, alive = {};
    shuffledPids.forEach((pid, i) => { roles[pid] = shuffledRoles[i]; alive[pid] = true; });
    const cupidId = Object.keys(roles).find(id => roles[id] === 'cupid') || null;

    store.replaceGame(Object.assign(makeWerewolfGame(), {
      nightTime     : cfg.nightTime || 30,
      nightTimeLeft : cfg.nightTime || 30,
      voteTime      : cfg.voteTime  || 60,
      voteTimeLeft  : cfg.voteTime  || 60,
      roleConfig    : cfg.roles,
      roles, alive, cupidId,
    }));
    this.broadcast();
  }


  // ── Night (simultaneous) ──────────────────────────────
  // All role-players act at the same time. Night ends when every
  // active-role player confirms their action OR the timer expires.

  _startNight() {
    const g  = store.get().game;
    this.stopVoteTimer(); // Clear any lingering vote timer

    // Passive roles (villager/bomber/knight) now confirm manually via their button.
    // Only pre-confirm active roles that haven't checked in yet (none at start).
    const nightConfirmed = {};

    store.patchGame({
      wwPhase              : 'night',
      wwRound              : g.wwRound + 1,
      wolfVotes            : {},
      wolfTarget           : null,
      wolfConfirmed        : false,
      seerCheckedThisRound : null,
      witchSave            : false,
      witchPoison          : null,
      witchDone            : false,
      hunterDone           : false,
      // Don't reset hunterCanShoot/hunterShot — they persist across nights
      // Pre-confirm cupid on rounds > 1 (their action only applies round 1)
      nightConfirmed       : g.cupidDone ? { [g.cupidId]: true } : {},
      discussReady         : {},
      votes                : {},
      voteLocked           : {},
      voteEliminated       : null,
      nightTimeLeft        : g.nightTime,
    });
    this.broadcast();
    this._startNightTimer();
  }

  _startNightTimer() {
    this.stopTimer();
    const nt = store.get().game.nightTime;
    let t = nt;
    this._timer = setInterval(() => {
      t = Math.max(0, t - 1);
      store.patchGame({ nightTimeLeft: t });
      this.broadcast();
      if (t <= 0) { this.stopTimer(); this._resolveNight(); }
    }, 1000);
  }

  _tryEndNight() {
    const g = store.get().game;
    if (g.wwPhase !== 'night') return;
    const alivePids    = Object.keys(g.alive).filter(id => g.alive[id]);
    const needsAction  = alivePids.filter(pid => NIGHT_ACTIVE_ROLES.has(g.roles[pid]));
    if (needsAction.length > 0 && needsAction.every(pid => g.nightConfirmed[pid])) {
      this.stopTimer();
      this._resolveNight();
    }
  }

  _confirmPlayer(pid) {
    const confirmed = Object.assign({}, store.get().game.nightConfirmed, { [pid]: true });
    store.patchGame({ nightConfirmed: confirmed });
    this.broadcast();
    this._tryEndNight();
  }

  _nightDoneAck(pid) { this._confirmPlayer(pid); }

  // ── Wolf ──────────────────────────────────────────────

  _wolfVote(pid, targetId) {
    const g = store.get().game;
    if (g.wwPhase !== 'night') return;
    const r = g.roles[pid];
    if (r !== 'wolf' && r !== 'wolfking') return;
    if (!g.alive[targetId]) return;

    const wolfVotes = Object.assign({}, g.wolfVotes, { [pid]: targetId });
    store.patchGame({ wolfVotes });
    this.broadcast();

    // Auto-confirm when all alive wolves unanimously pick the same target
    const wolves = Object.keys(g.roles).filter(id => g.alive[id] && (g.roles[id] === 'wolf' || g.roles[id] === 'wolfking'));
    const unified = wolves.length > 0 && wolves.every(w => wolfVotes[w] === targetId);
    if (unified) this._finalizeWolfKill(targetId, wolves);
  }

  _wolfConfirm(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'night' || g.wolfConfirmed) return;
    if (g.roles[pid] !== 'wolf' && g.roles[pid] !== 'wolfking') return;
    if (!Object.keys(g.wolfVotes).length) return;

    const tally = {};
    Object.values(g.wolfVotes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
    const max    = Math.max(...Object.values(tally));
    const top    = Object.keys(tally).filter(t => tally[t] === max);
    const target = top[Math.floor(Math.random() * top.length)];
    const wolves = Object.keys(g.roles).filter(id => g.alive[id] && (g.roles[id] === 'wolf' || g.roles[id] === 'wolfking'));
    this._finalizeWolfKill(target, wolves);
  }

  _finalizeWolfKill(target, wolves) {
    const confirmed = Object.assign({}, store.get().game.nightConfirmed);
    wolves.forEach(w => { confirmed[w] = true; });
    store.patchGame({ wolfTarget: target, wolfConfirmed: true, nightConfirmed: confirmed });
    this.broadcast();
    this._tryEndNight();
  }

  // ── Seer ──────────────────────────────────────────────

  _seerCheck(pid, targetId) {
    const g = store.get().game;
    if (g.wwPhase !== 'night') return;
    if (g.roles[pid] !== 'seer' || !g.alive[pid]) return;
    if (!g.alive[targetId] || g.seerCheckedThisRound) return;

    const r       = g.roles[targetId];
    const result  = (r === 'wolf' || r === 'wolfking') ? 'bad' : 'good';
    const results = Object.assign({}, g.seerResults, { [targetId]: result });
    store.patchGame({ seerResults: results, seerCheckedThisRound: targetId });
    this._confirmPlayer(pid);
  }

  // ── Witch ─────────────────────────────────────────────

  _witchSave(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'night' || g.witchDone) return;
    if (g.roles[pid] !== 'witch' || g.witchAntidoteUsed || !g.wolfTarget) return;
    // Toggle: click again to undo
    store.patchGame({ witchSave: !g.witchSave });
    this.broadcast();
  }

  _witchPoison(pid, targetId) {
    const g = store.get().game;
    if (g.wwPhase !== 'night' || g.witchDone) return;
    if (g.roles[pid] !== 'witch' || g.witchPoisonUsed) return;
    if (targetId && !g.alive[targetId]) return;
    // Toggle same target to unselect; select different target to replace
    store.patchGame({ witchPoison: g.witchPoison === targetId ? null : targetId });
    this.broadcast();
  }

  _witchPass(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'night' || g.witchDone) return;
    if (g.roles[pid] !== 'witch') return;
    // Finalize — commit antidote/poison usage flags now
    store.patchGame({
      witchDone        : true,
      witchAntidoteUsed: g.witchSave ? true : g.witchAntidoteUsed,
      witchPoisonUsed  : g.witchPoison ? true : g.witchPoisonUsed,
    });
    this._confirmPlayer(pid);
  }

  // ── Hunter ────────────────────────────────────────────

  _hunterShoot(pid, targetId) {
    const g = store.get().game;
    if (g.wwPhase !== 'special') return;
    const sp = g.specialPending;
    if (!sp || sp.type !== 'hunter' || sp.pid !== pid) return;
    if (!g.alive[targetId]) return;
    const alive    = Object.assign({}, g.alive);
    const deathLog = Object.assign({}, g.deathLog);
    alive[targetId] = false;
    deathLog[targetId] = '被獵人亮牌擊殺';
    const cause = sp.cause || 'vote';
    this._propagateLoverDeath(alive, deathLog, store.get().game);
    store.patchGame({ alive, deathLog, hunterShot: true, specialPending: null });
    this.broadcast();
    if (!this._checkWin()) {
      if (cause === 'wolf') {
        // Hunter was wolf-killed during night → resume day flow after special
        setTimeout(() => this._startDiscuss(), 2500);
      } else {
        // Hunter was voted out → proceed to next night
        setTimeout(() => this._startNight(), 2500);
      }
    }
  }

  // ── Cupid ─────────────────────────────────────────────

  _cupidSelect(pid, targetId) {
    const g = store.get().game;
    if (g.wwPhase !== 'night') return;
    if (g.roles[pid] !== 'cupid' || g.cupidDone) return;
    let sel = (g.cupidSelected || []).slice();
    if (sel.includes(targetId)) {
      sel = sel.filter(id => id !== targetId); // deselect
    } else {
      if (sel.length < 2) sel.push(targetId);
    }
    store.patchGame({ cupidSelected: sel });
    this.broadcast();
  }

  _cupidConfirm(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'night') return;
    if (g.roles[pid] !== 'cupid' || g.cupidDone) return;
    const sel = g.cupidSelected || [];
    if (sel.length !== 2) return;
    const [p1, p2] = sel;
    // Determine loverTeam
    const isWolf = r => r === 'wolf' || r === 'wolfking';
    const p1Wolf = isWolf(g.roles[p1]);
    const p2Wolf = isWolf(g.roles[p2]);
    let loverTeam = 'village';
    if (p1Wolf && p2Wolf) loverTeam = 'wolf';
    else if (!p1Wolf && !p2Wolf) loverTeam = 'village';
    else loverTeam = 'third'; // mixed → third party
    store.patchGame({
      cupidDone: true, cupidId: pid, lovers: [p1, p2],
      loverTeam, loverAcks: {},
    });
    this.broadcast();
    this._confirmPlayer(pid);
  }

  _loverAck(pid) {
    const g = store.get().game;
    const lovers = g.lovers || [];
    if (!lovers.includes(pid)) return;
    const acks = Object.assign({}, g.loverAcks, { [pid]: true });
    store.patchGame({ loverAcks: acks });
    this.broadcast();
  }

  // Propagate lover death: if one lover died, immediately kill the other (no skills)
  // Returns updated { alive, deathLog } and also patches store if changes occurred
  _propagateLoverDeath(alive, deathLog, g) {
    const lovers = g.lovers;
    if (!lovers || lovers.length !== 2) return;
    const [l1, l2] = lovers;
    // Check if newly dead
    const l1Dead = !alive[l1];
    const l2Dead = !alive[l2];
    if (l1Dead && alive[l2]) {
      alive[l2] = false;
      deathLog[l2] = '殉情（情侶離去）';
    } else if (l2Dead && alive[l1]) {
      alive[l1] = false;
      deathLog[l1] = '殉情（情侶離去）';
    }
  }

  // ── Night Resolution ──────────────────────────────────

  _resolveNight() {
    const { game: g } = store.get();
    if (g.wwPhase !== 'night') return;

    const alive    = Object.assign({}, g.alive);
    const died     = [];
    const deathLog = Object.assign({}, g.deathLog);

    // Wolf kill
    if (g.wolfTarget && !g.witchSave) {
      alive[g.wolfTarget] = false;
      died.push(g.wolfTarget);
      deathLog[g.wolfTarget] = '被狼人獵殺';
    }
    // Witch poison
    if (g.witchPoison && alive[g.witchPoison]) {
      alive[g.witchPoison] = false;
      died.push(g.witchPoison);
      deathLog[g.witchPoison] = '被女巫毒殺';
    }
    // Wolfking secret shot
    if (g.wolfkingSecretReady && g.wolfkingSecretTarget && alive[g.wolfkingSecretTarget]) {
      alive[g.wolfkingSecretTarget] = false;
      died.push(g.wolfkingSecretTarget);
      deathLog[g.wolfkingSecretTarget] = '被狼王秘密帶走';
    }

    // Check if hunter was wolf-killed (not witch) → will trigger special after announce
    const hunterWolfKilled = g.wolfTarget && !g.witchSave && g.roles[g.wolfTarget] === 'hunter';

    // Lover propagation: if a lover died tonight, kill the other (殉情)
    // But if the killed-by-love player is a hunter, block their shoot ability
    this._propagateLoverDeath(alive, deathLog, g);
    // Rebuild died list from final alive state
    const finalDied = Object.keys(g.alive).filter(id => g.alive[id] && !alive[id]);

    store.patchGame({
      wwPhase: 'day_announce', alive, deathLog,
      announcement: { peaceful: finalDied.length === 0, died: finalDied },
      witchAntidoteUsed: g.witchSave   ? true : g.witchAntidoteUsed,
      witchPoisonUsed  : g.witchPoison ? true : g.witchPoisonUsed,
      wolfkingSecretTarget: null,
      wolfkingSecretReady : g.wolfkingSecretReady,
      ...(hunterWolfKilled ? { hunterCanShoot: true, hunterShootCause: 'wolf' } : {}),
    });
    this.broadcast();
    setTimeout(() => {
      if (this._checkWin()) return;
      if (hunterWolfKilled) {
        // Trigger public hunter special after win check
        const hunterPid = g.wolfTarget;
      store.patchGame({ wwPhase: 'special', specialPending: { type: 'hunter', pid: hunterPid, cause: 'wolf' } });
        this.broadcast();
      }
    }, 4000);
  }

  // ── Day ───────────────────────────────────────────────

  _startDiscuss() {
    store.patchGame({ wwPhase: 'day_discuss', discussReady: {}, votes: {}, voteLocked: {} });
    this.broadcast();
  }

  _discussReady(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'day_discuss' || !g.alive[pid]) return;
    const ready     = Object.assign({}, g.discussReady, { [pid]: true });
    const alivePids = Object.keys(g.alive).filter(id => g.alive[id]);
    store.patchGame({ discussReady: ready });
    this.broadcast();
    // All alive players confirmed → move to vote automatically
    if (alivePids.every(id => ready[id])) {
      this._startVote();
    }
  }

  _hostForceVote() {
    const g = store.get().game;
    if (g.wwPhase !== 'day_discuss') return;
    this._startVote();
  }

  _startVote() {
    const g = store.get().game;
    const voteTime = g.voteTime || 60;
    store.patchGame({ wwPhase: 'vote', votes: {}, voteLocked: {}, voteTimeLeft: voteTime });
    this.broadcast();
    this._startVoteTimer();
  }

  _startVoteTimer() {
    this.stopVoteTimer();
    let t = store.get().game.voteTimeLeft || 60;
    this._voteTimer = setInterval(() => {
      t = Math.max(0, t - 1);
      store.patchGame({ voteTimeLeft: t });
      this.broadcast();
      if (t <= 0) {
        this.stopVoteTimer();
        // Auto-lock: use current selection if player had one, otherwise abstain
        const g = store.get().game;
        const alivePids = Object.keys(g.alive).filter(id => g.alive[id]);
        const votes     = Object.assign({}, g.votes);
        const voteLocked = Object.assign({}, g.voteLocked);
        alivePids.forEach(pid => {
          if (!voteLocked[pid]) {
            // If player had a selection, lock it; otherwise abstain
            if (!votes[pid]) votes[pid] = VOTE_ABSTAIN_ID;
            voteLocked[pid] = true;
          }
        });
        store.patchGame({ votes, voteLocked });
        this.broadcast();
        this._resolveVote();
      }
    }, 1000);
  }

  stopVoteTimer() { clearInterval(this._voteTimer); this._voteTimer = null; }

  _knightReveal(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'day_discuss' || !g.alive[pid]) return;
    if (g.roles[pid] !== 'knight' || g.knightUsed || g.knightRevealed) return;
    store.patchGame({ knightRevealed: true });
    this.broadcast();
  }

  _knightChallenge(pid, targetId) {
    const g = store.get().game;
    if (g.wwPhase !== 'day_discuss' || !g.alive[pid] || !g.alive[targetId]) return;
    if (g.roles[pid] !== 'knight' || g.knightUsed) return;
    if (!g.knightRevealed) return; // must reveal first

    const targetRole = g.roles[targetId];
    const isWolf     = targetRole === 'wolf' || targetRole === 'wolfking';
    const alive      = Object.assign({}, g.alive);
    const deathLog   = Object.assign({}, g.deathLog);
    const challengeLog = { knightId: pid, targetId, result: isWolf ? 'hit' : 'miss', targetRole };

    if (isWolf) {
      alive[targetId] = false;
      deathLog[targetId] = '被騎士決鬥擊殺';
      if (targetRole === 'wolfking') {
        this._propagateLoverDeath(alive, deathLog, g);
        store.patchGame({
          alive, knightUsed: true, deathLog, knightChallengeLog: challengeLog,
          wolfkingSecretReady: true,
          wolfkingSecretTarget: null,
        });
        this.broadcast();
        this._checkWin();
        return;
      }
    } else {
      alive[pid] = false;
      deathLog[pid] = '騎士決鬥失敗出局';
    }
    this._propagateLoverDeath(alive, deathLog, g);
    store.patchGame({ alive, knightUsed: true, deathLog, knightChallengeLog: challengeLog });
    this.broadcast();
    this._checkWin();
  }

  // ── Vote (lock-based) ─────────────────────────────────

  _voteSelect(pid, targetId) {
    const g = store.get().game;
    if (g.wwPhase !== 'vote' || !g.alive[pid]) return;
    if ((g.voteLocked || {})[pid]) return;  // already locked — can't change
    if (targetId !== VOTE_ABSTAIN_ID && (!g.alive[targetId] || pid === targetId)) return;
    // Click same target again → deselect (set to null)
    const currentVote = (g.votes || {})[pid];
    if (currentVote === targetId) {
      const votes = Object.assign({}, g.votes);
      delete votes[pid];
      store.patchGame({ votes });
    } else {
      store.patchGame({ votes: Object.assign({}, g.votes, { [pid]: targetId }) });
    }
    this.broadcast();
  }

  _voteLock(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'vote' || !g.alive[pid]) return;
    if (!(g.votes || {})[pid]) return;  // must have selected first
    const voteLocked = Object.assign({}, g.voteLocked, { [pid]: true });
    store.patchGame({ voteLocked });
    this.broadcast();
    // Check if everyone has locked
    const alivePids = Object.keys(g.alive).filter(id => g.alive[id]);
    if (alivePids.every(id => voteLocked[id])) {
      this.stopVoteTimer();
      this._resolveVote();
    }
  }

  _voteUnlock(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'vote' || !g.alive[pid]) return;
    const voteLocked = Object.assign({}, g.voteLocked);
    delete voteLocked[pid];
    store.patchGame({ voteLocked });
    this.broadcast();
  }

  _resolveVote() {
    const g        = store.get().game;
    const allVotes = g.votes || {};
    // Tally only real votes (not abstain)
    const tally = {};
    Object.entries(allVotes).forEach(([voter, t]) => {
      if (t !== VOTE_ABSTAIN_ID) tally[t] = (tally[t] || 0) + 1;
    });
    const abstainCount = Object.values(allVotes).filter(v => v === VOTE_ABSTAIN_ID).length;

    // No real votes → no elimination (all abstained or empty)
    if (!Object.keys(tally).length) {
      store.patchGame({ wwPhase: 'vote_result', voteEliminated: null, voteVoters: [], abstainCount });
      this.broadcast();
      setTimeout(() => this._startNight(), 3500); return;
    }

    const max = Math.max(...Object.values(tally));
    const top = Object.keys(tally).filter(t => tally[t] === max);

    if (top.length > 1) {
      store.patchGame({ wwPhase: 'vote_result', voteEliminated: null, voteVoters: [], abstainCount });
      this.broadcast();
      setTimeout(() => this._startNight(), 3500); return;
    }

    const eliminated  = top[0];
    const role        = g.roles[eliminated];
    const alive       = Object.assign({}, g.alive);
    const alivePids   = Object.keys(g.alive).filter(id => g.alive[id]);
    const voters      = Object.keys(allVotes).filter(id => allVotes[id] === eliminated);
    const deathLog    = Object.assign({}, g.deathLog);
    // "All voted bomber" = every OTHER alive player voted for bomber.
    // Bomber cannot vote for themselves, so their own vote (abstain/other) must NOT disqualify this.
    const eligibleVoterCount = alivePids.filter(id => id !== eliminated).length;
    const allVotedBomber = (role === 'bomber') && (voters.length === eligibleVoterCount);

    if (role === 'bomber') {
      if (allVotedBomber) {
        alive[eliminated] = false;
        deathLog[eliminated] = '全票放逐，炸彈客獨勝！';
        store.patchGame({ alive, deathLog, wwPhase: 'end', winner: 'bomber', winReason: '全員票選炸彈客，炸彈客單獨獲勝！💣', voteEliminated: eliminated, voteVoters: voters, abstainCount });
        this.broadcast(); return;
      }
      alive[eliminated] = false;
      deathLog[eliminated] = '被投票放逐（炸彈客引爆）';
      voters.forEach(vid => { alive[vid] = false; deathLog[vid] = '炸彈客引爆連帶陣亡'; });
      this._propagateLoverDeath(alive, deathLog, store.get().game);
      store.patchGame({ alive, deathLog, wwPhase: 'vote_result', voteEliminated: eliminated, voteVoters: voters, abstainCount });
      this.broadcast();
      setTimeout(() => { if (!this._checkWin()) setTimeout(() => this._startNight(), 2000); }, 3500);
      return;
    }

    alive[eliminated] = false;
    deathLog[eliminated] = '被投票放逐';
    // Hunter killed by vote → skip lover propagation (hunter gets special phase instead)
    if (role !== 'hunter') this._propagateLoverDeath(alive, deathLog, store.get().game);

    store.patchGame({ alive, deathLog, wwPhase: 'vote_result', voteEliminated: eliminated, voteVoters: voters, abstainCount });
    this.broadcast();
    setTimeout(() => {
      if (this._checkWin()) return;
      if (role === 'hunter') {
        // Hunter voted out → public special phase for everyone to watch
        store.patchGame({
          wwPhase: 'special',
          specialPending: { type: 'hunter', pid: eliminated, cause: 'vote' },
          hunterCanShoot: true, hunterShootCause: 'vote',
        });
        this.broadcast();
      } else {
        this._startNight();
      }
    }, 3500);
  }

  // ── WolfKing posthumous ───────────────────────────────

  _wolfkingSecret(pid, targetId) {
    const g = store.get().game;
    // wolfking can pick secret target whenever they're dead and haven't chosen yet
    if ((g.roles || {})[pid] !== 'wolfking') return;
    if ((g.alive || {})[pid]) return;          // must be dead
    if (g.wolfkingSecretReady) return;          // already chosen
    if (!g.alive[targetId]) return;
    store.patchGame({ wolfkingSecretTarget: targetId, wolfkingSecretReady: true });
    this.broadcast();
  }

  _wolfkingShoot(pid, targetId) {
    const g = store.get().game;
    if (g.wwPhase !== 'special') return;
    const sp = g.specialPending;
    if (!sp || sp.type !== 'wolfking' || sp.pid !== pid || !g.alive[targetId]) return;
    const alive    = Object.assign({}, g.alive);
    const deathLog = Object.assign({}, g.deathLog);
    alive[targetId] = false;
    deathLog[targetId] = '被狼王帶走';
    this._propagateLoverDeath(alive, deathLog, g);
    store.patchGame({ alive, deathLog, specialPending: null }); this.broadcast();
    if (!this._checkWin()) setTimeout(() => this._startNight(), 2500);
  }

  // ── Win ───────────────────────────────────────────────

  _checkWin() {
    const { game: g } = store.get();
    const alivePids = Object.keys(g.alive).filter(id => g.alive[id]);
    const roles     = g.roles || {};
    const lovers    = Array.isArray(g.lovers) ? g.lovers : [];
    const loverTeam = g.loverTeam;   // 'village' | 'wolf' | 'third' | null
    const cupidId   = g.cupidId;

    const isWolf = id => roles[id] === 'wolf' || roles[id] === 'wolfking';
    const aliveWolves = alivePids.filter(isWolf);

    // Are both lovers still alive? (crucial gatekeeper)
    const loversAlive = lovers.length === 2 && lovers.every(id => alivePids.includes(id));

    const _win = (winner, winReason) => {
      store.patchGame({ wwPhase: 'end', winner, winReason });
      this.broadcast(); return true;
    };

    // ══════════════════════════════════════════════════════
    // CASE A: MIXED LOVERS (一狼一村 → 第三方)
    // Priority: HIGHEST — lovers alive blocks all other wins
    // ══════════════════════════════════════════════════════
    if (loverTeam === 'third') {
      const thirdIds       = [...new Set([cupidId, ...lovers].filter(Boolean))];
      const aliveThird     = alivePids.filter(id =>  thirdIds.includes(id));
      const aliveNonThird  = alivePids.filter(id => !thirdIds.includes(id));

      // 第三方勝: 所有非第三方玩家均已出局
      if (aliveNonThird.length === 0 && aliveThird.length > 0)
        return _win('lovers', '情侶完成屠城！第三方陣營獲勝！💘');

      // 兩人都還活著 → 阻斷所有其他勝利條件
      if (loversAlive) return false;

      // 情侶均已死亡（殉情），恢復正常勝利判斷
      // 注意：狼人情侶已死，aliveWolves 只包含剩餘的「純狼」
      const aliveNonThirdWolves = alivePids.filter(id => isWolf(id) && !thirdIds.includes(id));
      const aliveNonThirdVill   = alivePids.filter(id => !isWolf(id)  && !thirdIds.includes(id));
      if (aliveNonThirdWolves.length === 0)
        return _win('village', '所有狼人已消滅！村民陣營獲勝！🌅');
      if (aliveNonThirdWolves.length >= aliveNonThirdVill.length)
        return _win('wolves', '狼人數量已不少於其他存活玩家！狼人陣營獲勝！🐺');
      return false;
    }

    // ══════════════════════════════════════════════════════
    // CASE B: WOLF-WOLF LOVERS (兩狼情侶)
    // ══════════════════════════════════════════════════════
    if (loverTeam === 'wolf') {
      // 場上有第三隻狼（非情侶）→ 正常狼人勝利條件
      const extraWolvesAlive = aliveWolves.filter(id => !lovers.includes(id));
      if (extraWolvesAlive.length > 0) {
        // 正常判定（有額外狼助陣）
        if (aliveWolves.length === 0)
          return _win('village', '所有狼人已消滅！村民陣營獲勝！🌅');
        const aliveNonWolf = alivePids.filter(id => !isWolf(id));
        if (aliveWolves.length >= aliveNonWolf.length)
          return _win('wolves', '狼人數量已不少於其他存活玩家！狼人陣營獲勝！🐺');
        return false;
      }

      // 沒有第三隻狼 → 情侶需要屠城才能勝利
      if (loversAlive) {
        // 情侶還活著：非情侶存活人數 ≤ 1 才算屠城
        const aliveNonLover = alivePids.filter(id => !lovers.includes(id));
        if (aliveNonLover.length <= 1)
          return _win('lovers', '狼人情侶完成屠城！情侶陣營獲勝！💘');
        // 情侶還活著但非情侶 ≥ 2 → 阻斷普通狼人勝利（情侶優先）
        return false;
      }

      // 兩狼情侶均已死亡 → 恢復正常判定
      if (aliveWolves.length === 0)
        return _win('village', '所有狼人已消滅！村民陣營獲勝！🌅');
      const aliveNonWolf = alivePids.filter(id => !isWolf(id));
      if (aliveWolves.length >= aliveNonWolf.length)
        return _win('wolves', '狼人數量已不少於其他存活玩家！狼人陣營獲勝！🐺');
      return false;
    }

    // ══════════════════════════════════════════════════════
    // CASE C: 無情侶 / 兩村情侶 → 正常勝利判定
    // ══════════════════════════════════════════════════════
    if (aliveWolves.length === 0)
      return _win('village', '所有狼人已被消滅！村民陣營獲勝！🌅');
    const aliveNonWolf = alivePids.filter(id => !isWolf(id));
    if (aliveWolves.length >= aliveNonWolf.length)
      return _win('wolves', '狼人數量已不少於其他存活玩家！狼人陣營獲勝！🐺');
    return false;
  }

  // ── Helpers ───────────────────────────────────────────

  sendAction(action) {
    const { isHost, myId, roomCode } = store.get();
    if (isHost) bus.emit(EVT.ACTION_RECEIVED, { action: Object.assign({}, action, { playerId: myId }) });
    else transport.pushAction(roomCode, Object.assign({}, action, { playerId: myId }));
  }

  broadcast() {
    const { isHost, game, roomCode } = store.get();
    if (!isHost) return;
    transport.pushGameState(roomCode, game);
  }

  stopTimer() { clearInterval(this._timer); this._timer = null; }
}

const wwEngine = new WerewolfEngine();

// ═══════════════════════════════════════════════════════════════════════
// LAYER 11 ─ UI Controller
// ═══════════════════════════════════════════════════════════════════════

class UIController {
  constructor() {
    this._screen    = 'home';
    this._toastTmr  = null;
    this._lastTurn  = -1;
    this._prevPhase = PHASE.WAITING;
    this._specRevealed  = new Set(); // tracks which PIDs have their role revealed in spectator view
    this._autoLockTurn  = -1;       // tracks which turn we auto-submitted for (story relay)

    store.subscribe(s => this._sync(s));
    bus.on(EVT.TOAST,       d  => this.toast(d.msg, d.type));
    bus.on(EVT.RETURN_LOBBY, () => this.show('room'));

    bus.on(EVT.ROOM_JOINED, ({ roomCode }) => {
      this._setText('display-room-code', roomCode);
      this.show('room');
    });

    bus.on(EVT.SETTINGS_UPDATED, ({ settings }) => {
      if (store.get().isHost) return;  // host never overwrites their own settings
      store.set({ settings });
      if (this._screen === 'room') this._renderRoomControls(store.get());
    });

    bus.on(EVT.GAME_STATE_UPDATED, ({ state }) => {
      if (!state) return;

      if (state.gameType === 'werewolf') {
        // Navigate if needed, then always render WW with the incoming state
        if (this._screen !== 'ww-game') {
          // Switch screen first (does a _sync but store may not have new state yet)
          document.querySelectorAll('.screen').forEach(el => {
            el.classList.add('hidden'); el.classList.remove('active');
          });
          const el = document.getElementById('screen-ww-game');
          if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
          this._screen = 'ww-game';
        }
        // Always render with the INCOMING state (most up-to-date)
        this._renderWW(Object.assign({}, store.get(), { game: state }));
        return;
      }

      // WW game ended / returned to lobby — clear spectator flag for this client
      if (this._screen === 'ww-game') {
        const { myId, roomCode, isSpectator: wasSpec } = store.get();
        if (wasSpec) {
          store.set({ isSpectator: false });
          transport.updatePlayerSpectator(roomCode, myId, false);
        }
        this.show('room'); return;
      }

      // Story relay navigation
      if (!state.phase) return;
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
    this._bindWWGame();
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
    if (this._screen === 'ww-game') {
      const g = s.game;
      if (!g || g.gameType !== 'werewolf') return;
      // Only host-side updates come through _sync; non-host updates come through GAME_STATE_UPDATED
      if (s.isHost) this._renderWW(s);
    }
  }

  // ── Room rendering ────────────────────────────────────

  _renderPlayers(players, myId, hostId) {
    const { settings, isSpectator } = store.get();
    const maxP = (settings || {}).maxPlayers || 12;
    const cnt  = document.getElementById('player-count');
    const lst  = document.getElementById('players-list');
    if (!cnt || !lst) return;
    const n = Object.keys(players).length;
    cnt.textContent = n + ' / ' + maxP;
    lst.innerHTML = Object.entries(players).map(function([id, p]) {
      const isHost = id === hostId;
      const isMe   = id === myId;
      return '<li class="player-item ' + (isHost ? 'is-host' : '') + (p.isSpectator ? ' is-spectator' : '') + '">' +
        '<div class="player-avatar" style="background:' + Utils.avatarColor(p.name) + '">' + (p.name || '?')[0] + '</div>' +
        '<span class="player-name">' + Utils.escapeHtml(p.name) + '</span>' +
        '<div class="player-badges">' +
          (isHost ? '<span class="p-badge p-badge-host">👑 主持人</span>' : '') +
          (isMe   ? '<span class="p-badge p-badge-you">你</span>' : '') +
          (p.isSpectator ? '<span class="p-badge p-badge-spec">👁 觀戰</span>' : '') +
          (!p.isSpectator ? '<span class="p-badge p-badge-conn">在線</span>' : '') +
        '</div></li>';
    }).join('');

    // Spectator toggle button: shows enter/exit based on current state
    const toggleBtn = document.getElementById('btn-toggle-spectator');
    if (toggleBtn) {
      if (isSpectator) {
        toggleBtn.textContent = '🎮 退出觀戰模式';
        toggleBtn.className   = 'btn btn-secondary btn-sm btn-full spec-toggle-btn';
        toggleBtn.disabled    = false;
      } else {
        toggleBtn.textContent = '👁 進入觀戰模式';
        toggleBtn.className   = 'btn btn-ghost btn-sm btn-full spec-toggle-btn';
        toggleBtn.disabled    = false;
      }
    }
  }

  _renderRoomControls(s) {
    // Host in spectator mode: settings panel stays visible but shows exit bar
    // Non-host in spectator mode: show spectator lobby panel
    // Non-host normal: show waiting panel
    this._show('settings-panel',        s.isHost);
    this._show('host-spec-exit-bar',    !!(s.isHost && s.isSpectator));
    this._show('waiting-panel',         !s.isHost && !s.isSpectator);
    this._show('spectator-lobby-panel', !s.isHost && !!s.isSpectator);

    // Sync max-players select (host only)
    if (s.isHost) {
      var mpSel = document.getElementById('select-max-players');
      if (mpSel) mpSel.value = String((s.settings || {}).maxPlayers || 12);
    }

    if (s.isHost) {
      const gameType = (s.settings || {}).gameType || 'story';
      const mode     = (s.settings || {}).mode || 'round';

      document.querySelectorAll('.game-type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === gameType);
      });

      this._show('story-settings', gameType === 'story');
      this._show('ww-settings',    gameType === 'werewolf');

      if (gameType === 'story') {
        document.querySelectorAll('input[name="game-mode"]').forEach(r => { r.checked = r.value === mode; });
        this._show('time-setting', mode === 'time');
      }
      if (gameType === 'werewolf') {
        const wwCfg = (s.settings || {}).wwConfig || {};
        const roles = wwCfg.roles || {};
        Object.keys(ROLES).forEach(rid => {
          const el = document.getElementById('ww-count-' + rid);
          if (el) el.textContent = roles[rid] || 0;
        });
        const nte = document.getElementById('ww-night-time');
        if (nte) nte.value = wwCfg.nightTime || 30;
      }
    } else if (s.isSpectator) {
      this._renderSpectatorLobby(s.settings || {});
    } else {
      this._renderSettingsPreview(s.settings || {});
    }
  }

  _renderSpectatorLobby(settings) {
    var cont = document.getElementById('spectator-lobby-content');
    if (!cont) return;
    var gameType = settings.gameType || 'story';
    var lines = '';
    if (gameType === 'story') {
      var mode = settings.mode || 'round';
      var rounds = settings.rounds || 2;
      lines = '<div class="spec-lobby-row"><span>📖 故事接龍</span></div>' +
        '<div class="spec-lobby-row"><span class="slr-label">計時方式</span><span>' + (mode==='time'?'計時制':'回合制') + '</span></div>' +
        '<div class="spec-lobby-row"><span class="slr-label">回合數</span><span>' + rounds + ' 回合</span></div>';
    } else {
      var wwCfg = settings.wwConfig || {};
      var roles = wwCfg.roles || {};
      var roleLines = Object.entries(ROLES).filter(([rid]) => (roles[rid]||0)>0)
        .map(([rid,def]) => def.icon+' '+def.name+' ×'+roles[rid]).join('、');
      lines = '<div class="spec-lobby-row"><span>🐺 狼人殺</span></div>' +
        '<div class="spec-lobby-row"><span class="slr-label">夜晚時限</span><span>' + (wwCfg.nightTime||30) + ' 秒</span></div>' +
        '<div class="spec-lobby-row spec-lobby-roles"><span class="slr-label">職業配置</span><span>' + (roleLines||'未設定') + '</span></div>';
    }
    cont.innerHTML = lines;
  }

  _renderSettingsPreview(settings) {
    const gameType = settings.gameType || 'story';
    const cont     = document.getElementById('settings-preview');
    if (!cont) return;

    if (gameType === 'story') {
      const mode = settings.mode || 'round';
      const rounds = settings.rounds || 2;
      const turnTime = settings.turnTime || 90;
      cont.innerHTML =
        '<div class="preview-row"><span class="preview-label">遊戲模式</span><span class="preview-val">📖 故事接龍</span></div>' +
        '<div class="preview-row"><span class="preview-label">計時方式</span><span class="preview-val">' + (mode==='time'?'計時制（'+turnTime+'秒/輪）':'回合制（全員鎖定換輪）') + '</span></div>' +
        '<div class="preview-row"><span class="preview-label">回合數</span><span class="preview-val">' + rounds + ' 回合</span></div>';
    } else {
      const wwCfg = settings.wwConfig || {};
      const roles  = wwCfg.roles || {};
      const nightTime = wwCfg.nightTime || 30;
      const voteTime  = wwCfg.voteTime  || 60;
      const roleLines = Object.entries(ROLES)
        .filter(([rid]) => (roles[rid] || 0) > 0)
        .map(([rid, def]) => def.icon + ' ' + def.name + ' ×' + roles[rid])
        .join('　');
      cont.innerHTML =
        '<div class="preview-row"><span class="preview-label">遊戲模式</span><span class="preview-val">🐺 狼人殺</span></div>' +
        '<div class="preview-row"><span class="preview-label">夜晚時限</span><span class="preview-val">' + nightTime + ' 秒</span></div>' +
        '<div class="preview-row"><span class="preview-label">投票時限</span><span class="preview-val">' + voteTime + ' 秒</span></div>' +
        '<div class="preview-row preview-roles"><span class="preview-label">職業設定</span><span class="preview-val">' + (roleLines || '未設定') + '</span></div>';
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
      this._setText('char-count', '0');
      this._updateCharRing(0);
      this._show('btn-lock',       true);
      this._show('waiting-locked', false);
      this._show('writing-card',   true);
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
          const tv = Math.max(0, timeLeft || 0);
          this._setText('timer-value', String(tv));
          te.classList.toggle('urgent', tv <= 10);
          // Update ring progress
          const maxTime = game.nightTime || 90;
          const pct = tv / maxTime;
          const ring = document.getElementById('timer-ring-fill');
          if (ring) ring.style.strokeDashoffset = String(94.25 * (1 - pct));
          // Auto-lock: when timer hits 0, submit whatever the player has typed
          if (tv <= 0 && !(game.locked || {})[myId]) {
            const inp = document.getElementById('story-input');
            const txt = inp ? inp.value.trim() : '';
            if (!isHost) {
              gameEngine.sendAction({ type: ACTION.LOCK, text: txt || '（時間到，未輸入）' });
            }
          }
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
        ctxEl.innerHTML = Utils.escapeHtml(ctx.text);
        ctxEl.classList.add('has-content');
      } else {
        ctxEl.innerHTML = '<span class="context-placeholder">（故事的開端，由你來書寫！）</span>';
        ctxEl.classList.remove('has-content');
      }
    }

    // Auto-lock when time is almost up (prevents blank story segments)
    if (game.mode === 'time' && (game.timeLeft <= 3) && game.timeLeft > 0 && !isLocked) {
      if (this._autoLockTurn !== game.currentTurn) {
        this._autoLockTurn = game.currentTurn;
        var txt = (inp ? inp.value.trim() : '') || '（略過）';
        setTimeout(function() { gameEngine.sendAction({ type: ACTION.LOCK, text: txt }); }, 0);
      }
    }

    if (inp) inp.disabled = isLocked;
    this._show('btn-lock',        !isLocked);
    this._show('waiting-locked',   isLocked);
    this._show('writing-card',    !isLocked);
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
    const cont = document.getElementById('reveal-stories');
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

    // ── Game type switcher ──────────────────────────────
    document.querySelectorAll('.game-type-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var s = store.get().settings;
        var newSettings = Object.assign({}, s, { gameType: btn.dataset.type });
        store.set({ settings: newSettings });
        transport.pushSettings(store.get().roomCode, newSettings);
        self._renderRoomControls(store.get());
      });
    });

    // ── Story: start game ───────────────────────────────
    this._on('btn-start-game', 'click', function() {
      var players       = store.get().players;
      var activePlayers = Object.values(players).filter(function(p) { return !p.isSpectator; });
      if (activePlayers.length < CONFIG.MIN_PLAYERS)
        return self._err('room-error', '至少需要 ' + CONFIG.MIN_PLAYERS + ' 名玩家才能開始');

      var modeEl   = document.querySelector('input[name="game-mode"]:checked');
      var mode     = modeEl ? modeEl.value : 'round';
      var roundsEl = document.getElementById('input-rounds');
      var timeEl   = document.getElementById('input-turn-time');
      var rounds   = Utils.clamp(parseInt((roundsEl || {}).value || 2), 1, 10);
      var turnTime = Utils.clamp(parseInt((timeEl   || {}).value || 90), 15, 300);

      store.set({ settings: Object.assign({}, store.get().settings, { mode, rounds, turnTime }) });
      gameEngine.startGame({ mode, rounds, turnTime });
      self._prevPhase = PHASE.WAITING;
      self.show('game');
    });

    // ── Werewolf: role counter buttons ──────────────────
    document.querySelectorAll('.role-counter-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var roleId  = btn.dataset.role;
        var dir     = parseInt(btn.dataset.dir);
        var s       = store.get().settings;
        var wwCfg   = s.wwConfig || {};
        var roles   = Object.assign({}, (wwCfg.roles) || {});
        var current = roles[roleId] || 0;
        var isWolf  = roleId === 'wolf' || roleId === 'wolfking';
        var max     = isWolf ? 6 : 2;
        roles[roleId] = Math.max(0, Math.min(max, current + dir));
        var newSettings = Object.assign({}, s, { wwConfig: Object.assign({}, wwCfg, { roles }) });
        store.set({ settings: newSettings });
        transport.pushSettings(store.get().roomCode, newSettings);
        var el = document.getElementById('ww-count-' + roleId);
        if (el) el.textContent = roles[roleId];
      });
    });

    // ── Werewolf: start game ────────────────────────────
    this._on('btn-start-ww', 'click', function() {
      alert('因檢測到狼人殺遊戲中有重大bug，故暫時關閉該功能');
      return;
      
      var players    = store.get().players;
      var activePlayers = Object.values(players).filter(function(p) { return !p.isSpectator; });
      var n          = activePlayers.length;
      if (n < 4) return self._err('room-error', '狼人殺至少需要 4 名玩家（觀戰者不計入）');

      var s       = store.get().settings;
      var wwCfg   = s.wwConfig || {};
      var roles   = Object.assign({}, (wwCfg.roles) || {});
      var nte     = document.getElementById('ww-night-time');
      var nightTime = Utils.clamp(parseInt((nte || {}).value || 30), 15, 90);
      var vte     = document.getElementById('ww-vote-time');
      var voteTime = Utils.clamp(parseInt((vte || {}).value || 60), 20, 180);

      var wolfCount = (roles.wolf || 0) + (roles.wolfking || 0);
      if (wolfCount < 1) return self._err('room-error', '至少需要設定 1 名狼人或狼王');

      var totalConfig = Object.values(roles).reduce(function(a, b) { return a + b; }, 0);
      if (totalConfig > n) return self._err('room-error', '職業總數（' + totalConfig + '）超過玩家數（' + n + '），請減少職業數量');

      store.set({ settings: Object.assign({}, s, { wwConfig: Object.assign({}, wwCfg, { roles, nightTime, voteTime }) }) });
      wwEngine.startGame({ roles, nightTime, voteTime });

      // Navigate host immediately, then render with final game state
      document.querySelectorAll('.screen').forEach(function(el) {
        el.classList.add('hidden'); el.classList.remove('active');
      });
      var scrEl = document.getElementById('screen-ww-game');
      if (scrEl) { scrEl.classList.remove('hidden'); scrEl.classList.add('active'); }
      self._screen = 'ww-game';
      self._renderWW(store.get());
    });

    // ── Story: game mode radio ──────────────────────────
    document.querySelectorAll('input[name="game-mode"]').forEach(function(r) {
      r.addEventListener('change', function(e) {
        var s = store.get().settings;
        var newSettings = Object.assign({}, s, { mode: e.target.value });
        store.set({ settings: newSettings });
        transport.pushSettings(store.get().roomCode, newSettings);
        self._show('time-setting', e.target.value === 'time');
      });
    });

    // Push story numeric settings on blur
    ['input-rounds','input-turn-time'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', function() {
        var s  = store.get().settings;
        var ns = Object.assign({}, s, {
          rounds  : Utils.clamp(parseInt(document.getElementById('input-rounds')?.value||2),1,10),
          turnTime: Utils.clamp(parseInt(document.getElementById('input-turn-time')?.value||90),15,300),
        });
        store.set({ settings: ns });
        transport.pushSettings(store.get().roomCode, ns);
      });
    });

    // Push WW night time on change
    var nte = document.getElementById('ww-night-time');
    if (nte) nte.addEventListener('change', function() {
      var s = store.get().settings;
      var wwCfg = s.wwConfig || {};
      var ns = Object.assign({}, s, { wwConfig: Object.assign({}, wwCfg, { nightTime: Utils.clamp(parseInt(nte.value||30),15,90) }) });
      store.set({ settings: ns });
      transport.pushSettings(store.get().roomCode, ns);
    });

    // Push WW vote time on change
    var vte = document.getElementById('ww-vote-time');
    if (vte) vte.addEventListener('change', function() {
      var s = store.get().settings;
      var wwCfg = s.wwConfig || {};
      var ns = Object.assign({}, s, { wwConfig: Object.assign({}, wwCfg, { voteTime: Utils.clamp(parseInt(vte.value||60),20,180) }) });
      store.set({ settings: ns });
      transport.pushSettings(store.get().roomCode, ns);
    });

    // Max players selector
    var mpSel = document.getElementById('select-max-players');
    if (mpSel) mpSel.addEventListener('change', function() {
      var val = parseInt(mpSel.value) || 12;
      var s   = store.get().settings;
      var ns  = Object.assign({}, s, { maxPlayers: val });
      store.set({ settings: ns });
      transport.pushSettings(store.get().roomCode, ns);
      var cnt = document.getElementById('player-count');
      if (cnt) cnt.textContent = Object.keys(store.get().players).length + ' / ' + val;
    });

    // Voluntary spectator toggle (enter or exit spectator mode for all players including host)
    this._on('btn-toggle-spectator', 'click', async function() {
      var s = store.get();
      // Read actual spectator state from player record (most reliable source)
      var myPlayer = (s.players || {})[s.myId] || {};
      var currentSpec = !!(s.isSpectator || myPlayer.isSpectator);
      var newVal = !currentSpec;
      store.set({ isSpectator: newVal });
      await transport.updatePlayerSpectator(s.roomCode, s.myId, newVal);
      self._renderPlayers(store.get().players, s.myId, s.hostId);
      self._renderRoomControls(store.get());
    });

    // Exit spectator mode (non-host lobby panel button + host exit bar)
    ['btn-leave-spec', 'btn-host-leave-spec'].forEach(function(btnId) {
      self._on(btnId, 'click', async function() {
        var s = store.get();
        store.set({ isSpectator: false });
        await transport.updatePlayerSpectator(s.roomCode, s.myId, false);
        self._renderPlayers(store.get().players, s.myId, s.hostId);
        self._renderRoomControls(store.get());
      });
    });
  }

  _updateCharRing(n) {
    const ring = document.getElementById('char-ring-fill');
    const circumference = 81.7;
    if (ring) ring.style.strokeDashoffset = String(circumference * (1 - Math.min(n / 500, 1)));
    const el = document.getElementById('char-count');
    if (el) {
      el.textContent = String(n);
      // Color shift when getting full
      el.style.color = n > 400 ? '#f87171' : n > 250 ? 'var(--gold2)' : 'var(--txt2)';
    }
  }

  _bindGame() {
    var self = this;
    this._on('story-input', 'input', function() {
      var inp = document.getElementById('story-input');
      self._updateCharRing(inp ? inp.value.length : 0);
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
    this._on('btn-return-lobby', 'click', function() { roomManager.returnToLobby(); });
  }

  // ── WW Game Bindings ──────────────────────────────────

  _bindWWGame() {
    var self = this;

    // Host: start night after role reveal
    this._on('btn-ww-start-night', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.START_NIGHT });
    });

    // Host: open discussion after morning announcement
    this._on('btn-ww-start-discuss', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.START_DISCUSS });
    });

    // Knight: reveal identity before challenging
    this._on('btn-knight-reveal', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.KNIGHT_REVEAL });
    });

    // All: ready to vote during discussion
    this._on('btn-ww-ready', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.DISCUSS_READY });
    });

    // Wolf: confirm kill choice
    this._on('btn-wolf-confirm', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.WOLF_CONFIRM });
    });

    // Witch: save
    this._on('btn-witch-save', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.WITCH_SAVE });
    });

    // Witch: pass
    this._on('btn-witch-pass', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.WITCH_PASS });
    });

    // Hunter: passive confirm (night toy done)
    this._on('btn-hunter-pass', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.PASSIVE_CONFIRM });
    });

    // Knight: challenge (toggled via discussion panel rebuild on render)
    // Handled via dynamic onclick in grid items

    // Vote: abstain (now also auto-locks)
    this._on('btn-vote-abstain', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.VOTE_ABSTAIN });
    });

    // Vote: lock selection
    this._on('btn-vote-lock', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.VOTE_LOCK });
    });

    // Vote: unlock selection
    this._on('btn-vote-unlock', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.VOTE_UNLOCK });
    });

    // Host: force start vote
    this._on('btn-host-force-vote', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.HOST_FORCE_VOTE });
    });

    // Passive night roles: confirm done (villager/bomber/knight)
    this._on('btn-passive-done', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.NIGHT_DONE });
    });

    // Cupid: confirm pair
    this._on('btn-cupid-confirm', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.CUPID_CONFIRM });
    });

    // Lover: acknowledge notification
    this._on('btn-lover-ack', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.LOVER_ACK });
    });

    // Night toy is now initialized dynamically in _renderWWNight based on player role

    // Return to lobby
    this._on('btn-ww-back-lobby', 'click', function() {
      // Reset spectator revealed tracking when leaving game
      self._specRevealed.clear();
      wwEngine.sendAction({ type: WW_ACTION.WW_RETURN_LOBBY });
    });

    // Spectator: role reveal via event delegation (reliable across re-renders)
    var specContent = document.getElementById('ww-spectator-content');
    if (specContent) {
      specContent.addEventListener('click', function(e) {
        var cell = e.target.closest('.spec-role-cell');
        if (!cell) return;
        var pid = cell.getAttribute('data-pid');
        if (self._specRevealed.has(pid)) {
          self._specRevealed.delete(pid);
          cell.setAttribute('data-revealed', '0');
          cell.innerHTML = '<span class="spec-role-hint">👆 點擊查看</span>';
        } else {
          self._specRevealed.add(pid);
          var role = cell.getAttribute('data-role') || '?';
          var team = cell.getAttribute('data-team') || 'village';
          cell.setAttribute('data-revealed', '1');
          cell.innerHTML = '<span class="spec-role-text team-' + team + '">' + Utils.escapeHtml(role) + '</span>';
        }
      });
    }

    // Dead player overlay: same role reveal logic
    var deadContent = document.getElementById('ww-dead-content');
    if (deadContent) {
      deadContent.addEventListener('click', function(e) {
        var cell = e.target.closest('.spec-role-cell');
        if (!cell) return;
        var pid = cell.getAttribute('data-pid');
        if (self._specRevealed.has(pid)) {
          self._specRevealed.delete(pid);
          cell.setAttribute('data-revealed', '0');
          cell.innerHTML = '<span class="spec-role-hint">👆 點擊查看</span>';
        } else {
          self._specRevealed.add(pid);
          var role = cell.getAttribute('data-role') || '?';
          var team = cell.getAttribute('data-team') || 'village';
          cell.setAttribute('data-revealed', '1');
          cell.innerHTML = '<span class="spec-role-text team-' + team + '">' + Utils.escapeHtml(role) + '</span>';
        }
      });
    }
  }

  // ── WW Rendering Entry Point ──────────────────────────

  _renderWW(s) {
    const { game: g, players, myId, isHost, isSpectator } = s;
    // Determine if this player is dead in-game (has role, not alive, not in end phase)
    const hasRole  = !!(g.roles || {})[myId];
    const amAlive  = !!(g.alive || {})[myId];
    const isDead   = hasRole && !amAlive && g.wwPhase !== 'end';
    // wolfking with pending secret shot needs special UI even while dead
    const isWolfkingDeadWithPendingShot = isDead && (g.roles||{})[myId] === 'wolfking' && !g.wolfkingSecretReady;
    // hunter who can shoot needs shot UI on dead overlay
    const isHunterDeadWithShot = isDead && (g.roles||{})[myId] === 'hunter' && g.hunterCanShoot && !g.hunterShot;

    this._renderWWHeader(g, players, myId);

    // Always hide all game panels first
    const panels = ['role-reveal','night','day-announce','day-discuss','vote','vote-result','special','end'];
    panels.forEach(p => this._show('ww-panel-' + p, false));

    // Spectator overlay
    this._show('ww-spectator-overlay', !!isSpectator && !isDead);
    // Dead overlay
    this._show('ww-dead-overlay', !!isDead && !isSpectator);

    if (isSpectator && !isDead) {
      this._renderWWSpectator(g, players);
      return;
    }

    if (isDead && !isSpectator) {
      // Exception: if it's the special phase and THIS dead player is the actor (hunter/wolfking),
      // they must see the special panel to take their action — skip the dead overlay.
      const sp = g.specialPending;
      const isSpecialActor = g.wwPhase === 'special' && sp && sp.pid === myId;

      if (!isSpecialActor) {
        this._renderWWDead(g, players, myId, isHost, isWolfkingDeadWithPendingShot, isHunterDeadWithShot);
        if (isHost) this._renderWWDeadHostBar(g);
        return;
      }
      // Actor falls through to render the special panel below
      this._show('ww-dead-overlay', false);
    }

    const phase = g.wwPhase;

    // ── Lover notification modal ─────────────────────────
    // Show to each lover once cupid has confirmed, until they ack
    const lovers = g.lovers || [];
    const amLover = lovers.includes(myId);
    const loverNotifyModal = document.getElementById('lover-notify-modal');
    const needsNotify = amLover && g.cupidDone && !(g.loverAcks||{})[myId] && phase !== 'end';
    if (loverNotifyModal) {
      loverNotifyModal.classList.toggle('hidden', !needsNotify);
      if (needsNotify) {
        // Find partner
        const partnerId = lovers.find(id => id !== myId);
        const partnerP  = (players||{})[partnerId] || {};
        const partnerEl = document.getElementById('lover-partner-name');
        const avatarEl  = document.getElementById('lover-partner-avatar');
        if (partnerEl) partnerEl.textContent = partnerP.name || partnerId || '???';
        if (avatarEl)  {
          avatarEl.textContent   = (partnerP.name||'?')[0];
          avatarEl.style.background = Utils.avatarColor(partnerP.name||partnerId||'?');
        }
      }
    }

    if (phase === 'role_reveal')  { this._show('ww-panel-role-reveal', true);  this._renderWWRoleReveal(g, myId, isHost, players); }
    if (phase === 'night')        { this._show('ww-panel-night', true);         this._renderWWNight(g, myId, players); }
    if (phase === 'day_announce') { this._show('ww-panel-day-announce', true);  this._renderWWAnnounce(g, players, isHost); }
    if (phase === 'day_discuss')  { this._show('ww-panel-day-discuss', true);   this._renderWWDiscuss(g, players, myId, isHost, amAlive); }
    if (phase === 'vote')         { this._show('ww-panel-vote', true);          this._renderWWVote(g, players, myId, amAlive); }
    if (phase === 'vote_result')  { this._show('ww-panel-vote-result', true);   this._renderWWVoteResult(g, players); }
    if (phase === 'special')      { this._show('ww-panel-special', true);       this._renderWWSpecial(g, players, myId); }
    if (phase === 'end')          { this._show('ww-panel-end', true);           this._renderWWEnd(g, players); }
  }

  _renderWWSpectator(g, players) {
    var cont = document.getElementById('ww-spectator-content');
    if (!cont) return;

    var phaseNames = {
      role_reveal:'身份確認中', night:'🌙 夜晚行動中', day_announce:'🌅 清晨宣告',
      day_discuss:'💬 白天討論', vote:'🗳️ 投票中', vote_result:'投票結果',
      special:'⚡ 特殊技能', end:'遊戲結束'
    };
    var phase = g.wwPhase;
    var round = g.wwRound || 0;
    var self  = this;

    var rows = Object.entries(g.roles||{}).map(function([pid, roleId]) {
      var p       = players[pid] || {};
      var role    = ROLES[roleId] || ROLES.villager;
      var isAlive = !!(g.alive||{})[pid];
      var isRev   = self._specRevealed.has(pid);
      var roleCellHtml = isRev
        ? '<span class="spec-role-text team-' + role.team + '">' + Utils.escapeHtml(role.icon + ' ' + role.name) + '</span>'
        : '<span class="spec-role-hint">👆 點擊查看</span>';
      return '<div class="spec-row ' + (isAlive?'spec-alive':'spec-dead') + '">' +
        '<div class="spec-name-cell">' +
          '<div class="spec-mini-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
          Utils.escapeHtml(p.name||pid) +
        '</div>' +
        '<div class="spec-alive-cell">' + (isAlive ? '✅' : '💀') + '</div>' +
        '<div class="spec-role-cell" data-pid="' + pid + '" data-revealed="' + (isRev?'1':'0') + '"' +
          ' data-role="' + Utils.escapeHtml(role.icon + ' ' + role.name) + '" data-team="' + role.team + '">' +
          roleCellHtml +
        '</div>' +
      '</div>';
    }).join('');

    cont.innerHTML =
      '<div class="spectator-phase-bar">' +
        '<span class="spec-badge">👁 觀戰中</span>' +
        '<span class="spec-phase">' + (phaseNames[phase]||phase) + '</span>' +
        (round > 0 ? '<span class="spec-round">第 ' + round + ' 夜</span>' : '') +
      '</div>' +
      '<div class="spec-table-header"><span>玩家</span><span>存活</span><span>職業（點擊顯示）</span></div>' +
      '<div class="spectator-role-table">' + rows + '</div>' +
      '<div class="spectator-hint">👁 你是觀戰者，無法參與遊戲。點擊職業欄可個別查看玩家身份。</div>';
  }

  // Kept as no-op for compatibility; actual toggle logic is in _bindWWGame event delegation
  _initSpecToggle() {}

  _renderWWDead(g, players, myId, isHost, isWolfkingPending, isHunterPending) {
    var cont = document.getElementById('ww-dead-content');
    if (!cont) return;

    var phaseNames = {
      role_reveal:'身份確認中', night:'🌙 夜晚行動中', day_announce:'🌅 清晨宣告',
      day_discuss:'💬 白天討論', vote:'🗳️ 投票中', vote_result:'投票結果',
      special:'⚡ 特殊技能', end:'遊戲結束'
    };
    var phase      = g.wwPhase;
    var round      = g.wwRound || 0;
    var cause      = (g.deathLog || {})[myId] || '原因不明';
    var myRoleId   = (g.roles || {})[myId];
    var myRole     = ROLES[myRoleId] || ROLES.villager;
    var self       = this;

    // Spectator-like table of all alive players
    var rows = Object.entries(g.roles||{}).map(function([pid, roleId]) {
      var p       = players[pid] || {};
      var role    = ROLES[roleId] || ROLES.villager;
      var isAlive = !!(g.alive||{})[pid];
      var isRev   = self._specRevealed.has(pid);
      var roleCellHtml = isRev
        ? '<span class="spec-role-text team-' + role.team + '">' + Utils.escapeHtml(role.icon + ' ' + role.name) + '</span>'
        : '<span class="spec-role-hint">👆 點擊查看</span>';
      return '<div class="spec-row ' + (isAlive?'spec-alive':'spec-dead') + '">' +
        '<div class="spec-name-cell">' +
          '<div class="spec-mini-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
          Utils.escapeHtml(p.name||pid) +
        '</div>' +
        '<div class="spec-alive-cell">' + (isAlive ? '✅' : '💀') + '</div>' +
        '<div class="spec-role-cell" data-pid="' + pid + '" data-revealed="' + (isRev?'1':'0') + '"' +
          ' data-role="' + Utils.escapeHtml(role.icon + ' ' + role.name) + '" data-team="' + role.team + '">' +
          roleCellHtml +
        '</div>' +
      '</div>';
    }).join('');

    // Wolfking secret shot panel
    var wkSection = '';
    if (isWolfkingPending) {
      var alivePids = Object.keys(g.alive||{}).filter(id => g.alive[id] && id !== myId);
      var selectedTarget = g.wolfkingSecretTarget;
      var chips = alivePids.map(function(pid) {
        var pp = players[pid] || {};
        var isSel = pid === selectedTarget;
        return '<div class="vote-chip ' + (isSel?'selected':'') + '" style="cursor:pointer"' +
          ' onclick="wwEngine.sendAction({type:WW_ACTION.WOLFKING_SECRET,targetId:\'' + pid + '\'})">' +
          '<div class="vote-avatar" style="background:' + Utils.avatarColor(pp.name||pid) + '">' + (pp.name||'?')[0] + '</div>' +
          '<span>' + Utils.escapeHtml(pp.name||pid) + '</span>' +
          (isSel ? '<span class="vote-tally">✓</span>' : '') +
          '</div>';
      }).join('');
      wkSection =
        '<div class="dead-wk-panel">' +
          '<div class="dead-wk-header">' +
            '<span class="dead-wk-icon">👑</span>' +
            '<span class="dead-wk-title">狼王秘密帶走一人</span>' +
          '</div>' +
          '<p class="dead-wk-hint">悄悄選擇一個目標——將在下一個白天生效，無人知曉</p>' +
          '<div class="player-vote-grid">' + chips + '</div>' +
          (g.wolfkingSecretTarget ?
            '<p class="dead-wk-chosen">✓ 已選擇目標，等待夜晚結束生效…</p>' : '') +
        '</div>';
    }

    // Hunter shoot panel — REMOVED: hunter now uses public special phase visible to all
    var hunterSection = '';

    cont.innerHTML =
      '<div class="dead-player-header">' +
        '<div class="dead-skull-big">💀</div>' +
        '<h2 class="dead-title">你已死亡</h2>' +
        '<div class="dead-cause-row">' +
          '<span class="dead-cause-label">死亡原因</span>' +
          '<span class="dead-cause-text">' + Utils.escapeHtml(cause) + '</span>' +
        '</div>' +
        '<div class="dead-role-row">' +
          '<span class="dead-role-badge team-badge-' + myRole.team + '">' + myRole.icon + ' ' + myRole.name + '</span>' +
        '</div>' +
      '</div>' +
      wkSection +
      hunterSection +
      '<div class="spectator-phase-bar">' +
        '<span class="spec-phase">' + (phaseNames[phase]||phase) + '</span>' +
        (round > 0 ? '<span class="spec-round">第 ' + round + ' 夜</span>' : '') +
      '</div>' +
      '<div class="spec-table-header"><span>玩家</span><span>存活</span><span>職業（點擊顯示）</span></div>' +
      '<div class="spectator-role-table">' + rows + '</div>' +
      '<div class="spectator-hint">你已出局，可靜靜觀察剩餘玩家的動向。' + (isHost ? ' 主持人控制列在右上角。' : '') + '</div>';
  }

  // Dead host floating control bar — lets host manage game even after death
  _renderWWDeadHostBar(g) {
    var bar = document.getElementById('dead-host-bar');
    if (!bar) return;
    var phase = g.wwPhase;
    bar.innerHTML = '';
    bar.classList.remove('hidden');

    if (phase === 'day_announce') {
      var btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-sm dead-host-btn';
      btn.textContent = '💬 開始討論';
      btn.onclick = function() { wwEngine.sendAction({ type: WW_ACTION.START_DISCUSS }); };
      bar.appendChild(btn);
    } else if (phase === 'day_discuss') {
      var btn2 = document.createElement('button');
      btn2.className = 'btn btn-secondary btn-sm dead-host-btn';
      btn2.textContent = '⚡ 強制投票';
      btn2.onclick = function() { wwEngine.sendAction({ type: WW_ACTION.HOST_FORCE_VOTE }); };
      bar.appendChild(btn2);
    } else {
      bar.classList.add('hidden');
    }
  }

  _renderWWHeader(g, players, myId) {
    const alivePids  = Object.keys(g.alive || {}).filter(id => g.alive[id]);
    const phaseNames = {
      role_reveal: '身份確認', night: '夜晚', day_announce: '清晨宣告',
      day_discuss: '白天討論', vote: '投票放逐', vote_result: '投票結果',
      special: '特殊技能', end: '遊戲結束',
    };
    this._setText('ww-phase-label', phaseNames[g.wwPhase] || '');
    this._setText('ww-round-label', g.wwRound > 0 ? '第 ' + g.wwRound + ' 夜' : '');
    this._setText('ww-alive-count', '👥 存活 ' + alivePids.length + ' 人');

    // Night timer
    const showTimer = g.wwPhase === 'night' && g.nightTimeLeft > 0;
    this._show('ww-night-timer', showTimer);
    if (showTimer) {
      this._setText('ww-timer-val', String(g.nightTimeLeft || 0));
      var te = document.getElementById('ww-night-timer');
      if (te) te.classList.toggle('urgent', (g.nightTimeLeft || 0) <= 10);
    }
  }

  _renderWWRoleReveal(g, myId, isHost, players) {
    const myRole   = (g.roles || {})[myId];
    const roleDef  = ROLES[myRole] || ROLES.villager;
    const isWolf   = roleDef.team === 'wolf';

    this._setText('ww-role-icon', roleDef.icon);
    this._setText('ww-role-name', roleDef.name);
    this._setText('ww-role-team', isWolf ? '⚠️ 狼人陣營' : '✦ 村民陣營');
    this._setText('ww-role-desc', roleDef.desc);

    var card = document.getElementById('ww-role-card');
    if (card) {
      card.className = 'role-card role-' + (isWolf ? 'wolf' : 'village');
    }

    // Show teammates for wolves
    var teammates = Object.entries(g.roles || {}).filter(function([pid, r]) {
      return pid !== myId && (r === 'wolf' || r === 'wolfking');
    });
    this._show('ww-wolf-teammates', isWolf && teammates.length > 0);
    var tl = document.getElementById('ww-teammates-list');
    if (tl && isWolf) {
      tl.innerHTML = teammates.map(function([pid]) {
        var p = players[pid] || {};
        var r = ROLES[g.roles[pid]] || {};
        return '<span class="teammate-chip"><span>' + Utils.escapeHtml(p.name || pid) + '</span>' +
               '<span class="teammate-role">' + (r.icon || '') + (r.name || '') + '</span></span>';
      }).join('');
    }

    // Only host sees "start night" button; others wait
    this._show('btn-ww-start-night', isHost);
    this._show('ww-night-starts',   !isHost);
  }

  _renderWWNight(g, myId, players) {
    const myRole   = (g.roles || {})[myId];
    const amWolf   = myRole === 'wolf' || myRole === 'wolfking';
    const amSeer   = myRole === 'seer';
    const amWitch  = myRole === 'witch';
    const amHunter = myRole === 'hunter';
    const isActive = NIGHT_ACTIVE_ROLES.has(myRole);
    const amDone   = !!(g.nightConfirmed || {})[myId];
    const amCupid  = myRole === 'cupid';
    const isPassive = !isActive && !amHunter && !amCupid; // villager, bomber, knight

    // Each player sees only their own panel simultaneously
    this._show('ww-night-wolf',    amWolf   && !amDone);
    this._show('ww-night-seer',    amSeer   && !amDone);
    this._show('ww-night-witch',   amWitch  && !amDone);
    this._show('ww-night-hunter',  amHunter && !amDone);
    this._show('ww-night-cupid',   amCupid  && !amDone && !g.cupidDone);
    this._show('ww-night-passive', isPassive && !amDone);
    // Show waiting scene: active role done, OR passive/hunter/cupid confirmed
    this._show('ww-night-waiting', (isActive && amDone) || ((isPassive || amHunter || amCupid) && amDone));

    // Cupid panel rendering
    if (amCupid && !amDone && !g.cupidDone) {
      const sel = g.cupidSelected || [];
      // Slot labels
      const slot0 = document.getElementById('cupid-slot-name-0');
      const slot1 = document.getElementById('cupid-slot-name-1');
      if (slot0) slot0.textContent = sel[0] ? ((players[sel[0]]||{}).name||sel[0]) : '—';
      if (slot1) slot1.textContent = sel[1] ? ((players[sel[1]]||{}).name||sel[1]) : '—';
      // Highlight slots with selection
      var s0 = document.getElementById('cupid-slot-0');
      var s1 = document.getElementById('cupid-slot-1');
      if (s0) s0.className = 'cupid-slot' + (sel[0] ? ' cupid-slot-filled' : '');
      if (s1) s1.className = 'cupid-slot' + (sel[1] ? ' cupid-slot-filled' : '');
      // Grid of all players (including self)
      const allPids = Object.keys(g.alive||{}).filter(id => g.alive[id]);
      var cGrid = document.getElementById('ww-cupid-grid');
      if (cGrid) {
        cGrid.innerHTML = allPids.map(function(pid) {
          var p = players[pid] || {};
          var isSel = sel.includes(pid);
          var selIdx = sel.indexOf(pid);
          return '<div class="vote-chip cupid-chip ' + (isSel ? 'selected' : '') + '"' +
            ' onclick="wwEngine.sendAction({type:WW_ACTION.CUPID_SELECT,targetId:\'' + pid + '\'})">' +
            '<div class="vote-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
            '<span>' + Utils.escapeHtml(p.name||pid) + (pid === myId ? '（你）' : '') + '</span>' +
            (isSel ? '<span class="vote-tally">' + (selIdx === 0 ? 'A' : 'B') + '</span>' : '') +
            '</div>';
        }).join('');
      }
      // Enable/disable confirm button
      var confirmBtn = document.getElementById('btn-cupid-confirm');
      if (confirmBtn) confirmBtn.disabled = sel.length !== 2;
    }

    // Hunter toy — rendered in ww-night-hunter's own toy div
    if (amHunter && !amDone) {
      const hunterToy = document.getElementById('night-toy-hunter');
      if (hunterToy && hunterToy.getAttribute('data-init') !== '1') {
        hunterToy.setAttribute('data-init', '1');
        hunterToy.style.width  = '260px';
        hunterToy.style.height = '175px';
        hunterToy.innerHTML =
          '<div class="toy-hunter-game" id="toy-hunter-game">' +
            '<div class="hunter-range">' +
              '<div class="hunter-target" id="hunter-target">🎯</div>' +
            '</div>' +
            '<div class="hunter-stats">' +
              '<span class="hunter-hits" id="hunter-hits">命中：0</span>' +
              '<span class="hunter-misses" id="hunter-misses">偏移：0</span>' +
            '</div>' +
            '<div class="toy-msg" id="toy-msg-hunter">等靶子移動再點擊射擊！</div>' +
          '</div>';
        (function() {
          var target   = hunterToy.querySelector('#hunter-target');
          var hitsEl   = hunterToy.querySelector('#hunter-hits');
          var missEl   = hunterToy.querySelector('#hunter-misses');
          var msgEl    = hunterToy.querySelector('#toy-msg-hunter');
          var range    = hunterToy.querySelector('.hunter-range');
          var hits = 0, misses = 0, moving = false;
          var hitMsgs  = ['正中靶心！','好眼力！','百步穿楊！','神射手！','完美命中！'];
          var missMsgs = ['偏了一點…','下次瞄準再射','慢慢來','手穩一點'];
          function moveTarget() {
            if (!range || !target) return;
            moving = true;
            var rw = range.offsetWidth  || 220;
            var rh = range.offsetHeight || 100;
            var tx = 10 + Math.random() * (rw - 50);
            var ty = 10 + Math.random() * (rh - 50);
            target.style.left = tx + 'px';
            target.style.top  = ty + 'px';
            target.style.transform = 'scale(1.2)';
            setTimeout(function(){ target.style.transform = 'scale(1)'; }, 200);
            setTimeout(moveTarget, 1500 + Math.random() * 1000);
          }
          if (range) range.addEventListener('click', function(e) {
            if (!moving) return;
            var rect   = range.getBoundingClientRect();
            var tRect  = target ? target.getBoundingClientRect() : null;
            var hit = tRect && e.clientX >= tRect.left && e.clientX <= tRect.right &&
                              e.clientY >= tRect.top  && e.clientY <= tRect.bottom;
            if (hit) {
              hits++;
              if (hitsEl) hitsEl.textContent = '命中：' + hits;
              if (msgEl)  msgEl.textContent  = hitMsgs[hits % hitMsgs.length];
              if (target) { target.textContent = '💥'; setTimeout(function(){ target.textContent = '🎯'; }, 300); }
            } else {
              misses++;
              if (missEl) missEl.textContent = '偏移：' + misses;
              if (msgEl)  msgEl.textContent  = missMsgs[misses % missMsgs.length];
            }
          });
          setTimeout(moveTarget, 800);
        })();
      }
    }

    // Setup passive panel icon/title + role-specific toy
    if (isPassive && !amDone) {
      const roleData = ROLES[myRole] || ROLES.villager;
      this._setText('passive-role-icon', roleData.icon || '🏘️');
      this._setText('passive-role-title', roleData.name + '，請閉眼等待');

      // Swap toy based on role (keyed by current role to avoid re-init)
      const toyWrap = document.getElementById('night-toy');
      if (toyWrap && toyWrap.getAttribute('data-toy-role') !== myRole) {
        toyWrap.setAttribute('data-toy-role', myRole);

        if (myRole === 'bomber') {
          // 💣 Bomber: defuse the bomb game
          toyWrap.style.width  = '220px';
          toyWrap.style.height = '150px';
          toyWrap.innerHTML =
            '<div class="toy-scene" id="toy-scene">' +
              '<div class="toy-bomb" id="toy-bomb">💣</div>' +
              '<div class="toy-fuse" id="toy-fuse">〰</div>' +
            '</div>' +
            '<div class="toy-msg" id="toy-msg">點炸彈試試</div>';
          (function() {
            var bomb  = toyWrap.querySelector('#toy-bomb');
            var msg   = toyWrap.querySelector('#toy-msg');
            var scene = toyWrap.querySelector('#toy-scene');
            var n = 0;
            var bmsgs = ['💣 滴答…','😬 還在嗎','💣 滴答滴答…','😅 別亂按！',
                         '🤫 裝沒事','😤 我很穩','💣 好熱…','🫠 快不行了',
                         '🫡 使命必達','💪 我能撐住'];
            if (bomb) bomb.addEventListener('click', function() {
              n++;
              if (msg) msg.textContent = bmsgs[(n-1) % bmsgs.length];
              bomb.style.transform = 'scale(1.4) rotate('+(n*60)+'deg)';
              setTimeout(function(){ bomb.style.transform = ''; }, 200);
              if (scene && n % 5 === 0) {
                var sp = document.createElement('div');
                sp.className = 'toy-spark';
                sp.textContent = ['💥','✨','🌟'][n%3];
                sp.style.left = (25+Math.random()*50)+'%';
                sp.style.top  = (20+Math.random()*40)+'%';
                scene.appendChild(sp);
                setTimeout(function(){ if(sp.parentNode) sp.parentNode.removeChild(sp); }, 700);
              }
            });
          })();

        } else if (myRole === 'knight') {
          // ⚔️ Knight: Block incoming wolf paws — tap/click in time mini-game
          toyWrap.style.width  = '260px';
          toyWrap.style.height = '175px';
          toyWrap.innerHTML =
            '<div class="toy-knight-game" id="toy-knight-game">' +
              '<div class="knight-arena">' +
                '<div class="knight-hero" id="knight-hero">🛡️</div>' +
                '<div class="knight-attacker" id="knight-attacker" style="opacity:0">🐾</div>' +
              '</div>' +
              '<div class="knight-score-row">' +
                '<span class="knight-score" id="knight-score">防禦：0</span>' +
                '<span class="knight-miss"  id="knight-miss">失誤：0</span>' +
              '</div>' +
              '<div class="toy-msg" id="toy-msg">點擊盾牌格擋爪子！</div>' +
            '</div>';
          (function() {
            var hero     = toyWrap.querySelector('#knight-hero');
            var attacker = toyWrap.querySelector('#knight-attacker');
            var scoreEl  = toyWrap.querySelector('#knight-score');
            var missEl   = toyWrap.querySelector('#knight-miss');
            var msgEl    = toyWrap.querySelector('#toy-msg');
            var score = 0, miss = 0, gameActive = false;
            var swords = ['🐾','🐺','⚡','🔥'];
            var positions = [
              {top:'20%',left:'25%'},{top:'20%',left:'65%'},
              {top:'55%',left:'15%'},{top:'55%',left:'60%'},
              {top:'35%',left:'40%'}
            ];
            var hitMessages = ['格擋成功！','完美格擋！','反擊！','英勇！','所向披靡！'];
            var missMessages = ['被偷了一下','沒擋住！','要小心！','再加油！'];

            function launchAttack() {
              if (!attacker) return;
              gameActive = true;
              var pos = positions[Math.floor(Math.random()*positions.length)];
              attacker.textContent = swords[Math.floor(Math.random()*swords.length)];
              attacker.style.top   = pos.top;
              attacker.style.left  = pos.left;
              attacker.style.opacity = '1';
              attacker.style.transform = 'scale(1.4)';
              var timeout = setTimeout(function() {
                if (attacker.style.opacity === '1') {
                  miss++;
                  if (missEl) missEl.textContent = '失誤：' + miss;
                  if (msgEl) msgEl.textContent = missMessages[miss % missMessages.length];
                  if (hero) { hero.textContent = '😰'; setTimeout(function(){ hero.textContent = '🛡️'; }, 400); }
                  attacker.style.opacity = '0';
                  setTimeout(launchAttack, 1200 + Math.random()*600);
                }
              }, 1000);
              attacker._clearTO = timeout;
            }

            if (attacker) attacker.addEventListener('click', function() {
              if (!gameActive || attacker.style.opacity === '0') return;
              clearTimeout(attacker._clearTO);
              score++;
              attacker.style.opacity  = '0';
              attacker.style.transform= 'scale(0.3)';
              if (scoreEl) scoreEl.textContent = '防禦：' + score;
              if (msgEl) msgEl.textContent = hitMessages[score % hitMessages.length];
              if (hero) { hero.textContent = '⚔️'; setTimeout(function(){ hero.textContent = '🛡️'; }, 350); }
              setTimeout(launchAttack, 900 + Math.random()*500);
            });

            // Start game after 1s
            setTimeout(launchAttack, 1000);
          })();

        } else {
          // 🌟 Villager / default: Star catch game — stars fall, tap them before they disappear
          toyWrap.style.width  = '260px';
          toyWrap.style.height = '175px';
          toyWrap.innerHTML =
            '<div class="toy-star-game" id="toy-star-game">' +
              '<div class="star-sky" id="star-sky"></div>' +
              '<div class="star-ground"><div class="star-ground-line">— — — — — — —</div></div>' +
              '<div class="star-hud">' +
                '<span class="star-caught" id="star-caught">⭐ 0</span>' +
                '<span class="star-missed" id="star-missed">💨 0</span>' +
              '</div>' +
              '<div class="toy-msg" id="toy-msg">點擊流星接住它！</div>' +
            '</div>';
          (function() {
            var sky      = toyWrap.querySelector('#star-sky');
            var caughtEl = toyWrap.querySelector('#star-caught');
            var missedEl = toyWrap.querySelector('#star-missed');
            var msgEl    = toyWrap.querySelector('#toy-msg');
            var caught = 0, missed = 0;
            var stars  = ['⭐','🌟','✨','💫','🌠'];
            var hitMsgs  = ['接住了！','漂亮！','太快了！','光速接取！','閃耀！'];
            var missMsgs = ['跑掉了…','下次接住','快一點！','手要快！'];

            function spawnStar() {
              if (!sky) return;
              var el = document.createElement('div');
              el.className = 'falling-star';
              el.textContent = stars[Math.floor(Math.random()*stars.length)];
              var leftPct = 5 + Math.random() * 80;
              var duration = 1800 + Math.random() * 800;
              el.style.cssText = 'left:' + leftPct + '%;animation-duration:' + duration + 'ms';

              var alive = true;
              el.addEventListener('click', function(e) {
                if (!alive) return;
                e.stopPropagation();
                alive = false;
                caught++;
                el.style.animation = 'starPop .3s ease forwards';
                if (caughtEl) caughtEl.textContent = '⭐ ' + caught;
                if (msgEl) msgEl.textContent = hitMsgs[caught % hitMsgs.length];
                setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 300);
              });

              sky.appendChild(el);
              setTimeout(function() {
                if (!alive) return;
                alive = false;
                missed++;
                if (missedEl) missedEl.textContent = '💨 ' + missed;
                if (msgEl) msgEl.textContent = missMsgs[missed % missMsgs.length];
                if (el.parentNode) el.parentNode.removeChild(el);
              }, duration + 100);

              // Schedule next star
              setTimeout(spawnStar, 1000 + Math.random() * 600);
            }
            setTimeout(spawnStar, 600);
          })();
        }
      }
    }

    // Night progress footer
    const alivePids   = Object.keys(g.alive||{}).filter(id => g.alive[id]);
    const needsAction = alivePids.filter(pid => NIGHT_ACTIVE_ROLES.has((g.roles||{})[pid]));
    const doneCount   = needsAction.filter(pid => (g.nightConfirmed||{})[pid]).length;
    this._setText('ww-night-step-label',
      amDone    ? '✓ 你已完成行動，等待其他人…' :
      isActive  ? '請完成你的夜晚行動' :
                  '夜晚降臨，請閉上眼睛…');
    this._setText('ww-night-progress', doneCount + ' / ' + needsAction.length + ' 人完成行動');

    // ── Wolf panel ────────────────────────────────────────
    if (amWolf && !amDone) {
      const targets = Object.keys(g.alive||{}).filter(id => g.alive[id] && !(g.roles[id]==='wolf'||g.roles[id]==='wolfking'));
      var wolfGrid = document.getElementById('ww-wolf-vote-grid');
      if (wolfGrid) {
        wolfGrid.innerHTML = targets.map(function(pid) {
          var p         = players[pid] || {};
          var myVote    = (g.wolfVotes || {})[myId];
          var isVoted   = myVote === pid;
          var voteCount = Object.values(g.wolfVotes || {}).filter(function(v) { return v === pid; }).length;
          return '<div class="vote-chip ' + (isVoted ? 'selected' : '') + '" ' +
            'onclick="wwEngine.sendAction({type:WW_ACTION.WOLF_VOTE,targetId:\'' + pid + '\'})">' +
            '<div class="vote-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
            '<span>' + Utils.escapeHtml(p.name||pid) + '</span>' +
            (voteCount > 0 ? '<span class="vote-tally">' + voteCount + '票</span>' : '') + '</div>';
        }).join('');
      }
      var myVoted    = !!(g.wolfVotes||{})[myId];
      var confirmBtn = document.getElementById('btn-wolf-confirm');
      if (confirmBtn) {
        confirmBtn.disabled    = !myVoted;
        confirmBtn.textContent = g.wolfConfirmed ? '✓ 已確認目標' : '✓ 確認獵殺目標';
      }
      this._show('btn-wolf-confirm', true);
      var wolves     = Object.keys(g.roles||{}).filter(function(id) { return (g.alive||{})[id] && (g.roles[id]==='wolf'||g.roles[id]==='wolfking'); });
      var votedCount = wolves.filter(function(id) { return (g.wolfVotes||{})[id]; }).length;
      this._setText('ww-wolf-vote-status', votedCount + ' / ' + wolves.length + ' 名狼人已選擇');
    }

    // ── Seer panel ────────────────────────────────────────
    if (amSeer && !amDone) {
      var seerTargets = Object.keys(g.alive||{}).filter(function(id) { return g.alive[id] && id !== myId; });
      var seerGrid = document.getElementById('ww-seer-grid');
      if (seerGrid) {
        seerGrid.innerHTML = seerTargets.map(function(pid) {
          var p      = players[pid] || {};
          var result = (g.seerResults||{})[pid];
          var alreadyChecked = g.seerCheckedThisRound === pid;
          return '<div class="vote-chip ' + (result ? 'checked-' + result : '') + '"' +
            (result ? '' : ' onclick="wwEngine.sendAction({type:WW_ACTION.SEER_CHECK,targetId:\'' + pid + '\'})"') + '>' +
            '<div class="vote-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
            '<span>' + Utils.escapeHtml(p.name||pid) + '</span>' +
            (result ? '<span class="seer-result ' + result + '">' + (result==='good'?'✦ 好人':'⚠ 狼人') + '</span>' : '') +
            '</div>';
        }).join('');
      }
      var hist = document.getElementById('ww-seer-history');
      if (hist) {
        var seen = Object.entries(g.seerResults||{});
        hist.innerHTML = seen.length ? '<div class="seer-hist-title">歷史查驗記錄</div>' +
          seen.map(function(entry) {
            var pid = entry[0], r = entry[1];
            var p = players[pid] || {};
            return '<div class="seer-hist-row ' + r + '">' + Utils.escapeHtml(p.name||pid) + ' — ' + (r==='good'?'✦ 好人':'⚠ 狼人') + '</div>';
          }).join('') : '';
      }
    }

    // ── Witch panel ───────────────────────────────────────
    if (amWitch && !amDone) {
      var killedEl = document.getElementById('ww-witch-killed');
      if (killedEl) {
        if (g.wolfTarget) {
          // Witch only knows SOMEONE was targeted — not who
          killedEl.innerHTML = '<div class="witch-kill-label">今晚有人被狼人選中。</div>' +
            '<div class="witch-kill-name" style="font-size:.85rem;color:var(--txt1)">是否要使用解藥救人？（你不知道是誰）</div>';
        } else {
          killedEl.innerHTML = '<div class="witch-kill-label witch-kill-wait">⏳ 等待狼人確認目標中…</div>';
        }
      }
      var saveBtn = document.getElementById('btn-witch-save');
      if (saveBtn) {
        var canSave = !g.witchAntidoteUsed && !!g.wolfTarget;
        saveBtn.disabled    = !canSave;
        saveBtn.textContent = g.witchSave
          ? '✓ 解藥已選（再按取消）'
          : (g.witchAntidoteUsed ? '解藥已用完' : (g.wolfTarget ? '💊 使用解藥救人' : '💊 解藥（今夜無目標）'));
        saveBtn.classList.toggle('active-choice', !!g.witchSave);
      }
      var witchPassBtn = document.getElementById('btn-witch-pass');
      if (witchPassBtn) {
        var summary = [];
        if (g.witchSave && g.wolfTarget) summary.push('救人');
        if (g.witchPoison) summary.push('毒 ' + ((players[g.witchPoison]||{}).name||'?'));
        witchPassBtn.textContent = summary.length ? '確認（' + summary.join('，') + '），天亮 ✓' : '不使用藥水，天亮';
      }
      var poisonGrid = document.getElementById('ww-witch-poison-grid');
      if (poisonGrid) {
        var ppids = Object.keys(g.alive||{}).filter(function(id) { return g.alive[id]; });
        poisonGrid.innerHTML = g.witchPoisonUsed
          ? '<span class="witch-used">毒藥已用完</span>'
          : ppids.map(function(pid) {
              var p = players[pid] || {};
              return '<div class="vote-chip small ' + (g.witchPoison===pid?'selected':'') + '"' +
                ' onclick="wwEngine.sendAction({type:WW_ACTION.WITCH_POISON,targetId:\'' + pid + '\'})">' +
                '<div class="vote-avatar sm" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
                '<span>' + Utils.escapeHtml(p.name||pid) + '</span>' +
                (g.witchPoison===pid ? '<span class="vote-tally">☠</span>' : '') + '</div>';
            }).join('');
      }
    }
  }

  _renderWWAnnounce(g, players, isHost) {
    var cont = document.getElementById('ww-announce-content');
    if (!cont) return;
    var ann = g.announcement || {};

    // Firebase can serialize arrays as objects {0:v,1:v} or as null — normalise defensively
    var died = ann.died;
    if (!died) died = [];
    else if (!Array.isArray(died)) died = Object.values(died);

    if (ann.peaceful || died.length === 0) {
      cont.innerHTML =
        '<div class="announce-peaceful">' +
          '<div class="announce-peace-bg"></div>' +
          '<div class="announce-peace-icon">🌸</div>' +
          '<h2 class="announce-peace-title">平安夜</h2>' +
          '<p class="announce-peace-sub">昨夜無人遇難，所有人平安度過</p>' +
        '</div>';
    } else {
      cont.innerHTML =
        '<div class="announce-death-scene">' +
          '<div class="announce-death-header">' +
            '<div class="death-tolls">' + died.map(function() { return '🪦'; }).join(' ') + '</div>' +
            '<h2 class="death-title">昨夜有人遇難</h2>' +
          '</div>' +
          '<div class="death-cards-row">' +
          died.map(function(pid) {
            var p = players[pid] || {};
            return '<div class="death-card">' +
              '<div class="death-avatar-wrap">' +
                '<div class="death-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
                '<div class="death-skull-badge">💀</div>' +
              '</div>' +
              '<div class="death-card-name">' + Utils.escapeHtml(p.name||pid) + '</div>' +
              '<div class="death-card-label">昨夜遇難</div>' +
            '</div>';
          }).join('') +
          '</div>' +
        '</div>';
    }

    this._show('btn-ww-start-discuss', isHost);
    this._show('ww-waiting-discuss', !isHost);
  }

  _renderWWDiscuss(g, players, myId, isHost, amAlive) {
    var alive    = Object.keys(g.alive||{}).filter(id => g.alive[id]);
    var ready    = Object.keys(g.discussReady||{}).length;
    var iReady   = !!(g.discussReady||{})[myId];
    var myRole   = (g.roles||{})[myId];
    var isKnight = myRole === 'knight' && !g.knightUsed && amAlive;
    var knightRevealed = !!g.knightRevealed;

    // Find knight pid for public announcements
    var knightPid = Object.keys(g.roles||{}).find(function(pid) { return g.roles[pid] === 'knight'; });
    var knightName = knightPid ? ((players[knightPid]||{}).name || knightPid) : '騎士';

    this._setText('ww-ready-count', ready + ' / ' + alive.length + ' 人確認（全員確認後開始投票）');

    // ── Public Knight Banner (visible to ALL players) ──────
    var bannerEl = document.getElementById('knight-public-banner');
    if (bannerEl) {
      var clog = g.knightChallengeLog;
      if (clog) {
        // Challenge has happened — show result to everyone
        var kName  = (players[clog.knightId]||{}).name || clog.knightId;
        var tName  = (players[clog.targetId] ||{}).name || clog.targetId;
        var hit    = clog.result === 'hit';
        bannerEl.className = 'knight-public-banner ' + (hit ? 'knight-banner-hit' : 'knight-banner-miss');
        bannerEl.innerHTML =
          '<span class="knight-banner-icon">' + (hit ? '⚔️✨' : '⚔️💨') + '</span>' +
          '<span class="knight-banner-text">' +
            '<strong>' + Utils.escapeHtml(kName) + '</strong> 向 ' +
            '<strong>' + Utils.escapeHtml(tName) + '</strong> 發起決鬥 — ' +
            (hit ? '命中！決鬥成功！' : '😤 決鬥失敗，騎士出局') +
          '</span>';
        bannerEl.classList.remove('hidden');
      } else if (knightRevealed && knightPid) {
        // Knight revealed but hasn't challenged yet
        bannerEl.className = 'knight-public-banner knight-banner-reveal';
        bannerEl.innerHTML =
          '<span class="knight-banner-icon">⚔️</span>' +
          '<span class="knight-banner-text"><strong>' + Utils.escapeHtml(knightName) + '</strong> 亮牌：我是騎士！準備發起決鬥…</span>';
        bannerEl.classList.remove('hidden');
      } else {
        bannerEl.classList.add('hidden');
      }
    }

    var lst = document.getElementById('ww-alive-players-list');
    if (lst) {
      lst.innerHTML = alive.map(function(pid) {
        var p    = players[pid] || {};
        var isMe = pid === myId;
        var seer = (g.seerResults||{})[pid];
        var seerHint = (myRole === 'seer' && seer) ?
          '<span class="seer-inline ' + seer + '">' + (seer==='good'?'✦':'⚠') + '</span>' : '';
        var isReady = !!(g.discussReady||{})[pid];
        var isTheKnight = pid === knightPid && knightRevealed;
        // Knight challenge button — only to knight themselves after reveal
        var knightBtn = (isKnight && !isMe && knightRevealed) ?
          '<button class="btn btn-xs btn-danger knight-btn" onclick="wwEngine.sendAction({type:WW_ACTION.KNIGHT_CHALLENGE,targetId:\'' + pid + '\'})">⚔ 決鬥</button>' : '';
        return '<div class="discuss-player-row ' + (isMe?'is-me':'') + '">' +
          '<div class="dp-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
          '<span class="dp-name">' + Utils.escapeHtml(p.name||pid) + seerHint + (isMe?' (你)':'') +
          (isTheKnight ? ' <span class="dp-knight-badge">⚔️ 騎士</span>' : '') +
          '</span>' +
          '<span class="dp-ready">' + (isReady ? '✓ 準備好了' : '⋯') + '</span>' +
          knightBtn +
          '</div>';
      }).join('');
    }

    var readyBtn = document.getElementById('btn-ww-ready');
    if (readyBtn) {
      readyBtn.disabled    = iReady || !amAlive;
      readyBtn.textContent = iReady ? '✓ 已確認，等待其他人…' : '✋ 我準備好了（進入投票）';
    }

    // Knight: show reveal button if not yet revealed (to knight only)
    var knightRevealBtn = document.getElementById('btn-knight-reveal');
    if (knightRevealBtn) {
      this._show('btn-knight-reveal', isKnight && !knightRevealed);
    }
    var knightRevealedBadge = document.getElementById('knight-revealed-badge');
    if (knightRevealedBadge) {
      this._show('knight-revealed-badge', isKnight && knightRevealed && !g.knightChallengeLog);
    }

    // Host can force-start vote at any time
    this._show('btn-host-force-vote', isHost);
  }

  _renderWWVote(g, players, myId, amAlive) {
    var alive        = Object.keys(g.alive||{}).filter(id => g.alive[id]);
    var lockedCount  = Object.keys(g.voteLocked||{}).filter(id => g.alive[id]).length;
    var myVote       = (g.votes||{})[myId];
    var myLocked     = !!(g.voteLocked||{})[myId];
    var iAbstained   = myVote === VOTE_ABSTAIN_ID;
    var abstainCount = Object.values(g.votes||{}).filter(v => v === VOTE_ABSTAIN_ID).length;

    // Timer
    var voteTime  = g.voteTime || 60;
    var timeLeft  = (g.voteTimeLeft !== undefined) ? g.voteTimeLeft : voteTime;
    var timerEl   = document.getElementById('ww-vote-time-left');
    if (timerEl) timerEl.textContent = timeLeft;
    var timerWrap = document.getElementById('ww-vote-timer');
    if (timerWrap) timerWrap.classList.toggle('urgent', timeLeft <= 10);
    // Progress bar
    var bar = document.getElementById('ww-vote-bar');
    if (bar) bar.style.width = Math.max(0, (timeLeft / voteTime) * 100) + '%';

    this._setText('ww-vote-count', lockedCount + ' / ' + alive.length + ' 人已鎖定' +
      (abstainCount > 0 ? '（棄票 ' + abstainCount + '）' : ''));

    var grid = document.getElementById('ww-vote-grid');
    if (grid) {
      grid.innerHTML = alive.map(function(pid) {
        var p        = players[pid] || {};
        var isMe     = pid === myId;
        var votedFor = Object.values(g.votes||{}).filter(v => v === pid).length;
        var lockedFor = Object.keys(g.voteLocked||{}).filter(id => (g.votes||{})[id] === pid && (g.voteLocked||{})[id]).length;
        var iSelected = myVote === pid;
        var canClick  = !myLocked && amAlive && !isMe;
        return '<div class="vote-chip ' + (iSelected?'selected':'') + (isMe?' self':'') + (myLocked&&iSelected?' locked':'') + '"' +
          (canClick ? ' onclick="wwEngine.sendAction({type:WW_ACTION.VOTE,targetId:\'' + pid + '\'})"' : '') + '>' +
          '<div class="vote-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
          '<span>' + Utils.escapeHtml(p.name||pid) + (isMe?' (你)':'') + '</span>' +
          (votedFor > 0 ? '<span class="vote-tally">' + votedFor + '票 <small>(' + lockedFor + '🔒)</small></span>' : '') +
          '</div>';
      }).join('');
    }

    // Abstain button
    var ab = document.getElementById('btn-vote-abstain');
    if (ab) {
      ab.disabled    = myLocked;
      ab.className   = 'btn vote-abstain-btn' + (iAbstained ? ' abstained' : '');
      ab.textContent = iAbstained ? '🚫 已選擇棄票' : '棄票（不投任何人）';
    }
    this._show('vote-abstain-area', amAlive && !myLocked);

    // Lock / Unlock buttons
    var hasSelection = !!myVote;
    this._show('btn-vote-lock',   amAlive && !myLocked && hasSelection);
    this._show('btn-vote-unlock', amAlive && myLocked);

    var lockBtn = document.getElementById('btn-vote-lock');
    if (lockBtn) lockBtn.textContent = iAbstained ? '🔒 確認棄票' : '🔒 確認鎖定投票';
  }

  _renderWWVoteResult(g, players) {
    var cont = document.getElementById('ww-vote-result-content');
    if (!cont) return;
    var abstainCount = g.abstainCount || 0;

    if (!g.voteEliminated) {
      var allVotes = Object.values(g.votes||{});
      var allAbstained = allVotes.length > 0 && allVotes.every(v => v === VOTE_ABSTAIN_ID);
      var reason = allAbstained ? '全員棄票' : '平票';
      cont.innerHTML =
        '<div class="vr-no-elim">' +
          '<div class="vr-no-elim-icon">⚖️</div>' +
          '<h2 class="vr-no-elim-title">' + reason + '</h2>' +
          '<p class="vr-no-elim-sub">本輪無人被放逐' + (abstainCount > 0 ? '（' + abstainCount + ' 人棄票）' : '') + '</p>' +
        '</div>';
      return;
    }

    var pid      = g.voteEliminated;
    var p        = players[pid] || {};
    // Firebase can serialize arrays as objects — normalise defensively
    var rawVoters = g.voteVoters || [];
    var voters   = Array.isArray(rawVoters) ? rawVoters : Object.values(rawVoters);
    var isBomber = g.roles[pid] === 'bomber';

    // Update footer spinner text
    this._setText('vote-result-footer-text', isBomber ? '結算中…' : '即將進入夜晚…');

    cont.innerHTML = isBomber
      ? '<div class="vr-bomb-scene">' +
          '<div class="vr-bomb-blast">💥</div>' +
          '<h2 class="vr-bomb-title">炸彈引爆！</h2>' +
          '<div class="vr-elim-row">' +
            '<div class="vr-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
            '<span class="vr-name">' + Utils.escapeHtml(p.name||pid) + '</span>' +
          '</div>' +
          (voters.length > 0 ?
            '<div class="vr-bomber-chain">💀 連帶陣亡：' + voters.map(function(vid) { return Utils.escapeHtml((players[vid]||{}).name||vid); }).join('、') + '</div>' : '') +
          (abstainCount > 0 ? '<div class="vr-abstain-note">🚫 ' + abstainCount + ' 人棄票</div>' : '') +
        '</div>'
      : '<div class="vr-exile-scene">' +
          '<div class="vr-exile-cross">✕</div>' +
          '<h2 class="vr-exile-title">放逐出局</h2>' +
          '<div class="vr-elim-row">' +
            '<div class="vr-avatar dead-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
            '<span class="vr-name">' + Utils.escapeHtml(p.name||pid) + '</span>' +
          '</div>' +
          '<div class="vr-vote-breakdown">' +
            voters.map(function(vid) {
              var vp = players[vid] || {};
              return '<span class="vr-voter-chip">' + Utils.escapeHtml(vp.name||vid) + '</span>';
            }).join('') +
            (abstainCount > 0 ? '<span class="vr-abstain-chip">🚫 棄票 ×' + abstainCount + '</span>' : '') +
          '</div>' +
        '</div>';
  }

  _renderWWSpecial(g, players, myId) {
    var sp = g.specialPending;
    if (!sp) return;
    var isActor  = sp.pid === myId;
    var actorP   = players[sp.pid] || {};
    var isHunter = sp.type === 'hunter';
    var isWolfking = sp.type === 'wolfking';

    // Config per role
    var cfg = isHunter ? {
      bgClass   : 'special-hunter-bg',
      icon      : '🏹',
      actorBadge: '獵人亮牌！',
      headline  : isActor ? '你是獵人 — 選擇帶走一名玩家！' : (Utils.escapeHtml(actorP.name||sp.pid) + ' 亮出身份牌！'),
      subline   : isActor
        ? (g.hunterShootCause === 'wolf' ? '你被狼人擊倒，但你有最後一槍！' : '你被放逐，但你有最後一槍！')
        : '獵人正在瞄準目標…',
      action    : WW_ACTION.HUNTER_SHOOT,
      waitLabel : '等待獵人選擇目標…',
      waitIcon  : '🏹',
    } : {
      bgClass   : 'special-wolfking-bg',
      icon      : '👑',
      actorBadge: '狼王落馬！',
      headline  : isActor ? '你是狼王 — 臨死帶走一名玩家！' : (Utils.escapeHtml(actorP.name||sp.pid) + ' 身份揭露！'),
      subline   : isActor ? '選擇你的最後一擊目標' : '狼王正在選擇目標…',
      action    : WW_ACTION.WOLFKING_SHOOT,
      waitLabel : '等待狼王選擇目標…',
      waitIcon  : '👑',
    };

    var panel = document.getElementById('ww-panel-special');
    if (!panel) return;

    // Rebuild the special panel fully every render cycle
    var alivePids = Object.keys(g.alive||{}).filter(id => g.alive[id] && id !== sp.pid);

    var actorColor = Utils.avatarColor(actorP.name||sp.pid);
    var actorInitial = (actorP.name||'?')[0];

    var gridHtml = alivePids.map(function(pid) {
      var pp = players[pid] || {};
      var clr = Utils.avatarColor(pp.name||pid);
      return '<div class="special-target-chip" onclick="wwEngine.sendAction({type:\'' + cfg.action + '\',targetId:\'' + pid + '\'})">' +
        '<div class="special-target-avatar" style="background:' + clr + '">' + (pp.name||'?')[0] + '</div>' +
        '<span class="special-target-name">' + Utils.escapeHtml(pp.name||pid) + '</span>' +
        '<span class="special-target-arrow">→</span>' +
      '</div>';
    }).join('');

    panel.innerHTML =
      '<div class="special-stage ' + cfg.bgClass + '">' +
        // Dramatic actor reveal
        '<div class="special-reveal-row">' +
          '<div class="special-actor-avatar" style="background:' + actorColor + '">' + actorInitial + '</div>' +
          '<div class="special-reveal-info">' +
            '<div class="special-badge">' + cfg.actorBadge + '</div>' +
            '<div class="special-actor-name">' + Utils.escapeHtml(actorP.name||sp.pid) + '</div>' +
          '</div>' +
          '<div class="special-role-icon">' + cfg.icon + '</div>' +
        '</div>' +

        '<h2 class="special-headline">' + cfg.headline + '</h2>' +
        '<p class="special-subline">' + cfg.subline + '</p>' +

        (isActor
          ? '<div class="special-target-grid">' + gridHtml + '</div>' +
            '<p class="special-must-choose">必須選擇一人，此操作無法撤銷</p>'
          : '<div class="special-watching">' +
              '<div class="special-watch-icon">' + cfg.waitIcon + '</div>' +
              '<p class="special-watch-label">' + cfg.waitLabel + '</p>' +
              '<div class="special-dots"><span></span><span></span><span></span></div>' +
            '</div>'
        ) +
      '</div>';
  }

  _renderWWEnd(g, players) {
    var winner = g.winner;
    var banner = document.getElementById('ww-end-banner');
    if (banner) {
      var isLoversWin = winner === 'lovers';
      var isBomberWin = winner === 'bomber';
      var isWolfWin   = winner === 'wolves';
      var bannerClass = isLoversWin ? 'lovers-win' : isWolfWin ? 'wolf-win' : isBomberWin ? 'bomber-win' : 'village-win';
      var bannerIcon  = isLoversWin ? '💘' : isWolfWin ? '🐺' : isBomberWin ? '💣' : '🌅';
      var bannerTitle = isLoversWin ? '第三方陣營獲勝！' : isWolfWin ? '狼人勝利！' : isBomberWin ? '炸彈客單獨獲勝！' : '村民勝利！';
      banner.className = 'end-banner ' + bannerClass;
      banner.innerHTML =
        '<div class="end-icon">' + bannerIcon + '</div>' +
        '<h2 class="end-title">' + bannerTitle + '</h2>' +
        '<p class="end-reason">' + Utils.escapeHtml(g.winReason||'') + '</p>';
    }

    var list = document.getElementById('ww-role-reveal-list');
    if (!list) return;
    var deathLog  = g.deathLog || {};
    var lovers    = g.lovers || [];
    var cupidId   = g.cupidId;
    var loverTeam = g.loverTeam;
    var thirdPids = loverTeam === 'third' ? [...new Set([cupidId, ...lovers].filter(Boolean))] : [];

    // Group: alive first, dead below
    var entries = Object.entries(g.roles||{});
    var alive   = entries.filter(([pid]) => !!(g.alive||{})[pid]);
    var dead    = entries.filter(([pid]) => !(g.alive||{})[pid]);

    var makeRow = function([pid, roleId]) {
      var p     = players[pid] || {};
      var role  = ROLES[roleId] || ROLES.villager;
      var isDead = !(g.alive||{})[pid];
      var cause = deathLog[pid] || '';
      var isLover = lovers.includes(pid);
      var isCupidThird = thirdPids.includes(pid);
      var loverBadge = isLover ? '<span class="rr-lover-badge">💕 情侶</span>' : '';
      var thirdBadge = isCupidThird && roleId === 'cupid' ? '<span class="rr-lover-badge">💘 邱比特</span>' : '';
      // For display: if third-party, show effective team
      var effectiveTeamClass = thirdPids.includes(pid) ? 'third' : role.team;
      return '<div class="rr-row ' + (isDead?'rr-dead-row':'') + ' team-' + effectiveTeamClass + '">' +
        '<div class="rr-avatar-wrap">' +
          '<div class="rr-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
          (isDead ? '<div class="rr-skull">💀</div>' : '') +
        '</div>' +
        '<div class="rr-info">' +
          '<div class="rr-name">' + Utils.escapeHtml(p.name||pid) + loverBadge + thirdBadge + '</div>' +
          (isDead && cause ? '<div class="rr-cause">' + Utils.escapeHtml(cause) + '</div>' : '') +
        '</div>' +
        '<div class="rr-role-badge team-badge-' + effectiveTeamClass + '">' + role.icon + ' ' + role.name + '</div>' +
        '<div class="rr-status">' + (isDead ? '<span class="rr-dead">已出局</span>' : '<span class="rr-alive">存活</span>') + '</div>' +
      '</div>';
    };

    list.innerHTML =
      '<div class="rr-section-label">🏆 存活玩家</div>' +
      (alive.length ? alive.map(makeRow).join('') : '<div class="rr-empty">（無）</div>') +
      '<div class="rr-section-label rr-dead-label">☠️ 出局玩家</div>' +
      (dead.length  ? dead.map(makeRow).join('')  : '<div class="rr-empty">（無）</div>');
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
    this._ui._initSpecToggle();  // expose window._specToggle for spectator role reveal

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
