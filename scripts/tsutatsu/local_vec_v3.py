# -*- coding: utf-8 -*-
"""
通達コーパス v3 用のベクトル更新を、ユーザーPC（ローカルGPU・bge-m3）で行うためのランナー。

入力（子セッションが生成・gzip でブランチに同梱）:
  docs/benchmarks/tax_ab/data/vec_input_v3.ndjson.gz         新規に埋め込む 926本 {id, namespace, text, metadata}
  docs/benchmarks/tax_ab/data/vec_homes_update_v3.ndjson.gz  homes だけ差し替える 1,825本 {id, namespace, metadata}
  docs/benchmarks/tax_ab/data/vec_compat_check_v3.ndjson.gz  既存20本と同じ text（互換性チェック用）

text / id / metadata は 11_embed_giants.cjs・16_embed_reverse.cjs と同一仕様で作られているので、
このスクリプトは中身を一切加工せず、埋め込みと Vectorize への出し入れだけを行う。

順序（各段の前後で probe を叩いて本数を控える）:
  0) compat      既存20本の cosine を測る。0.99 未満なら --fp32 で再試行
  1) backup      homes 差し替え対象 1,825本の現状 (values+metadata) を退避
  2) embed       926本を埋め込み → vectors ndjson
  3) upsert --ns 340AC0000000034:22   カナリア（法人税法22条 82本）→ probe で 82本を確認
  4) delete --ns 340AC0000000034:22   ロールバック実証 → probe で元の本数に戻ることを確認
  5) upsert --exclude-ns _reverse     巨大条文ぶん（(a)(b) 301本）
  6) （R2 v3 書き込み・Worker 参照切替のあと）upsert --ns _reverse / homes-apply → upsert

環境変数:
  CLOUDFLARE_API_TOKEN  必須（Vectorize の読み書き）。値は表示しない
  CF_ACCOUNT_ID         省略時は 22_vec_backup.cjs と同じ既定値
  JOUBUN_BYPASS_KEY     probe 用（/api/tsutatsu の x-api-key）

使い方:
  python scripts/tsutatsu/local_vec_v3.py compat --in docs/benchmarks/tax_ab/data/vec_compat_check_v3.ndjson.gz
  python scripts/tsutatsu/local_vec_v3.py backup --in docs/benchmarks/tax_ab/data/vec_homes_update_v3.ndjson.gz --out scripts/tsutatsu/state/vec_backup_reverse_homes.ndjson
  python scripts/tsutatsu/local_vec_v3.py embed  --in docs/benchmarks/tax_ab/data/vec_input_v3.ndjson.gz --out scripts/tsutatsu/state/vec_v3_vectors.ndjson
  python scripts/tsutatsu/local_vec_v3.py upsert --in scripts/tsutatsu/state/vec_v3_vectors.ndjson --ns 340AC0000000034:22
  python scripts/tsutatsu/local_vec_v3.py probe  --worker <bench の Worker の URL>
  python scripts/tsutatsu/local_vec_v3.py delete --in scripts/tsutatsu/state/vec_v3_vectors.ndjson --ns 340AC0000000034:22
  python scripts/tsutatsu/local_vec_v3.py upsert --in scripts/tsutatsu/state/vec_v3_vectors.ndjson --exclude-ns _reverse
  python scripts/tsutatsu/local_vec_v3.py homes-apply --update docs/benchmarks/tax_ab/data/vec_homes_update_v3.ndjson.gz --backup scripts/tsutatsu/state/vec_backup_reverse_homes.ndjson --out scripts/tsutatsu/state/vec_homes_v3_vectors.ndjson
  python scripts/tsutatsu/local_vec_v3.py check  --in scripts/tsutatsu/state/vec_v3_vectors.ndjson
  python scripts/tsutatsu/local_vec_v3.py show   --in scripts/tsutatsu/state/canary_vec.ndjson   # id/namespace/homes を実物から表示

どのコマンドも --dry を付けると Vectorize に書かず件数だけ出す（upsert / delete）。
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

ACCT = os.environ.get('CF_ACCOUNT_ID', site_config.CF_ACCOUNT_ID)
INDEX = 'tsutatsu-embeddings-v1'
VEC = f'https://api.cloudflare.com/client/v4/accounts/{ACCT}/vectorize/v2/indexes/{INDEX}'
MODEL = 'BAAI/bge-m3'
API_BATCH = 200  # upsert の1リクエストあたり件数（2026-09-24 に 200 で通ることを確認）
DELETE_BATCH = 100  # delete_by_ids は1リクエスト100件まで（2026-09-24 に 200 で 400 エラー: max id count is 100）


# ---------------------------------------------------------------- I/O
def read_ndjson(path: str):
    p = Path(path)
    opener = gzip.open if p.suffix == '.gz' else open
    with opener(p, 'rt', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def write_ndjson(path: str, rows):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with p.open('w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
            n += 1
    return n


def select_ns(rows, ns: str | None, exclude_ns: str | None):
    for r in rows:
        if ns and r.get('namespace') != ns:
            continue
        if exclude_ns and r.get('namespace') == exclude_ns:
            continue
        yield r


# ---------------------------------------------------------------- Cloudflare REST
def _token():
    t = os.environ.get('CLOUDFLARE_API_TOKEN')
    if not t:
        sys.exit('CLOUDFLARE_API_TOKEN（環境変数）が未設定です。PC のユーザー環境変数に設定してください（値は表示しないこと）')
    return t


def cf_request(url: str, body: bytes, content_type: str):
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'Authorization': f'Bearer {_token()}',
        'Content-Type': content_type,
    })
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                j = json.loads(res.read().decode('utf-8'))
            if not j.get('success', False):
                raise RuntimeError(f'API error: {json.dumps(j.get("errors"))[:300]}')
            return j.get('result')
        except urllib.error.HTTPError as e:
            txt = e.read().decode('utf-8', 'replace')[:300]
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f'HTTP {e.code}: {txt}')
    raise RuntimeError('unreachable')


def get_by_ids(ids: list[str]) -> list[dict]:
    # Vectorize の get_by_ids は 1リクエスト20件まで（22_vec_backup.cjs と同じ）
    out = []
    for i in range(0, len(ids), 20):
        r = cf_request(f'{VEC}/get_by_ids', json.dumps({'ids': ids[i:i + 20]}).encode('utf-8'), 'application/json')
        out.extend(r or [])
        if (i // 20) % 25 == 0 and i:
            print(f'  get_by_ids {min(i + 20, len(ids))}/{len(ids)}', flush=True)
    return out


def upsert_vectors(rows: list[dict], dry: bool) -> int:
    n = 0
    for i in range(0, len(rows), API_BATCH):
        batch = rows[i:i + API_BATCH]
        for r in batch:
            if not isinstance(r.get('values'), list) or len(r['values']) != 1024:
                raise RuntimeError(f'values が 1024 次元でない: {r.get("id")}')
        if not dry:
            body = ('\n'.join(json.dumps({
                'id': r['id'], 'values': r['values'], 'namespace': r['namespace'], 'metadata': r.get('metadata') or {},
            }, ensure_ascii=False) for r in batch) + '\n').encode('utf-8')
            cf_request(f'{VEC}/upsert', body, 'application/x-ndjson')
        n += len(batch)
        print(f'  upsert {n}/{len(rows)}{" (dry)" if dry else ""}', flush=True)
    return n


def delete_ids(ids: list[str], dry: bool) -> int:
    n = 0
    for i in range(0, len(ids), DELETE_BATCH):
        batch = ids[i:i + DELETE_BATCH]
        if not dry:
            cf_request(f'{VEC}/delete_by_ids', json.dumps({'ids': batch}).encode('utf-8'), 'application/json')
        n += len(batch)
        print(f'  delete {n}/{len(ids)}{" (dry)" if dry else ""}', flush=True)
    return n


# ---------------------------------------------------------------- embedding
def load_model(fp32: bool):
    try:
        from sentence_transformers import SentenceTransformer  # noqa: WPS433
    except ImportError:
        sys.exit('sentence-transformers が無い。scripts/rebuild/04_generate_vectors.py と同じ環境で実行すること')
    import torch
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f'Model: {MODEL}  device: {device}  fp16: {not fp32 and device == "cuda"}')
    m = SentenceTransformer(MODEL, device=device)
    if not fp32 and device == 'cuda':
        m = m.half()
    return m


def embed_texts(model, texts: list[str], batch_size: int):
    # 04_generate_vectors.py と同じ: L2 正規化・numpy 出力
    vecs = model.encode(texts, batch_size=batch_size, normalize_embeddings=True,
                        show_progress_bar=False, convert_to_numpy=True)
    return [[float(x) for x in v] for v in vecs]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


# ---------------------------------------------------------------- commands
def cmd_compat(a):
    rows = list(read_ndjson(a.inp))
    model = load_model(a.fp32)
    local = embed_texts(model, [r['text'] for r in rows], a.batch_size)
    existing = {v['id']: v for v in get_by_ids([r['id'] for r in rows])}
    sims = []
    for r, lv in zip(rows, local):
        ev = existing.get(r['id'])
        if not ev or not ev.get('values'):
            print(f'  {r["id"]}  既存ベクトルなし（getByIds に values が無い）')
            continue
        s = cosine(lv, ev['values'])
        sims.append(s)
        print(f'  {r["id"]}  cosine={s:.4f}  {r["text"][:40]}')
    if not sims:
        sys.exit('比較できた本数が 0。トークン権限か id を疑う')
    print(f'\n比較 {len(sims)}本  min={min(sims):.4f}  mean={sum(sims)/len(sims):.4f}')
    print('判定:', '合格（0.99以上）。Workers AI 製と混ぜてよい' if min(sims) >= 0.99
          else '不合格。--fp32 で再試行。それでも駄目なら親に報告')


def cmd_backup(a):
    rows = list(read_ndjson(a.inp))
    got = get_by_ids([r['id'] for r in rows])
    by_id = {v['id']: v for v in got}
    out, missing = [], []
    for r in rows:
        v = by_id.get(r['id'])
        if not v or not v.get('values'):
            missing.append(r['id'])
            continue
        out.append({'id': v['id'], 'namespace': v.get('namespace') or r['namespace'],
                    'values': v['values'], 'metadata': v.get('metadata') or {}})
    n = write_ndjson(a.out, out)
    print(f'退避 {n}本 → {a.out}   未登録（バックアップ不要）: {len(missing)}本')
    if missing:
        write_ndjson(a.out + '.missing.json', [{'id': m} for m in missing])


def cmd_embed(a):
    rows = list(select_ns(read_ndjson(a.inp), a.ns, a.exclude_ns))
    print(f'対象 {len(rows)}本')
    model = load_model(a.fp32)
    out = []
    t0 = time.time()
    for i in range(0, len(rows), a.batch_size):
        batch = rows[i:i + a.batch_size]
        vecs = embed_texts(model, [r['text'] for r in batch], a.batch_size)
        for r, v in zip(batch, vecs):
            out.append({'id': r['id'], 'namespace': r['namespace'], 'values': v, 'metadata': r.get('metadata') or {}})
        print(f'  {len(out)}/{len(rows)}  {time.time()-t0:.0f}s', flush=True)
    n = write_ndjson(a.out, out)
    print(f'書き出し {n}本 → {a.out}')


def cmd_upsert(a):
    rows = list(select_ns(read_ndjson(a.inp), a.ns, a.exclude_ns))
    if a.limit:
        rows = rows[:a.limit]
    ns_count = {}
    for r in rows:
        ns_count[r['namespace']] = ns_count.get(r['namespace'], 0) + 1
    print('namespace 別:', json.dumps(ns_count, ensure_ascii=False))
    n = upsert_vectors(rows, a.dry)
    print(f'upsert {n}本{"（dry・未書き込み）" if a.dry else ""}')


def cmd_delete(a):
    rows = list(select_ns(read_ndjson(a.inp), a.ns, a.exclude_ns))
    ids = [r['id'] for r in rows]
    n = delete_ids(ids, a.dry)
    print(f'delete {n}本{"（dry・未削除）" if a.dry else ""}')


def cmd_homes_apply(a):
    # values はバックアップから、metadata は更新ファイルから。再埋め込みしない。
    backup = {r['id']: r for r in read_ndjson(a.backup)}
    out, missing = [], []
    for u in read_ndjson(a.update):
        b = backup.get(u['id'])
        if not b:
            missing.append(u['id'])
            continue
        out.append({'id': u['id'], 'namespace': u['namespace'], 'values': b['values'], 'metadata': u['metadata']})
    n = write_ndjson(a.out, out)
    print(f'生成 {n}本 → {a.out}   バックアップに無く適用できない: {len(missing)}本')
    print('次: upsert --in', a.out, '   戻すとき: upsert --in', a.backup)


def cmd_check(a):
    rows = list(select_ns(read_ndjson(a.inp), a.ns, a.exclude_ns))
    got = {v['id'] for v in get_by_ids([r['id'] for r in rows])}
    found = sum(1 for r in rows if r['id'] in got)
    print(f'登録済み {found}/{len(rows)}本')


def cmd_show(a):
    """Vectorize の実物から id・namespace・metadata.homes を表示する（カナリアの確認用。書き込みなし）。"""
    rows = list(select_ns(read_ndjson(a.inp), a.ns, a.exclude_ns))
    if a.limit:
        rows = rows[:a.limit]
    by_id = {v['id']: v for v in get_by_ids([r['id'] for r in rows])}
    for r in rows:
        v = by_id.get(r['id'])
        if not v:
            print(f'  {r["id"]}  未登録')
            continue
        md = v.get('metadata') or {}
        homes = md.get('homes', '')
        try:
            n = len(json.loads(homes or '[]'))
        except Exception:
            n = '?'
        print(f'  {v["id"]}  ns={v.get("namespace")}  homes {n}件  {str(homes)[:300]}')


def cmd_probe(a):
    key = os.environ.get('JOUBUN_BYPASS_KEY')
    if not key:
        sys.exit('JOUBUN_BYPASS_KEY が未設定（ベンチ用バイパスキー）')
    articles = [{'law_id': l, 'article_title': t} for l, t in (x.split('=', 1) for x in a.article)]
    body = json.dumps({'articles': articles, 'query': a.query}, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(a.worker.rstrip('/') + '/api/tsutatsu', data=body, method='POST',
                                 headers={'Content-Type': 'application/json', 'x-api-key': key})
    with urllib.request.urlopen(req, timeout=60) as res:
        j = json.loads(res.read().decode('utf-8'))
    for r in j.get('results', []):
        print(f'  {r["law_id"]} {r["article_title"]}: {len(r.get("tsutatsu") or [])}本')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    def common_ns(p):
        p.add_argument('--ns', help='この namespace だけ')
        p.add_argument('--exclude-ns', help='この namespace を除く')

    p = sub.add_parser('compat'); p.add_argument('--in', dest='inp', required=True)
    p.add_argument('--fp32', action='store_true'); p.add_argument('--batch-size', type=int, default=16)
    p.set_defaults(fn=cmd_compat)

    p = sub.add_parser('backup'); p.add_argument('--in', dest='inp', required=True); p.add_argument('--out', required=True)
    p.set_defaults(fn=cmd_backup)

    p = sub.add_parser('embed'); p.add_argument('--in', dest='inp', required=True); p.add_argument('--out', required=True)
    p.add_argument('--fp32', action='store_true'); p.add_argument('--batch-size', type=int, default=16); common_ns(p)
    p.set_defaults(fn=cmd_embed)

    p = sub.add_parser('upsert'); p.add_argument('--in', dest='inp', required=True); common_ns(p)
    p.add_argument('--limit', type=int); p.add_argument('--dry', action='store_true')
    p.set_defaults(fn=cmd_upsert)

    p = sub.add_parser('delete'); p.add_argument('--in', dest='inp', required=True); common_ns(p)
    p.add_argument('--dry', action='store_true')
    p.set_defaults(fn=cmd_delete)

    p = sub.add_parser('homes-apply'); p.add_argument('--update', required=True); p.add_argument('--backup', required=True)
    p.add_argument('--out', required=True)
    p.set_defaults(fn=cmd_homes_apply)

    p = sub.add_parser('check'); p.add_argument('--in', dest='inp', required=True); common_ns(p)
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser('show'); p.add_argument('--in', dest='inp', required=True); common_ns(p)
    p.add_argument('--limit', type=int, help='先頭N本だけ')
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser('probe')
    p.add_argument('--worker', default=site_config.WORKER_URLS['bench'])
    p.add_argument('--article', action='append',
                   default=None, help='law_id=条タイトル。省略時は 法人税法22条・相続税法22条')
    p.add_argument('--query', default='損金の額に算入される費用の範囲')
    p.set_defaults(fn=cmd_probe)

    a = ap.parse_args()
    if a.cmd == 'probe' and not a.article:
        a.article = ['340AC0000000034=第二十二条', '325AC0000000073=第二十二条']
    a.fn(a)


if __name__ == '__main__':
    main()
