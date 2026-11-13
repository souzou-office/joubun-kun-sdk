# -*- coding: utf-8 -*-
"""裁判例PDF（hanrei_raw/pdf/*.pdf）の一括テキスト抽出・正規化

    python scripts/hanrei/02_extract_pdf_text.py                # 全PDF（既出力はスキップ）
    python scripts/hanrei/02_extract_pdf_text.py --only 96174   # 特定IDのみ（カンマ区切り可）
    python scripts/hanrei/02_extract_pdf_text.py --force        # 既出力も再抽出

入力: hanrei_raw/pdf/{id}.pdf, hanrei_raw/pdf/point_{id}.pdf（知財要旨）
出力: hanrei_raw/pdftext/{id}.json, hanrei_raw/pdftext/point_{id}.json
      = { id, pages, chars, text, found }（エラーPDFは found:false で記録し続行）

正規化（実測で必須と確認済みの4点 + 見出し保存）:
  ①全角文字同士の間の改行・空白除去（ないと条文引用の約10%を取りこぼす）
  ②行頭の左余白行番号 ^(5|10|15|20|25)\\s の除去（語の分断防止）
  ③ページ番号行「- N -」の除去
  ④独立した数字のみ行 ^\\d+$ の除去
  ただし①を無差別に適用すると全文が1行に潰れて「主 文」等の見出し行が消えるため、
  見出し行・ブロック開始行（第１/１/⑴/ア 型）では改行を保存する。
  行内の全角間空白は常に除去する（「主 文」→見出しとして「主文」に正準化）。
"""
import argparse
import json
import os
import re
import sys
import time

import pdfplumber

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# HANREI_DATA_ROOT: 週次更新（scripts/hanrei/weekly）の作業フォルダ。未指定なら従来どおり hanrei_raw/
DATA_ROOT = os.path.abspath(os.environ['HANREI_DATA_ROOT']) if os.environ.get('HANREI_DATA_ROOT') else REPO_ROOT
PDF_DIR = os.path.join(DATA_ROOT, 'hanrei_raw', 'pdf')
OUT_DIR = os.path.join(DATA_ROOT, 'hanrei_raw', 'pdftext')

# --- 前処理（1行単位） ---
PAGE_NO_RE = re.compile(r'^\s*-\s*[0-9０-９]+\s*-\s*$')       # ③「- N -」
MARGIN_RE = re.compile(r'^(5|10|15|20|25)(\s+|$)')             # ②左余白行番号
DIGITS_ONLY_RE = re.compile(r'^\s*[0-9]+\s*$')                 # ④独立数字行

# --- 見出し・ブロック開始の判定（改行保存のため） ---
# 「主 文」「理 由」のように字間空白で組版されるため、各文字間に空白を許容する
MARKERS = ['事実及び理由', '事実及理由', '事実及び争点', '罪となるべき事実', '主文', '事実', '理由']


def _spaced(word):
    return r'[\s　]*'.join(re.escape(c) for c in word)


HEAD_SHUBUN_RE = re.compile(r'^[\s　]*主[\s　]*文[\s　]*$')
HEAD_MARKER_RE = re.compile(
    r'^[\s　]*(' + '|'.join(_spaced(w) for w in MARKERS) + r')[\s　]*$')
BLOCK_START_RE = re.compile(
    r'^[\s　]*(?:'
    r'第[０-９0-9一二三四五六七八九十百]+(?:[\s　]|$)'      # 第１ 事案の概要
    r'|[０-９0-9]{1,2}(?:[\s　]|$)'                          # １ 前提事実
    r'|[一二三四五六七八九十]{1,3}(?:[\s　]|$)'              # 一 …（昭和期）
    r'|[（(][０-９0-9一二三四五六七八九十ア-ン]{1,3}[）)]'       # (1) ／（ア）
    r'|[⑴-⒇]'
    r'|[ア-ン](?:[\s　])'                                    # ア 主張…
    r'|(?:別紙|別表|物件目録|当事者目録)'
    r')')
# 見出しとして独立させる番号見出し: 短くて句点を含まない
HEAD_MAX_LEN = 30

ZEN_JOIN_RE = re.compile(r'(?<=[^\x00-\x7f])[\s　]+(?=[^\x00-\x7f])')  # ①（行内）


def is_heading(line):
    if HEAD_SHUBUN_RE.match(line) or HEAD_MARKER_RE.match(line):
        return True
    t = line.strip().strip('　')
    if BLOCK_START_RE.match(line) and len(t) <= HEAD_MAX_LEN and '。' not in t:
        return True
    return False


