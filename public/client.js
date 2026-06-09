// ============================================================================
// Chinese Poker - client. Renders server state; sends play/pass/room actions.
// Adds: Web Audio sound effects, theme toggle (wood/dark), bots in lobby.
// ============================================================================
const socket = io();

// Persistent per-browser identity so we can reconnect to our seat.
let playerId = localStorage.getItem('cp_playerId');
if (!playerId) {
  playerId = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem('cp_playerId', playerId);
}

const SUIT = { D: '♦', C: '♣', H: '♥', S: '♠' };
const RED = { D: true, H: true };

let state = null;
let prev = null; // previous state, for diffing (sound cues)
let selected = new Set();
let roomCode = null;
let handRows = [[], [], []]; // up to 3 rows; the player arranges cards freely
let drag = null; // active drag-and-drop operation
let dealAnim = false; // one-shot: play the deal-in animation / reset rows on a new deal
let lastTapCode = null, lastTapTime = 0; // for double-tap-to-play detection

const $ = (id) => document.getElementById(id);
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}
function parseCode(code) {
  return { rank: code.slice(0, -1), suit: code.slice(-1) };
}
function cardEl(code, opts = {}) {
  const { rank, suit } = parseCode(code);
  const el = document.createElement('div');
  el.className = 'card ' + (RED[suit] ? 'red' : 'black') + (opts.small ? ' small' : '') + (opts.deal ? ' dealing' : '');
  el.dataset.code = code;
  const sym = SUIT[suit];
  el.innerHTML =
    `<div class="corner">${rank}<br>${sym}</div>` +
    `<div class="pip">${sym}</div>` +
    `<div class="corner bottom">${rank}<br>${sym}</div>`;
  return el;
}

// ============================ THEME ============================
const savedTheme = localStorage.getItem('cp_theme') || 'wood';
document.documentElement.setAttribute('data-theme', savedTheme);
$('themeBtn').textContent = savedTheme === 'wood' ? '🌳' : '🌙';
$('themeBtn').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'wood' ? 'dark' : 'wood';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('cp_theme', next);
  $('themeBtn').textContent = next === 'wood' ? '🌳' : '🌙';
};

// ============================ SOUND (Web Audio, no asset files) ============
let muted = localStorage.getItem('cp_muted') === '1';
$('muteBtn').textContent = muted ? '🔇' : '🔊';
$('muteBtn').onclick = () => {
  muted = !muted;
  localStorage.setItem('cp_muted', muted ? '1' : '0');
  $('muteBtn').textContent = muted ? '🔇' : '🔊';
  if (!muted) beep(660, 0.07, 'sine', 0.2);
};

let audioCtx = null;
function ac() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// Unlock audio on first user interaction (mobile browsers require this).
['pointerdown', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, () => ac(), { once: true })
);

function beep(freq, dur = 0.1, type = 'sine', gain = 0.18, when = 0) {
  if (muted) return;
  const ctx = ac();
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}
const SFX = {
  play: () => beep(420, 0.08, 'triangle', 0.16),
  pass: () => beep(200, 0.12, 'sine', 0.14),
  turn: () => { beep(760, 0.09, 'sine', 0.18); beep(1010, 0.09, 'sine', 0.14, 0.08); },
  alert: () => { beep(300, 0.14, 'square', 0.12); beep(300, 0.14, 'square', 0.12, 0.18); },
  deal: () => { for (let i = 0; i < 4; i++) beep(500 + i * 40, 0.05, 'triangle', 0.08, i * 0.05); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.18, 'sine', 0.2, i * 0.12)),
  lose: () => [392, 330, 262].forEach((f, i) => beep(f, 0.22, 'sine', 0.16, i * 0.14)),
};

// ============================ EMOJI QUICK-CHAT ============================
const REACT_EMOJIS = ['👍', '😂', '😮', '😎', '🔥', '😭', '🎉', '🤔', '👏', '🫡'];
const REACT_PHRASES = ['ayree', 'GG', 'blghalatt', 'maberba7', 'werrr', 'laa wloo', 'asra33'];

(function buildTray() {
  const tray = $('reactTray');
  REACT_EMOJIS.forEach((e) => {
    const b = document.createElement('button');
    b.className = 'r-emoji';
    b.textContent = e;
    b.onclick = () => sendReaction(e);
    tray.appendChild(b);
  });
  REACT_PHRASES.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'r-phrase';
    b.textContent = p;
    b.onclick = () => sendReaction(p);
    tray.appendChild(b);
  });
})();

