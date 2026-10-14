#!/usr/bin/env python3
"""
공모전, 경진대회, 사업계획서 실전 HWP/HWPX 문서 수집기
GitHub에 공개된 실제 공모전 참가신청서 및 제안서 한글 문서들을 탐색하여 tests/fixtures/contests/에 다운로드합니다.
"""

import os
import sys
import json
import urllib.request
import urllib.parse
import re

TARGET_DIR = os.path.abspath("tests/fixtures/contests")
os.makedirs(TARGET_DIR, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    "Accept": "application/vnd.github.v3+json",
}

KEYWORDS = [
    "공모전", "경진대회", "해커톤", "사업계획서", "창업동아리",
    "예비창업패키지", "참가신청서", "제안서", "공고문"
]

def search_repos(keyword):
    q = urllib.parse.quote(keyword)
    url = f"https://api.github.com/search/repositories?q={q}&sort=updated&per_page=15"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return [it["full_name"] for it in data.get("items", [])]
    except Exception as e:
        print(f"[-] 검색 실패 ({keyword}): {e}")
        return []

def get_hwp_files_from_repo(repo_full_name):
    # 기본 브랜치 트리 조회
    branches = ["main", "master"]
    for branch in branches:
        url = f"https://api.github.com/repos/{repo_full_name}/git/trees/{branch}?recursive=1"
        req = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
                tree = data.get("tree", [])
                hwp_files = []
                for item in tree:
                    path = item.get("path", "")
                    if path.lower().endswith((".hwp", ".hwpx")):
                        hwp_files.append((branch, path))
                if hwp_files:
                    return hwp_files
        except Exception:
            continue
    return []

def download_file(repo, branch, file_path):
    raw_url = f"https://raw.githubusercontent.com/{repo}/{branch}/{urllib.parse.quote(file_path)}"
    base_name = os.path.basename(file_path)
    # 안전한 파일명 생성
    clean_name = re.sub(r'[^\w\.\-\(\)\[\]가-힣 ]', '_', base_name)
    save_path = os.path.join(TARGET_DIR, clean_name)

    req = urllib.request.Request(raw_url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read()
            # 매직 넘버 검증 (CFBF: D0 CF 11 E0 또는 ZIP: 50 4B 03 04)
            if len(content) < 512:
                return None
            is_cfbf = content[:4] == b'\xd0\xcf\x11\xe0'
            is_zip = content[:4] == b'\x50\x4b\x03\x04'

            if not (is_cfbf or is_zip):
                return None

            with open(save_path, "wb") as f:
                f.write(content)
            print(f"[+] 다운로드 성공: {clean_name} ({len(content):,} bytes) from {repo}")
            return save_path
    except Exception as e:
        return None

def main():
    print(f"[*] 공모전 실전문서 수집 시작... 저장 위치: {TARGET_DIR}")
    downloaded = 0
    checked_repos = set()

    for kw in KEYWORDS:
        print(f"[*] 키워드 탐색 중: '{kw}'")
        repos = search_repos(kw)
        for repo in repos:
            if repo in checked_repos:
                continue
            checked_repos.add(repo)

            hwp_items = get_hwp_files_from_repo(repo)
            if hwp_items:
                print(f"[!] {repo}에서 {len(hwp_items)}개의 한글 파일 발견!")
                for branch, path in hwp_items:
                    res = download_file(repo, branch, path)
                    if res:
                        downloaded += 1
                        if downloaded >= 30: # 30개 이상 확보 시 종료
                            print(f"[★] 목표 달성! 총 {downloaded}개 파일 수집 완료.")
                            return

    print(f"[*] 수집 종료. 총 {downloaded}개의 유효한 한글 문서 확보.")

if __name__ == "__main__":
    main()
