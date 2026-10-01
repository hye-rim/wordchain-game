'use strict';

// 끝말잇기용 한글 도우미. 브라우저와 서버(Node)가 같이 쓴다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Hangul = factory();
})(this, function () {
  const BASE = 0xac00;
  const isSyllable = (ch) => { const c = ch.charCodeAt(0); return c >= BASE && c <= 0xd7a3; };
  const isWordShape = (w) => /^[가-힣]{2,8}$/.test(w || '');

  // 음절 → [초성, 중성, 종성] 번호
  const split = (ch) => { const c = ch.charCodeAt(0) - BASE; return [Math.floor(c / 588), Math.floor((c % 588) / 28), c % 28]; };
  const join = (cho, jung, jong) => String.fromCharCode(BASE + cho * 588 + jung * 28 + jong);

  const CHO_N = 2, CHO_R = 5, CHO_O = 11;            // ㄴ ㄹ ㅇ
  const Y_VOWELS = new Set([2, 6, 7, 12, 17, 20]);   // ㅑ ㅕ ㅖ ㅛ ㅠ ㅣ
  const R_TO_N = new Set([0, 1, 8, 11, 13, 18]);     // ㅏ ㅐ ㅗ ㅚ ㅜ ㅡ

  // 두음법칙: 낱말 첫머리에서 바뀌는 소리. 력→역, 리→이, 라→나, 로→노, 녀→여, 뉴→유. 해당 없으면 null
  function dueum(ch) {
    if (!ch || !isSyllable(ch)) return null;
    const [cho, jung, jong] = split(ch);
    if (cho === CHO_R && Y_VOWELS.has(jung)) return join(CHO_O, jung, jong);
    if (cho === CHO_R && R_TO_N.has(jung)) return join(CHO_N, jung, jong);
    if (cho === CHO_N && Y_VOWELS.has(jung)) return join(CHO_O, jung, jong);
    return null;
  }

  const lastChar = (w) => (w ? w[w.length - 1] : '');
  // 앞 단어 다음에 올 수 있는 첫 글자들 (끝 글자, 두음법칙을 적용한 글자)
  function starts(prev) {
    const l = lastChar(prev);
    const d = dueum(l);
    return d ? [l, d] : [l];
  }
  const follows = (prev, word) => !!word && starts(prev).includes(word[0]);

  return { isSyllable, isWordShape, dueum, lastChar, starts, follows };
});
