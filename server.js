const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const E = require('./game/engine');
const BOT = require('./game/bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const DATA_DIR = path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const rooms = new Map();
const STATS_FILE = path.join(DATA_DIR,'stats.json');
let stats={};
function statFor(id,name){ if(!stats[id]) stats[id]={name:name||'Player',matchesPlayed:0,matchesWon:0,matchesLost:0,roundsWon:0,points:0}; if(name) stats[id].name=name; return stats[id]; }
const ALLOWED_REACTIONS=new Set(['👍','😂','😮','😎','🔥','😭','🎉','🤔','👏','🫡','Nice!','GG','Good game','Your turn!','Oops','So close','Wow','Hurry up!']);
let _statsTimer=null;
function saveStatsSoon(){ if(_statsTimer) return; _statsTimer=setTimeout(()=>{_statsTimer=null; try{ if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(STATS_FILE,JSON.stringify(stats)); }catch(e){} },50); }
function loadStats(){ try{ if(fs.existsSync(STATS_FILE)) stats=JSON.parse(fs.readFileSync(STATS_FILE,'utf8'))||{}; }catch(e){} }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code=''; for (let i=0;i<4;i++) code+=chars[Math.floor(Math.random()*chars.length)]; } while (rooms.has(code));
  return code;
}
function makeRoom(code, hostId) {
  return { code, hostId, phase:'lobby', players:[], log:[], game:null, lastRound:null, matchResult:null, lastActive:Date.now(), turnSeconds:0, _botTimer:null, _turnTimer:null };
}
function touch(room){ room.lastActive=Date.now(); }
function logRoom(room,msg){ room.log.push(msg); if(room.log.length>40) room.log.shift(); }
function playerBySocket(socketId){ for(const room of rooms.values()){ const p=room.players.find(x=>x.socketId===socketId); if(p) return {room,player:p}; } return null; }
function humanCount(room){ return room.players.filter(p=>!p.isBot).length; }

function startDeal(room){
  const n=room.players.length; const hands=E.deal(n);
  room.players.forEach((p,i)=>{p.hand=hands[i];});
  let starter=0; room.players.forEach((p,i)=>{ if(p.hand.some(E.isThreeOfDiamonds)) starter=i; });
  room.game={ turn:starter, currentPlay:null, lastPlayer:null, passes:0, mustIncludeThreeDiamonds:true, oneCardPlayer:null, forcedPlayer:null, forcedHandled:false, freeLeadFor:null };
  room.phase='playing'; room.lastRound=null;
  logRoom(room, `New deal. ${room.players[starter].name} holds 3D and leads.`);
}
function nextSeat(room,seat){ return (seat+1)%room.players.length; }
function advanceTurn(room){ const g=room.game; let nx=nextSeat(room,g.turn); if(g.freeLeadFor!=null && nx===g.freeLeadFor) nx=nextSeat(room,nx); g.turn=nx; }
function awardTrick(room){ const g=room.game; const w=g.lastPlayer; logRoom(room,`${room.players[w].name} wins the trick and leads.`); g.currentPlay=null; g.lastPlayer=null; g.passes=0; g.turn=w; g.freeLeadFor=null; }
function handToCodes(hand){ return hand.slice().sort(E.compareCards).map(E.cardCode); }
function takeCards(hand,codes){ const removed=[]; const working=hand.slice(); for(const code of codes){ const idx=working.findIndex(c=>E.cardCode(c)===code); if(idx===-1) return null; removed.push(working[idx]); working.splice(idx,1);} return {removed,remaining:working}; }

