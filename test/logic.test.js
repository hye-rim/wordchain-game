'use strict';

// 두음법칙·판정·컴퓨터의 말 고르기 테스트. 실행: npm test
const test = require('node:test');
const assert = require('node:assert');
const H = require('../public/hangul.js');
const D = require('../dict.js');

test('dueum rule: rieul/nieun at the start of a word', () => {
  const cases = { '력': '역', '리': '이', '라': '나', '로': '노', '녀': '여', '뉴': '유', '래': '내', '량': '양' };
  for (const [from, to] of Object.entries(cases)) assert.strictEqual(H.dueum(from), to, from);
  for (const c of ['가', '노', '사']) assert.strictEqual(H.dueum(c), null, c);
});

test('follows(): last syllable or its dueum form', () => {
  assert.ok(H.follows('사과', '과일'));
  assert.ok(!H.follows('사과', '사자'));
  assert.ok(H.follows('경력', '역사') && H.follows('경력', '력사'));
});

test('check(): shape, chain, used, unknown, ok', () => {
  assert.strictEqual(D.check('사과', '과').reason, 'short');
  assert.strictEqual(D.check('사과', 'abcd').reason, 'shape');
  assert.strictEqual(D.check('사과', '사자').reason, 'chain');
  assert.strictEqual(D.check('사과', '과일', new Set(['과일'])).reason, 'used');
  assert.strictEqual(D.check('사과', '과뿔뿔').reason, 'unknown');
  const ok = D.check('사과', '과일');
  assert.ok(ok.ok && ok.rare === false);
  assert.ok(D.check('경력', '역사').ok);
});

test('dead-end words are detected', () => {
  const dead = D.check('시기', '기쁨');
  assert.ok(dead.ok && dead.dead, 'a word nothing can follow');
  assert.strictEqual(D.contAll('기쁨'), 0);
});

test('computer never plays a dead-end word and always follows the rule', () => {
  for (const level of [1, 4, 9, 20]) {
    for (let i = 0; i < 60; i++) {
      const used = new Set(); const start = D.opener(Math.random, used); used.add(start);
      const w = D.computerWord(start, used, level);
      if (w === null) continue;
      assert.ok(H.follows(start, w), `${start} -> ${w}`);
      assert.ok(!used.has(w));
      assert.ok(D.contAll(w) > 0, `${w} must be playable for the human`);
    }
  }
});

test('openers are common words with room to continue', () => {
  for (let i = 0; i < 50; i++) { const w = D.opener(); assert.ok(H.isWordShape(w)); assert.ok(D.isCommon(w)); assert.ok(D.contCommon(w) >= 15, w); }
});

test('examples follow the chain and skip used words', () => {
  const used = new Set(['과일', '과자']);
  const ex = D.examples('사과', used, 3);
  assert.strictEqual(ex.length, 3);
  for (const w of ex) { assert.ok(H.follows('사과', w)); assert.ok(!used.has(w)); }
});