$('reactBtn').onclick = () => {
  ac();
  const panel = $('chatPanel');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if (opening) { clearUnread(); setTimeout(() => $('chatInput').focus(), 50); }
};
function sendReaction(emoji) {
  localEcho(emoji);
  socket.emit('reaction', { emoji });
}
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('chatInput');
  const text = inp.value.trim().slice(0, 140);
  if (!text) return;
  localEcho(text);
  socket.emit('chat', { text });
  inp.value = '';
  inp.focus();
});
// show your own message immediately (server relays to the others)
function localEcho(content) {
  if (!state || !state.players[state.yourSeat]) return;
  const me = state.players[state.yourSeat];
  showReaction(state.yourSeat, me.name, content);
  addChatLog(state.yourSeat, me.name, content);
}

socket.on('reaction', ({ seat, name, emoji }) => {
  showReaction(seat, name, emoji);
  addChatLog(seat, name, emoji);
  beep(720, 0.06, 'triangle', 0.1);
});
socket.on('chat', ({ seat, name, text }) => {
  showReaction(seat, name, text);
  addChatLog(seat, name, text);
  beep(660, 0.05, 'sine', 0.08);
});

function addChatLog(seat, name, text) {
  const log = $('chatLog');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'msg' + (state && seat === state.yourSeat ? ' me' : '');
  div.innerHTML = `<span class="who">${escapeHtml(name)}:</span>${escapeHtml(text)}`;
  log.appendChild(div);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
  if ($('chatPanel').classList.contains('hidden')) markUnread();
}
function markUnread() { $('chatUnread').classList.remove('hidden'); }
function clearUnread() { $('chatUnread').classList.add('hidden'); }

function showReaction(seat, name, content) {
  if (!state) return;
  let target;
  if (seat === state.yourSeat) target = document.querySelector('.your-area');
  else target = document.querySelector(`.opp[data-seat="${seat}"]`);
  if (!target) return;
  const bubble = document.createElement('div');
  const isEmoji = REACT_EMOJIS.includes(content);
  bubble.className = 'reaction-bubble' + (isEmoji ? ' big' : ' text');
  bubble.textContent = content;
  target.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2600);
}

// ============================ SCOREBOARD ============================
$('scoreBtn').onclick = () => {
  if (!state || !state.players) return;
  showScores();
};
$('scoresClose').onclick = () => $('scoresOverlay').classList.add('hidden');
function showScores() {
  const ranked = state.players.slice().sort((a, b) => a.score - b.score);
  const playing = state.phase === 'playing';
  const rows = ranked
    .map((p, i) => {
      const cards = playing ? `${p.cardCount}` : '—';
      const you = p.isYou ? ' (you)' : '';
      const bot = p.isBot ? ' 🤖' : '';
      return `<tr class="${i === 0 ? 'rank-1' : ''}"><td>${i + 1}. ${escapeHtml(p.name)}${you}${bot}</td><td class="num">${p.score} / 101</td><td class="num">${cards}</td></tr>`;
    })
    .join('');
  $('scoresBody').innerHTML =
    '<p class="muted" style="margin:0 0 8px">First to reach 101 loses — lowest score wins.</p>' +
    `<table class="score-table"><tr><th>Rank</th><th class="num">Score</th><th class="num">Cards left</th></tr>${rows}</table>`;
  $('scoresOverlay').classList.remove('hidden');
}

// ============================ STATS ============================
$('statsBtn').onclick = () => {
  socket.emit('getStats', { playerId }, (res) => {
    showStats(res && res.ok ? res.stats : null);
  });
};
$('statsClose').onclick = () => $('statsOverlay').classList.add('hidden');

function showStats(s) {
  const body = $('statsBody');
  if (!s || !s.matchesPlayed) {
    body.innerHTML = '<p class="stat-empty">No matches finished yet. Play a full match to 101 and your record shows up here!</p>';
  } else {
    const winPct = s.matchesPlayed ? Math.round((s.matchesWon / s.matchesPlayed) * 100) : 0;
    body.innerHTML =
      `<p class="muted" style="margin:0 0 4px">Playing as <strong>${escapeHtml(s.name)}</strong></p>` +
      '<div class="stat-grid">' +
      statCard(s.matchesPlayed, 'Matches') +
      statCard(s.matchesWon, 'Matches won') +
      statCard(winPct + '%', 'Win rate') +
      statCard(s.roundsWon, 'Rounds won') +
      statCard(s.matchesLost, 'Last place') +
      statCard(s.points, 'Penalty pts (total)') +
      '</div>';
  }
  $('statsOverlay').classList.remove('hidden');
}
function statCard(num, lbl) {
  return `<div class="stat-card"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`;
}

