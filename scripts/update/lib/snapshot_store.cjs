// 取得の写し（前回のスナップショット・台帳・manifest）を R2 に置く・戻す。週次の取り直しの基準。
//   通達（scripts/tsutatsu/weekly/run.cjs）・質疑応答事例と裁決（scripts/cases/weekly/run.cjs）で共用。
//
//   {prefix}/current.json                     今の基準（run_id・世代・日付・part の一覧と sha256）
//   {prefix}/snapshots/{run_id}-{時刻}/part-NNN  作業フォルダの一部を tar.gz にして partBytes ごとに分けたもの
//
// 戻すときは各 part の大きさと sha256 を照らし、合わなければ落ちる（取り直しに進まない）。2 世代残す（前回の分は戻し用）。
// 置き場は毎回別（run_id を使い回しても今と前回の part を上書きしない）。current.json は part を置けたと確かめてから最後に書く。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} が失敗（exit ${r.status}）`);
}

// r2: scripts/update/lib/r2.cjs の R2。workRoot: 写しを展開する・固める根（その中の相対パスで持つ）。tmpRoot: 作業用の一時フォルダの置き場
function makeSnapshotStore({ r2, prefix, workRoot, tmpRoot, partBytes = 100 * 1024 * 1024, log = console.log }) {
  const CURRENT_KEY = `${prefix}/current.json`;

  async function restore() {
    const cur = await r2.getJson(CURRENT_KEY);
    if (!cur) { log(`前回の写しが R2 に無い（${prefix}・初回）。全件を取り直す`); return null; }
    log(`前回の写し: ${cur.stamp}（run ${cur.run_id}・${cur.parts.length} 個・${(cur.total_bytes / 1048576).toFixed(0)} MB）を戻す`);
    const tmp = path.join(tmpRoot, 'restore');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const files = [];
    for (const p of cur.parts) {
      const buf = await r2.get(p.key);
      if (!buf) throw new Error(`前回の写しの一部が R2 に無い: ${p.key}`);
      if (buf.length !== p.bytes || sha256(buf) !== p.sha256) throw new Error(`前回の写しの一部が壊れている: ${p.key}`);
      const f = path.join(tmp, path.basename(p.key));
      fs.writeFileSync(f, buf);
      files.push(f);
    }
    fs.mkdirSync(workRoot, { recursive: true });
    // 分割した tar.gz をつないで展開
    sh('bash', ['-c', 'set -o pipefail; cat "$@" | tar -xzf - -C "$ROOT"', 'restore', ...files], { env: { ...process.env, ROOT: workRoot } });
    fs.rmSync(tmp, { recursive: true, force: true });
    return cur;
  }

  // rel: workRoot からの相対パス（無いものは飛ばす）。counts: 報告用の件数
  async function save({ stamp, rid, prevCur, counts, rel }) {
    const gen = `${rid}-${Date.now().toString(36)}`;
    if ((await r2.list(`${prefix}/snapshots/${gen}/`)).length) throw new Error(`写しの置き場が既に使われている: ${prefix}/snapshots/${gen}/`);
    const tmp = path.join(tmpRoot, 'save');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const have = rel.filter((p) => fs.existsSync(path.join(workRoot, p)));
    sh('bash', ['-c', 'set -o pipefail; tar -czf - -C "$ROOT" "$@" | split -b "$PART" -d -a 3 - "$DEST/part-"', 'save', ...have],
      { env: { ...process.env, ROOT: workRoot, PART: String(partBytes), DEST: tmp } });
    const names = fs.readdirSync(tmp).filter((n) => n.startsWith('part-')).sort();
    const parts = [];
    for (const n of names) {
      const buf = fs.readFileSync(path.join(tmp, n));
      const key = `${prefix}/snapshots/${gen}/${n}`;
      await r2.put(key, buf, 'application/octet-stream');
      parts.push({ key, bytes: buf.length, sha256: sha256(buf) });
    }
    // 置けたかを一覧の大きさで確かめてから、基準を切り替える（current.json は最後に書く）
    const listed = new Map((await r2.list(`${prefix}/snapshots/${gen}/`)).map((o) => [o.key, o.size]));
    for (const p of parts) if (listed.get(p.key) !== p.bytes) throw new Error(`R2 に置いた写しの大きさが合わない: ${p.key}`);
    const cur = {
      run_id: rid, gen, stamp, created_at: new Date().toISOString(), parts,
      total_bytes: parts.reduce((s, p) => s + p.bytes, 0), counts,
      previous: prevCur ? { run_id: prevCur.run_id, gen: prevCur.gen || null, stamp: prevCur.stamp, parts: prevCur.parts } : null,
    };
    await r2.put(CURRENT_KEY, JSON.stringify(cur, null, 2));
    // 2 世代前の写しを消す（前回の分は戻し用に残す）。今と前回の part と重なるものは消さない
    const keep = new Set([...parts, ...((prevCur && prevCur.parts) || [])].map((p) => p.key));
    const old = prevCur && prevCur.previous;
    if (old && old.parts) for (const p of old.parts) if (!keep.has(p.key)) await r2.delete(p.key);
    fs.rmSync(tmp, { recursive: true, force: true });
    log(`今回の写しを基準にした（${prefix}）: ${parts.length} 個・${(cur.total_bytes / 1048576).toFixed(0)} MB`);
    return cur;
  }

  return { restore, save, CURRENT_KEY };
}

module.exports = { makeSnapshotStore };
