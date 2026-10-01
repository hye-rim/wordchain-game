'use strict';

// 끝말잇기: 컴퓨터와 이어가기 + 방 코드 온라인 대결. 사전과 판정, 컴퓨터의 대답은 서버가 맡는다.
(() => {
const H = window.Hangul;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 저장·소리 ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};
const session = {
  get() { try { return JSON.parse(sessionStorage.getItem('wordchainRoom')); } catch (_) { return null; } },
  set(v) { try { sessionStorage.setItem('wordchainRoom', JSON.stringify(v)); } catch (_) {} },
  clear() { try { sessionStorage.removeItem('wordchainRoom'); } catch (_) {} },
};
let muted = store.get('wordchainMuted') === '1';
let audio = null;
function tone(freq, dur, type = 'sine', vol = 0.12, slide = 0) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur);
  } catch (_) {}
}
const sfx = {
  ok: (c = 0) => { tone(620 + Math.min(c, 8) * 40, 0.09, 'sine', 0.12, 240); setTimeout(() => tone(930 + Math.min(c, 8) * 40, 0.1, 'sine', 0.1), 70); },
  bad: () => tone(170, 0.14, 'square', 0.06, -50),
  tick: () => tone(1000, 0.04, 'square', 0.05),
  lose: () => [400, 300, 220].forEach((f, i) => setTimeout(() => tone(f, 0.16, 'sawtooth', 0.07), i * 110)),
  turn: () => { tone(880, 0.08, 'triangle', 0.09); setTimeout(() => tone(1175, 0.1, 'triangle', 0.09), 80); },
  word: () => tone(560, 0.06, 'triangle', 0.06, 120),
  boom: () => [784, 988, 1175, 1568].forEach((f, i) => setTimeout(() => tone(f, 0.12, 'square', 0.07), i * 70)),
  win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.16, 'triangle', 0.1), i * 100)),
};
function setMute(m) { muted = m; store.set('wordchainMuted', m ? '1' : '0'); $('sMute').textContent = $('rMute').textContent = m ? '🔇' : '🔊'; }
$('sMute').onclick = $('rMute').onclick = (e) => { e.currentTarget.blur(); setMute(!muted); };
setMute(muted);

// ---------- 화면 ----------
function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === id)); }
function shake(el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
function setMsg(el, text, kind = '') { el.textContent = text; el.className = 'msg ' + kind; }

// 이어야 하는 단어를 글자 타일로. 끝 글자는 노랗게, 글자가 많으면 타일을 줄인다
function renderWord(tilesEl, nextEl, word, cpu = false) {
  const n = [...word].length;
  tilesEl.parentElement.style.setProperty('--tw', n <= 3 ? '' : `${Math.max(40, Math.floor(76 - (n - 3) * 10))}px`);
  tilesEl.innerHTML = [...word].map((c, i) => `<div class="tile${cpu ? ' cpu' : ''}${i === n - 1 ? ' end' : ''}">${c}</div>`).join('');
  nextEl.innerHTML = word ? `${startsText(word)}${ro(word)} 시작해요` : '';
}
const startsText = (word) => H.starts(word).map((c) => `<b>${c}</b>`).join(' 또는 ');
const startsPlain = (word) => H.starts(word).map((c) => `'${c}'`).join(' 또는 ');
// 조사 '로/으로': 마지막으로 보이는 글자에 받침이 있으면(ㄹ 받침은 빼고) '으로'
function ro(word) {
  const ch = H.starts(word).slice(-1)[0] || '';
  const jong = ch ? (ch.charCodeAt(0) - 0xac00) % 28 : 0;
  return jong && jong !== 8 ? '으로' : '로';
}

// 한글 입력기는 Enter 로 마지막 글자를 확정하면서 입력 이벤트를 한 번 더 보내거나, 지운 칸에 글자를 되살리는 경우가 있다.
// 제출 직후 마지막 글자 하나만 되살아나면 지운다.
function wireInput(input, form, onSubmit) {
  let last = { text: '', at: 0 };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    input.value = '';
    if (!v) return;
    last = { text: v, at: performance.now() };
    onSubmit(v);
  });
  input.addEventListener('input', () => {
    if (performance.now() - last.at < 150 && input.value.length === 1 && last.text.endsWith(input.value)) input.value = '';
  });
  form.querySelector('button').addEventListener('pointerdown', (e) => e.preventDefault());   // 키보드가 내려가지 않게
}

