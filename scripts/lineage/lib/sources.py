# 材料の置き場所と取得（読むだけ・取ったものは LINEAGE_DATA の下に控える）
#   lawdb/   名古屋大学「法令XMLデータ」（CC BY 4.0・https://doi.org/10.18999/2014084）を展開したもの
#   ndl/     国立国会図書館「日本法令索引」の改正履歴（画面の裏の JSON を 1 秒に 1 回まで）
#   egov/    e-Gov 法令 API v2 の改正履歴と時点ごとの XML
import json
import os
import re
import time
import urllib.parse
import urllib.request

from .kansuji import ERA, ERA_BASE, kan2int, parse_egov_id

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
DATA = os.environ.get('LINEAGE_DATA') or os.path.join(REPO, 'lineage_data')
OFFLINE = os.environ.get('LINEAGE_OFFLINE') == '1'   # 1 なら控えだけを読む（¥0 の確認用）

_last = {'ndl': 0.0, 'egov': 0.0}


def _get(url, kind, gap):
    if OFFLINE:
        raise RuntimeError(f'LINEAGE_OFFLINE=1 なので取りに行かない: {url}')
    wait = _last[kind] + gap - time.time()
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={'User-Agent': 'joubun-kun-lineage/1 (+https://joubun-kun.com/)'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                _last[kind] = time.time()
                return r.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(3 * (attempt + 1))


def _cached(path, fetch):
    if os.path.exists(path):
        with open(path, 'rb') as f:
            return f.read()
    b = fetch()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b)
    return b


# ---------------------------------------------------------------- 名古屋大学の法令 XML
_lawdb_index = None


def lawdb_index():
    """(元号の数字, 年, 番号) → [XML のパス]（a・b に分かれたものは並べて返す）"""
    global _lawdb_index
    if _lawdb_index is None:
        idx = {}
        root = os.path.join(DATA, 'lawdb', 'Act')
        for d, _, fs in os.walk(root):
            for f in fs:
                m = re.match(r'^(\d)(\d\d)a(\d{4})([a-z]?)\.xml$', f)
                if m:
                    idx.setdefault((int(m.group(1)), int(m.group(2)), int(m.group(3))), []).append(os.path.join(d, f))
        for k in idx:
            idx[k].sort()
        _lawdb_index = idx
    return _lawdb_index


def lawdb_paths(era, year, num):
    return lawdb_index().get((era, year, num), [])


# ---------------------------------------------------------------- 日本法令索引
NDL = 'https://hourei.ndl.go.jp/law/api/v1'


def ndl_search(title, div='1'):
    """div='1' は法律だけ。'' は政令・省令・勅令も"""
    q = urllib.parse.urlencode({'fw': title, 'fwc': 'and', 'cross.ed1': 'true', 'cross.ed2': 'true', 'cross.ed3': 'true',
                                'cross.ed4': 'true', 'cross.ed5': 'true', 'type': '', 'div': div, 'order': '1', 'page': '1', 'perpage': '100'})
    name = re.sub(r'[\\/:*?"<>|]', '_', title)
    path = os.path.join(DATA, 'ndl', ('search_' if div == '1' else 'search_dall_') + name + '.json')
    b = _cached(path, lambda: _get(f'{NDL}/search/detail?{q}', 'ndl', 1.0))
    j = json.loads(b)
    return j.get('data') or []


def ndl_search_all(title, pages=5):
    """ndl_search の続きのページも取る（題名で引くと改正法が先に並び、100 件で前の法律が切れる: 所得税法など）"""
    out = list(ndl_search(title))
    for page in range(2, pages + 1):
        if len(out) < (page - 1) * 100:
            break
        q = urllib.parse.urlencode({'fw': title, 'fwc': 'and', 'cross.ed1': 'true', 'cross.ed2': 'true', 'cross.ed3': 'true',
                                    'cross.ed4': 'true', 'cross.ed5': 'true', 'type': '', 'div': '1', 'order': '1', 'page': str(page), 'perpage': '100'})
        path = os.path.join(DATA, 'ndl', f'search_p{page}_' + re.sub(r'[\\/:*?"<>|]', '_', title) + '.json')
        j = json.loads(_cached(path, lambda: _get(f'{NDL}/search/detail?{q}', 'ndl', 1.0)))
        got = j.get('data') or []
        if not got:
            break
        out += got
    return out