// ============================ VOICE CHAT (WebRTC) ============================
const ICE = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
] };
const voice = { joined: false, stream: null, peers: {}, micOn: true, spkOn: true };

async function joinVoice() {
  if (voice.joined) { leaveVoice(); return; }
  if (!state) { flashError('Join a game first.'); return; }
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    flashError('Microphone blocked — allow mic access to use voice.');
    return;
  }
  voice.joined = true; voice.micOn = true; applyMic();
  socket.emit('voiceJoin');
  updateVoiceUI();
}
function leaveVoice() {
  socket.emit('voiceLeave');
  Object.keys(voice.peers).forEach(closePeer);
  if (voice.stream) { voice.stream.getTracks().forEach((t) => t.stop()); voice.stream = null; }
  voice.joined = false;
  updateVoiceUI();
}
function applyMic() { if (voice.stream) voice.stream.getAudioTracks().forEach((t) => (t.enabled = voice.micOn)); }
function vsig(to, data) { socket.emit('voiceSignal', { to, data }); }

function makePeer(peerId, initiator) {
  if (voice.peers[peerId]) return voice.peers[peerId];
  const pc = new RTCPeerConnection(ICE);
  const audio = document.createElement('audio');
  audio.autoplay = true; audio.playsInline = true; audio.muted = !voice.spkOn;
  document.body.appendChild(audio);
  const entry = { pc, audio, pending: [] };
  voice.peers[peerId] = entry;
  if (voice.stream) voice.stream.getTracks().forEach((t) => pc.addTrack(t, voice.stream));
  pc.onicecandidate = (e) => { if (e.candidate) vsig(peerId, { type: 'candidate', candidate: e.candidate }); };
  pc.ontrack = (e) => { audio.srcObject = e.streams[0]; audio.muted = !voice.spkOn; const p = audio.play(); if (p) p.catch(() => {}); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) closePeer(peerId); };
  if (initiator) {
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => vsig(peerId, { type: 'offer', sdp: pc.localDescription }))
      .catch(() => {});
  }
  return entry;
}
function closePeer(id) {
  const e = voice.peers[id]; if (!e) return;
  try { e.pc.close(); } catch (_) {}
  if (e.audio) { e.audio.srcObject = null; e.audio.remove(); }
  delete voice.peers[id];
}
function flushCand(e) { e.pending.forEach((c) => e.pc.addIceCandidate(c).catch(() => {})); e.pending = []; }

socket.on('voicePeers', ({ peers }) => { if (voice.joined) peers.forEach((id) => makePeer(id, socket.id > id)); });
socket.on('voicePeerJoined', ({ id }) => { if (voice.joined) makePeer(id, socket.id > id); });
socket.on('voicePeerLeft', ({ id }) => closePeer(id));
socket.on('voiceSignal', async ({ from, data }) => {
  if (!voice.joined) return;
  const e = voice.peers[from] || makePeer(from, false);
  const pc = e.pc;
  try {
    if (data.type === 'offer') {
      await pc.setRemoteDescription(data.sdp); flushCand(e);
      const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
      vsig(from, { type: 'answer', sdp: pc.localDescription });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(data.sdp); flushCand(e);
    } else if (data.type === 'candidate') {
      if (pc.remoteDescription && pc.remoteDescription.type) await pc.addIceCandidate(data.candidate).catch(() => {});
      else e.pending.push(data.candidate);
    }
  } catch (err) {}
});

function toggleMic() { if (!voice.joined) return; voice.micOn = !voice.micOn; applyMic(); updateVoiceUI(); }
function toggleSpk() {
  if (!voice.joined) return;
  voice.spkOn = !voice.spkOn;
  Object.values(voice.peers).forEach((e) => { if (e.audio) e.audio.muted = !voice.spkOn; });
  updateVoiceUI();
}
function updateVoiceUI() {
  const inRoom = !!state;
  const jb = $('voiceJoinBtn'), mb = $('voiceMicBtn'), sb = $('voiceSpkBtn');
  jb.style.display = inRoom ? '' : 'none';
  jb.textContent = voice.joined ? '📴' : '🎙️';
  jb.title = voice.joined ? 'Leave voice' : 'Join voice';
  jb.classList.toggle('on', voice.joined);
  const show = inRoom && voice.joined;
  mb.style.display = show ? '' : 'none';
  sb.style.display = show ? '' : 'none';
  mb.textContent = voice.micOn ? '🎤' : '🔇';
  mb.classList.toggle('off', !voice.micOn);
  mb.title = voice.micOn ? 'Mute my mic' : 'Unmute my mic';
  sb.textContent = voice.spkOn ? '🎧' : '🔈';
  sb.classList.toggle('off', !voice.spkOn);
  sb.title = voice.spkOn ? 'Mute others' : 'Unmute others';
}
$('voiceJoinBtn').onclick = joinVoice;
$('voiceMicBtn').onclick = toggleMic;
$('voiceSpkBtn').onclick = toggleSpk;

