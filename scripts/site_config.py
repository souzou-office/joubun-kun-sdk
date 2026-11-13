# -*- coding: utf-8 -*-
"""データ側の Python スクリプトのサイト固有の既定値の入口（JS 側は scripts/site_config.cjs）。

- site_config_private.py（同じフォルダ）に条文くん自身の値がある。あればそれを既定にする（このリポジトリでは今までと同じ値）。
- 公開用の写しにはそのファイルを含めない。無ければすべて環境変数から取る:
    CRAWLER_CONTACT・CF_ACCOUNT_ID・STAGING_WORKER_URL・BENCH_WORKER_URL・PRODUCTION_WORKER_URL・LOCAL_DATA_ROOT
- クローラの連絡先だけは、private があっても環境変数 CRAWLER_CONTACT を先に見る。
- 各スクリプトが今まで通り先に見ている環境変数（CF_ACCOUNT_ID など）は、呼び出し側でそのまま先に見る。

使い方（scripts/ の下のどの深さからでも）:
    sys.path.append(str(Path(__file__).resolve().parents[N]))  # scripts/
    import site_config
private は sys.path に頼らずこのファイルの隣から読む。
"""
import importlib.util
import os
import pathlib

_PRIVATE_FILE = pathlib.Path(__file__).resolve().parent / 'site_config_private.py'
_P = None
if _PRIVATE_FILE.is_file():
    _spec = importlib.util.spec_from_file_location('site_config_private', _PRIVATE_FILE)
    _P = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_P)

_env = os.environ

CRAWLER_CONTACT = _env.get('CRAWLER_CONTACT') or (_P.CRAWLER_CONTACT if _P else '')
CF_ACCOUNT_ID = _P.CF_ACCOUNT_ID if _P else _env.get('CF_ACCOUNT_ID', '')
WORKER_URLS = dict(_P.WORKER_URLS) if _P else {
    'staging': _env.get('STAGING_WORKER_URL', ''),
    'bench': _env.get('BENCH_WORKER_URL', ''),
    'production': _env.get('PRODUCTION_WORKER_URL', ''),
}
LOCAL_DATA_ROOT = _P.LOCAL_DATA_ROOT if _P else (_env.get('LOCAL_DATA_ROOT') or '.')
