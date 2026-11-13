# -*- coding: utf-8 -*-
"""
bge-m3 (BAAI/bge-m3) でベクトル生成するスクリプト。

入力:  {LOCAL_DATA_ROOT}\rebuild_output\embedding_inputs.jsonl
       各行: { "id": "...", "text": "...", "metadata": {...} }

出力:  {LOCAL_DATA_ROOT}\rebuild_output\vectors.ndjson
       各行: { "id": "...", "values": [1024 floats], "metadata": {...} }
       Cloudflare Vectorize の wrangler vectorize insert と互換。

実行環境:
  - PyTorch (CUDA 対応版)
  - sentence-transformers >= 2.6.0
  - GPU: RTX 5070 (12GB) で十分

使い方:
  # フル実行
  python scripts/rebuild/04_generate_vectors.py

  # 中断した場合のレジューム (id を見て続きから)
  python scripts/rebuild/04_generate_vectors.py --resume

  # バッチサイズ調整 (GPU メモリが足りない場合)
  python scripts/rebuild/04_generate_vectors.py --batch-size 16

  # 試運転 (最初の 1000 件だけ)
  python scripts/rebuild/04_generate_vectors.py --limit 1000

参考:
  bge-m3 は BAAI/bge-m3 (1024 次元、L2 正規化済み)。
  Cloudflare Workers AI の @cf/baai/bge-m3 と同じモデル重みなので、
  既存 Vectorize データと互換性あり。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

INPUT_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/embedding_inputs.jsonl')
OUTPUT_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/vectors.ndjson')
LOG_FILE = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/vectors_log.json')


def load_inputs(path: Path, limit: int | None = None):
    """入力 JSONL を逐次読み込み。"""
    with path.open('r', encoding='utf-8') as f:
        for i, line in enumerate(f):
            if limit and i >= limit:
                break
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def already_processed_ids(path: Path) -> set[str]:
    """resume 時の既処理 ID 取得。"""
    ids: set[str] = set()
    if not path.exists():
        return ids
    with path.open('r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ids.add(json.loads(line)['id'])
            except Exception:
                continue
    return ids


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--batch-size', type=int, default=64, help='GPU バッチサイズ (default 64)')
    ap.add_argument('--limit', type=int, default=None, help='最初の N エントリだけ (テスト用)')
    ap.add_argument('--resume', action='store_true', help='既存 vectors.ndjson の続きから')
    ap.add_argument('--device', type=str, default='cuda', help='cuda | cpu')
    ap.add_argument('--model', type=str, default='BAAI/bge-m3', help='Hugging Face model name')
    ap.add_argument('--fp16', action='store_true', default=True, help='FP16 推論 (default: True)')
    ap.add_argument('--no-fp16', dest='fp16', action='store_false', help='FP32 推論')
    ap.add_argument('--no-sort', action='store_true', help='長さソートを無効化')
    args = ap.parse_args()

    if not INPUT_FILE.exists():
        print(f'ERROR: {INPUT_FILE} not found.')
        print('まず 03_prepare_embedding_inputs.py を実行してください')
        return 1

    # sentence-transformers の import (GPU が無くても CPU で動く)
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print('ERROR: sentence-transformers がインストールされていません')
        print('pip install sentence-transformers torch')
        return 1

    print(f'Model: {args.model}')
    print(f'Device: {args.device}')
    print(f'Batch size: {args.batch_size}')
    print()

    print('Loading model...')
    model = SentenceTransformer(args.model, device=args.device)
    if args.fp16 and args.device == 'cuda':
        # FP16 推論 (速度 2倍、VRAM 半分)
        # bge-m3 の出力品質は FP16 でほぼ変わらない
        model = model.half()
        print('  Model loaded (FP16)')
    else:
        print('  Model loaded (FP32)')

    # resume 対応
    skip_ids: set[str] = set()
    if args.resume:
        print('Resuming: loading already-processed IDs...')
        skip_ids = already_processed_ids(OUTPUT_FILE)
        print(f'  既に {len(skip_ids)} 件処理済み')

    # 入力をロード (一旦メモリ展開: 53万件 × 数百バイト = 数GB)
    print('Loading inputs...')
    all_inputs = list(load_inputs(INPUT_FILE, args.limit))
    if skip_ids:
        all_inputs = [r for r in all_inputs if r['id'] not in skip_ids]
    print(f'  処理対象: {len(all_inputs):,}')

    if not all_inputs:
        print('処理対象なし')
        return 0

    # 長さソート: バッチ内のテキスト長を揃えて padding を最小化
    # encode 後の出力順を保つため、元 index を保持
    if not args.no_sort:
        print('  長さソート中...')
        all_inputs_with_idx = [(i, r) for i, r in enumerate(all_inputs)]
        all_inputs_with_idx.sort(key=lambda x: len(x[1]['text']))
        # 元の順序情報を保持しつつ、ソート済みリストを処理
        # → 出力順は不要 (各エントリ独立) なのでソート順のまま書き出して OK
        all_inputs = [r for _, r in all_inputs_with_idx]
        print(f'  ソート完了')

    # 出力モード (resume なら append)
    mode = 'a' if args.resume else 'w'
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    print()
    print(f'ベクトル生成開始 (batch={args.batch_size}, fp16={args.fp16}, sort={not args.no_sort})...',
          flush=True)
    start = time.time()
    processed = 0

    with OUTPUT_FILE.open(mode, encoding='utf-8') as out_f:
        for i in range(0, len(all_inputs), args.batch_size):
            batch = all_inputs[i:i + args.batch_size]
            texts = [r['text'] for r in batch]

            # bge-m3 でベクトル化 (L2 正規化必須)
            vectors = model.encode(
                texts,
                batch_size=args.batch_size,
                normalize_embeddings=True,
                show_progress_bar=False,
                convert_to_numpy=True,
            )

            for rec, vec in zip(batch, vectors):
                output = {
                    'id': rec['id'],
                    'values': vec.tolist(),
                    'metadata': rec['metadata'],
                }
                out_f.write(json.dumps(output, ensure_ascii=False) + '\n')

            processed += len(batch)
            # 進捗表示は 5000 件ごと
            if processed % 5000 == 0 or processed >= len(all_inputs):
                out_f.flush()  # 中断対応で逐次フラッシュ
                elapsed = time.time() - start
                rate = processed / elapsed if elapsed > 0 else 0
                eta = (len(all_inputs) - processed) / rate if rate > 0 else 0
                print(f'  {processed:7d}/{len(all_inputs):7d}  '
                      f'rate={rate:.1f}/s  eta={eta/60:.1f}min',
                      flush=True)

    elapsed = time.time() - start
    print()
    print('=== 完了 ===')
    print(f'  処理時間: {elapsed:.1f} 秒 ({elapsed/60:.1f} 分)')
    print(f'  処理件数: {processed:,}')
    print(f'  出力先:   {OUTPUT_FILE}')

    output_size = OUTPUT_FILE.stat().st_size if OUTPUT_FILE.exists() else 0
    print(f'  出力サイズ: {output_size / 1024 / 1024:.0f} MB')

    log = {
        'elapsed_seconds': elapsed,
        'processed': processed,
        'output_size_bytes': output_size,
        'model': args.model,
        'device': args.device,
        'batch_size': args.batch_size,
    }
    with LOG_FILE.open('w', encoding='utf-8') as f:
        json.dump(log, f, ensure_ascii=False, indent=2)

    return 0


if __name__ == '__main__':
    sys.exit(main())
