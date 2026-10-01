'use strict';

// 서버 보안·안정성 회귀 테스트: 잘못된 주소, 숨김 파일, 큰 웹소켓 메시지, 방 코드 무차별 대입
// 실행: npm test  (Node 18 이상, 별도 설치 없이 node:test 사용)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');

const PORT = 5600 + Math.floor(Math.random() * 300);

const get = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 서버를 모듈 맨 위에서 띄우고, 모든 테스트가 준비될 때까지 기다린다 (Node 18 과 22 모두에서 같게 동작하도록 before 훅을 쓰지 않는다)
const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
child.unref();                                  // 서버가 테스트 프로세스의 종료를 붙잡지 않게
process.on('exit', () => child.kill());
const ready = (async () => {
  for (let i = 0; i < 80; i++) { try { await get('/'); return; } catch { await sleep(100); } }
  throw new Error('server did not start');
})();

test('malformed URLs get 400 and the server stays up', async () => {
  await ready;
  assert.strictEqual(await get('/%'), 400);
  assert.strictEqual(await get('/%00'), 400);
  assert.strictEqual(await get('/%E0%A4%A'), 400);
  assert.strictEqual(await get('/'), 200);          // 여전히 살아 있다
});

test('dotfiles and paths outside the public dir are not served', async () => {
  await ready;
  assert.strictEqual(await get('/.git/config'), 403);
  assert.strictEqual(await get('/.hidden'), 403);
  assert.ok([403, 404].includes(await get('/../server.js')));
});

const open = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const c = { ws, msgs: [], closed: null };
  ws.on('message', (d) => { try { c.msgs.push(JSON.parse(d)); } catch {} });
  ws.on('close', (code) => { c.closed = code; });
  ws.on('error', () => {});
  ws.on('open', () => resolve(c));
  setTimeout(() => reject(new Error('websocket connect failed')), 3000);
});

test('oversized websocket message closes the connection (1009)', async () => {
  await ready;
  const c = await open();
  c.ws.send('x'.repeat(2 * 1024 * 1024));
  await sleep(500);
  assert.strictEqual(c.closed, 1009);
  assert.strictEqual(await get('/'), 200);          // 한 손님의 오류로 서버가 죽으면 안 된다
});

test('repeated wrong room codes get temporarily blocked', async () => {
  await ready;
  const c = await open();
  for (let i = 0; i < 10; i++) { c.ws.send(JSON.stringify({ t: 'join', code: 'ZZZ' + 'ABCDEFGH'[i] })); }
  await sleep(500);
  const texts = c.msgs.filter((m) => m.t === 'error').map((m) => m.msg);
  assert.ok(texts.some((x) => /그런 방이 없어요/.test(x)), 'first attempts are answered with room-not-found');
  assert.ok(texts.some((x) => /너무 많이 틀렸어요/.test(x)), 'many wrong codes get blocked (' + texts.length + ' replies)');
  c.ws.close();
});

test('shutdown', () => { child.kill(); });