// ============================ EXIT GUARD ============================
// Prevent accidentally leaving an active game (back button / refresh / close).
let leavingGame = false;
let backTrapArmed = false;
function inActiveGame() {
  return !!(state && ['playing', 'roundEnd', 'matchEnd'].includes(state.phase));
}
function armBackTrap() {
  if (backTrapArmed) return;
  backTrapArmed = true;
  try { history.pushState({ cp: 1 }, ''); } catch (e) {}
}
// browser refresh / tab close / navigate away -> native "leave site?" prompt
window.addEventListener('beforeunload', (e) => {
  if (inActiveGame() && !leavingGame) { e.preventDefault(); e.returnValue = ''; }
});
// back button -> custom confirm popup (re-trap so we don't actually leave yet)
window.addEventListener('popstate', () => {
  if (inActiveGame() && !leavingGame) {
    try { history.pushState({ cp: 1 }, ''); } catch (e) {}
    $('exitOverlay').classList.remove('hidden');
  }
});
$('exitStayBtn').onclick = () => $('exitOverlay').classList.add('hidden');
$('exitLeaveBtn').onclick = () => {
  leavingGame = true;
  $('exitOverlay').classList.add('hidden');
  location.href = location.origin + location.pathname; // back to the home screen
};

// ============================ HOME ============================
$('createBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  if (!name) return ($('homeError').textContent = 'Enter a name first.');
  ac();
  socket.emit('createRoom', { name, playerId }, (res) => {
    if (res && res.ok) roomCode = res.code;
    else $('homeError').textContent = (res && res.error) || 'Could not create room.';
  });
};
$('joinBtn').onclick = () => {
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return ($('homeError').textContent = 'Enter a name first.');
  if (!code) return ($('homeError').textContent = 'Enter a room code.');
  ac();
  socket.emit('joinRoom', { code, name, playerId }, (res) => {
    if (res && res.ok) roomCode = res.code;
    else $('homeError').textContent = (res && res.error) || 'Could not join.';
  });
};
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('codeInput').value = urlRoom.toUpperCase();

// ============================ LOBBY ============================
$('startBtn').onclick = () => socket.emit('startGame');
$('addBotBtn').onclick = () => socket.emit('addBot');
$('removeBotBtn').onclick = () => socket.emit('removeBot');
document.querySelectorAll('.tbtn').forEach((b) => {
  b.onclick = () => {
    // instant visual feedback; the server confirms via the next state update
    document.querySelectorAll('.tbtn').forEach((x) => x.classList.toggle('active', x === b));
    socket.emit('setTurnTime', { seconds: Number(b.dataset.s) });
  };
});

// live turn countdown (reads the server-provided deadline)
setInterval(updateTurnTimer, 200);
function updateTurnTimer() {
  const el = $('turnTimer');
  if (!el) return;
  // no timer set, or not in a game -> hide
  if (!state || state.phase !== 'playing' || !state.turnSeconds) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  if (state.turnDeadline) {
    // active turn has a live deadline -> count down
    const remain = Math.max(0, (state.turnDeadline - Date.now()) / 1000);
    el.textContent = '⏱ ' + Math.ceil(remain) + 's';
    el.classList.toggle('low', remain <= 5);
  } else {
    // e.g. during a bot's turn -> just show the configured limit
    el.textContent = '⏱ ' + state.turnSeconds + 's';
    el.classList.remove('low');
  }
}
$('shareBtn').onclick = () => {
  const link = `${location.origin}/?room=${roomCode}`;
  navigator.clipboard?.writeText(link).then(
    () => ($('shareBtn').textContent = 'Link copied!'),
    () => ($('shareBtn').textContent = link)
  );
  setTimeout(() => ($('shareBtn').textContent = 'Copy invite link'), 2000);
};

