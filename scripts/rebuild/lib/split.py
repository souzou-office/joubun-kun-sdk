# -*- coding: utf-8 -*-
"""
パース済み法令 dict → 条文単位ファイル群（large_law_articles_v3 形式）。

02_split_articles.py（全件再構築）と scripts/update/04_parse_split.py（週次更新）の両方がこれを使う。
ファイルの中身（JSON の並び・区切り文字）を変えると、R2 上の既存ファイルとハッシュが合わなくなり
差分検出が全件「変更」になるので、出力形式は変えないこと。

出力:
  {out_dir}/{law_id}/_index.json   法令メタ + 条の一覧（files）+ 目次（toc）
  {out_dir}/{law_id}/{title}.json  同名条文（本則と附則の同じ条番号など）は articles 配列にまとめる
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

# ファイル名で使えない文字を全角に置換（Windows: / \ : * ? " < > |）。Worker の safeFilename と同じ対応表
_INVALID_FILENAME_CHARS = {
    '/': '／', '\\': '＼', ':': '：', '*': '＊',
    '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜',
}

# ファイル名（拡張子を除く）の UTF-8 バイト数の上限
_MAX_FILENAME_BYTES = 200

# 目次に出す階層の順（深さ）
_TOC_LEVELS = ('part', 'chapter', 'section', 'subsection', 'division')


def safe_filename(title: str) -> str:
    """ファイル名として安全な形に変換。"""
    s = title
    for bad, good in _INVALID_FILENAME_CHARS.items():
        s = s.replace(bad, good)
    s = s.rstrip(' .')
    # ファイルシステムの上限（255 バイト）に掛からないよう、UTF-8 で 200 バイトに切る（別表の長い見出し向け。
    # 同名になれば split_law が articles 配列にまとめる）。Worker と lib/common.cjs の safeFilename と同じ規則
    while len(s.encode('utf-8')) > _MAX_FILENAME_BYTES:
        s = s[:-1]
    s = s.rstrip(' .')
    if not s:
        s = '_unnamed'
    return s


def build_toc(articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    条の並び（文書順）と各条の structure から、目次を平らなリストで作る。

    各要素: {"kind": "part|chapter|section|subsection|division|suppl", "title": "...",
             "first": "第一条", "count": 12}
    kind は階層の深さの目安（part が最上位）。附則は "suppl" で、改正法の附則は title に法令番号を持つ。
    見出しが変わったところで新しい要素を出すので、同じ章に節が並ぶときは
    章の要素の後に節の要素が続く。
    """
    toc: list[dict[str, Any]] = []
    current: dict[str, str | None] = {k: None for k in _TOC_LEVELS}
    current_suppl: str | None = None   # None=本則, '' = 制定時附則, それ以外 = 改正法番号

    for art in articles:
        if art.get('type', 'article') != 'article':
            continue
        st = art.get('structure') or {}
        title = art.get('title', '')
        if st.get('suppl'):
            key = st.get('amend_law_num', '')
            if current_suppl is None or key != current_suppl:
                current_suppl = key
                current = {k: None for k in _TOC_LEVELS}
                toc.append({'kind': 'suppl', 'title': ('附則（' + key + '）') if key else '附則', 'first': title, 'count': 0})
            toc[-1]['count'] += 1
            continue
        current_suppl = None
        changed_at = None
        for i, k in enumerate(_TOC_LEVELS):
            v = st.get(k)
            if v != current[k]:
                changed_at = i
                break
        if changed_at is not None:
            for k in _TOC_LEVELS[changed_at:]:
                current[k] = st.get(k)
            for k in _TOC_LEVELS[changed_at:]:
                if current[k]:
                    toc.append({'kind': k, 'title': current[k], 'first': title, 'count': 0})
        if toc and toc[-1]['kind'] != 'suppl':
            # 直近の見出しに条を数える（見出しのない法令は数えない）
            toc[-1]['count'] += 1
    return toc


def split_law(law: dict[str, Any], out_base: Path) -> dict[str, Any]:
    """
    1 法令分を条文単位ファイルに書き出す。返却は処理サマリ。
    """
    law_id = law['law_id']
    out_dir = Path(out_base) / law_id
    out_dir.mkdir(parents=True, exist_ok=True)

    articles = law.get('articles', [])

    grouped: dict[str, list[dict]] = defaultdict(list)
    for art in articles:
        grouped[art.get('title', '_unnamed')].append(art)

    base_meta = {
        'law_id': law_id,
        'law_title': law.get('law_title', ''),
        'law_num': law.get('law_num', ''),
        'law_type': law.get('law_type', ''),
    }

    article_files: list[dict] = []
    for title, art_list in grouped.items():
        filename = safe_filename(title) + '.json'
        article_data = {**base_meta, 'articles': art_list}
        with (out_dir / filename).open('w', encoding='utf-8') as f:
            json.dump(article_data, f, ensure_ascii=False, separators=(',', ':'))

        entry: dict[str, Any] = {
            'title': title,
            'filename': filename,
            'count': len(art_list),
            'captions': [a.get('caption', '') for a in art_list],
            'types': list({a.get('type', 'article') for a in art_list}),
        }
        # 本則の条の所属（同名条文があれば本則側＝structure に suppl の無いものを優先）
        main = next((a for a in art_list if not (a.get('structure') or {}).get('suppl')), art_list[0])
        if main.get('structure'):
            entry['structure'] = main['structure']
        article_files.append(entry)

    index = {
        **base_meta,
        'article_count': len(articles),
        'unique_titles': len(grouped),
        'files': article_files,
        'toc': build_toc(articles),
        '_source': law.get('_source', {}),
    }
    with (out_dir / '_index.json').open('w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))

    return {
        'law_id': law_id,
        'law_title': law.get('law_title', ''),
        'articles_total': len(articles),
        'unique_files': len(grouped),
        'duplicate_titles': sum(1 for ats in grouped.values() if len(ats) > 1),
    }
