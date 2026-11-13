# -*- coding: utf-8 -*-
"""
国税庁(NTA)から法人税の別表様式PDFを取得し、法令(法人税法施行規則)の別表に対応づけるスクリプト。

背景:
  e-Gov の法令データには法人税法施行規則の別表(別表一付表 等)の画像が収録されていない
  (Fig src が空)。実物の様式は国税庁が年度別ページでPDF配布している。
  → 国税庁のPDFをスクレイプし、法令の別表(title+caption)と「説明文(caption)」で突合して
     「法令の別表 → 国税庁PDF」のマッピングを作り、PDFを自前取得する。

突合方法:
  法令側 appdx_style の caption (= RelatedArticleNum, 例「中小通算法人等の軽減対象所得金額の…明細書」)
  と、NTA一覧表の各行の説明文が一致する。番号体系(別表一(一) vs 別表一)は揺れるので説明文で照合。

出力:
  rebuild_output/nta_beppyo/{law_id}/{safe_title}.pdf
  rebuild_output/nta_beppyo/{law_id}/_manifest.json   # title→pdf, source_url, unmatched

使い方:
  python scripts/rebuild/12_fetch_nta_beppyo.py            # 取得実行
  python scripts/rebuild/12_fetch_nta_beppyo.py --dry-run  # 突合だけ(DLしない)
"""
from __future__ import annotations
import argparse, json, re, sys, urllib.request
from pathlib import Path
from datetime import datetime, timezone
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = {'User-Agent': f'Mozilla/5.0 (joubun-kun legal reference; {site_config.CRAWLER_CONTACT})'}
HOST = 'https://www.nta.go.jp'
# 法人税等各種別表 一覧(令和7年4月〜令和8年3月提供分)
NTA_INDEX = HOST + '/taxes/tetsuzuki/shinsei/annai/hojin/shinkoku/itiran2025/01.htm'
LAW_ID = '340M50000040012'  # 法人税法施行規則
FETCHED = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/fetched_laws/{LAW_ID}.json')
OUT_DIR = Path(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/nta_beppyo/{LAW_ID}')

_INVALID = {'/': '／', '\\': '＼', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜'}

def safe_filename(title: str) -> str:
    s = title or '_unnamed'
    for b, g in _INVALID.items():
        s = s.replace(b, g)
    return s.rstrip(' .') or '_unnamed'

def strip_tags(s: str) -> str:
    return re.sub(r'<[^>]+>', '', s or '')

def norm(s: str) -> str:
    s = strip_tags(s)
    s = re.sub(r'（PDF[^）]*）|PDF/[\d,]+KB', '', s)
    for d in '―－ー‐−':
        s = s.replace(d, '-')
    return re.sub(r'[\s　]', '', s)

def is_form_pdf(href: str) -> bool:
    bn = href.rsplit('/', 1)[-1]
    if bn.startswith('r01-') or bn.startswith('f02-'):   # 留意点 / 判定 等の解説PDF
        return False
    if bn.endswith('-ki.pdf') or '-ki-' in bn:           # 記載例
        return False
    return bn.endswith('.pdf')

def fetch(url: str) -> str:
    raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()
    for enc in ('cp932', 'utf-8', 'shift_jis', 'euc-jp'):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode('utf-8', 'ignore')

def fetch_bytes(url: str) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()

def scrape_rows(html: str):
    """NTA一覧から (説明文, 説明文正規化, [様式PDF URL]) の行リストを作る。"""
    rows = []
    for tr in re.findall(r'<tr[^>]*>.*?</tr>', html, re.S | re.I):
        forms = [HOST + p for p in re.findall(r'href="([^"]+\.pdf)"', tr) if is_form_pdf(p)]
        if not forms:
            continue
        desc = ''
        for c in re.findall(r'<td[^>]*>(.*?)</td>', tr, re.S | re.I):
            t = strip_tags(c).strip()
            if re.search(r'(申告書|明細書|計算書|計算に関する|に関する明細|届出|の計算書|表)', t) and len(t) > len(desc):
                desc = t
        rows.append({'desc': desc, 'desc_norm': norm(desc), 'forms': forms})
    return rows

def main() -> int:
    ap = argparse.ArgumentParser(description='Fetch NTA corporate-tax appendix PDFs and map to law beppyo')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    print('NTA一覧を取得:', NTA_INDEX)
    rows = scrape_rows(fetch(NTA_INDEX))
    print('  様式PDFを持つ行:', len(rows))

    law = json.load(FETCHED.open(encoding='utf-8'))
    beps = [a for a in law.get('articles', []) if a.get('type') == 'appdx_style' and a.get('caption')]
    print('  法令の別表(caption付き):', len(beps))

    mappings, unmatched = [], []
    for b in beps:
        cn = norm(b['caption'])
        hit = None
        if len(cn) >= 4:
            for r in rows:
                if r['desc_norm'] and (cn in r['desc_norm'] or r['desc_norm'] in cn):
                    hit = r
                    break
        if hit:
            mappings.append({'title': b['title'], 'caption': b['caption'],
                             'pdf_url': hit['forms'][0],
                             'pdf_file': safe_filename(b['title']) + '.pdf'})
        else:
            unmatched.append({'title': b['title'], 'caption': b['caption']})

    print(f'  マッチ: {len(mappings)} / {len(beps)}  非マッチ: {len(unmatched)}')

    if args.dry_run:
        print('--dry-run: ダウンロードしません')
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ok = 0
    errors = []
    for m in mappings:
        try:
            data = fetch_bytes(m['pdf_url'])
            if data[:5] != b'%PDF-':
                errors.append({'title': m['title'], 'reason': 'not_pdf'})
                continue
            (OUT_DIR / m['pdf_file']).write_bytes(data)
            ok += 1
            if ok % 50 == 0:
                print(f'  ...{ok}/{len(mappings)}')
        except Exception as e:
            errors.append({'title': m['title'], 'reason': f'{type(e).__name__}: {e}'})

    manifest = {
        'law_id': LAW_ID, 'law_title': law.get('law_title'),
        'source_index': NTA_INDEX,
        'fetched_at': datetime.now(timezone.utc).isoformat(),
        'matched': len(mappings), 'downloaded': ok,
        'unmatched_count': len(unmatched),
        'mappings': mappings, 'unmatched': unmatched, 'errors': errors,
    }
    (OUT_DIR / '_manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n完了: DL成功 {ok} / 失敗 {len(errors)}  → {OUT_DIR}')
    if errors:
        print('  失敗例:', errors[:5])
    return 0

if __name__ == '__main__':
    sys.exit(main())