// ============================ GAME ACTIONS ============================
$('playBtn').onclick = () => {
  if (selected.size === 0) return ($('gameError').textContent = 'Select cards to play.');
  socket.emit('play', { cards: Array.from(selected) });
};
$('passBtn').onclick = () => socket.emit('pass');
$('clearSelBtn').onclick = () => { selected.clear(); render(); };
$('logToggle').onclick = () => {
  const log = $('log');
  log.classList.toggle('hidden');
  $('logToggle').textContent = log.classList.contains('hidden') ? 'Show log' : 'Hide log';
};

// ============================ SOCKET ============================
socket.on('connect', () => {
  if (roomCode) socket.emit('joinRoom', { code: roomCode, name: $('nameInput').value.trim() || 'Player', playerId });
  // if we were in voice before a reconnect, re-establish it
  if (voice.joined) {
    Object.keys(voice.peers).forEach(closePeer);
    socket.emit('voiceJoin');
  }
});
socket.on('disconnect', () => { Object.keys(voice.peers).forEach(closePeer); });
socket.on('error', ({ message }) => {
  $('gameError').textContent = message;
  setTimeout(() => { if ($('gameError').textContent === message) $('gameError').textContent = ''; }, 3500);
});
socket.on('state', (s) => {
  cueSounds(prev, s);
  // a brand-new deal just started (only true once per deal, from the server)
  if (s.phase === 'playing' && (!state || state.phase !== 'playing')) dealAnim = true;
  prev = state;
  state = s;
  roomCode = s.code;
  render();
});

// ============================ SOUND CUES (diff prev vs next) ============
function cueSounds(old, s) {
  if (!s) return;
  // entering a deal
  if ((!old || old.phase !== 'playing') && s.phase === 'playing') SFX.deal();

  if (s.phase === 'playing') {
    // someone played: current play changed to a non-null new set
    const oldCards = old && old.currentPlay ? old.currentPlay.cards.join(',') : '';
    const newCards = s.currentPlay ? s.currentPlay.cards.join(',') : '';
    if (newCards && newCards !== oldCards) SFX.play();
    // a pass happened (table still has same play but a new "passed" log line)
    if (old && newCards === oldCards) {
      const newLogs = s.log.slice((old.log || []).length);
      if (newLogs.some((l) => /passed\.$/.test(l))) SFX.pass();
    }
    // it just became my turn
    const wasMyTurn = old && old.phase === 'playing' && old.turnSeat === old.yourSeat;
    const isMyTurn = s.turnSeat === s.yourSeat;
    if (isMyTurn && !wasMyTurn) SFX.turn();
    // forced on me, or someone newly down to 1 card
    const oldForced = old ? old.forcedPlayer : null;
    if (s.forcedPlayer === s.yourSeat && oldForced !== s.yourSeat) SFX.alert();
    const oldOne = old ? old.oneCardPlayer : null;
    if (s.oneCardPlayer !== null && s.oneCardPlayer !== oldOne) SFX.alert();
  }

  // round / match end
  if (s.phase === 'roundEnd' && (!old || old.phase !== 'roundEnd')) {
    const iWon = s.lastRound && s.lastRound.winnerName === s.players[s.yourSeat].name;
    iWon ? SFX.win() : SFX.lose();
  }
  if (s.phase === 'matchEnd' && (!old || old.phase !== 'matchEnd')) {
    const iWon = s.matchResult && s.matchResult.winnerName === s.players[s.yourSeat].name;
    iWon ? SFX.win() : SFX.lose();
  }
}

// ============================ RENDER ============================
function render() {
  if (!state) return;
  if (state.phase === 'lobby') { showScreen('lobby'); renderLobby(); }
  else { showScreen('game'); renderGame(); }
  renderOverlay();
  updateVoiceUI();
  if (inActiveGame()) armBackTrap();
}

function renderLobby() {
  $('lobbyCode').textContent = state.code;
  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const p = state.players[i];
    const li = document.createElement('li');
    if (p) {
      li.innerHTML =
        `<span>${escapeHtml(p.name)}${p.isYou ? ' (you)' : ''}</span>` +
        `<span>${p.isHost ? '<span class="tag host-tag">HOST</span> ' : ''}${p.isBot ? '<span class="tag bot-tag">BOT</span>' : ''}</span>`;
    } else {
      li.innerHTML = '<span class="empty">empty seat…</span>';
    }
    ul.appendChild(li);
  }
  const need = state.needMorePlayers;
  $('lobbyStatus').textContent = need > 0 ? `${need} seat${need > 1 ? 's' : ''} open — invite friends or add bots.` : 'All 4 seats filled!';
  $('addBotBtn').style.display = state.canAddBot ? '' : 'none';
  $('removeBotBtn').style.display = state.canRemoveBot ? '' : 'none';
  document.querySelectorAll('.tbtn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.s) === (state.turnSeconds || 0));
    b.disabled = !state.youAreHost;
  });
  const startBtn = $('startBtn');
  startBtn.disabled = !state.canStart;
  startBtn.textContent = state.youAreHost ? 'Start game' : 'Waiting for host to start…';
}

