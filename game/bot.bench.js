// Head-to-head benchmark: NEW bot (bot.js) vs the OLD heuristic bot, over many
// single deals with alternating seats. Run:  node game/bot.bench.js [deals]
const E = require('./engine');
const NEW = require('./bot');

// ---------------------------------------------------------------------------
// Inline snapshot of the ORIGINAL bot (pre-upgrade), for comparison.
// ---------------------------------------------------------------------------
const OLD = (() => {
  function sortHand(hand) { return hand.slice().sort(E.compareCards); }
  function singles(hand) { return hand.map((c) => [c]); }
  function groupByRank(hand) {
    const byRank = {};
    hand.forEach((c) => (byRank[c.r] = byRank[c.r] || []).push(c));
    return byRank;
  }
  function pairs(hand) {
    const res = [];
    Object.values(groupByRank(hand)).forEach((cs) => {
      if (cs.length >= 2) {
        const s = cs.slice().sort(E.compareCards);
        res.push([s[0], s[1]]);
        res.push([s[s.length - 2], s[s.length - 1]]);
      }
    });
    return res;
  }
  function tripsList(hand) {
    const res = [];
    Object.values(groupByRank(hand)).forEach((cs) => {
      if (cs.length >= 3) {
        const s = cs.slice().sort(E.compareCards);
        res.push([s[0], s[1], s[2]]);
      }
    });
    return res;
  }
  function fives(hand) {
    const res = [];
    const n = hand.length;
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++)
        for (let c = b + 1; c < n; c++)
          for (let d = c + 1; d < n; d++)
            for (let e = d + 1; e < n; e++) {
              const combo = [hand[a], hand[b], hand[c], hand[d], hand[e]];
              if (E.identifyCombo(combo)) res.push(combo);
            }
    return res;
  }
  function byStrength(a, b) {
    if (a.category === E.CAT.FIVE && a.typeStrength !== b.typeStrength) {
      return a.typeStrength - b.typeStrength;
    }
    return a.key - b.key;
  }
  function decide({ hand, current, forced, mustThreeD, opponents }) {
    const h = sortHand(hand);
    const id = (cards) => E.identifyCombo(cards);
    if (forced) return [h[h.length - 1]];
    const oppMin = opponents.length ? Math.min(...opponents.map((o) => o.cardCount)) : 13;
    const pressure = oppMin <= 2;
    if (!current) {
      if (mustThreeD) {
        const td = h.find(E.isThreeOfDiamonds);
        const sameRank = h.filter((c) => c.r === td.r);
        if (sameRank.length >= 2) return [sameRank[0], sameRank[1]];
        return [td];
      }
      if (h.length <= 5 && id(h)) return h;
      const lowest = h[0];
      const sameRank = h.filter((c) => c.r === lowest.r);
      if (sameRank.length >= 2 && lowest.r <= 4) return [sameRank[0], sameRank[1]];
      return [lowest];
    }
    let cands = [];
    if (current.category === E.CAT.SINGLE) cands = singles(h);
    else if (current.category === E.CAT.PAIR) cands = pairs(h);
    else if (current.category === E.CAT.TRIPS) cands = tripsList(h);
    else if (current.category === E.CAT.FIVE) cands = fives(h);
    const beaters = cands.map(id).filter((cb) => cb && E.beats(cb, current)).sort(byStrength);
    if (beaters.length === 0) return null;
    const winMove = beaters.find((cb) => cb.cards.length === h.length);
    if (winMove) return winMove.cards;
    const minimal = beaters[0];
    if (pressure) return minimal.cards;
    if (current.category === E.CAT.SINGLE) {
      const rank = minimal.cards[0].r;
      if (rank >= 11 && h.length > 4) return null;
    }
    if (
      current.category === E.CAT.FIVE &&
      current.typeStrength <= E.FIVE_TYPE.FLUSH &&
      minimal.typeStrength >= E.FIVE_TYPE.FOUR &&
      h.length > 5
    ) {
      return null;
    }
    return minimal.cards;
  }
  return { decide };
})();

// ---------------------------------------------------------------------------
// Minimal game loop mirroring the server's rules (forced 1-card rule,
// mustThreeD opener, trick awards on 3 passes).
// ---------------------------------------------------------------------------
function forcedCanPlay(hand, current) {
  if (!hand.length) return false;
  if (!current) return true;
  if (current.category !== E.CAT.SINGLE) return false;
  const highest = hand.slice().sort(E.compareCards).pop();
  return E.beats(E.identifyCombo([highest]), current);
}

