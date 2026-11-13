#!/usr/bin/env python3
"""公開データの版を Hugging Face のデータセットに上げる（2026-11-05 オーナー: 置き場所は Hugging Face・更新があったら自動で版を上げる）。

  python3 -I scripts/open_data/release_hf.py --out /tmp/open_data            export.cjs が作った一番新しい版を上げる
  python3 -I scripts/open_data/release_hf.py --out /tmp/open_data --dry-run  比べるだけ（何も書かない）
  python3 -I scripts/open_data/release_hf.py --write-check                   書けるか（鍵の権限）だけ確かめる（枝を作ってすぐ消す）
    [--force-shrink]  前の版より 5% 超減っても止めない（版の切り替えなどで正しく減ったとき）

鍵: 環境変数 HF_TOKEN（そのデータセットに書ける Hugging Face のトークン。fine-grained でそのリポジトリだけに絞る）
置き先: 環境変数 HF_DATASET（既定 souzou-office/joubun-kun-law-data）。無ければ非公開で作る（公開の日に Hugging Face の設定で公開にする）

決まり（export.cjs が R2 に書いていたときと同じ考え方）:
  - 前の版（データセットの main の MANIFEST.json）とファイルの sha256 が全部同じなら何もしない（版を増やさない）
  - 前の版より件数が 5% 超減ったデータがあれば、書く前に止める
  - 版の名前は前の版より新しい物だけ（同じ日に流し直すなら export.cjs の --release 2026-11-09.2）
  - 全部のファイルを 1 つのコミットで上げる（途中で落ちても main は前の版のまま）。上げたらその版の名前のタグを付ける。前の版は履歴とタグに残る
本番の R2 には触らない。出すのは版の名前・件数・大きさだけ。
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

RELEASE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}(?:\.\d{1,2})?$')
SHRINK_LIMIT = 0.05
DEFAULT_REPO = 'souzou-office/joubun-kun-law-data'
SITE = 'https://joubun-kun.com/'
GAVEL = 'https://github.com/souzou-office/joubun-kun-sdk'
# データの名前 → 画面の説明（Hugging Face のデータセットの「configs」に 1 つずつ出す）
TITLES = {
    'laws': '法令 1 本 1 行（台帳の書誌＋目次）',
    'articles': '条 1 件 1 行（本文・項・号。本則の条にだけ article_id）',
    'refs': '参照 1 件 1 行（この条 → 引いている条）',
    'delegations': '委任 1 件 1 行（「政令で定める」等の受け皿）',
    'kokuji_gaps': '告示への委任で、受け皿の告示がまだ入っていない箇所',
    'links': '条 → 通達・質疑応答事例・裁決・判例の紐付け（資料の ID・題名・日付・原文の URL・付け方。本文は入れない）',
}


def log(*a):
    print('[hf]', *a, flush=True)


def release_key(v):
    m = re.match(r'^(\d{4}-\d{2}-\d{2})(?:\.(\d{1,2}))?$', str(v))
    return (m.group(1), int(m.group(2)) if m.group(2) else 1) if m else (str(v), 0)


def latest_local(out):
    root = Path(out).resolve() / 'releases'
    vers = [p.name for p in root.iterdir() if p.is_dir() and RELEASE_RE.match(p.name) and (p / 'MANIFEST.json').exists()] if root.exists() else []
    if not vers:
        raise SystemExit(f'{root} に MANIFEST.json のある版が無い（先に export.cjs を流す）')
    return root / sorted(vers, key=release_key)[-1]


def shrink_check(prev, files):
    bad = []
    for name, f in files.items():
        p = (prev or {}).get('files', {}).get(name)
        if p and p.get('records') and f['records'] < p['records'] * (1 - SHRINK_LIMIT):
            bad.append(f"{name}: {p['records']} → {f['records']}")
    return bad


def same_files(prev, files):
    pf = (prev or {}).get('files') or {}
    return set(pf) == set(files) and all(pf[k].get('sha256') and pf[k].get('sha256') == files[k].get('sha256') for k in files)


def dataset_card(m, repo):
    """データセットの説明（README.md）。上の YAML は Hugging Face が読む（ライセンス・言語・データの分け方）"""
    files = m.get('files') or {}
    as_of = ((m.get('sources') or {}).get('laws') or {}).get('fetched_at') or ''
    configs = ''.join(f'  - config_name: {k}\n    data_files: data/{k}.jsonl.gz\n' for k in files)
    rows = ''.join(f"| `{k}` | {TITLES.get(k, '')} | {files[k]['records']:,} |\n" for k in files)
    return (
        '---\n'
        'license: cc-by-4.0\n'
        'language:\n  - ja\n'
        'pretty_name: 条文くん 法令データ\n'
        'tags:\n  - legal\n  - japanese-law\n'
        f'configs:\n{configs}'
        '---\n\n'
        '# 条文くん 法令データ\n\n'
        f'[条文くん]({SITE})（司法書士法人そうぞう）が検索と条文ページに使っている法令データの写しです。'
        'データベースの中身を見せるために公開しています（完成品ではありません）。'
        'データが変わった週に新しい版を上げます。版の名前はタグ（例 `2026-11-09`）で、前の版も履歴に残ります。\n\n'
        f"- 版: **{m.get('release')}**（法令は e-Gov法令検索の {str(as_of)[:10] or '—'} 時点）\n"
        f'- 形の説明・入っていないもの・作り方のコード: [条文くん Gavel]({GAVEL})（`SCHEMA.md`・`KNOWN_GAPS.md`）\n'
        '- 件数とファイルの sha256: `MANIFEST.json`\n\n'
        '| データ | 中身 | 件数 |\n|---|---|---:|\n' + rows +
        '\n## ライセンスと出典\n\n'
        '加工データは CC BY 4.0 です。使うときは次のように表示してください。\n\n'
        f"> 出典: e-Gov法令検索（デジタル庁）。条文くん（司法書士法人そうぞう）が加工 https://huggingface.co/datasets/{repo} （{m.get('release')} 版）\n\n"
        '法令の本文の出典は e-Gov法令検索（デジタル庁）です。\n'
        + ('紐付け（`links`）の先の資料は、国税庁（通達・質疑応答事例）・国税不服審判所（裁決）・裁判所（判例）の公開情報です。本文は入れていないので、原文の URL から読んでください。'
           '判例の今の条への付け直しは、名古屋大学「法令XMLデータ」（佐野智也・外山勝彦・増田知子、CC BY 4.0 https://doi.org/10.18999/2014084）の改正の経過に基づきます。\n'
           if 'links' in files else '')
    )


def stage(dir_, m, repo, tmp):
    """上げる形に並べる: data/{名前}.jsonl.gz・MANIFEST.json・README.md"""
    root = Path(tmp)
    (root / 'data').mkdir(parents=True, exist_ok=True)
    for k, f in m['files'].items():
        src = dir_ / f'{k}.jsonl.gz'
        if src.stat().st_size != f['bytes']:
            raise SystemExit(f'{src.name} の大きさが MANIFEST と違う')
        dst = root / 'data' / f'{k}.jsonl.gz'
        try:
            os.link(src, dst)   # 大きいので写さずに同じファイルを指す
        except OSError:
            shutil.copyfile(src, dst)
    (root / 'MANIFEST.json').write_bytes((dir_ / 'MANIFEST.json').read_bytes())
    (root / 'README.md').write_text(dataset_card(m, repo), encoding='utf-8')
    return root


def previous_manifest(api, repo):
    """main の MANIFEST.json（データセットかファイルが無ければ None＝初めての版）。読めないのは止める。読むだけで何も作らない"""
    if not api.repo_exists(repo, repo_type='dataset') or not api.file_exists(repo, 'MANIFEST.json', repo_type='dataset'):
        return None
    p = api.hf_hub_download(repo, 'MANIFEST.json', repo_type='dataset')
    with open(p, encoding='utf-8') as fh:
        prev = json.load(fh)
    if not isinstance(prev, dict) or not isinstance(prev.get('files'), dict) or not RELEASE_RE.match(str(prev.get('release', ''))):
        raise SystemExit('前の版の MANIFEST.json が壊れている')
    return prev


def publish(dir_, opt, api, repo):
    m = json.loads((dir_ / 'MANIFEST.json').read_text(encoding='utf-8'))
    release = str(m.get('release') or '')
    if not RELEASE_RE.match(release):
        raise SystemExit('MANIFEST.json に版の名前（release）が無い')
    if m.get('partial'):
        raise SystemExit('--only・--limit-laws で絞った版は上げない')
    if not m.get('files'):
        raise SystemExit('MANIFEST.json にファイルが無い')
    prev = previous_manifest(api, repo)
    # 前の回が上げた後・タグを付ける前に落ちていたら、main を次の版に進める前に（今の main＝前の版のコミットに）タグを付ける。
    # データが変わったかどうかに関係なく先にする（変わった週に進めてしまうと、前の版の名前で取れなくなる・GPT レビュー #415）
    if prev and not opt.dry_run and prev['release'] not in {t.name for t in api.list_repo_refs(repo, repo_type='dataset').tags}:
        api.create_tag(repo, tag=prev['release'], repo_type='dataset', revision='main')
        log(f"前の版 {prev['release']} にタグが無かったので付けた")
    if prev and same_files(prev, m['files']):
        log(f"前の版（{prev['release']}）とファイルが全部同じ。版を増やさない")
        return {'skipped': True, 'release': release, 'prev': prev['release']}
    if prev and not release_key(release) > release_key(prev['release']):
        if opt.dry_run:   # 比べるだけの回は名前で止めない（件数とハッシュを比べるのが目的・2026-11-06 の試しの書き出しがここで止まった）
            log(f"版の名前（{release}）は今の版（{prev['release']}）より新しくない。上げるときは --next-release の名前にする")
        else:
            raise SystemExit(f"版の名前（{release}）は今の版（{prev['release']}）より新しくする（同じ日なら --release {prev['release']}.2 のように）")
    shrunk = shrink_check(prev, m['files'])
    if shrunk and not opt.force_shrink:
        raise SystemExit(f"前の版（{prev['release']}）より 5% 超減った: {'・'.join(shrunk)}。正しく減ったなら --force-shrink で流す")
    if opt.dry_run:
        log(f"比べただけ: {release}（前の版 {prev['release'] if prev else 'なし'}）")
        return {'dry_run': True, 'release': release, 'prev': prev['release'] if prev else None}
    api.create_repo(repo, repo_type='dataset', private=True, exist_ok=True)   # 上げるときだけ。無ければ非公開で作る（有れば何もしない・公開の設定は変えない）
    with tempfile.TemporaryDirectory() as tmp:
        root = stage(dir_, m, repo, tmp)
        info = api.upload_folder(repo_id=repo, repo_type='dataset', folder_path=str(root), commit_message=f'データ {release}',
                                 commit_description=f"法令の時点 {((m.get('sources') or {}).get('laws') or {}).get('fetched_at') or '—'}")
    api.create_tag(repo, tag=release, repo_type='dataset', revision=getattr(info, 'oid', None))
    for k, f in m['files'].items():
        log(f"{k}: {f['records']:,} 件・{f['bytes'] / 1048576:.1f} MB")
    log(f'上げた {repo} の版 {release}')
    return {'release': release, 'url': f'https://huggingface.co/datasets/{repo}/tree/{release}'}


def next_release(api, repo, today):
    """今日の日付（YYYY-MM-DD）で使える版の名前。今日の版がもうあれば .2・.3 … と次の連番にする（同じ日に流し直しても止まらないように）"""
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', str(today)):
        raise SystemExit(f'--next-release は YYYY-MM-DD: {today}')
    prev = previous_manifest(api, repo)
    if not prev:
        return today
    d, n = release_key(prev['release'])
    if d < today:
        return today
    if d == today:
        return f'{today}.{n + 1}'
    raise SystemExit(f"今の版（{prev['release']}）が今日（{today}）より先の日付")


PREV_FILES = ('MANIFEST.json', 'data/laws.jsonl.gz', 'data/articles.jsonl.gz')


def fetch_prev(api, repo, out):
    """変わっていない法令の行を使い回すために、今の版の MANIFEST と laws・articles を out に落とす（無ければ何も置かない）。
    export.cjs --prev が MANIFEST の sha256 と照らしてから使う。読むだけで何も書かない"""
    prev = previous_manifest(api, repo)
    if not prev or not all(api.file_exists(repo, f, repo_type='dataset') for f in PREV_FILES):
        log('前の版が無い（使い回さずに全部読む）')
        return None
    o = Path(out)
    o.mkdir(parents=True, exist_ok=True)
    for f in PREV_FILES:
        src = api.hf_hub_download(repo, f, repo_type='dataset')
        shutil.copyfile(src, o / Path(f).name)
    log(f"前の版 {prev['release']} の MANIFEST・laws・articles を {o} に置いた")
    return prev['release']


def write_check(api, repo):
    """書けるかだけ: データセットが無ければ非公開で作り、枝を作ってすぐ消す（main は変えない）"""
    api.create_repo(repo, repo_type='dataset', private=True, exist_ok=True)
    br = f'write-check-{os.getpid()}'
    api.create_branch(repo, branch=br, repo_type='dataset')
    api.delete_branch(repo, branch=br, repo_type='dataset')
    log(f'書けた（枝を作って消した）: {repo}')
    return True


def main(argv=None, api=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--force-shrink', action='store_true')
    ap.add_argument('--write-check', action='store_true')
    ap.add_argument('--next-release', metavar='YYYY-MM-DD')
    ap.add_argument('--fetch-prev', metavar='DIR')
    opt = ap.parse_args(argv)
    repo = os.environ.get('HF_DATASET') or DEFAULT_REPO
    if not re.match(r'^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$', repo):
        raise SystemExit(f'HF_DATASET の形が違う: {repo}')
    if api is None:
        token = os.environ.get('HF_TOKEN')
        if not token:
            raise SystemExit('HF_TOKEN が無い')
        from huggingface_hub import HfApi
        api = HfApi(token=token)
    if opt.write_check:
        return write_check(api, repo)
    if opt.next_release:
        name = next_release(api, repo, opt.next_release)
        print(name)
        return name
    if opt.fetch_prev:
        return fetch_prev(api, repo, opt.fetch_prev)
    if not opt.out:
        raise SystemExit('--out が要る（export.cjs の --out と同じ）')
    r = publish(latest_local(opt.out), opt, api, repo)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as fh:
            fh.write(f"\nHugging Face: {'変更なし（版を増やさない）' if r.get('skipped') else ('比べただけ' if r.get('dry_run') else r.get('url'))}\n")
    return r


if __name__ == '__main__':
    try:
        main()
    except SystemExit as e:
        if e.code not in (None, 0):
            print(f'[hf] 失敗: {e.code}', file=sys.stderr)
            sys.exit(1)