def preclean_line(line):
    """②③④。除去対象なら None を返す。"""
    if PAGE_NO_RE.match(line):
        return None
    line = MARGIN_RE.sub('', line)
    if DIGITS_ONLY_RE.match(line):
        return None
    return line


def norm_inline(line):
    """行内の①適用 + trim。"""
    return ZEN_JOIN_RE.sub('', line.strip().strip('　')).strip()


def canonical_heading(line):
    """主文/理由等のマーカー見出しは空白除去で正準化。番号見出しは空白を半角1個に。"""
    t = line.strip().strip('　')
    if HEAD_MARKER_RE.match(line):
        return re.sub(r'[\s　]+', '', t)
    return re.sub(r'[\s　]+', ' ', t)


def joinable(prev_ch, next_ch):
    """改行を跨ぐ結合の可否: ①全角-全角 ②全角-数字 ③数字-全角（extract_cites3と同じ規則）"""
    p_zen = ord(prev_ch) > 0x7f
    n_zen = ord(next_ch) > 0x7f
    p_dig = prev_ch.isdigit()
    n_dig = next_ch.isdigit()
    return (p_zen and n_zen) or (p_zen and n_dig) or (p_dig and n_zen)


def normalize_pdf_text(raw_pages):
    """ページごとの生テキスト → 見出し保存つき正規化テキスト"""
    out = []
    cur = None
    for page_text in raw_pages:
        for raw in (page_text or '').split('\n'):
            line = preclean_line(raw)
            if line is None or not line.strip():
                continue
            if is_heading(line):
                if cur is not None:
                    out.append(cur)
                out.append(canonical_heading(line))
                cur = None
                continue
            piece = norm_inline(line)
            if not piece:
                continue
            if cur is None or BLOCK_START_RE.match(line):
                if cur is not None:
                    out.append(cur)
                cur = piece
            else:
                if joinable(cur[-1], piece[0]):
                    cur += piece
                else:
                    cur += ' ' + piece
    if cur is not None:
        out.append(cur)
    return '\n'.join(out)


def extract_one(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        raw_pages = [pg.extract_text() or '' for pg in pdf.pages]
        return len(pdf.pages), normalize_pdf_text(raw_pages)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='対象ID（カンマ区切り。point_ は自動で対象に含む）')
    ap.add_argument('--force', action='store_true', help='既出力も再抽出')
    ap.add_argument('--shard', help='並列実行用 i/n（idをnで割った剰余がiのものだけ処理）')
    args = ap.parse_args()

    only = set(args.only.split(',')) if args.only else None
    shard = None
    if args.shard:
        si, sn = args.shard.split('/')
        shard = (int(si), int(sn))
    if not os.path.isdir(PDF_DIR):
        print(f'PDFディレクトリがありません: {PDF_DIR}', file=sys.stderr)
        sys.exit(1)
    os.makedirs(OUT_DIR, exist_ok=True)

    files = sorted(f for f in os.listdir(PDF_DIR) if f.lower().endswith('.pdf'))
    t0 = time.time()
    done = skipped = errors = 0
    for i, fn in enumerate(files):
        m = re.match(r'^(point_)?(\d+)\.pdf$', fn)
        if not m:
            continue
        prefix, pid = m.group(1) or '', m.group(2)
        if only and pid not in only:
            continue
        if shard and int(pid) % shard[1] != shard[0]:
            continue
        out_path = os.path.join(OUT_DIR, f'{prefix}{pid}.json')
        if os.path.exists(out_path) and not args.force:
            skipped += 1
            continue
        try:
            pages, text = extract_one(os.path.join(PDF_DIR, fn))
            rec = {'id': pid, 'pages': pages, 'chars': len(text), 'text': text, 'found': True}
        except Exception as e:  # 壊れたPDFは記録して続行
            errors += 1
            rec = {'id': pid, 'pages': 0, 'chars': 0, 'text': '',
                   'found': False, 'error': type(e).__name__}
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(rec, f, ensure_ascii=False)
        done += 1
        if done % 100 == 0:
            print(f'  {done}件抽出 (経過 {time.time() - t0:.0f}s)')

    print(f'抽出完了: {done}件 / スキップ {skipped}件 / エラー {errors}件 ({time.time() - t0:.1f}s)')


if __name__ == '__main__':
    main()
