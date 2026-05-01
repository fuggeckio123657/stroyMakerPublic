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
  gravedigger: { id:'gravedigger', name:'守墓人', team:'village', icon:'⚰️', desc:'第二夜起可得知上一白天投票放逐出局玩家的陣營。被狼人刀死、女巫毒死、或獵人射死者不算；若無人被投出局，則無任何訊息。' },
  hiddenwolf : { id:'hiddenwolf', name:'隱狼',   team:'wolf',    icon:'🥷', desc:'狼人陣營。預言家查驗顯示「好人」（金水）。初始不參與狼人夜間投票。所有普通狼/狼王全部出局後，於下一個夜晚「覺醒」，獨自獲得開刀能力。隱狼知道自己的狼隊友是誰，但狼隊友不知道隱狼身份。' },
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
  HUNTER_PASS      : 'ww_hunter_pass_shot',  // hunter forfeits their shot
  HUNTER_DECIDE    : 'ww_hunter_decide',       // hunter privately decides to shoot (triggers public phase)
  WOLFKING_PASS    : 'ww_wolfking_pass',      // wolfking forfeits takedown
  CUPID_SELECT     : 'ww_cupid_select',   // cupid toggles a lover candidate
  CUPID_CONFIRM    : 'ww_cupid_confirm',  // cupid locks in the pair
  LOVER_ACK        : 'ww_lover_ack',      // lover dismisses the notification
  NIGHT_DONE       : 'ww_night_done',     // passive/gravedigger confirm done
  VOTE             : 'ww_vote',           // select/change candidate (unlocked)
  VOTE_LOCK        : 'ww_vote_lock',      // lock your current selection
  VOTE_UNLOCK      : 'ww_vote_unlock',    // unlock to re-select
  VOTE_ABSTAIN     : 'ww_vote_abstain',   // abstain (auto-locks)
  DISCUSS_READY    : 'ww_discuss_ready',
  HOST_FORCE_VOTE  : 'ww_host_force_vote',// host forces vote phase
  START_NIGHT      : 'ww_start_night',
  START_DISCUSS    : 'ww_start_discuss',
  WW_RETURN_LOBBY      : 'ww_return_lobby',
  HIDDENWOLF_SHOOT     : 'ww_hiddenwolf_shoot',   // hiddenwolf awakened solo kill
  HIDDENWOLF_PASS      : 'ww_hiddenwolf_pass',    // hiddenwolf passes their kill
  HIDDENWOLF_CONFIRM   : 'ww_hiddenwolf_confirm', // hiddenwolf locks in their kill choice
};

// Sentinel value for abstain votes
const VOTE_ABSTAIN_ID = '__abstain__';

