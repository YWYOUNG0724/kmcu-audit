"""감사 대상 기관에 학교 종류(전문대학/일반대학/교육대학/원격·사이버대학/대학원대학/기타기관)를 붙인다.

전문대학 판정 근거
  1) 한국전문대학교육협의회 회원대학 목록 (https://www.kcce.or.kr/web/collegeIntro/webKcceMemberCollegeList.do)
  2) 위키백과 '대한민국의 전문대학 목록' (폐교·교명변경 대학 보완)
  3) 아래 MANUAL (원문 보고서로 확인한 예외)

사용법:  python -X utf8 tools/05_school_types.py            (캐시된 목록 사용)
         python -X utf8 tools/05_school_types.py --refresh  (목록 다시 내려받기)
결과:    data/school-types.json 작성, data/moe-cases.json 각 건에 schoolType 추가
"""
import json, os, re, sys, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw")
KCCE_URL = "https://www.kcce.or.kr/web/collegeIntro/webKcceMemberCollegeList.do"
WIKI_URL = ("https://ko.wikipedia.org/w/index.php?action=raw&title="
            + urllib.parse.quote("대한민국의_전문대학_목록"))
UA = {"User-Agent": "Mozilla/5.0 (KMCU audit dashboard; research)"}

TYPES = ["전문대학", "일반대학", "교육대학", "원격·사이버대학", "대학원대학", "기타기관"]

# 원문·공식자료로 확인한 예외 (기관명 → (종류, 근거))
MANUAL = {
    "백석예술대학교": ("전문대학", "전문대학 학력인정 평생교육시설 (감사결과 보고서 본문)"),
    "한국골프대학교": ("전문대학", "현 한국골프과학기술대학교 (전문대교협 회원)"),
    "한국방송통신대학교": ("원격·사이버대학", "고등교육법상 방송통신대학"),
    "한국교원대학교": ("교육대학", "교원양성 국립대학"),
    "한국대학교육협의회": ("기타기관", "대학 아닌 협의체"),
    "사립대학": ("기타기관", "여러 사립대학 대상 실태 특정감사"),
}


def fetch(url, data=None):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode() if data else None, headers=UA)
    return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")


def kcce_members(refresh):
    path = os.path.join(RAW, "kcce_members.json")
    if os.path.exists(path) and not refresh:
        return json.load(open(path, encoding="utf-8"))
    names = []
    for page in range(1, 20):
        found = re.findall(r'mem_tt_kr">([^<]+)<', fetch(KCCE_URL, {"page": page}))
        if not found: break
        names += [n.strip() for n in found]
    names = sorted(set(names))
    json.dump(names, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    return names


def wiki_list(refresh):
    path = os.path.join(RAW, "wiki_jc.json")
    if os.path.exists(path) and not refresh:
        return json.load(open(path, encoding="utf-8"))
    t = fetch(WIKI_URL)
    names = {m.split("|")[-1].strip() for m in re.findall(r"\[\[([^\]]+)\]\]", t)}
    names = sorted(n for n in names if re.search(r"대학(교)?$", n) and "목록" not in n)
    json.dump(names, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    return names


def stem(name):
    return re.sub(r"대학교?$", "", name.replace(" ", ""))


def classify(name, junior):
    if name in MANUAL: return MANUAL[name]
    if stem(name) in junior: return junior[stem(name)]
    if name.endswith("대학원대학교"): return "대학원대학", "교명"
    if "사이버" in name: return "원격·사이버대학", "교명"
    if name.endswith("교육대학교"): return "교육대학", "교명"
    if re.search(r"대학교?$", name): return "일반대학", "전문대학 목록에 없음"
    return "기타기관", "대학 아님"


def main():
    refresh = "--refresh" in sys.argv
    kcce, wiki = kcce_members(refresh), wiki_list(refresh)
    junior = {stem(n): ("전문대학", "위키백과 전문대학 목록(폐교·교명변경 포함)") for n in wiki}
    junior.update({stem(n): ("전문대학", "전문대교협 회원대학") for n in kcce})

    path = os.path.join(ROOT, "data", "moe-cases.json")
    data = json.load(open(path, encoding="utf-8"))
    table = {}
    for c in data["cases"]:
        if c["institution"] == "한국대학교" and "대학교육협의회" in (c.get("source", "") + c.get("org", "")):
            c["institution"] = "한국대학교육협의회"        # 예전 추출본의 기관명 오류 보정
        t, why = classify(c["institution"], junior)
        c["schoolType"] = t
        table[c["institution"]] = {"type": t, "basis": why}
    for n in list(wiki) + list(kcce):                     # 감사 데이터에 없는 전문대학도 넣어 CSV 불러오기 때 자동 분류
        if re.search(r"대학(교)?$", n) and n not in table:
            table[n] = {"type": "전문대학", "basis": junior[stem(n)][1], "inData": False}
    data["meta"]["schoolTypes"] = {
        "types": TYPES,
        "source": "한국전문대학교육협의회 회원대학 목록, 위키백과 '대한민국의 전문대학 목록', 원문 보고서",
        "kcceMembers": len(kcce),
    }
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump({"meta": data["meta"]["schoolTypes"], "institutions": dict(sorted(table.items()))},
              open(os.path.join(ROOT, "data", "school-types.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    from collections import Counter
    inst = Counter(v["type"] for v in table.values())
    cases = Counter(c["schoolType"] for c in data["cases"])
    print(json.dumps({"kcce": len(kcce), "wiki": len(wiki), "institutions": inst, "cases": cases}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