async function api(path) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// 서버에 묻기 전에 폰에서 바로 알 수 있는 실수
function quickCheck(prev, w, used) {
  if (!H.isWordShape(w)) return w.length < 2 ? 'short' : 'shape';
  if (!H.follows(prev, w)) return 'chain';
  if (used.has(w)) return 'used';
  return null;
}
const rejectText = (reason, prev) => ({
  short: '두 글자 이상 써요',
  shape: '한글 단어만 돼요 (8글자까지)',
  chain: `${startsPlain(prev)}${ro(prev)} 시작해야 해요`,
  used: '이미 나온 말이에요',
  unknown: '사전에 없는 말이에요',
  offline: '서버에 연결할 수 없어요',
}[reason] || '다시 해 보세요');

let best = Number(store.get('wordchainBest')) || 0;
function saveBest(score) { if (score > best) { best = score; store.set('wordchainBest', String(best)); refreshHome(); } }
function refreshHome() {
  const t = $('bestTag');
  t.hidden = !best;
  t.textContent = `🏆 컴퓨터와 이어가기 최고 ${best.toLocaleString()}점`;
}

// =====================================================================
// 컴퓨터와 이어가기
// =====================================================================
const solo = {};
const levelOf = (mine) => 1 + Math.floor(mine / 5);
const turnSecs = (level) => Math.max(8, 18 - (level - 1));
function newSolo() {
  Object.assign(solo, { lives: 3, score: 0, mine: 0, combo: 0, passes: 2, booms: 0, used: new Set(), history: [], prev: '', deadline: 0, total: 18, phase: 'idle', busy: false, pausedRemain: 0, lastTickSec: -1, timerId: 0, gen: 0 });
}
newSolo();

function soloHud() {
  $('sLives').textContent = '❤️'.repeat(solo.lives) + '🖤'.repeat(3 - solo.lives);
  $('sScore').textContent = solo.score.toLocaleString();
  $('sLevel').textContent = `Lv ${levelOf(solo.mine)}`;
  $('sPassLeft').textContent = solo.passes;
  $('sPass').disabled = solo.passes <= 0 || solo.phase !== 'input';
  setMsg($('sCombo'), solo.combo >= 2 ? `🔥 ${solo.combo}연속!` : '', 'good');
  const inputOn = solo.phase === 'input';
  $('sInput').disabled = !inputOn && solo.phase !== 'good';
  $('sSend').disabled = !inputOn;
  $('sWords').innerHTML = solo.history.slice(-40).reverse()
    .map((h) => `<span class="chip ${h.by === 'cpu' ? 'cpu' : h.rare ? 'rare' : ''}">${h.by === 'cpu' ? '🤖' : '🙋'} ${esc(h.w)}</span>`).join('');
}
const usedParam = () => encodeURIComponent([...solo.used].slice(-300).join(','));

function startSolo() {
  newSolo();
  show('solo');
  $('sVeil').classList.remove('on');
  soloHud();
  cpuOpen();
}

// 컴퓨터가 새 시작 단어를 낸다 (처음, 하트를 잃은 뒤, 패스, 한방 뒤)
async function cpuOpen() {
  const gen = ++solo.gen;
  solo.phase = 'cpu';
  $('sWho').textContent = '🤖 컴퓨터가 시작 단어를 고르는 중…';
  soloHud();
  const r = await api(`api/start?used=${usedParam()}`);
  if (gen !== solo.gen) return;
  if (!r) return soloOffline();
  cpuSay(r.word, true);
}