function endRound(room,winnerSeat){
  const results=room.players.map((p,i)=>{ const cardsLeft=i===winnerSeat?0:p.hand.length; const penalty=E.penaltyFor(cardsLeft); p.score+=penalty; return {name:p.name,cardsLeft,penalty,score:p.score,seat:i}; });
  room.lastRound={results,winnerName:room.players[winnerSeat].name};
  logRoom(room,'win');
  const _w=room.players[winnerSeat]; if(!_w.isBot) statFor(_w.id,_w.name).roundsWon+=1;
  results.forEach(r=>{ const p=room.players[r.seat]; if(!p.isBot&&r.penalty>0) statFor(p.id,p.name).points+=r.penalty; });
  const someoneOut=room.players.some(p=>p.score>=E.MATCH_TARGET);
  if(someoneOut){ const ranked=room.players.map((p,i)=>({name:p.name,score:p.score,seat:i})).sort((a,b)=>a.score-b.score); room.matchResult={ranked,winnerName:ranked[0].name,loserName:ranked[ranked.length-1].name}; room.phase='matchEnd'; room.game=null; logRoom(room,'match over');
    const _best=ranked[0].seat,_worst=ranked[ranked.length-1].seat;
    room.players.forEach((p,i)=>{ if(p.isBot) return; const st=statFor(p.id,p.name); st.matchesPlayed+=1; if(i===_best) st.matchesWon+=1; if(i===_worst) st.matchesLost+=1; }); }
  else { room.phase='roundEnd'; room.game=null; }
  saveStatsSoon();
}

function doPlay(room,seat,codes){
  const g=room.game;
  if(!g) return 'No game in progress.';
  if(g.turn!==seat) return 'Not your turn.';
  if(!Array.isArray(codes)||codes.length===0) return 'Select at least one card.';
  const player=room.players[seat];
  const taken=takeCards(player.hand,codes);
  if(!taken) return 'You do not hold those cards.';
  const combo=E.identifyCombo(taken.removed);
  if(!combo) return 'That is not a legal combination.';
  const isForced=g.forcedPlayer===seat && !g.forcedHandled;
  if(isForced){
    if(combo.category!==E.CAT.SINGLE) return 'You must play your highest single card.';
    const highest=player.hand.slice().sort(E.compareCards).pop();
    if(E.cardCode(highest)!==codes[0]) return 'You must play your HIGHEST single card.';
    player.hand=taken.remaining; g.currentPlay={seat,combo}; g.lastPlayer=seat; g.passes=0; g.forcedHandled=true; g.forcedPlayer=null; g.mustIncludeThreeDiamonds=false; g.freeLeadFor=g.oneCardPlayer;
    logRoom(room,`${player.name} is forced to play ${combo.cards.map(E.cardLabel).join(' ')} (1-card rule).`);
    afterPlay(room,seat,taken.remaining.length); return null;
  }
  if(g.mustIncludeThreeDiamonds){ if(!combo.cards.some(E.isThreeOfDiamonds)) return 'Your first play must include 3D.'; }
  if(g.currentPlay){ if(combo.category!==g.currentPlay.combo.category) return `You must play a ${g.currentPlay.combo.category} (or pass).`; if(!E.beats(combo,g.currentPlay.combo)) return 'That does not beat the current play.'; }
  player.hand=taken.remaining; g.currentPlay={seat,combo}; g.lastPlayer=seat; g.passes=0; g.mustIncludeThreeDiamonds=false; g.freeLeadFor=null;
  logRoom(room,`${player.name} played ${combo.label}.`);
  afterPlay(room,seat,taken.remaining.length); return null;
}
function afterPlay(room,seat,cardsLeft){
  const g=room.game;
  if(cardsLeft===0){ endRound(room,seat); return; }
  if(cardsLeft===1 && g.oneCardPlayer!==seat){ g.oneCardPlayer=seat; g.forcedPlayer=(seat-1+room.players.length)%room.players.length; g.forcedHandled=false; logRoom(room,`${room.players[seat].name} has 1 card left! ${room.players[g.forcedPlayer].name} must play highest card next.`); }
  advanceTurn(room);
}
function doPass(room,seat){
  const g=room.game;
  if(!g) return 'No game in progress.';
  if(g.turn!==seat) return 'Not your turn.';
  if(!g.currentPlay) return 'You are leading.';
  if(g.forcedPlayer===seat && !g.forcedHandled) return 'You must play your highest card (1-card rule).';
  g.passes+=1; logRoom(room,`${room.players[seat].name} passed.`);
  if(g.freeLeadFor!=null){ if(g.passes>=room.players.length-2){ const u=g.freeLeadFor; g.currentPlay=null; g.lastPlayer=null; g.passes=0; g.freeLeadFor=null; g.turn=u; logRoom(room,`${room.players[u].name} takes the lead (1-card rule).`); return null; } advanceTurn(room); return null; }
  if(g.passes>=room.players.length-1){ awardTrick(room); return null; }
  advanceTurn(room); return null;
}

