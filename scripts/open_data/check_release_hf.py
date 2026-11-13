#!/usr/bin/env python3
"""release_hf.py の確かめ（¥0・Hugging Face には何も送らない。作り物の API に向けて流す）
  python3 -I scripts/open_data/check_release_hf.py
"""
import hashlib
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_hf as R  # noqa: E402

fails = 0


def check(name, ok):
    global fails
    print(('PASS' if ok else 'FAIL') + '  ' + name)
    if not ok:
        fails += 1


class FakeHf:
    """データセット 1 つ分の作り物: main の中身・コミット・タグ・枝"""
    def __init__(self, fail_upload=False):
        self.files, self.commits, self.tags, self.branches, self.calls = {}, [], {}, set(), []
        self.created, self.fail_upload = None, fail_upload

    def create_repo(self, repo_id, repo_type=None, private=None, exist_ok=False):
        self.calls.append('create_repo')
        if self.created is None:
            self.created = {'repo': repo_id, 'private': private}

    def repo_exists(self, repo_id, repo_type=None):
        return self.created is not None and self.created['repo'] == repo_id

    def file_exists(self, repo_id, filename, repo_type=None):
        return filename in self.files

    def hf_hub_download(self, repo_id, filename, repo_type=None):
        p = Path(tempfile.mkdtemp()) / filename
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(self.files[filename])
        return str(p)

    def upload_folder(self, repo_id, repo_type, folder_path, commit_message, commit_description=None):
        self.calls.append('upload_folder')
        if self.fail_upload:
            raise RuntimeError('network')
        root = Path(folder_path)
        new = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}
        self.files.update(new)
        oid = hashlib.sha1(commit_message.encode()).hexdigest()
        self.commits.append({'oid': oid, 'message': commit_message, 'names': sorted(new)})
        return SimpleNamespace(oid=oid)

    def create_tag(self, repo_id, tag, repo_type=None, revision=None):
        self.calls.append('create_tag')
        if tag in self.tags:
            raise RuntimeError('tag exists')
        self.tags[tag] = revision

    def list_repo_refs(self, repo_id, repo_type=None):
        return SimpleNamespace(tags=[SimpleNamespace(name=t) for t in self.tags])

    def create_branch(self, repo_id, branch, repo_type=None):
        self.branches.add(branch); self.calls.append('create_branch')

    def delete_branch(self, repo_id, branch, repo_type=None):
        self.branches.discard(branch); self.calls.append('delete_branch')


def make_local(root, release, counts, partial=False, salt=''):
    d = Path(root) / 'releases' / release
    d.mkdir(parents=True, exist_ok=True)
    files = {}
    for k, n in counts.items():
        b = f'{k}:{n}:{salt}'.encode()
        (d / f'{k}.jsonl.gz').write_bytes(b)
        files[k] = {'records': n, 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest()}
    (d / 'MANIFEST.json').write_text(json.dumps({'format_version': 1, 'release': release, 'files': files, 'sources': {'laws': {'fetched_at': '2026-11-08T00:00:00Z'}}, 'partial': partial}), encoding='utf-8')
    return d


def run(api, root, *extra):
    return R.main(['--out', str(root), *extra], api=api)


def expect_fail(fn):
    try:
        fn()
    except SystemExit as e:
        return str(e.code)
    return None


# workflow から渡された HF_DATASET・HF_TOKEN に左右されないように、確かめの間は外して終わりに戻す（GPT レビュー #415）
import os  # noqa: E402
SAVED = {k: os.environ.pop(k, None) for k in ('HF_DATASET', 'HF_TOKEN')}

root = tempfile.mkdtemp()
# 比べるだけ（--dry-run）は、データセットが無くても作らない・何も書かない（GPT レビュー #415）
api0 = FakeHf()
root0 = tempfile.mkdtemp()
make_local(root0, '2026-11-09', {'laws': 1, 'articles': 2})
r0 = run(api0, root0, '--dry-run')
check('--dry-run はデータセットが無くても作らない（作成・コミット・タグ・枝の操作が無い）', r0.get('dry_run') and r0.get('prev') is None and api0.created is None and not api0.calls)

api = FakeHf()
make_local(root, '2026-11-09', {'laws': 9000, 'articles': 500000})
r = run(api, root)
check('初めての版: データセットを非公開で作り、1 つのコミットで data/・MANIFEST・README を上げ、版の名前のタグを付ける',
      api.created == {'repo': R.DEFAULT_REPO, 'private': True} and len(api.commits) == 1 and api.commits[0]['names'] == ['MANIFEST.json', 'README.md', 'data/articles.jsonl.gz', 'data/laws.jsonl.gz'] and '2026-11-09' in api.tags and r['release'] == '2026-11-09')