def ndl_history(ndl_id):
    path = os.path.join(DATA, 'ndl', f'ndl_h_{ndl_id}.json')
    b = _cached(path, lambda: _get(f'{NDL}/detail/history?lawId={ndl_id}', 'ndl', 1.0))
    j = json.loads(b)
    return j if isinstance(j, list) else (j.get('data') or [])


def parse_announcement(s):
    """「平成16年12月1日法律第147号」→ {'era','year','num','date','kind'}"""
    m = re.match(r'^(明治|大正|昭和|平成|令和)(元|\d+)年(\d+)月(\d+)日(法律|勅令|政令|太政官布告)第(\d+)号', s or '')
    if not m:
        return None
    era = ERA[m.group(1)]
    y = 1 if m.group(2) == '元' else int(m.group(2))
    return {'era': era, 'year': y, 'num': int(m.group(6)), 'kind': m.group(5),
            'date': f'{ERA_BASE[era] + y}-{int(m.group(3)):02d}-{int(m.group(4)):02d}'}


def ndl_find_law(law_id, title):
    """e-Gov の法令 ID と題名 → 日本法令索引の法令 ID（公布の年と番号が合うもの）"""
    era, year, kind, num = parse_egov_id(law_id)
    # 1 ページ目に無ければ続きのページも（昭和22年の所得税法など）。政令・勅令は種類を問わずに引く
    searches = (ndl_search, ndl_search_all) if kind == 'AC' else ((lambda t: ndl_search(t, div='')),)
    for search in searches:
        for d in search(title):
            a = parse_announcement((d.get('announcement') or '').strip('（）'))
            if a and a['era'] == era and a['year'] == year and a['num'] == num:
                return d['law_id'], d
    return None, None


# ---------------------------------------------------------------- e-Gov
EGOV = 'https://laws.e-gov.go.jp/api/2'


def egov_revisions(law_id, refresh=False):
    """refresh=True は控えを使わずに取り直す（月に 1 回の続き。新しい改正が載る）"""
    path = os.path.join(DATA, 'egov', 'revisions', f'{law_id}.json')
    if refresh and os.path.exists(path):
        os.remove(path)
    b = _cached(path, lambda: _get(f'{EGOV}/law_revisions/{law_id}', 'egov', 0.5))
    return json.loads(b).get('revisions') or []


def egov_xml_asof(law_id, asof):
    path = os.path.join(DATA, 'egov', 'xml', f'{law_id}_{asof}.xml')
    _cached(path, lambda: _get(f'{EGOV}/law_file/xml/{law_id}?asof={asof}', 'egov', 0.5))
    return path


def egov_xml_revision(revision_id):
    path = os.path.join(DATA, 'egov', 'xml', f'{revision_id}.xml')
    _cached(path, lambda: _get(f'{EGOV}/law_file/xml/{revision_id}', 'egov', 0.5))
    return path


def ledger():
    """法令の台帳（R2 update_state/sync_state.json の写し）。無ければ空（月に 1 回の作り直しは題名を report.json から取る）"""
    p = os.path.join(DATA, 'sync_state.json')
    if not os.path.exists(p):
        return {}
    with open(p, encoding='utf-8') as f:
        return json.load(f)['laws']


def title_of(law_id):
    led = ledger().get(law_id)
    if led and led.get('law_title'):
        return led['law_title']
    p = os.path.join(DATA, 'out', law_id, 'report.json')
    if os.path.exists(p):
        return json.load(open(p, encoding='utf-8')).get('title') or law_id
    return law_id