function cpuSay(word, opening = false) {
  solo.prev = word;
  solo.used.add(word);
  solo.history.push({ w: word, by: 'cpu' });
  renderWord($('sTiles'), $('sNext'), word, true);
  $('sWho').textContent = opening ? '🤖 컴퓨터가 새로 시작해요' : '🤖 컴퓨터가 이었어요';
  sfx.word();
  const level = levelOf(solo.mine);
  solo.total = turnSecs(level);
  solo.deadline = performance.now() + solo.total * 1000;
  solo.lastTickSec = -1;
  solo.phase = 'input';
  setMsg($('sMsg'), '');
  $('sInput').value = '';
  soloHud();
  $('sInput').focus();
  cancelAnimationFrame(solo.timerId);
  solo.timerId = requestAnimationFrame(soloTick);
}

function soloTick() {
  if (solo.phase !== 'input') return;
  const remain = (solo.deadline - performance.now()) / 1000;
  const bar = $('sTimer');
  bar.firstElementChild.style.transform = `scaleX(${Math.max(0, remain / solo.total)})`;
  bar.classList.toggle('low', remain < 4);
  const sec = Math.ceil(remain);
  if (remain < 5 && sec !== solo.lastTickSec && remain > 0) { solo.lastTickSec = sec; sfx.tick(); }
  if (remain <= 0) return soloTimeout();
  solo.timerId = requestAnimationFrame(soloTick);
}

wireInput($('sInput'), $('sForm'), async (w) => {
  if (solo.phase !== 'input' || solo.busy) return;
  const bad = (reason) => { setMsg($('sMsg'), rejectText(reason, solo.prev), 'bad'); shake($('sTiles')); sfx.bad(); $('sInput').focus(); };
  const quick = quickCheck(solo.prev, w, solo.used);
  if (quick) return bad(quick);
  solo.busy = true;
  const gen = solo.gen;
  const level = levelOf(solo.mine);
  const r = await api(`api/play?prev=${encodeURIComponent(solo.prev)}&w=${encodeURIComponent(w)}&level=${level}&used=${usedParam()}`);
  solo.busy = false;
  if (gen !== solo.gen || solo.phase !== 'input') return;   // 확인하는 사이 시간이 다 됐다
  if (!r) return bad('offline');
  if (!r.ok) return bad(r.reason);
  // 이었다: 기본 100점 + 긴 말 + 남은 시간 + 흔치 않은 말 보너스, 연속으로 이을수록 배율
  const remain = Math.max(0, (solo.deadline - performance.now()) / 1000);
  const len = [...w].length;
  const gain = Math.round((100 + (len - 2) * 30 + Math.round(remain * 10) + (r.rare ? 50 : 0)) * (1 + Math.min(solo.combo, 10) * 0.1));
  solo.phase = 'good';
  cancelAnimationFrame(solo.timerId);
  solo.combo++; solo.mine++; solo.score += gain;
  solo.used.add(w);
  solo.history.push({ w, by: 'me', rare: r.rare });
  solo.prev = w;
  renderWord($('sTiles'), $('sNext'), w);
  $('sWho').textContent = '🙋 내가 이었어요';
  const lvUp = levelOf(solo.mine) > levelOf(solo.mine - 1);
  setMsg($('sMsg'), `+${gain}${r.rare ? ' ✨ 흔치 않은 말!' : ''}${lvUp ? ' · 레벨 업! 🎉' : ''}`, 'good');
  sfx.ok(solo.combo);
  saveBest(solo.score);
  soloHud();
  if (r.cpu) {
    setTimeout(() => {
      if (gen !== solo.gen || solo.phase !== 'good') return;
      $('sWho').textContent = '🤖 컴퓨터 생각 중…';
      setTimeout(() => { if (gen === solo.gen && solo.phase === 'good') cpuSay(r.cpu); }, 450);
    }, 500);
  } else {
    // 컴퓨터가 이을 말을 못 찾았다: 한방!
    const bonus = 500;
    solo.score += bonus; solo.booms++;
    saveBest(solo.score);
    setTimeout(() => {
      if (gen !== solo.gen) return;
      setMsg($('sMsg'), `💥 한방! 컴퓨터가 이을 말이 없어요 +${bonus}`, 'good');
      $('sWho').textContent = '🤖 …항복!';
      sfx.boom();
      soloHud();
      setTimeout(() => { if (gen === solo.gen) cpuOpen(); }, 1600);
    }, 500);
  }
});

