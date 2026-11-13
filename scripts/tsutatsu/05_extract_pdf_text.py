# 取得した内容PDFを pdfplumber でテキスト抽出し、引用条文・廃止フラグ・抜粋を出す。
# 表示は原本PDFリンクで行う方針なので、これは「裏方」の引用抽出用（本文は保存・表示しない）。
#
# 使い方:
#   python scripts/tsutatsu/05_extract_pdf_text.py                       # 最新スナップショットの全PDF
#   python scripts/tsutatsu/05_extract_pdf_text.py --glob _tmp_pdf/*.pdf # 任意のPDF（検証用）
#   python scripts/tsutatsu/05_extract_pdf_text.py --max 20              # 先頭20件（検証）
#
# 出力: scripts/tsutatsu/state/pdf_items_YYYYMMDD.ndjson
#   { url, local_path, circular_path, title, abolished, citations:[{kind,article,branch,para,item}], snippet, chars }
#
# 引用抽出は 03_parse.cjs と同じ規則（法/令/規/措置法 第○条、前が漢字なら他法令で除外、空白許容、改正履歴除去）。

import os, re, sys, json, glob as globmod

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
STATE_DIR = os.path.join(os.path.dirname(__file__), 'state')
SCOPE = '/law/tsutatsu/'

def parse_args():
    a = sys.argv[1:]
    o = {'snapshot': None, 'glob': None, 'max': None}
    i = 0
    while i < len(a):
        if a[i] == '--snapshot': o['snapshot'] = a[i+1]; i += 2
        elif a[i] == '--glob': o['glob'] = a[i+1]; i += 2
        elif a[i] == '--max': o['max'] = int(a[i+1]); i += 2
        else: i += 1
    return o

def latest_snapshot():
    ds = sorted(d for d in os.listdir(REPO_ROOT) if re.match(r'^all_tsutatsu_\d{8}$', d))
    return ds[-1].replace('all_tsutatsu_', '') if ds else None

def zen2han(s):
    return s.translate(str.maketrans('０１２３４５６７８９', '0123456789'))

CITE_BASE = re.compile(r'(?<![一-鿿々〇])(法|令|規)第\s*(\d+)\s*条(?:の\s*(\d+))?(?:\s*第\s*(\d+)\s*項)?(?:\s*第\s*(\d+)\s*号)?')
CITE_SOCHI = re.compile(r'(措置法|租税特別措置法)第\s*(\d+)\s*条(?:の\s*(\d+))?(?:\s*第\s*(\d+)\s*項)?(?:\s*第\s*(\d+)\s*号)?')
KAISEI_HIST = re.compile(r'（[^（）]*により(?:追加|改正|削除|新設|変更)[^（）]*）')

def extract_citations(text):
    t = KAISEI_HIST.sub(' ', zen2han(text))
    cites, seen = [], set()
    def add(kind, m):
        art = int(m.group(2))
        br = int(m.group(3)) if m.group(3) else None
        pa = int(m.group(4)) if m.group(4) else None
        it = int(m.group(5)) if m.group(5) else None
        key = (kind, art, br, pa, it)
        if key in seen: return
        seen.add(key)
        cites.append({'kind': kind, 'article': art, 'branch': br, 'para': pa, 'item': it})
    for m in CITE_SOCHI.finditer(t): add('措置法', m)
    for m in CITE_BASE.finditer(t): add(m.group(1), m)
    return cites

def url_from_path(local_path, snap_dir):
    rel = os.path.relpath(local_path, snap_dir).replace(os.sep, '/')
    return 'https://www.nta.go.jp' + SCOPE + rel

def circular_from_path(local_path, snap_dir):
    rel = os.path.relpath(local_path, snap_dir).replace(os.sep, '/').split('/')
    return '/'.join(rel[:2]) if len(rel) >= 2 else (rel[0] if rel else '')

BRACKET_HEAD = re.compile(r'^[【\[［]\s*(.{4,}?)\s*[】\]］]$')

def guess_title(lines):
    head = [ln.strip() for ln in lines[:25]]
    # 先頭近くの【…】の見出し（様式の記載要領など。2026-10-22 に「【給与所得の源泉徴収票等の法定調書合計表】」を飛ばして
    # 本文の折り返しの途中「得の源泉徴収票の提出を省略するもの…について記載する。」を拾った）。次の行が「記載要領」など短い名前なら続ける
    for i, s in enumerate(head[:5]):
        m = BRACKET_HEAD.match(s)
        if not m: continue
        t = m.group(1)
        nxt = head[i + 1] if i + 1 < len(head) else ''
        if nxt and len(nxt) <= 12 and not nxt.endswith('。') and not re.match(r'^[0-9０-９（(]', nxt): t = t + ' ' + nxt
        return t[:120]
    # 「〜について」「〜の取扱い」等を含む早い行を見出しとみなす（発遣ヘッダの後にあることが多い）。
    # 「。」で終わる行は本文の文なので採らない（「…について記載する。」を題名にしない）
    for s in head:
        if len(s) >= 12 and re.search(r'について|取扱い|評価|の特例|通達', s) and not s.startswith('※') and not s.endswith('。'):
            return s[:120]
    for s in head:
        if len(s) >= 10: return s[:120]
    return None

def is_abolished(text):
    head = text[:400]
    return bool(re.search(r'廃止(?:され|する|した)', head))

def main():
    o = parse_args()
    import pdfplumber
    stamp = o['snapshot'] or latest_snapshot()
    snap_dir = os.path.join(REPO_ROOT, 'all_tsutatsu_%s' % stamp)
    files = globmod.glob(o['glob']) if o['glob'] else globmod.glob(os.path.join(snap_dir, '**', '*.pdf'), recursive=True)
    files.sort()
    if o['max']: files = files[:o['max']]

    out_file = os.path.join(STATE_DIR, 'pdf_items_%s.ndjson' % stamp)
    os.makedirs(STATE_DIR, exist_ok=True)
    n, errs, scanned, withcite, abol = 0, 0, 0, 0, 0
    with open(out_file, 'w', encoding='utf-8') as out:
        for f in files:
            try:
                with pdfplumber.open(f) as pdf:
                    pages = [(p.extract_text() or '') for p in pdf.pages]
                text = '\n'.join(pages)
            except Exception as e:
                errs += 1
                out.write(json.dumps({'local_path': os.path.relpath(f, REPO_ROOT).replace(os.sep,'/'), 'error': str(e)}, ensure_ascii=False) + '\n')
                continue
            n += 1
            chars = len(text.strip())
            if chars < 20:
                scanned += 1  # テキスト層なし＝スキャン画像の可能性（要OCR）
            cites = extract_citations(text)
            if cites: withcite += 1
            ab = is_abolished(text)
            if ab: abol += 1
            lines = [l for l in text.split('\n') if l.strip()]
            rec = {
                'url': url_from_path(f, snap_dir),
                'local_path': os.path.relpath(f, REPO_ROOT).replace(os.sep, '/'),
                'circular_path': circular_from_path(f, snap_dir),
                'title': guess_title(lines),
                'abolished': ab,
                'citations': cites,
                'snippet': re.sub(r'\s+', ' ', text).strip()[:160],
                'chars': chars,
            }
            out.write(json.dumps(rec, ensure_ascii=False) + '\n')
    print('PDF処理: %d / エラー %d / スキャン疑い(text<20字) %d' % (n, errs, scanned))
    print('引用あり: %d (%d%%) / 廃止: %d' % (withcite, round(100*withcite/n) if n else 0, abol))
    print('出力: %s' % out_file)

if __name__ == '__main__':
    main()
