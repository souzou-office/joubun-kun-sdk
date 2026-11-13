# -*- coding: utf-8 -*-
"""02: 01で選定した現行和文PDFをダウンロードし、条単位に分割して
state/treaty_articles.json を出力する。

- 縦書きPDF（官報様式）は1行1文字で抽出されるが読み順は正しい → 改行除去で復元
- 条分割は逐次アンカー方式: 第N条を見つけたら次は第N+1条だけを探す。
  条文中の「第○条」参照やMLI統合条文のボックス（BEPS条約の条番号）に誤爆しない。
- テキスト層がない（スキャン）PDFはフォールバックを試し、全滅ならphase2として記録

  python scripts/treaty/02_parse_articles.py
"""
import io
import json
import pathlib
import re
import sys
import time
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import fitz  # PyMuPDF

STATE = pathlib.Path(__file__).parent / 'state'
PDF_DIR = STATE / 'pdf'
PDF_DIR.mkdir(parents=True, exist_ok=True)

KANJI = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9}
SKIP_COUNTRIES = re.compile(r'^(.行|日台民間租税取決め.*|税務行政執行共助条約|ＢＥＰＳ防止措置実施条約)$')
NUM_RE = r'[一二三四五六七八九十0-9０-９]+'


def kanji_to_int(s):
    s = s.translate(str.maketrans('０１２３４５６７８９', '0123456789'))
    if s.isdigit():
        return int(s)
    # 一〜九十九まで対応（条約は最大でも35条程度）
    if '十' in s:
        a, _, b = s.partition('十')
        return (KANJI.get(a, 1) if a else 1) * 10 + (KANJI.get(b, 0) if b else 0)
    return KANJI.get(s, 0)


def download(url):
    name = url.rsplit('/', 1)[-1]
    dest = PDF_DIR / name
    if dest.exists() and dest.stat().st_size > 1000:
        return dest
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    dest.write_bytes(urllib.request.urlopen(req, timeout=60).read())
    time.sleep(0.5)  # 財務省サーバへの配慮
    return dest


def extract_vertical_page_lines(page):
    """縦書きページを文字座標から列単位で復元する。

    PyMuPDFの既定順は単純ページでは正しいが、官報様式では
    ①ページ番号（下端マージンの横書き数字）が本文に混入し、
    ②号記号 (a)(b) 等（横書きの挿入物）が誤った位置に混ざる。
    実測: 本文=wmode1(縦書き)・列間隔約30pt、(a)(b)=wmode0で本文列のx中心±7内、
    ページ番号=wmode0でy≈794（本文域外）。
    → 縦書き文字で列（x中心のクラスタ）を作り、横書き文字は本文域内なら最近傍列へ
      y位置で挿入、本文域外（マージン）は捨てる。列は右→左、列内は上→下。
    """
    d = page.get_text('rawdict')
    vchars = []   # (x, y, c) 列を定義する文字
    hgroups = []  # (x_center, y, text) 挿入物（号記号(a)(b)等）— グループ単位で扱う
    sizes = {}
    raw_lines = []
    for block in d['blocks']:
        if block['type'] != 0:
            continue
        for line in block['lines']:
            wmode = line.get('wmode', 0)
            chs = []
            for span in line['spans']:
                size = round(span.get('size', 0), 1)
                for ch in span.get('chars', []):
                    x = (ch['bbox'][0] + ch['bbox'][2]) / 2
                    y = (ch['bbox'][1] + ch['bbox'][3]) / 2
                    chs.append((x, y, ch['c'], size))
                    sizes[size] = sizes.get(size, 0) + 1
            if chs:
                raw_lines.append((wmode, chs))
    if not sizes:
        return None
    modal = max(sizes, key=sizes.get)
    has_wmode1 = any(w == 1 for w, _ in raw_lines)
    for w, chs in raw_lines:
        # ルビ・上付き文字（本文の60%未満のサイズ。実測: 本文14.0 vs ルビ5.0）は捨てる
        chs = [c for c in chs if c[3] >= modal * 0.6]
        if not chs:
            continue
        if w == 1 or (not has_wmode1 and ord(chs[0][2]) > 0x2E80):
            # 縦書き本文（ウルグアイ型=全wmode0はCJK先頭で判定）
            vchars.extend((x, y, c) for x, y, c, _ in chs)
        else:
            # 横書き挿入物: 号記号 (a)(b) / ページ番号等。グループごと（分割すると
            # 「b)(」のような括弧転置や、列跨ぎでのラベル脱落が起きる＝監査で実証）
            gx = sum(c[0] for c in chs) / len(chs)
            gy = sum(c[1] for c in chs) / len(chs)
            hgroups.append((gx, gy, ''.join(c[2] for c in chs)))
    if not vchars:
        return None  # 縦書きページではない
    # 本文域（縦書き文字のy範囲）。域外の横書き＝ページ番号等 → 捨てる
    ymin = min(c[1] for c in vchars) - 12
    ymax = max(c[1] for c in vchars) + 12
    # 列クラスタ（x降順、間隔30ptに対して許容12pt）
    cols = []  # [ [x_center, [(y, x, text), ...]], ... ]
    for x, y, c in sorted(vchars, key=lambda t: -t[0]):
        for col in cols:
            if abs(col[0] - x) < 12:
                col[1].append((y, x, c))
                break
        else:
            cols.append([x, [(y, x, c)]])
    # 挿入物グループを最近傍の列へ（距離での破棄はしない＝ラベル脱落の根絶）。
    # 数字のみのグループは位置で区別（実測）:
    #   下マージン（y>ymax）= ページ番号 → 捨てる
    #   上マージン（y<ymin）= 縦中横の項番号（11〜16等）が列頭の上にぶら下がる → 列に割当
    for gx, gy, text in hgroups:
        is_digits = bool(re.fullmatch(r'[0-9０-９\s]+', text))
        if is_digits and gy > ymax:
            continue  # ページ番号
        col = min(cols, key=lambda col: abs(col[0] - gx))
        if is_digits and gy < ymin and abs(col[0] - gx) > 15:
            continue  # 列に紐づかない上部の数字（念のため）
        if not (ymin - 40 <= gy <= ymax + 40):
            continue
        col[1].append((gy, gx, text))
    cols.sort(key=lambda col: -col[0])
    lines = []
    for _, entries in cols:
        # 列内は上→下。同じ高さ（横書きグループの内部）は左→右
        entries.sort(key=lambda t: (round(t[0], 0), t[1]))
        text = ''.join(t[2] for t in entries)
        # 純粋な数字だけの列＝官報の漢数字ページ番号（実測: 本文グリッド外 x≈523 の独立列）
        if re.fullmatch(r'[一二三四五六七八九〇十0-9０-９]{1,4}', text):
            continue
        lines.append(text)
    return lines


