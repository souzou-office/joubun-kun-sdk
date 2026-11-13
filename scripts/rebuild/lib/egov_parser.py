# -*- coding: utf-8 -*-
"""
e-Gov 法令 XML 統合パーサー

過去の修正 (regenerate_v2_with_subitems / fix_all_subitems_v2 / add_beppyo_to_chunks /
fix_ruby_truncated_laws) を1つに集約した実装。

機能:
  - Article (条) / Paragraph (項) / Item (号) / Subitem (イ・ロ・ハ) 再帰パース (深さ無制限)
  - AppdxTable (別表) パース → article として出力 (type="appdx_table")
  - Ruby (<Rt>) 事前削除で振り仮名混入を防止
  - 同名条文を (title, caption) タプルキーで区別
  - Column 要素対応 (Subitem1Sentence 内の Column を sentences に展開)
  - 法令メタデータ (LawNum, LawTitle, LawType, Era, Year, Num, PromulgateDate) 抽出

入力:  XML ファイルパス
出力:  dict (シリアライズ可能)
  {
    "law_id": "...",
    "law_title": "...",
    "law_num": "...",
    "law_type": "Act|CabinetOrder|...",
    "era": "Meiji|Taisho|Showa|Heisei|Reiwa",
    "year": "29",
    "num": "089",
    "promulgate_date": "1896-04-27",
    "articles": [
      {
        "type": "article",
        "number": "3",
        "title": "第三条",
        "caption": "（基本原則）",
        "paragraphs": [
          {
            "num": "1",
            "sentences": [{"num": "1", "text": "..."}],
            "items": [...]
          }
        ],
        "full_text": "...",
        "embedding_text": "..."
      },
      {
        "type": "appdx_table",
        "title": "別表第一",
        "caption": "（第六条関係）",
        "paragraphs": [...]
      }
    ]
  }
"""

from __future__ import annotations

import re
from copy import deepcopy
from pathlib import Path
from typing import Any

from lxml import etree


# ============================================================
# Ruby 前処理
# ============================================================

def strip_ruby(root: etree._Element) -> None:
    """
    XML ツリーから <Rt> 要素を破壊的に削除する。

    e-Gov の Ruby は <Ruby>陶<Rt>とう</Rt></Ruby> 形式。
    Rt を削除すると Ruby に残るのは Rb のテキストのみで、
    後段の get_text_content が振り仮名を混入させない。

    Rt の tail (Rt の閉じタグ後のテキスト) は保持する必要があるが、
    e-Gov の構造では Rt は Ruby の最後の子なので tail は通常存在しない。
    念のため tail があれば親要素に引き継ぐ。
    """
    for rt in root.iter('Rt'):
        parent = rt.getparent()
        if parent is None:
            continue
        # Rt の tail を保持 (通常は空だが念のため)
        if rt.tail:
            prev = rt.getprevious()
            if prev is not None:
                prev.tail = (prev.tail or '') + rt.tail
            else:
                parent.text = (parent.text or '') + rt.tail
        parent.remove(rt)


# ============================================================
# テキスト抽出
# ============================================================

def get_text(elem: etree._Element | None) -> str:
    """要素配下の全テキストを再帰的に連結して返す。"""
    if elem is None:
        return ''
    parts: list[str] = []
    if elem.text:
        parts.append(elem.text)
    for child in elem:
        parts.append(get_text(child))
        if child.tail:
            parts.append(child.tail)
    return ''.join(parts).strip()


def parse_sentence(sent_elem: etree._Element) -> dict[str, str]:
    """<Sentence> をパース。"""
    return {
        'num': sent_elem.get('Num', '1'),
        'text': get_text(sent_elem),
    }


# ============================================================
# Subitem (イ・ロ・ハ・(イ)(ロ)(ハ) ...) 再帰
# ============================================================

