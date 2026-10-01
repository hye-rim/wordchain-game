'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const D = require('./dict.js');

// ---------- Config ----------
const PORT = process.env.PORT || 3006;
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const FAULTS_MAX = 3;            // 패 3개면 탈락
// 시간 값. WORDCHAIN_FAST=1 이면 테스트가 빨리 돌도록 30배 줄인다
const FAST = !!process.env.WORDCHAIN_FAST;
const T = (ms) => (FAST ? Math.max(120, Math.round(ms / 30)) : ms);
const TURN_MAX_MS = T(15000);    // 한 사람이 단어를 이을 수 있는 시간. 한 라운드에서 단어가 쌓일수록 줄어든다
const TURN_MIN_MS = T(7000);
const TURN_STEP_MS = FAST ? 10 : 500;
const ROUND_PAUSE_MS = T(3800);  // 패가 난 뒤 다음 라운드까지 (이을 수 있었던 예시 단어를 보여 주는 시간)
const GRACE_MS = T(30000);       // 게임 중 연결이 끊겨도 이 시간 안에 돌아오면 이어서 한다
const WAIT_GRACE_MS = T(180000); // 대기실에서는 더 길게: 초대 링크를 보내러 메신저에 다녀오는 동안 방이 사라지면 안 된다
const HEARTBEAT_MS = 25000;
const SILENCE_TIMEOUT_MS = 90000;
// 헷갈리는 글자(0/O, 1/I)는 빼서 코드를 불러주기 쉽게 한다.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- Static + JSON API ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// 컴퓨터와 이어가기용: 시작 단어 · 판정과 컴퓨터의 대답 · 힌트. 사전은 서버에만 있고 폰은 내려받지 않는다.
// 지금까지 나온 말(used)은 폰이 들고 있다가 매번 보낸다 (서버는 판마다 상태를 들고 있지 않는다)
const usedOf = (q) => new Set(String(q.get('used') || '').split(',').filter((w) => D.H.isWordShape(w)).slice(-400));
const wordOf = (q, k) => String(q.get(k) || '').trim().slice(0, 8);
const api = {
  start(q) { return { word: D.opener(Math.random, usedOf(q)) }; },
  play(q) {
    const prev = wordOf(q, 'prev'), w = wordOf(q, 'w'), used = usedOf(q);
    const level = Math.max(1, Math.min(99, Number(q.get('level')) || 1));
    if (!D.H.isWordShape(prev)) return { ok: false, reason: 'shape' };
    const res = D.check(prev, w, used);
    if (!res.ok) return res;
    used.add(w);
    return { ...res, cpu: D.computerWord(w, used, level) };    // cpu 가 null 이면 컴퓨터가 못 이음 (한방!)
  },
  hint(q) {
    const prev = wordOf(q, 'prev');
    return { examples: D.H.isWordShape(prev) ? D.examples(prev, usedOf(q), 3) : [] };
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : null;
  if (name) {
    if (!Object.prototype.hasOwnProperty.call(api, name)) return json(res, { error: 'not found' }, 404);
    return json(res, api[name](url.searchParams));
  }
  let reqPath = decodeURIComponent(url.pathname);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// ---------- State ----------
const rooms = new Map();     // code -> room
const clients = new Map();   // ws -> client
let queue = null;            // 빠른 대전을 기다리는 client 하나
let nextId = 1;

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ t: type, ...payload }));
}

function makeCode() {
  for (let k = 0; k < 50; k++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}
const makeToken = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function sanitizeName(raw) {
  const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 8);
  return name || `손님${Math.floor(100 + Math.random() * 900)}`;
}