async function soloTimeout() {
  solo.phase = 'fail';
  const gen = ++solo.gen;
  solo.lives--; solo.combo = 0;
  sfx.lose();
  $('sTimer').firstElementChild.style.transform = 'scaleX(0)';
  soloHud();
  const h = await api(`api/hint?prev=${encodeURIComponent(solo.prev)}&used=${usedParam()}`);
  if (gen !== solo.gen) return;
  setMsg($('sMsg'), `시간 초과! 예) ${h && h.examples.length ? h.examples.join(' · ') : '…'}`, 'bad');
  shake($('sTiles'));
  setTimeout(() => { if (gen === solo.gen) (solo.lives <= 0 ? soloOver() : cpuOpen()); }, 2400);
}

$('sPass').onclick = () => {
  if (solo.phase !== 'input' || solo.passes <= 0) return;
  solo.passes--; solo.combo = 0;
  cancelAnimationFrame(solo.timerId);
  sfx.bad();
  setMsg($('sMsg'), '패스! 컴퓨터가 새로 시작해요');
  cpuOpen();
};

function soloOver() {
  solo.phase = 'over';
  saveBest(solo.score);
  const isBest = solo.score > 0 && solo.score >= best;
  const mine = solo.history.filter((h) => h.by === 'me');
  const longest = mine.reduce((a, h) => ([...h.w].length > [...a].length ? h.w : a), '');
  const veil = $('sVeil');
  veil.innerHTML = `
    <h2 class="inked">게임 끝!</h2>
    <div class="code" style="font-size:52px">${solo.score.toLocaleString()}</div>
    <span class="tag">${isBest ? '🏆 최고 기록!' : `최고 기록 ${best.toLocaleString()}`}</span>
    <div class="card" style="text-align:center">이은 단어 ${solo.mine}개 · 레벨 ${levelOf(solo.mine)}${solo.booms ? ` · 💥 한방 ${solo.booms}번` : ''}${longest ? `<br>가장 긴 말 <b>${esc(longest)}</b>` : ''}</div>
    <div class="words">${mine.map((h) => `<span class="chip ${h.rare ? 'rare' : ''}">${esc(h.w)}</span>`).join('')}</div>
    <button id="sAgain">한 번 더</button>
    <button class="alt" id="sHome">처음으로</button>`;
  veil.classList.add('on');
  sfx.win();
  $('sAgain').onclick = startSolo;
  $('sHome').onclick = goHome;
}

function soloOffline() {
  solo.phase = 'offline';
  const veil = $('sVeil');
  veil.innerHTML = `<h2 class="inked">연결 실패</h2><p class="sub">서버에 연결할 수 없어요.<br>잠시 후 다시 해 주세요.</p><button id="sRetry">다시 시도</button><button class="alt" id="sHome2">처음으로</button>`;
  veil.classList.add('on');
  $('sRetry').onclick = () => { veil.classList.remove('on'); cpuOpen(); };
  $('sHome2').onclick = goHome;
}

// 앱을 잠깐 떠나면 시간을 멈춘다 (돌아왔더니 시간 초과가 되지 않게)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && $('solo').classList.contains('on') && solo.phase === 'input') {
    solo.pausedRemain = solo.deadline - performance.now();
    solo.phase = 'paused';
    cancelAnimationFrame(solo.timerId);
    const veil = $('sVeil');
    veil.innerHTML = `<h2 class="inked">일시정지</h2><button id="sResume">계속하기</button>`;
    veil.classList.add('on');
    $('sResume').onclick = () => {
      veil.classList.remove('on');
      solo.deadline = performance.now() + solo.pausedRemain;
      solo.phase = 'input';
      soloHud();
      $('sInput').focus();
      solo.timerId = requestAnimationFrame(soloTick);
    };
  }
});

$('sQuit').onclick = () => { solo.phase = 'idle'; solo.gen++; cancelAnimationFrame(solo.timerId); goHome(); };