def extract_horizontal_page_lines(page):
    """横書きページ: 行単位で抽出し、脚注・上付き文字をサイズで落とす。
    実測(MLI統合条文): 本文14.0pt / 脚注10.6pt / 上付き注番号8.5・6.5pt。
    脚注は本文ブロックの間に挟まって抽出され「（27ページ参照）」等が文中混入していた。"""
    d = page.get_text('dict')
    sizes = {}
    lines = []
    for block in d['blocks']:
        if block['type'] != 0:
            continue
        for line in block['lines']:
            spans = [(round(s.get('size', 0), 1), s['text']) for s in line['spans']]
            if not any(t.strip() for _, t in spans):
                continue
            for sz, t in spans:
                sizes[sz] = sizes.get(sz, 0) + len(t)
            lines.append(spans)
    if not sizes:
        return []
    modal = max(sizes, key=sizes.get)
    out = []
    for spans in lines:
        # スパン単位でフィルタ: 本文行の中に埋まった上付き脚注番号（8.5pt等）も落とす。
        # 行単位だと「与えられない。1」のようにマーカーだけ本文行に残る（再監査で実証）
        txt = ''.join(t for sz, t in spans if sz >= modal * 0.85)
        if txt.strip():
            out.append(txt)
    return out


def normalize_text(s):
    """抽出テキストの字形正規化。
    - 厶(U+53B6 漢字)→ム: PDFのフォント置換でカタカナのムが漢字になる（グア厶/フィル厶で実測）
    - 空の半角鉤括弧 ｢｣ の除去（ルビ位置マークの残骸）"""
    s = re.sub(r'厶(?=[ァ-ヴー])|(?<=[ァ-ヴー])厶', 'ム', s)
    s = s.replace('｢｣', '')
    return s