// ---------- Rooms ----------
function createRoom(isPrivate) {
  const room = {
    code: makeCode(),
    isPrivate,
    seats: [],               // { client, name, token, online, faults, out, graceTimer }
    host: 0,
    state: 'waiting',        // waiting | playing | roundEnd | over
    roundNo: 0,
    word: '',                // 지금 이어야 하는 단어 (라운드 첫 단어는 서버가 정한다)
    words: [],               // 이번 라운드에 이어진 단어 { w, by, rare }
    used: new Set(),         // 이번 게임에 나온 말 (라운드가 바뀌어도 다시 못 쓴다)
    turn: 0,
    deadline: 0,
    turnTimer: null,
    pauseTimer: null,
    lastLoss: null,          // { seat, examples, reason, word }
    winner: -1,
  };
  rooms.set(room.code, room);
  return room;
}

const seatOf = (room, client) => room.seats.findIndex((s) => s.client === client);
const alive = (room) => room.seats.map((s, i) => (!s.out ? i : -1)).filter((i) => i >= 0);

function nextAlive(room, from) {
  const n = room.seats.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (!room.seats[i].out) return i;
  }
  return from;
}

function snapshot(room, idx) {
  const seat = room.seats[idx];
  return {
    code: room.code,
    isPrivate: room.isPrivate,
    token: seat.token,
    you: idx,
    host: room.host,
    state: room.state,
    roundNo: room.roundNo,
    word: room.word,
    turnMs: room.turnMs,
    turn: room.turn,
    remain: room.state === 'playing' ? Math.max(0, room.deadline - Date.now()) : 0,
    faultsMax: FAULTS_MAX,
    players: room.seats.map((s) => ({ name: s.name, online: s.online, faults: s.faults, out: s.out })),
    words: room.words,
    lastLoss: room.lastLoss,
    winner: room.winner,
  };
}

function pushRoom(room) {
  room.seats.forEach((s, i) => { if (s.online && s.client) send(s.client.ws, 'room', snapshot(room, i)); });
}

function sitDown(room, client) {
  room.seats.push({ client, name: client.name, token: makeToken(), online: true, faults: 0, out: false, graceTimer: null });
  client.roomCode = room.code;
  if (!room.isPrivate && room.seats.length >= MIN_PLAYERS) startGame(room);   // 빠른 대전은 두 명이 모이면 바로 시작
  else pushRoom(room);
}

function startGame(room) {
  clearTimeout(room.pauseTimer);
  room.seats.forEach((s) => { s.faults = 0; s.out = false; });
  room.roundNo = 0;
  room.winner = -1;
  room.lastLoss = null;
  room.used = new Set();
  startRound(room, 0);
}

function startRound(room, starter) {
  clearTimeout(room.pauseTimer);
  room.roundNo++;
  room.word = D.opener(Math.random, room.used);      // 라운드를 여는 단어
  room.used.add(room.word);
  room.words = [];
  room.state = 'playing';
  room.turn = room.seats[starter] && !room.seats[starter].out ? starter : nextAlive(room, starter);
  armTurn(room);
  pushRoom(room);
}

function armTurn(room) {
  clearTimeout(room.turnTimer);
  const ms = Math.max(TURN_MIN_MS, TURN_MAX_MS - TURN_STEP_MS * room.words.length);
  room.deadline = Date.now() + ms;
  room.turnMs = ms;
  room.turnTimer = setTimeout(() => loseRound(room, room.turn, 'timeout'), ms);
}

// 시간 안에 못 이은 사람이 패 하나를 받고, 그 라운드는 끝난다. 패가 3개가 되면 탈락
// reason: timeout(시간 초과) | dead(앞 사람이 한방 단어를 써서 이을 말이 없음)
function loseRound(room, idx, reason) {
  if (room.state !== 'playing') return;
  clearTimeout(room.turnTimer);
  const seat = room.seats[idx];
  seat.faults++;
  if (seat.faults >= FAULTS_MAX) seat.out = true;
  room.lastLoss = { seat: idx, reason, examples: reason === 'dead' ? [] : D.examples(room.word, room.used, 3), word: room.word };
  const left = alive(room);
  if (left.length <= 1) {
    room.state = 'over';
    room.winner = left.length ? left[0] : -1;
    pushRoom(room);
    return;
  }
  room.state = 'roundEnd';
  pushRoom(room);
  room.pauseTimer = setTimeout(() => { if (rooms.get(room.code) === room) startRound(room, nextAlive(room, idx)); }, ROUND_PAUSE_MS);
}

