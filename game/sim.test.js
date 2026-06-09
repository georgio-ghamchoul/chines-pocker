// Integration sim: boots the real server, connects 4 bots, plays full deals.
// Bots play the lowest legal move (singles only) or pass. Verifies the full
// turn/pass/trick/round/match loop runs without errors and scoring works.
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const E = require('./engine');

const PORT = 4099;
const URL = `http://localhost:${PORT}`;

function startServer() {
  return new Promise((resolve) => {
    const proc = spawn('node', [__dirname + '/../server.js'], {
      env: { ...process.env, PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('running')) resolve(proc);
    });
    proc.stderr.on('data', (d) => console.error('SERVER ERR:', d.toString()));
  });
}

// Bot decision: given my hand (codes) and current play, return cards to play or null (pass).
function decide(handCodes, currentPlay, mustThreeD, forced) {
  const cards = handCodes.map(E.parseCode);
  const byId = cards.slice().sort(E.compareCards);

  if (forced) {
    // play highest single
    return [E.cardCode(byId[byId.length - 1])];
  }

  if (!currentPlay) {
    // leading: play lowest single (include 3D if required)
    if (mustThreeD) {
      const td = handCodes.find((c) => c === '3D');
      return [td];
    }
    return [E.cardCode(byId[0])];
  }

  // must beat. Only handle singles here; pass otherwise.
  if (currentPlay.cards.length !== 1) return null;
  const target = E.identifyCombo(currentPlay.cards.map(E.parseCode));
  // find lowest single that beats
  for (const c of byId) {
    const mine = E.identifyCombo([c]);
    if (E.beats(mine, target)) return [E.cardCode(c)];
  }
  return null; // pass
}

async function run() {
  const server = await startServer();
  let failed = false;
  const fail = (m) => { failed = true; console.error('FAIL:', m); };

  const sockets = [];
  const states = [null, null, null, null];
  let roomCode = null;

  function mkBot(idx) {
    return new Promise((resolve) => {
      const s = io(URL, { forceNew: true });
      sockets[idx] = s;
      s.on('connect', () => resolve(s));
      s.on('error', (e) => console.error(`bot${idx} server error:`, e.message));
      s.on('state', (st) => {
        states[idx] = st;
        maybeAct(idx, st);
      });
    });
  }

  let actingLock = false;
  function maybeAct(idx, st) {
    if (st.phase !== 'playing') return;
    if (st.turnSeat !== st.yourSeat) return;
    if (actingLock) return;
    actingLock = true;
    setTimeout(() => {
      actingLock = false;
      const cur = states[idx];
      if (!cur || cur.phase !== 'playing' || cur.turnSeat !== cur.yourSeat) return;
      const forced = cur.forcedPlayer === cur.yourSeat;
      const move = decide(cur.yourHand, cur.currentPlay, cur.mustIncludeThreeDiamonds, forced);
      if (move) sockets[idx].emit('play', { cards: move });
      else sockets[idx].emit('pass');
    }, 5);
  }

  // host creates
  await mkBot(0);
  await new Promise((res) =>
    sockets[0].emit('createRoom', { name: 'Alice', playerId: 'A' }, (r) => {
      roomCode = r.code;
      res();
    })
  );
  for (let i = 1; i < 4; i++) {
    await mkBot(i);
    await new Promise((res) =>
      sockets[i].emit('joinRoom', { code: roomCode, name: 'P' + i, playerId: 'P' + i }, () => res())
    );
  }

  // Drive: start game, and on each roundEnd start the next, until matchEnd.
  let matchEnded = false;
  let rounds = 0;
  const watcher = sockets[0];
  watcher.on('state', (st) => {
    if (st.phase === 'roundEnd' && st.youAreHost) {
      rounds++;
      // validate scoring: exactly one winner with 0 added this round
      const winners = st.lastRound.results.filter((r) => r.penalty === 0 && r.cardsLeft === 0);
      if (winners.length !== 1) fail('expected exactly one round winner, got ' + winners.length);
      setTimeout(() => watcher.emit('nextRound'), 10);
    }
    if (st.phase === 'matchEnd' && !matchEnded) {
      matchEnded = true;
      const mr = st.matchResult;
      if (!mr) return fail('no matchResult');
      const top = mr.ranked[0];
      const someoneHit101 = mr.ranked.some((r) => r.score >= 101);
      if (!someoneHit101) fail('match ended but nobody hit 101');
      if (top.score !== Math.min(...mr.ranked.map((r) => r.score))) fail('winner is not lowest score');
      console.log(`\nMatch ended after ${rounds} rounds. Winner: ${mr.winnerName} (${top.score} pts).`);
      console.log('Final:', mr.ranked.map((r) => `${r.name}:${r.score}`).join('  '));
      finish();
    }
  });

  sockets[0].emit('startGame');

  let done = false;
  function finish() {
    if (done) return;
    done = true;
    sockets.forEach((s) => s.close());
    server.kill();
    console.log(failed ? '\nSIM FAILED' : '\nSIM PASSED ✅');
    process.exit(failed ? 1 : 0);
  }

  // safety timeout
  setTimeout(() => { fail('timeout — game did not reach matchEnd'); finish(); }, 25000);
}

run();
