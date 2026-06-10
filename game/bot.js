// ============================================================================
// Chinese Poker - Bot AI v2 (card memory + hand planning + blocking)
// Pure logic. decide() returns the card objects to play, or null to pass.
//
// What makes it smart:
//   - Card memory: tracks which cards have been played (`played`) and knows
//     when one of its cards/combos is a "boss" nothing left can beat.
//   - Hand planning: partitions its hand into combos (fives, trips, pairs,
//     singles) and avoids breaking good combos to answer cheap plays.
//   - Blocking: when the NEXT player is low on cards it leads multi-card
//     combos (a 1-card player can never follow a pair) or high singles.
//   - Endgame: with 2 playable units left, leads the boss first to guarantee
//     control, then dumps the rest.
// ============================================================================
const E = require('./engine');

function sortHand(hand) {
  return hand.slice().sort(E.compareCards);
}

// ---- candidate generators (by category) ----
function singles(hand) {
  return hand.map((c) => [c]);
}

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
      res.push([s[0], s[1]]); // lowest pair of this rank
      res.push([s[s.length - 2], s[s.length - 1]]); // highest pair of this rank
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

// ascending strength order for a list of identified combos
function byStrength(a, b) {
  if (a.category === E.CAT.FIVE && a.typeStrength !== b.typeStrength) {
    return a.typeStrength - b.typeStrength;
  }
  return a.key - b.key;
}

// ----------------------------------------------------------------------------
// Card memory: which cards are still unseen (not in my hand, not yet played)?
// ----------------------------------------------------------------------------
function unseenCards(hand, played) {
  const seen = new Set();
  hand.forEach((c) => seen.add(E.cardId(c)));
  (played || []).forEach((c) => seen.add(E.cardId(c)));
  const out = [];
  for (const c of E.makeDeck()) if (!seen.has(E.cardId(c))) out.push(c);
  return out;
}

// Is this identified combo unbeatable by anything still unseen?
function isBoss(combo, unseen) {
  if (combo.category === E.CAT.SINGLE) {
    const myId = E.cardId(combo.cards[0]);
    return !unseen.some((c) => E.cardId(c) > myId);
  }
  if (combo.category === E.CAT.PAIR) {
    // a higher pair needs 2 unseen cards of a rank whose pair-key beats ours
    const byRank = groupByRank(unseen);
    const myKey = combo.key;
    return !Object.values(byRank).some((cs) => {
      if (cs.length < 2) return false;
      const s = cs.slice().sort(E.compareCards);
      return E.cardId(s[s.length - 1]) > myKey;
    });
  }
  if (combo.category === E.CAT.TRIPS) {
    const byRank = groupByRank(unseen);
    return !Object.values(byRank).some((cs) => cs.length >= 3 && cs[0].r > combo.key);
  }
  // five-card: only treat the very top as boss (four-of-a-kind or better is
  // "near boss"; a royal flush is truly boss).
  if (combo.typeStrength >= E.FIVE_TYPE.STRAIGHT_FLUSH) return true;
  if (combo.typeStrength === E.FIVE_TYPE.FOUR) {
    const byRank = groupByRank(unseen);
    return !Object.values(byRank).some((cs) => cs.length >= 4 && cs[0].r > combo.key);
  }
  return false;
}

// ----------------------------------------------------------------------------
// Hand planning: partition the hand into playable units (greedy, low-first).
// Returns identified combos covering the whole hand.
// ----------------------------------------------------------------------------
function removeCards(hand, cards) {
  const ids = new Set(cards.map(E.cardId));
  return hand.filter((c) => !ids.has(E.cardId(c)));
}
function sumIds(cards) {
  return cards.reduce((s, c) => s + E.cardId(c), 0);
}

function planHand(hand) {
  let rest = sortHand(hand);
  const units = [];
  // 1) five-card combos: repeatedly take the one made of the LOWEST cards
  //    (sheds weak cards, keeps high cards for control)
  for (;;) {
    const fs = fives(rest).map(E.identifyCombo).filter(Boolean);
    if (!fs.length) break;
    fs.sort((a, b) => sumIds(a.cards) - sumIds(b.cards));
    units.push(fs[0]);
    rest = removeCards(rest, fs[0].cards);
  }
  // 2) trips
  for (const t of tripsList(rest)) {
    const combo = E.identifyCombo(t);
    if (combo) { units.push(combo); rest = removeCards(rest, t); }
  }
  // 3) pairs
  for (;;) {
    const ps = pairs(rest).map(E.identifyCombo).filter(Boolean).sort(byStrength);
    if (!ps.length) break;
    units.push(ps[0]);
    rest = removeCards(rest, ps[0].cards);
  }
  // 4) singles
  rest.forEach((c) => units.push(E.identifyCombo([c])));
  // weakest first (by top card)
  units.sort((a, b) => E.cardId(a.cards[a.cards.length - 1]) - E.cardId(b.cards[b.cards.length - 1]));
  return units;
}

