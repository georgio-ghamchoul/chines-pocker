// ============================================================================
// Chinese Poker - Bot AI (solid heuristic)
// Pure logic. decide() returns the card objects to play, or null to pass.
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
// decide({ hand, current, forced, mustThreeD, opponents })
//   hand        : array of card objects
//   current     : the identified combo to beat, or null if leading
//   forced      : true if the 1-card rule forces this bot to play highest single
//   mustThreeD  : true if this play must include 3 of diamonds
//   opponents   : array of { cardCount } for the other players
// returns array of card objects to play, or null to pass.
// ----------------------------------------------------------------------------
function decide({ hand, current, forced, mustThreeD, opponents }) {
  const h = sortHand(hand);
  const id = (cards) => E.identifyCombo(cards);

  // 1-card rule: must play highest single.
  if (forced) return [h[h.length - 1]];

  const oppMin = opponents.length ? Math.min(...opponents.map((o) => o.cardCount)) : 13;
  const pressure = oppMin <= 2; // an opponent is close to going out

  // ---- leading a fresh trick ----
  if (!current) {
    if (mustThreeD) {
      // Lead 3D. If 3D forms a low pair, dump the pair to shed more cards.
      const td = h.find(E.isThreeOfDiamonds);
      const sameRank = h.filter((c) => c.r === td.r);
      if (sameRank.length >= 2) return [sameRank[0], sameRank[1]];
      return [td];
    }
    // If the whole remaining hand is one legal combo, play it to win.
    if (h.length <= 5 && id(h)) return h;

    // Prefer to lead a low pair (sheds 2 low cards) when the rank is small.
    const lowest = h[0];
    const sameRank = h.filter((c) => c.r === lowest.r);
    if (sameRank.length >= 2 && lowest.r <= 4) {
      return [sameRank[0], sameRank[1]];
    }
    return [lowest]; // otherwise lead the lowest single, keep control
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

  const minimal = beaters[0];

  // Under pressure (someone about to go out), always block if we can.
  if (pressure) return minimal.cards;

  // Otherwise conserve strength:
  // - don't spend an Ace/2 on a single early when we still hold many cards
  if (current.category === E.CAT.SINGLE) {
    const rank = minimal.cards[0].r; // A=11, 2=12
    if (rank >= 11 && h.length > 4) return null;
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
