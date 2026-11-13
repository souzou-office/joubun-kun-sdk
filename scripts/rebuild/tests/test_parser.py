# -*- coding: utf-8 -*-
"""
egov_parser の動作確認テスト。

実 XML を相手にチェック:
  T1. 民法 第一条 (基本構造)
  T2. 民法 第三十条 (ArticleCaption に Ruby 含む)
  T3. 民法 第四百六十五条の六 (Subitem1 + Column 構造)
  T4. 民法 (同名条文: 本則の第三条と附則の第三条が両立しているか)
  T5. 商業登記法 (別表 AppdxTable がパースされるか)
  T6. 弁護士法 (Ruby 切り捨て問題が再発していないか)

実行:  python scripts/rebuild/tests/test_parser.py
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

# リポジトリルートからの import を可能にする
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# UTF-8 出力 (Windows 端末対応)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from lib.egov_parser import parse_law_xml  # noqa: E402
sys.path.append(str(Path(__file__).resolve().parents[2]))  # scripts/（site_config）
import site_config  # noqa: E402


XML_BASE = Path(f'{site_config.LOCAL_DATA_ROOT}/all_xml_20260508')


def find_xml(law_id: str) -> Path:
    """指定 law_id の最新版 XML を探す (施行日が現在以前で最新)."""
    candidates = sorted(XML_BASE.glob(f'{law_id}_*'))
    if not candidates:
        raise FileNotFoundError(f'No XML for law_id={law_id}')
    # 施行日順 (将来分含む)。とりあえず文字列ソートの最後を「最新」と扱う
    # (将来日付除外は別ロジック)
    latest = candidates[-1]
    xml_files = list(latest.glob('*.xml'))
    if not xml_files:
        raise FileNotFoundError(f'No xml file inside {latest}')
    return xml_files[0]


def find_xml_specific(law_id: str, prefix_filter: str | None = None) -> Path:
    """特定の prefix を含むディレクトリを優先 (現在施行版を選ぶ用)."""
    candidates = sorted(XML_BASE.glob(f'{law_id}_*'))
    if prefix_filter:
        filtered = [c for c in candidates if prefix_filter in c.name]
        if filtered:
            candidates = filtered
    if not candidates:
        raise FileNotFoundError(f'No XML for law_id={law_id}')
    latest = candidates[-1]
    xml_files = list(latest.glob('*.xml'))
    return xml_files[0]


def report(name: str, ok: bool, detail: str = '') -> bool:
    mark = 'PASS' if ok else 'FAIL'
    print(f'[{mark}] {name}')
    if detail:
        for line in detail.splitlines():
            print(f'       {line}')
    return ok


def test_t1_minpo_article_1():
    """T1: 民法 第一条 — 3項あり、全て正しく取れているか"""
    xml = find_xml_specific('129AC0000000089', '20260401')
    law = parse_law_xml(xml)

    art = next((a for a in law['articles'] if a['title'] == '第一条'), None)
    if not art:
        return report('T1 民法第一条', False, '第一条が見つからない')

    paras = art['paragraphs']
    checks = [
        (law['law_title'] == '民法', f'law_title={law["law_title"]}'),
        (art['caption'] == '（基本原則）', f'caption={art["caption"]}'),
        (len(paras) == 3, f'paragraphs={len(paras)}'),
        ('公共の福祉' in paras[0]['sentences'][0]['text'], '第1項本文に「公共の福祉」'),
        ('信義' in paras[1]['sentences'][0]['text'], '第2項本文に「信義」'),
        ('濫用' in paras[2]['sentences'][0]['text'], '第3項本文に「濫用」'),
    ]
    ok = all(c[0] for c in checks)
    detail = '\n'.join(f'{c[1]}: {"OK" if c[0] else "NG"}' for c in checks)
    return report('T1 民法第一条', ok, detail)


def test_t2_ruby_in_caption():
    """T2: 民法 第三十条 — caption に Ruby (失踪) を含む"""
    xml = find_xml_specific('129AC0000000089', '20260401')
    law = parse_law_xml(xml)

    art = next((a for a in law['articles'] if a['title'] == '第三十条'), None)
    if not art:
        return report('T2 Ruby in caption', False, '第三十条が見つからない')

    cap = art['caption']
    # Ruby 削除後は "失踪の宣告" 形式 (Rt の "そう" が消えている)
    checks = [
        ('失踪' in cap, f'caption={cap}'),
        ('そう' not in cap, 'Rt の振り仮名が混入していない'),
    ]
    ok = all(c[0] for c in checks)
    detail = '\n'.join(f'{c[1]}: {"OK" if c[0] else "NG"}' for c in checks)
    return report('T2 Ruby caption', ok, detail)


def test_t3_subitem_with_column():
    """T3: Subitem1 + Column 構造 — 民法 第四百六十五条の六付近のような複雑構造"""
    xml = find_xml_specific('129AC0000000089', '20260401')
    law = parse_law_xml(xml)

    # Subitem を含む article を探す
    target = None
    for art in law['articles']:
        for para in art['paragraphs']:
            for item in para.get('items', []):
                for sub in item.get('sub_items', []):
                    if sub.get('subitem_title'):
                        target = (art, para, item, sub)
                        break
                if target:
                    break
            if target:
                break
        if target:
            break

    if not target:
        return report('T3 Subitem+Column', False, 'Subitem を持つ条文が見つからない')

    art, para, item, sub = target
    # Subitem に sentences があるか (Column 経由)
    has_sentences = bool(sub.get('sentences'))
    checks = [
        (sub.get('subitem_title') in ['イ', 'ロ', 'ハ', 'ニ', 'ホ', 'ヘ', 'ト', 'チ', 'リ'],
         f'subitem_title={sub.get("subitem_title")}'),
        (has_sentences, f'sentences={len(sub.get("sentences", []))}'),
    ]
    ok = all(c[0] for c in checks)
    detail = f'article={art["title"]}\nitem={item.get("item_title")}\n'
    detail += '\n'.join(f'{c[1]}: {"OK" if c[0] else "NG"}' for c in checks)
    return report('T3 Subitem+Column', ok, detail)


def test_t4_same_title_articles():
    """T4: 同名条文の存在を確認 (本則と附則で同じ title)"""
    xml = find_xml_specific('129AC0000000089', '20260401')
    law = parse_law_xml(xml)

    # title ベースで集計
    title_counts: dict[str, int] = {}
    for art in law['articles']:
        title_counts[art['title']] = title_counts.get(art['title'], 0) + 1

    duplicates = {t: c for t, c in title_counts.items() if c > 1}
    has_duplicates = len(duplicates) > 0

    detail = f'duplicate titles: {len(duplicates)}'
    if duplicates:
        detail += '\nfirst 3 examples: ' + str(list(duplicates.items())[:3])

    # 同名条文が存在することを確認 (caption で区別される前提)
    # 民法には附則条文があるので必ず同名は出る (民法は附則 第一条 などがあるはず)
    ok = has_duplicates  # 重複が存在することが期待される (区別は caption で)
    return report('T4 Same-title articles', ok, detail)


def test_t5_appdx_table():
    """T5: 商業登記法 — 別表 AppdxTable の検出"""
    # 商業登記法は LARGE_075 候補だが普通のチャンクに入っている
    # 登録免許税法 (342AC0000000035) の方が別表あり
    try:
        xml = find_xml_specific('342AC0000000035')
    except FileNotFoundError as e:
        return report('T5 AppdxTable', False, str(e))

    law = parse_law_xml(xml)

    appdx = [a for a in law['articles'] if a.get('type') == 'appdx_table']

    detail = f'law_title={law["law_title"]}\nappdx_table count: {len(appdx)}'
    if appdx:
        detail += f'\nfirst: {appdx[0]["title"]} {appdx[0]["caption"]}'
        detail += f'\nfull_text head: {appdx[0]["full_text"][:100]}'

    ok = len(appdx) > 0
    return report('T5 AppdxTable', ok, detail)


def test_t6_bengoshi_ruby():
    """T6: 弁護士法 第二条 — Ruby 切り捨てが起きていないか"""
    try:
        xml = find_xml_specific('324AC0000000205')
    except FileNotFoundError:
        # 旧 ID 形式
        try:
            xml = find_xml_specific('324AC1000000205')
        except FileNotFoundError as e:
            return report('T6 Bengoshi Ruby', False, str(e))

    law = parse_law_xml(xml)
    art = next((a for a in law['articles'] if a['title'] == '第二条'), None)
    if not art:
        return report('T6 Bengoshi Ruby', False, '第二条が見つからない')

    # 第二条本文の Ruby 処理確認:
    #   元 XML: <Ruby>陶<Rt>とう</Rt></Ruby>や → "陶や" になっているはず
    #   旧バグ:  途切れて "陶" だけ、または振り仮名 "とう" が混入
    full = art['full_text']
    detail = f'第二条 full_text length: {len(full)}\n'
    detail += f'tail: ...{full[-60:]}'
    checks = [
        ('陶やに努め' in full, 'Ruby「陶や」が正しく展開されている'),
        ('とう' not in full, 'Rt 振り仮名「とう」が混入していない'),
    ]
    ok = all(c[0] for c in checks)
    detail += '\n' + '\n'.join(f'{c[1]}: {"OK" if c[0] else "NG"}' for c in checks)
    return report('T6 Bengoshi Ruby', ok, detail)


def main():
    tests = [
        test_t1_minpo_article_1,
        test_t2_ruby_in_caption,
        test_t3_subitem_with_column,
        test_t4_same_title_articles,
        test_t5_appdx_table,
        test_t6_bengoshi_ruby,
    ]
    results = []
    for t in tests:
        try:
            results.append(t())
        except Exception as e:
            print(f'[ERROR] {t.__name__}: {type(e).__name__}: {e}')
            results.append(False)
        print()

    passed = sum(1 for r in results if r)
    total = len(results)
    print(f'=== {passed}/{total} passed ===')
    sys.exit(0 if passed == total else 1)


if __name__ == '__main__':
    main()