function seatName(seat) {
  const p = state.players[seat];
  return p ? p.name : '?';
}

function renderSeat(elId, seat, wide) {
  const el = $(elId);
  const p = state.players[seat];
  if (!p) { el.innerHTML = ''; return; }
  const active = state.turnSeat === seat && state.phase === 'playing';
  const mini = '<div class="mini-card"></div>'.repeat(Math.min(p.cardCount, 13));
  el.innerHTML =
    `<div class="opp${active ? ' active-turn' : ''}${p.connected ? '' : ' disconnected'}" data-seat="${seat}">` +
    (p.isBot ? '<span class="bot-badge">BOT</span>' : '') +
    (state.oneCardPlayer === seat ? '<span class="one-card-flag">1 CARD</span>' : '') +
    `<div class="opp-name">${escapeHtml(p.name)}${!p.isBot && !p.connected ? ' (off)' : ''}</div>` +
    `<div class="mini-cards">${mini}</div>` +
    `<div class="opp-cards">${p.cardCount} cards</div>` +
    `<div class="opp-score">${p.score} pts</div>` +
    `</div>`;
}

// ---- the player's 3-row hand arrangement, kept in sync with the real hand ----
function flatHand() {
  return handRows.flat();
}
function reconcileHandRows(fresh) {
  const inHand = state.yourHand || [];
  if (fresh || flatHand().length === 0) { handRows = [inHand.slice(), [], []]; return; }
  const set = new Set(inHand);
  handRows = handRows.map((row) => row.filter((c) => set.has(c)));
  while (handRows.length < 3) handRows.push([]);
  const present = new Set(flatHand());
  for (const c of inHand) if (!present.has(c)) handRows[0].push(c);
}
function renderHandRows(freshDeal, yourTurn) {
  document.querySelectorAll('.hand-row').forEach((rowEl) => {
    const ri = Number(rowEl.dataset.row);
    rowEl.innerHTML = '';
    (handRows[ri] || []).forEach((code) => {
      const el = cardEl(code, { deal: freshDeal });
      el.dataset.code = code;
      if (selected.has(code)) el.classList.add('selected');
      if (state.mustIncludeThreeDiamonds && yourTurn && code === '3D') el.classList.add('threeD-hint');
      el.addEventListener('pointerdown', (e) => onCardPointerDown(e, code));
      rowEl.appendChild(el);
    });
  });
}

// ============================ DRAG: reorder + play ============================
function onCardPointerDown(e, code) {
  if (e.button !== undefined && e.button !== 0) return; // primary button / touch only
  e.preventDefault();
  drag = {
    code, startX: e.clientX, startY: e.clientY, moved: false, ghost: null,
    el: e.currentTarget, multi: selected.has(code) && selected.size > 1,
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

function onPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) > 8) {
    drag.moved = true;
    drag.ghost = drag.el.cloneNode(true);
    drag.ghost.classList.add('drag-ghost');
    drag.ghost.classList.remove('selected');
    if (drag.multi) {
      const b = document.createElement('div');
      b.className = 'drag-count';
      b.textContent = '×' + selected.size;
      drag.ghost.appendChild(b);
    }
    document.body.appendChild(drag.ghost);
    drag.el.classList.add('dragging-src');
    $('hand').classList.add('dragging'); // expand empty rows into easy drop targets
  }
  if (drag.moved) {
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
    const over = overPlayZone(e);
    $('centerTable').classList.toggle('play-hover', over);
    clearDropMarkers();
    if (!over) markDrop(e);
  }
}

