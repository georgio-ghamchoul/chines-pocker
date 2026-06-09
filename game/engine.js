// ============================================================================
// Chinese Poker - Game Rule Engine
// Pure logic, no I/O. Safe to require from the server or run in tests.
// ============================================================================

// Rank order weakest -> strongest:  3 4 5 6 7 8 9 10 J Q K A 2
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
// Suit order weakest -> strongest:  diamond < club < heart < spade
const SUITS = ['D', 'C', 'H', 'S'];
const SUIT_SYMBOL = { D: '♦', C: '♣', H: '♥', S: '♠' };

// A card is { r: rankIndex 0..12, s: suitIndex 0..3 }.
// Unique id 0..51 = r*4 + s. This id is also the total ordering for SINGLES.

function cardId(card) {
  return card.r * 4 + card.s;
}

function cardCode(card) {
  // Stable string id used between client and server, e.g. "10H", "AS", "3D".
  return RANKS[card.r] + SUITS[card.s];
}

function parseCode(code) {
  const s = code.slice(-1);
  const r = code.slice(0, -1);
  return { r: RANKS.indexOf(r), s: SUITS.indexOf(s) };
}

function cardLabel(card) {
  return RANKS[card.r] + SUIT_SYMBOL[card.s];
}

// Total order for single-card comparison: rank first, then suit.
function compareCards(a, b) {
  return cardId(a) - cardId(b);
}

// The 3 of diamonds: r=0 (rank '3'), s=0 (suit 'D'). id 0.
const THREE_OF_DIAMONDS = { r: 0, s: 0 };
function isThreeOfDiamonds(card) {
  return card.r === 0 && card.s === 0;
}

function makeDeck() {
  const deck = [];
  for (let r = 0; r < RANKS.length; r++) {
    for (let s = 0; s < SUITS.length; s++) {
      deck.push({ r, s });
    }
  }
  return deck;
}

function shuffle(deck, rng = Math.random) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Deal 13 cards to each of `n` players. Returns array of hands (each sorted).
function deal(n = 4, rng = Math.random) {
  const d = shuffle(makeDeck(), rng);
  const hands = Array.from({ length: n }, () => []);
  for (let i = 0; i < d.length; i++) {
    hands[i % n].push(d[i]);
  }
  hands.forEach((h) => h.sort(compareCards));
  return hands;
}

// ----------------------------------------------------------------------------
// Straight definitions
// ----------------------------------------------------------------------------
// Allowed straights (low -> high), Big-Two style. 2 is NOT used in straights,
// and the top straight is 10-J-Q-K-A (which, suited, is the Royal Flush).
// A may act as the low card in A-2-3-4-5.
//
// Each entry: the set of rankIndices -> { height, topRankIndex }.
//   height = 0 (lowest, A2345) ... 9 (highest, 10JQKA)
//   topRankIndex = the rankIndex of the highest card in the run (for suit tiebreak)
const STRAIGHTS = (() => {
  const map = {};
  const RI = {};
  RANKS.forEach((label, i) => (RI[label] = i));
  const seqs = [
    ['A', '2', '3', '4', '5'],
    ['2', '3', '4', '5', '6'],
    ['3', '4', '5', '6', '7'],
    ['4', '5', '6', '7', '8'],
    ['5', '6', '7', '8', '9'],
    ['6', '7', '8', '9', '10'],
    ['7', '8', '9', '10', 'J'],
    ['8', '9', '10', 'J', 'Q'],
    ['9', '10', 'J', 'Q', 'K'],
    ['10', 'J', 'Q', 'K', 'A'],
  ];
  // The "top" card of each run (highest in poker order, not in rank-value order)
  const tops = ['5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  seqs.forEach((seq, height) => {
    const key = seq
      .map((l) => RI[l])
      .sort((a, b) => a - b)
      .join(',');
    map[key] = { height, topRankIndex: RI[tops[height]] };
  });
  return map;
})();

function straightInfo(cards) {
  const key = cards
    .map((c) => c.r)
    .sort((a, b) => a - b)
    .join(',');
  return STRAIGHTS[key] || null;
}

// ----------------------------------------------------------------------------
// Combination identification
// ----------------------------------------------------------------------------
// Category constants. A combo can only beat another combo of the SAME category.
const CAT = { SINGLE: 'single', PAIR: 'pair', TRIPS: 'trips', FIVE: 'five' };

// Five-card type strengths (higher beats lower regardless of card values).
const FIVE_TYPE = {
  STRAIGHT: 1,
  FLUSH: 2,
  FULL_HOUSE: 3,
  FOUR: 4,
  STRAIGHT_FLUSH: 5,
  ROYAL_FLUSH: 6,
};
const FIVE_TYPE_NAME = {
  1: 'Straight',
  2: 'Flush',
  3: 'Full House',
  4: 'Four of a Kind',
  5: 'Straight Flush',
  6: 'Royal Flush',
};

function rankCounts(cards) {
  const counts = {};
  for (const c of cards) counts[c.r] = (counts[c.r] || 0) + 1;
  return counts;
}