function closeRoom(room) {
  clearTimeout(room.turnTimer);
  clearTimeout(room.pauseTimer);
  for (const s of room.seats) { clearTimeout(s.graceTimer); if (s.client) s.client.roomCode = null; }
  rooms.delete(room.code);
}

// 자리에서 완전히 일어난다 (나가기, 또는 끊긴 뒤 돌아오지 않음)
function vacate(room, idx) {
  const seat = room.seats[idx];
  if (!seat) return;
  clearTimeout(seat.graceTimer);
  if (seat.client) seat.client.roomCode = null;
  if (room.state === 'waiting' || room.state === 'over') {
    room.seats.splice(idx, 1);
    if (!room.seats.length || !room.seats.some((s) => s.online)) { closeRoom(room); return; }
    if (room.host >= room.seats.length || room.host === idx) room.host = Math.max(0, room.seats.findIndex((s) => s.online));
    else if (idx < room.host) room.host--;
    if (room.state === 'over') room.winner = room.winner === idx ? -1 : (room.winner > idx ? room.winner - 1 : room.winner);
    pushRoom(room);
    return;
  }
  // 게임 중에 나가면 그 자리는 탈락 처리(자리는 남겨 순서와 기록이 어긋나지 않게)
  seat.out = true; seat.online = false; seat.client = null;
  if (!room.seats.some((s) => s.online)) { closeRoom(room); return; }
  if (room.host === idx) room.host = room.seats.findIndex((s) => s.online);
  const left = alive(room);
  if (left.length <= 1) {
    clearTimeout(room.turnTimer); clearTimeout(room.pauseTimer);
    room.state = 'over'; room.winner = left.length ? left[0] : -1; room.lastLoss = null;
  } else if (room.state === 'playing' && room.turn === idx) {
    room.turn = nextAlive(room, idx);      // 내 차례에 나갔으면 벌칙 없이 다음 사람으로
    armTurn(room);
  }
  pushRoom(room);
}

const dropFromQueue = (client) => { if (queue === client) queue = null; };