def parse_subitem(subitem_elem: etree._Element, level: int = 1) -> dict[str, Any]:
    """
    <Subitem{N}> を再帰的にパース。深さ無制限。

    構造:
      <Subitem1 Num="1">
        <Subitem1Title>イ</Subitem1Title>
        <Subitem1Sentence>
          <Sentence>...</Sentence>
          または
          <Column Num="1"><Sentence>...</Sentence></Column>
          <Column Num="2"><Sentence>...</Sentence></Column>
        </Subitem1Sentence>
        <Subitem2 Num="1">...</Subitem2>
        ...
      </Subitem1>
    """
    title_tag = f'Subitem{level}Title'
    sentence_tag = f'Subitem{level}Sentence'
    next_subitem_tag = f'Subitem{level + 1}'

    title_elem = subitem_elem.find(title_tag)
    title = get_text(title_elem) if title_elem is not None else ''

    sentences: list[dict[str, str]] = []
    sentence_container = subitem_elem.find(sentence_tag)
    if sentence_container is not None:
        # Column 配下の Sentence と直下の Sentence の両方を拾う
        for sent in sentence_container.findall('.//Sentence'):
            sentences.append(parse_sentence(sent))

    # Subitem 直下に Sentence が来るケースもある (e-Gov の旧フォーマット)
    for sent in subitem_elem.findall('Sentence'):
        sentences.append(parse_sentence(sent))

    result: dict[str, Any] = {
        'subitem_num': subitem_elem.get('Num', ''),
        'subitem_title': title,
        'sentences': sentences,
    }

    # 下位 Subitem を再帰
    sub_subitems = [
        parse_subitem(sub, level + 1)
        for sub in subitem_elem.findall(next_subitem_tag)
    ]
    if sub_subitems:
        result['sub_items'] = sub_subitems

    return result


# ============================================================
# Item (号: 一・二・三・...)
# ============================================================

def parse_item(item_elem: etree._Element) -> dict[str, Any]:
    """<Item> (号) をパース。"""
    item_num = item_elem.get('Num', '')

    title_elem = item_elem.find('ItemTitle')
    item_title = get_text(title_elem) if title_elem is not None else ''

    sentences: list[dict[str, str]] = []
    item_sentence = item_elem.find('ItemSentence')
    if item_sentence is not None:
        for sent in item_sentence.findall('.//Sentence'):
            sentences.append(parse_sentence(sent))

    result: dict[str, Any] = {
        'item_num': item_num,
        'item_title': item_title,
        'sentences': sentences,
    }

    # Subitem1 から再帰
    sub_items = [parse_subitem(s, 1) for s in item_elem.findall('Subitem1')]
    if sub_items:
        result['sub_items'] = sub_items

    return result


# ============================================================
# Paragraph (項)
# ============================================================

def parse_paragraph(para_elem: etree._Element) -> dict[str, Any]:
    """<Paragraph> (項) をパース。"""
    para_num = para_elem.get('Num', '1')

    sentences: list[dict[str, str]] = []
    para_sentence = para_elem.find('ParagraphSentence')
    if para_sentence is not None:
        for sent in para_sentence.findall('.//Sentence'):
            sentences.append(parse_sentence(sent))

    result: dict[str, Any] = {
        'num': para_num,
        'sentences': sentences,
    }

    items = [parse_item(it) for it in para_elem.findall('Item')]
    if items:
        result['items'] = items

    return result


# ============================================================
# Article (条)
# ============================================================

def parse_article(article_elem: etree._Element, law_title: str) -> dict[str, Any]:
    """
    <Article> (条) をパース。
    full_text と embedding_text も同時に生成する。
    """
    article_num = article_elem.get('Num', '')

    title_elem = article_elem.find('ArticleTitle')
    article_title = get_text(title_elem) if title_elem is not None else ''

    caption_elem = article_elem.find('ArticleCaption')
    caption = get_text(caption_elem) if caption_elem is not None else ''

    paragraphs = [parse_paragraph(p) for p in article_elem.findall('Paragraph')]

    full_text = build_full_text(article_title, caption, paragraphs)
    embedding_text = build_embedding_text(law_title, article_title, caption, paragraphs)

    return {
        'type': 'article',
        'number': article_num,
        'title': article_title,
        'caption': caption,
        'paragraphs': paragraphs,
        'full_text': full_text,
        'embedding_text': embedding_text,
    }