// Identify a combination from an array of card objects.
// Returns null if the cards do not form a legal combination.
function identifyCombo(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  const sorted = cards.slice().sort(compareCards);
  const n = sorted.length;

  if (n === 1) {
    return { category: CAT.SINGLE, cards: sorted, label: 'Single', key: cardId(sorted[0]) };
  }

  if (n === 2) {
    if (sorted[0].r !== sorted[1].r) return null;
    return { category: CAT.PAIR, cards: sorted, label: 'Pair', key: cardId(sorted[1]) };
  }

  if (n === 3) {
    if (sorted[0].r !== sorted[1].r || sorted[1].r !== sorted[2].r) return null;
    return { category: CAT.TRIPS, cards: sorted, label: 'Three of a Kind', key: sorted[0].r };
  }

  if (n === 5) {
    return identifyFive(sorted);
  }

  // 4-card hands (and 6+) are not legal combinations in this game.
  return null;
}

function identifyFive(sorted) {
  const counts = rankCounts(sorted);
  const countVals = Object.values(counts).sort((a, b) => b - a); // e.g. [3,2]
  const isFlush = sorted.every((c) => c.s === sorted[0].s);
  const sInfo = straightInfo(sorted);
  const topCard = (rankIndex) => sorted.find((c) => c.r === rankIndex);

  // Four of a kind: counts [4,1]
  if (countVals[0] === 4) {
    const quadRank = Number(Object.keys(counts).find((r) => counts[r] === 4));
    return {
      category: CAT.FIVE,
      cards: sorted,
      typeStrength: FIVE_TYPE.FOUR,
      label: FIVE_TYPE_NAME[FIVE_TYPE.FOUR],
      key: quadRank,
    };
  }

  // Full house: counts [3,2]
  if (countVals[0] === 3 && countVals[1] === 2) {
    const tripRank = Number(Object.keys(counts).find((r) => counts[r] === 3));
    return {
      category: CAT.FIVE,
      cards: sorted,
      typeStrength: FIVE_TYPE.FULL_HOUSE,
      label: FIVE_TYPE_NAME[FIVE_TYPE.FULL_HOUSE],
      key: tripRank,
    };
  }

  if (sInfo && isFlush) {
    const top = topCard(sInfo.topRankIndex);
    if (sInfo.height === 9) {
      // 10-J-Q-K-A suited = Royal Flush. All equal except suit of the Ace.
      return {
        category: CAT.FIVE,
        cards: sorted,
        typeStrength: FIVE_TYPE.ROYAL_FLUSH,
        label: FIVE_TYPE_NAME[FIVE_TYPE.ROYAL_FLUSH],
        key: top.s,
      };
    }
    return {
      category: CAT.FIVE,
      cards: sorted,
      typeStrength: FIVE_TYPE.STRAIGHT_FLUSH,
      label: FIVE_TYPE_NAME[FIVE_TYPE.STRAIGHT_FLUSH],
      key: sInfo.height * 4 + top.s,
    };
  }

  if (isFlush) {
    const high = sorted[sorted.length - 1];
    return {
      category: CAT.FIVE,
      cards: sorted,
      typeStrength: FIVE_TYPE.FLUSH,
      label: FIVE_TYPE_NAME[FIVE_TYPE.FLUSH],
      key: cardId(high),
    };
  }

  if (sInfo) {
    const top = topCard(sInfo.topRankIndex);
    return {
      category: CAT.FIVE,
      cards: sorted,
      typeStrength: FIVE_TYPE.STRAIGHT,
      label: FIVE_TYPE_NAME[FIVE_TYPE.STRAIGHT],
      key: sInfo.height * 4 + top.s,
    };
  }

  return null;
}

// ----------------------------------------------------------------------------
// Comparing two legal combinations
// ----------------------------------------------------------------------------
// Returns true if `candidate` legally BEATS `current` (strictly higher).
function beats(candidate, current) {
  if (!candidate || !current) return false;
  if (candidate.category !== current.category) return false;

  if (candidate.category === CAT.FIVE) {
    if (candidate.typeStrength !== current.typeStrength) {
      return candidate.typeStrength > current.typeStrength;
    }
    return candidate.key > current.key;
  }

  // single / pair / trips
  return candidate.key > current.key;
}

// ----------------------------------------------------------------------------
// Scoring
// ----------------------------------------------------------------------------
// Penalty for a losing player based on cards left in hand.
//   1-6 cards  -> x1
//   7-9 cards  -> x2
//   10-13 cards-> x3
function penaltyFor(cardsLeft) {
  if (cardsLeft <= 0) return 0;
  let mult = 1;
  if (cardsLeft >= 10) mult = 3;
  else if (cardsLeft >= 7) mult = 2;
  return cardsLeft * mult;
}

const MATCH_TARGET = 101;

module.exports = {
  RANKS,
  SUITS,
  SUIT_SYMBOL,
  CAT,
  FIVE_TYPE,
  FIVE_TYPE_NAME,
  MATCH_TARGET,
  THREE_OF_DIAMONDS,
  cardId,
  cardCode,
  parseCode,
  cardLabel,
  compareCards,
  isThreeOfDiamonds,
  makeDeck,
  shuffle,
  deal,
  identifyCombo,
  beats,
  penaltyFor,
};
