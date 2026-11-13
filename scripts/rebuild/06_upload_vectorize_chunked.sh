#!/usr/bin/env bash
# Vectorize へ vectors_part_*.ndjson を順次 insert (リトライ + skip 完了部分)
# wrangler vectorize insert は途中 "fetch failed" で死ぬので、リトライ付き

# 注意: set -e は使わない (途中エラーで中断したくない)

# 置き場の根（scripts/site_config.cjs の localDataRoot。条文くんの PC の作業フォルダ）
DATA_ROOT="$(node -e "process.stdout.write(require(require('path').resolve(process.argv[1])).localDataRoot)" "$(dirname "$0")/../site_config.cjs")" || exit 1
INDEX="law-embeddings-v2"
CHUNKS_DIR="${DATA_ROOT}/rebuild_output/vectors_chunks"
LOG_DIR="${DATA_ROOT}/rebuild_output/vectorize_chunked_logs"
DONE_MARKER_DIR="${DATA_ROOT}/rebuild_output/vectorize_chunked_done"
mkdir -p "$LOG_DIR" "$DONE_MARKER_DIR"

MAX_RETRIES=10

PARTS=$(ls "$CHUNKS_DIR"/vectors_part_*.ndjson | sort)

for part in $PARTS; do
  name=$(basename "$part")
  num=$(echo "$name" | sed 's/.*part_\([0-9]*\).*/\1/')
  done_marker="$DONE_MARKER_DIR/${name}.done"

  # part_00 は既に index 上に
  if [ "$num" = "00" ]; then
    echo "[SKIP] $name (already in index)"
    touch "$done_marker"
    continue
  fi

  # 既に done マーカーがあればスキップ
  if [ -f "$done_marker" ]; then
    echo "[SKIP] $name (marker exists)"
    continue
  fi

  log="$LOG_DIR/${name%.ndjson}.log"

  attempt=0
  success=false
  while [ "$attempt" -lt "$MAX_RETRIES" ]; do
    attempt=$((attempt + 1))
    # ログをアテンプトごとに別ファイル化 (混ざらないように)
    attempt_log="${log%.log}_a${attempt}.log"
    echo ""
    echo "=== [$num] (attempt $attempt/$MAX_RETRIES) Inserting $name ==="
    start=$(date +%s)
    npx wrangler vectorize insert "$INDEX" --file="$part" > "$attempt_log" 2>&1
    rc=$?
    elapsed=$(( $(date +%s) - start ))
    enq=$(grep -c "Enqueued" "$attempt_log" 2>/dev/null || echo 0)
    succ_msg=$(grep -c "Successfully enqueued" "$attempt_log" 2>/dev/null || echo 0)
    echo "  rc=$rc enqueued=$enq batches, success_msg=$succ_msg, ${elapsed}s"
    if [ "$rc" -eq 0 ] && [ "$succ_msg" -ge 1 ]; then
      success=true
      break
    fi
    sleep_sec=$((attempt * 30))
    echo "  failed (rc=$rc), retrying in ${sleep_sec}s..."
    sleep $sleep_sec
  done

  if [ "$success" = true ]; then
    touch "$done_marker"
    echo "[OK] $name done"
  else
    echo "[FAIL] $name gave up after $MAX_RETRIES attempts"
  fi
done

echo ""
echo "=== ALL DONE ==="
ls "$DONE_MARKER_DIR"