// Which roles have active night tasks (must confirm before night ends)
const NIGHT_ACTIVE_ROLES = new Set(['wolf','wolfking','seer','witch','cupid','hiddenwolf']);

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
    const palette = [
      // Vivid / bright
      '#e85d4a','#f0a500','#2ec4b6','#7b61ff','#ff6b9d','#00c896',
      '#ff7f3f','#3a86ff','#ff006e','#8ecae6','#06d6a0','#ffd166',
      // Mid-tone
      '#c9a84c','#4ac0a0','#9b85e8','#e07050','#60b0e8','#80c870',
      '#c080c8','#d4807a','#5ba4cf','#e8845e','#7ec8a4','#b088d8',
      // Dark / moody
      '#7c4daa','#1a6b8a','#8b3a3a','#2d6a4f','#4a4a8a','#7a5c2a',
      '#5c2d6e','#1b5e5e','#6b4226','#3d3d7a','#4d6b2a','#7a2d5c',
    ];
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
  hunterDecidePending  : null,  // { pid, cause } — hunter privately deciding whether to shoot
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
  gravediggerLog       : [],             // [{round, pid, name, team}] — vote-eliminated per round
  // ── HiddenWolf ───────────────────────────────────────────
  hiddenwolfAwakened   : false,          // true once all normal wolves are dead and hw can kill
  hiddenwolfShot       : null,           // pid hw killed this night (resolved in _resolveNight)
  hiddenwolfDone       : false,          // hw confirmed action this night
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
    wwConfig   : { roles: { wolf:2, wolfking:0, seer:1, witch:1, hunter:1, knight:0, bomber:0, cupid:0, hiddenwolf:0 }, nightTime: 30, voteTime: 60 },
    madlibConfig: { answerTime: 45 },
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
    // NOTE: We intentionally do NOT set rooms/<code>.onDisconnect().remove() here.
    // Doing so causes the entire room to be deleted when the host disconnects, which
    // triggers the kick listener for all other players.
    // Room cleanup is handled by _watchRoomEmpty (watches /players child_removed).
    this._registerRoomCleanup(code, hostId);
  }

  async addPlayer(code, pid, name, isSpectator) {
    await this.ref('rooms/' + code + '/players/' + pid).set({
      name, joinedAt: Date.now(), isSpectator: !!isSpectator,
    });
    this.ref('rooms/' + code + '/players/' + pid).onDisconnect().remove();
    this._registerRoomCleanup(code, pid);
  }

  // ── Explicit kick (host action only) ─────────────────
  // Write a dedicated /kicked/<pid> node instead of removing the player node directly.
  // Players watch this path; it never fires due to disconnect/reconnect.
  async kickPlayer(code, pid) {
    await this.ref('rooms/' + code + '/kicked/' + pid).set(Date.now());
    // Also remove their player node
    return this.ref('rooms/' + code + '/players/' + pid).remove()
      .catch(e => console.warn('[transport] kick:', e));
  }

  watchKicked(code, myId, cb) {
    const r = this.ref('rooms/' + code + '/kicked/' + myId);
    const h = r.on('value', snap => { if (snap.exists()) cb(); });
    transport._off.push(() => r.off('value', h));
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
      this._registerRoomCleanup(code, pid);
    });
    this._off.push(() => connRef.off('value', h));
  }

  // Register a per-player presence key with onDisconnect auto-remove.
  // Room cleanup is handled in watchPlayers (child_removed triggers empty check).
  _registerRoomCleanup(code, pid) {
    const presenceRef = this.ref('rooms/' + code + '/presence/' + pid);
    presenceRef.set(true);
    presenceRef.onDisconnect().remove();
  }

  // Room-empty watcher: watch PLAYERS node directly.
  // When any player's node is removed (by onDisconnect or hardLeave),
  // Firebase fires child_removed on all connected clients.
  // That handler checks if players is now empty and deletes the room.
  // This covers: last-player-presses-leave ✓, any-player closes browser ✓
  _watchRoomEmpty(code) {
    const playersRef = this.ref('rooms/' + code + '/players');
    const h = playersRef.on('child_removed', () => {
      playersRef.get().then(snap => {
        if (!snap.exists() || Object.keys(snap.val() || {}).length === 0) {
          this.ref('rooms/' + code).remove().catch(() => {});
        }
      }).catch(() => {});
    });
    this._off.push(() => playersRef.off('child_removed', h));
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

  // ── Task 3: Chat ───────────────────────────────────────
  pushChat(code, msg) {
    this.ref('rooms/' + code + '/chat').push(
      Object.assign({}, msg, { ts: Date.now() })
    ).catch(() => {});
  }

  watchChat(code, cb) {
    const r = this.ref('rooms/' + code + '/chat');
    // Load last 50 messages then listen for new ones
    const h = r.limitToLast(50).on('child_added', snap => {
      if (snap.exists()) cb(snap.val());
    });
    this._off.push(() => r.off('child_added', h));
  }

  // ── DM private chat ────────────────────────────────────
  // Path: rooms/<code>/dm/<sortedKey> where sortedKey = [pid1,pid2].sort().join('_')
  _dmKey(pid1, pid2) { return [pid1, pid2].sort().join('_'); }

  pushDM(code, fromId, toId, msg) {
    const key = this._dmKey(fromId, toId);
    this.ref('rooms/' + code + '/dm/' + key).push(
      Object.assign({}, msg, { ts: Date.now() })
    ).catch(() => {});
  }

  watchDM(code, myId, targetId, cb) {
    const key = this._dmKey(myId, targetId);
    const r   = this.ref('rooms/' + code + '/dm/' + key);
    const h   = r.limitToLast(80).on('child_added', snap => {
      if (snap.exists()) cb(snap.val());
    });
    this._off.push(() => r.off('child_added', h));
    return () => r.off('child_added', h);
  }

  // ── DM Inbox (notification-only path) ─────────────────────────────
  // /rooms/<code>/dm_inbox/<toId>/<fromId> = { fromName, ts }
  // Written on send → recipient gets red dot regardless of active watcher.
  // Uses startAt(joinTs) so old notifications from prior sessions don't fire.

  writeDMInbox(code, fromId, fromName, toId) {
    this.ref('rooms/' + code + '/dm_inbox/' + toId + '/' + fromId)
      .set({ fromName: fromName, ts: Date.now() })
      .catch(() => {});
  }

  clearDMInbox(code, myId, fromId) {
    this.ref('rooms/' + code + '/dm_inbox/' + myId + '/' + fromId)
      .remove().catch(() => {});
  }

  // Watch dm_inbox with timestamp filter — no remove needed, stale entries ignored.
  watchDMInbox(code, myId, minTs, cb) {
    var self2 = this;
    var r = this.ref('rooms/' + code + '/dm_inbox/' + myId);
    // orderByChild('ts').startAt(minTs) ensures only NEW notifications fire
    var h1 = r.orderByChild('ts').startAt(minTs).on('child_added', function(snap) {
      if (snap.exists()) cb(snap.key, snap.val());
    });
    var h2 = r.orderByChild('ts').startAt(minTs).on('child_changed', function(snap) {
      if (snap.exists()) cb(snap.key, snap.val());
    });
    self2._off.push(function() {
      r.off('child_added',  h1);
      r.off('child_changed', h2);
    });
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
    store.set({ myId, myName: playerName, roomCode, isHost: true, hostId: myId, isSpectator: false, joinTs: Date.now() });
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
    const wwStarted     = gd && gd.gameType === 'werewolf' && gd.wwPhase && gd.wwPhase !== 'role_reveal';
    const storyStarted  = gd && gd.phase && gd.phase !== PHASE.WAITING;
    const chaosStarted  = gd && gd.gameType === 'chaos'  && gd.chaosPhase && gd.chaosPhase !== 'write_sentence';
    const madlibStarted = gd && gd.gameType === 'madlib' && !!gd.mlPhase;
    const isSpectator = !!(wwStarted || storyStarted || chaosStarted || madlibStarted);

    const myId = Utils.genId();
    store.set({ myId, myName: playerName, roomCode, isHost: false, hostId, isSpectator, joinTs: Date.now() });
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
    // Player presence
    transport.watchPlayers(
      roomCode,
      (pid, data) => bus.emit(EVT.PLAYER_JOINED,  { id: pid, name: data.name, isSpectator: !!data.isSpectator, joinedAt: data.joinedAt || 0 }),
      (pid)       => bus.emit(EVT.PLAYER_LEFT,    { id: pid }),
      (pid, data) => bus.emit(EVT.PLAYER_CHANGED, { id: pid, name: data.name, isSpectator: !!data.isSpectator }),
    );

    // Room-empty watcher
    transport._watchRoomEmpty(roomCode);

    // Game state
    transport.watchGameState(roomCode, game => {
      if (store.get().isHost) return;
      bus.emit(EVT.GAME_STATE_UPDATED, { state: game });
    });

    // Settings sync
    if (!isHost) {
      transport.watchSettings(roomCode, settings => {
        bus.emit(EVT.SETTINGS_UPDATED, { settings });
      });
    }

    // Actions
    if (isHost) this.startWatchingActions();

    // Task 3: Chat — all clients watch chat
    transport.watchChat(roomCode, msg => {
      bus.emit('chat:message', { msg });
    });

    // Kick detection: watch a dedicated /kicked/<myId> node.
    // Only ever written by an explicit host kick action — never fires on disconnect/reconnect.
    transport.watchKicked(roomCode, myId, () => {
      const s = store.get();
      if (s.roomCode === roomCode && s.myId === myId) {
        bus.emit('room:kicked');
      }
    });
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

  _onJoin({ id, name, isSpectator, joinedAt }) {
    const { players, myId, myName, hostId, joinTs } = store.get();
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
    if (id === myId) {
      // Show success-join toast only when joining (not creating — host shows no toast here)
      // joinTs is set just before addPlayer, so joinedAt should be >= joinTs for our own node.
      // We show the toast here (on the PLAYER_JOINED event for self) so it fires after any
      // initial-load child_added events, avoiding ordering issues.
      if (!store.get().isHost) {
        bus.emit(EVT.TOAST, { msg: '✅ 成功加入：房間代碼：' + store.get().roomCode, type: 'success' });
      }
    } else {
      // Only show "xxx 加入了房間" for players who joined AFTER we did.
      // joinedAt comes from Firebase data; joinTs is when we started listening.
      // If joinedAt is before our joinTs, it's an initial-load event (existing room member).
      const myJoinTs = joinTs || 0;
      if ((joinedAt || 0) >= myJoinTs) {
        bus.emit(EVT.TOAST, { msg: name + ' 加入了房間', type: 'info' });
      }
    }
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
      if (t <= 0) {
        this.stopTimer();
        // Track the timer-triggered advance so checkAllLocked can cancel it
        clearTimeout(storyRelay._timerAdvTimer);
        storyRelay._timerAdvTimer = setTimeout(() => storyRelay.advance(), 3000);
      }
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
  constructor() { this._advTimer = null; this._timerAdvTimer = null; }

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
    // Cancel any timer-scheduled advance (prevents double-advance after auto-lock)
    clearTimeout(this._timerAdvTimer); this._timerAdvTimer = null;
    clearTimeout(this._advTimer);      this._advTimer = null;
    gameEngine.stopTimer();
    const { game, players } = store.get();
    // Guard: only advance if still in WRITING phase
    if (!game || game.phase !== PHASE.WRITING) return;
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
    else if (t === WW_ACTION.HUNTER_PASS)      this._hunterPass(pid);
    else if (t === WW_ACTION.HUNTER_DECIDE)    this._hunterDecide(pid);
    else if (t === WW_ACTION.WOLFKING_PASS)    this._wolfkingPass(pid);
    else if (t === WW_ACTION.CUPID_SELECT)     this._cupidSelect(pid, a.targetId);
    else if (t === WW_ACTION.CUPID_CONFIRM)    this._cupidConfirm(pid);
    else if (t === WW_ACTION.LOVER_ACK)        this._loverAck(pid);
    else if (t === WW_ACTION.NIGHT_DONE)       this._nightDoneAck(pid);
    else if (t === WW_ACTION.VOTE)             this._voteSelect(pid, a.targetId);
    else if (t === WW_ACTION.VOTE_LOCK)        this._voteLock(pid);
    else if (t === WW_ACTION.VOTE_UNLOCK)      this._voteUnlock(pid);
    else if (t === WW_ACTION.VOTE_ABSTAIN)     this._voteSelect(pid, VOTE_ABSTAIN_ID), this._voteLock(pid);
    else if (t === WW_ACTION.DISCUSS_READY)    this._discussReady(pid);
    else if (t === WW_ACTION.HOST_FORCE_VOTE)  this._hostForceVote();
    else if (t === WW_ACTION.START_NIGHT)      this._startNight();
    else if (t === WW_ACTION.START_DISCUSS)    this._startDiscuss();
    else if (t === WW_ACTION.WW_RETURN_LOBBY)  roomManager.returnToLobby();
    else if (t === WW_ACTION.HIDDENWOLF_SHOOT)   this._hiddenwolfShoot(pid, a.targetId);
    else if (t === WW_ACTION.HIDDENWOLF_PASS)    this._hiddenwolfPass(pid);
    else if (t === WW_ACTION.HIDDENWOLF_CONFIRM) this._hiddenwolfConfirm(pid);
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
    this.stopVoteTimer();

    // Pre-confirm cupid on rounds > 1 (their action only applies round 1)
    const preConfirm = {};
    if (g.cupidId && g.cupidDone) preConfirm[g.cupidId] = true;

    // ── HiddenWolf awakening check ────────────────────────
    // Check if hiddenwolf should awaken: awakened when ALL normal kill-capable wolves are dead.
    // Kill-capable wolves = wolf + wolfking (NOT hiddenwolf itself).
    const hwPid = Object.keys(g.roles || {}).find(id => g.roles[id] === 'hiddenwolf');
    const aliveNormalWolves = Object.keys(g.roles || {}).filter(
      id => g.alive[id] && (g.roles[id] === 'wolf' || g.roles[id] === 'wolfking')
    );
    // hiddenwolf awakens if: hw exists, hw is alive, all normal wolves are dead
    const hwAwakened = !!(hwPid && g.alive[hwPid] && aliveNormalWolves.length === 0);

    // Pre-confirm hiddenwolf if NOT awakened (not yet able to kill)
    if (hwPid && g.alive[hwPid] && !hwAwakened) preConfirm[hwPid] = true;

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
      nightConfirmed       : preConfirm,
      discussReady         : {},
      votes                : {},
      voteLocked           : {},
      voteEliminated       : null,
      nightTimeLeft        : g.nightTime,
      hiddenwolfAwakened   : hwAwakened,
      hiddenwolfShot       : null,
      hiddenwolfDone       : false,
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
    const alivePids   = Object.keys(g.alive).filter(id => g.alive[id]);
    const needsAction = alivePids.filter(pid => NIGHT_ACTIVE_ROLES.has(g.roles[pid]));
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
    if (r !== 'wolf' && r !== 'wolfking') return;  // hiddenwolf excluded from wolf vote
    // Target must be alive (wolves CAN vote for themselves or fellow wolves)
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
    if (g.roles[pid] !== 'wolf' && g.roles[pid] !== 'wolfking') return;  // hw excluded
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
    // hiddenwolf appears as 'good' to seer (golden water passive)
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
    // If poison already selected this night, cancel it first (one potion per night)
    const newSave = !g.witchSave;
    store.patchGame({ witchSave: newSave, witchPoison: newSave ? null : g.witchPoison });
    this.broadcast();
  }

  _witchPoison(pid, targetId) {
    const g = store.get().game;
    if (g.wwPhase !== 'night' || g.witchDone) return;
    if (g.roles[pid] !== 'witch' || g.witchPoisonUsed) return;
    if (targetId && !g.alive[targetId]) return;
    // Cannot poison self
    if (targetId === pid) return;
    // If save already selected this night, cancel it first (one potion per night)
    const newTarget = g.witchPoison === targetId ? null : targetId;
    store.patchGame({ witchPoison: newTarget, witchSave: newTarget ? false : g.witchSave });
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
    const isWolf = r => r === 'wolf' || r === 'wolfking' || r === 'hiddenwolf';
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

    // HiddenWolf solo kill (only when awakened)
    // witchSave blocks hw kill too (witch sees target but not identity of killer)
    if (g.hiddenwolfAwakened && g.hiddenwolfShot && alive[g.hiddenwolfShot] && !g.witchSave) {
      alive[g.hiddenwolfShot] = false;
      died.push(g.hiddenwolfShot);
      deathLog[g.hiddenwolfShot] = '被狼人獵殺';  // displayed as generic wolf kill (identity hidden)
    }

    // Check if hunter was wolf-killed (not witch) → will trigger special after announce
    const hunterWolfKilled = (g.wolfTarget && !g.witchSave && g.roles[g.wolfTarget] === 'hunter')
      || (g.hiddenwolfAwakened && g.hiddenwolfShot && g.roles[g.hiddenwolfShot] === 'hunter');

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
      hiddenwolfShot: null,
    });
    this.broadcast();
    setTimeout(() => {
      if (this._checkWin()) return;
      if (hunterWolfKilled) {
        // Hunter gets private decision before public reveal
        const hunterPid = g.wolfTarget;
        store.patchGame({ hunterDecidePending: { pid: hunterPid, cause: 'wolf' } });
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
    const isWolf     = targetRole === 'wolf' || targetRole === 'wolfking' || targetRole === 'hiddenwolf';
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

    // Task 6: Record for gravedigger — determine team of eliminated
    // hiddenwolf belongs to wolf team but ROLES has team:'wolf', so no special case needed.
    const elimRole = ROLES[role] || ROLES.villager;
    const { players } = store.get();
    const gravediggerLog = [...(g.gravediggerLog || []), {
      round : g.wwRound,
      pid   : eliminated,
      name  : (players[eliminated] || {}).name || eliminated,
      team  : elimRole.team,  // hiddenwolf → 'wolf' (correctly identified for gravedigger)
    }];

    store.patchGame({ alive, deathLog, wwPhase: 'vote_result', voteEliminated: eliminated, voteVoters: voters, abstainCount, gravediggerLog });
    this.broadcast();
    setTimeout(() => {
      if (this._checkWin()) return;
      if (role === 'hunter') {
        store.patchGame({ hunterDecidePending: { pid: eliminated, cause: 'vote' } });
        this.broadcast();
      } else {
        this._startNight();
      }
    }, 3500);
  }

  // ── HiddenWolf ───────────────────────────────────────────

  _hiddenwolfShoot(pid, targetId) {
    const g = store.get().game;
    if (g.wwPhase !== 'night') return;
    if (g.roles[pid] !== 'hiddenwolf' || !g.alive[pid]) return;
    if (!g.hiddenwolfAwakened) return;  // not yet awakened
    if (g.hiddenwolfDone) return;       // already acted this night
    if (!g.alive[targetId] || targetId === pid) return;
    // Toggle: click same target to deselect
    const newShot = g.hiddenwolfShot === targetId ? null : targetId;
    store.patchGame({ hiddenwolfShot: newShot });
    this.broadcast();
  }

  _hiddenwolfPass(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'night') return;
    if (g.roles[pid] !== 'hiddenwolf' || !g.alive[pid]) return;
    if (!g.hiddenwolfAwakened) return;
    if (g.hiddenwolfDone) return;
    // Pass: confirm without killing
    store.patchGame({ hiddenwolfShot: null });
    this._confirmPlayer(pid);
  }

  // Called when hw confirms their kill choice
  _hiddenwolfConfirm(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'night') return;
    if (g.roles[pid] !== 'hiddenwolf' || !g.alive[pid]) return;
    if (!g.hiddenwolfAwakened) return;
    if (g.hiddenwolfDone) return;
    store.patchGame({ hiddenwolfDone: true });
    this._confirmPlayer(pid);
  }

  // ── WolfKing posthumous ───────────────────────────────

  _wolfkingSecret(pid, targetId) {
    const g = store.get().game;
    if ((g.roles || {})[pid] !== 'wolfking') return;
    if ((g.alive || {})[pid]) return;
    if (g.wolfkingSecretReady) return;
    if (!g.alive[targetId]) return;
    // Witch-killed wolfking cannot use ability
    if ((g.deathLog || {})[pid] === '被女巫毒殺') return;
    store.patchGame({ wolfkingSecretTarget: targetId, wolfkingSecretReady: true });
    this.broadcast();
  }

  _hunterPass(pid) {
    const g = store.get().game;
    // Can pass from either private decide phase or public special phase
    const hdp = g.hunterDecidePending;
    const sp  = g.specialPending;
    if (hdp && hdp.pid === pid) {
      // Private decision: hunter chose not to shoot — silent death
      const cause = hdp.cause || 'vote';
      store.patchGame({ hunterDecidePending: null, hunterShot: true });
      this.broadcast();
      if (!this._checkWin()) {
        if (cause === 'wolf') setTimeout(() => this._startDiscuss(), 2000);
        else setTimeout(() => this._startNight(), 2000);
      }
      return;
    }
    if (sp && sp.type === 'hunter' && sp.pid === pid) {
      const cause = sp.cause || 'vote';
      store.patchGame({ specialPending: null, hunterShot: true });
      this.broadcast();
      if (!this._checkWin()) {
        if (cause === 'wolf') setTimeout(() => this._startDiscuss(), 2000);
        else setTimeout(() => this._startNight(), 2000);
      }
    }
  }

  _hunterDecide(pid) {
    // Hunter chose to shoot — escalate to public special phase
    const g = store.get().game;
    const hdp = g.hunterDecidePending;
    if (!hdp || hdp.pid !== pid) return;
    store.patchGame({
      hunterDecidePending: null,
      wwPhase: 'special',
      specialPending: { type: 'hunter', pid: hdp.pid, cause: hdp.cause },
      hunterCanShoot: true, hunterShootCause: hdp.cause,
    });
    this.broadcast();
  }

  _wolfkingPass(pid) {
    const g = store.get().game;
    if (g.wwPhase !== 'special') return;
    const sp = g.specialPending;
    if (!sp || sp.type !== 'wolfking' || sp.pid !== pid) return;
    store.patchGame({ specialPending: null }); this.broadcast();
    if (!this._checkWin()) setTimeout(() => this._startNight(), 2000);
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

    const isWolf = id => roles[id] === 'wolf' || roles[id] === 'wolfking' || roles[id] === 'hiddenwolf';
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

const CHAOS_ACTION = {
  SUBMIT_SENTENCE  : 'chaos_submit_sentence',
  UNSUBMIT_SENTENCE: 'chaos_unsubmit_sentence',
  SUBMIT_RULE      : 'chaos_submit_rule',
  UNSUBMIT_RULE    : 'chaos_unsubmit_rule',
  SUBMIT_MODIFY    : 'chaos_submit_modify',
  UNSUBMIT_MODIFY  : 'chaos_unsubmit_modify',
  VOTE_CARD        : 'chaos_vote_card',       // select rating for current card
  CONFIRM_CARD     : 'chaos_confirm_card',    // lock vote for current card
  BONUS_VOTE       : 'chaos_bonus_vote',      // favourite overall (any time during vote_reveal)
  HOST_NEXT_ROUND  : 'chaos_next_round',
  END_REVEAL_NEXT  : 'chaos_end_reveal_next',
  REACT            : 'chaos_react',           // emoji reaction
  RETURN_LOBBY     : 'chaos_return_lobby',
};

const CHAOS_SCORE = { violation: -500, npc: -100, normal: 100, great: 300, goat: 500 };

// chaosPhase: write_sentence | write_rule | rule_reveal | modify | vote_reveal | round_result | end
const makeChaosGame = () => ({
  gameType          : 'chaos',
  chaosPhase        : 'write_sentence',
  chaosRound        : 1,
  totalRounds       : 5,
  writeTime         : 60,
  modifyTime        : 60,
  voteTime          : 20,   // seconds per card
  timeLeft          : 60,
  sentences         : {},
  rules             : {},
  selectedRule      : '',
  selectedRuleAuthor: null,
  assignments       : {},
  revealOrder       : [],   // shuffled editorPid array
  voteCardIndex     : 0,    // which card is currently being voted on
  modifications     : {},
  // votes[voterPid][editorPid] = 'violation'|'normal'|'great'
  votes             : {},
  // cardConfirmed[voterPid] = true when they locked vote for current card
  cardConfirmed     : {},
  bonusVotes        : {},   // { voterPid: editorPid } — cancellable
  scores            : {},
  roundScores       : {},
  bonusScores       : {},
  greatCounts       : {},
  violationCounts   : {},
  endRevealStep     : 0,
  reactions         : {},   // { pid: emoji } — live emoji reactions during reveal
});

// ═══════════════════════════════════════════════════════════════════════
// LAYER 10c ─ Chaos Engine (規則混亂)
// ═══════════════════════════════════════════════════════════════════════

class ChaosEngine {
  constructor() {
    this._timer = null;
    bus.on(EVT.ACTION_RECEIVED, ({ action }) => {
      if (!store.get().isHost) return;
      if ((store.get().game || {}).gameType !== 'chaos') return;
      this._dispatch(action);
    });
  }

  _dispatch(a) {
    const t = a.type, pid = a.playerId;
    if      (t === CHAOS_ACTION.SUBMIT_SENTENCE)   this._submitSentence(pid, a.text);
    else if (t === CHAOS_ACTION.UNSUBMIT_SENTENCE)  this._unsubmitSentence(pid);
    else if (t === CHAOS_ACTION.SUBMIT_RULE)        this._submitRule(pid, a.text);
    else if (t === CHAOS_ACTION.UNSUBMIT_RULE)      this._unsubmitRule(pid);
    else if (t === CHAOS_ACTION.SUBMIT_MODIFY)      this._submitModify(pid, a.text);
    else if (t === CHAOS_ACTION.UNSUBMIT_MODIFY)    this._unsubmitModify(pid);
    else if (t === CHAOS_ACTION.VOTE_CARD)          this._voteCard(pid, a.rating);
    else if (t === CHAOS_ACTION.CONFIRM_CARD)       this._confirmCard(pid);
    else if (t === CHAOS_ACTION.BONUS_VOTE)         this._bonusVote(pid, a.targetPid);
    else if (t === CHAOS_ACTION.HOST_NEXT_ROUND)    this._hostNextRound();
    else if (t === CHAOS_ACTION.END_REVEAL_NEXT)    this._endRevealNext();
    else if (t === CHAOS_ACTION.REACT)              this._react(pid, a.emoji);
    else if (t === CHAOS_ACTION.RETURN_LOBBY)       this._returnLobby();
  }

  startGame(cfg) {
    const { players } = store.get();
    const pids = Object.keys(players).filter(pid => !players[pid].isSpectator);
    const z = (k) => { const o = {}; pids.forEach(p => o[p] = k); return o; };
    store.replaceGame(Object.assign(makeChaosGame(), {
      totalRounds: cfg.totalRounds || 5, writeTime: cfg.writeTime || 60,
      modifyTime: cfg.modifyTime || 60,  voteTime: cfg.voteTime || 20,
      timeLeft: cfg.writeTime || 60, chaosRound: 1, chaosPhase: 'write_sentence',
      scores: z(0), greatCounts: z(0), violationCounts: z(0), bonusScores: z(0),
      gameStartTs: Date.now(),   // unique key per game — forces input reset
    }));
    this.broadcast();
    this._startTimer(cfg.writeTime || 60, () => this._resolveWriteSentence());
  }

  // ── write_sentence ────────────────────────────────────

  _submitSentence(pid, text) {
    const g = store.get().game;
    if (g.chaosPhase !== 'write_sentence') return;
    store.patchGame({ sentences: Object.assign({}, g.sentences, { [pid]: text || '（未輸入）' }) });
    this.broadcast();
    const fresh = store.get().game;
    if (this._activePids().every(p => fresh.sentences[p])) { this.stopTimer(); this._resolveWriteSentence(); }
  }

  _unsubmitSentence(pid) {
    const g = store.get().game;
    if (g.chaosPhase !== 'write_sentence') return;
    const sentences = Object.assign({}, g.sentences); delete sentences[pid];
    store.patchGame({ sentences }); this.broadcast();
  }

  _resolveWriteSentence() {
    const g = store.get().game; const pids = this._activePids();
    const sentences = Object.assign({}, g.sentences);
    pids.forEach(p => { if (!sentences[p]) sentences[p] = '（未輸入）'; });
    store.patchGame({ chaosPhase: 'write_rule', sentences, rules: {}, timeLeft: g.writeTime });
    this.broadcast();
    this._startTimer(g.writeTime, () => this._resolveWriteRule());
  }

  // ── write_rule ────────────────────────────────────────

  _submitRule(pid, text) {
    const g = store.get().game;
    if (g.chaosPhase !== 'write_rule') return;
    store.patchGame({ rules: Object.assign({}, g.rules, { [pid]: text || '句子要很有趣' }) });
    this.broadcast();
    const fresh = store.get().game;
    if (this._activePids().every(p => fresh.rules[p])) { this.stopTimer(); this._resolveWriteRule(); }
  }

  _unsubmitRule(pid) {
    const g = store.get().game;
    if (g.chaosPhase !== 'write_rule') return;
    const rules = Object.assign({}, g.rules); delete rules[pid];
    store.patchGame({ rules }); this.broadcast();
  }

  _resolveWriteRule() {
    const g = store.get().game; const pids = this._activePids();
    const sentences = Object.assign({}, g.sentences), rules = Object.assign({}, g.rules);
    pids.forEach(p => { if (!sentences[p]) sentences[p] = '（未輸入）'; if (!rules[p]) rules[p] = '句子要很有趣'; });
    const chosen = pids.map(p => ({ pid: p, rule: rules[p] }))[Math.floor(Math.random() * pids.length)] || { pid: null, rule: '句子要很有趣' };
    const shuffled = this._derange(pids);
    const assignments = {}; pids.forEach((p, i) => { assignments[shuffled[i]] = p; });
    const bonusScores = Object.assign({}, g.bonusScores); pids.forEach(p => { bonusScores[p] = 0; });
    store.patchGame({
      chaosPhase: 'rule_reveal', sentences, rules,
      selectedRule: chosen.rule, selectedRuleAuthor: chosen.pid,
      assignments, modifications: {}, revealOrder: [], voteCardIndex: 0,
      votes: {}, cardConfirmed: {}, bonusVotes: {}, roundScores: {}, bonusScores,
      reactions: {}, timeLeft: 3,
    });
    this.broadcast();
    // Count down 3→0 then start modify
    let t = 3;
    const tick = setInterval(() => {
      t = Math.max(0, t - 1);
      store.patchGame({ timeLeft: t });
      this.broadcast();
      if (t <= 0) { clearInterval(tick); this._startModify(); }
    }, 1000);
  }

  // ── modify ────────────────────────────────────────────

  _startModify() {
    const g = store.get().game;
    store.patchGame({ chaosPhase: 'modify', timeLeft: g.modifyTime });
    this.broadcast();
    this._startTimer(g.modifyTime, () => this._resolveModify());
  }

  _submitModify(pid, text) {
    const g = store.get().game;
    if (g.chaosPhase !== 'modify') return;
    store.patchGame({ modifications: Object.assign({}, g.modifications, { [pid]: text || '（未修改）' }) });
    this.broadcast();
    const fresh = store.get().game;
    if (this._activePids().every(p => fresh.modifications[p])) { this.stopTimer(); this._resolveModify(); }
  }

  _unsubmitModify(pid) {
    const g = store.get().game;
    if (g.chaosPhase !== 'modify') return;
    const modifications = Object.assign({}, g.modifications); delete modifications[pid];
    store.patchGame({ modifications }); this.broadcast();
  }

  _resolveModify() {
    const g = store.get().game; const pids = this._activePids();
    const modifications = Object.assign({}, g.modifications);
    pids.forEach(p => { if (!modifications[p]) modifications[p] = '（未修改）'; });
    const revealOrder = Utils.shuffle(pids.slice());
    store.patchGame({ chaosPhase: 'vote_reveal', modifications, revealOrder, voteCardIndex: 0, votes: {}, cardConfirmed: {}, bonusVotes: {}, reactions: {}, timeLeft: g.voteTime });
    this.broadcast();
    this._startTimer(g.voteTime, () => this._cardTimerExpired());
  }

  // ── vote_reveal: one card at a time with timer ─────────

  _voteCard(pid, rating) {
    const g = store.get().game;
    if (g.chaosPhase !== 'vote_reveal') return;
    if (!['violation','npc','normal','great','goat'].includes(rating)) return;
    const order   = g.revealOrder || [];
    const cardIdx = typeof g.voteCardIndex === 'number' ? g.voteCardIndex : 0;
    if (cardIdx >= order.length) return;
    const targetPid = order[cardIdx];
    if (targetPid === pid) return; // can't vote self
    // Store vote (overwrite if changes mind before confirming)
    const votes = Utils.deepClone(g.votes || {});
    if (!votes[pid]) votes[pid] = {};
    votes[pid][targetPid] = rating;
    store.patchGame({ votes }); this.broadcast();
  }

  _confirmCard(pid) {
    const g = store.get().game;
    if (g.chaosPhase !== 'vote_reveal') return;
    const order   = g.revealOrder || [];
    const cardIdx = typeof g.voteCardIndex === 'number' ? g.voteCardIndex : 0;
    if (cardIdx >= order.length) return;
    const targetPid = order[cardIdx];
    // Self-card: auto-confirm with no vote required
    const myVote  = (g.votes[pid] || {})[targetPid];
    if (targetPid !== pid && !myVote) return; // must have selected a rating first
    const cardConfirmed = Object.assign({}, g.cardConfirmed, { [pid]: true });
    store.patchGame({ cardConfirmed }); this.broadcast();
    // Check if all confirmed
    if (this._activePids().every(p => cardConfirmed[p])) {
      this.stopTimer(); this._advanceCard();
    }
  }

  _cardTimerExpired() {
    // Auto-confirm everyone who hasn't yet (give them violation or keep pending)
    this._advanceCard();
  }

  _advanceCard() {
    const g = store.get().game;
    const order   = g.revealOrder || [];
    const cardIdx = (typeof g.voteCardIndex === 'number' ? g.voteCardIndex : 0);
    const nextIdx = cardIdx + 1;
    if (nextIdx >= order.length) {
      // All cards done — resolve
      this._resolveVoteReveal();
      return;
    }
    store.patchGame({ voteCardIndex: nextIdx, cardConfirmed: {}, timeLeft: g.voteTime });
    this.broadcast();
    this._startTimer(g.voteTime, () => this._cardTimerExpired());
  }

  _bonusVote(pid, targetPid) {
    const g = store.get().game;
    if (g.chaosPhase !== 'vote_reveal') return;
    const bonusVotes = Object.assign({}, g.bonusVotes);
    if (bonusVotes[pid] === targetPid) delete bonusVotes[pid]; // toggle cancel
    else bonusVotes[pid] = targetPid;
    store.patchGame({ bonusVotes }); this.broadcast();
  }

  _react(pid, emoji) {
    const g = store.get().game;
    if (!['vote_reveal','round_result'].includes(g.chaosPhase)) return;
    const allowed = ['😂','🔥','💀','👏','😮','🤣','👎','💯'];
    if (!allowed.includes(emoji)) return;

    // If same emoji is already active, clear first then re-fire (creates new float)
    const cur0 = (g.reactions || {})[pid];
    const doFire = () => {
      const reactions = Object.assign({}, store.get().game.reactions, { [pid]: emoji });
      store.patchGame({ reactions }); this.broadcast();
      this._scheduleReactClear(pid, emoji);
    };
    if (cur0 === emoji) {
      // Clear existing, then re-fire on next tick so the float animation restarts
      const r0 = Object.assign({}, g.reactions); delete r0[pid];
      store.patchGame({ reactions: r0 }); this.broadcast();
      setTimeout(doFire, 50);
    } else {
      doFire();
    }
  }

  _scheduleReactClear(pid, emoji) {
    setTimeout(() => {
      const cur = store.get().game.reactions || {};
      if (cur[pid] === emoji) {
        const r2 = Object.assign({}, cur); delete r2[pid];
        store.patchGame({ reactions: r2 }); this.broadcast();
      }
    }, 3000);
  }

  _resolveVoteReveal() {
    const g = store.get().game; const pids = this._activePids();
    const votes = g.votes || {}, bonusVotes = g.bonusVotes || {};
    const roundScores = {}, bonusScores = {};
    const newGreat = Object.assign({}, g.greatCounts), newViol = Object.assign({}, g.violationCounts);
    pids.forEach(p => { roundScores[p] = 0; bonusScores[p] = 0; });
    pids.forEach(editorPid => {
      pids.forEach(voterPid => {
        if (voterPid === editorPid) return;
        const r = (votes[voterPid] || {})[editorPid]; if (!r) return;
        roundScores[editorPid] += CHAOS_SCORE[r] || 0;
        // Track "top" ratings (great/goat) and "bottom" ratings (violation/npc)
        if (r === 'great' || r === 'goat') newGreat[editorPid] = (newGreat[editorPid] || 0) + 1;
        if (r === 'violation' || r === 'npc') newViol[editorPid] = (newViol[editorPid] || 0) + 1;
      });
    });
    Object.values(bonusVotes).forEach(t => { if (bonusScores[t] !== undefined) bonusScores[t]++; });
    const newScores = Object.assign({}, g.scores);
    pids.forEach(p => { newScores[p] = (newScores[p] || 0) + roundScores[p]; });
    store.patchGame({ chaosPhase: 'round_result', roundScores, scores: newScores, bonusScores, greatCounts: newGreat, violationCounts: newViol });
    this.broadcast();
  }

  // ── round_result / end ────────────────────────────────

  _hostNextRound() {
    const g = store.get().game;
    if (g.chaosPhase !== 'round_result') return;
    if (g.chaosRound >= g.totalRounds) {
      store.patchGame({ chaosPhase: 'end', endRevealStep: 0 }); this.broadcast(); return;
    }
    store.patchGame({
      chaosPhase: 'write_sentence', chaosRound: g.chaosRound + 1,
      sentences: {}, rules: {}, selectedRule: '', selectedRuleAuthor: null,
      assignments: {}, modifications: {}, revealOrder: [], voteCardIndex: 0,
      votes: {}, cardConfirmed: {}, bonusVotes: {}, roundScores: {}, reactions: {},
      timeLeft: g.writeTime,
    });
    this.broadcast();
    this._startTimer(g.writeTime, () => this._resolveWriteSentence());
  }

  _endRevealNext() {
    const g = store.get().game;
    if (g.chaosPhase !== 'end') return;
    const pids = Object.keys(store.get().players).filter(id => !store.get().players[id].isSpectator);
    // Total steps = pids.length (one per player, last→first) + 2 (badges)
    const maxStep = pids.length + 2;
    store.patchGame({ endRevealStep: Math.min((g.endRevealStep || 0) + 1, maxStep) });
    this.broadcast();
  }

  _returnLobby() { store.replaceGame(makeGame()); this.broadcast(); bus.emit(EVT.RETURN_LOBBY); }

  // ── Helpers ───────────────────────────────────────────

  _activePids() { return Object.keys(store.get().players).filter(id => !store.get().players[id].isSpectator); }

  _derange(arr) {
    if (arr.length <= 1) return arr.slice();
    let r, tries = 0;
    do { r = Utils.shuffle(arr.slice()); tries++; } while (r.some((v, i) => v === arr[i]) && tries < 200);
    return r;
  }

  _startTimer(seconds, onExpire) {
    this.stopTimer();
    let t = seconds;
    this._timer = setInterval(() => {
      t = Math.max(0, t - 1); store.patchGame({ timeLeft: t }); this.broadcast();
      if (t <= 0) { this.stopTimer(); onExpire(); }
    }, 1000);
  }

  stopTimer() { clearInterval(this._timer); this._timer = null; }

  broadcast() { const { isHost, game, roomCode } = store.get(); if (!isHost) return; transport.pushGameState(roomCode, game); }

  sendAction(action) {
    const { isHost, myId, roomCode } = store.get();
    if (isHost) bus.emit(EVT.ACTION_RECEIVED, { action: Object.assign({}, action, { playerId: myId }) });
    else transport.pushAction(roomCode, Object.assign({}, action, { playerId: myId }));
  }
}


const wwEngine    = new WerewolfEngine();
const chaosEngine = new ChaosEngine();

// ═══════════════════════════════════════════════════════════════════════
// STORY COLLAPSE 故事崩壞中 — Templates & Engine
// ═══════════════════════════════════════════════════════════════════════

// ── Embedded Story Templates ──────────────────────────────────────────
// Each template: { id, title, desc, story (with {N} placeholders), prompts[] }
// To add templates: append to ML_TEMPLATES, or call MadlibTemplates.loadFromJSON(url).

const ML_TEMPLATES = [
  {
    id    : 'fantasy_001',
    title : '⚔️ 勇者的末日冒險',
    desc  : '一段充滿意外的奇幻英雄冒險故事',
    story : '在【{0}】王國的最邊疆，住著一位名叫【{1}】的【{2}】。某天，一隻巨大的【{3}】突然從天而降，口中噴出大量的【{4}】，將整座【{5}】夷為平地。村民們驚慌失措地大喊：「{6}！」只有{1}臨危不亂，緊緊握住手中的【{7}】，深吸一口氣，高喊：「{8}！」然後以【{9}】的速度衝了上去。激戰了整整【{10}】個小時後，{1}使出了最終絕技——【{11}】，怪物應聲倒地。從此，{1}的名字傳遍了整個王國，成為永恆的傳說。',
    prompts: [
      '一個王國名稱',
      '一個人名',
      '一種職業',
      '一種怪物或動物',
      '一種液體',
      '一種建築物或場所',
      '一句驚呼或求救聲（例如：救命啊！）',
      '一種武器或道具',
      '一句豪言壯語',
      '一個形容速度的詞（例如：閃電般）',
      '一個數字',
      '一個武術或技能招式名',
    ],
  },
  {
    id    : 'office_001',
    title : '💼 史上最慘的上班日',
    desc  : '一個職場小員工的終極悲慘遭遇',
    story : '【{0}】今天上班遲到了，因為路上突然出現一群【{1}】，把整條【{2}】堵得水洩不通。好不容易到了公司，主管【{3}】立刻衝出來大吼：「{4}！」{0}只好解釋：「對不起，我昨晚在家【{5}】太久了。」同事小李偷偷遞來一張紙條，上面寫著：「{6}。」下午簡報時，{0}的投影片突然全變成了【{7}】的圖案，全場陷入詭異的沉默。散會後，{0}一個人坐在茶水間，默默拿出【{8}】，開始【{9}】，心裡只有一個念頭：今天真是太【{10}】了。',
    prompts: [
      '一個人名',
      '一種動物（複數）',
      '一條路或地名',
      '一個主管或人名',
      '一句憤怒的斥責',
      '一個動詞活動（做什麼）',
      '一句奇怪或莫名其妙的建議',
      '一種生物或物品',
      '一種食物或飲料',
      '一個動詞活動（做什麼）',
      '一個負面形容詞',
    ],
  },
  {
    id    : 'space_001',
    title : '🚀 迷航星際探索隊',
    desc  : '人類首次接觸外星文明的震撼紀實',
    story : '西元【{0}】年，人類史上最勇敢的星際探索隊，終於抵達了傳說中的【{1}】星球。隊長【{2}】第一個踏出艙門，雙腳踩在【{3}】的地面上，情不自禁地大喊：「{4}！」突然，從遠處衝來一種叫做【{5}】的外星生物，它有【{6}】條腿，全身散發著【{7}】的氣味，看起來十分【{8}】。副隊長急忙拿出【{9}】，試圖【{10}】牠。就在千鈞一髮之際，外星生物張嘴，用流利的【{11}】語說：「{12}。」全體隊員目瞪口呆，人類的宇宙探索就此進入了全新紀元。',
    prompts: [
      '一個年份（數字）',
      '一個星球或地名',
      '一個人名',
      '一個形容地面質感的詞',
      '一句感嘆或驚呼聲',
      '一個自創外星生物名稱',
      '一個數字',
      '一種氣味的描述',
      '一個形容外表的詞',
      '一種道具或武器',
      '一個動詞（對動物做什麼）',
      '一種語言名稱（如：台語、火星語）',
      '一句外星語或奇怪的話',
    ],
  },
  {
  id    : 'story_001',
  title : '🙂 看似普通的一天',
  desc  : '一切都很正常，直到某些細節開始崩壞',
  story : '【{0}】今天原本打算去【{1}】，途中卻遇到一群【{2}】，讓整個行程被迫延後。抵達後，{0}發現【{3}】竟然變成了【{4}】，讓人不寒而慄。此時一位自稱【{5}】的人走過來，低聲說：「{6}。」{0}半信半疑，只好照做，結果引發了【{7}】。現場突然出現【{8}】，並開始【{9}】，所有人都愣住了。最後，{0}只能拿出【{10}】，試圖【{11}】，卻讓事情變得更加【{12}】。',
  prompts: [
      '一個人名',
      '一個地點',
      '一種動物（複數）',
      '一個物品',
      '一種物品',
      '一種職業',
      '一句奇怪的話',
      '一個事件',
      '一種東西（複數）',
      '一個動作',
      '一個物品',
      '一個動作',
      '一個形容詞',
    ],
  },
  {
  id    : 'story_002',
  title : '📦 神秘任務',
  desc  : '你只是接了一個任務，但事情不太對勁',
  story : '{0}接到來自【{1}】的委託，要前往【{2}】取得【{3}】。途中遇見【{4}】，對方警告：「{5}。」但{0}沒有理會，繼續前進。到達目的地後，發現【{6}】竟然被【{7}】包圍。情急之下，{0}使用【{8}】，成功觸發【{9}】。然而下一秒，整個場景變成【{10}】，讓人無法理解。最後，{0}只好決定【{11}】，希望一切不要太【{12}】。',
  prompts: [
      '一個人名',
      '一個組織或人名',
      '一個地點',
      '一個物品',
      '一個角色或生物',
      '一句警告',
      '一個物品',
      '一種生物（複數）',
      '一個物品',
      '一個事件',
      '一種場景',
      '一個行動',
      '一個形容詞',
    ],
  },
  {
  id    : 'story_003',
  title : '🫠 尷尬爆表的場合',
  desc  : '你只想正常互動，但事情越來越奇怪',
  story : '{0}今天被邀請參加【{1}】，一開始氣氛還算【{2}】。沒想到主持人突然點名：「{3}，來分享一下你的【{4}】！」{0}一時語塞，只能胡亂說：「{5}。」全場瞬間安靜。接著有人端出【{6}】，卻開始【{7}】，場面逐漸失控。旁邊的【{8}】悄悄說：「{9}。」但事情沒有好轉，反而出現【{10}】，讓整個場合變得更加【{11}】。最後，{0}只能假裝【{12}】，慢慢離開。',
  prompts: [
      '一個人名',
      '一個場合',
      '一個形容詞',
      '一個人名',
      '一個主題',
      '一句奇怪發言',
      '一種食物',
      '一個動作',
      '一種角色',
      '一句建議',
      '一個事件',
      '一個形容詞',
      '一個動作',
    ],
  },
  {
  id    : 'story_005',
  title : '🧠 那段奇怪的回憶',
  desc  : '你以為你記得，但其實…？',
  story : '{0}一直記得那天在【{1}】發生的事。當時天空是【{2}】，而周圍充滿【{3}】。有人對{0}說：「{4}。」接著出現【{5}】，開始【{6}】。那一刻，{0}手中握著【{7}】，卻不知道該不該【{8}】。回想起來，整件事充滿【{9}】，尤其是最後出現的【{10}】，讓一切變得【{11}】。直到現在，{0}仍然無法理解那到底是【{12}】。',
  prompts: [
      '一個人名',
      '一個地點',
      '一種顏色或形容',
      '一種東西（複數）',
      '一句話',
      '一個物體',
      '一個動作',
      '一個物品',
      '一個動作',
      '一個抽象名詞',
      '一個東西',
      '一個形容詞',
      '一個名詞',
    ],
  },
  {
  id    : 'story_006',
  title : '📈 情況逐漸升級',
  desc  : '一開始只是小問題，最後卻完全失控',
  story : '{0}原本只是想去【{1}】辦點事情，卻在路上看到【{2}】正在【{3}】。出於好奇，{0}停下來觀察，結果被【{4}】誤認為【{5}】。對方立刻大喊：「{6}！」場面瞬間混亂。有人開始拿出【{7}】，有人則開始【{8}】。不久後，【{9}】也加入，並導致【{10}】發生。{0}試圖用【{11}】來解決問題，但卻意外觸發【{12}】。整個現場變成【{13}】，甚至連【{14}】都出現了。最後，{0}只能【{15}】，心想這一切實在太【{16}】了。',
  prompts: [
      '一個人名',
      '一個地點',
      '一種東西（複數）',
      '一個動作',
      '一個角色',
      '一個身分',
      '一句大喊的話',
      '一個物品',
      '一個動作',
      '一個東西或角色',
      '一個事件',
      '一個物品',
      '一個事件',
      '一種場景',
      '一種東西（複數）',
      '一個行動',
      '一個形容詞',
    ],
  },
  {
  id: 'mystery_002',
  title: '🔍 沒人相信的都市傳說',
  desc: '關於那個神祕事件，大家的說法都不一樣。',
  story: '最近在【{2}】流傳著一個傳聞。據說只要你在深夜【{5}】的時候，手裡拿著【{7}】，大喊三聲：「{4}！」就會召喚出【{0}】。他會強迫你跟他一起【{9}】，直到你拿出【{8}】當作祭品。這聽起來很【{10}】，但【{3}】卻對此深信不疑。他甚至還在【{2}】裝設了【{1}】來捕捉證據。上週，他真的拍到了【{0}】正在【{6}】的畫面，全網都震驚了。',
  prompts: [
    '一個生物',             // 0
    '一種物品',             // 1
    '一個地名',             // 2
    '一個人名',             // 3
    '一句短語/口號',         // 4
    '一個時間點/動作',       // 5
    '一個動詞',             // 6
    '一個小東西',           // 7
    '一種消耗品',           // 8
    '一個動詞活動',         // 9
    '一個形容詞',           // 10
    ],
  },
  {
  id: 'chaos_003',
  title: '🍳 驚心動魄的職人時刻',
  desc: '這是一場關於專業、汗水與大災難的紀錄。',
  story: '今天【{0}】決定挑戰一項高難度任務：製作【{1}】。他先準備了大量的【{7}】，並將其放入【{2}】中攪拌。接著，為了增加風味，他偷偷加了一點【{8}】。這時，助教【{3}】走過來，嚴肅地提醒：「千萬別忘記要【{9}】！」話才說完，機器突然發出【{10}】的聲音，噴出了一堆【{11}】。現場變得很【{12}】，【{0}】只好拿起【{4}】，大叫：「{5}！」試圖挽救局面，最後卻只得到了一碗像【{6}】的東西。',
  prompts: [
    '一個人名',            // 0
    '一個名詞',         // 1
    '一個容器/空間',     // 2
    '一個職場稱呼',     // 3
    '長條狀物品',       // 4
    '一句大喊的話',     // 5
    '一種名詞（複數）',  // 6
    '一種材料',         // 7
    '一種液體',         // 8
    '一個動作',         // 9
    '一個擬聲詞',       // 10
    '一種東西',         // 11
    '一個形容詞',       // 12
    ],
  },
  {
  id: 'world_004',
  title: '🌌 歡迎來到新的世界',
  desc: '在出發冒險前，請先閱讀這份說明。',
  story: '歡迎來到【{2}】！在這裡，每個人出生時都會獲得一個【{1}】。我們的最高領袖是【{3}】，他最討厭有人【{9}】。如果你想在這裡生存，每天早上必須對著【{7}】【{5}】三分鐘。這裡的通用貨幣是【{8}】，雖然看起來很【{10}】，但非常好用。這裡唯一的禁忌是：絕對不能在【{6}】的時候使用【{4}】，否則你會變成一隻【{0}】。如果你準備好了，就跟我們一起【{11}】吧！',
  prompts: [
    '一種生物',         // 0
    '一種工具/配件',     // 1
    '一個地名/國家',     // 2
    '一個人物職稱',     // 3
    '一種手持物品',     // 4
    '一個動作',         // 5
    '一個場合/情境',     // 6
    '一個自然物',       // 7
    '一種小東西（複數）', // 8
    '一個形容詞',       // 9
    '一個形容詞',     // 10
    '一個動詞',         // 11
    ],
  },
  {
  id: 'history_001',
  title: '📜 消失的文明文獻',
  desc: '這份剛出土的羊皮紙，揭開了某個偉大時代的祕密。',
  story: '在【{2}】時代，最受人尊敬的職業其實是【{11}】。當時的統治者【{0}】為了慶祝【{14}】，下令全國人民必須帶著【{1}】去【{12}】。某天，一位名叫【{3}】的智者在【{4}】發現了【{7}】，他驚呼：「{5}！」這項發現改變了所有人【{9}】的方式。雖然當時的法律規定不能【{10}】，但大家還是私下在【{13}】。直到今天，當我們看到【{8}】時，依然會想起那段極其【{6}】的歲月。',
  prompts: [
    '一個名人',         // 0
    '一種生活用品',      // 1
    '一個時代/朝代',    // 2
    '一個人名',         // 3
    '一個具體地點',      // 4
    '一句感嘆詞/短語',   // 5
    '一個形容詞',       // 6
    '一個神祕物品',      // 7
    '一種自然現象/物',   // 8
    '一個動詞活動',      // 9
    '一個違法動作',      // 10
    '一個現代職稱',      // 11
    '一個動詞場所',      // 12
    '一個陰暗的地點',    // 13
    '一個節日或事件',    // 14
    ],
  },
  {
  id: 'show_001',
  title: '🎥 誰是最後贏家？',
  desc: '這場實境秀的發展已經超出了製作人的控制。',
  story: '歡迎收看《【{2}】大挑戰》！今天我們的挑戰者【{0}】要在不使用【{7}】的情況下，完成一項艱難的任務：【{9}】。現場評審【{3}】表示，他最看重的是挑戰者的【{10}】。比賽中途，【{0}】突然掏出【{1}】，對著攝影機大喊：「{5}！」這讓另一位選手【{11}】感到非常【{6}】，甚至開始【{13}】。最後，主辦單位送上了一份【{8}】作為獎勵，全場氣氛瞬間變得很【{12}】。節目組提醒：請勿在【{4}】模仿此行為。',
  prompts: [
    '一個人名',         // 0
    '一種小工具',       // 1
    '一個動詞名詞',     // 2
    '一位長輩或老師',   // 3
    '一個公共場所',     // 4
    '一句廣告詞',       // 5
    '一個情緒形容詞',   // 6
    '一種科技產品',     // 7
    '一種難吃的東西',   // 8
    '一個高難度動作',   // 9
    '一種抽象的人格特質',// 10
    '一個卡通角色',     // 11
    '一個感官形容詞',   // 12
    '一個奇怪的動作',   // 13
    ],
  },
  {
  id: 'letter_001',
  title: '✉️ 來自過去的時光膠囊',
  desc: '打開這封信時，你可能已經不再是當初那個你了。',
  story: '親愛的【{0}】：你好嗎？寫這封信時，我正坐在【{2}】裡【{5}】。希望未來的你已經學會了如何【{9}】，並且擁有一台【{1}】。別忘了小時候【{3}】曾對你說過：「{4}。」那是我們最【{10}】的回憶。雖然現在的生活充滿了【{7}】，但只要想到【{8}】，我就能繼續【{6}】下去。祝你天天都能像【{11}】一樣開心！',
  prompts: [
    '一個暱稱',       // 0
    '一種昂貴的物品',    // 1
    '一個狹窄的空間',    // 2
    '一位討厭的人',      // 3
    '一句很凶的話',      // 4
    '一個重複性的動作',  // 5
    '一個動詞',         // 6
    '一種抽象負面名詞',  // 7
    '一種生物',         // 8
    '一個技能',         // 9
    '一個正向形容詞',    // 10
    '一個歷史人物',      // 11
    ],
  },
  {
  id: 'contract_001',
  title: '📜 關於一份神祕文件的備忘錄',
  desc: '請謹慎填寫，這可能影響你的後半輩子（？）。',
  story: '根據【{2}】協議，甲方【{0}】必須在【{14}】之前，將【{1}】移交給【{12}】。若甲方無法完成，則需在【{13}】公開進行【{9}】，並對著【{3}】大喊：「{5}！」此外，乙方有權沒收甲方的【{7}】，直到【{8}】出現為止。甲方代表表示，雖然這聽起來很【{6}】，但為了獲取【{11}】，這是必須付出的代價。對此，目擊者感嘆：「這簡直比【{10}】還要【{15}】！」',
  prompts: [
    '一個名詞（人或組織）', // 0
    '一個物品',            // 1
    '一個地名/空間',       // 2
    '一個名詞',            // 3
    '一個地點',            // 4 (備用)
    '一句短語',            // 5
    '一個形容詞',          // 6
    '一個物件',            // 7
    '一個自然名詞',        // 8
    '一個動作/活動',       // 9
    '一個名詞',            // 10
    '一個抽象名詞',        // 11
    '一個職稱/身份',       // 12
    '一個特定地點',        // 13
    '一個時間點',          // 14
    '一個形容詞',        // 15
    ],
  },
  {
  id: 'expedition_001',
  title: '🧗 來自未知領域的訊號',
  desc: '通訊斷斷續續，只剩下這些破碎的字句。',
  story: '報告！我們已經到達了【{2}】。這裡到處都是【{11}】，空氣中瀰漫著【{8}】的味道。隊長【{0}】下令所有人放下手中的【{7}】，改用【{1}】來進行【{9}】。隊員【{3}】因為不小心觸碰了【{4}】，現在整個人變得非常【{6}】。他一邊跳著【{13}】，一邊對著天空吼叫：「{5}！」這讓我們感到很【{12}】。如果我們沒能回去，請把我的【{10}】留給我的家人。',
  prompts: [
    '一個人名',            // 0
    '一種工具',         // 1
    '一個地點',         // 2
    '一個稱呼',         // 3
    '一個物件',         // 4
    '一句話',           // 5
    '一個形容詞',       // 6
    '一個隨身物品',     // 7
    '一種氣味/物質',    // 8
    '一個動作',         // 9
    '一種物品',     // 10
    '一種東西（複數）',  // 11
    '一個心理形容詞',    // 12
    '一種舞蹈或律動',    // 13
    ],
  },
  {
  id: 'report_001',
  title: '🏥 一份令人困惑的報告',
  desc: '醫生看了搖頭，護理師看了想笑。',
  story: '患者【{0}】於今日下午感到【{10}】，主要症狀是【{5}】時會伴隨著【{8}】。經診斷，這是因為患者長期接觸過多【{1}】所致。醫生建議，患者應立即停止【{9}】，並每天早晚使用【{2}】對患部進行【{6}】。在治療期間，如果聽到【{3}】大喊：「{4}！」屬於正常現象，請保持【{7}】即可。',
  prompts: [
    '一個人名',            // 0
    '一個名詞',         // 1
    '一個器具',         // 2
    '一個名詞',         // 3
    '一句短語',         // 4
    '一個動作',         // 5
    '一個動作',         // 6
    '一個抽象狀態',     // 7
    '一種聲音',    // 8
    '一個活動',         // 9
    '一個形容詞',    // 10
    ],
  },
  {
  id: 'alien_001',
  title: '🛸 星球觀測紀錄：編號 {1}',
  desc: '這裡的一切都跟地球完全不同。',
  story: '這顆星球的居民自稱為【{0}】。他們不吃東西，而是靠著【{9}】來獲取能量。這裡的建築物都是由【{8}】構成的，形狀看起來非常【{10}】。當他們見面時，會互相交換【{2}】，並發出「{4}」的聲音。他們的領袖【{3}】今天正在【{6}】，看起來非常忙碌。如果地球人來到這裡，最需要帶的裝備是【{7}】，否則會無法【{5}】。',
  prompts: [
    '一個族群名稱',     // 0
    '一串數字',         // 1
    '一種物品',         // 2
    '一個職稱',         // 3
    '一個擬聲詞',  // 4
    '一個動作',         // 5
    '一個動作',         // 6
    '一個生活用品',     // 7
    '一種材質',    // 8
    '一個動詞',         // 9
    '一個形容詞',       // 10
    ],
  },
  {
  id: 'review_001',
  title: '🎬 院線首輪強檔快評',
  desc: '這部電影的評價非常兩極，看完你就會明白為什麼。',
  story: '這部由【{0}】執導的新片《【{1}】》在【{2}】首映後引發熱議。電影講述了一個關於【{3}】的故事，整體氛圍非常【{4}】。主角在片中有一段經典對白：「{5}！」隨後便開始【{6}】，這段戲讓全場觀眾放下了手中的【{7}】。影評人指出，導演成功地將【{8}】與【{9}】結合在一起，雖然結局有些【{10}】，但仍不失為一部優秀的【{11}】。',
  prompts: [
    '一個人名',         // 0
    '一個名詞',         // 1
    '一個地點',         // 2
    '一個名詞',         // 3
    '一個形容詞',       // 4
    '一句話',           // 5
    '一個動作',         // 6
    '一個物品',         // 7
    '一個名詞',         // 8
    '一個名詞',         // 9
    '一個形容詞',       // 10
    '一個名詞',         // 11
    ],
  },
  {
  id: 'manual_001',
  title: '🛠️ 產品使用安全守則',
  desc: '在使用這件物品前，請務必詳閱本說明。',
  story: '歡迎使用本公司的【{0}】。首先，請確保您處於【{1}】的狀態。接著，按住【{2}】三秒鐘，直到機器發出【{3}】的聲音。若燈光變為【{4}】色，請立即【{5}】。本產品嚴禁與【{6}】接觸，否則會產生【{7}】的後果。如果您有任何疑問，請大喊：「{8}！」並對著機器進行【{9}】。祝您體驗【{10}】！',
  prompts: [
    '一個名詞',         // 0
    '一個狀態/動作',     // 1
    '一個物件',         // 2
    '一個擬聲詞',       // 3
    '一種顏色',         // 4
    '一個動作',         // 5
    '一種名詞（複數）',  // 6
    '一個形容詞',       // 7
    '一句話',           // 8
    '一個動作',         // 9
    '一個形容詞',       // 10
    ],
  },
  {
  id: 'sports_001',
  title: '🏆 年度總決賽現場直擊',
  desc: '這場比賽的轉折多到連賽評都傻眼。',
  story: '現場氣氛非常熱烈！對陣雙方是【{0}】和【{1}】。比賽一開始，【{0}】就展現出【{2}】的氣勢，手持【{3}】衝向【{4}】。場邊教練大喊：「{5}！」球員隨即開始【{6}】，並精準地將【{7}】投向了【{8}】。這真是一場【{9}】的較量。比賽進行到一半，突然出現了大量的【{10}】，所有人被迫【{11}】。最後，主審宣布勝者可以獲得【{12}】，這讓全場感到非常【{13}】，大家一起開始【{14}】。',
  prompts: [
    '一個人名',     // 0
    '一個人名',     // 1
    '一個形容詞',       // 2
    '一個物品',         // 3
    '一個地點/目標',     // 4
    '一句話',           // 5
    '一個動作',         // 6
    '一個物件',         // 7
    '一個地點',         // 8
    '一個形容詞',       // 9
    '一種東西（複數）',  // 10
    '一個動作',         // 11
    '一個名詞',         // 12
    '一個形容詞',       // 13
    '一個動作',         // 14
    ],
  },
  {
  id: 'travel_001',
  title: '🗺️ 意外的旅程手札',
  desc: '這趟旅行跟我原本想像的完全不一樣。',
  story: '這是我在【{0}】的第三天。這裡的【{1}】非常有名，每個人出門都會帶著【{2}】。早上，我嘗試去【{3}】，結果感覺很【{4}】。當地人告訴我，如果不小心碰到【{5}】，一定要記得【{6}】。晚餐時我吃了一份【{7}】，味道像【{8}】。這讓我想起【{9}】曾經說過的：「{10}。」雖然行程變得很【{11}】，但我決定明天要繼續【{12}】。',
  prompts: [
    '一個地名',         // 0
    '一個名詞',         // 1
    '一個物件',         // 2
    '一個活動/動作',     // 3
    '一個形容詞',       // 4
    '一個名詞',         // 5
    '一個動作',         // 6
    '一個名詞',         // 7
    '一個名詞',         // 8
    '一個人物',         // 9
    '一句話',           // 10
    '一個形容詞',       // 11
    '一個動作',         // 12
    ],
  },
  {
  id: 'ghost_001',
  title: '👻 深夜的異常觀測筆錄',
  desc: '有些事情，原本是不該被記錄下來的。',
  story: '關於【{0}】的傳聞一直很多。據說每當深夜時分，那裡的【{1}】就會開始移動。某次，調查員【{2}】帶著【{3}】隻身前往，卻在【{4}】發現了一個散發著【{5}】氣味的【{6}】。就在這時，耳邊傳來一聲「{7}」，他回頭一看，所有的【{8}】竟然都在【{9}】。那一刻，空氣變得極度【{10}】，他對著黑暗大喊：「{11}！」隨即轉身瘋狂地【{12}】，從此再也沒人見過他。',
  prompts: [
    '一個地名',         // 0
    '一個名詞（物品/生物）',// 1
    '一個人名',         // 2
    '一個數字',         // 3
    '一個具體空間',      // 4
    '一種氣味/形容詞',   // 5
    '一個物件',         // 6
    '一個擬聲詞/短語',   // 7
    '一個名詞（複數）',  // 8
    '一個動作',         // 9
    '一個形容詞',       // 10
    '一句話',           // 11
    '一個動作',         // 12
    ],
  },
  {
  id: 'science_001',
  title: '🔬 每日科學：驚人的發現',
  desc: '今天我們來聊聊一個徹底改變人類認知的現象。',
  story: '大家聽過【{0}】嗎？這是一種主要發生在【{1}】的自然現象。當【{2}】與【{3}】產生接觸時，會釋放出大量的【{4}】。為了研究這個過程，科學家通常會使用【{5}】來測量其【{6}】。根據最新的學術報告，這種狀態被形容為非常【{7}】。知名教授【{8}】曾在講座中提到：「{9}。」這說明了【{10}】對人類【{11}】的重要性。如果你想在家中觀察，請務必先準備好【{12}】，否則可能會導致【{13}】。',
  prompts: [
    '一個名詞',         // 0
    '一個環境/地點',     // 1
    '一個名詞',         // 2
    '一個名詞',       // 3
    '一種物質/東西',     // 4
    '一種工具',         // 5
    '一個物理屬性/名詞', // 6
    '一個形容詞',       // 7
    '一個人名',         // 8
    '一句短語',         // 9
    '一個名詞',         // 10
    '一個抽象名詞',     // 11
    '一個物件',         // 12
    '一個形容詞/名詞',   // 13
    ],
  },
  {
  id: 'bio_001',
  title: '👤 時代焦點：影響世界的人物',
  desc: '讓我們一起走進這位傳奇人物的內心世界。',
  story: '今天我們要介紹的是【{0}】。他是一位舉世聞名的【{1}】，平日裡最喜歡在【{2}】進行【{3}】。他最廣為人知的成就是發明了【{4}】，這讓他在【{5}】圈子裡顯得格外【{6}】。私底下的他，其實有個不為人知的習慣，就是每天都會【{7}】，並且隨身帶著【{8}】。他的座右銘是：「{9}。」這句話激勵了無數的【{10}】。如果您有機會見到他，千萬不要對他【{11}】，因為那是他最感到【{12}】的時刻，他可能會立刻【{13}】。',
  prompts: [
    '一個人名',       // 0
    '一個職業',     // 1
    '一個地點',         // 2
    '一個動作',     // 3
    '一個物品',     // 4
    '一個群體/領域',     // 5
    '一個形容詞',       // 6
    '一個動作',         // 7
    '一個物品',         // 8
    '一句短語',         // 9
    '一個名詞（複數）',  // 10
    '一個動作',         // 11
    '一個形容詞',       // 12
    '一個動作',         // 13
    ],
  },
  {
  id: 'chaos_999',
  title: '🌪️ 虛擬時空的碎片紀錄',
  desc: '這是一段沒有邏輯的文字，全看你填了什麼。',
  story: '在【{0}】，【{1}】正準備【{2}】。突然，【{3}】拿著【{4}】衝了進來，對著大家尖叫：「{5}！」接著【{6}】瞬間變成了【{7}】，空氣中充滿了【{8}】。現場有人在【{9}】，有人則忙著【{10}】，這讓【{11}】感到非常【{12}】。最後，所有人決定一起【{13}】，並留下一個【{14}】作為紀念。這真是一個【{15}】的【{16}】。',
  prompts: [
    '一個地點',         // 0
    '一個名詞',         // 1
    '一個動作',         // 2
    '一個人名',     // 3
    '一個物品',         // 4
    '一句話',           // 5
    '一個名詞',         // 6
    '一個名詞',       // 7
    '一種物質（複數）',  // 8
    '一個動作',         // 9
    '一個動作',         // 10
    '一個外號/人名',    // 11
    '一個形容詞',       // 12
    '一個動作',         // 13
    '一個物件',         // 14
    '一個形容詞',       // 15
    '一個名詞',         // 16
    ],
  },
  {
  id: 'rpg_001',
  title: '🛡️ 預言中的勇者傳說',
  desc: '傳說中，只有被選中的人才能完成這項使命。',
  story: '【{0}】背起了他的【{1}】，朝向神祕的【{2}】出發。半路上，他遇到了一位【{3}】，對方遞給他一個【{4}】，並低聲說：「{5}。」這讓他學會了如何【{6}】。經過一番【{7}】後，他終於抵達了目的地，發現那裡住著一群【{8}】。他深吸一口氣，拿出了【{9}】，開始【{10}】。最終，他成功獲得了【{11}】，這段旅程真是太【{12}】了。',
  prompts: [
    '一個人名',            // 0
    '一個物品',         // 1
    '一個地點',         // 2
    '一個職業',     // 3
    '一個小東西',       // 4
    '一句短語',         // 5
    '一個動作',         // 6
    '一個名詞/活動',     // 7
    '一種生物（複數）',  // 8
    '一個物件',         // 9
    '一個動作',         // 10
    '一個名詞',         // 11
    '一個形容詞',       // 12
    ],
  },
  {
  id: 'app_001',
  title: '📱 軟體商店的五星（？）評論',
  desc: '這款軟體徹底改變了我的生活，但不是好的那種。',
  story: '我最近下載了這款名為《【{0}】》的 App。它的主要功能是幫你【{1}】，介面看起來非常【{2}】。只要點擊畫面上的【{3}】，它就會自動開始【{4}】。客服主管【{5}】承諾這絕對安全，但我的手機卻變成了【{6}】。我試著聯繫他們，結果卻收到一則訊息說：「{7}。」現在我每天只能【{8}】，心裡覺得很【{9}】。這絕對是今年最【{10}】的【{11}】。',
  prompts: [
    '一個名詞',     // 0
    '一個活動/動作',     // 1
    '一個形容詞',       // 2
    '一個物件',         // 3
    '一個動作',         // 4
    '一個人名',     // 5
    '一個名詞',         // 6
    '一句短語',         // 7
    '一個動作',         // 8
    '一個心情',    // 9
    '一個形容詞',       // 10
    '一個名詞',         // 11
    ],
  },
  {
  id: 'cook_001',
  title: '🍳 私房料理：深夜食堂',
  desc: '這道料理的精髓在於，你永遠不知道吃下去會發生什麼。',
  story: '今天要教大家做的是【{0}】。首先，準備好一份【{1}】，並將它放入【{2}】中。接著加入大量的【{3}】，直到顏色看起來有點【{4}】。這時候，主廚【{5}】會提醒你要記得【{6}】，並一邊大喊：「{7}！」完成後，盤子裡會散發出【{8}】的氣息。如果你敢嘗試吃下一口，你會感覺正在【{9}】，味道就像【{10}】。總結來說，這是一道非常【{11}】的【{12}】。',
  prompts: [
    '一個食物',   // 0
    '一個名詞',         // 1
    '一個容器/空間',     // 2
    '一種液體/物質',     // 3
    '一個顏色',         // 4
    '一個人名',        // 5
    '一個動作',         // 6
    '一句短語',         // 7
    '一個形容詞',       // 8
    '一個動作',         // 9
    '一個名詞',         // 10
    '一個形容詞',       // 11
    '一個名詞',         // 12
    ],
  },
];

// ── Template Loader Interface ─────────────────────────────────────────
// Public API for all template access. _extra holds dynamically loaded templates.
// Future: await MadlibTemplates.loadFromJSON('./stories.json');
const MadlibTemplates = {
  _extra : [],
  getAll()    { return ML_TEMPLATES.concat(this._extra); },
  getById(id) { return this.getAll().find(function(t) { return t.id === id; }) || null; },
  getRandom() { var all = this.getAll(); return all[Math.floor(Math.random() * all.length)]; },
  loadFromJSON: async function(url) {
    try {
      var res  = await fetch(url);
      var data = await res.json();
      if (Array.isArray(data)) { var self = this; data.forEach(function(t){ self._extra.push(t); }); }
    } catch(e) { console.warn('[MadlibTemplates] Failed to load:', url, e); }
  },
};

// ── Action Constants ──────────────────────────────────────────────────
const MADLIB_ACTION = {
  SUBMIT_ANSWER   : 'ml_submit_answer',
  UNSUBMIT_ANSWER : 'ml_unsubmit_answer',
  REVEAL_NEXT     : 'ml_reveal_next',
  RETURN_LOBBY    : 'ml_return_lobby',
};

// ── Game State Factory ────────────────────────────────────────────────
const makeMadlibGame = () => ({
  gameType          : 'madlib',
  mlPhase           : 'answering',         // answering | reveal | end
  selectedTemplateId: null,
  rounds            : [],   // [{type:'independent'|'buffer', questionIdxs?, assignments?:{pid:qIdx}, slots?:[{questionIdx,pids}]}]
  currentRound      : 0,
  answers           : {},   // { roundIdx: { pid: text } }
  submitted         : {},   // { roundIdx: { pid: true } }
  selectedAnswers   : {},   // { qIdx: answer } — final chosen answers for story
  revealStep        : 0,    // how many blanks revealed (0..Q)
  answerTime        : 45,
  timeLeft          : 45,
  activePids        : [],   // snapshot of non-spectator pids at game start
});

// ═══════════════════════════════════════════════════════════════════════
// LAYER 10d ─ Mad Lib Engine (故事崩壞中)
// ═══════════════════════════════════════════════════════════════════════

class MadlibEngine {
  constructor() {
    this._timer = null;
    bus.on(EVT.ACTION_RECEIVED, ({ action }) => {
      if (!store.get().isHost) return;
      if ((store.get().game || {}).gameType !== 'madlib') return;
      this._dispatch(action);
    });
  }

  _dispatch(a) {
    var t = a.type, pid = a.playerId;
    if      (t === MADLIB_ACTION.SUBMIT_ANSWER)   this._submitAnswer(pid, a.text, a.roundIdx);
    else if (t === MADLIB_ACTION.UNSUBMIT_ANSWER) this._unsubmitAnswer(pid);
    else if (t === MADLIB_ACTION.REVEAL_NEXT)     this._revealNext();
    else if (t === MADLIB_ACTION.RETURN_LOBBY)    this._returnLobby();
  }

  // ── Start game (called from room) ────────────────────
  // Template is picked randomly and secretly — nobody sees the template beforehand.
  startGame(cfg) {
    const { players } = store.get();
    const pids     = Object.keys(players).filter(id => !players[id].isSpectator);
    const template = MadlibTemplates.getRandom();
    const Q        = template.prompts.length;
    const P        = pids.length;
    const rounds   = this._computeRounds(Q, P, pids);
    store.replaceGame(Object.assign(makeMadlibGame(), {
      answerTime        : cfg.answerTime || 45,
      timeLeft          : cfg.answerTime || 45,
      activePids        : pids,
      selectedTemplateId: template.id,
      mlPhase           : 'answering',
      rounds,
      currentRound      : 0,
      answers           : {},
      submitted         : {},
      selectedAnswers   : {},
      revealStep        : 0,
    }));
    this.broadcast();
    this._startTimer();
  }

  // Template selection methods removed (Fix 3 — pure random, nobody sees template beforehand)

  // ── Round distribution algorithm ──────────────────────
  // ── Round distribution algorithm — Best Fit ───────────
  //
  // N = ceil(Q / P)   → total rounds
  // u = floor(Q / P)  → independent rounds
  // r = Q - u * P     → remaining blanks  (0 ≤ r < P)
  //
  // If r === 0: all N rounds are independent.
  // If r > 0  : N = u + 1; the last round is a single "buffer" round
  //   that packs all r blanks into one round where every player answers exactly once.
  //
  //   k_base = floor(P / r)   → base players per slot
  //   m      = P mod r        → slots that get one extra player
  //
  //   Slots: m slots of (k_base+1) players, (r-m) slots of k_base players
  //   Collab slots (pids.length > 1): random pick at resolve, skipping timeout/empty.
  //
  // Examples:
  //   Q=15, P=4 → u=3, r=3, k=1, m=1 → 3 ind + 1 buffer(slots:2,1,1 pids) = 4 rounds ✓
  //   Q=10, P=3 → u=3, r=1, k=3, m=0 → 3 ind + 1 buffer(slot:3 pids)      = 4 rounds ✓
  //   Q=12, P=4 → u=3, r=0            → 3 ind (no buffer)                  = 3 rounds ✓
  _computeRounds(Q, P, pids) {
    if (P === 0) return [];
    var u = Math.floor(Q / P);
    var r = Q - u * P;

    // Randomly ordered question indices
    var allQIdxs = Utils.shuffle(Array.from({ length: Q }, function(_, k) { return k; }));
    var qi = 0;

    // Build independent rounds
    var rounds = [];
    for (var i = 0; i < u; i++) {
      var questionIdxs = allQIdxs.slice(qi, qi + P);
      qi += P;
      var shuffledPids = Utils.shuffle(pids.slice());
      var assignments = {};
      shuffledPids.forEach(function(pid, idx) { assignments[pid] = questionIdxs[idx]; });
      rounds.push({ type: 'independent', questionIdxs: questionIdxs, assignments: assignments });
    }

    // Build buffer round if r > 0
    if (r > 0) {
      var kBase = Math.floor(P / r);  // base players per slot
      var m     = P % r;              // slots that get one extra player
      var shuffledAll = Utils.shuffle(pids.slice());
      var playerIdx = 0;
      var slots = [];
      for (var s = 0; s < r; s++) {
        var slotSize = kBase + (s < m ? 1 : 0);
        var slotPids = shuffledAll.slice(playerIdx, playerIdx + slotSize);
        playerIdx += slotSize;
        slots.push({ questionIdx: allQIdxs[qi++], pids: slotPids });
      }
      rounds.push({ type: 'buffer', slots: slots });
    }

    // Shuffle so buffer doesn't always land at the end
    return Utils.shuffle(rounds);
  }

  // ── Timer ─────────────────────────────────────────────
  _startTimer() {
    this.stopTimer();
    var t = store.get().game.answerTime || 45;
    this._timer = setInterval(() => {
      t = Math.max(0, t - 1);
      store.patchGame({ timeLeft: t });
      this.broadcast();
      // At t=0: clients have already sent their textarea content at t=1 (see _renderMadlib).
      // By now those actions have arrived and been processed. Simply fill any remaining
      // empties with '（時間到）' and advance to the next round — same pattern as ChaosEngine.
      if (t <= 0) { this.stopTimer(); this._autoSubmitAll(); this._resolveCurrentRound(); }
    }, 1000);
  }

  stopTimer() { clearInterval(this._timer); this._timer = null; }

  // ── Answers ───────────────────────────────────────────
  _autoSubmitAll() {
    const g = store.get().game;
    const cr  = g.currentRound;
    const rounds2 = Array.isArray(g.rounds) ? g.rounds : Object.values(g.rounds || {});
    const round = rounds2[cr] || {};
    const activePidsNorm2 = Array.isArray(g.activePids) ? g.activePids : Object.values(g.activePids || {});
    var pidsToSubmit = [];
    if (round.type === 'buffer') {
      var slotsNorm = Array.isArray(round.slots) ? round.slots : Object.values(round.slots || {});
      slotsNorm.forEach(function(slot) {
        var sp = Array.isArray(slot.pids) ? slot.pids : Object.values(slot.pids || {});
        pidsToSubmit = pidsToSubmit.concat(sp);
      });
    } else {
      pidsToSubmit = activePidsNorm2;
    }
    var answers   = Utils.deepClone(g.answers);
    var submitted = Utils.deepClone(g.submitted);
    if (!answers[cr])   answers[cr]   = {};
    if (!submitted[cr]) submitted[cr] = {};
    pidsToSubmit.forEach(function(pid) {
      if (!submitted[cr][pid]) {
        answers[cr][pid]   = '（時間到）';
        submitted[cr][pid] = true;
      }
    });
    store.patchGame({ answers: answers, submitted: submitted });
    this.broadcast();
  }

  _submitAnswer(pid, text, roundIdx) {
    const g = store.get().game;
    if (g.mlPhase !== 'answering') return;
    const cr  = g.currentRound;
    // Reject stale actions: if the action was stamped with a round index that no
    // longer matches the current round, the action arrived late (Firebase delay > 400ms).
    // Applying it would mark the player as submitted in the WRONG round.
    if (roundIdx !== undefined && roundIdx !== cr) return;
    var answers   = Utils.deepClone(g.answers);
    var submitted = Utils.deepClone(g.submitted);
    if (!answers[cr])   answers[cr]   = {};
    if (!submitted[cr]) submitted[cr] = {};
    answers[cr][pid]   = text || '（空白）';
    submitted[cr][pid] = true;
    store.patchGame({ answers: answers, submitted: submitted });
    this.broadcast();
    // All relevant players submitted → resolve immediately
    var roundsNorm = Array.isArray(g.rounds) ? g.rounds : Object.values(g.rounds || {});
    var round2 = roundsNorm[cr] || {};
    var activePidsNorm = Array.isArray(g.activePids) ? g.activePids : Object.values(g.activePids || {});
    var relevantPids;
    if (round2.type === 'buffer') {
      var slotsNorm2 = Array.isArray(round2.slots) ? round2.slots : Object.values(round2.slots || {});
      relevantPids = [];
      slotsNorm2.forEach(function(slot) {
        var sp = Array.isArray(slot.pids) ? slot.pids : Object.values(slot.pids || {});
        relevantPids = relevantPids.concat(sp);
      });
    } else {
      relevantPids = activePidsNorm;
    }
    // All players submitted before time is up → resolve early.
    if (relevantPids.every(function(p) { return submitted[cr][p]; })) {
      this.stopTimer();
      this._resolveCurrentRound();
    }
  }

  _unsubmitAnswer(pid) {
    const g = store.get().game;
    if (g.mlPhase !== 'answering') return;
    const cr = g.currentRound;
    var submitted = Utils.deepClone(g.submitted);
    if (submitted[cr]) delete submitted[cr][pid];
    store.patchGame({ submitted: submitted });
    this.broadcast();
  }

  // ── Round resolution ──────────────────────────────────
  _resolveCurrentRound() {
    const g      = store.get().game;
    if (g.mlPhase !== 'answering') return;
    const cr     = g.currentRound;
    var roundsArr2 = Array.isArray(g.rounds) ? g.rounds : Object.values(g.rounds || {});
    const round  = roundsArr2[cr];
    if (!round) return;
    const roundAnswers   = (g.answers[cr]) || {};
    var selectedAnswers  = Utils.deepClone(g.selectedAnswers);

    if (round.type === 'independent') {
      // Each player's answer fills their individually assigned blank
      var asgn = round.assignments || {};
      Object.keys(asgn).forEach(function(pid) {
        var qIdx = asgn[pid];
        selectedAnswers[qIdx] = roundAnswers[pid] || '（未填寫）';
      });
    } else if (round.type === 'buffer') {
      // Buffer: each slot has 1+ players; pick best answer per slot.
      // Prefer answers that are not empty/timeout. If all are bad, fall back to any.
      var TIMEOUT_MARKER = '（時間到）';
      var EMPTY_MARKER   = '（空白）';
      var slotsR = Array.isArray(round.slots) ? round.slots : Object.values(round.slots || {});
      slotsR.forEach(function(slot) {
        var slotPids = Array.isArray(slot.pids) ? slot.pids : Object.values(slot.pids || {});
        var good = slotPids.filter(function(p) {
          var a = roundAnswers[p];
          return a && a !== TIMEOUT_MARKER && a !== EMPTY_MARKER;
        });
        var pool = good.length > 0 ? good : slotPids;
        var pick = pool[Math.floor(Math.random() * pool.length)];
        selectedAnswers[slot.questionIdx] = (pick && roundAnswers[pick]) || '（未填寫）';
      });
    }

    const nextRound = cr + 1;
    var roundsLen = Array.isArray(g.rounds) ? g.rounds.length : Object.keys(g.rounds || {}).length;
    if (nextRound >= roundsLen) {
      // All rounds done → enter reveal phase
      store.patchGame({
        selectedAnswers : selectedAnswers,
        mlPhase         : 'reveal',
        currentRound    : nextRound,
        revealStep      : 0,
      });
      this.broadcast();
    } else {
      // Advance to next round
      store.patchGame({
        selectedAnswers : selectedAnswers,
        currentRound    : nextRound,
        timeLeft        : g.answerTime,
      });
      this.broadcast();
      this._startTimer();
    }
  }

  // ── Reveal ────────────────────────────────────────────
  _revealNext() {
    const g        = store.get().game;
    if (g.mlPhase !== 'reveal') return;
    const template = MadlibTemplates.getById(g.selectedTemplateId);
    const Q        = template ? template.prompts.length : 0;
    const newStep  = Math.min((g.revealStep || 0) + 1, Q);
    store.patchGame({ revealStep: newStep, mlPhase: newStep >= Q ? 'end' : 'reveal' });
    this.broadcast();
  }

  // ── Lobby ─────────────────────────────────────────────
  _returnLobby() {
    store.replaceGame(makeGame());
    this.broadcast();
    bus.emit(EVT.RETURN_LOBBY);
  }

  // ── Helpers ───────────────────────────────────────────
  broadcast() {
    const { isHost, game, roomCode } = store.get();
    if (!isHost) return;
    transport.pushGameState(roomCode, game);
  }

  sendAction(action) {
    const { isHost, myId, roomCode } = store.get();
    if (isHost) bus.emit(EVT.ACTION_RECEIVED, { action: Object.assign({}, action, { playerId: myId }) });
    else transport.pushAction(roomCode, Object.assign({}, action, { playerId: myId }));
  }
}

const madlibEngine = new MadlibEngine();

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

    // Unified chat: public messages
    bus.on('chat:message', ({ msg }) => { this._appendChatMsg(msg); });
    // Unified chat: DM messages
    bus.on('dm:message',   ({ msg }) => { this._appendDMMsg(msg); });

    // Task 2: Kicked event — show prominent modal
    bus.on('room:kicked', () => {
      transport.teardown();
      store.set({ myId: null, myName: '', roomCode: '', isHost: false, hostId: null, isSpectator: false, players: {}, game: makeGame() });
      // Show kicked modal
      const modal = document.getElementById('kicked-modal');
      if (modal) modal.classList.remove('hidden');
    });

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
        if (this._screen !== 'ww-game') {
          document.querySelectorAll('.screen').forEach(el => {
            el.classList.add('hidden'); el.classList.remove('active');
          });
          const el = document.getElementById('screen-ww-game');
          if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
          this._screen = 'ww-game';
        }
        this._renderWW(Object.assign({}, store.get(), { game: state }));
        return;
      }

      if (state.gameType === 'chaos') {
        if (this._screen !== 'chaos-game') {
          document.querySelectorAll('.screen').forEach(el => {
            el.classList.add('hidden'); el.classList.remove('active');
          });
          const el = document.getElementById('screen-chaos-game');
          if (el) { el.classList.remove('hidden'); el.classList.add('active'); }
          this._screen = 'chaos-game';
        }
        this._renderChaos(Object.assign({}, store.get(), { game: state }));
        return;
      }

      if (state.gameType === 'madlib') {
        if (this._screen !== 'madlib') {
          document.querySelectorAll('.screen').forEach(el => {
            el.classList.add('hidden'); el.classList.remove('active');
          });
          const elM = document.getElementById('screen-madlib');
          if (elM) { elM.classList.remove('hidden'); elM.classList.add('active'); }
          this._screen = 'madlib';
        }
        this._renderMadlib(Object.assign({}, store.get(), { game: state }));
        return;
      }

      // WW / chaos / madlib game ended / returned to lobby
      if (this._screen === 'ww-game' || this._screen === 'chaos-game' || this._screen === 'madlib') {
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
    this._bindChaosGame();
    this._bindMadlibGame();
    this._bindUnifiedChat();

    // Kicked modal OK button
    var self = this;
    var kickedOk = document.getElementById('btn-kicked-ok');
    if (kickedOk) kickedOk.addEventListener('click', function() {
      var modal = document.getElementById('kicked-modal');
      if (modal) modal.classList.add('hidden');
      self.show('home');
    });

    // Seer result modal ACK
    var seerAck = document.getElementById('btn-seer-result-ack');
    if (seerAck) seerAck.addEventListener('click', function() {
      var m = document.getElementById('seer-result-modal');
      if (m) { m.classList.add('hidden'); m._ackedRound = true; }
      // Confirm done so night can progress
      wwEngine.sendAction({ type: WW_ACTION.NIGHT_DONE });
    });

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
    t.classList.add('hidden');
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        t.className = 'toast ' + type;
        clearTimeout(this._toastTmr);
        this._toastTmr = setTimeout(function() { t.classList.add('hidden'); }, 3800);
      }.bind(this));
    }.bind(this));
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
    if (this._screen === 'chaos-game') {
      const g = s.game;
      if (!g || g.gameType !== 'chaos') return;
      if (s.isHost) this._renderChaos(s);
    }
    if (this._screen === 'madlib') {
      const g = s.game;
      if (!g || g.gameType !== 'madlib') return;
      // Both host and non-host render via _sync; data-card-key guard prevents textarea disruption
      this._renderMadlib(s);
    }
  }

  // ── Room rendering ────────────────────────────────────

  _renderPlayers(players, myId, hostId) {
    const { settings, isSpectator, isHost } = store.get();
    const maxP = (settings || {}).maxPlayers || 12;
    const cnt  = document.getElementById('player-count');
    const lst  = document.getElementById('players-list');
    if (!cnt || !lst) return;
    const n = Object.keys(players).length;
    cnt.textContent = n + ' / ' + maxP;

    // Track which pids are already rendered to animate new arrivals
    const existingIds = new Set(Array.from(lst.querySelectorAll('li[data-pid]')).map(el => el.getAttribute('data-pid')));

    // Build new map
    const newHtml = Object.entries(players).map(function([id, p]) {
      const amHost  = id === hostId;
      const isMe    = id === myId;
      const canKick = isHost && !isMe;
      const isNew   = !existingIds.has(id);
      return '<li class="player-item' +
        (amHost ? ' is-host' : '') +
        (p.isSpectator ? ' is-spectator' : '') +
        (isNew ? ' joining' : '') +
        '" data-pid="' + id + '">' +
        '<div class="player-avatar" style="background:' + Utils.avatarColor(p.name) + '">' + (p.name || '?')[0] + '</div>' +
        '<span class="player-name">' + Utils.escapeHtml(p.name) + '</span>' +
        '<div class="player-badges">' +
          (amHost ? '<span class="p-badge p-badge-host">👑 主持人</span>' : '') +
          (isMe   ? '<span class="p-badge p-badge-you">你</span>' : '') +
          (p.isSpectator ? '<span class="p-badge p-badge-spec">👁 觀戰</span>' : '') +
          (!p.isSpectator ? '<span class="p-badge p-badge-conn">在線</span>' : '') +
        '</div>' +
        (canKick ? '<button class="player-kick-btn" data-kick-id="' + id + '" title="踢出玩家">✕ 踢出</button>' : '') +
        '</li>';
    }).join('');
    lst.innerHTML = newHtml;

    // Kick button delegation
    lst.querySelectorAll('.player-kick-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const kickId = btn.getAttribute('data-kick-id');
        const p = players[kickId] || {};
        if (!confirm('確定要踢出 ' + (p.name || kickId) + ' 嗎？')) return;
        const { roomCode } = store.get();
        await transport.kickPlayer(roomCode, kickId);
        bus.emit(EVT.TOAST, { msg: (p.name || kickId) + ' 已被踢出房間', type: 'info' });
      });
    });

    // Spectator toggle button
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

      this._show('story-settings',  gameType === 'story');
      this._show('ww-settings',     gameType === 'werewolf');
      this._show('chaos-settings',  gameType === 'chaos');
      this._show('madlib-settings', gameType === 'madlib');

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
        // Hiddenwolf counter sync (in case not in ROLES iteration order)
        var hwEl = document.getElementById('ww-count-hiddenwolf');
        if (hwEl) hwEl.textContent = roles['hiddenwolf'] || 0;
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
    } else if (gameType === 'madlib') {
      var mc = settings.madlibConfig || {};
      lines = '<div class="spec-lobby-row"><span>📝 故事崩壞中</span></div>' +
        '<div class="spec-lobby-row"><span class="slr-label">填詞時限</span><span>' + (mc.answerTime||45) + ' 秒</span></div>';
    } else if (gameType === 'chaos') {
      var cc = settings.chaosConfig || {};
      lines = '<div class="spec-lobby-row"><span>🎲 規則混亂</span></div>' +
        '<div class="spec-lobby-row"><span class="slr-label">回合數</span><span>' + (cc.totalRounds||5) + ' 回合</span></div>' +
        '<div class="spec-lobby-row"><span class="slr-label">寫句子</span><span>' + (cc.writeTime||60) + ' 秒</span></div>' +
        '<div class="spec-lobby-row"><span class="slr-label">修改</span><span>' + (cc.modifyTime||60) + ' 秒</span></div>' +
        '<div class="spec-lobby-row"><span class="slr-label">每張投票</span><span>' + (cc.voteTime||20) + ' 秒</span></div>';
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
    } else if (gameType === 'madlib') {
      const mc = settings.madlibConfig || {};
      cont.innerHTML =
        '<div class="preview-row"><span class="preview-label">遊戲模式</span><span class="preview-val">📝 故事崩壞中</span></div>' +
        '<div class="preview-row"><span class="preview-label">填詞時限</span><span class="preview-val">' + (mc.answerTime||45) + ' 秒／輪</span></div>';
    } else if (gameType === 'chaos') {
      const cc = settings.chaosConfig || {};
      cont.innerHTML =
        '<div class="preview-row"><span class="preview-label">遊戲模式</span><span class="preview-val">🎲 規則混亂</span></div>' +
        '<div class="preview-row"><span class="preview-label">回合數</span><span class="preview-val">' + (cc.totalRounds||5) + ' 回合</span></div>' +
        '<div class="preview-row"><span class="preview-label">寫句子時限</span><span class="preview-val">' + (cc.writeTime||60) + ' 秒</span></div>' +
        '<div class="preview-row"><span class="preview-label">修改時限</span><span class="preview-val">' + (cc.modifyTime||60) + ' 秒</span></div>' +
        '<div class="preview-row"><span class="preview-label">每張投票時限</span><span class="preview-val">' + (cc.voteTime||20) + ' 秒</span></div>';
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

    // Auto-lock at last second (timeLeft===1 avoids race with host phase transition at 0)
    if (game.mode === 'time' && game.timeLeft === 1 && !isLocked) {
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
    var _busy = false;  // prevent double-submit
    var go = async function(join) {
      if (_busy) return;
      var name = (document.getElementById('input-name') || {}).value;
      name = name ? name.trim() : '';
      if (!name) return self._err('home-error', '請先輸入暱稱');
      if (join) {
        var code = (document.getElementById('input-room-code') || {}).value;
        code = code ? code.trim() : '';
        if (!code) return self._err('home-error', '請輸入房間代碼');
      }
      _busy = true;
      self._setHomeBusy(true, join ? '加入中…' : '建立中…');
      try {
        if (join) { await roomManager.joinRoom(code, name); }
        else       { await roomManager.createRoom(name); }
      } catch (e) {
        self._err('home-error', (join ? '加入失敗：' : '建立失敗：') + e.message);
      } finally {
        _busy = false;
        self._setHomeBusy(false, '');
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

  _setHomeBusy(busy, msg) {
    var createBtn = document.getElementById('btn-create-room');
    var joinBtn   = document.getElementById('btn-join-room');
    var nameInp   = document.getElementById('input-name');
    var codeInp   = document.getElementById('input-room-code');
    var loading   = document.getElementById('home-loading-bar');

    if (createBtn) {
      createBtn.disabled = busy;
      createBtn.classList.toggle('btn-loading', busy);
    }
    if (joinBtn) {
      joinBtn.disabled = busy;
      joinBtn.classList.toggle('btn-loading', busy);
    }
    if (nameInp) nameInp.disabled = busy;
    if (codeInp) codeInp.disabled = busy;
    if (loading) {
      loading.classList.toggle('hidden', !busy);
      var loadTxt = loading.querySelector('.home-loading-txt');
      if (loadTxt) {
        // Animated dots: base text + cycling dots
        clearInterval(this._loadingDotsInterval);
        if (busy) {
          var base = msg ? msg.replace(/…$/, '') : '';
          var dots = 0;
          loadTxt.textContent = base + '…';
          this._loadingDotsInterval = setInterval(function() {
            dots = (dots + 1) % 4;
            loadTxt.textContent = base + '.'.repeat(dots) || base;
          }, 420);
        } else {
          clearInterval(this._loadingDotsInterval);
          if (loadTxt) loadTxt.textContent = '';
        }
      }
    }
  }

  _bindRoom() {
    var self = this;
    // ── Task 4: Copy button circle-to-checkmark animation ──
    this._on('btn-copy-code', 'click', function() {
      var code = (document.getElementById('display-room-code') || {}).textContent || '';
      var btn  = document.getElementById('btn-copy-code');
      if (!btn || btn.classList.contains('is-copying')) return;

      var doSuccess = function() {
        btn.classList.remove('is-copying');
        btn.classList.add('is-copied');
        setTimeout(function() { btn.classList.remove('is-copied'); }, 2200);
        self.toast('房間代碼已複製！', 'success');
      };
      var doFail = function() {
        btn.classList.remove('is-copying');
        self.toast('代碼：' + code, 'info');
      };

      btn.classList.add('is-copying');
      // Arc animation duration = 650ms, then flip to check
      setTimeout(function() {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(code).then(doSuccess).catch(doFail);
        } else {
          try {
            var ta = document.createElement('textarea');
            ta.value = code; document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta);
            doSuccess();
          } catch(_) { doFail(); }
        }
      }, 650);
    });

    this._on('btn-leave-room', 'click', async function() {
      await roomManager.hardLeave();
      // Clear chat for next session
      var msgs = document.getElementById('fc-messages');
      if (msgs) msgs.innerHTML = '';
      self._chatSeenTs = 0;
      self._showUnifiedChat(false);
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
        var isWolf  = roleId === 'wolf' || roleId === 'wolfking' || roleId === 'hiddenwolf';
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

    // Push chaos settings on change — so non-host preview stays in sync
    function pushChaos() {
      var s  = store.get().settings;
      var cc = Object.assign({}, s.chaosConfig || {}, {
        totalRounds : Utils.clamp(parseInt((document.getElementById('chaos-rounds')||{}).value||5),1,15),
        writeTime   : Utils.clamp(parseInt((document.getElementById('chaos-write-time')||{}).value||60),20,180),
        modifyTime  : Utils.clamp(parseInt((document.getElementById('chaos-modify-time')||{}).value||60),20,180),
        voteTime    : Utils.clamp(parseInt((document.getElementById('chaos-vote-time')||{}).value||20),10,60),
      });
      var ns = Object.assign({}, s, { chaosConfig: cc });
      store.set({ settings: ns });
      transport.pushSettings(store.get().roomCode, ns);
    }
    ['chaos-rounds','chaos-write-time','chaos-modify-time','chaos-vote-time'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', pushChaos);
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

    // ── Chaos: start game ───────────────────────────────
    // ── Madlib: push settings on change ──────────────────
    function pushMadlib() {
      var s = store.get().settings;
      var mc = { answerTime: Utils.clamp(parseInt((document.getElementById('madlib-answer-time')||{}).value||45),15,120) };
      var ns = Object.assign({}, s, { madlibConfig: mc });
      store.set({ settings: ns });
      transport.pushSettings(store.get().roomCode, ns);
    }
    var mATEl = document.getElementById('madlib-answer-time');
    if (mATEl) mATEl.addEventListener('change', pushMadlib);

    // ── Madlib: start game (template auto-selected randomly in engine) ─
    this._on('btn-start-madlib', 'click', function() {
      var players = store.get().players;
      var activePlayers = Object.values(players).filter(function(p) { return !p.isSpectator; });
      if (activePlayers.length < 2) return self._err('room-error', '故事崩壞中至少需要 2 名玩家');
      var answerTime = Utils.clamp(parseInt((document.getElementById('madlib-answer-time')||{}).value||45),15,120);
      var newSettings = Object.assign({}, store.get().settings, { madlibConfig: { answerTime: answerTime } });
      store.set({ settings: newSettings });
      transport.pushSettings(store.get().roomCode, newSettings);
      madlibEngine.startGame({ answerTime: answerTime });
      document.querySelectorAll('.screen').forEach(function(el) {
        el.classList.add('hidden'); el.classList.remove('active');
      });
      var scrEl = document.getElementById('screen-madlib');
      if (scrEl) { scrEl.classList.remove('hidden'); scrEl.classList.add('active'); }
      self._screen = 'madlib';
      self._renderMadlib(store.get());
    });

    this._on('btn-start-chaos', 'click', function() {
      var players      = store.get().players;
      var activePlayers = Object.values(players).filter(function(p) { return !p.isSpectator; });
      if (activePlayers.length < 3)
        return self._err('room-error', '規則混亂至少需要 3 名玩家');
      var s   = store.get().settings;
      var cc  = s.chaosConfig || {};
      var totalRounds = Utils.clamp(parseInt((document.getElementById('chaos-rounds') || {}).value || 5), 1, 15);
      var writeTime   = Utils.clamp(parseInt((document.getElementById('chaos-write-time') || {}).value || 60), 20, 180);
      var modifyTime  = Utils.clamp(parseInt((document.getElementById('chaos-modify-time') || {}).value || 60), 20, 180);
      var voteTime    = Utils.clamp(parseInt((document.getElementById('chaos-vote-time') || {}).value || 30), 10, 90);
      var newSettings = Object.assign({}, s, { chaosConfig: { totalRounds, writeTime, modifyTime, voteTime } });
      store.set({ settings: newSettings });
      transport.pushSettings(store.get().roomCode, newSettings);
      chaosEngine.startGame({ totalRounds, writeTime, modifyTime, voteTime });
      document.querySelectorAll('.screen').forEach(function(el) {
        el.classList.add('hidden'); el.classList.remove('active');
      });
      var scrEl = document.getElementById('screen-chaos-game');
      if (scrEl) { scrEl.classList.remove('hidden'); scrEl.classList.add('active'); }
      self._screen = 'chaos-game';
      self._renderChaos(store.get());
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

    // Gravedigger: confirm done
    this._on('btn-gravedigger-done', 'click', function() {
      wwEngine.sendAction({ type: WW_ACTION.NIGHT_DONE });
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

  // ── Unified Chat (public + DM) ────────────────────────

  _bindUnifiedChat() {
    var self = this;
    this._chatSeenTs   = 0;
    this._chatOpen     = false;
    this._chatMinimized = false;
    this._chatUnread    = 0;          // public unread
    this._dmTarget      = null;       // current DM partner pid
    this._dmWatcher     = null;       // { unsubFn, targetId } — active DM Firebase listener
    this._dmLoaded      = {};         // { pid: true } — which convos have been loaded already
    this._dmUnread      = 0;
    this._activeTab     = 'public';   // 'public' | 'dm'

    // ── Room lifecycle ──────────────────────────────────
    bus.on(EVT.ROOM_JOINED, function() {
      var msgs = document.getElementById('fc-messages');
      if (msgs) msgs.innerHTML = '';
      self._chatSeenTs  = 0; self._chatUnread = 0; self._dmUnread = 0;
      self._dmTarget    = null; self._dmLoaded = {}; self._dmUnreadMap = {};
      if (self._dmWatcher) { self._dmWatcher.unsubFn(); self._dmWatcher = null; }
      var dot = document.getElementById('chat-unread-dot');
      if (dot) dot.classList.add('hidden');
      var dmDot = document.getElementById('dm-tab-dot');
      if (dmDot) dmDot.classList.add('hidden');
      self._showUnifiedChat(true);
      // Start dm_inbox watcher — fires for any DM sent to me, even without an open convo watcher.
      // Using startAt(joinTs) so stale notifications from previous sessions are ignored entirely.
      var joinTs = Date.now();
      var s2 = store.get();
      if (s2.roomCode && s2.myId) {
        transport.watchDMInbox(s2.roomCode, s2.myId, joinTs, function(fromPid /*, data*/) {
          // Already viewing this person's convo and panel is open → clear inbox, no dot needed
          if (self._chatOpen && self._activeTab === 'dm' && self._dmTarget === fromPid) {
            transport.clearDMInbox(s2.roomCode, s2.myId, fromPid);
            return;
          }
          if (!self._dmUnreadMap) self._dmUnreadMap = {};
          // Set to 1 per sender (inbox stores latest only; don't double-count)
          if (!(self._dmUnreadMap[fromPid] > 0)) self._dmUnreadMap[fromPid] = 1;
          self._updateDMDots();
          // Refresh picker badges live if user is on DM picker view
          if (self._chatOpen && self._activeTab === 'dm' && !self._dmTarget) {
            self._renderDMPicker();
          }
        });
      }
    });
    bus.on(EVT.RETURN_LOBBY,  function() { self._showUnifiedChat(true);  });
    bus.on('room:kicked',     function() { self._showUnifiedChat(false); });

    // ── Panel open/close/toggle ─────────────────────────
    var panel   = document.getElementById('chat-panel');
    var openBtn = document.getElementById('chat-open-btn');
    var closeBtn= document.getElementById('chat-panel-close');
    var toggleBtn=document.getElementById('chat-panel-toggle');

    if (openBtn) openBtn.addEventListener('click', function() {
      if (!panel) return;
      panel.classList.remove('hidden');
      panel.classList.remove('cp-minimized');
      openBtn.classList.add('hidden');
      self._chatOpen     = true;
      self._chatMinimized = false;
      self._chatUnread   = 0;
      var dot = document.getElementById('chat-unread-dot');
      if (dot) dot.classList.add('hidden');
      // Don't blindly clear dm-tab-dot; let _updateDMDots re-draw based on actual unread state
      self._updateDMDots();
      // Scroll public to bottom
      var msgs = document.getElementById('fc-messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      // activeTab is always 'public' when panel was closed via ✕ button
      // (we reset to public in closeBtn handler). Just scroll public to bottom.
      // If user was on DM tab when they closed, they'll land on public on reopen —
      // DM red dot remains visible on the tab until they switch to it.
    });

    if (closeBtn) closeBtn.addEventListener('click', function() {
      if (panel) panel.classList.add('hidden');
      if (openBtn) openBtn.classList.remove('hidden');
      self._chatOpen = false;

      // Bug 3 fix: if closing while in a DM convo (without pressing ←),
      // navigate back to public tab NOW (on close) so that:
      // 1. Red dot appears correctly on reopen
      // 2. Panel reopens on public chat, not stuck in DM convo view
      if (self._activeTab === 'dm') {
        // Stop DM watcher
        if (self._dmWatcher) { self._dmWatcher.unsubFn(); self._dmWatcher = null; }
        // Reset convo state
        self._dmTarget = null;
        // Reset DM UI to picker
        var picker = document.getElementById('dm-picker-view');
        var convo  = document.getElementById('dm-convo-view');
        if (picker) picker.classList.remove('hidden');
        if (convo)  convo.classList.add('hidden');
        // Switch activeTab to public so panel reopens on public chat
        self._activeTab = 'public';
        var pubContent = document.getElementById('chat-tab-public');
        var dmContent  = document.getElementById('chat-tab-dm');
        if (pubContent) pubContent.classList.remove('hidden');
        if (dmContent)  dmContent.classList.add('hidden');
        document.querySelectorAll('.chat-tab').forEach(function(b) {
          b.classList.toggle('chat-tab-active', b.getAttribute('data-tab') === 'public');
        });
      }
      // Update dots: dm_inbox watcher keeps running and will show dot for any unread DMs
      self._updateDMDots();
    });

    if (toggleBtn) toggleBtn.addEventListener('click', function() {
      self._chatMinimized = !self._chatMinimized;
      if (panel) panel.classList.toggle('cp-minimized', self._chatMinimized);
      toggleBtn.textContent = self._chatMinimized ? '▲' : '▼';
    });

    // ── Tab switching ───────────────────────────────────
    document.querySelectorAll('.chat-tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tab = btn.getAttribute('data-tab');
        self._switchChatTab(tab);
      });
    });

    // ── Drag ───────────────────────────────────────────
    var header = document.getElementById('chat-panel-header');
    if (panel && header) {
      var drag = false, ox = 0, oy = 0;
      header.addEventListener('mousedown', function(e) {
        if (e.target.closest('button') || e.target.closest('.chat-tab-bar')) return;
        drag = true;
        var r = panel.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top;
        panel.style.transition = 'none'; e.preventDefault();
      });
      document.addEventListener('mousemove', function(e) {
        if (!drag) return;
        var x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
        var y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
        panel.style.left  = x + 'px'; panel.style.top = y + 'px';
      });
      document.addEventListener('mouseup', function() { if (drag) { drag = false; panel.style.transition = ''; } });
    }

    // ── Public chat send ────────────────────────────────
    var sendPublic = function() {
      var inp = document.getElementById('fc-input');
      if (!inp) return;
      var text = inp.value.trim(); if (!text) return;
      var s = store.get(); if (!s.roomCode || !s.myId) return;
      inp.value = '';
      transport.pushChat(s.roomCode, { pid: s.myId, name: s.myName || '???', text: text });
    };
    var fcSend = document.getElementById('fc-send-btn');
    if (fcSend) fcSend.addEventListener('click', sendPublic);
    var fcInp  = document.getElementById('fc-input');
    if (fcInp)  fcInp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPublic(); }
    });

    // ── DM back button ──────────────────────────────────
    var dmBack = document.getElementById('dm-back-btn');
    if (dmBack) dmBack.addEventListener('click', function() {
      self._closeDMConvo();
      self._renderDMPicker();
    });

    // ── DM send ─────────────────────────────────────────
    var sendDM = function() {
      var inp = document.getElementById('dm-input');
      if (!inp || !self._dmTarget) return;
      var text = inp.value.trim(); if (!text) return;
      var s = store.get(); if (!s.roomCode || !s.myId) return;
      inp.value = '';
      transport.pushDM(s.roomCode, s.myId, self._dmTarget, { pid: s.myId, name: s.myName || '???', text: text });
      // Notify recipient via dm_inbox so they get a red dot even without an active watcher
      transport.writeDMInbox(s.roomCode, s.myId, s.myName || '???', self._dmTarget);
    };
    var dmSend = document.getElementById('dm-send-btn');
    if (dmSend) dmSend.addEventListener('click', sendDM);
    var dmInp  = document.getElementById('dm-input');
    if (dmInp)  dmInp.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDM(); }
    });
  }

  _switchChatTab(tab) {
    this._activeTab = tab;
    document.querySelectorAll('.chat-tab').forEach(function(b) {
      b.classList.toggle('chat-tab-active', b.getAttribute('data-tab') === tab);
    });
    var pubContent = document.getElementById('chat-tab-public');
    var dmContent  = document.getElementById('chat-tab-dm');
    if (pubContent) pubContent.classList.toggle('hidden', tab !== 'public');
    if (dmContent)  dmContent.classList.toggle('hidden',  tab !== 'dm');
    if (tab === 'public') {
      var msgs = document.getElementById('fc-messages');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }
    if (tab === 'dm') {
      // Clear DM tab unread dot
      var dmDot = document.getElementById('dm-tab-dot');
      if (dmDot) dmDot.classList.add('hidden');
      this._dmUnread = 0;

      // If there's an active watcher but _dmTarget is null (user pressed ← back),
      // show picker. If watcher exists and _dmTarget is set, restore convo view.
      if (this._dmWatcher && this._dmTarget !== null) {
        // Convo already open — just scroll to bottom
        var dmsgs = document.getElementById('dm-messages');
        if (dmsgs) dmsgs.scrollTop = dmsgs.scrollHeight;
      } else {
        // Show picker
        this._renderDMPicker();
      }
    }
  }

  _showUnifiedChat(visible) {
    var panel   = document.getElementById('chat-panel');
    var openBtn = document.getElementById('chat-open-btn');
    if (!visible) {
      if (panel)   panel.classList.add('hidden');
      if (openBtn) openBtn.classList.add('hidden');
      this._chatOpen = false;
      // Stop DM watcher when leaving room
      if (this._dmWatcher) { this._dmWatcher.unsubFn(); this._dmWatcher = null; }
      this._dmTarget = null;
    } else {
      // Enter room: default closed
      this._chatOpen = false;
      if (panel)   panel.classList.add('hidden');
      if (openBtn) openBtn.classList.remove('hidden');
    }
  }

  _renderDMPicker() {
    var list = document.getElementById('dm-player-list');
    if (!list) return;
    var s      = store.get();
    var myId   = s.myId;
    var others = Object.entries(s.players || {}).filter(function(e) { return e[0] !== myId; });
    var self   = this;
    var unreadMap = this._dmUnreadMap || {};
    if (!others.length) { list.innerHTML = '<div class="dm-no-players">目前沒有其他玩家</div>'; return; }
    list.innerHTML = others.map(function(e) {
      var pid   = e[0], p = e[1];
      var color = Utils.avatarColor(p.name || pid);
      var cnt   = unreadMap[pid] || 0;
      var badge = cnt > 0 ? '<span class="dm-unread-badge">' + cnt + '</span>' : '';
      return '<div class="dm-player-row" data-pid="' + pid + '">' +
        '<div class="dm-p-avatar" style="background:' + color + '">' + (p.name||'?')[0] + '</div>' +
        '<span class="dm-p-name">' + Utils.escapeHtml(p.name || pid) + '</span>' +
        badge +
        '<span class="dm-p-arrow">›</span>' +
      '</div>';
    }).join('');
    list.querySelectorAll('.dm-player-row').forEach(function(row) {
      row.addEventListener('click', function() {
        var pid = row.getAttribute('data-pid');
        var p   = (s.players || {})[pid] || {};
        self._openDMWith(pid, p.name || pid);
      });
    });
  }

  _openDMWith(targetId, targetName) {
    var self     = this;
    var picker   = document.getElementById('dm-picker-view');
    var convo    = document.getElementById('dm-convo-view');
    var withName = document.getElementById('dm-with-name');
    var msgs     = document.getElementById('dm-messages');

    this._dmTarget = targetId;

    // Clear unread count and remove dm_inbox notification for this contact
    if (!this._dmUnreadMap) this._dmUnreadMap = {};
    this._dmUnreadMap[targetId] = 0;
    var sOpen = store.get();
    if (sOpen.roomCode && sOpen.myId) transport.clearDMInbox(sOpen.roomCode, sOpen.myId, targetId);
    this._updateDMDots();

    if (picker)   picker.classList.add('hidden');
    if (convo)    convo.classList.remove('hidden');
    if (withName) withName.textContent = '🤫 ' + targetName;

    // If already watching this same target, just scroll — don't re-fetch (messages already rendered)
    if (this._dmWatcher && this._dmWatcher.targetId === targetId) {
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      return;
    }

    // Stop old watcher (different target)
    if (this._dmWatcher) { this._dmWatcher.unsubFn(); this._dmWatcher = null; }

    // Clear and reload messages for new target
    if (msgs) msgs.innerHTML = '';

    var s = store.get();
    if (!s.roomCode || !s.myId) return;

    var unsubFn = transport.watchDM(s.roomCode, s.myId, targetId, function(msg) {
      bus.emit('dm:message', { msg: msg });
    });
    this._dmWatcher = { unsubFn: unsubFn, targetId: targetId };
  }

  _closeDMConvo() {
    // Do NOT clear _dmTarget — keep tracking which conversation is active for notifications
    // Just flip the UI back to picker view
    var picker = document.getElementById('dm-picker-view');
    var convo  = document.getElementById('dm-convo-view');
    if (picker) picker.classList.remove('hidden');
    if (convo)  convo.classList.add('hidden');
    this._dmTarget = null;   // null means "picker visible", watcher still runs
    this._renderDMPicker();
  }

  _updateDMDots() {
    var map    = this._dmUnreadMap || {};
    var anyDM  = Object.keys(map).some(function(k) { return map[k] > 0; });
    var dmDot  = document.getElementById('dm-tab-dot');
    if (dmDot) dmDot.classList.toggle('hidden', !anyDM);
    // Also update button dot (combines public + DM unread)
    var anyUnread = anyDM || this._chatUnread > 0;
    var btnDot = document.getElementById('chat-unread-dot');
    if (btnDot) btnDot.classList.toggle('hidden', !anyUnread || this._chatOpen);
    var openBtn = document.getElementById('chat-open-btn');
    if (openBtn && anyUnread && !this._chatOpen) openBtn.classList.remove('hidden');
  }

  _appendChatMsg(msg) {
    var cont = document.getElementById('fc-messages');
    if (!cont) return;
    // Dedup
    if (msg.ts && msg.ts <= this._chatSeenTs) return;
    if (msg.ts) this._chatSeenTs = Math.max(this._chatSeenTs, msg.ts);

    var s    = store.get();
    var isMe = msg.pid === s.myId;
    cont.appendChild(this._makeMsgEl(msg, isMe, false));
    cont.scrollTop = cont.scrollHeight;

    // Online badge
    var badge = document.getElementById('fc-online-badge');
    if (badge) { var lbl = Object.keys(s.players||{}).length+' 人在線'; if (badge.textContent!==lbl) badge.textContent=lbl; }

    // Unread if panel closed or on DM tab
    if (!this._chatOpen || this._activeTab !== 'public') {
      if (!isMe) {
        this._chatUnread++;
        if (!this._chatOpen) {
          var dot = document.getElementById('chat-unread-dot');
          if (dot) dot.classList.remove('hidden');
        }
      }
    }
  }

  _appendDMMsg(msg) {
    var s    = store.get();
    var isMe = msg.pid === s.myId;
    // The active watcher tells us which conversation this message belongs to
    var watchedId   = this._dmWatcher ? this._dmWatcher.targetId : null;
    var msgFromPid  = isMe ? watchedId : msg.pid;  // infer sender's conversation partner
    // Only render if convo view is open AND on DM tab AND panel is open
    var convoVisible = this._chatOpen && this._activeTab === 'dm' && this._dmTarget !== null;
    var msgBelongs   = this._dmTarget === msg.pid || (isMe && this._dmTarget !== null);
    var cont = document.getElementById('dm-messages');

    if (convoVisible && msgBelongs && cont) {
      cont.appendChild(this._makeMsgEl(msg, isMe, true));
      cont.scrollTop = cont.scrollHeight;
    } else if (!isMe) {
      // Not viewing this convo — accumulate per-pid unread count
      if (!this._dmUnreadMap) this._dmUnreadMap = {};
      var fromPid = watchedId || msg.pid;
      this._dmUnreadMap[fromPid] = (this._dmUnreadMap[fromPid] || 0) + 1;
      this._dmUnread++;
      this._updateDMDots();
    }
  }

  _makeMsgEl(msg, isMe, isDM) {
    var name    = msg.name || '???';
    var color   = Utils.avatarColor(name);
    var timeStr = '';
    if (msg.ts) {
      var d = new Date(msg.ts);
      timeStr = d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
    }
    var el = document.createElement('div');
    el.className = 'fc-msg' + (isMe ? ' fc-msg-me' : '');
    var bubbleCls = 'fc-msg-bubble' + (isMe ? ' fc-msg-bubble-me' : '') + (isDM ? ' dm-bubble' : '');
    if (isMe) {
      el.innerHTML =
        '<div class="fc-msg-body fc-msg-body-me">' +
          '<div class="fc-msg-meta-right">' +
            '<span class="fc-msg-time">' + timeStr + '</span>' +
            '<span class="fc-msg-name fc-msg-name-me">' + Utils.escapeHtml(name) + '</span>' +
          '</div>' +
          '<div class="' + bubbleCls + '">' + Utils.escapeHtml(msg.text || '') + '</div>' +
        '</div>';
    } else {
      el.innerHTML =
        '<div class="fc-msg-avatar" style="background:' + color + '">' + Utils.escapeHtml(name[0]) + '</div>' +
        '<div class="fc-msg-body">' +
          '<div class="fc-msg-meta">' +
            '<span class="fc-msg-name" style="color:' + color + '">' + Utils.escapeHtml(name) + '</span>' +
            '<span class="fc-msg-time">' + timeStr + '</span>' +
          '</div>' +
          '<div class="' + bubbleCls + '">' + Utils.escapeHtml(msg.text || '') + '</div>' +
        '</div>';
    }
    return el;
  }


  // ── Chaos Game Bindings ─────────────────────────────

  _bindChaosGame() {
    var self = this;

    // write_sentence
    var sInp = document.getElementById('chaos-sentence-input');
    this._on('btn-chaos-submit-sentence', 'click', function() {
      var t = (sInp||{}).value||''; if (!t.trim()) return self.toast('請先輸入句子','warn');
      chaosEngine.sendAction({ type: CHAOS_ACTION.SUBMIT_SENTENCE, text: t.trim() });
    });
    this._on('btn-chaos-unsubmit-sentence', 'click', function() { chaosEngine.sendAction({ type: CHAOS_ACTION.UNSUBMIT_SENTENCE }); });
    if (sInp) sInp.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault(); document.getElementById('btn-chaos-submit-sentence').click();} });

    // write_rule
    var rInp = document.getElementById('chaos-rule-input');
    this._on('btn-chaos-submit-rule', 'click', function() {
      var t = (rInp||{}).value||''; if (!t.trim()) return self.toast('請先輸入規則','warn');
      chaosEngine.sendAction({ type: CHAOS_ACTION.SUBMIT_RULE, text: t.trim() });
    });
    this._on('btn-chaos-unsubmit-rule', 'click', function() { chaosEngine.sendAction({ type: CHAOS_ACTION.UNSUBMIT_RULE }); });
    if (rInp) rInp.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault(); document.getElementById('btn-chaos-submit-rule').click();} });

    // modify
    var mInp = document.getElementById('chaos-modify-input');
    this._on('btn-chaos-submit-modify', 'click', function() {
      var t = (mInp||{}).value||''; if (!t.trim()) return self.toast('請先輸入修改結果','warn');
      chaosEngine.sendAction({ type: CHAOS_ACTION.SUBMIT_MODIFY, text: t.trim() });
    });
    this._on('btn-chaos-unsubmit-modify', 'click', function() { chaosEngine.sendAction({ type: CHAOS_ACTION.UNSUBMIT_MODIFY }); });
    if (mInp) mInp.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault(); document.getElementById('btn-chaos-submit-modify').click();} });

    // vote_reveal: vote + confirm + bonus + reactions — all via event delegation
    document.addEventListener('click', function(e) {
      var rb = e.target.closest('[data-chaos-rate]');
      if (rb) { chaosEngine.sendAction({ type: CHAOS_ACTION.VOTE_CARD, rating: rb.getAttribute('data-rating') }); return; }
      var bb = e.target.closest('[data-chaos-bonus]');
      if (bb) { chaosEngine.sendAction({ type: CHAOS_ACTION.BONUS_VOTE, targetPid: bb.getAttribute('data-target') }); return; }
      var em = e.target.closest('[data-chaos-react]');
      if (em) { chaosEngine.sendAction({ type: CHAOS_ACTION.REACT, emoji: em.getAttribute('data-emoji') }); return; }
      // Confirm card — dynamic button, must use delegation
      if (e.target && (e.target.id === 'btn-chaos-confirm-card' || e.target.closest('#btn-chaos-confirm-card'))) {
        chaosEngine.sendAction({ type: CHAOS_ACTION.CONFIRM_CARD }); return;
      }
    });

    // navigation
    this._on('btn-chaos-next-round',  'click', function() { chaosEngine.sendAction({ type: CHAOS_ACTION.HOST_NEXT_ROUND }); });
    this._on('btn-chaos-end-reveal',  'click', function() { chaosEngine.sendAction({ type: CHAOS_ACTION.END_REVEAL_NEXT }); });
    this._on('btn-chaos-back-lobby',  'click', function() { chaosEngine.sendAction({ type: CHAOS_ACTION.RETURN_LOBBY }); });
  }

  // ── Chaos Rendering ───────────────────────────────────

  _renderChaos(s) {
    var g = s.game, players = s.players, myId = s.myId, isHost = s.isHost, isSpectator = s.isSpectator;
    if (!g || g.gameType !== 'chaos') return;
    var phase = g.chaosPhase;

    // Auto-submit at last second (timeLeft===1) — avoids race with host phase transition at 0
    if (g.timeLeft === 1) {
      if (phase === 'write_sentence' && !(g.sentences||{})[myId]) {
        var si = document.getElementById('chaos-sentence-input');
        var st = si ? si.value.trim() : '';
        chaosEngine.sendAction({ type: CHAOS_ACTION.SUBMIT_SENTENCE, text: st || '（時間到）' });
      } else if (phase === 'write_rule' && !(g.rules||{})[myId]) {
        var ri = document.getElementById('chaos-rule-input');
        var rt = ri ? ri.value.trim() : '';
        chaosEngine.sendAction({ type: CHAOS_ACTION.SUBMIT_RULE, text: rt || '句子要很有趣' });
      } else if (phase === 'modify' && !(g.modifications||{})[myId]) {
        var mi = document.getElementById('chaos-modify-input');
        var mt = mi ? mi.value.trim() : '';
        chaosEngine.sendAction({ type: CHAOS_ACTION.SUBMIT_MODIFY, text: mt || '（時間到）' });
      }
    }

    var specOv = document.getElementById('chaos-spectator-overlay');
    if (specOv) specOv.classList.toggle('hidden', !isSpectator);
    if (isSpectator) { this._renderChaosSpectator(g, players); return; }

    var pn = { write_sentence:'✏️ 寫初始句子', write_rule:'📜 制定規則', rule_reveal:'🎲 規則揭曉！', modify:'🔧 修改句子', vote_reveal:'🃏 揭牌評分', round_result:'📊 回合結果', end:'🏆 遊戲結束' };
    var hdr = document.getElementById('chaos-header-info');
    if (hdr) hdr.textContent = '第 ' + g.chaosRound + ' / ' + g.totalRounds + ' 回合　' + (pn[phase]||'');

    var timerEl = document.getElementById('chaos-timer-val'), timerWrap = document.getElementById('chaos-timer-wrap');
    var showTimer = ['write_sentence','write_rule','modify','vote_reveal','rule_reveal'].includes(phase);
    if (timerWrap) timerWrap.classList.toggle('hidden', !showTimer);
    if (timerEl && showTimer) timerEl.textContent = g.timeLeft || 0;

    ['write-sentence','write-rule','rule-reveal','modify','vote-reveal','round-result','end'].forEach(function(p) {
      var el = document.getElementById('chaos-panel-' + p); if (el) el.classList.add('hidden');
    });

    if (phase === 'write_sentence') this._renderChaosWriteSentence(g, myId, players);
    if (phase === 'write_rule')     this._renderChaosWriteRule(g, myId, players);
    if (phase === 'rule_reveal')    this._renderChaosRuleReveal(g, players);
    if (phase === 'modify')         this._renderChaosModify(g, myId, players);
    if (phase === 'vote_reveal')    this._renderChaosVoteReveal(g, myId, players, isHost);
    if (phase === 'round_result')   this._renderChaosRoundResult(g, players, isHost);
    if (phase === 'end')            this._renderChaosEnd(g, players, isHost);
  }

  _showChaosPanel(id) { var el = document.getElementById('chaos-panel-' + id); if (el) el.classList.remove('hidden'); }

  _chaosInputReset(inputId, round) {
    var inp = document.getElementById(inputId);
    if (inp && inp.getAttribute('data-round') !== String(round)) {
      inp.value = ''; inp.setAttribute('data-round', round);
    }
  }

  _renderChaosWriteSentence(g, myId, players) {
    this._showChaosPanel('write-sentence');
    var submitted = !!(g.sentences||{})[myId];
    var ts       = g.gameStartTs || 0;
    var roundKey = ts + '_' + g.chaosRound + '_ws';
    this._chaosInputReset('chaos-sentence-input', roundKey);
    this._chaosInputReset('chaos-rule-input',     roundKey);
    this._chaosInputReset('chaos-modify-input',   roundKey);
    var inp = document.getElementById('chaos-sentence-input'); if (inp) inp.disabled = submitted;
    var btn = document.getElementById('btn-chaos-submit-sentence');
    if (btn) { btn.disabled = submitted; btn.textContent = submitted ? '✓ 已提交，等待其他人…' : '✦ 提交句子'; }
    var unBtn = document.getElementById('btn-chaos-unsubmit-sentence'); if (unBtn) unBtn.classList.toggle('hidden', !submitted);
    var pids = Object.keys(players).filter(function(id){return !players[id].isSpectator;});
    var prog = document.getElementById('chaos-sentence-progress');
    if (prog) prog.textContent = pids.filter(function(p){return !!(g.sentences||{})[p];}).length + ' / ' + pids.length + ' 人已提交';
  }

  _renderChaosWriteRule(g, myId, players) {
    this._showChaosPanel('write-rule');
    var submitted = !!(g.rules||{})[myId];
    var ts       = g.gameStartTs || 0;
    var roundKey = ts + '_' + g.chaosRound + '_wr';
    if (!submitted) this._chaosInputReset('chaos-rule-input', roundKey);
    var myS = document.getElementById('chaos-your-sentence'); if (myS) myS.textContent = (g.sentences||{})[myId] || '';
    var inp = document.getElementById('chaos-rule-input'); if (inp) inp.disabled = submitted;
    var btn = document.getElementById('btn-chaos-submit-rule');
    if (btn) { btn.disabled = submitted; btn.textContent = submitted ? '✓ 已提交，等待其他人…' : '✦ 提交規則'; }
    var unBtn = document.getElementById('btn-chaos-unsubmit-rule'); if (unBtn) unBtn.classList.toggle('hidden', !submitted);
    var pids = Object.keys(players).filter(function(id){return !players[id].isSpectator;});
    var prog = document.getElementById('chaos-rule-progress');
    if (prog) prog.textContent = pids.filter(function(p){return !!(g.rules||{})[p];}).length + ' / ' + pids.length + ' 人已提交';
  }

  _renderChaosRuleReveal(g, players) {
    this._showChaosPanel('rule-reveal');
    var el = document.getElementById('chaos-rule-text'); if (el) el.textContent = g.selectedRule || '';
    var auth = g.selectedRuleAuthor ? ((players[g.selectedRuleAuthor]||{}).name||'???') : '隨機';
    var tl   = (g.timeLeft != null && g.timeLeft > 0) ? g.timeLeft : '';
    var au = document.getElementById('chaos-rule-author');
    if (au) au.textContent = '規則由 ' + auth + ' 制定' + (tl !== '' ? ' · ' + tl + ' 秒後開始修改…' : ' · 即將開始修改…');
    // Timer for rule_reveal
    var timerWrap = document.getElementById('chaos-timer-wrap');
    var timerEl   = document.getElementById('chaos-timer-val');
    if (timerWrap) timerWrap.classList.toggle('hidden', !tl);
    if (timerEl && tl)   timerEl.textContent = tl;
  }

  _renderChaosModify(g, myId, players) {
    this._showChaosPanel('modify');
    var rEl = document.getElementById('chaos-modify-rule'); if (rEl) rEl.textContent = g.selectedRule || '';
    var origPid  = (g.assignments||{})[myId];
    var origText = origPid ? ((g.sentences||{})[origPid]||'') : '';
    var oEl = document.getElementById('chaos-modify-original'); if (oEl) oEl.textContent = origText || '（無）';
    var submitted = !!(g.modifications||{})[myId];
    var ts       = g.gameStartTs || 0;
    var roundKey = ts + '_' + g.chaosRound + '_mod';
    var inp = document.getElementById('chaos-modify-input');
    if (!submitted) {
      // Reset input on new round/game
      if (inp && inp.getAttribute('data-round') !== String(roundKey)) {
        inp.value = origText;  // ← pre-fill with original sentence
        inp.setAttribute('data-round', roundKey);
      }
    }
    if (inp) inp.disabled = submitted;
    var btn = document.getElementById('btn-chaos-submit-modify');
    if (btn) { btn.disabled = submitted; btn.textContent = submitted ? '✓ 已提交，等待其他人…' : '✦ 提交修改結果'; }
    var unBtn = document.getElementById('btn-chaos-unsubmit-modify');
    if (unBtn) unBtn.classList.toggle('hidden', !submitted);
    var pids = Object.keys(players).filter(function(id){return !players[id].isSpectator;});
    var prog = document.getElementById('chaos-modify-progress');
    if (prog) prog.textContent = pids.filter(function(p){return !!(g.modifications||{})[p];}).length + ' / ' + pids.length + ' 人已完成';
  }

  // ── vote_reveal: FULL SCREEN single card ──────────────
  _renderChaosVoteReveal(g, myId, players, isHost) {
    this._showChaosPanel('vote-reveal');
    var order    = Array.isArray(g.revealOrder) ? g.revealOrder : [];
    var cardIdx  = typeof g.voteCardIndex === 'number' ? g.voteCardIndex : 0;
    var total    = order.length;
    var editorPid  = order[cardIdx] || null;
    var assignments  = g.assignments  || {};
    var sentences    = g.sentences    || {};
    var modifications= g.modifications|| {};
    var myVoteForCard= editorPid ? ((g.votes||{})[myId]||{})[editorPid] : null;
    var myConfirmed  = !!(g.cardConfirmed||{})[myId];
    var pids         = Object.keys(players).filter(function(id){return !players[id].isSpectator;});
    var confirmedCount = pids.filter(function(p){return !!(g.cardConfirmed||{})[p];}).length;
    var reactions    = g.reactions || {};
    var myReact      = reactions[myId] || '';
    var myBonus      = (g.bonusVotes||{})[myId];
    var isSelf       = editorPid === myId;
    var canConfirm   = !myConfirmed && (isSelf || !!myVoteForCard);

    // Always update header (no animation)
    var ctr = document.getElementById('chaos-vote-card-counter');
    if (ctr) ctr.textContent = (cardIdx + 1) + ' / ' + total;
    var rEl = document.getElementById('chaos-vr-rule');
    if (rEl) rEl.textContent = g.selectedRule || '';

    var grid = document.getElementById('chaos-vr-grid'); if (!grid) return;

    // ── Card change: full rebuild WITH entry animation ──
    if (!editorPid) {
      grid.innerHTML = '<div class="chaos-reveal-waiting"><p>準備揭牌…</p></div>';
      grid.setAttribute('data-card', '-1'); return;
    }

    var isNewCard = grid.getAttribute('data-card') !== String(cardIdx);

    if (isNewCard) {
      grid.setAttribute('data-card', String(cardIdx));
      var origPid  = assignments[editorPid];
      var editor   = players[editorPid] || {};
      var origAuth = players[origPid]   || {};
      var orig     = sentences[origPid]     || '（未輸入）';
      var mod      = modifications[editorPid] || '（未修改）';
      var editorName = (myConfirmed || isSelf) ? Utils.escapeHtml(editor.name||'???') : '🎭 神秘改寫者';

      grid.innerHTML =
        '<div class="chaos-vote-card-full">' +
          '<div class="chaos-card-original"><span class="chaos-card-label">原句（' + Utils.escapeHtml((origAuth.name||'???')) + ' 所寫）</span>' +
            '<div class="chaos-card-text chaos-orig-big">' + Utils.escapeHtml(orig) + '</div></div>' +
          '<div class="chaos-card-arrow-big">↓</div>' +
          '<div class="chaos-card-modified"><span class="chaos-card-label">修改（<span id="cvr-editor-name">' + editorName + '</span>）</span>' +
            '<div class="chaos-card-text chaos-mod-big">' + Utils.escapeHtml(mod) + '</div></div>' +
          '<div id="cvr-rating-row" class="chaos-card-rating-row"></div>' +
          '<div id="cvr-bonus-wrap"></div>' +
        '</div>';

      grid.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Reset persistent elements for new card
      var confirmWrapNew = document.getElementById('cvr-confirm-wrap');
      if (confirmWrapNew) { confirmWrapNew.innerHTML = ''; confirmWrapNew._patchedConfirmed = false; }
      var ratingRowNew = document.getElementById('cvr-rating-row');
      if (ratingRowNew) { ratingRowNew._patchedVoted = false; }

      // Trigger entry animation exactly once
      var cardFull = grid.querySelector('.chaos-vote-card-full');
      if (cardFull) {
        cardFull.classList.add('card-enter');
        setTimeout(function() { if (cardFull) cardFull.classList.remove('card-enter'); }, 500);
      }
    }

    // ── Patch dynamic parts without rebuilding card ──

    // Editor name (revealed after confirm)
    var nameEl = document.getElementById('cvr-editor-name');
    if (nameEl) {
      var origPid2 = assignments[editorPid];
      var editor2  = players[editorPid] || {};
      var newName  = (myConfirmed || isSelf) ? Utils.escapeHtml(editor2.name||'???') : '🎭 神秘改寫者';
      if (nameEl.textContent !== newName) nameEl.textContent = newName;
    }

    // Rating row
    var ratingRow = document.getElementById('cvr-rating-row');
    if (ratingRow) {
      if (!isSelf && !myConfirmed) {
        var ratings = [
          {val:'violation', label:'💀 拉完了', cls:'vote-violation'},
          {val:'npc',       label:'🤖 NPC',     cls:'vote-npc'},
          {val:'normal',    label:'👤 人上人',   cls:'vote-normal'},
          {val:'great',     label:'⭐ 頂級',     cls:'vote-great'},
          {val:'goat',      label:'🔥 夯爆了',   cls:'vote-goat'},
        ];
        var newRatingHtml = ratings.map(function(r) {
          return '<button class="chaos-rating-big ' + r.cls + (myVoteForCard===r.val?' selected':'') + '" data-chaos-rate="1" data-rating="' + r.val + '">' + r.label + '</button>';
        }).join('');
        var curSelected = ratingRow.querySelector('.selected');
        var curVal = curSelected ? curSelected.getAttribute('data-rating') : null;
        if (curVal !== (myVoteForCard||null) || ratingRow.children.length !== 5) {
          ratingRow.innerHTML = newRatingHtml;
        }
      } else {
        var rLabel = {violation:'💀 拉完了', npc:'🤖 NPC', normal:'👤 人上人', great:'⭐ 頂級', goat:'🔥 夯爆了'};
        var voteText = myVoteForCard ? rLabel[myVoteForCard] : isSelf ? '（自己）' : '—';
        if (!ratingRow._patchedVoted) {
          ratingRow.innerHTML = '<div class="chaos-voted-label">你的評分：' + voteText + '</div>';
          ratingRow._patchedVoted = true;
        }
      }
    }

    // Bonus button
    var bonusWrap = document.getElementById('cvr-bonus-wrap');
    if (bonusWrap && !isSelf) {
      var bonusSel = myBonus === editorPid;
      var newBonusTxt = '💫 ' + (bonusSel ? '已選最喜歡 ✓' : '選為最喜歡');
      var existingBonus = bonusWrap.querySelector('.chaos-bonus-btn');
      if (!existingBonus) {
        bonusWrap.innerHTML = '<button class="chaos-bonus-btn' + (bonusSel?' selected':'') + '" data-chaos-bonus="1" data-target="' + editorPid + '">' + newBonusTxt + '</button>';
      } else {
        var needsSel = bonusSel !== existingBonus.classList.contains('selected');
        if (needsSel || existingBonus.textContent !== newBonusTxt) {
          existingBonus.className = 'chaos-bonus-btn' + (bonusSel?' selected':'');
          existingBonus.textContent = newBonusTxt;
        }
      }
    }

    // Confirm / confirmed label — persistent element in HTML
    var confirmWrap = document.getElementById('cvr-confirm-wrap');
    if (confirmWrap) {
      if (!myConfirmed) {
        var existingBtn = document.getElementById('btn-chaos-confirm-card');
        if (!existingBtn) {
          confirmWrap.innerHTML = '<button id="btn-chaos-confirm-card" class="btn btn-primary btn-full' + (canConfirm ? '' : ' hidden') + '">✓ 確認此張評分</button>';
        } else {
          existingBtn.classList.toggle('hidden', !canConfirm);
        }
      } else {
        if (!confirmWrap._patchedConfirmed) {
          confirmWrap.innerHTML = '<div class="chaos-confirmed-label">✓ 已確認，等待其他人…</div>';
          confirmWrap._patchedConfirmed = true;
        }
      }
    }

    // Confirmed count — persistent element
    var progEl = document.getElementById('cvr-progress');
    var progTxt = confirmedCount + ' / ' + pids.length + ' 人已確認';
    if (progEl && progEl.textContent !== progTxt) progEl.textContent = progTxt;

    // Reaction buttons — rebuild if myReact changed OR first render (innerHTML empty)
    var reactBtns = document.getElementById('cvr-react-btns');
    if (reactBtns) {
      var reactEmojis = ['😂','🔥','💀','👏','😮','🤣'];
      var curMark = reactBtns.getAttribute('data-react');
      // curMark===null means first render; always build then
      if (curMark === null || curMark !== (myReact || '')) {
        reactBtns.setAttribute('data-react', myReact || '');
        reactBtns.innerHTML = reactEmojis.map(function(em) {
          return '<button class="chaos-react-btn' + (myReact===em?' reacting':'') + '" data-chaos-react="1" data-emoji="' + em + '">' + em + '</button>';
        }).join('');
      }
    }

    // Reactions stage — keyed, spread positions
    var stage = document.getElementById('cvr-react-stage');
    if (stage) {
      // Build a keyed map so we only add NEW reactions, never rebuild existing ones
      var existing = {};
      stage.querySelectorAll('[data-react-pid]').forEach(function(el) {
        existing[el.getAttribute('data-react-pid')] = el;
      });
      // Remove stale
      Object.keys(existing).forEach(function(pid) {
        if (!reactions[pid]) existing[pid].remove();
      });
      // Add new ones at spread positions along the bottom
      Object.entries(reactions).forEach(function(pair, idx) {
        var pid2 = pair[0], emoji = pair[1];
        if (!existing[pid2]) {
          var span = document.createElement('span');
          span.setAttribute('data-react-pid', pid2);
          span.className = 'chaos-react-float';
          // Spread across 10%–90% width, staggered vertically by index
          var leftPct = 8 + (idx * 13) % 82;  // spread across width
          span.style.left = leftPct + '%';
          span.style.animationDuration = (2.2 + Math.random() * 0.8) + 's';
          span.textContent = emoji;
          stage.appendChild(span);
        }
      });
    }
  }

  _renderChaosRoundResult(g, players, isHost) {
    this._showChaosPanel('round-result');
    var pids   = Object.keys(players).filter(function(id){return !players[id].isSpectator;});
    var myId   = store.get().myId;
    var rs     = g.roundScores||{}, bs = g.bonusScores||{}, ts = g.scores||{};
    var order  = Array.isArray(g.revealOrder) ? g.revealOrder : [];
    // Sort by this-round score only (total stays hidden from others)
    var sorted = pids.slice().sort(function(a,b){ return (rs[b]||0)-(rs[a]||0); });
    var cont   = document.getElementById('chaos-round-result-list');
    if (cont) {
      // Round leaderboard — show round score only; own total is visible to self
      var lbHtml = '<div class="chaos-round-lb-title">📊 本回合得分</div>' +
        sorted.map(function(pid) {
          var p   = players[pid]||{};
          var r   = rs[pid]||0, b = bs[pid]||0;
          var isMePid = pid === myId;
          var totalHtml = isMePid
            ? '<span class="chaos-result-total cr-my-total">我的總分 '+(ts[pid]||0)+'</span>'
            : '<span class="chaos-result-total cr-hidden-total">總分 ???</span>';
          return '<div class="chaos-result-row">' +
            '<div class="chaos-result-avatar" style="background:'+Utils.avatarColor(p.name||pid)+'">'+((p.name||'?')[0])+'</div>' +
            '<div class="chaos-result-name-wrap">' +
              '<span class="chaos-result-name">'+Utils.escapeHtml(p.name||pid)+'</span>' +
              (b>0?'<span class="chaos-bonus-badge">💫 ×'+b+'</span>':'') +
            '</div>' +
            '<span class="chaos-result-round '+(r>0?'score-pos':r<0?'score-neg':'')+'">'+((r>0?'+':'')+r)+'</span>' +
            totalHtml +
          '</div>';
        }).join('');

      // Pairs section (all revealed)
      var assignments = g.assignments||{}, sentences = g.sentences||{}, modifications = g.modifications||{}, votes = g.votes||{};
      var pairsHtml = '<div class="chaos-pairs-section"><div class="chaos-pairs-title">本回合所有改句</div>' +
        order.map(function(editorPid) {
          var origPid  = assignments[editorPid];
          var editor   = players[editorPid]||{}, origAuth = players[origPid]||{};
          var orig     = sentences[origPid]||'', mod = modifications[editorPid]||'';
          var goat=0,great=0,normal=0,npc=0,violation=0;
          pids.forEach(function(vp){
            var r=(votes[vp]||{})[editorPid];
            if(r==='goat')goat++;else if(r==='great')great++;
            else if(r==='normal')normal++;else if(r==='npc')npc++;
            else if(r==='violation')violation++;
          });
          return '<div class="chaos-pair-card">' +
            '<div class="chaos-pair-meta"><span class="chaos-pair-editor">改寫者：'+Utils.escapeHtml(editor.name||'???')+'</span></div>' +
            '<div class="chaos-card-original"><span class="chaos-card-label">原句（'+Utils.escapeHtml(origAuth.name||'???')+'）</span><div class="chaos-card-text">'+Utils.escapeHtml(orig)+'</div></div>' +
            '<div class="chaos-card-arrow">↓</div>' +
            '<div class="chaos-card-modified"><div class="chaos-card-text chaos-card-text-mod">'+Utils.escapeHtml(mod)+'</div></div>' +
            '<div class="chaos-pair-tally">' +
              (goat?'🔥×'+goat+'　':'')+(great?'⭐×'+great+'　':'')+(normal?'👤×'+normal+'　':'')+(npc?'🤖×'+npc+'　':'')+(violation?'💀×'+violation:'') +
            '</div>' +
          '</div>';
        }).join('') + '</div>';

      cont.innerHTML = lbHtml + pairsHtml;
    }
    var nb = document.getElementById('btn-chaos-next-round');
    if (nb) {
      nb.classList.toggle('hidden', !isHost);
      nb.textContent = g.chaosRound >= g.totalRounds ? '🏆 進入最終揭示' : '➡ 下一回合';
    }
  }

  _renderChaosEnd(g, players, isHost) {
    this._showChaosPanel('end');
    var pids   = Object.keys(players).filter(function(id){return !players[id].isSpectator;});
    var sc     = g.scores||{}, gc = g.greatCounts||{}, vc = g.violationCounts||{};
    var step   = g.endRevealStep || 0;
    // Sort lowest→highest (reveal from worst to best)
    var sorted = pids.slice().sort(function(a,b){ return (sc[a]||0)-(sc[b]||0); });
    var n      = sorted.length;
    // maxStep = n (one reveal per player) + 2 (badges)
    var maxStep = n + 2;

    var cont = document.getElementById('chaos-end-list');
    var badges = document.getElementById('chaos-end-badges');

    if (cont) {
      // Step 0: blank — no one shown yet
      if (step === 0) {
        cont.innerHTML = '<div class="chaos-end-waiting"><div class="chaos-end-wait-icon">🏆</div><p>最終結果即將揭示…</p></div>';
      } else {
        // Steps 1…n: reveal one player per step (index 0=last place, n-1=1st place)
        var revealed = sorted.slice(0, step); // show bottom 'step' players revealed so far
        cont.innerHTML = revealed.map(function(pid, i) {
          var globalRank = i; // 0=last, n-1=first
          var revealRank = n - globalRank; // reverse: 1=first(best), n=last(worst)
          // Display rank from perspective of worst→best reveal
          var p      = players[pid]||{};
          var score  = sc[pid]||0;
          var isJustRevealed = i === revealed.length - 1;
          var isFirst  = globalRank === n - 1;
          var isSecond = globalRank === n - 2;
          var isThird  = globalRank === n - 3;
          var medal    = isFirst  ? '🥇' :
                         isSecond ? '🥈' :
                         isThird  ? '🥉' : (revealRank) + '.';
          var rowClass = 'chaos-result-row chaos-end-row' +
                         (isJustRevealed ? ' chaos-end-reveal-new' : '') +
                         (isFirst  ? ' chaos-end-first'  : '') +
                         (isSecond ? ' chaos-end-second' : '') +
                         (isThird  ? ' chaos-end-third'  : '');
          return '<div class="'+rowClass+'">' +
            '<span class="chaos-result-rank">'+medal+'</span>' +
            '<div class="chaos-result-avatar" style="background:'+Utils.avatarColor(p.name||pid)+'">'+((p.name||'?')[0])+'</div>' +
            '<div class="chaos-end-info"><span class="chaos-result-name">'+Utils.escapeHtml(p.name||pid)+'</span></div>' +
            '<span class="chaos-result-total chaos-end-total">'+score+' 分</span>' +
          '</div>';
        }).reverse().join(''); // show best at top
      }
    }

    // Badges (step > n)
    if (badges) {
      var html = '';
      if (step > n) {
        // Most 🔥/⭐ (top ratings)
        var mg = pids.reduce(function(a,b){return (gc[a]||0)>=(gc[b]||0)?a:b;}, pids[0]||'');
        html += '<div class="chaos-badge chaos-badge-great chaos-badge-reveal">⭐🔥 最受好評　<strong>'+Utils.escapeHtml((players[mg]||{}).name||'???')+'</strong></div>';
      }
      if (step > n + 1) {
        // Most violations
        var mv = pids.reduce(function(a,b){return (vc[a]||0)>=(vc[b]||0)?a:b;}, pids[0]||'');
        html += '<div class="chaos-badge chaos-badge-viol chaos-badge-reveal">💀 最多違規　<strong>'+Utils.escapeHtml((players[mv]||{}).name||'???')+'</strong></div>';
      }
      badges.innerHTML = html;
    }

    // Reveal button: visible to host as long as not at max
    var rb = document.getElementById('btn-chaos-end-reveal');
    if (rb) {
      rb.classList.toggle('hidden', !isHost || step >= maxStep);
      // Dynamic label for dramatic effect
      if (step === 0) rb.textContent = '✦ 開始揭示名次！';
      else if (step < n - 3) rb.textContent = '▶ 揭示下一位…';
      else if (step === n - 3) rb.textContent = '🥉 揭示第三名！';
      else if (step === n - 2) rb.textContent = '🥈 揭示第二名！';
      else if (step === n - 1) rb.textContent = '🥇 揭示第一名！！';
      else if (step === n) rb.textContent = '⭐ 揭示最佳獎項';
      else rb.textContent = '💀 揭示最差獎項';
    }

    // Back button only after all revealed
    var bb = document.getElementById('btn-chaos-back-lobby');
    if (bb) bb.classList.toggle('hidden', step < maxStep);
  }

  _renderChaosSpectator(g, players) {
    var cont = document.getElementById('chaos-spectator-content'); if (!cont) return;
    var pn = { write_sentence:'✏️ 寫初始句子', write_rule:'📜 制定規則', rule_reveal:'🎲 規則揭曉', modify:'🔧 修改中', vote_reveal:'🃏 揭牌評分', round_result:'📊 回合結果', end:'🏆 結束' };
    var html = '<div class="spec-phase-badge">'+(pn[g.chaosPhase]||g.chaosPhase)+'</div><div class="spec-round-info">第 '+g.chaosRound+' / '+g.totalRounds+' 回合</div>';
    if (g.selectedRule) html += '<div class="chaos-modify-rule-box" style="margin:8px 0"><span class="chaos-label">規則：</span><span class="chaos-modify-rule-text">'+Utils.escapeHtml(g.selectedRule)+'</span></div>';
    var sc = g.scores||{};
    var pids = Object.keys(players).filter(function(id){return !players[id].isSpectator;});
    if (pids.length) {
      var sorted = pids.slice().sort(function(a,b){return (sc[b]||0)-(sc[a]||0);});
      html += '<div class="chaos-result-list">'+sorted.map(function(pid,i){
        var p = players[pid]||{}, medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1)+'.';
        return '<div class="chaos-result-row"><span class="chaos-result-rank">'+medal+'</span><div class="chaos-result-avatar" style="background:'+Utils.avatarColor(p.name||pid)+'">'+((p.name||'?')[0])+'</div><span class="chaos-result-name">'+Utils.escapeHtml(p.name||pid)+'</span><span class="chaos-result-total">'+((sc[pid]||0)+' 分')+'</span></div>';
      }).join('')+'</div>';
    }
    cont.innerHTML = html;
  }


  // ── WW Rendering Entry Point ──────────────────────────

  _renderWW(s) {
    const { game: g, players, myId, isHost, isSpectator } = s;
    // Determine if this player is dead in-game (has role, not alive, not in end phase)
    const hasRole  = !!(g.roles || {})[myId];
    const amAlive  = !!(g.alive || {})[myId];
    const isDead   = hasRole && !amAlive && g.wwPhase !== 'end';
    // wolfking with pending secret shot needs special UI even while dead
    // Wolfking gets secret shot ONLY if wolf-killed (not witch-poisoned)
    const wkDeathCause = (g.deathLog || {})[myId] || '';
    const wolfkingWolfKilled = wkDeathCause === '被狼人獵殺'; // only if own-team kill (should not happen) or not witch
    const isWolfkingDeadWithPendingShot = isDead && (g.roles||{})[myId] === 'wolfking' && !g.wolfkingSecretReady
      && wkDeathCause !== '被女巫毒殺';  // witch kill = no ability
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
      const sp  = g.specialPending;
      const hdp = g.hunterDecidePending;
      const isSpecialActor = (g.wwPhase === 'special' && sp && sp.pid === myId)
                          || (hdp && hdp.pid === myId);

      if (!isSpecialActor) {
        this._renderWWDead(g, players, myId, isHost, isWolfkingDeadWithPendingShot, isHunterDeadWithShot);
        if (isHost) this._renderWWDeadHostBar(g);
        return;
      }
      // Actor falls through to render the special / hunter-decide panel below
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
    // Hunter private decision panel — shown only to the hunter, no phase change
    this._renderWWHunterDecide(g, players, myId);
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
          (g.wolfkingSecretTarget
            ? '<p class="dead-wk-chosen">✓ 已選擇目標，等待夜晚結束生效…</p>'
            : '<button class="special-pass-btn" style="margin-top:10px;width:100%" onclick="wwEngine.sendAction({type:WW_ACTION.WOLFKING_PASS})">🤝 放棄，不帶走任何人</button>'
          ) +
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
      // Hide role table if this player still has a pending special action
      // (they'll be moved to the special panel once it fires)
      (isWolfkingPending || isHunterPending || !!(g.hunterDecidePending && g.hunterDecidePending.pid === myId)
        ? '<div class="dead-pending-hint">⏳ 等待你的最後技能發動…</div>'
        : '<div class="spec-table-header"><span>玩家</span><span>存活</span><span>職業（點擊顯示）</span></div>' +
          '<div class="spectator-role-table">' + rows + '</div>' +
          '<div class="spectator-hint">你已出局，可靜靜觀察剩餘玩家的動向。' + (isHost ? ' 主持人控制列在右上角。' : '') + '</div>'
      );
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
    const isHW     = myRole === 'hiddenwolf';

    this._setText('ww-role-icon', roleDef.icon);
    this._setText('ww-role-name', roleDef.name);
    // hiddenwolf shows as wolf team internally but seer sees them as village
    var teamLabel = isHW ? '⚠️ 狼人陣營（預言家驗為金水）' : (isWolf ? '⚠️ 狼人陣營' : '✦ 村民陣營');
    this._setText('ww-role-team', teamLabel);
    this._setText('ww-role-desc', roleDef.desc);

    var card = document.getElementById('ww-role-card');
    if (card) {
      var cardTeam = myRole === 'hiddenwolf' ? 'hiddenwolf' : (isWolf ? 'wolf' : 'village');
      card.className = 'role-card role-' + cardTeam;
    }

    // Show teammates for wolves
    // hiddenwolf sees all wolf/wolfking teammates, but normal wolves do NOT see hiddenwolf
    var isHiddenWolf = myRole === 'hiddenwolf';
    var teammates = Object.entries(g.roles || {}).filter(function([pid, r]) {
      if (isHiddenWolf) return pid !== myId && (r === 'wolf' || r === 'wolfking');
      // Normal wolves: exclude hiddenwolf from their teammate list (they don't know hw)
      return pid !== myId && (r === 'wolf' || r === 'wolfking');
    });
    this._show('ww-wolf-teammates', (isWolf || isHiddenWolf) && teammates.length > 0);
    var tl = document.getElementById('ww-teammates-list');
    if (tl && (isWolf || isHiddenWolf)) {
      tl.innerHTML = teammates.map(function([pid]) {
        var p = players[pid] || {};
        var r = ROLES[g.roles[pid]] || {};
        return '<span class="teammate-chip"><span>' + Utils.escapeHtml(p.name || pid) + '</span>' +
               '<span class="teammate-role">' + (r.icon || '') + (r.name || '') + '</span></span>';
      }).join('');
      if (isHiddenWolf && teammates.length > 0) {
        tl.innerHTML += '<div class="hw-teammate-note">⚠️ 你的隊友並不知道你是隱狼</div>';
      }
    }

    // Only host sees "start night" button; others wait
    this._show('btn-ww-start-night', isHost);
    this._show('ww-night-starts',   !isHost);
  }

  _renderWWNight(g, myId, players) {
    const myRole      = (g.roles || {})[myId];
    const amWolf      = myRole === 'wolf' || myRole === 'wolfking';
    const amSeer      = myRole === 'seer';
    const amWitch     = myRole === 'witch';
    const amHunter    = myRole === 'hunter';
    const amGD        = myRole === 'gravedigger';
    const amHiddenWolf= myRole === 'hiddenwolf';
    const isActive    = NIGHT_ACTIVE_ROLES.has(myRole);
    const amDone      = !!(g.nightConfirmed || {})[myId];
    const amCupid     = myRole === 'cupid';
    // gravedigger is passive — doesn't block night end, always sees their panel
    const isPassive   = !isActive && !amHunter && !amCupid && !amGD && !amHiddenWolf;

    this._show('ww-night-wolf',        amWolf   && !amDone);
    this._show('ww-night-seer',        amSeer   && !amDone);
    this._show('ww-night-witch',       amWitch  && !amDone);
    this._show('ww-night-hunter',      amHunter && !amDone);
    this._show('ww-night-cupid',       amCupid  && !amDone && !g.cupidDone);
    this._show('ww-night-cupid-toy',   amCupid  && g.cupidDone);
    this._show('ww-night-gravedigger', amGD);
    // HiddenWolf: always shows their status panel; kill panel only when awakened
    // HiddenWolf always sees their status panel (like gravedigger) — kill panel when awakened
    this._show('ww-night-hiddenwolf',  amHiddenWolf);
    this._show('ww-night-passive',     isPassive && !amDone);
    // Waiting scene: active role done (includes hw after confirming)
    // HiddenWolf: when not awakened they show their status panel, not the waiting scene
    this._show('ww-night-waiting',
      (isActive && amDone && !(amHiddenWolf && !g.hiddenwolfAwakened)) ||
      ((isPassive || amHunter || amCupid) && amDone)
    );

    // ── Gravedigger panel ─────────────────────────────────
    if (amGD) {
      var gdHint = document.getElementById('gravedigger-night-hint');
      var gdLog  = document.getElementById('gravedigger-log-display');
      var logArr = Array.isArray(g.gravediggerLog) ? g.gravediggerLog
                 : Object.values(g.gravediggerLog || {});
      // Use a data-key to avoid rebuilding the DOM every render tick (fixes flicker)
      var logKey = g.wwRound + ':' + logArr.length;
      if (gdLog && gdLog.getAttribute('data-log-key') !== logKey) {
        gdLog.setAttribute('data-log-key', logKey);
        // Round 1: no info yet
        if (g.wwRound <= 1) {
          if (gdHint) gdHint.textContent = '第一夜尚無案卷可查…';
          gdLog.innerHTML = '<div class="gd-no-info">第二夜起才會有記錄</div>';
        } else {
          if (gdHint) gdHint.textContent = '查閱昨日白天放逐記錄';
          if (logArr.length === 0) {
            gdLog.innerHTML = '<div class="gd-no-info">昨日無人被投票放逐</div>';
          } else {
            gdLog.innerHTML = logArr.map(function(entry, i) {
              var isLatest = i === logArr.length - 1;
              var teamCls = entry.team === 'wolf'   ? 'gd-wolf' :
                            entry.team === 'bomber' ? 'gd-bomber' :
                            entry.team === 'third'  ? 'gd-third' : 'gd-village';
              var teamLabel = entry.team === 'wolf'   ? '狼人陣營' :
                              entry.team === 'bomber' ? '第三方' :
                              entry.team === 'third'  ? '第三方' : '村民陣營';
              return '<div class="gd-entry' + (isLatest ? ' gd-latest' : '') + '">' +
                '<span class="gd-round">第 ' + entry.round + ' 夜前</span>' +
                '<span class="gd-name">' + Utils.escapeHtml(entry.name || '???') + '</span>' +
                '<span class="gd-team ' + teamCls + '">' + teamLabel + '</span>' +
              '</div>';
            }).join('');
          }
        }
      }
      // else: key unchanged → DOM is already correct, skip to avoid flicker

      // Gravedigger ghost game toy
      var gdToy = document.getElementById('night-toy-gravedigger');
      if (gdToy && gdToy.getAttribute('data-init') !== '1') {
        gdToy.setAttribute('data-init', '1');
        gdToy.innerHTML =
          '<div class="toy-ghost-game">' +
            '<div class="ghost-field" id="gd-ghost-field"></div>' +
            '<div class="ghost-hud"><span id="ghost-banished">⚰️ 驅散：0</span><span id="ghost-escaped">👻 逃走：0</span></div>' +
            '<div id="toy-msg-ghost">點擊幽靈驅散它！</div>' +
          '</div>';

        (function() {
          var field    = gdToy.querySelector('#gd-ghost-field');
          var banishEl = gdToy.querySelector('#ghost-banished');
          var escEl    = gdToy.querySelector('#ghost-escaped');
          var msgEl    = gdToy.querySelector('#toy-msg-ghost');
          var banished = 0, escaped = 0;
          var ghosts   = ['👻','💀','🕯️','☠️'];
          var banishMsgs = ['驅散！','消散吧！','走開！','清靜了','成功！'];
          var escapeMsgs = ['跑掉了…','太快了','下次一定'];

          function spawnGhost() {
            if (!field) return;
            var fw = field.offsetWidth  || 200;
            var fh = field.offsetHeight || 80;
            var el = document.createElement('div');
            el.className = 'ghost-sprite';
            el.textContent = ghosts[Math.floor(Math.random() * ghosts.length)];
            var lx = 8 + Math.random() * (fw - 44);
            var ly = 4 + Math.random() * (fh - 36);
            el.style.left = lx + 'px';
            el.style.top  = ly + 'px';

            var alive = true;
            el.addEventListener('click', function(e) {
              if (!alive) return;
              e.stopPropagation();
              alive = false;
              el.style.animation = 'ghostBanish .45s ease forwards';
              banished++;
              if (banishEl) banishEl.textContent = '⚰️ 驅散：' + banished;
              if (msgEl) msgEl.textContent = banishMsgs[banished % banishMsgs.length];
              setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); spawnGhost(); }, 460);
            });

            field.appendChild(el);
            var escTime = 1800 + Math.random() * 900;
            setTimeout(function() {
              if (!alive) return;
              alive = false;
              escaped++;
              if (escEl) escEl.textContent = '👻 逃走：' + escaped;
              if (msgEl) msgEl.textContent = escapeMsgs[escaped % escapeMsgs.length];
              if (el.parentNode) el.parentNode.removeChild(el);
              setTimeout(spawnGhost, 500);
            }, escTime);
          }
          setTimeout(spawnGhost, 600);
          setTimeout(spawnGhost, 1600);
        })();
      }
    }

    // ── HiddenWolf night panel ──────────────────────────────
    if (amHiddenWolf) {
      var hwPanel = document.getElementById('ww-night-hiddenwolf');
      if (hwPanel) {
        var hwAwakened = !!g.hiddenwolfAwakened;
        var hwDone     = !!amDone;  // true when hw pre-confirmed (not awakened) or after confirming kill
        var hwShot     = g.hiddenwolfShot || null;
        // Build teammate status list
        var hwTeammates = Object.keys(g.roles || {}).filter(function(pid) {
          return g.roles[pid] === 'wolf' || g.roles[pid] === 'wolfking';
        });
        var teammateHtml = hwTeammates.length === 0
          ? '<div class="hw-no-teammates">所有普通狼隊友已全部出局</div>'
          : hwTeammates.map(function(pid) {
              var p = players[pid] || {};
              var alive2 = !!(g.alive || {})[pid];
              return '<div class="hw-teammate-row ' + (alive2 ? 'hw-alive' : 'hw-dead') + '">' +
                '<div class="hw-tm-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
                '<span class="hw-tm-name">' + Utils.escapeHtml(p.name||pid) + '</span>' +
                '<span class="hw-tm-status">' + (alive2 ? '✅ 存活' : '💀 死亡') + '</span>' +
              '</div>';
            }).join('');

        // dataKey: state signature — rebuild when state changes
        // Include hwDone so the panel updates after confirming
        var dataKey = (hwAwakened ? 'awk' : 'sleep') + ':' + hwDone + ':' + hwShot + ':' + Object.values(g.alive||{}).join('');
        if (hwPanel.getAttribute('data-hw-key') !== dataKey) {
          hwPanel.setAttribute('data-hw-key', dataKey);

          if (!hwAwakened) {
            // ── Not awakened: show status panel + moon toy ────────────
            // amDone is always true here (pre-confirmed by _startNight)
            hwPanel.innerHTML =
              '<div class="night-header" style="padding-bottom:4px">' +
                '<div class="night-moon" style="font-size:2rem">🥷</div>' +
                '<h2 style="font-family:var(--serif);color:var(--gold2)">隱狼，請閉上眼睛</h2>' +
                '<p class="night-hint">你的開刀權尚未覺醒。只要場上還有普通狼存活，靜靜等待即可。</p>' +
              '</div>' +
              '<div class="hw-teammate-section"><div class="hw-section-label">🐺 狼隊友狀態</div>' + teammateHtml + '</div>' +
              '<div class="night-toy-wrap">' +
                '<div class="night-toy" id="night-toy-hiddenwolf" title="點我互動" data-toy-role="hiddenwolf"></div>' +
              '</div>';
            // Init moon toy
            var hwToy = document.getElementById('night-toy-hiddenwolf');
            if (hwToy && hwToy.getAttribute('data-init') !== '1') {
              hwToy.setAttribute('data-init', '1');
              hwToy.innerHTML =
                '<div class="toy-scene">' +
                  '<div class="toy-star ts1">✦</div><div class="toy-star ts2">✧</div>' +
                  '<div class="toy-star ts3">✦</div><div class="toy-star ts4">✧</div>' +
                  '<div class="toy-moon" id="toy-moon-hw">🌕</div>' +
                  '<div class="toy-cloud tc1">☁</div><div class="toy-cloud tc2">☁</div>' +
                '</div>' +
                '<div class="toy-msg" id="toy-msg-hw">靜靜等待隊友的消息…</div>';
              var moonHW = hwToy.querySelector('#toy-moon-hw');
              var msgHW  = hwToy.querySelector('#toy-msg-hw');
              var moons  = ['🌕','🌖','🌗','🌘','🌑','🌒','🌓','🌔'];
              var mi = 0;
              var hwMsgs = ['守望月亮…','靜靜潛伏中…','等待時機…','你是最終的牌…','一切盡在掌握…'];
              if (moonHW) moonHW.addEventListener('click', function() {
                mi = (mi + 1) % moons.length;
                moonHW.textContent = moons[mi];
                if (msgHW) msgHW.textContent = hwMsgs[mi % hwMsgs.length];
                var spark = document.createElement('div');
                spark.className = 'toy-spark';
                spark.textContent = '🥷';
                spark.style.left = (30 + Math.random() * 40) + '%';
                spark.style.top  = (20 + Math.random() * 30) + '%';
                hwToy.appendChild(spark);
                setTimeout(function() { if (spark.parentNode) spark.parentNode.removeChild(spark); }, 700);
              });
            }

          } else if (!hwDone) {
            // ── Awakened, not yet confirmed: show kill grid ───────────
            var alivePidsForHW = Object.keys(g.alive||{}).filter(function(id) { return g.alive[id] && id !== myId; });
            var targetGrid = alivePidsForHW.map(function(pid) {
              var p = players[pid] || {};
              var isSel = hwShot === pid;
              return '<div class="vote-chip ' + (isSel ? 'selected' : '') + '" onclick="wwEngine.sendAction({type:WW_ACTION.HIDDENWOLF_SHOOT,targetId:\'' + pid + '\'})">' +
                '<div class="vote-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
                '<span>' + Utils.escapeHtml(p.name||pid) + '</span>' +
                (isSel ? '<span class="vote-tally">✓</span>' : '') +
              '</div>';
            }).join('');
            hwPanel.innerHTML =
              '<div class="night-header" style="padding-bottom:4px">' +
                '<div class="night-moon hw-awakened-icon">🐺</div>' +
                '<h2 class="hw-awakened-title">孤狼覺醒！開刀權已啟動</h2>' +
                '<p class="night-hint">所有狼隊友已出局，你是最後的希望。獨自選擇今晚的目標。</p>' +
              '</div>' +
              '<div class="hw-awakened-banner">🌕 你是最後的希望，開刀權已覺醒！</div>' +
              '<div class="hw-teammate-section"><div class="hw-section-label">🐺 狼隊友狀態</div>' + teammateHtml + '</div>' +
              '<div class="hw-kill-section"><div class="hw-section-label">🎯 選擇今晚目標</div>' +
              '<div class="player-vote-grid">' + targetGrid + '</div></div>' +
              '<div class="night-footer">' +
                '<button class="btn btn-danger" ' + (hwShot ? '' : 'disabled') + ' onclick="wwEngine.sendAction({type:WW_ACTION.HIDDENWOLF_CONFIRM})">🥷 確認刀人</button>' +
                '<button class="btn btn-ghost" onclick="wwEngine.sendAction({type:WW_ACTION.HIDDENWOLF_PASS})">🤝 今晚放棄行動</button>' +
              '</div>';

          } else {
            // ── Awakened and confirmed: waiting ───────────────────────
            hwPanel.innerHTML =
              '<div class="night-header">' +
                '<div class="night-moon hw-awakened-icon">🐺</div>' +
                '<h2 class="hw-awakened-title">已選擇目標，等待天亮</h2>' +
                '<p class="night-hint">你的刀已出手，靜靜等待結果…</p>' +
              '</div>' +
              '<div class="hw-teammate-section"><div class="hw-section-label">🐺 狼隊友狀態</div>' + teammateHtml + '</div>' +
              '<div style="text-align:center;padding:16px;color:var(--teal);font-size:1rem">✓ 已確認行動</div>';
          }
        }
      }
    }

    // ── Cupid toy (round 2+, after firing arrow) ──────────
    if (amCupid && g.cupidDone) {
      var cupidToy = document.getElementById('night-toy-cupid');
      if (cupidToy && cupidToy.getAttribute('data-init') !== '1') {
        cupidToy.setAttribute('data-init', '1');
        cupidToy.innerHTML =
          '<div class="toy-cupid-game">' +
            '<div class="cupid-sky" id="cupid-sky"></div>' +
            '<div class="cupid-hud">' +
              '<span id="cupid-hit-count">💘 命中：0</span>' +
              '<span id="cupid-miss-count">💔 失誤：0</span>' +
            '</div>' +
            '<div class="toy-msg" id="toy-msg-cupid">點擊愛心射箭！</div>' +
          '</div>';
        (function() {
          var sky    = cupidToy.querySelector('#cupid-sky');
          var hEl    = cupidToy.querySelector('#cupid-hit-count');
          var mEl    = cupidToy.querySelector('#cupid-miss-count');
          var msgEl  = cupidToy.querySelector('#toy-msg-cupid');
          var hits = 0, miss = 0;
          var hitMsgs  = ['💘 命中！','💕 愛的箭！','💝 射穿心！','❤️‍🔥 燃起來！','💞 配對！'];
          var missMsgs = ['💨 偏了…','😅 再瞄準','🏹 下次一定'];
          var hearts   = ['💗','💓','💞','💖','❤️','🩷','💝'];

          function spawnHeart() {
            if (!sky) return;
            var el     = document.createElement('div');
            el.className = 'cupid-heart-target';
            el.textContent = hearts[Math.floor(Math.random() * hearts.length)];
            var leftPct = 6 + Math.random() * 80;
            var dur     = 2200 + Math.random() * 1000;
            el.style.cssText = 'left:' + leftPct + '%;animation-duration:' + dur + 'ms';

            var alive = true;
            el.addEventListener('click', function(e) {
              if (!alive) return;
              e.stopPropagation(); alive = false; hits++;
              el.style.animation = 'heartPop .3s ease forwards';
              if (hEl)   hEl.textContent  = '💘 命中：' + hits;
              if (msgEl) msgEl.textContent = hitMsgs[hits % hitMsgs.length];
              setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
            });

            sky.appendChild(el);
            setTimeout(function() {
              if (!alive) return;
              alive = false; miss++;
              if (mEl)   mEl.textContent  = '💔 失誤：' + miss;
              if (msgEl) msgEl.textContent = missMsgs[miss % missMsgs.length];
              if (el.parentNode) el.parentNode.removeChild(el);
            }, dur + 100);

            setTimeout(spawnHeart, 700 + Math.random() * 800);
          }
          setTimeout(spawnHeart, 500);
          setTimeout(spawnHeart, 1400);
        })();
      }
    }

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
          // 💣 Bomber: FUSE CHARGE — click rapidly to charge the fuse; boom on full charge
          toyWrap.style.width  = '280px';
          toyWrap.style.height = '185px';
          toyWrap.innerHTML =
            '<div class="toy-bomber-game" id="toy-bomber-game">' +
              '<div class="bom-arena" id="bom-arena">' +
                '<div class="bom-bomb" id="bom-bomb">💣</div>' +
                '<div class="bom-fuse-wrap"><div class="bom-fuse-bar" id="bom-fuse-bar"></div></div>' +
                '<div class="bom-fuse-label" id="bom-fuse-label">導火線</div>' +
              '</div>' +
              '<div class="bom-hud"><span id="bom-clicks">點擊：0</span><span id="bom-booms">引爆：0</span></div>' +
              '<div class="toy-msg" id="toy-msg-bom">瘋狂點擊炸彈充能！</div>' +
            '</div>';
          (function() {
            var bomb    = toyWrap.querySelector('#bom-bomb');
            var fuseBar = toyWrap.querySelector('#bom-fuse-bar');
            var label   = toyWrap.querySelector('#bom-fuse-label');
            var clickEl = toyWrap.querySelector('#bom-clicks');
            var boomEl  = toyWrap.querySelector('#bom-booms');
            var msgEl   = toyWrap.querySelector('#toy-msg-bom');
            var arena   = toyWrap.querySelector('#bom-arena');
            var charge  = 0, clicks = 0, booms = 0, exploding = false;
            var MAX     = 100;

            var chargeMsgs = ['瘋狂點擊充能！','再用力一點！','快炸了！！','轟的一聲！','💣 引爆！'];
            var boomMsgs   = ['💥 BOOM！','🔥 轟！','💥 再來！','🌋 爆炸！'];

            function doExplode() {
              if (exploding) return;
              exploding = true;
              booms++;
              if (boomEl) boomEl.textContent = '引爆：' + booms;
              if (msgEl)  msgEl.textContent  = boomMsgs[booms % boomMsgs.length];
              if (bomb)   { bomb.textContent = '💥'; bomb.style.transform = 'scale(2)'; }
              if (fuseBar) fuseBar.style.width = '100%';

              // Flash the toy background
              if (toyWrap) {
                toyWrap.style.background = 'rgba(255,100,30,0.45)';
                setTimeout(function() { toyWrap.style.background = ''; }, 200);
              }

              // Shockwave ring
              if (arena) {
                var ring = document.createElement('div');
                ring.className = 'bom-shockwave';
                arena.appendChild(ring);
                setTimeout(function() { if (ring.parentNode) ring.parentNode.removeChild(ring); }, 600);
              }

              // Particles fly outward at different angles
              var emojis = ['💥','🔥','💨','⚡','🌋','✨','🔴','🟠'];
              for (var i = 0; i < 12; i++) {
                (function(idx) {
                  setTimeout(function() {
                    if (!arena) return;
                    var p = document.createElement('div');
                    p.className = 'bom-particle';
                    var angle   = (idx / 12) * 360;
                    var dist    = 40 + Math.random() * 30;
                    p.textContent = emojis[idx % emojis.length];
                    p.style.setProperty('--bom-dx', Math.cos(angle * Math.PI / 180) * dist + 'px');
                    p.style.setProperty('--bom-dy', Math.sin(angle * Math.PI / 180) * dist + 'px');
                    arena.appendChild(p);
                    setTimeout(function() { if (p.parentNode) p.parentNode.removeChild(p); }, 750);
                  }, idx * 25);
                })(i);
              }

              // Reset after 950ms
              setTimeout(function() {
                exploding = false;
                charge = 0;
                if (fuseBar) fuseBar.style.width = '0%';
                if (bomb)    { bomb.textContent = '💣'; bomb.style.transform = ''; }
                if (label)   { label.textContent = '導火線'; label.style.color = ''; }
              }, 950);
            }

            if (bomb) bomb.addEventListener('click', function() {
              if (exploding) return;
              clicks++;
              charge = Math.min(MAX, charge + 12);
              if (clickEl) clickEl.textContent = '點擊：' + clicks;
              if (fuseBar) fuseBar.style.width = charge + '%';
              // Shake bomb
              bomb.style.transform = 'scale(1.3) rotate(' + ((clicks*33)%360) + 'deg)';
              setTimeout(function() { if (!exploding) bomb.style.transform = ''; }, 120);
              // Update label urgency
              if (charge < 40)       { if (label) label.style.color = '#4ac0a0'; if(msgEl) msgEl.textContent = chargeMsgs[0]; }
              else if (charge < 70)  { if (label) label.style.color = '#fbbf24'; if(msgEl) msgEl.textContent = chargeMsgs[1]; }
              else if (charge < 90)  { if (label) label.style.color = '#fb923c'; if(msgEl) msgEl.textContent = chargeMsgs[2]; }
              else                   { if (label) label.style.color = '#ef4444'; if(msgEl) msgEl.textContent = chargeMsgs[3]; }
              if (charge >= MAX) doExplode();
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
      const targets = Object.keys(g.alive||{}).filter(id => g.alive[id]);
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

    // ── Seer result modal ─────────────────────────────────
    // Show once when seer has just confirmed their check this round.
    // Gate on a local flag so re-renders don't re-open it.
    if (amSeer && g.seerCheckedThisRound && amDone) {
      var seerModal  = document.getElementById('seer-result-modal');
      // Only show if not already visible AND not yet acked by the user this round
      if (seerModal && seerModal.classList.contains('hidden') && !seerModal._ackedRound) {
        var checkedPid = g.seerCheckedThisRound;
        var cp         = players[checkedPid] || {};
        var result     = (g.seerResults || {})[checkedPid];
        var isWolfResult = result === 'bad';
        var glyphEl  = document.getElementById('seer-result-glyph');
        var nameEl2  = document.getElementById('seer-result-name');
        var verdictEl= document.getElementById('seer-result-verdict');
        if (glyphEl)   glyphEl.textContent  = isWolfResult ? '🐺' : '✦';
        if (nameEl2)   nameEl2.textContent  = cp.name || checkedPid || '???';
        if (verdictEl) {
          verdictEl.textContent  = isWolfResult ? '⚠️ 狼人陣營！' : '✦ 好人陣營';
          verdictEl.className    = 'seer-result-verdict ' + (isWolfResult ? 'seer-bad' : 'seer-good');
        }
        seerModal.classList.remove('hidden');
      }
    } else if (!amDone) {
      // Reset ack flag at start of new night so modal can show again next round
      var sm = document.getElementById('seer-result-modal');
      if (sm) { sm.classList.add('hidden'); sm._ackedRound = false; }
    }

    // ── Seer panel (grid + history) ───────────────────────
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
      // Effective kill target: normal wolf kill OR hiddenwolf awakened kill.
      // Hiddenwolf identity is hidden — witch sees the victim but not who killed them.
      // hw target is only revealed to witch AFTER hw confirms (hiddenwolfDone=true),
      // so hw's selection doesn't prematurely expose the kill before confirmation.
      var effectiveKillTarget = g.wolfTarget ||
        (g.hiddenwolfAwakened && g.hiddenwolfDone && g.hiddenwolfShot ? g.hiddenwolfShot : null);
      var killedEl = document.getElementById('ww-witch-killed');
      if (killedEl) {
        if (effectiveKillTarget) {
          var targetName = (players[effectiveKillTarget] || {}).name || '???';
          var targetColor = Utils.avatarColor(targetName);
          killedEl.innerHTML =
            '<div class="witch-kill-label">今晚被狼人選中的是：</div>' +
            '<div class="witch-kill-name-row">' +
              '<div class="witch-target-avatar" style="background:' + targetColor + '">' + targetName[0] + '</div>' +
              '<span class="witch-kill-name">' + Utils.escapeHtml(targetName) + '</span>' +
            '</div>' +
            '<div class="witch-kill-hint">使用解藥可以救他</div>';
        } else {
          killedEl.innerHTML = '<div class="witch-kill-label witch-kill-wait">⏳ 等待狼人確認目標中…</div>';
        }
      }
      var saveBtn = document.getElementById('btn-witch-save');
      if (saveBtn) {
        var canSave = !g.witchAntidoteUsed && !!effectiveKillTarget;
        saveBtn.disabled    = !canSave;
        saveBtn.textContent = g.witchSave
          ? '✓ 解藥已選（再按取消）'
          : (g.witchAntidoteUsed ? '解藥已用完' : (effectiveKillTarget ? '💊 使用解藥救人' : '💊 解藥（今夜無目標）'));
        saveBtn.classList.toggle('active-choice', !!g.witchSave);
      }
      var witchPassBtn = document.getElementById('btn-witch-pass');
      if (witchPassBtn) {
        var summary = [];
        if (g.witchSave && effectiveKillTarget) summary.push('救人');
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

  _renderWWHunterDecide(g, players, myId) {
    // Private panel shown ONLY to the hunter while they decide.
    // CRITICAL: Must not run when wwPhase is 'special' — that phase has its own panel rendering.
    if (g.wwPhase === 'special') return;

    const hdp = g.hunterDecidePending;
    const panel = document.getElementById('ww-panel-special');
    if (!panel) return;

    if (!hdp || hdp.pid !== myId) {
      // Not this player's decide — clean up only if WE set this panel
      if (panel.getAttribute('data-for') === 'hunter-decide') {
        panel.innerHTML = ''; panel.setAttribute('data-for', '');
        this._show('ww-panel-special', false);
      }
      return;
    }

    // Show the private decide panel
    this._show('ww-panel-special', true);
    // Only rebuild if not already showing decide UI (avoid flicker)
    if (panel.getAttribute('data-for') !== 'hunter-decide') {
      panel.setAttribute('data-for', 'hunter-decide');
      const causeText = hdp.cause === 'wolf' ? '你被狼人獵殺，但你還有最後一槍' : '你被票出局，但你還有最後一槍';
      panel.innerHTML =
        '<div class="special-stage special-hunter-bg">' +
          '<div class="special-reveal-row">' +
            '<div class="special-role-icon">🏹</div>' +
            '<div class="special-reveal-info">' +
              '<div class="special-badge">獵人已出局</div>' +
              '<div class="special-actor-name">只有你看得到此畫面</div>' +
            '</div>' +
          '</div>' +
          '<h2 class="special-headline">你要帶走一名玩家嗎？</h2>' +
          '<p class="special-subline">' + causeText + '</p>' +
          '<div class="hunter-decide-btns">' +
            '<button class="hunter-decide-yes" onclick="wwEngine.sendAction({type:WW_ACTION.HUNTER_DECIDE})">🏹 是，我要亮牌並帶走一人</button>' +
            '<button class="hunter-decide-no"  onclick="wwEngine.sendAction({type:WW_ACTION.HUNTER_PASS})">🤝 否，讓我安靜地離開</button>' +
          '</div>' +
        '</div>';
    }
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
      passAction: WW_ACTION.HUNTER_PASS,
      waitLabel : '等待獵人選擇目標…',
      waitIcon  : '🏹',
    } : {
      bgClass   : 'special-wolfking-bg',
      icon      : '👑',
      actorBadge: '狼王落馬！',
      headline  : isActor ? '你是狼王 — 臨死帶走一名玩家！' : (Utils.escapeHtml(actorP.name||sp.pid) + ' 身份揭露！'),
      subline   : isActor ? '選擇你的最後一擊目標' : '狼王正在選擇目標…',
      action    : WW_ACTION.WOLFKING_SHOOT,
      passAction: WW_ACTION.WOLFKING_PASS,
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
            '<div class="special-actor-actions">' +
              '<p class="special-must-choose">選擇帶走一人，或選擇放棄</p>' +
              '<button class="special-pass-btn" onclick="wwEngine.sendAction({type:\'' + cfg.passAction + '\'})">' +
                '🤝 放棄，不帶任何人' +
              '</button>' +
            '</div>'
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
      var hwBadge    = roleId === 'hiddenwolf' ? '<span class="rr-lover-badge rr-hw-badge">🥷 金水偽裝</span>' : '';
      // For display: if third-party, show effective team
      var effectiveTeamClass = thirdPids.includes(pid) ? 'third' : role.team;
      return '<div class="rr-row ' + (isDead?'rr-dead-row':'') + ' team-' + effectiveTeamClass + '">' +
        '<div class="rr-avatar-wrap">' +
          '<div class="rr-avatar" style="background:' + Utils.avatarColor(p.name||pid) + '">' + (p.name||'?')[0] + '</div>' +
          (isDead ? '<div class="rr-skull">💀</div>' : '') +
        '</div>' +
        '<div class="rr-info">' +
          '<div class="rr-name">' + Utils.escapeHtml(p.name||pid) + loverBadge + thirdBadge + hwBadge + '</div>' +
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


  // ── Mad Lib Bindings ──────────────────────────────────

  _bindMadlibGame() {
    // btn-ml-reveal and btn-ml-back live in the static HTML — safe to bind once
    this._on('btn-ml-reveal', 'click', function() { madlibEngine.sendAction({ type: MADLIB_ACTION.REVEAL_NEXT }); });
    this._on('btn-ml-back',   'click', function() { madlibEngine.sendAction({ type: MADLIB_ACTION.RETURN_LOBBY }); });
    // btn-ml-submit / btn-ml-unsubmit are dynamically built inside ml-question-area.
    // They are bound directly in _renderMadlibAnswering via querySelector after innerHTML rebuild.
    // No _on() needed — avoids "element not found" warnings.
  }

  // ── Mad Lib Rendering ──────────────────────────────────

  _renderMadlib(s) {
    var g = s.game, players = s.players, myId = s.myId, isHost = s.isHost, isSpectator = s.isSpectator;
    if (!g || g.gameType !== 'madlib') return;
    var phase = g.mlPhase;

    // Header — only update text, never rebuild
    var hdr = document.getElementById('ml-header-info');
    if (hdr) {
      var phaseLabel = { answering:'填詞中', reveal:'故事揭示', end:'崩壞完成！' };
      var newHdr = '📝 故事崩壞中　' + (phaseLabel[phase] || '');
      if (hdr.textContent !== newHdr) hdr.textContent = newHdr;
    }
    // Timer — only update value, never rebuild
    var timerWrap = document.getElementById('ml-timer-wrap');
    var timerVal  = document.getElementById('ml-timer-val');
    var showTimer = phase === 'answering';
    if (timerWrap) timerWrap.classList.toggle('hidden', !showTimer);
    if (timerVal && showTimer) {
      var newTime = String(g.timeLeft || 0);
      if (timerVal.textContent !== newTime) timerVal.textContent = newTime;
    }

    // Auto-submit at t=1 — mirrors ChaosEngine's pattern.
    // Fires one second before host resolves at t=0, giving the action time to arrive
    // and be processed before _autoSubmitAll + _resolveCurrentRound run on the host.
    // Always sends (even empty textarea) so the host gets a real submission rather
    // than a '（時間到）' stamp — keeps the player's answer if they typed anything.
    if (phase === 'answering' && g.timeLeft === 1 && !isSpectator) {
      var cr0 = g.currentRound;
      if (!((g.submitted || {})[cr0] || {})[myId]) {
        var inp0 = document.getElementById('ml-answer-input');
        var txt0 = inp0 ? inp0.value.trim() : '';
        madlibEngine.sendAction({ type: MADLIB_ACTION.SUBMIT_ANSWER, text: txt0 || '（時間到）', roundIdx: cr0 });
      }
    }

    // Show correct panel (only hide others when phase changes)
    ['answering','reveal','end'].forEach(function(p) {
      var el = document.getElementById('ml-panel-' + p);
      if (el) el.classList.toggle('hidden', p !== phase);
    });

    // Spectator overlay
    var specOv = document.getElementById('ml-spectator-overlay');
    if (specOv) specOv.classList.toggle('hidden', !isSpectator);
    if (isSpectator) { this._renderMadlibSpectator(g, players); return; }

    if (phase === 'answering') this._renderMadlibAnswering(g, myId, players, isHost);
    if (phase === 'reveal')    this._renderMadlibReveal(g, isHost);
    if (phase === 'end')       this._renderMadlibEnd(g);
  }

  _renderMadlibAnswering(g, myId, players, isHost) {
    var panel = document.getElementById('ml-panel-answering');
    if (!panel) return;
    var cr = g.currentRound;
    // Firebase serializes arrays as objects ({0:v,1:v}) — normalize defensively
    var roundsArr = Array.isArray(g.rounds) ? g.rounds : Object.values(g.rounds || {});
    var round = roundsArr[cr];
    if (!round) return;
    // Normalize buffer slots array (Firebase object→array)
    if (round.type === 'buffer' && round.slots && !Array.isArray(round.slots)) {
      round = Object.assign({}, round, { slots: Object.values(round.slots) });
    }
    // assignments is {pid: qIdx} — already an object, no normalization needed for independent
    var template = MadlibTemplates.getById(g.selectedTemplateId);
    if (!template) return;
    var totalRounds = roundsArr.length;
    var submitted   = !!((g.submitted || {})[cr] || {})[myId];

    // Round info — only round number, no type label (Fix 2)
    var roundInfo = document.getElementById('ml-round-info');
    if (roundInfo) {
      var newInfo = '第 ' + (cr+1) + ' / ' + totalRounds + ' 輪';
      if (roundInfo.getAttribute('data-ri') !== newInfo) {
        roundInfo.setAttribute('data-ri', newInfo);
        roundInfo.innerHTML = '<span class="ml-round-badge">' + newInfo + '</span>';
      }
    }

    // My question index — depends on round type
    var myQIdx = null;
    if (round.type === 'independent') {
      myQIdx = (round.assignments || {})[myId];
    } else if (round.type === 'buffer') {
      // Find which slot this player belongs to
      var slotsRender = Array.isArray(round.slots) ? round.slots : Object.values(round.slots || {});
      for (var si = 0; si < slotsRender.length; si++) {
        var slotPidsR = Array.isArray(slotsRender[si].pids) ? slotsRender[si].pids : Object.values(slotsRender[si].pids || {});
        if (slotPidsR.indexOf(myId) >= 0) { myQIdx = slotsRender[si].questionIdx; break; }
      }
    }
    var myPrompt = (myQIdx !== undefined && myQIdx !== null) ? template.prompts[myQIdx] : null;

    // Progress — normalize activePids (Firebase may serialize as object)
    var activePidsNorm = Array.isArray(g.activePids) ? g.activePids : Object.values(g.activePids || {});
    var relevantPids;
    if (round.type === 'buffer') {
      var slotsRP = Array.isArray(round.slots) ? round.slots : Object.values(round.slots || {});
      relevantPids = [];
      slotsRP.forEach(function(slot) {
        var sp = Array.isArray(slot.pids) ? slot.pids : Object.values(slot.pids || {});
        relevantPids = relevantPids.concat(sp);
      });
    } else {
      relevantPids = activePidsNorm;
    }
    var submittedCount = relevantPids.filter(function(p) { return !!((g.submitted || {})[cr] || {})[p]; }).length;
    var totalCount     = relevantPids.length;
    var progEl = document.getElementById('ml-answer-progress');
    if (progEl) {
      var newProg = submittedCount + ' / ' + totalCount + ' 人已提交';
      if (progEl.textContent !== newProg) progEl.textContent = newProg;
    }

    // Question card:
    // - submitted / no-q states: always rebuild (no textarea to protect, stale HTML must be cleared)
    // - textarea state (!submitted): guard with data-card-key to avoid destroying content mid-typing
    var qArea = document.getElementById('ml-question-area');
    if (!qArea) return;

    if (myPrompt === null || myPrompt === undefined) {
      // Not assigned a question this round
      qArea.removeAttribute('data-card-key');
      qArea.innerHTML = '<div class="ml-no-q">🎲 這輪靜靜等待…</div>';

    } else if (submitted) {
      // Always rebuild the locked view — no textarea to protect, and stale locked HTML
      // must be replaced when the round advances (even if cr changes, old HTML stays until rebuilt).
      qArea.removeAttribute('data-card-key');
      var myAns = ((g.answers || {})[cr] || {})[myId] || '';
      qArea.innerHTML =
        '<div class="ml-submitted-card">' +
          '<div class="ml-q-label">✍ 你的答案</div>' +
          '<div class="ml-answer-display">' + Utils.escapeHtml(myAns) + '</div>' +
          '<button class="btn btn-ghost ml-unsubmit-btn" style="margin-top:10px;width:100%">↩ 取消，重新填寫</button>' +
        '</div>' +
        '<div class="ml-waiting-dots">等待其他人…<div class="wl-dots"><span></span><span></span><span></span></div></div>';
      var unBtn = qArea.querySelector('.ml-unsubmit-btn');
      // Store the previously submitted answer on the area so that when the card rebuilds
      // (after unsubmit clears data-card-key), the textarea can be pre-filled with it.
      // Scope it with cardKey so it doesn't bleed into a different round/question.
      var prevCardKey = cr + ':' + String(myQIdx);
      qArea.setAttribute('data-prev-ans', myAns);
      qArea.setAttribute('data-prev-ans-key', prevCardKey);
      if (unBtn) unBtn.addEventListener('click', function() {
        madlibEngine.sendAction({ type: MADLIB_ACTION.UNSUBMIT_ANSWER });
      });

    } else {
      // Textarea state: only rebuild if round or question changed, to preserve mid-typing content.
      var cardKey = cr + ':' + String(myQIdx);
      if (qArea.getAttribute('data-card-key') === cardKey) return;
      qArea.setAttribute('data-card-key', cardKey);
      // Restore previously submitted answer (if player just pressed "取消，重新填寫")
      // Only apply if the stored key matches this card — prevents bleeding into the next round.
      var prevAns = '';
      if (qArea.getAttribute('data-prev-ans-key') === cardKey) {
        prevAns = qArea.getAttribute('data-prev-ans') || '';
      }
      qArea.removeAttribute('data-prev-ans');
      qArea.removeAttribute('data-prev-ans-key');
      qArea.innerHTML =
        '<div class="ml-question-card">' +
          '<div class="ml-q-prompt">' + Utils.escapeHtml(myPrompt) + '</div>' +
          '<textarea class="ml-answer-textarea chaos-textarea" id="ml-answer-input" placeholder="輸入你的答案…" maxlength="50" rows="2" autocomplete="off"></textarea>' +
          '<button class="btn btn-primary btn-full ml-submit-btn" style="margin-top:10px">✦ 送出答案</button>' +
        '</div>';
      var subBtn = qArea.querySelector('.ml-submit-btn');
      var inp    = qArea.querySelector('#ml-answer-input');
      // Restore the previous answer text so the player can edit it rather than starting blank
      if (inp && prevAns) inp.value = prevAns;
      var doSubmit = function() {
        var txt = inp ? inp.value.trim() : '';
        if (!txt) return;
        madlibEngine.sendAction({ type: MADLIB_ACTION.SUBMIT_ANSWER, text: txt, roundIdx: cr });
      };
      if (subBtn) subBtn.addEventListener('click', doSubmit);
      if (inp)    { inp.focus(); inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSubmit(); }
      }); }
    }
  }

  _renderMadlibReveal(g, isHost) {
    var panel = document.getElementById('ml-panel-reveal');
    if (!panel) return;
    panel.classList.remove('hidden');
    var template = MadlibTemplates.getById(g.selectedTemplateId);
    if (!template) return;
    var Q    = template.prompts.length;
    var step = g.revealStep || 0;

    var titleEl = document.getElementById('ml-reveal-title');
    if (titleEl) titleEl.textContent = template.title;
    var progEl  = document.getElementById('ml-reveal-progress');
    if (progEl)  progEl.textContent = '已揭示 ' + step + ' / ' + Q + ' 格';

    var storyEl = document.getElementById('ml-story-display');
    if (storyEl) storyEl.innerHTML = this._buildStoryHTML(template.story, g.selectedAnswers, step);

    var revBtn  = document.getElementById('btn-ml-reveal');
    var watchEl = document.getElementById('ml-reveal-watch');
    if (revBtn)  revBtn.classList.toggle('hidden',  !isHost || step >= Q);
    if (watchEl) watchEl.classList.toggle('hidden', isHost);
  }

  _renderMadlibEnd(g) {
    var panel = document.getElementById('ml-panel-end');
    if (!panel) return;
    panel.classList.remove('hidden');
    var template = MadlibTemplates.getById(g.selectedTemplateId);
    if (!template) return;
    var titleEl = document.getElementById('ml-end-title');
    if (titleEl) titleEl.textContent = template.title;
    var storyEl = document.getElementById('ml-end-story');
    if (storyEl) {
      var Q = template.prompts.length;
      storyEl.innerHTML = this._buildStoryHTML(template.story, g.selectedAnswers, Q);
    }
  }

  _renderMadlibSpectator(g, players) {
    var cont = document.getElementById('ml-spectator-content');
    if (!cont) return;
    var phase = g.mlPhase;
    var phaseNames = { answering:'填詞中', reveal:'故事揭示', end:'已完成' };
    var html = '<div class="spec-phase-badge">' + (phaseNames[phase]||phase) + '</div>';
    if (g.selectedTemplateId) {
      var tpl = MadlibTemplates.getById(g.selectedTemplateId);
      if (tpl) html += '<div class="spec-round-info">📖 ' + Utils.escapeHtml(tpl.title) + '</div>';
    }
    if (phase === 'answering') {
      var cr = g.currentRound;
      var total = (g.rounds || []).length;
      var sub   = Object.keys(((g.submitted || {})[cr] || {})).length;
      var act   = (g.activePids || []).length;
      html += '<div class="spec-round-info">第 ' + (cr+1) + ' / ' + total + ' 輪　' + sub + ' / ' + act + ' 人已提交</div>';
    }
    cont.innerHTML = html;
  }

  // Parse story text and build HTML with revealed/hidden blanks
  _buildStoryHTML(storyText, selectedAnswers, revealStep) {
    var parts = storyText.split(/\{(\d+)\}/g);
    var colors = ['#4ac0a0','#c9a84c','#9b85e8','#e07050','#60b0e8','#e8845e'];
    var html = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        html += Utils.escapeHtml(parts[i]);
      } else {
        var qIdx   = parseInt(parts[i]);
        var answer = selectedAnswers[qIdx];
        if (answer !== undefined && qIdx < revealStep) {
          var color = colors[qIdx % colors.length];
          html += '<span class="ml-answer-filled" style="color:' + color + ';border-bottom-color:' + color + '">' + Utils.escapeHtml(answer) + '</span>';
        } else {
          html += '<span class="ml-blank-slot" data-idx="' + qIdx + '">　　　　</span>';
        }
      }
    }
    return html;
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