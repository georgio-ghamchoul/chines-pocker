// Unit tests for the bot AI. Run: node game/bot.test.js
const E = require('./engine');
const BOT = require('./bot');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.error('  FAIL:', n)); };
const C = (...x) => x.map(E.parseCode);
const id = (...x) => E.identifyCombo(C(...x));
const opp = (...counts) => counts.map((c) => ({ cardCount: c }));
let d;

// 1-card rule: must play highest single
d = BOT.decide({ hand: C('3D', '7H', 'KS'), current: null, forced: true, mustThreeD: false, opponents: opp(5) });
ok('forced -> highest single (KS)', d.length === 1 && E.cardCode(d[0]) === 'KS');

// opening play must include 3D
d = BOT.decide({ hand: C('3D', '7H', 'KS'), current: null, forced: false, mustThreeD: true, opponents: opp(5) });
ok('lead includes 3D', d.some(E.isThreeOfDiamonds));

// leading normally -> sheds a low card
d = BOT.decide({ hand: C('4D', '9H', 'KS', '2S'), current: null, forced: false, mustThreeD: false, opponents: opp(5, 5, 5) });
ok('lead lowest single 4D', d.length === 1 && E.cardCode(d[0]) === '4D');

// responding to a single -> minimal beater
d = BOT.decide({ hand: C('4D', '9H', 'JS'), current: id('8C'), forced: false, mustThreeD: false, opponents: opp(5, 5, 5) });
ok('beats 8C minimally with 9H', d && d.length === 1 && E.cardCode(d[0]) === '9H');

// cannot beat -> pass
d = BOT.decide({ hand: C('3D', '4D', '5C'), current: id('2S'), forced: false, mustThreeD: false, opponents: opp(5, 5, 5) });
ok('passes when nothing beats 2S', d === null);

// conserve A/2 vs a single early
d = BOT.decide({ hand: C('AS', '2S', '3D', '4D', '5C', '6C', '7H'), current: id('KH'), forced: false, mustThreeD: false, opponents: opp(6, 7, 8) });
ok('holds A/2 on a single when hand is large', d === null);

// pressure: an opponent on 1 card -> block even with a high card
d = BOT.decide({ hand: C('AS', '2S', '3D', '4D', '5C', '6C', '7H'), current: id('KH'), forced: false, mustThreeD: false, opponents: opp(1, 7, 8) });
ok('blocks under pressure (plays AS)', d && d.length === 1 && E.cardCode(d[0]) === 'AS');

// take the win if a beating move empties the hand
d = BOT.decide({ hand: C('AS'), current: id('KH'), forced: false, mustThreeD: false, opponents: opp(5) });
ok('plays last card to win', d && d.length === 1 && E.cardCode(d[0]) === 'AS');

// 5-card response: beat a straight with a higher-type 5-card combo
d = BOT.decide({ hand: C('3H', '6H', '9H', 'JH', 'KH', '2D', '2C'), current: id('4D', '5C', '6S', '7H', '8D'), forced: false, mustThreeD: false, opponents: opp(3, 3, 3) });
ok('beats a straight with a 5-card combo', d && d.length === 5 && E.identifyCombo(d).typeStrength >= E.FIVE_TYPE.FLUSH);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