card = api.files['README.md'].decode('utf-8')
check('データセットの説明: CC BY 4.0・日本語・データごとの configs・件数・出典・条文くんへのリンク',
      'license: cc-by-4.0' in card and '- ja' in card and 'config_name: articles' in card and 'data/articles.jsonl.gz' in card and '500,000' in card and '出典: e-Gov法令検索' in card and R.SITE in card)

# 変わっていなければ版を増やさない
make_local(root, '2026-11-16', {'laws': 9000, 'articles': 500000})
r = run(api, root)
check('前の版とファイルが全部同じなら何もしない（コミットもタグも増えない）', r.get('skipped') and len(api.commits) == 1 and list(api.tags) == ['2026-11-09'])

# 変わったら上げる
make_local(root, '2026-11-23', {'laws': 9001, 'articles': 499000}, salt='x')
r = run(api, root)
check('変わったら新しい版を上げてタグ・前の版のタグは残る', len(api.commits) == 2 and set(api.tags) == {'2026-11-09', '2026-11-23'})

# 5% 超減ったら止める
make_local(root, '2026-11-30', {'laws': 9001, 'articles': 400000}, salt='y')
err = expect_fail(lambda: run(api, root))
check('前の版より 5% 超減ったら上げない', err and '5% 超減った' in err and len(api.commits) == 2)
r = run(api, root, '--force-shrink')
check('--force-shrink なら上げる', len(api.commits) == 3 and '2026-11-30' in api.tags)

# 古い版の名前
root2 = tempfile.mkdtemp()
make_local(root2, '2026-11-01', {'laws': 1, 'articles': 2}, salt='z')
err = expect_fail(lambda: run(api, root2))
check('今の版より古い版の名前は上げない', err and 'より新しくする' in err and len(api.commits) == 3)

# 比べるだけ
root3 = tempfile.mkdtemp()
make_local(root3, '2026-12-07', {'laws': 9001, 'articles': 400001}, salt='w')
r = run(api, root3, '--dry-run')
check('--dry-run は何も書かない', r.get('dry_run') and len(api.commits) == 3 and '2026-12-07' not in api.tags)

# 上げた後・タグの前に落ちた次の回は、タグだけ付ける
api2 = FakeHf()
root4 = tempfile.mkdtemp()
make_local(root4, '2026-11-09', {'laws': 1, 'articles': 2})
orig = api2.create_tag
api2.create_tag = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('落ちた'))
try:
    run(api2, root4)
except RuntimeError:
    pass
api2.create_tag = orig
make_local(root4, '2026-11-16', {'laws': 1, 'articles': 2})
r = run(api2, root4)
check('前の回がタグの前に落ちていたら、次の回にタグだけ付ける', r.get('skipped') and api2.tags.get('2026-11-09') == 'main' and len(api2.commits) == 1)

# タグの前に落ちて、次の回にデータが変わっていても、先に前の版にタグを付けてから新しい版を上げる（GPT レビュー #415）
api6 = FakeHf()
root9 = tempfile.mkdtemp()
make_local(root9, '2026-11-09', {'laws': 1, 'articles': 2})
orig6 = api6.create_tag
api6.create_tag = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('落ちた'))
try:
    run(api6, root9)
except RuntimeError:
    pass
api6.create_tag = orig6
first_oid = api6.commits[0]['oid']
order = []
orig_up, orig_tag = api6.upload_folder, api6.create_tag
api6.upload_folder = lambda **k: (order.append('upload'), orig_up(**k))[1]
api6.create_tag = lambda *a, **k: (order.append(('tag', k.get('tag'))), orig_tag(*a, **k))[1]
make_local(root9, '2026-11-16', {'laws': 1, 'articles': 3}, salt='new')
run(api6, root9)
check('タグの前に落ちた次の回にデータが変わっていても、上げる前に前の版にタグを付けてから新しい版を上げる',
      order[:2] == [('tag', '2026-11-09'), 'upload'] and api6.tags.get('2026-11-09') == 'main' and '2026-11-16' in api6.tags and len(api6.commits) == 2 and first_oid)

# 上げるのに失敗したらタグを付けない
api3 = FakeHf(fail_upload=True)
root5 = tempfile.mkdtemp()
make_local(root5, '2026-11-09', {'laws': 1})
try:
    run(api3, root5)
    ok3 = False