# ============================================================
# 条立てのない法令の本則・附則（項だけ）
# ============================================================

MAIN_PROVISION_TITLE = '本則'
SUPPL_PROVISION_TITLE = '附則'


def _synthetic_article(title: str, caption: str, paragraphs: list[dict[str, Any]], law_title: str) -> dict[str, Any]:
    return {
        'type': 'article',
        'number': '',
        'title': title,
        'caption': caption,
        'paragraphs': paragraphs,
        'full_text': build_full_text(title, caption, paragraphs),
        'embedding_text': build_embedding_text(law_title, title, caption, paragraphs),
    }


def synthesize_articles_for_article_less_law(root: etree._Element, law_title: str) -> list[dict[str, Any]]:
    """
    <Article> を持たない法令の本則・附則を、条文と同じ形の要素にして返す。

    - <MainProvision> 直下の <Paragraph> → 1 件（title「本則」）
    - 各 <SupplProvision> 直下の <Paragraph> → 1 件ずつ（title「附則」。改正法の附則は caption に法令番号、
      structure に suppl / amend_law_num）。本則が無ければ附則も出さない
    """
    main = root.find('.//MainProvision')
    if main is None:
        return []
    main_paras = [parse_paragraph(p) for p in main.findall('Paragraph')]
    if not main_paras:
        return []
    out: list[dict[str, Any]] = [_synthetic_article(MAIN_PROVISION_TITLE, '', main_paras, law_title)]
    for sp in root.findall('.//SupplProvision'):
        paras = [parse_paragraph(p) for p in sp.findall('Paragraph')]
        if not paras:
            continue
        amend = sp.get('AmendLawNum', '')
        art = _synthetic_article(SUPPL_PROVISION_TITLE, f'（{amend}）' if amend else '', paras, law_title)
        art['structure'] = {'suppl': True, **({'amend_law_num': amend} if amend else {})}
        out.append(art)
    return out


# ============================================================
# AppdxTable (別表)
# ============================================================

