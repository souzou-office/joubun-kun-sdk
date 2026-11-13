#!/usr/bin/env bash
# 別表 item 用ベクトルを Vectorize に挿入するスクリプト
#
# 入力:  {localDataRoot}/rebuild_output/vectors_appendix.ndjson
# 出力先: Vectorize index "law-embeddings-v2"
#
# wrangler vectorize insert は 1ファイルあたり最大件数制限があるので、
# 100,000 行ずつチャンク化してから順次 insert する。
#
# 使い方:
#   bash scripts/rebuild/06b_insert_appendix_vectors.sh

set -e

# 置き場の根（scripts/site_config.cjs の localDataRoot。条文くんの PC の作業フォルダ）
DATA_ROOT="$(node -e "process.stdout.write(require(require('path').resolve(process.argv[1])).localDataRoot)" "$(dirname "$0")/../site_config.cjs")" || exit 1
INDEX="law-embeddings-v2"
INPUT="${DATA_ROOT}/rebuild_output/vectors_appendix.ndjson"
CHUNKS_DIR="${DATA_ROOT}/rebuild_output/vectors_appendix_chunks"
DONE_DIR="${DATA_ROOT}/rebuild_output/vectors_appendix_done"

mkdir -p "$CHUNKS_DIR" "$DONE_DIR"

if [ ! -f "$INPUT" ]; then
  echo "ERROR: $INPUT not found"
  exit 1
fi

TOTAL_LINES=$(wc -l < "$INPUT")
echo "Total vectors: $TOTAL_LINES"

# 既存チャンクを削除して再生成
rm -f "$CHUNKS_DIR"/vectors_appendix_part_*.ndjson

# 100,000 行ずつ分割
split -l 100000 -d --additional-suffix=.ndjson "$INPUT" "$CHUNKS_DIR/vectors_appendix_part_"

PARTS=$(ls "$CHUNKS_DIR"/vectors_appendix_part_*.ndjson | sort)
echo "Chunks generated:"
ls -la "$CHUNKS_DIR"/vectors_appendix_part_*.ndjson

MAX_RETRIES=8

for part in $PARTS; do
  name=$(basename "$part")
  done_marker="$DONE_DIR/${name}.done"

  if [ -f "$done_marker" ]; then
    echo "[SKIP] $name (already inserted)"
    continue
  fi

  echo "=== Inserting $name ==="

  attempt=1
  while [ $attempt -le $MAX_RETRIES ]; do
    if npx wrangler vectorize insert "$INDEX" --file="$part"; then
      touch "$done_marker"
      echo "[OK] $name"
      break
    fi
    echo "[FAIL attempt $attempt] $name — retrying in $((attempt * 5))s..."
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
  done

  if [ ! -f "$done_marker" ]; then
    echo "[GIVE UP] $name after $MAX_RETRIES attempts"
    exit 1
  fi
done

echo ""
echo "=== All appendix vectors inserted into $INDEX ==="