// =====================================================================
// 온라인 대결
// =====================================================================
let ws = null, retryTimer = 0;
let room = null, deadlineLocal = 0, lastTurnKey = '', lastWordCount = 0, lastRoundKey = '', tickSec = -1, timerId2 = 0;
let intent = null;        // 연결이 열리면 보낼 첫 요청 { t, ... }
const NAME_KEY = 'wordchainName';

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${location.pathname.replace(/index\.html$/, '')}`;
}
const wsSend = (t, o = {}) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t, ...o })); };

function connect() {
  clearTimeout(retryTimer);
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    wsSend('hello', { name: $('lName').value.trim() || store.get(NAME_KEY) || '' });
    const saved = session.get();
    if (intent) { const i = intent; intent = null; wsSend(i.t, i); }
    else if (saved) wsSend('resume', saved);
    clearInterval(connect.pulse);
    connect.pulse = setInterval(() => wsSend('pulse'), 20000);
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === 'room') applyRoom(m);
    else if (m.t === 'reject') onReject(m);
    else if (m.t === 'error') { setLobbyErr(m.msg); if (!room) show('lobby'); }
    else if (m.t === 'queued') setLobbyErr('상대를 찾는 중… (다른 사람이 빠른 대전을 누르면 바로 시작해요)', true);
    else if (m.t === 'resumeFailed') { session.clear(); room = null; hideVeil(); if ($('room').classList.contains('on')) { show('lobby'); setLobbyErr('방이 없어졌어요. 새로 만들어 주세요.'); } }
  };
  ws.onclose = () => {
    clearInterval(connect.pulse);
    if (session.get() && room) {                    // 방에 있던 중이면 다시 붙어 본다
      showVeil('연결이 끊겼어요', '<p class="sub">다시 연결하는 중…</p>');
      retryTimer = setTimeout(connect, 1500);
    }
  };
}

function setLobbyErr(text, info = false) { const e = $('lErr'); e.textContent = text; e.className = 'msg ' + (info ? 'good' : 'bad'); }

function openLobby(code) {
  show('lobby');
  $('lName').value = store.get(NAME_KEY) || '';
  if (code) $('lCode').value = code;
  setLobbyErr('');
}
function go(req) {
  const n = $('lName').value.trim();
  if (n) store.set(NAME_KEY, n);
  setLobbyErr('');
  if (ws && ws.readyState === 1) { wsSend('hello', { name: n }); wsSend(req.t, req); }
  else { intent = req; connect(); }
}
$('lCreate').onclick = () => go({ t: 'create' });
$('lQuick').onclick = () => go({ t: 'quick' });
$('lJoin').onclick = () => {
  const code = $('lCode').value.trim().toUpperCase();
  if (code.length !== 4) return setLobbyErr('방 코드 4자리를 입력해 주세요.');
  go({ t: 'join', code });
};
$('lCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lJoin').click(); });
$('lBack').onclick = () => { wsSend('leave'); goHome(); };

function showVeil(title, bodyHtml) {
  const v = $('rVeil');
  v.innerHTML = `<h2 class="inked">${title}</h2>${bodyHtml}`;
  v.classList.add('on');
}
const hideVeil = () => $('rVeil').classList.remove('on');

function applyRoom(m) {
  const prev = room;
  room = m;
  session.set({ code: m.code, token: m.token });
  deadlineLocal = performance.now() + m.remain;
  show('room');
  const waiting = m.state === 'waiting';
  $('rWait').style.display = waiting ? 'flex' : 'none';
  $('rPlay').style.display = waiting ? 'none' : 'flex';
  $('rRound').textContent = waiting ? `방 ${m.code}` : `라운드 ${m.roundNo}`;
  waiting ? renderWaiting() : renderPlaying(prev);
  if (m.state === 'playing' || m.state === 'waiting') hideVeil();
}

function playerChip(p, i, extra = '') {
  const hearts = '❤️'.repeat(Math.max(0, room.faultsMax - p.faults)) + '🖤'.repeat(Math.min(room.faultsMax, p.faults));
  const cls = ['pl', i === room.you ? 'me' : '', p.out ? 'out' : '', !p.online ? 'off' : '', extra].filter(Boolean).join(' ');
  return `<div class="${cls}"><b>${esc(p.name)}</b>${i === room.host ? ' 👑' : ''}<small>${p.out ? '탈락' : hearts}${p.online ? '' : ' · 연결 끊김'}</small></div>`;
}

function renderWaiting() {
  $('rCode').textContent = room.code;
  $('rWaitPlayers').innerHTML = room.players.map((p, i) => playerChip(p, i)).join('');
  const isHost = room.you === room.host, enough = room.players.filter((p) => p.online).length >= 2;
  $('rStart').style.display = isHost ? '' : 'none';
  $('rStart').disabled = !enough;
  $('rWaitNote').textContent = isHost
    ? (enough ? '준비됐으면 시작해요!' : '두 명 이상 모이면 시작할 수 있어요')
    : '방장이 시작하길 기다려요';
}

const nameOf = (i) => (room.players[i] ? room.players[i].name : '');

function renderPlaying(prev) {
  const m = room;
  $('rPlayers').innerHTML = m.players.map((p, i) => playerChip(p, i, m.state === 'playing' && i === m.turn ? 'turn' : '')).join('');
  const lastW = m.words[m.words.length - 1];
  renderWord($('rTiles'), $('rNext'), m.word, !lastW);
  $('rWho').textContent = lastW ? `${lastW.by === m.you ? '🙋 내가' : `💬 ${nameOf(lastW.by)}님이`} 이었어요` : '🎲 시작 단어';
  const myTurn = m.state === 'playing' && m.turn === m.you && !m.players[m.you].out;
  const inp = $('rInput');
  inp.disabled = !myTurn;
  $('rSend').disabled = !myTurn;
  inp.placeholder = myTurn ? '이어 갈 말을 입력해요' : '내 차례에 입력해요';
  if (m.state === 'playing') {
    $('rTurn').textContent = myTurn ? '🎤 내 차례! 끝말을 이어요' : `⏳ ${nameOf(m.turn)}님 차례`;
  } else $('rTurn').textContent = '';
  $('rWords').innerHTML = m.words.map((x) => `<span class="chip ${x.dead ? 'dead' : x.rare ? 'rare' : ''}"><span class="by">${esc(nameOf(x.by))}</span>${esc(x.w)}</span>`).join('<span class="arr">→</span>');

  // 소리·포커스: 내 차례가 새로 왔을 때, 다른 사람이 단어를 이었을 때
  const turnKey = `${m.roundNo}:${m.turn}:${m.words.length}:${m.state}`;
  if (turnKey !== lastTurnKey) {
    setMsg($('rMsg'), '');                      // 지난 차례의 '틀렸어요' 안내는 지운다
    if (myTurn) { sfx.turn(); inp.value = ''; inp.focus(); }
    else if (m.state === 'playing' && m.words.length > lastWordCount && lastRoundKey === String(m.roundNo)) sfx.word();
    lastTurnKey = turnKey;
  }
  lastWordCount = m.words.length;
  lastRoundKey = String(m.roundNo);
  tickSec = -1;

  if (m.state === 'roundEnd' && m.lastLoss) {
    const l = m.lastLoss, p = m.players[l.seat];
    const killer = l.reason === 'dead' && lastW ? nameOf(lastW.by) : '';
    l.reason === 'dead' ? sfx.boom() : sfx.lose();
    showVeil(l.reason === 'dead' ? '💥 한방!' : '시간 초과!', `
      <div class="wordbox" style="--tw:${[...l.word].length <= 3 ? 60 : 46}px"><div class="tiles">${[...l.word].map((c, i, a) => `<div class="tile${i === a.length - 1 ? ' end' : ''}">${c}</div>`).join('')}</div></div>
      <p class="sub">${killer ? `<b>${esc(killer)}</b>님의 한방 단어! 이을 말이 없어요<br>` : ''}<b>${esc(p.name)}</b>님 패!<br>${p.out ? '💀 패 3개로 탈락했어요' : `남은 하트 ${'❤️'.repeat(m.faultsMax - p.faults)}`}</p>
      ${l.examples.length ? `<div class="card" style="text-align:center">이런 말로 이을 수 있었어요<br><b>${l.examples.map(esc).join(' · ')}</b></div>` : ''}
      <p class="sub">잠시 뒤 다음 라운드!</p>`);
  } else if (m.state === 'over') {
    const w = m.players[m.winner];
    sfx.win();
    const isHost = m.you === m.host;
    showVeil(w ? '🏆 우승!' : '게임 끝', `
      ${w ? `<div class="code" style="font-size:38px">${esc(w.name)}</div>` : ''}
      <div class="players">${m.players.map((p, i) => playerChip(p, i)).join('')}</div>
      ${isHost ? '<button id="rAgain">한 판 더</button>' : '<p class="sub">방장이 다시 시작하길 기다려요</p>'}
      <button class="alt" id="rExit">나가기</button>`);
    if ($('rAgain')) $('rAgain').onclick = () => wsSend('start');
    $('rExit').onclick = leaveRoom;
  }
  if (!prev || prev.state !== m.state || prev.roundNo !== m.roundNo) requestAnimationFrame(onlineTick);
}

function onlineTick() {
  cancelAnimationFrame(timerId2);
  if (!room || room.state !== 'playing') { $('rTimer').firstElementChild.style.transform = 'scaleX(1)'; return; }
  const remain = (deadlineLocal - performance.now()) / 1000;
  const total = (room.turnMs || 15000) / 1000;
  $('rTimer').firstElementChild.style.transform = `scaleX(${Math.max(0, Math.min(1, remain / total))})`;
  $('rTimer').classList.toggle('low', remain < 3);
  const sec = Math.ceil(remain);
  if (room.turn === room.you && remain < 4 && sec !== tickSec && remain > 0) { tickSec = sec; sfx.tick(); }
  timerId2 = requestAnimationFrame(onlineTick);
}

wireInput($('rInput'), $('rForm'), (w) => {
  if (!room || room.state !== 'playing' || room.turn !== room.you) return;
  const quick = quickCheck(room.word, w, new Set(room.words.map((x) => x.w)));   // 서버까지 안 가도 아는 실수는 바로 알려 준다
  if (quick) { onReject({ reason: quick }); return; }
  wsSend('answer', { w });
});

function onReject(m) {
  setMsg($('rMsg'), rejectText(m.reason, room ? room.word : ''), 'bad');
  shake($('rTiles'));
  sfx.bad();
  $('rInput').focus();
}

function leaveRoom() {
  wsSend('leave');
  session.clear();
  room = null;
  hideVeil();
  openLobby();
}
$('rLeave').onclick = leaveRoom;
$('rStart').onclick = () => wsSend('start');
$('rCopy').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${room.code}`;
  const done = () => { $('rCopy').textContent = '✅ 복사했어요'; setTimeout(() => { $('rCopy').textContent = '🔗 초대 링크 복사'; }, 1500); };
  if (navigator.share && matchMedia('(pointer: coarse)').matches) navigator.share({ title: '끝말잇기 한 판 해요!', url }).catch(() => {});
  else if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('링크를 복사하세요', url));
  else prompt('링크를 복사하세요', url);
};

// =====================================================================
// 처음 화면·시작
// =====================================================================
function goHome() {
  cancelAnimationFrame(solo.timerId);
  cancelAnimationFrame(timerId2);
  show('home');
  refreshHome();
}
$('goSolo').onclick = startSolo;
$('goOnline').onclick = () => openLobby();

refreshHome();
const params = new URLSearchParams(location.search);
if (session.get()) { show('room'); showVeil('다시 연결하는 중…', ''); room = { faultsMax: 3 }; connect(); }
else if (params.get('room')) openLobby(params.get('room').toUpperCase().slice(0, 4));

// 테스트용
window.__wc = { get solo() { return solo; }, get room() { return room; }, startSolo, show };
})();