def parse_appdx_table(appdx_elem: etree._Element, law_title: str) -> dict[str, Any]:
    """
    <AppdxTable> (別表) をパース。
    Article と同列の構造体として返す (type="appdx_table")。

    XML 構造:
      <AppdxTable>
        <AppdxTableTitle>別表第一</AppdxTableTitle>
        <RelatedArticleNum>（第六条関係）</RelatedArticleNum>
        <Item>...</Item>
        <TableStruct>
          <Table>
            <TableRow><TableColumn>...</TableColumn>...</TableRow>
          </Table>
        </TableStruct>
        <Remarks>備考</Remarks>
      </AppdxTable>

    出力ルール:
      - title: <AppdxTableTitle> のテキスト
      - caption: <RelatedArticleNum> のテキスト
      - paragraphs: 1段落に集約。テーブルセルは全角スペース 　 で結合
        (フロントの正規表現が項目区切りとして全角スペースを検出する仕様と整合)
    """
    title_elem = appdx_elem.find('AppdxTableTitle')
    title = get_text(title_elem) if title_elem is not None else ''

    related_elem = appdx_elem.find('RelatedArticleNum')
    related = get_text(related_elem) if related_elem is not None else ''

    # 「概要」テキスト (Item要素や Remarks など、Table 以外のテキスト)
    intro_sentences: list[dict[str, str]] = []
    items: list[dict[str, Any]] = []
    text_parts: list[str] = []  # full_text 用に全テキストを集約

    # 別表先頭の説明 (Item 要素) - 通則。parse_item で階層 (Subitem1/2/3...) を保持
    item_num_counter = 0
    for item in appdx_elem.findall('Item'):
        parsed = parse_item(item)
        # items 配列に追加 (条文の号と同じ形式)
        item_num_counter += 1
        items.append({
            'item_num': str(item_num_counter),
            'item_title': parsed.get('item_title') or '',
            'sentences': parsed.get('sentences') or [],
            'sub_items': parsed.get('sub_items') or [],
        })
        # full_text 用に文字列も集約 (sub_items 含めて再帰)
        def _walk_for_text(node: dict[str, Any]) -> None:
            t = node.get('item_title') or node.get('subitem_title') or ''
            if t:
                text_parts.append(t)
            for s in node.get('sentences') or []:
                if s.get('text'):
                    text_parts.append(s['text'])
            for child in node.get('sub_items') or []:
                _walk_for_text(child)
        _walk_for_text(parsed)

    # Table 内: 1 TableRow を 1 item として構造化
    # これにより各行 (法令の号・細目) ごとに別エンベディング/別表示が可能になる
    # （旧実装は全部 1 つのフラットテキストにしていた）
    item_num_counter = 0
    # いろは順（イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス）全カバー
    # 数字・漢数字 (一、二、（一）、（二） 等) も含む
    item_title_pattern = re.compile(
        r'^\s*((?:[一二三四五六七八九十百千0-9]+)'
        r'|（[一二三四五六七八九十百千0-9]+）'
        r'|[イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス](?=\s|　))'
    )
    for table in appdx_elem.findall('.//Table'):
        for row in table.findall('.//TableRow'):
            col_texts: list[str] = []
            for col in row.findall('.//TableColumn'):
                t = get_text(col)
                if t:
                    col_texts.append(t)
            if not col_texts:
                continue

            # 先頭テキストから 号番号 (一、（一）、イ 等) を推定
            first_text = col_texts[0].lstrip()
            m = item_title_pattern.match(first_text)
            item_title_str = m.group(1) if m else ''

            # item_title 抽出時は、本文側の先頭から該当部分 + 続く空白を除去
            # （badge と本文に同じ文字が重複表示されるのを防ぐ）
            if item_title_str:
                # 元のテキストから先頭の "イ　" / "一　" / "（一）　" 等を除去
                stripped_first = re.sub(
                    r'^\s*' + re.escape(item_title_str) + r'[\s　]*',
                    '',
                    col_texts[0],
                    count=1,
                )
                row_text = '　'.join([stripped_first, *col_texts[1:]]) if col_texts[1:] else stripped_first
            else:
                row_text = '　'.join(col_texts)

            text_parts.append(row_text)

            item_num_counter += 1
            items.append({
                'item_num': str(item_num_counter),
                'item_title': item_title_str,
                'sentences': [{'num': '1', 'text': row_text}],
            })

    # Remarks (備考)
    for remarks in appdx_elem.findall('.//Remarks'):
        t = get_text(remarks)
        if t:
            text_parts.append(t)
            # 備考は intro_sentences と同じレイヤに追加
            intro_sentences.append({'num': str(len(intro_sentences) + 1), 'text': t})

    full_body = ' '.join(text_parts)
    full_text = (related + ' ' + full_body).strip() if related else full_body

    # paragraphs 構築:
    # - items がある場合: sentences は intro_sentences のみ (Remarks 等)。
    #   items に全コンテンツが入っているので sentences で重複させない
    # - items が空の場合: sentences に full_text を入れて旧データ互換
    paragraph: dict[str, Any] = {
        'num': '1',
    }
    if items:
        paragraph['sentences'] = intro_sentences  # 空でも構わない (Remarks があれば入る)
        paragraph['items'] = items
    else:
        paragraph['sentences'] = intro_sentences if intro_sentences else [{'num': '1', 'text': full_text}]

    paragraphs = [paragraph]

    embedding_text = build_embedding_text(law_title, title, related, paragraphs)

    return {
        'type': 'appdx_table',
        'number': '',
        'title': title,
        'caption': related,
        'paragraphs': paragraphs,
        'full_text': full_text,
        'embedding_text': embedding_text,
    }