// does playing `cards` break up a multi-card planned unit?
function breaksPlan(cards, units) {
  const ids = new Set(cards.map(E.cardId));
  return units.some((u) => {
    if (u.cards.length < 2) return false;
    const overlap = u.cards.filter((c) => ids.has(E.cardId(c))).length;
    return overlap > 0 && overlap < u.cards.length;
  });
}
// size of the largest planned unit that `cards` would break (0 if none)
function brokenUnitSize(cards, units) {
  const ids = new Set(cards.map(E.cardId));
  let size = 0;
  units.forEach((u) => {
    if (u.cards.length < 2) return;
    const overlap = u.cards.filter((c) => ids.has(E.cardId(c))).length;
    if (overlap > 0 && overlap < u.cards.length) size = Math.max(size, u.cards.length);
  });
  return size;
}

// ----------------------------------------------------------------------------
// decide({ hand, current, forced, mustThreeD, opponents, played })
//   hand        : array of card objects
//   current     : the identified combo to beat, or null if leading
//   forced      : true if the 1-card rule forces this bot to play highest single
//   mustThreeD  : true if this play must include 3 of diamonds
//   opponents   : array of { cardCount } — opponents[0] is the NEXT player to act
//   played      : (optional) card objects already played this deal, for memory
// returns array of card objects to play, or null to pass.
// ----------------------------------------------------------------------------
function decide({ hand, current, forced, mustThreeD, opponents, played }) {
  const h = sortHand(hand);
  const id = (cards) => E.identifyCombo(cards);
  const unseen = unseenCards(h, played || []);

  // 1-card rule: must play highest single.
  if (forced) return [h[h.length - 1]];

  const counts = (opponents || []).map((o) => o.cardCount);
  const oppMin = counts.length ? Math.min(...counts) : 13;
  const nextCount = counts.length ? counts[0] : 13;
  const pressure = oppMin <= 2; // an opponent is close to going out

  const units = planHand(h);

  // ---- leading a fresh trick ----
  if (!current) {
    if (mustThreeD) {
      // Lead the LARGEST planned unit that contains 3D (sheds the most cards).
      const withTd = units.filter((u) => u.cards.some(E.isThreeOfDiamonds));
      if (withTd.length) {
        withTd.sort((a, b) => b.cards.length - a.cards.length);
        return withTd[0].cards;
      }
      return [h.find(E.isThreeOfDiamonds)];
    }
    // If the whole remaining hand is one legal combo, play it to win.
    if (h.length <= 5 && id(h)) return h;

    // Endgame: 2 units left and one is a boss -> lead the boss, keep control,
    // then dump the other unit next trick. Guaranteed (or near-guaranteed) out.
    if (units.length === 2) {
      const boss = units.find((u) => isBoss(u, unseen));
      if (boss) return boss.cards;
      // no boss: lead the STRONGER unit, best chance to win a trick and dump
      return units[units.length - 1].cards;
    }

    // Blocking: the next player is nearly out.
    if (nextCount <= 2) {
      // a 1-card player can never follow a multi-card combo
      const multi = units.filter((u) => u.cards.length >= (nextCount === 1 ? 2 : 3));
      if (multi.length) return multi[0].cards;
      // otherwise deny them a cheap single: lead our highest single unit
      const singleUnits = units.filter((u) => u.cards.length === 1);
      if (singleUnits.length) return singleUnits[singleUnits.length - 1].cards;
    }

    // Normal lead: weakest unit first. Prefer multi-card units over an equally
    // weak single (sheds more cards).
    return units[0].cards;
  }

  // ---- responding: must beat `current` with the same category ----
  let cands = [];
  if (current.category === E.CAT.SINGLE) cands = singles(h);
  else if (current.category === E.CAT.PAIR) cands = pairs(h);
  else if (current.category === E.CAT.TRIPS) cands = tripsList(h);
  else if (current.category === E.CAT.FIVE) cands = fives(h);

  const beaters = cands
    .map(id)
    .filter((cb) => cb && E.beats(cb, current))
    .sort(byStrength);

  if (beaters.length === 0) return null; // nothing beats it -> pass

  // If a beating move empties our hand, take the win.
  const winMove = beaters.find((cb) => cb.cards.length === h.length);
  if (winMove) return winMove.cards;

  // Prefer the cheapest beater that does NOT break a planned multi-card unit —
  // unless dodging the break is much more expensive than splitting a mere pair
  // (don't spend a King to protect a pair of 4s).
  const nonBreaking = beaters.filter((cb) => !breaksPlan(cb.cards, units));
  let minimal = (nonBreaking.length ? nonBreaking : beaters)[0];
  if (nonBreaking.length && current.category === E.CAT.SINGLE) {
    const overall = beaters[0];
    if (overall !== minimal && minimal.key - overall.key > 8 && brokenUnitSize(overall.cards, units) <= 2) {
      minimal = overall;
    }
  }

  // Under pressure (someone about to go out), always block if we can.
  if (pressure) return minimal.cards;

  // All beaters would shatter a good combo and we still have a big hand: pass.
  if (!nonBreaking.length && h.length > 5) return null;

  // Otherwise conserve strength:
  if (current.category === E.CAT.SINGLE) {
    const card = minimal.cards[0];
    const bossSingle = isBoss(minimal, unseen);
    // A boss single will win the trick for sure — worth playing when we're
    // down to a few units and want to take the lead back.
    if (bossSingle && units.length <= 3) return minimal.cards;
    // don't spend an Ace/2 on a single early when we still hold many cards
    if (card.r >= 11 && h.length > 4) return null;
  }
  // - don't crack a bomb (four-of-a-kind / straight flush) just to beat a
  //   weak five-card play when we're not under pressure
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

module.exports = { decide };