function playDeal(bots) {
  const hands = E.deal(4);
  let starter = 0;
  hands.forEach((h, i) => { if (h.some(E.isThreeOfDiamonds)) starter = i; });
  const g = {
    turn: starter, currentPlay: null, lastPlayer: null, passes: 0,
    mustThreeD: true, oneCardPlayer: null, forcedPlayer: null, forcedHandled: false,
    played: [],
  };
  for (let guard = 0; guard < 5000; guard++) {
    const seat = g.turn;
    const hand = hands[seat];
    const isForced = g.forcedPlayer === seat && !g.forcedHandled &&
      forcedCanPlay(hand, g.currentPlay ? g.currentPlay.combo : null);
    const opponents = [];
    for (let i = 1; i < 4; i++) opponents.push({ cardCount: hands[(seat + i) % 4].length });
    const move = bots[seat].decide({
      hand, current: g.currentPlay ? g.currentPlay.combo : null,
      forced: isForced, mustThreeD: g.mustThreeD, opponents, played: g.played,
    });

    // validate like the server; fall back to pass / lowest single
    let combo = move ? E.identifyCombo(move) : null;
    let legal = false;
    if (combo) {
      const ids = new Set(hand.map(E.cardId));
      const holds = combo.cards.every((c) => ids.has(E.cardId(c)));
      if (holds) {
        if (isForced) {
          const highest = hand.slice().sort(E.compareCards).pop();
          legal = combo.category === E.CAT.SINGLE && E.cardId(combo.cards[0]) === E.cardId(highest);
        } else if (g.mustThreeD && !combo.cards.some(E.isThreeOfDiamonds)) legal = false;
        else if (g.currentPlay) legal = combo.category === g.currentPlay.combo.category && E.beats(combo, g.currentPlay.combo);
        else legal = true;
      }
    }
    if (!legal) {
      if (g.currentPlay) { // pass
        if (g.forcedPlayer === seat && !g.forcedHandled) { g.forcedHandled = true; g.forcedPlayer = null; }
        g.passes++;
        if (g.passes >= 3) { g.turn = g.lastPlayer; g.currentPlay = null; g.lastPlayer = null; g.passes = 0; continue; }
        g.turn = (seat + 1) % 4; continue;
      }
      const lowest = hand.slice().sort(E.compareCards)[0];
      combo = E.identifyCombo(g.mustThreeD ? [hand.find(E.isThreeOfDiamonds)] : [lowest]);
    }
    // apply the play
    const ids = new Set(combo.cards.map(E.cardId));
    hands[seat] = hand.filter((c) => !ids.has(E.cardId(c)));
    g.played.push(...combo.cards);
    g.currentPlay = { seat, combo };
    g.lastPlayer = seat; g.passes = 0; g.mustThreeD = false;
    if (isForced) { g.forcedHandled = true; g.forcedPlayer = null; }
    if (hands[seat].length === 0) {
      return { winnerSeat: seat, penalties: hands.map((h2, i2) => (i2 === seat ? 0 : E.penaltyFor(h2.length))) };
    }
    if (hands[seat].length === 1 && g.oneCardPlayer !== seat) {
      g.oneCardPlayer = seat;
      g.forcedPlayer = (seat - 1 + 4) % 4;
      g.forcedHandled = false;
    }
    g.turn = (seat + 1) % 4;
  }
  throw new Error('deal did not finish (guard hit)');
}

const DEALS = Number(process.argv[2] || 1000);
// alternate seatings so neither bot has a position advantage
const seatings = [
  ['NEW', 'OLD', 'NEW', 'OLD'],
  ['OLD', 'NEW', 'OLD', 'NEW'],
];
const tally = { NEW: { wins: 0, points: 0, seats: 0 }, OLD: { wins: 0, points: 0, seats: 0 } };
for (let d = 0; d < DEALS; d++) {
  const labels = seatings[d % 2];
  const bots = labels.map((l) => (l === 'NEW' ? NEW : OLD));
  const { winnerSeat, penalties } = playDeal(bots);
  labels.forEach((l, i) => {
    tally[l].seats++;
    tally[l].points += penalties[i];
    if (i === winnerSeat) tally[l].wins++;
  });
}
for (const k of ['NEW', 'OLD']) {
  const t = tally[k];
  console.log(`${k}: won ${t.wins}/${DEALS} deals (${((t.wins / DEALS) * 100).toFixed(1)}%), avg penalty/seat ${(t.points / t.seats).toFixed(2)}`);
}
const ok = tally.NEW.wins > tally.OLD.wins;
console.log(ok ? '\nNEW BOT IS STRONGER ✅' : '\nNEW BOT IS NOT STRONGER ❌');
process.exit(ok ? 0 : 1);
