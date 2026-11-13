import json, sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parents[1]))  # scripts/（site_config）
import site_config  # noqa: E402
try:
    with open(f'{site_config.LOCAL_DATA_ROOT}/rebuild_output/upload_r2_resume.json', encoding='utf-8') as f:
        d = json.load(f)
    n = len(d['uploaded'])
    print(f'{n} / 266143  ({n/266143*100:.1f}%)')
except Exception as e:
    print(f'ERR: {e}')
