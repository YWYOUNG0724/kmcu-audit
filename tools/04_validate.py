"""추출 결과 품질 검증: 보고서에 적힌 공식 지적 건수와 대조, 항목 누락·이상값 점검.
사용: python -X utf8 tools/04_validate.py  → raw/validation.json 저장, 요약 출력"""
import json, os, re, collections, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
man = json.load(open(os.path.join(ROOT, "raw/reports/manifest.json"), encoding="utf-8"))
data = json.load(open(os.path.join(ROOT, "data/moe-cases.json"), encoding="utf-8"))
cases = data["cases"]
by_src = collections.defaultdict(list)
for c in cases: by_src[c["url"].split("boardSeq=")[1].split("&")[0]].append(c)

def official_count(seq):
    """보고서 본문에 적힌 지적(처분) 건수. 찾지 못하면 None."""
    for f in man[seq]["files"]:
        base = os.path.join(ROOT, "raw/text", os.path.basename(f["local"]))
        for p in (base + ".txt", base + ".raw.txt"):
            if not os.path.exists(p): continue
            t = open(p, encoding="utf-8").read()
            for pat in (r"처분\s*요구\s*사항\s*\(\s*(\d+)\s*건\s*\)", r"감사결과\s*처분서\s*:\s*(\d+)\s*건",
                        r"(?:지적\s*건수|지적사항)[ \t]+(?:\d+[ \t]+){1,9}(\d+)[ \t]*\n"):   # 유형별 지적건수 표의 합계(맨 끝 숫자)
                m = re.search(pat, t)
                if m: return int(m.group(1))
    return None

rows, match, near, off, unknown = [], 0, 0, 0, 0
for seq, post in man.items():
    got = len(by_src.get(seq, []))
    if got == 0: continue
    exp = official_count(seq)
    st = "확인불가" if exp is None else ("일치" if exp == got else ("근접(±10%)" if abs(exp - got) <= max(1, exp * 0.1) else "불일치"))
    rows.append({"seq": seq, "title": post["title"], "official": exp, "extracted": got, "status": st})
cnt = collections.Counter(r["status"] for r in rows)

def pct(n): return f"{n} ({n / len(cases) * 100:.1f}%)"
checks = {
    "처분 빈칸": pct(sum(1 for c in cases if not c["action"])),
    "관련규정 빈칸": pct(sum(1 for c in cases if not c["law"])),
    "상세 빈칸": pct(sum(1 for c in cases if not c["detail"])),
    "제목 이상(4자 미만·80자 초과·숫자/기호 시작)": pct(sum(1 for c in cases if len(c["issue"]) < 4 or len(c["issue"]) > 80 or re.match(r"^[\d\W]", c["issue"]))),
    "금액 있음": pct(sum(1 for c in cases if c["amount"] > 0)),
    "금액 10억원 초과": sum(1 for c in cases if c["amount"] > 1_000_000),
    "분류 '기타'": pct(sum(1 for c in cases if c["category"] == "기타")),
    "중복(같은 보고서·같은 제목)": len(cases) - len({(c["url"], c["issue"]) for c in cases}),
}
out = {"reports_with_cases": len(rows), "cases": len(cases), "count_check": dict(cnt), "field_checks": checks,
       "mismatches": [r for r in rows if r["status"] == "불일치"],
       "big_amounts": sorted(({"issue": c["issue"], "institution": c["institution"], "amount_천원": c["amount"]} for c in cases if c["amount"] > 1_000_000), key=lambda x: -x["amount_천원"]),
       "odd_titles": [c["issue"] for c in cases if len(c["issue"]) < 4 or len(c["issue"]) > 80 or re.match(r"^[\d\W]", c["issue"])],
       "categories": collections.Counter(c["category"] for c in cases).most_common(),
       "actions": collections.Counter(a for c in cases for a in c["action"].split(", ") if a).most_common()}
json.dump(out, open(os.path.join(ROOT, "raw/validation.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps({k: out[k] for k in ("reports_with_cases", "cases", "count_check", "field_checks", "categories", "actions")}, ensure_ascii=False, indent=1))
print("불일치:", [(r["title"][:30], r["official"], r["extracted"]) for r in out["mismatches"]])
print("이상 제목:", out["odd_titles"][:20])
print("10억 초과:", [(b["institution"], b["issue"][:25], b["amount_천원"]) for b in out["big_amounts"][:15]])