function botMove(room,seat){
  const g=room.game; const me=room.players[seat];
  const opponents=room.players.filter((_,i)=>i!==seat).map(p=>({cardCount:p.hand.length}));
  const decision=BOT.decide({hand:me.hand,current:g.currentPlay?g.currentPlay.combo:null,forced:g.forcedPlayer===seat&&!g.forcedHandled,mustThreeD:g.mustIncludeThreeDiamonds,opponents});
  return decision?decision.map(E.cardCode):null;
}
function scheduleBot(room){
  if(room.phase!=='playing'||!room.game) return;
  const seat=room.game.turn; const p=room.players[seat];
  if(!p||!p.isBot) return; if(room._botTimer) return;
  room._botTimer=setTimeout(()=>{
    room._botTimer=null;
    if(room.phase!=='playing'||!room.game||room.game.turn!==seat){ scheduleBot(room); return; }
    const codes=botMove(room,seat); let err=null;
    if(codes&&codes.length) err=doPlay(room,seat,codes); else err=doPass(room,seat);
    if(err){ const e2=doPass(room,seat); if(e2){ const lowest=room.players[seat].hand.slice().sort(E.compareCards)[0]; if(lowest) doPlay(room,seat,[E.cardCode(lowest)]); } }
    touch(room); broadcastNoBot(room); saveSoon(); scheduleBot(room);
  }, 700+Math.random()*700); // fast for tests
}

function stateFor(room,player){
  const g=room.game; const seat=room.players.indexOf(player);
  return { code:room.code, phase:room.phase, youAreHost:player.id===room.hostId, yourSeat:seat, yourHand:handToCodes(player.hand||[]),
    turnSeat:g?g.turn:null, turnSeconds:room.turnSeconds||0, turnDeadline:g?(g.turnDeadline||null):null, oneCardPlayer:g?g.oneCardPlayer:null, forcedPlayer:g?(g.forcedHandled?null:g.forcedPlayer):null, mustIncludeThreeDiamonds:g?g.mustIncludeThreeDiamonds:false,
    currentPlay:g&&g.currentPlay?{seat:g.currentPlay.seat,name:room.players[g.currentPlay.seat].name,cards:g.currentPlay.combo.cards.map(E.cardCode),label:g.currentPlay.combo.label}:null,
    players:room.players.map((p,i)=>({seat:i,name:p.name,score:p.score,cardCount:(p.hand||[]).length,connected:p.connected,isHost:p.id===room.hostId,isBot:!!p.isBot,isYou:i===seat,lifetime:p.isBot?null:(stats[p.id]||null)})),
    log:room.log.slice(-30), lastRound:room.lastRound, matchResult:room.matchResult,
    canStart:room.phase==='lobby'&&room.players.length===MAX_PLAYERS&&humanCount(room)>=1&&player.id===room.hostId,
    canAddBot:room.phase==='lobby'&&room.players.length<MAX_PLAYERS&&player.id===room.hostId,
    canRemoveBot:room.phase==='lobby'&&room.players.some(p=>p.isBot)&&player.id===room.hostId,
    needMorePlayers:MAX_PLAYERS-room.players.length };
}
function clearTurnTimer(room){ if(room._turnTimer){clearTimeout(room._turnTimer);room._turnTimer=null;} if(room.game){room.game.turnDeadline=null;room.game._timerSeat=null;} }
function armTurnTimer(room){ const g=room.game; if(!g||room.phase!=='playing'||!room.turnSeconds){clearTurnTimer(room);return;} const seat=g.turn; const p=room.players[seat]; if(!p||p.isBot||!p.connected){clearTurnTimer(room);return;} if(room._turnTimer&&g._timerSeat===seat)return; if(room._turnTimer)clearTimeout(room._turnTimer); g.turnDeadline=Date.now()+room.turnSeconds*1000; g._timerSeat=seat; room._turnTimer=setTimeout(()=>{ room._turnTimer=null; const gg=room.game; if(gg&&room.phase==='playing'&&gg.turn===seat) autoAct(room); }, room.turnSeconds*1000+200); }
function autoAct(room){ const g=room.game; if(!g||room.phase!=='playing')return; const seat=g.turn; const p=room.players[seat]; if(!p)return; const forced=g.forcedPlayer===seat&&!g.forcedHandled; const sorted=p.hand.slice().sort(E.compareCards); let err=null; if(g.currentPlay&&!forced){ err=doPass(room,seat); } else { let codes; if(forced) codes=[E.cardCode(sorted[sorted.length-1])]; else if(g.mustIncludeThreeDiamonds) codes=[E.cardCode(sorted.find(E.isThreeOfDiamonds))]; else codes=[E.cardCode(sorted[0])]; err=doPlay(room,seat,codes); if(err&&sorted[0]) doPlay(room,seat,[E.cardCode(sorted[0])]); } logRoom(room, p.name+"'s time ran out."); touch(room); broadcast(room); }
function broadcastNoBot(room){ for(const p of room.players){ if(p.socketId) io.to(p.socketId).emit('state',stateFor(room,p)); } }
function broadcast(room){ scheduleBot(room); armTurnTimer(room); broadcastNoBot(room); saveSoon(); }

