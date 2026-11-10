"""교육부 '관할기관 감사정보' 게시판(boardID=345) 목록을 수집해 raw/board_list.json 으로 저장.
제목·담당부서·등록일·게시글 번호만 읽는다(첨부 다운로드 없음)."""
import re, html, json, time, sys, urllib.request
BASE = "https://www.moe.go.kr/boardCnts/listRenew.do?boardID=345&m=041202&s=moe&page={}"
UA = {"User-Agent": "Mozilla/5.0 (KMCU audit board data collector)"}
rows, seen = [], set()
for page in range(1, 200):
    req = urllib.request.Request(BASE.format(page), headers=UA)
    s = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
    found = 0
    for m in re.finditer(r'<tr>\s*<td class="no">(\d+)</td>(.*?)</tr>', s, re.S):
        no, body = m.groups()
        g = re.search(r"goView\('345', '(\d+)'", body)
        tds = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t))).strip() for t in re.findall(r"<td[^>]*>(.*?)</td>", body, re.S)]
        if not g or g.group(1) in seen: continue
        seen.add(g.group(1)); found += 1
        rows.append({"no": int(no), "seq": g.group(1), "title": tds[0], "dept": tds[1], "date": tds[2]})
    print(page, found, file=sys.stderr)
    if not found: break
    time.sleep(0.7)
json.dump(rows, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(rows))