def extract(pdf_path):
    """テキスト抽出。縦書きページは列再構成、横書きページはサイズフィルタ付き行抽出"""
    doc = fitz.open(pdf_path)
    all_lines = []
    n_vertical = 0
    for i in range(len(doc)):
        page = doc[i]
        default = page.get_text()
        dlines = [ln for ln in default.split('\n') if ln.strip()]
        mean_len = (sum(len(ln.strip()) for ln in dlines) / len(dlines)) if dlines else 0
        if mean_len < 2.5:  # 1行1文字 = 縦書きページ
            vlines = extract_vertical_page_lines(page)
            if vlines:
                n_vertical += 1
                # 官報の字間スペース（「議定 書」「終 了」等）は構造判定を狂わせるので除去
                all_lines.extend(normalize_text(ln.replace('　', '').replace(' ', '')) for ln in vlines)
                continue
        all_lines.extend(normalize_text(ln) for ln in extract_horizontal_page_lines(page))
    doc.close()
    vertical = n_vertical >= 1
    full = '\n'.join(all_lines)
    jp = len(re.findall(r'[ぁ-んァ-ン一-龥]', full))
    en = len(re.findall(r'[A-Za-z]', full))
    return full, vertical, jp, en


def parse_paras(body_lines):
    """条の中身（行リスト）を項・号に構造化する。

    - 項: 行頭の1〜2桁数字。逐次アンカー（次に期待する番号だけ受理）で
      「３１の規定は…」（項3の本文が「１の規定は」で始まる）も正しく分離。
    - 号: (a)(b)… を逐次アンカーで分割。ただし行頭 or 「。」直後のみ
      （「次の(a)及び(b)に該当する」のような文中参照では切らない）。
    戻り値: [{n, t, items: [{l, t}]}]
    """
    # 前処理: 文の切れ目（。）直後の項番号・署名末文・枝番条見出しを行頭に出す。
    # 官報の縦書きでは項が列の途中から始まることがあり（米27条の項11〜16で実証）、
    # 行頭だけ見ていると項番号を取りこぼす。
    pre = []
    for ln in body_lines:
        parts = re.split(r'(?<=。)(?=[0-9０-９]{1,2}(?![0-9０-９年月日人回号項条時箇%％])|以上の証拠として|第[一二三四五六七八九十0-9０-９]+条の[ＡＢＣ])', ln)
        pre.extend(p for p in parts if p.strip())
    body_lines = pre

    # 行を段落テキストへ（日本語なので折返しはそのまま連結。行頭マークの判定用に\nは保持）
    paras = []
    cur = {'n': '', 'lines': []}
    expect = 2  # 行頭「１」は最初の本文と区別しにくいので、1は先頭行のみ特別扱い
    first = True
    for ln in body_lines:
        ln = ln.rstrip()
        if not ln:
            continue
        m = re.match(r'([0-9０-９]{1,2})\s*(.*)$', ln)
        matched_no = None
        rest = None
        if m:
            digits = m.group(1).translate(str.maketrans('０１２３４５６７８９', '0123456789'))
            if first and int(digits[0]) == 1:
                matched_no, rest = 1, (digits[1:] + m.group(2)) if len(digits) > 1 else m.group(2)
            elif int(digits) == expect:
                matched_no, rest = expect, m.group(2)
            elif len(digits) == 2 and int(digits[0]) == expect:
                # 「３１の規定は」= 項3 + 本文「１の規定は」
                matched_no, rest = expect, digits[1] + m.group(2)
        # 参照の誤検知リジェクト: 「（前条１又は）２の規定によって…」の行頭「２」は
        # 項番号ではなく参照（アイルランド3条で実証）
        if matched_no is not None and re.match(r'\s*(の規定|の適用|、|及び|又は|から|まで)', rest or ''):
            matched_no = None
        if matched_no is not None:
            if cur['lines'] or cur['n']:
                paras.append(cur)
            cur = {'n': str(matched_no), 'lines': [rest] if rest else []}
            expect = matched_no + 1
        elif re.match(r'(第[一二三四五六七八九十0-9０-９]+条の[ＡＢＣ]|以上の証拠として)', ln):
            # 枝番条（第二十六条のＡ＝改正議定書での追加条）と署名末文は独立ブロックに
            if cur['lines'] or cur['n']:
                paras.append(cur)
            cur = {'n': '', 'lines': [ln]}
        else:
            cur['lines'].append(ln)
        first = False
    if cur['lines'] or cur['n']:
        paras.append(cur)

    out = []
    for p in paras:
        # 連結しつつ元の行頭位置を記録（号記号は「行頭」か「。直後」に現れる。
        # 「…の租税(b)課税年度に…」のように。なしで行頭に来る号があるため行頭情報が必要）
        text = ''
        line_starts = set()
        for s in p['lines']:
            line_starts.add(len(text))
            text += s.strip()
        items = []
        LETTERS = [chr(c) for c in range(ord('a'), ord('z') + 1)]
        idx = 0
        pos = 0
        starts = []
        while idx < len(LETTERS):
            marker = '(' + LETTERS[idx] + ')'
            k = text.find(marker, pos)
            while k != -1 and not (k == 0 or k in line_starts or text[k - 1] == '。'):
                k = text.find(marker, k + 1)
            if k == -1:
                break
            starts.append((k, marker))
            pos = k + len(marker)
            idx += 1
        if starts:
            main = text[:starts[0][0]]
            for k2, (s, marker) in enumerate(starts):
                e = starts[k2 + 1][0] if k2 + 1 < len(starts) else len(text)
                items.append({'l': marker, 't': text[s + len(marker):e].strip()})
            text = main.strip()
        out.append({'n': p['n'], 't': text, **({'items': items} if items else {})})
    return out


