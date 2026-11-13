# -*- coding: utf-8 -*-
"""
Vectorize ID 生成ユーティリティ

Cloudflare Vectorize の ID は最大 64 バイト (UTF-8) という制約があるため、
ロジカルキー (law_id + article_title + caption + paragraph_num) を
収まるように truncation/hashing する。

ID の構成要素:
  - law_id            約15-16文字 (例: 129AC0000000089)
  - article_title     可変長 (例: 第三条、別表第一、附則 第三条)
  - caption           可変長 (例: 「（基本原則）」, 「附則 抄」)
  - paragraph_num     1-2桁 (例: 1, 2, 10)

戦略:
  1. まず {law_id}_{article_title}_{paragraph_num} を試す (caption 無し)
  2. 64バイト超 or 同 ID が衝突する場合は caption_hash を付与
     {law_id}_{caption_hash[:8]}_{article_title_hash[:8]}_{paragraph_num}
     → 法令ID + 4ハッシュ要素 + 区切り文字3つで32バイト程度
"""

from __future__ import annotations

import hashlib
import re

VECTORIZE_ID_MAX_BYTES = 64

# Vectorize ID で使えない可能性のある文字を除去 (英数字・アンダースコア・日本語のみ許容)
# ※ Cloudflare Vectorize は UTF-8 ASCII / 多言語文字に対応するが、
#   念のため危険な文字 (改行・制御・スペース等) は除く
_UNSAFE_CHARS = re.compile(r'[\s\x00-\x1f\x7f]')


def _md5_hex(s: str) -> str:
    return hashlib.md5(s.encode('utf-8')).hexdigest()


def _byte_len(s: str) -> int:
    return len(s.encode('utf-8'))


def _sanitize(s: str) -> str:
    """ID 構成要素から制御文字・空白を除去。"""
    return _UNSAFE_CHARS.sub('', s)


def make_vector_id(
    law_id: str,
    article_title: str,
    paragraph_num: str,
    caption: str = '',
) -> str:
    """
    Vectorize 用のベクトル ID を生成。

    戦略:
      1. 短い場合: {law_id}_{article_title}_{paragraph_num}
         (例: '129AC0000000089_第三条_1')
      2. 64バイト超 or caption で区別が必要な場合:
         {law_id}_a{article_hash[:10]}_c{caption_hash[:8]}_{paragraph_num}
         (例: '129AC0000000089_a3f2a1c4d5_c8b9a0c1_1')

    返却: 64バイト以内の文字列
    """
    law_id = _sanitize(law_id)
    article_title = _sanitize(article_title)
    paragraph_num = _sanitize(paragraph_num)

    # まず短い形式を試す
    short = f'{law_id}_{article_title}_{paragraph_num}'
    if _byte_len(short) <= VECTORIZE_ID_MAX_BYTES and not caption:
        return short

    # caption 込みでハッシュ化
    article_hash = _md5_hex(article_title)[:10]
    caption_hash = _md5_hex(caption)[:8] if caption else '00000000'
    hashed = f'{law_id}_a{article_hash}_c{caption_hash}_{paragraph_num}'

    if _byte_len(hashed) <= VECTORIZE_ID_MAX_BYTES:
        return hashed

    # それでも超える場合 (law_id が異常に長い場合など)
    # law_id 自体もハッシュ化
    law_hash = _md5_hex(law_id)[:12]
    fallback = f'l{law_hash}_a{article_hash}_c{caption_hash}_{paragraph_num}'
    return fallback


def make_vector_metadata(
    law_id: str,
    law_title: str,
    article_title: str,
    article_caption: str,
    paragraph_num: str,
) -> dict[str, str]:
    """
    Vectorize に保存するメタデータ。
    Worker から条文ファイルを引くのに必要な情報を全部入れる。
    """
    return {
        'law_id': law_id,
        'law_title': law_title,
        'article_title': article_title,
        'article_caption': article_caption,
        'paragraph_num': paragraph_num,
    }


# ============================================================
# 重複 ID 検出 (バッチ生成時の safety check)
# ============================================================

class IdAllocator:
    """
    バッチ ID 生成時の重複検出器。
    同じ ID が複数回出現したら suffix で区別する。

    使い方:
        alloc = IdAllocator()
        id_1 = alloc.allocate(law_id, article_title, '1', caption)
        id_2 = alloc.allocate(law_id, article_title, '1', caption)  # → 自動で _2 付与
    """

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}

    def allocate(
        self,
        law_id: str,
        article_title: str,
        paragraph_num: str,
        caption: str = '',
    ) -> str:
        base = make_vector_id(law_id, article_title, paragraph_num, caption)
        count = self._counts.get(base, 0)
        self._counts[base] = count + 1
        if count == 0:
            return base
        # 衝突した場合は _N を末尾に追加 (バイト境界で truncate)
        suffix = f'_{count + 1}'
        suffix_bytes = _byte_len(suffix)
        max_base_bytes = VECTORIZE_ID_MAX_BYTES - suffix_bytes
        # base を maxBaseBytes に切り詰め (UTF-8 マルチバイト境界に注意)
        if _byte_len(base) <= max_base_bytes:
            return base + suffix
        # マルチバイト境界で安全に切る
        encoded = base.encode('utf-8')
        truncated_bytes = encoded[:max_base_bytes]
        # 末尾の不完全マルチバイトを削る
        while truncated_bytes and (truncated_bytes[-1] & 0xC0) == 0x80:
            truncated_bytes = truncated_bytes[:-1]
        truncated = truncated_bytes.decode('utf-8', errors='ignore')
        return truncated + suffix


# ============================================================
# CLI (デバッグ用)
# ============================================================

if __name__ == '__main__':
    import sys

    examples = [
        ('129AC0000000089', '第三条', '1', ''),
        ('129AC0000000089', '第三条', '1', '（基本原則）'),
        ('129AC0000000089', '附則 第三条', '1', '（経過措置）'),
        # 異常に長い article_title
        ('123AC0000000456', '第千四百五十六条の二十三第二項第三号', '1', ''),
    ]

    print('--- make_vector_id sample ---')
    for law, art, para, cap in examples:
        vid = make_vector_id(law, art, para, cap)
        print(f'{vid:60s}  bytes={_byte_len(vid):2d}  ({art} cap={cap!r})')

    print()
    print('--- IdAllocator sample (collision handling) ---')
    alloc = IdAllocator()
    for _ in range(3):
        vid = alloc.allocate('129AC0000000089', '第三条', '1')
        print(f'  {vid}')
