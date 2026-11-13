// ¥0 の確かめ: 略称の定義（以下「X」という）は直前の法令名だけで決める（別の法令名を取らない）
// 2026-10-18: 「労働契約法や障害者の…法律（以下「障害者総合支援法」という）」で、労働契約法に付いていた
'use strict';
const assert = require('assert');
const P = require('./03_parse.cjs');
const lex = P.buildLexicon();
const txt = '本件解雇が労働契約法や障害者の日常生活及び社会生活を総合的に支援するための法律（以下「障害者総合支援法」という。）に違反する。障害者総合支援法42条1項の規定に鑑みれば、労働契約法16条も問題となる。';
const r = P.extractCitations(txt, lex, null);
const laws = [...r.refs.values()].map((x) => `${x.law}${x.art}`);
assert.ok(!laws.includes('労働契約法42'), '労働契約法42条に付いてはいけない');
assert.ok(laws.includes('労働契約法16'), '労働契約法16条は残す');
console.log('check_teigi: OK');
