// lib/vectors.cjs の ID 生成が Python 版（scripts/rebuild/lib/ids.py）と一致するか検査する。¥0。
//   node scripts/update/check_vector_ids.cjs
// Python 側で同じ入力の ID を出させ、1 件でも違えば失敗にする。
const { execFileSync } = require('child_process');
const path = require('path');
const { IdAllocator, makeVectorId } = require('./lib/vectors.cjs');

const cases = [
  ['129AC0000000089', '第三条', '1', ''],
  ['129AC0000000089', '第三条', '1', '（基本原則）'],
  ['129AC0000000089', '附則 第三条', '1', '（経過措置）'],
  ['123AC0000000456', '第千四百五十六条の二十三第二項第三号', '1', ''],
  ['332AC0000000026', '第七十条の六の二', '12', '（山林についての相続税の納税猶予及び免除）'],
  ['417AC0000000086', '別表第一', '1', ''],
  ['325AC1000000197', '第二条', '1', '（司法書士試験の筆記試験の免除に関する経過措置）'],
  ['325AC1000000197', '第二条', '1', ''],
  ['325AC1000000197', '第二条', '1', ''],   // 衝突 → _2
  ['325AC1000000197', '第二条', '1', ''],   // 衝突 → _3
  ['999XX0000000001', '第一条　全角空白　を含む', '1', ''],
];

const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'rebuild'))})
from lib.ids import IdAllocator
cases = json.loads(sys.stdin.read())
alloc = IdAllocator()
print(json.dumps([alloc.allocate(*c) for c in cases]))
`;
const pyOut = JSON.parse(execFileSync('python3', ['-c', py], { input: JSON.stringify(cases), encoding: 'utf8' }));

const alloc = new IdAllocator();
const jsOut = cases.map((c) => alloc.allocate(...c));
let bad = 0;
cases.forEach((c, i) => {
  const ok = jsOut[i] === pyOut[i];
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c[1]} cap=${c[3] || '-'}  js=${jsOut[i]}${ok ? '' : `  py=${pyOut[i]}`}`);
});
console.log(bad ? `\n${bad} 件不一致` : '\nすべて一致');
process.exit(bad ? 1 : 0);
