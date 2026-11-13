#!/usr/bin/env bash
# Vectorize 新インデックス作成 + ベクトル投入スクリプト
#
# 入力: {localDataRoot}\rebuild_output\vectors.ndjson
# 出力先: Vectorize index "law-embeddings-v2"
#
# 実行前提:
#   - wrangler 4.x インストール済
#   - wrangler login 済
#   - vectors.ndjson が生成済 (04_generate_vectors.py 実行済)

set -e

# 置き場の根（scripts/site_config.cjs の localDataRoot。条文くんの PC の作業フォルダ）
DATA_ROOT="$(node -e "process.stdout.write(require(require('path').resolve(process.argv[1])).localDataRoot)" "$(dirname "$0")/../site_config.cjs")" || exit 1
INDEX_NAME="law-embeddings-v2"
NDJSON_FILE="${DATA_ROOT}/rebuild_output/vectors.ndjson"
DIMENSIONS=1024
METRIC="cosine"

echo "=== Vectorize アップロード ==="
echo "  Index name: ${INDEX_NAME}"
echo "  Dimensions: ${DIMENSIONS}"
echo "  Metric:     ${METRIC}"
echo "  NDJSON:     ${NDJSON_FILE}"
echo ""

# ファイル存在確認
if [ ! -f "${NDJSON_FILE}" ]; then
  echo "ERROR: ${NDJSON_FILE} not found"
  echo "先に 04_generate_vectors.py を実行してください"
  exit 1
fi

# サイズ表示
size_mb=$(du -m "${NDJSON_FILE}" | cut -f1)
line_count=$(wc -l < "${NDJSON_FILE}")
echo "  ファイルサイズ: ${size_mb} MB"
echo "  ベクトル数:    ${line_count}"
echo ""

# 既存インデックスをチェック
echo "[Step 1] 既存インデックス確認..."
if npx wrangler vectorize get "${INDEX_NAME}" 2>/dev/null; then
  echo ""
  echo "WARNING: ${INDEX_NAME} は既に存在します"
  read -p "上書きしますか? 既存ベクトルは保持されます (続行: y / 中止: n): " ans
  if [ "$ans" != "y" ]; then
    echo "中止しました"
    exit 0
  fi
else
  echo "  新規作成します"
  echo ""
  echo "[Step 2] インデックス作成..."
  npx wrangler vectorize create "${INDEX_NAME}" \
    --dimensions=${DIMENSIONS} \
    --metric="${METRIC}"
fi

echo ""
echo "[Step 3] ベクトル投入..."
echo "  (大量の場合は数分〜数十分かかります)"

# wrangler vectorize insert
# 100K vectors ずつバッチで投入する仕様
npx wrangler vectorize insert "${INDEX_NAME}" --file="${NDJSON_FILE}"

echo ""
echo "=== 完了 ==="
echo ""
echo "次のステップ:"
echo "  1. ステージング Worker を作成 (wrangler.staging.toml)"
echo "  2. binding を ${INDEX_NAME} に向ける"
echo "  3. wrangler deploy --config wrangler.staging.toml"
echo "  4. 動作確認 (worker_patch.md のチェックリスト)"