def split_articles(lines):
    """条見出し（行頭「第N条（ 見出し）?」）の逐次アンカーで分割し、項・号も構造化。
    縦書きは列再構成済みなので横書きと同じ行ベースで扱える。"""
    # 文中に埋もれた条見出し（「…通知される。第二十六条１ 両締約国…」）を行頭に出す前処理。
    # 誤って文頭の条参照（「第七条の規定は…」）を切り出しても、下の参照リジェクトで見出し扱いしない。
    pre = []
    for ln in lines:
        parts = re.split(rf'(?<=。)(?=第{NUM_RE}条)', ln)
        pre.extend(p for p in parts if p)
    lines = pre

    heads = []  # (line_idx, no, cap, body_prefix)
    expect = 1
    for i, ln in enumerate(lines):
        m = re.match(rf'\s*第({NUM_RE})条(?![のがを])\s*(.*)$', ln)
        if not m:
            continue
        no = kanji_to_int(m.group(1))
        if no != expect:
            continue  # MLIボックスや参照 → 無視
        rest = m.group(2).strip()
        # 参照の誤検知リジェクト: 条文の冒頭が「第十六条、第十八条…の規定を留保して」のように
        # 別条への参照で始まると、その行頭を見出しと誤認して条ズレが起きる（伊15/16・埃16/17で実証）。
        # 見出し直後に来ない並び（読点・接続・「N の規定」等）なら見出しではない。
        if re.match(rf'([(（]?{NUM_RE}[)）]?)?\s*(の規定|の適用|、|及び|又は|から|まで|に(規定|いう))', rest):
            continue
        # 残りが「見出し」か「本文の書き出し」かを判定（見出しなし文書では本文が同じ行に続く）
        if rest and (len(rest) > 25 or '。' in rest or re.match(r'[1１一]\s|[0-9０-９]|この|一方の', rest)):
            cap, body_prefix = '', rest
        else:
            cap, body_prefix = rest, ''
        heads.append((i, no, cap, body_prefix))
        expect += 1
    def build(body_lines):
        paras = parse_paras(body_lines)
        body = '\n'.join(
            (f"{p['n']} " if p['n'] else '') + p['t'] +
            ''.join('\n' + it['l'] + ' ' + it['t'] for it in p.get('items', []))
            for p in paras
        ).strip()
        return body, paras

    arts = []
    for k, (i, no, cap, body_prefix) in enumerate(heads):
        end = heads[k + 1][0] if k + 1 < len(heads) else len(lines)
        body_lines = ([body_prefix] if body_prefix else []) + lines[i + 1:end]
        body_lines = [ln for ln in body_lines if not re.match(r'^\s*\d+\s*$', ln)]  # ページ番号行（横書き）
        # 最終条: 後続の議定書・交換公文をタイトル行（「議定書」等の単独行）で切り離す。
        # 文字列マーカー探索だと本文中の「この議定書に署名した」等に誤ヒットするため行単位で判定する。
        annex_lines = None
        if k + 1 == len(heads):
            for j, ln in enumerate(body_lines):
                # タイトル単独行（「議定書」）または「…条約に関する議定書」等の短いタイトル行
                if re.match(r'^\s*(議定書|交換公文|附属書)\s*$', ln) or re.match(r'^[^。]{0,42}(条約|協定)に関する議定書$', ln):
                    annex_lines = body_lines[j:]
                    body_lines = body_lines[:j]
                    break
        body, paras = build(body_lines)
        arts.append({'no': no, 'cap': cap, 'body': body, 'paras': paras})
        if annex_lines and sum(len(x) for x in annex_lines) > 300:
            abody, aparas = build(annex_lines[1:])
            arts.append({'no': 0, 'cap': '議定書・交換公文等', 'body': abody, 'paras': aparas})
    # 末尾検証: 最後に採用した条より大きい番号の行頭見出しが残っていないか
    missed = 0
    if heads:
        last_no = heads[-1][1]
        for ln in lines[heads[-1][0] + 1:]:
            m = re.match(rf'\s*第({NUM_RE})条(?![のがを])\s*$', ln)
            if m and kanji_to_int(m.group(1)) > last_no:
                missed += 1
    return arts, missed