# ============================================================
# AppdxStyle / AppdxNote / AppdxFig / AppdxFormat (様式系の別表) → スタブ
# ============================================================

# タイトル要素は型ごとに異なるため、既知のものを順に探す。
_APPDX_STYLE_TITLE_TAGS = (
    'AppdxStyleTitle', 'AppdxNoteTitle', 'AppdxFigTitle',
    'AppdxFormatTitle', 'AppdxTableTitle', 'ArithFormulaNum',
)


def parse_appdx_style(appdx_elem: etree._Element, law_title: str, type_name: str) -> dict[str, Any]:
    """
    <AppdxStyle>/<AppdxNote>/<AppdxFig>/<AppdxFormat> を軽量スタブとしてパース。

    これらは申告書様式などのフォームで、本体は <Fig src="./pict/xxx.jpg|pdf"> の画像が主体。
    画像はデータ化せず e-Gov から取得して自前ホスト(R2 appdx_images/)する方針のため、ここでは
      - title(様式名) + caption(対応条文) + images(画像srcの一覧)
      - TableStruct 等のテキストがあれば body として保持(画像が無いテキスト表別表が空にならないように)
    を持つスタブを返す。Worker/フロントは images があれば画像表示、無ければ body 表示。
    """
    title = ''
    for tag in _APPDX_STYLE_TITLE_TAGS:
        e = appdx_elem.find(tag)
        if e is not None and get_text(e):
            title = get_text(e)
            break

    related_elem = appdx_elem.find('RelatedArticleNum')
    related = get_text(related_elem) if related_elem is not None else ''

    # 画像参照 ("./pict/xxx.jpg" → "pict/xxx.jpg" に正規化。R2キーは appdx_images/{law_id}/pict/xxx)
    images: list[str] = []
    for fig in appdx_elem.findall('.//Fig'):
        src = fig.get('src')
        if src:
            images.append(src.lstrip('./'))

    # 本体テキスト(タイトル/対応条文を除く)。画像のみの様式では空になる。
    skip = set(_APPDX_STYLE_TITLE_TAGS) | {'RelatedArticleNum'}
    text_parts: list[str] = []
    for child in appdx_elem:
        if not isinstance(child.tag, str) or child.tag in skip:
            continue
        t = get_text(child)
        if t:
            text_parts.append(t)
    body = ' '.join(text_parts).strip()

    paragraphs = [{'num': '1', 'sentences': [{'num': '1', 'text': body}]}] if body else []
    full_text = (related + ' ' + body).strip() if related else body
    embedding_text = build_embedding_text(law_title, title, related, paragraphs)

    return {
        'type': type_name,
        'number': '',
        'title': title,
        'caption': related,
        'paragraphs': paragraphs,
        'images': images,
        'is_form': True,
        'full_text': full_text,
        'embedding_text': embedding_text,
    }


# ============================================================
# full_text / embedding_text 生成
# ============================================================

def _collect_paragraph_texts(paragraphs: list[dict[str, Any]]) -> list[str]:
    """paragraphs 配下の全テキストを順序通りに収集。"""
    texts: list[str] = []
    for para in paragraphs:
        for sent in para.get('sentences', []):
            if sent.get('text'):
                texts.append(sent['text'])
        for item in para.get('items', []):
            if item.get('item_title'):
                texts.append(item['item_title'])
            for sent in item.get('sentences', []):
                if sent.get('text'):
                    texts.append(sent['text'])
            for sub in item.get('sub_items', []):
                _collect_subitem_texts(sub, texts)
    return texts


def _collect_subitem_texts(subitem: dict[str, Any], texts: list[str]) -> None:
    """sub_items 配下のテキストを再帰的に収集。"""
    if subitem.get('subitem_title'):
        texts.append(subitem['subitem_title'])
    for sent in subitem.get('sentences', []):
        if sent.get('text'):
            texts.append(sent['text'])
    for child in subitem.get('sub_items', []):
        _collect_subitem_texts(child, texts)