function persist(){
  try{ if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true});
    const dump=[]; for(const room of rooms.values()){ dump.push({code:room.code,hostId:room.hostId,phase:room.phase,players:room.players.map(p=>({id:p.id,name:p.name,score:p.score,hand:p.hand,isBot:!!p.isBot})),log:room.log,game:room.game,lastRound:room.lastRound,matchResult:room.matchResult,lastActive:room.lastActive}); }
    fs.writeFileSync(SAVE_FILE,JSON.stringify(dump));
  }catch(e){ console.error('persist error:',e.message); }
}
let _saveTimer=null;
function saveSoon(){ if(_saveTimer) return; _saveTimer=setTimeout(()=>{_saveTimer=null;persist();},100); }
function loadRooms(){
  try{ if(!fs.existsSync(SAVE_FILE)) return; const dump=JSON.parse(fs.readFileSync(SAVE_FILE,'utf8')); const cutoff=Date.now()-ROOM_TTL_MS;
    for(const r of dump){ if((r.lastActive||0)<cutoff) continue; const room=makeRoom(r.code,r.hostId); room.phase=r.phase; room.log=r.log||[]; room.game=r.game||null; room.lastRound=r.lastRound||null; room.matchResult=r.matchResult||null; room.lastActive=r.lastActive||Date.now();
      room.players=(r.players||[]).map(p=>({id:p.id,name:p.name,score:p.score||0,hand:p.hand||[],isBot:!!p.isBot,socketId:null,connected:!!p.isBot})); rooms.set(room.code,room); }
    if(rooms.size) console.log(`Restored ${rooms.size} room(s) from disk.`);
    for(const room of rooms.values()) scheduleBot(room);
  }catch(e){ console.error('load error:',e.message); }
}