function onPointerUp(e) {
  cleanupDragListeners();
  if (!drag) return;
  const d = drag; drag = null;
  if (d.ghost) d.ghost.remove();
  if (d.el) d.el.classList.remove('dragging-src');
  $('centerTable').classList.remove('play-hover');
  $('hand').classList.remove('dragging');
  clearDropMarkers();

  if (!d.moved) { // a tap
    const now = Date.now();
    const isDouble = lastTapCode === d.code && now - lastTapTime < 350;
    lastTapCode = d.code; lastTapTime = now;
    if (isDouble) { // double-tap a card -> play it (or the whole selection it's part of)
      lastTapCode = null;
      const myTurn = state.phase === 'playing' && state.turnSeat === state.yourSeat;
      if (!myTurn) { flashError("It's not your turn yet."); render(); return; }
      const codes = (selected.has(d.code) && selected.size > 1)
        ? flatHand().filter((c) => selected.has(c))
        : [d.code];
      socket.emit('play', { cards: codes });
      selected.clear();
      return;
    }
    // single tap -> toggle selection
    if (selected.has(d.code)) selected.delete(d.code);
    else selected.add(d.code);
    render();
    return;
  }

  if (overPlayZone(e)) { // dropped on the felt -> play
    const myTurn = state.phase === 'playing' && state.turnSeat === state.yourSeat;
    if (!myTurn) { flashError("It's not your turn yet."); render(); return; }
    // play the whole selection if this card is part of a multi-select, else just this card
    const codes = (selected.has(d.code) && selected.size > 1)
      ? flatHand().filter((c) => selected.has(c))
      : [d.code];
    socket.emit('play', { cards: codes });
    selected.clear();
    return; // next state update re-renders
  }

  // dropped into a row -> move ONLY the card you grabbed to that row/position
  const t = computeRowDrop(e);
  moveCards([d.code], t.row, t.idx);
  render();
}

function onPointerCancel() {
  cleanupDragListeners();
  if (drag) {
    if (drag.ghost) drag.ghost.remove();
    if (drag.el) drag.el.classList.remove('dragging-src');
  }
  drag = null;
  $('centerTable').classList.remove('play-hover');
  $('hand').classList.remove('dragging');
  clearDropMarkers();
}
function cleanupDragListeners() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
}
function overPlayZone(e) {
  const r = $('centerTable').getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}
// which row + position is the pointer over?
function computeRowDrop(e) {
  const rows = Array.from(document.querySelectorAll('.hand-row'));
  let targetRow = rows.find((rowEl) => {
    const r = rowEl.getBoundingClientRect();
    return e.clientY >= r.top && e.clientY <= r.bottom;
  });
  if (!targetRow) { // outside any row vertically -> pick the nearest by center Y
    let best = null, bd = Infinity;
    rows.forEach((rowEl) => {
      const r = rowEl.getBoundingClientRect();
      const d = Math.abs(e.clientY - (r.top + r.bottom) / 2);
      if (d < bd) { bd = d; best = rowEl; }
    });
    targetRow = best;
  }
  const row = Number(targetRow.dataset.row);
  const cards = Array.from(targetRow.querySelectorAll('.card'));
  let idx = cards.length;
  for (let i = 0; i < cards.length; i++) {
    const r = cards[i].getBoundingClientRect();
    if (e.clientX < r.left + r.width / 2) { idx = i; break; }
  }
  return { row, idx };
}
function markDrop(e) {
  const t = computeRowDrop(e);
  const rowEl = document.querySelector(`.hand-row[data-row="${t.row}"]`);
  if (!rowEl) return;
  rowEl.classList.add('row-target');
  const cards = rowEl.querySelectorAll('.card');
  if (cards[t.idx]) cards[t.idx].classList.add('drop-before');
}
function clearDropMarkers() {
  document.querySelectorAll('#hand .drop-before').forEach((c) => c.classList.remove('drop-before'));
  document.querySelectorAll('.hand-row.row-target').forEach((r) => r.classList.remove('row-target'));
}
// move one or more cards (preserving their order) into a target row at idx
function moveCards(codes, row, idx) {
  const set = new Set(codes);
  let removedBefore = 0;
  for (let r = 0; r < handRows.length; r++) {
    const kept = [];
    handRows[r].forEach((c, i) => {
      if (set.has(c)) { if (r === row && i < idx) removedBefore++; }
      else kept.push(c);
    });
    handRows[r] = kept;
  }
  let at = Math.max(0, Math.min(idx - removedBefore, handRows[row].length));
  handRows[row].splice(at, 0, ...codes);
}
function flashError(msg) {
  $('gameError').textContent = msg;
  setTimeout(() => { if ($('gameError').textContent === msg) $('gameError').textContent = ''; }, 2500);
}