def build_full_text(article_title: str, caption: str, paragraphs: list[dict[str, Any]]) -> str:
    """
    full_text を生成 (改行区切り)。
    既存仕様に合わせ caption → title → 本文の順。
    """
    parts: list[str] = []
    if caption:
        parts.append(caption)
    if article_title:
        parts.append(article_title)
    parts.extend(_collect_paragraph_texts(paragraphs))
    return '\n'.join(parts)


def build_embedding_text(
    law_title: str,
    article_title: str,
    caption: str,
    paragraphs: list[dict[str, Any]],
) -> str:
    """
    embedding_text を生成 (スペース区切り)。
    Vectorize 投入時の埋め込みソース。
    既存仕様: "{law_title} {article_title} {caption} {本文...}"
    """
    parts: list[str] = []
    if law_title:
        parts.append(law_title)
    if article_title:
        parts.append(article_title)
    if caption:
        parts.append(caption)
    parts.extend(_collect_paragraph_texts(paragraphs))
    return ' '.join(parts)


# ============================================================
# 法令メタデータ抽出
# ============================================================

ERA_MAP = {
    'Meiji': '明治', 'Taisho': '大正', 'Showa': '昭和',
    'Heisei': '平成', 'Reiwa': '令和',
}


def extract_law_meta(root: etree._Element, law_id: str) -> dict[str, str]:
    """<Law> 要素から法令メタデータを抽出。"""
    law_num_elem = root.find('.//LawNum')
    law_num = get_text(law_num_elem) if law_num_elem is not None else ''

    law_title_elem = root.find('.//LawTitle')
    law_title = get_text(law_title_elem) if law_title_elem is not None else ''

    era = root.get('Era', '')
    year = root.get('Year', '')
    num = root.get('Num', '')
    law_type = root.get('LawType', '')
    promulgate_month = root.get('PromulgateMonth', '')
    promulgate_day = root.get('PromulgateDay', '')

    return {
        'law_id': law_id,
        'law_title': law_title,
        'law_num': law_num,
        'law_type': law_type,
        'era': era,
        'year': year,
        'num': num,
        'promulgate_month': promulgate_month,
        'promulgate_day': promulgate_day,
    }


# ============================================================
# メイン: XML ファイル → law_data dict
# ============================================================

LAW_ID_RE = re.compile(r'^([0-9A-Z]+)_')


def _law_id_from_filename(xml_path: Path) -> str:
    """ファイル名 (またはディレクトリ名) から law_id を取得。

    例: 129AC0000000089_20260401_506AC0000000033.xml → 129AC0000000089
    """
    stem = xml_path.stem
    m = LAW_ID_RE.match(stem)
    return m.group(1) if m else stem


# ============================================================
# 条の位置 (編・章・節・款・目 / 本則・附則)
# ============================================================

# 祖先要素のタグ → structure のキー。見出しは「{タグ}Title」子要素
_STRUCTURE_LEVELS = {
    'Part': 'part',
    'Chapter': 'chapter',
    'Section': 'section',
    'Subsection': 'subsection',
    'Division': 'division',
}


def article_structure(article_elem: etree._Element) -> dict[str, Any]:
    """
    <Article> がどの編・章・節・款・目に属するか、本則か附則かを祖先から拾う。

    返却例:
      {'chapter': '第一章　総則'}                                   本則の第一章
      {'chapter': '第五章　司法書士法人', 'section': '第一節　設立'}  章と節
      {'suppl': True, 'amend_law_num': '昭和二六年六月一三日法律第二三五号'}  改正法の附則
      {'suppl': True}                                               制定時の附則
    見出しが取れない階層は入れない。本則で章立てのない法令は {} になる。
    """
    st: dict[str, Any] = {}
    for anc in article_elem.iterancestors():
        tag = anc.tag
        key = _STRUCTURE_LEVELS.get(tag)
        if key and key not in st:
            title_elem = anc.find(f'{tag}Title')
            title = get_text(title_elem) if title_elem is not None else ''
            if title:
                st[key] = title
        elif tag == 'SupplProvision':
            st['suppl'] = True
            amend = anc.get('AmendLawNum', '')
            if amend:
                st['amend_law_num'] = amend
        elif tag == 'MainProvision':
            break
    return st