io.on('connection',(socket)=>{
  socket.on('createRoom',({name,playerId},cb)=>{ name=(name||'Player').toString().slice(0,16).trim()||'Player'; const code=genCode(); const room=makeRoom(code,playerId); room.players.push({id:playerId,name,socketId:socket.id,score:0,hand:[],connected:true,isBot:false}); rooms.set(code,room); socket.join(code); logRoom(room,`${name} created the room.`); cb&&cb({ok:true,code}); broadcast(room); });
  socket.on('joinRoom',({code,name,playerId},cb)=>{ code=(code||'').toString().toUpperCase().trim(); const room=rooms.get(code); if(!room) return cb&&cb({ok:false,error:'Room not found.'}); const ex=room.players.find(p=>p.id===playerId); if(ex){ ex.socketId=socket.id; ex.connected=true; socket.join(code); cb&&cb({ok:true,code}); broadcast(room); return; } if(room.phase!=='lobby') return cb&&cb({ok:false,error:'Game already started.'}); if(room.players.length>=MAX_PLAYERS) return cb&&cb({ok:false,error:'Room is full.'}); name=(name||'Player').toString().slice(0,16).trim()||'Player'; room.players.push({id:playerId,name,socketId:socket.id,score:0,hand:[],connected:true,isBot:false}); socket.join(code); logRoom(room,`${name} joined.`); cb&&cb({ok:true,code}); broadcast(room); });
  socket.on('addBot',()=>{ const f=playerBySocket(socket.id); if(!f) return; const {room,player}=f; if(player.id!==room.hostId||room.phase!=='lobby') return; if(room.players.length>=MAX_PLAYERS) return; const n=room.players.filter(p=>p.isBot).length+1; const id='bot_'+Math.random().toString(36).slice(2,9); room.players.push({id,name:'Bot '+n,socketId:null,score:0,hand:[],connected:true,isBot:true}); logRoom(room,'A bot joined.'); broadcast(room); });
  socket.on('removeBot',()=>{ const f=playerBySocket(socket.id); if(!f) return; const {room,player}=f; if(player.id!==room.hostId||room.phase!=='lobby') return; for(let i=room.players.length-1;i>=0;i--){ if(room.players[i].isBot){ room.players.splice(i,1); break; } } broadcast(room); });
  socket.on('startGame',()=>{ const f=playerBySocket(socket.id); if(!f) return; const {room,player}=f; if(player.id!==room.hostId) return socket.emit('error',{message:'Only the host can start.'}); if(room.players.length!==MAX_PLAYERS) return socket.emit('error',{message:'Need 4 seats filled.'}); if(humanCount(room)<1) return; if(room.phase==='playing') return; startDeal(room); broadcast(room); });
  socket.on('setTurnTime',({seconds}={})=>{ const f=playerBySocket(socket.id); if(!f)return; const {room,player}=f; if(player.id!==room.hostId)return; const s2=Number(seconds); room.turnSeconds=[0,10,20,30].includes(s2)?s2:0; clearTurnTimer(room); broadcast(room); });
  socket.on('nextRound',()=>{ const f=playerBySocket(socket.id); if(!f) return; const {room,player}=f; if(player.id!==room.hostId||room.phase!=='roundEnd') return; startDeal(room); broadcast(room); });
  socket.on('playAgain',()=>{ const f=playerBySocket(socket.id); if(!f) return; const {room,player}=f; if(player.id!==room.hostId||room.phase!=='matchEnd') return; room.players.forEach(p=>p.score=0); room.matchResult=null; room.lastRound=null; startDeal(room); broadcast(room); });
  socket.on('play',({cards})=>{ const f=playerBySocket(socket.id); if(!f) return; const {room,player}=f; const seat=room.players.indexOf(player); const err=doPlay(room,seat,cards); if(err) socket.emit('error',{message:err}); touch(room); broadcast(room); });
  socket.on('pass',()=>{ const f=playerBySocket(socket.id); if(!f) return; const {room,player}=f; const seat=room.players.indexOf(player); const err=doPass(room,seat); if(err) socket.emit('error',{message:err}); touch(room); broadcast(room); });
  socket.on('reaction',({emoji}={})=>{ const f=playerBySocket(socket.id); if(!f) return; const {room,player}=f; const t=String(emoji||'').slice(0,12); if(!ALLOWED_REACTIONS.has(t)) return; const now=Date.now(); if(player._lastReact&&now-player._lastReact<400) return; player._lastReact=now; const seat=room.players.indexOf(player); io.to(room.code).emit('reaction',{seat,name:player.name,emoji:t}); });
  socket.on('chat',({text}={})=>{ const f=playerBySocket(socket.id); if(!f) return; const {room,player}=f; const msg=String(text||'').replace(/[\x00-\x1F\x7F]/g,' ').trim().slice(0,140); if(!msg) return; const now=Date.now(); if(player._lastChat&&now-player._lastChat<300) return; player._lastChat=now; const seat=room.players.indexOf(player); socket.to(room.code).emit('chat',{seat,name:player.name,text:msg}); });
  socket.on('getStats',({playerId}={},cb)=>{ cb&&cb({ok:true,stats:stats[playerId]||null}); });
  socket.on('disconnect',()=>{ const f=playerBySocket(socket.id); if(!f) return; const {room,player}=f; player.connected=false; player.socketId=null; if(room.phase==='lobby'){ room.players=room.players.filter(p=>p.id!==player.id); if(humanCount(room)===0){ rooms.delete(room.code); saveSoon(); return; } if(!room.players.some(p=>p.id===room.hostId&&!p.isBot)){ const fh=room.players.find(p=>!p.isBot); if(fh) room.hostId=fh.id; } } broadcast(room); });
});
loadStats();
loadRooms();
server.listen(PORT,()=>{ console.log(`Chinese Poker server running on http://localhost:${PORT}`); });

if(process.env.CP_TEST) module.exports={makeRoom,doPlay,doPass};
