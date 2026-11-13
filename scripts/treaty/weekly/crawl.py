# -*- coding: utf-8 -*-
"""租税条約の週次: 財務省の一覧を取り直し、現行和文 PDF を条件付きで取り（304 は前回のまま）、変わった国だけ 02 の関数で解析する。
R2 にも Vectorize にも書かない（反映の下見の材料を作るだけ。比べるのと反映は build.cjs・apply.cjs）。

  python3 scripts/treaty/weekly/crawl.py --prev PREV.json --prod PROD.json --out OUTDIR

  PREV: 前回反映した状態 {"countries": {国: {"candidates": [url...], "picked": url|null}}, "pdfs": {url: {"etag", "last_modified", "sha256"}}}
        （無い・空なら初回＝全部取り直して解析する）
  PROD: 今の本番に載っている国 {国: src}（src が今回選んだ PDF と同じで、PDF が変わっていなければ解析しない）
  出力: OUTDIR/crawl.json

一覧の選び方は 01 の select()、PDF の読み取りと条の分け方は 02 の extract / split_articles / official_title をそのまま使う（LLM は使わない）。
国ごとの流れ（02 の main と同じ）: 候補（選んだ PDF → 予備）を順に取り、テキスト層が無ければ次へ。全部だめならフェーズ 2（OCR が要る）。
前回と候補が同じで、前回使った PDF まで（その前の予備を含む）がどれも 304 なら「変わらない」（本番のまま使う）。

PDF が取れない（404・5xx・通信の失敗）候補があって、それより前の候補で条文が取れなかった国は「取れなかった」（failed）にする。
テキスト層の無い PDF（取れたが読めない＝フェーズ 2）とは分ける（build が止める理由にする）。

環境変数: TREATY_LIST_URL（一覧の URL。確かめ用）、TREATY_SLEEP_MS（PDF を取る間。既定 500）、TREATY_RETRY_S（取り直しの間の基準秒。既定 1）
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
sys.path.append(str(pathlib.Path(__file__).resolve().parents[2]))  # scripts/（site_config）
import site_config  # noqa: E402

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
HERE = pathlib.Path(__file__).resolve().parent
TREATY = HERE.parent
UA = f'joubun-kun-treaty-crawler/1.0 (+https://joubun-kun.com; contact: {site_config.CRAWLER_CONTACT})'
SLEEP = int(os.environ.get('TREATY_SLEEP_MS', '500')) / 1000
RETRY_S = float(os.environ.get('TREATY_RETRY_S', '1'))


_keep = []   # 01・02 は読み込むと sys.stdout を包み直す。捨てられた包みが閉じると出力が閉じるので、包みを持っておく


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, TREATY / file)
    m = importlib.util.module_from_spec(spec)
    _keep.append(sys.stdout)
    spec.loader.exec_module(m)
    _keep.append(sys.stdout)
    return m


S01 = load('treaty01', '01_scrape_list.py')
S02 = load('treaty02', '02_parse_articles.py')


def get(url, validators=None):
    """→ (status, body|None, {etag, last_modified})。304 は body なし"""
    headers = {'User-Agent': UA}
    if validators:
        if validators.get('etag'):
            headers['If-None-Match'] = validators['etag']
        if validators.get('last_modified'):
            headers['If-Modified-Since'] = validators['last_modified']
    req = urllib.request.Request(url, headers=headers)
    last = None
    for i in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as res:
                body = res.read()
                return 200, body, {'etag': res.headers.get('ETag'), 'last_modified': res.headers.get('Last-Modified')}
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return 304, None, dict(validators or {})
            if e.code == 404:
                raise
            last = e
        except Exception as e:  # 通信の揺れ
            last = e
        time.sleep(RETRY_S * 2 ** i)
    raise last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--prev', required=True)
    ap.add_argument('--prod', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    pdf_dir = out / 'pdf'
    pdf_dir.mkdir(parents=True, exist_ok=True)
    prev = json.loads(pathlib.Path(a.prev).read_text(encoding='utf-8')) if pathlib.Path(a.prev).exists() else {}
    prev_c, prev_pdfs = prev.get('countries') or {}, prev.get('pdfs') or {}
    prod = json.loads(pathlib.Path(a.prod).read_text(encoding='utf-8'))

    list_url = os.environ.get('TREATY_LIST_URL') or S01.URL
    st, html, _ = get(list_url)
    treaties = S01.select(html.decode('utf-8', errors='replace'))

    pdfs = {}          # 今回見た PDF の validators と中身の hash
    bodies = {}        # 今回取った PDF の中身（url → path）
    counts = {'same': 0, 'parsed': 0, 'phase2': 0, 'failed': 0, 'pdf_200': 0, 'pdf_304': 0}
    results, report = [], []

    def fetch(url, conditional):
        v = prev_pdfs.get(url) if conditional else None
        st, body, val = get(url, v)
        if st == 304:
            pdfs[url] = dict(prev_pdfs[url])
            counts['pdf_304'] += 1
            return None
        name = hashlib.md5(url.encode()).hexdigest()[:12] + '_' + url.rsplit('/', 1)[-1]
        p = pdf_dir / name
        p.write_bytes(body)
        bodies[url] = p
        sha = hashlib.sha256(body).hexdigest()
        pdfs[url] = {**val, 'sha256': sha}
        counts['pdf_200'] += 1
        time.sleep(SLEEP)
        # 中身が前回と同じなら（validators が変わっただけ）変わっていない扱い
        return 'same' if url in prev_pdfs and prev_pdfs[url].get('sha256') == sha else p

    for t in treaties:
        name = t['country']
        if S02.SKIP_COUNTRIES.match(name):
            continue
        if not t['chosen']:
            results.append({'country': name, 'status': 'phase2', 'reason': '和文候補なし', 'candidates': [], 'picked': None})
            continue
        cands = [t['chosen']] + t.get('fallbacks', [])
        urls = [c['url'] for c in cands]
        pc = prev_c.get(name)
        # 変わらない: 候補が前回と同じ・前回使った PDF（無ければ全候補）までがどれも 304（か中身が同じ）・本番に同じ PDF で載っている
        if pc and pc.get('candidates') == urls:
            upto = urls[: urls.index(pc['picked']) + 1] if pc.get('picked') in urls else urls
            unchanged = True
            for u in upto:
                try:
                    r = fetch(u, True)
                except Exception as e:
                    report.append(f'  取得失敗 {name}: {u} {e}')
                    r = False
                if r is not None and r != 'same':
                    unchanged = False
            in_prod = (pc.get('picked') is None) or (prod.get(name) == pc.get('picked'))
            if unchanged and in_prod:
                for u in urls[len(upto):]:
                    if u in prev_pdfs:
                        pdfs[u] = dict(prev_pdfs[u])
                st = 'same' if pc.get('picked') else 'phase2'
                counts[st] += 1
                results.append({'country': name, 'status': st, 'candidates': urls, 'picked': pc.get('picked'),
                                **({} if pc.get('picked') else {'reason': 'テキスト層なし(要OCR)（前回と同じ）'})})
                continue
        # 解析する（02 の main と同じ流れ）
        picked = None
        dl_failed = []
        for c in cands:
            u = c['url']
            p = bodies.get(u)
            if p is None:
                try:
                    r = fetch(u, False)
                except Exception as e:
                    report.append(f'  DL失敗 {name}: {u} {e}')
                    dl_failed.append(f'{u} {e}')
                    continue
                p = bodies.get(u)
            full, vertical, jp, en = S02.extract(p)
            if jp < 1000:
                continue  # スキャン → 次候補
            picked = (c, full, vertical, jp, en)
            break
        if dl_failed:
            # 取れなかった候補より後ろの候補で済ませない（取れていれば選ばれた PDF が違うかもしれない）。本番のまま・build が止める
            counts['failed'] += 1
            results.append({'country': name, 'status': 'failed', 'reason': 'PDF が取れない: ' + ' / '.join(dl_failed)[:300], 'candidates': urls, 'picked': None})
            continue
        if not picked:
            counts['phase2'] += 1
            results.append({'country': name, 'status': 'phase2', 'reason': 'テキスト層なし(要OCR)', 'candidates': urls, 'picked': None})
            continue
        c, full, vertical, jp, en = picked
        arts, missed = S02.split_articles(full.split('\n'))
        title = S02.official_title(full, vertical)
        flags = []
        if len(arts) < 8:
            flags.append('条数少（要確認）')
        if missed:
            flags.append(f'末尾に未取得の条見出し{missed}行')
        if en / max(1, jp + en) > 0.3:
            flags.append('英文混入')
        counts['parsed'] += 1
        results.append({'country': name, 'status': 'parsed', 'candidates': urls, 'picked': c['url'],
                        'treaty_title': title, 'doc_type': c['type'], 'source_url': c['url'], 'vertical': vertical,
                        'articles': arts, 'flags': flags})
        report.append(f"  {name}: {len(arts)}条 {'縦' if vertical else '横'} {c['type']} {title[:45]}{' ★' + '・'.join(flags) if flags else ''}")

    (out / 'crawl.json').write_text(json.dumps({'countries': results, 'pdfs': pdfs, 'counts': counts, 'list_url': list_url}, ensure_ascii=False), encoding='utf-8')
    print(f"一覧 {len(treaties)} 行 / 変わらない {counts['same']}・解析 {counts['parsed']}・フェーズ2 {counts['phase2']}・取れない {counts['failed']} / PDF 取得 {counts['pdf_200']}・304 {counts['pdf_304']}")
    print('\n'.join(report))


if __name__ == '__main__':
    main()