except RuntimeError:
    ok3 = not api3.tags
check('上げるのに失敗したらタグを付けない（main は前のまま）', ok3)

# 絞った版・大きさのずれ・名前の形・鍵
root6 = tempfile.mkdtemp()
make_local(root6, '2026-11-09', {'laws': 1}, partial=True)
check('絞った版（partial）は上げない', '絞った版' in (expect_fail(lambda: run(FakeHf(), root6)) or ''))
root7 = tempfile.mkdtemp()
d = make_local(root7, '2026-11-09', {'laws': 1})
(d / 'laws.jsonl.gz').write_bytes(b'longer-than-before')
check('手元のファイルの大きさが MANIFEST と違えば上げない', 'MANIFEST と違う' in (expect_fail(lambda: run(FakeHf(), root7)) or ''))
os.environ['HF_DATASET'] = 'bad name'
check('HF_DATASET の形が違えば止める', '形が違う' in (expect_fail(lambda: run(FakeHf(), root)) or ''))
os.environ['HF_DATASET'] = 'my-org/my-data'
api5 = FakeHf()
root8 = tempfile.mkdtemp()
make_local(root8, '2026-11-09', {'laws': 1})
run(api5, root8)
check('HF_DATASET を変えれば、その置き先に上げる', api5.created == {'repo': 'my-org/my-data', 'private': True} and '2026-11-09' in api5.tags and 'my-org/my-data' in api5.files['README.md'].decode('utf-8'))
del os.environ['HF_DATASET']
check('HF_TOKEN が無ければ止める', 'HF_TOKEN' in (expect_fail(lambda: R.main(['--write-check'])) or ''))

# 同じ日に流し直す（2026-11-06 の試しの書き出しが「版の名前」で止まった）
api6 = FakeHf()
root9 = tempfile.mkdtemp()
make_local(root9, '2026-11-06', {'laws': 2, 'articles': 3})
run(api6, root9)
check('--next-release: 今日の版がもうあれば次の連番・無ければ今日', R.main(['--next-release', '2026-11-06'], api=api6) == '2026-11-06.2' and R.main(['--next-release', '2026-11-07'], api=api6) == '2026-11-07' and R.main(['--next-release', '2026-11-06'], api=FakeHf()) == '2026-11-06')
root10 = tempfile.mkdtemp()
make_local(root10, '2026-11-06', {'laws': 2, 'articles': 4})
r = run(api6, root10, '--dry-run')
check('--dry-run は版の名前が新しくなくても止めずに比べる（何も書かない）', r.get('dry_run') and len(api6.commits) == 1)
check('上げる回は版の名前が新しくなければ止める', 'より新しくする' in (expect_fail(lambda: run(api6, root10)) or ''))
prevd = Path(tempfile.mkdtemp()) / 'prev'
check('--fetch-prev: 今の版の MANIFEST・laws・articles を置く', R.main(['--fetch-prev', str(prevd)], api=api6) == '2026-11-06' and all((prevd / n).exists() for n in ('MANIFEST.json', 'laws.jsonl.gz', 'articles.jsonl.gz')))
prevd2 = Path(tempfile.mkdtemp()) / 'prev'
check('--fetch-prev: 前の版が無ければ何も置かない', R.main(['--fetch-prev', str(prevd2)], api=FakeHf()) is None and not prevd2.exists())

# 書けるかの確かめ
api4 = FakeHf()
R.main(['--write-check'], api=api4)
check('書けるかの確かめは枝を作って消すだけ（main は変えない）', not api4.branches and 'create_branch' in api4.calls and 'delete_branch' in api4.calls and not api4.commits)

# workflow が Hugging Face に上げる形になっているか
here = Path(__file__).resolve().parent.parent.parent
wf = next((p for p in [here / '.github/workflows/open_data_export.yml', here / 'examples/workflows/open_data_export.yml'] if p.exists()), None)
t = wf.read_text(encoding='utf-8') if wf else ''
check('workflow: 毎週・release_hf.py で上げる・鍵は HF_TOKEN・R2 に --upload しない', 'release_hf.py' in t and 'secrets.HF_TOKEN' in t and 'ARGS="$ARGS --upload"' not in t and 'release_hf.py --write-check' in t)

for k, v in SAVED.items():
    if v is not None:
        os.environ[k] = v
print(f'\n{fails} 件 失敗' if fails else '\nすべて通りました')
sys.exit(1 if fails else 0)