function renderGame() {
  $('gameCode').textContent = state.code;
  const me = state.players[state.yourSeat];
  const yourTurn = state.turnSeat === state.yourSeat;

  $('turnBanner').textContent =
    state.phase === 'playing' ? (yourTurn ? 'Your turn' : `${seatName(state.turnSeat)}'s turn`) : '';

  const alert = $('oneCardAlert');
  if (state.forcedPlayer === state.yourSeat) {
    alert.textContent = '⚠ 1-card rule: you must play your HIGHEST single card.';
    alert.classList.remove('hidden');
  } else if (state.oneCardPlayer === state.yourSeat) {
    alert.textContent = '⚠ You have 1 card left — go out!';
    alert.classList.remove('hidden');
  } else if (state.oneCardPlayer !== null) {
    alert.textContent = `⚠ ${seatName(state.oneCardPlayer)} has 1 card left!`;
    alert.classList.remove('hidden');
  } else {
    alert.classList.add('hidden');
  }

  // opponents seated around the table: next player on the left, then top, then right
  const n = state.players.length;
  renderSeat('seatLeft', (state.yourSeat + 1) % n, false);
  renderSeat('seatTop', (state.yourSeat + 2) % n, true);
  renderSeat('seatRight', (state.yourSeat + 3) % n, false);

  // current play
  const cp = $('currentPlay');
  cp.innerHTML = '';
  if (state.currentPlay) {
    $('currentPlayLabel').textContent = `${state.currentPlay.name} played ${state.currentPlay.label}`;
    state.currentPlay.cards.forEach((code) => cp.appendChild(cardEl(code)));
  } else {
    $('currentPlayLabel').textContent = state.phase === 'playing' ? 'Table is open — lead any combination' : '';
    cp.innerHTML = '<span class="empty-hint">no cards in play</span>';
  }

  // your meta + hand
  $('youName').textContent = me.name + ' (you)';
  $('youScore').textContent = `${me.score} pts · ${me.cardCount} cards`;
  for (const code of Array.from(selected)) if (!state.yourHand.includes(code)) selected.delete(code);
  const freshDeal = dealAnim; // consumed once per new deal (set by the state handler)
  dealAnim = false;
  reconcileHandRows(freshDeal);
  renderHandRows(freshDeal, yourTurn);

  const canAct = state.phase === 'playing' && yourTurn;
  $('playBtn').disabled = !canAct;
  $('passBtn').disabled = !canAct || !state.currentPlay;
  $('clearSelBtn').disabled = selected.size === 0;

  $('log').innerHTML = state.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
}

function renderOverlay() {
  const ov = $('overlay');
  if (state.phase === 'roundEnd' && state.lastRound) {
    ov.classList.remove('hidden');
    $('overlayTitle').textContent = `${state.lastRound.winnerName} wins the round!`;
    $('overlayBody').innerHTML = scoreTable(state.lastRound.results);
    const btn = $('overlayBtn');
    btn.style.display = '';
    if (state.youAreHost) {
      btn.disabled = false;
      btn.textContent = 'Deal next round';
      btn.onclick = () => { ov.classList.add('hidden'); socket.emit('nextRound'); };
    } else {
      btn.disabled = true;
      btn.textContent = 'Waiting for host…';
      btn.onclick = null;
    }
  } else if (state.phase === 'matchEnd' && state.matchResult) {
    ov.classList.remove('hidden');
    $('overlayTitle').textContent = `🏆 ${state.matchResult.winnerName} wins the match!`;
    $('overlayBody').innerHTML = finalTable(state.matchResult.ranked, state.players);
    const btn = $('overlayBtn');
    btn.style.display = '';
    btn.disabled = !state.youAreHost;
    btn.textContent = state.youAreHost ? 'Play again' : 'Waiting for host…';
    btn.onclick = state.youAreHost ? () => { ov.classList.add('hidden'); socket.emit('playAgain'); } : null;
  } else {
    ov.classList.add('hidden');
  }
}

function scoreTable(results) {
  const rows = results
    .map((r) => `<tr><td>${escapeHtml(r.name)}</td><td class="num">${r.cardsLeft} cards</td><td class="num">+${r.penalty}</td><td class="num">${r.score}</td></tr>`)
    .join('');
  return `<table class="score-table"><tr><th>Player</th><th class="num">Left</th><th class="num">Round</th><th class="num">Total</th></tr>${rows}</table>`;
}
function finalTable(ranked, players) {
  const rows = ranked
    .map((r, i) => {
      const p = players && players[r.seat];
      const wins = p && p.lifetime ? p.lifetime.matchesWon : null;
      const winCell = wins === null ? '<td class="num">—</td>' : `<td class="num">${wins}</td>`;
      return `<tr class="${i === 0 ? 'rank-1' : ''}"><td>${i + 1}. ${escapeHtml(r.name)}</td><td class="num">${r.score} pts</td>${winCell}</tr>`;
    })
    .join('');
  return `<table class="score-table"><tr><th>Rank</th><th class="num">Final score</th><th class="num">Lifetime wins</th></tr>${rows}</table>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