def official_title(full, vertical):
    """PDF冒頭から正式名称を拾う"""
    head = (full.replace('\n', '') if vertical else full)[:3000]
    head = re.sub(r'\s', '', head)
    head = re.sub(r'^[0-9０-９一]+|（訳文）', '', head)  # ページ番号・（訳文）の混入除去
    # MLI統合条文: 「…」引用の中の条約名（BEPS防止措置実施条約自体は除く）
    for m in re.finditer(r'「([^「」]{15,120}?(条約|協定))」', head):
        t = m.group(1)
        if 'ＢＥＰＳ' in t or '多数国間' in t or '税源浸食' in t:
            continue
        return t
    # 正式名称は「所得に対する/租税に関する/脱税の防止…」で始まる（前文の説明文を拾わないよう先頭を限定）
    m = re.search(r'((?:所得|租税|脱税)[^。「」]{10,120}?(?:日本国|日本)[^。「」]{0,80}?(?:条約|協定))', head)
    return re.sub(r'^[0-9０-９]+', '', m.group(1)) if m else ''


def main():
    treaties = json.loads((STATE / 'treaties.json').read_text(encoding='utf-8'))
    out = []
    phase2 = []
    report = []
    for t in treaties:
        name = t['country']
        if SKIP_COUNTRIES.match(name):
            continue
        if not t['chosen']:
            phase2.append({'country': name, 'reason': '和文候補なし'})
            continue
        candidates = [t['chosen']] + t.get('fallbacks', [])
        picked = None
        for c in candidates:
            try:
                p = download(c['url'])
            except Exception as e:
                report.append(f"  DL失敗 {name}: {c['url']} {e}")
                continue
            full, vertical, jp, en = extract(p)
            if jp < 1000:
                continue  # スキャン → 次候補
            picked = (c, full, vertical, jp, en)
            break
        if not picked:
            phase2.append({'country': name, 'reason': 'テキスト層なし(要OCR)',
                           'urls': [c['url'] for c in candidates]})
            continue
        c, full, vertical, jp, en = picked
        arts, missed = split_articles(full.split('\n'))
        title = official_title(full, vertical)
        n_caps = sum(1 for a in arts if a['cap'] and a['no'] > 0)
        flag = ''
        if len(arts) < 8:
            flag = ' ★条数少（要確認）'
        if missed:
            flag += f' ★末尾に未取得の条見出し{missed}行'
        en_ratio = en / max(1, jp + en)
        if en_ratio > 0.3:
            flag += ' ★英文混入'
        report.append(f"  {name}: {len(arts)}条 cap{n_caps} {'縦' if vertical else '横'} "
                      f"jp{jp} en率{en_ratio:.2f} {c['type']} {title[:45]}{flag}")
        out.append({
            'country': name,
            'treaty_title': title,
            'doc_type': c['type'],
            'source_url': c['url'],
            'vertical': vertical,
            'articles': arts,
        })
    # スロバキア: チェコスロバキア1977条約が承継適用される。チェコ選定分がその
    # タイプ版（テキスト層あり）なら流用する（スキャンしか無いスロバキアを救済）
    cz = next((x for x in out if x['country'] == 'チェコ'), None)
    if cz and 'チェッコスロヴァキア' in cz['treaty_title']:
        sk = next((p for p in phase2 if p['country'] == 'スロバキア'), None)
        if sk:
            phase2.remove(sk)
            out.append({**cz, 'country': 'スロバキア',
                        'note': 'チェコスロバキア条約の承継適用（チェコと同一文書）'})

    (STATE / 'treaty_articles.json').write_text(
        json.dumps(out, ensure_ascii=False), encoding='utf-8')
    (STATE / 'treaty_phase2.json').write_text(
        json.dumps(phase2, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'パース成功: {len(out)}か国 / フェーズ2送り: {len(phase2)}')
    print('\n'.join(report))
    print('\n--- フェーズ2（スキャンのみ・要OCR） ---')
    for p in phase2:
        print(f"  {p['country']}: {p['reason']}")


if __name__ == '__main__':
    main()
