// Lightweight test runner for the engine (no deps). Run: node game/engine.test.js
const E = require('./engine');

let pass = 0,
  fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error('  FAIL:', name);
  }
}

// Build cards from codes like "10H", "3D", "AS"
const C = (...codes) => codes.map(E.parseCode);
const combo = (...codes) => E.identifyCombo(C(...codes));

// ---- deck / deal ----
ok('deck has 52 cards', E.makeDeck().length === 52);
(() => {
  const hands = E.deal(4);
  ok('deals 4 hands', hands.length === 4);
  ok('each hand 13', hands.every((h) => h.length === 13));
  const all = hands.flat().map(E.cardId);
  ok('no duplicate cards dealt', new Set(all).size === 52);
})();

// ---- single card ordering ----
ok('2 beats A (single)', E.beats(combo('2D'), combo('AS')));
ok('5S beats 5H (suit tiebreak)', E.beats(combo('5S'), combo('5H')));
ok('5H does not beat 5S', !E.beats(combo('5H'), combo('5S')));
ok('3D is lowest card', E.cardId(E.THREE_OF_DIAMONDS) === 0);

// ---- pairs ----
ok('pair valid', combo('7H', '7D').category === E.CAT.PAIR);
ok('non-pair invalid', combo('7H', '8D') === null);
ok(
  'pair 5S5D beats 5H5C (high card of pair)',
  E.beats(combo('5S', '5D'), combo('5H', '5C'))
);

// ---- trips ----
ok('trips valid', combo('9H', '9D', '9C').category === E.CAT.TRIPS);
ok('trips of 6 beats trips of 5', E.beats(combo('6H', '6D', '6C'), combo('5H', '5D', '5S')));
ok(
  'trips cannot beat a five-card combo',
  !E.beats(combo('9H', '9D', '9C'), combo('3D', '4D', '5D', '6D', '7D'))
);
ok(
  'five-card combo cannot beat trips',
  !E.beats(combo('3D', '4D', '5D', '6D', '7D'), combo('9H', '9D', '9C'))
);

// ---- five-card type detection ----
ok('straight', combo('4D', '5C', '6H', '7S', '8D').typeStrength === E.FIVE_TYPE.STRAIGHT);
ok('flush', combo('3H', '6H', '9H', 'JH', 'KH').typeStrength === E.FIVE_TYPE.FLUSH);
ok('full house', combo('8H', '8D', '8C', '4S', '4D').typeStrength === E.FIVE_TYPE.FULL_HOUSE);
ok('four of a kind', combo('JH', 'JD', 'JC', 'JS', '2D').typeStrength === E.FIVE_TYPE.FOUR);
ok('straight flush', combo('4S', '5S', '6S', '7S', '8S').typeStrength === E.FIVE_TYPE.STRAIGHT_FLUSH);
ok('royal flush', combo('10S', 'JS', 'QS', 'KS', 'AS').typeStrength === E.FIVE_TYPE.ROYAL_FLUSH);
ok('A2345 is a straight', combo('AD', '2C', '3H', '4S', '5D').typeStrength === E.FIVE_TYPE.STRAIGHT);
ok('10JQKA straight (not flush)', combo('10D', 'JC', 'QH', 'KS', 'AD').typeStrength === E.FIVE_TYPE.STRAIGHT);
ok('JQKA2 is NOT a straight', combo('JD', 'QC', 'KH', 'AS', '2D') === null);
ok('random 5 cards invalid', combo('3D', '7C', '9H', 'JS', 'KD') === null);
ok('4 cards invalid', E.identifyCombo(C('3D', '3C', '3H', '3S')) === null);

// ---- cross-type beats ----
ok('flush beats straight', E.beats(combo('3H', '6H', '9H', 'JH', 'KH'), combo('4D', '5C', '6H', '7S', '8D')));
ok('full house beats flush', E.beats(combo('8H', '8D', '8C', '4S', '4D'), combo('3H', '6H', '9H', 'JH', 'KH')));
ok('four beats full house', E.beats(combo('JH', 'JD', 'JC', 'JS', '2D'), combo('8H', '8D', '8C', '4S', '4D')));
ok('straight flush beats four', E.beats(combo('4S', '5S', '6S', '7S', '8S'), combo('JH', 'JD', 'JC', 'JS', '2D')));
ok('royal beats straight flush', E.beats(combo('10S', 'JS', 'QS', 'KS', 'AS'), combo('4S', '5S', '6S', '7S', '8S')));

// ---- within-type comparisons ----
ok('higher straight beats lower', E.beats(combo('5D', '6C', '7H', '8S', '9D'), combo('4D', '5C', '6H', '7S', '8D')));
ok('straight suit tiebreak (8S top beats 8D top)', E.beats(combo('4D', '5C', '6H', '7S', '8S'), combo('4H', '5C', '6H', '7C', '8D')));
ok('full house compares trip part', E.beats(combo('6H', '6D', '6C', '2S', '2D'), combo('5H', '5D', '5C', 'AS', 'AD')));
ok('four compares quad rank', E.beats(combo('7H', '7D', '7C', '7S', '3D'), combo('6H', '6D', '6C', '6S', 'AD')));
ok('royal flush suit decides', E.beats(combo('10S', 'JS', 'QS', 'KS', 'AS'), combo('10H', 'JH', 'QH', 'KH', 'AH')));

// ---- category mismatch cannot beat ----
ok('pair cannot beat single', !E.beats(combo('5H', '5D'), combo('9S')));
ok('single cannot beat pair', !E.beats(combo('9S'), combo('5H', '5D')));

// ---- scoring ----
ok('penalty 5 cards = 5', E.penaltyFor(5) === 5);
ok('penalty 6 cards = 6', E.penaltyFor(6) === 6);
ok('penalty 7 cards = 14', E.penaltyFor(7) === 14);
ok('penalty 8 cards = 16', E.penaltyFor(8) === 16);
ok('penalty 9 cards = 18', E.penaltyFor(9) === 18);
ok('penalty 10 cards = 30', E.penaltyFor(10) === 30);
ok('penalty 13 cards = 39', E.penaltyFor(13) === 39);
ok('penalty 0 cards = 0', E.penaltyFor(0) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