// ---------- Handlers ----------
const handlers = {
  hello(client, msg) { client.name = sanitizeName(msg.name); },

  quick(client) {
    if (client.roomCode) return;
    if (queue && queue !== client && queue.ws.readyState === queue.ws.OPEN) {
      const other = queue;
      queue = null;
      const room = createRoom(false);
      sitDown(room, other);
      sitDown(room, client);
    } else {
      queue = client;
      send(client.ws, 'queued');
    }
  },

  create(client) {
    if (client.roomCode) return;
    dropFromQueue(client);
    sitDown(createRoom(true), client);
  },

  join(client, msg) {
    if (client.roomCode) return;
    dropFromQueue(client);
    const room = rooms.get(String(msg.code || '').trim().toUpperCase());
    if (!room) return send(client.ws, 'error', { msg: '그런 방이 없어요. 코드를 확인해 주세요.' });
    if (room.state !== 'waiting') return send(client.ws, 'error', { msg: '이미 게임이 시작된 방이에요.' });
    if (room.seats.length >= MAX_PLAYERS) return send(client.ws, 'error', { msg: `방이 가득 찼어요 (최대 ${MAX_PLAYERS}명).` });
    sitDown(room, client);
  },

  // 새로고침·네트워크 끊김 뒤 같은 자리로 돌아온다
  resume(client, msg) {
    const room = rooms.get(String(msg.code || ''));
    const idx = room ? room.seats.findIndex((s) => s.token === msg.token) : -1;
    if (idx < 0) return send(client.ws, 'resumeFailed');
    const seat = room.seats[idx];
    if (seat.client && seat.client !== client && seat.client.ws.readyState === seat.client.ws.OPEN) {
      seat.client.roomCode = null;
      send(seat.client.ws, 'error', { msg: '다른 창에서 이 방에 다시 들어왔어요.' });
    }
    clearTimeout(seat.graceTimer);
    seat.client = client;
    seat.online = true;
    client.name = seat.name;
    client.roomCode = room.code;
    pushRoom(room);
  },

  start(client) {
    const room = rooms.get(client.roomCode);
    const idx = room ? seatOf(room, client) : -1;
    if (idx < 0 || idx !== room.host) return;
    if (room.state === 'waiting' || room.state === 'over') {
      if (room.seats.filter((s) => s.online).length < MIN_PLAYERS) return send(client.ws, 'error', { msg: '두 명 이상 모여야 시작할 수 있어요.' });
      // 연결이 끊긴 사람·나간 사람은 빼고 남은 사람들로 시작 (방장 자리는 그대로 따라간다)
      const hostSeat = room.seats[room.host];
      for (const s of room.seats) if (!s.online) clearTimeout(s.graceTimer);
      room.seats = room.seats.filter((s) => s.online);
      room.host = Math.max(0, room.seats.indexOf(hostSeat));
      startGame(room);
    }
  },

  answer(client, msg) {
    const room = rooms.get(client.roomCode);
    const idx = room ? seatOf(room, client) : -1;
    if (idx < 0 || room.state !== 'playing' || room.turn !== idx || room.seats[idx].out) return;
    const w = String(msg.w || '').trim().slice(0, 8);
    if (!w) return;
    const res = D.check(room.word, w, room.used);
    if (!res.ok) return send(client.ws, 'reject', { reason: res.reason, w });
    room.used.add(w);
    room.word = w;
    room.words.push({ w, by: idx, rare: res.rare, dead: res.dead });
    room.turn = nextAlive(room, idx);
    // 한방 단어: 사전에 이을 말이 아예 없으니 다음 사람은 기다릴 것 없이 바로 패
    if (res.dead) { pushRoom(room); loseRound(room, room.turn, 'dead'); return; }
    armTurn(room);
    pushRoom(room);
  },

  leave(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const idx = room ? seatOf(room, client) : -1;
    if (idx >= 0) vacate(room, idx);
  },

  pulse() {},
};

// ---------- Connections ----------
function onDisconnect(client) {
  dropFromQueue(client);
  const room = rooms.get(client.roomCode);
  const idx = room ? seatOf(room, client) : -1;
  if (idx < 0) return;
  // 잠깐 기다려 준다. 게임 중이면 그동안 차례가 오면 시간이 지나 패가 된다
  const seat = room.seats[idx];
  seat.online = false;
  seat.client = null;
  clearTimeout(seat.graceTimer);
  seat.graceTimer = setTimeout(() => {
    const i = room.seats.indexOf(seat);          // 그사이 다른 자리가 빠졌을 수 있으니 번호를 다시 찾는다
    if (i >= 0 && rooms.get(room.code) === room) vacate(room, i);
  }, room.state === 'waiting' ? WAIT_GRACE_MS : GRACE_MS);
  pushRoom(room);
}

const heartbeat = setInterval(() => { for (const ws of wss.clients) ws.ping(); }, HEARTBEAT_MS);
const silenceSweep = setInterval(() => {
  const now = Date.now();
  for (const [ws, client] of clients) if (now - client.lastSeen > SILENCE_TIMEOUT_MS) ws.terminate();
}, 5000);
wss.on('close', () => { clearInterval(heartbeat); clearInterval(silenceSweep); });

wss.on('connection', (ws) => {
  const client = { id: nextId++, ws, name: sanitizeName(''), roomCode: null, lastSeen: Date.now() };
  clients.set(ws, client);
  ws.on('message', (raw) => {
    client.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const handler = msg && Object.prototype.hasOwnProperty.call(handlers, msg.t) ? handlers[msg.t] : null;
    if (handler) handler(client, msg);
  });
  ws.on('close', () => { onDisconnect(client); clients.delete(ws); });
});

server.listen(PORT, () => {
  console.log(`끝말잇기 서버 실행 중 → http://localhost:${PORT}  (사전 ${D.stats().words.toLocaleString()}개)`);
});