def parse_law_xml(xml_path: str | Path, law_id: str | None = None) -> dict[str, Any]:
    """
    XML ファイルを読み込み法令データ dict を返す。

    処理順:
      1. lxml でパース
      2. <Rt> 要素を全削除 (Ruby 振り仮名対策)
      3. メタデータ抽出
      4. <Article> 全件 → articles[]（各条に structure = 編・章・節・附則の所属を付ける）
      5. <AppdxTable> 全件 → articles[] に追加 (type="appdx_table")

    law_id を渡さなければファイル名から取る（{law_id}_{施行日}_{改正法ID}.xml の形式）。
    """
    xml_path = Path(xml_path)

    parser = etree.XMLParser(remove_blank_text=False, recover=True)
    tree = etree.parse(str(xml_path), parser)
    root = tree.getroot()

    # Ruby 振り仮名 (<Rt>) を全削除
    strip_ruby(root)

    law_id = law_id or _law_id_from_filename(xml_path)
    meta = extract_law_meta(root, law_id)

    articles: list[dict[str, Any]] = []

    # 通常の条文
    for article_elem in root.findall('.//Article'):
        art = parse_article(article_elem, meta['law_title'])
        st = article_structure(article_elem)
        if st:
            art['structure'] = st
        articles.append(art)

    # 条立てのない法令（本則が項だけ。宣言・古い勅令・短い特別措置法・指定政令など約 840 本。2026-09-22）:
    # <Article> が 1 つも無いときだけ、本則の項をまとめて 1 件の条文「本則」にし、附則の項があれば「附則」にする
    # （条のある法令の出力は変えない。ファイル名・ベクトル ID は題名から決まるので「本則」「附則」で一意。
    #  条文ページは /law/{law_id}/main で「本則」を出し、「附則」を同じページに畳む）
    if not articles:
        articles.extend(synthesize_articles_for_article_less_law(root, meta['law_title']))

    # 別表 (AppdxTable = データ表。従来どおり行単位に構造化)
    for appdx_elem in root.findall('.//AppdxTable'):
        articles.append(parse_appdx_table(appdx_elem, meta['law_title']))

    # 様式系の別表 (AppdxStyle/Note/Fig/Format = 申告書様式等)。
    # 画像は自前ホスト(R2 appdx_images/)。ここでは title+対応条文+画像src のスタブを生成。
    for _tag, _type in (('AppdxStyle', 'appdx_style'), ('AppdxNote', 'appdx_note'),
                        ('AppdxFig', 'appdx_fig'), ('AppdxFormat', 'appdx_format')):
        for el in root.findall(f'.//{_tag}'):
            articles.append(parse_appdx_style(el, meta['law_title'], _type))

    return {**meta, 'articles': articles}


# ============================================================
# 同名条文の (title, caption) ベース管理用ヘルパー
# ============================================================

def index_articles_by_key(articles: list[dict[str, Any]]) -> dict[tuple[str, str], list[int]]:
    """
    articles を (title, caption) タプルでインデックス化。
    同名条文 (本則と附則の同 title) が caption で区別される。
    重複があり得るので value は list[int] (articles 内の index)。
    """
    index: dict[tuple[str, str], list[int]] = {}
    for i, art in enumerate(articles):
        key = (art.get('title', ''), art.get('caption', ''))
        index.setdefault(key, []).append(i)
    return index


# ============================================================
# CLI (デバッグ用)
# ============================================================

if __name__ == '__main__':
    import json
    import sys

    if len(sys.argv) < 2:
        print('Usage: python egov_parser.py <xml_path>')
        sys.exit(1)

    result = parse_law_xml(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False, indent=2)[:5000])
    print(f'\n... (total articles: {len(result["articles"])})')
