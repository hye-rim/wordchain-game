'use strict';

// 끝말잇기 사전. 서버가 한 번 읽어 두고 혼자 하기·온라인 모두 같은 사전으로 판정한다.
const fs = require('fs');
const path = require('path');
const H = require('./public/hangul.js');

const readList = (f) => fs.readFileSync(path.join(__dirname, 'data', f), 'utf8').split('\n').filter(Boolean);
const words = readList('words.txt');          // 정답 판정용 (2~8글자 명사 전체)
const common = readList('common.txt');        // 자주 쓰는 명사: 시작 단어, 컴퓨터가 먼저 고르는 말, 예시
const allSet = new Set(words);
const commonSet = new Set(common);
for (const w of common) allSet.add(w);

// 첫 글자 → 단어 목록
const byFirst = new Map(), commonByFirst = new Map();
const add = (map, w) => { const k = w[0]; if (!map.has(k)) map.set(k, []); map.get(k).push(w); };
for (const w of allSet) add(byFirst, w);
for (const w of common) add(commonByFirst, w);

// 이 글자로 끝나면 이어 갈 수 있는 단어 수 (두음법칙 포함)
const countFrom = (map, ch) => { let n = 0; for (const s of H.starts(ch)) n += (map.get(s) || []).length; return n; };
const contAll = (w) => countFrom(byFirst, H.lastChar(w));
const contCommon = (w) => countFrom(commonByFirst, H.lastChar(w));

const choice = (arr, rng) => arr[Math.floor(rng() * arr.length)];

// 앞 단어에 이어 쓸 수 있는 단어들 (쓴 말은 빼고)
function candidates(prev, used, map) {
  const out = [];
  for (const s of H.starts(prev)) for (const w of map.get(s) || []) if (!used.has(w)) out.push(w);
  return out;
}

// 판정: 모양 → 이어지는지 → 이미 썼는지 → 사전에 있는지. rare 는 '자주 쓰는 말이 아님'(점수 보너스)
function check(prev, word, used = new Set()) {
  const w = String(word || '').trim();
  if (!H.isWordShape(w)) return { ok: false, reason: w.length < 2 ? 'short' : 'shape' };
  if (prev && !H.follows(prev, w)) return { ok: false, reason: 'chain' };
  if (used.has(w)) return { ok: false, reason: 'used' };
  if (!allSet.has(w)) return { ok: false, reason: 'unknown' };
  return { ok: true, rare: !commonSet.has(w), dead: contAll(w) === 0 };
}

// 라운드를 여는 단어: 자주 쓰는 2~3글자, 이어 갈 말이 넉넉한 것
const OPENERS = common.filter((w) => w.length <= 3 && contCommon(w) >= 15);
function opener(rng = Math.random, used = new Set()) {
  const list = OPENERS.filter((w) => !used.has(w));
  return choice(list.length ? list : OPENERS, rng);
}

// 컴퓨터가 고르는 단어. level 이 오를수록 사람이 잇기 어려운 끝 글자를 고른다.
//  - 쉬움(1~2): 자주 쓰는 말 중 이어 갈 말이 많은 것
//  - 보통(3~5): 자주 쓰는 말 아무거나
//  - 어려움(6~): 가끔 이어 갈 말이 적은(1~4개) 끝 글자로 몰아붙인다. 아예 못 잇는 말(한방 단어)은 쓰지 않는다
// 못 고르면 null (사람이 한방으로 이긴 것)
function computerWord(prev, used, level = 1, rng = Math.random) {
  const fair = (w) => contAll(w) > 0;
  let pool = candidates(prev, used, commonByFirst).filter(fair);
  if (!pool.length) {
    // 자주 쓰는 말로 못 이으면 사전 전체에서, 너무 긴 말은 빼고
    pool = candidates(prev, used, byFirst).filter((w) => w.length <= 4 && fair(w));
    return pool.length ? choice(pool, rng) : null;
  }
  if (level <= 2) {
    const easy = pool.filter((w) => contCommon(w) >= 15);
    return choice(easy.length ? easy : pool, rng);
  }
  if (level >= 6 && rng() < Math.min(0.5, 0.15 + (level - 6) * 0.07)) {
    const hard = pool.filter((w) => { const c = contCommon(w); return c >= 1 && c <= 4; });
    if (hard.length) return choice(hard, rng);
  }
  return choice(pool, rng);
}

// 못 이었을 때 보여 줄 예시 (자주 쓰는 말 먼저)
function examples(prev, used = new Set(), k = 3, rng = Math.random) {
  let src = candidates(prev, used, commonByFirst);
  if (src.length < k) src = src.concat(candidates(prev, used, byFirst).filter((w) => w.length <= 4 && !src.includes(w)));
  const copy = src.slice(), out = [];
  while (out.length < k && copy.length) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  return out;
}

const stats = () => ({ words: allSet.size, common: common.length, openers: OPENERS.length });

module.exports = { H, check, opener, computerWord, examples, candidates, contAll, contCommon, stats, has: (w) => allSet.has(w), isCommon: (w) => commonSet.has(w) };
