# -*- coding: utf-8 -*-
"""01: 財務省「我が国の租税条約等の一覧」をパースし、国ごとの文書一覧と
「現行和文テキスト」の選定結果を state/treaties.json に出力する。

現行テキストの優先順位（フェーズ1 = テキスト層があるものだけ）:
  1. MLI統合条文 Synthesi[sz]edText*_JP.pdf（複数あれば末尾番号が最大 = 最新の通告版）
  2. 議定書統合条文 *_ST_jp.pdf
  3. 発効日のある最新の条約本文の和文PDF（テキスト層の有無は 02 で判定しフォールバック）
※未発効（署名のみ）の新条約を現行と誤認しないため、3は「発効日：」がある区画に限る。

  python scripts/treaty/01_scrape_list.py
"""
import io
import json
import pathlib
import re
import sys
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

URL = 'https://www.mof.go.jp/tax_policy/summary/international/tax_convention/tax_convetion_list_jp.html'
STATE = pathlib.Path(__file__).parent / 'state'
STATE.mkdir(exist_ok=True)

try:
    from bs4 import BeautifulSoup
except ImportError:
    print('bs4 required: pip install beautifulsoup4')
    sys.exit(1)


def fetch_html():
    cache = STATE / 'mof_treaty_list.html'
    if cache.exists():
        return cache.read_text(encoding='utf-8', errors='replace')
    req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0'})
    html = urllib.request.urlopen(req).read().decode('utf-8', errors='replace')
    cache.write_text(html, encoding='utf-8')
    return html


def norm_url(href):
    href = (href or '').strip()
    href = href.replace('http://www.mof.go.jp', 'https://www.mof.go.jp')
    return href


def is_country_cell(td):
    style = td.get('style') or ''
    return 'background-color' in style.replace(' ', '') and '#f5f5f5' in style


def select(html):
    """一覧の HTML → 国ごとの文書と現行和文テキストの選定（週次 scripts/treaty/weekly/crawl.py と共用）"""
    soup = BeautifulSoup(html, 'html.parser')

    countries = {}   # name -> { docs: [...] }
    order = []
    current = None
    current_block = ''  # 原条約 / 改正議定書 / 交換公文 / BEPS防止措置実施条約 等
    block_has_effective = False

    for tr in soup.find_all('tr'):
        tds = tr.find_all('td')
        if not tds:
            continue
        for td in tds:
            if is_country_cell(td):
                name = re.sub(r'\s+', '', td.get_text())
                if name:
                    current = name
                    if name not in countries:
                        countries[name] = {'docs': []}
                        order.append(name)
                    current_block = ''
                    block_has_effective = False
        if current is None:
            continue
        row_text = re.sub(r'\s+', ' ', tr.get_text(' '))
        # 区画見出し（署名日・発効日を含むセル）を検出
        m = re.search(r'(原条約|新条約|改正議定書|議定書|交換公文|情報交換協定|新協定|原協定|BEPS防止措置実施条約|租税協定)', row_text)
        if m and re.search(r'署名日|通告日|発効日', row_text):
            current_block = m.group(1)
            block_has_effective = ('発効日' in row_text)
        for a in tr.find_all('a'):
            href = norm_url(a.get('href'))
            if not href or not href.lower().endswith('.pdf'):
                continue
            label = re.sub(r'\s+', '', a.get_text())
            countries[current]['docs'].append({
                'label': label,             # 和文 / 英文 / 和文・英文 / 概要 等
                'url': href,
                'block': current_block,
                'block_effective': block_has_effective,
                'row_text': row_text[:120],
            })

    # 現行和文テキストの選定
    out = []
    for name in order:
        docs = countries[name]['docs']
        jp_docs = [d for d in docs if '和文' in d['label']]

        synth = [d for d in jp_docs if re.search(r'Synthesi[sz]edText.*_JP\.pdf', d['url'], re.I)]
        st = [d for d in jp_docs if re.search(r'_ST_jp\.pdf', d['url'], re.I)]
        # 発効済み区画の条約本文（議定書・交換公文は除く: 本文は 原条約/新条約/協定 系の区画）
        conv = [d for d in jp_docs
                if d['block'] in ('原条約', '新条約', '情報交換協定', '新協定', '原協定', '租税協定')
                and d['block_effective']
                and not re.search(r'Synthesi[sz]edText|_ST_', d['url'], re.I)]

        chosen = None
        fallbacks = []
        if synth:
            def synth_ver(d):
                m2 = re.search(r'(\d+)_JP\.pdf', d['url'], re.I)
                return int(m2.group(1)) if m2 else 0
            synth.sort(key=synth_ver, reverse=True)
            chosen = {'type': 'MLI統合条文', 'url': synth[0]['url']}
            fallbacks = [{'type': 'MLI統合条文', 'url': d['url']} for d in synth[1:]]
        elif st:
            chosen = {'type': '統合条文', 'url': st[0]['url']}
        elif conv:
            # 年をURL/区画テキストから推定して新しい順
            def year_of(d):
                m2 = re.search(r'(19|20)\d{2}', d['url'])
                return int(m2.group(0)) if m2 else 0
            conv.sort(key=year_of, reverse=True)
            chosen = {'type': '条約本文', 'url': conv[0]['url']}
            fallbacks = [{'type': '条約本文', 'url': d['url']} for d in conv[1:]]

        out.append({
            'country': name,
            'chosen': chosen,
            'fallbacks': fallbacks,
            'docs': docs,
        })

    return out


def main():
    out = select(fetch_html())
    (STATE / 'treaties.json').write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')

    n_synth = sum(1 for t in out if t['chosen'] and t['chosen']['type'] == 'MLI統合条文')
    n_st = sum(1 for t in out if t['chosen'] and t['chosen']['type'] == '統合条文')
    n_conv = sum(1 for t in out if t['chosen'] and t['chosen']['type'] == '条約本文')
    n_none = sum(1 for t in out if not t['chosen'])
    print(f'国・地域: {len(out)}')
    print(f'  MLI統合条文: {n_synth} / 統合条文: {n_st} / 条約本文: {n_conv} / 候補なし: {n_none}')
    for t in out:
        c = t['chosen']
        print(f"  {t['country']}: {c['type'] if c else '---'} {c['url'].rsplit('/', 1)[-1] if c else ''}")


if __name__ == '__main__':
    main()
