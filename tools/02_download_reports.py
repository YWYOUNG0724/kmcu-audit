"""board_list.json 에서 2019년 이후 대학 감사결과 글을 골라 첨부파일을 raw/reports/ 에 내려받는다.
받은 파일 목록은 raw/reports/manifest.json 에 기록(게시글·파일명·크기·SHA-256)."""
import re, html, json, time, sys, os, hashlib, urllib.request, urllib.parse
FROM_YEAR = int(sys.argv[1]) if len(sys.argv) > 1 else 2019
UA = {"User-Agent": "Mozilla/5.0 (KMCU audit board data collector)"}
VIEW = "https://www.moe.go.kr/boardCnts/viewRenew.do?boardID=345&boardSeq={}&lev=0&statusYN=W&page=1&s=moe&m=041202&opType=N"
OUT = "raw/reports"; os.makedirs(OUT, exist_ok=True)
rows = json.load(open("raw/board_list.json", encoding="utf-8"))
target = [r for r in rows if "결과" in r["title"] and "감사" in r["title"] and "계획" not in r["title"]
          and "대학" in r["title"] and int(r["date"][:4]) >= FROM_YEAR]
man_path = f"{OUT}/manifest.json"
manifest = json.load(open(man_path, encoding="utf-8")) if os.path.exists(man_path) else {}
def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60)
for i, r in enumerate(target, 1):
    if r["seq"] in manifest and manifest[r["seq"]]["files"]: continue
    s = get(VIEW.format(r["seq"])).read().decode("utf-8", "replace")
    files = []
    for name, seq in re.findall(r"<li>\s*([^<]+?)\s*\[\s*[\d.,]+\s*[KMG]?B\s*\]\s*<a[^>]+fileDown\.do\?[^\"]*fileSeq=([0-9a-f]+)", s):
        name = html.unescape(name).strip()
        ext = os.path.splitext(name)[1].lower()
        if ext not in (".pdf", ".hwp", ".hwpx"): continue
        local = f"{OUT}/{r['seq']}_{len(files)+1}{ext}"
        data = get(f"https://www.moe.go.kr/boardCnts/fileDown.do?m=041202&s=moe&fileSeq={seq}").read()
        open(local, "wb").write(data)
        files.append({"name": name, "local": local, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        time.sleep(0.8)
    manifest[r["seq"]] = {**r, "files": files}
    json.dump(manifest, open(man_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{i}/{len(target)} {r['date']} {r['title'][:40]} files={len(files)}", flush=True)
    time.sleep(0.8)
print("done", len(manifest), sum(len(v['files']) for v in manifest.values()), sum(f['bytes'] for v in manifest.values() for f in v['files']))
