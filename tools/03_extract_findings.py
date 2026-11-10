"""raw/reports 의 교육부 감사결과 보고서(PDF)에서 처분요구 지적사항을 추출해 앱 형식 JSON으로 저장.

사용: python -X utf8 tools/03_extract_findings.py data/moe-cases.json
필요: pdftotext (poppler)

처분서 한 건은 보통 다음 순서로 되어 있다.
  교 육 부 / <처분 종류 줄> / 제 목 … / 소 관 기 관 … / 조 치 기 관 … / 내 용
  1. 업무개요  2. 관계법령 및 판단기준  3. 감사결과 확인된 문제점  … (n). 조치할 사항
"""
import json, os, re, subprocess, sys, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTS = os.path.join(ROOT, "raw", "reports")
PDFTOTEXT = os.environ.get("PDFTOTEXT", r"C:\Program Files\Git\mingw64\bin\pdftotext.exe")
TEXT_DIR = os.path.join(ROOT, "raw", "text")
os.makedirs(TEXT_DIR, exist_ok=True)

ACTION_BASE = ["기관경고", "기관주의", "중징계", "경징계", "징계", "문책", "경고", "주의", "시정", "회수", "통보", "개선", "권고", "고발", "수사의뢰", "임원취임승인취소", "변상",
               "파면", "해임", "정직", "감봉", "견책"]
ACTION_ALIAS = {"중징계": "징계", "경징계": "징계", "파면": "징계", "해임": "징계", "정직": "징계", "감봉": "징계", "견책": "징계"}

# 지적유형 분류 규칙 (위에서부터 먼저 맞는 것을 쓴다)
CATEGORY_RULES = [
    ("연구비·과제", r"연구비|연구개발|연구과제|연구장비|학생인건비|간접비|산학협력단|연구윤리|연구실적|논문"),
    ("채용·인사", r"채용|임용|승진|재임용|인사|정원|보직|호봉|연봉|전보|직원 .*임명|겸임교원|비전임|강사 (?:채용|위촉)|교원 .*심사"),
    ("교육·학사", r"학사|성적|학점|출석|수업|교육과정|졸업|휴학|복학|학위|시험|강의|교과|현장실습|학칙|편입|전과"),
    ("학생·장학", r"장학|등록금|입학|입시|전형|모집|신입생|외국인 학생|유학생|기숙사|학생지원|학생회"),
    ("계약·입찰", r"계약|입찰|수의|구매|발주|용역|조달|G2B|낙찰"),
    ("시설·공사", r"공사|시설|건축|설계|준공|안전점검|리모델링|유지보수"),
    ("복무·겸직", r"복무|겸직|출장|근무|휴가|초과근무|사외이사|영리"),
    ("징계·법령", r"징계|감경|처분 (?:요구 )?미이행|시효|비위"),
    ("개인정보·공시", r"공시|개인정보|정보공개|대학알리미"),
    ("예산·회계", r"회계|예산|결산|교비|법인카드|업무추진비|회의비|기본재산|수익용|재산|자금|세입|세출|전출|차입|적립금|기부금|발전기금|급여|수당|성과급|여비|부담금|카드|집행|지출|사용료|임대"),
    ("기타", r"이사회|정관|이사|감사 운영|규정|위원회"),
]


def to_text(pdf):
    out = os.path.join(TEXT_DIR, os.path.basename(pdf) + ".txt")
    if not os.path.exists(out):
        subprocess.run([PDFTOTEXT, "-enc", "UTF-8", "-layout", pdf, out], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return open(out, encoding="utf-8", errors="replace").read()


def clean(s):
    s = re.sub(r"\s*-\s*\d+\s*-\s*", " ", s)          # 쪽 번호
    return re.sub(r"\s+", " ", s).strip()


def norm_actions(line):
    line = re.sub(r"<\s*별도\s*조치\s*>.*", "", line)     # 별도조치(교육부 등)는 대학 처분이 아님
    acts = []
    for tok in re.split(r"[·,ㆍ/]", line):
        tok = re.sub(r"\(.*?\)|\s", "", tok)
        for base in ACTION_BASE:
            if tok.startswith(base):
                acts.append(ACTION_ALIAS.get(base, base)); break
    seen = []
    for a in acts:
        if a not in seen: seen.append(a)
    return seen


def money_to_thousand(num, unit):
    v = float(num.replace(",", ""))
    unit = unit.replace(" ", "")
    if unit.startswith("억"): return v * 100000
    if unit.startswith("백만"): return v * 1000
    if unit.startswith("천"): return v
    if unit.startswith("만"): return v * 10
    return v / 1000  # 원


AMT_RE = re.compile(r"(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(억\s*원|백만\s*원|천\s*원|만\s*원|원)")
RECOVER_RE = re.compile(r"(회수|반환|세입|변상|환수|보전|추징|감액|부당\s*(?:지급|집행))")


def recovery_amount(text):
    """'조치할 사항'에서 회수·세입 등 재정상 조치와 함께 나온 금액 중 가장 큰 값(천원).
    줄바꿈을 없앤 뒤 ①②… 항목과 '바랍니다/바라며/바라고' 단위로 나눠 같은 문장 안에서만 짝짓는다."""
    best = 0.0
    flat = clean(text)
    for sent in re.split(r"[①-⑳]|바랍니다|바라며|바라고", flat):
        if not RECOVER_RE.search(sent): continue
        for m in AMT_RE.finditer(sent):
            best = max(best, money_to_thousand(*m.groups()))
    return round(best)


PERSON_RE = re.compile(r"(?<![A-Za-z0-9])([A-Z]{1,2})(?![A-Za-z0-9])")


def count_persons(text):
    # 보고서는 관련자를 A, B, AK 같은 영문 기호로 가린다. 조치할 사항에 나온 서로 다른 기호 수.
    ids = {m for m in PERSON_RE.findall(text) if m not in ("G2B", "HiVE", "IT", "AI", "PC", "CCTV", "OK")}
    return len(ids)


def classify(title, body):
    for cat, pat in CATEGORY_RULES:
        if re.search(pat, title): return cat
    for cat, pat in CATEGORY_RULES:
        if re.search(pat, body[:600]): return cat
    return "기타"


def main_institution(post_title, org):
    """게시글 제목에서 감사 대상 대학 이름을 뽑는다. 예) '학교법인 화봉학원 및 대동대학교 종합감사 결과' → 대동대학교"""
    t = re.sub(r"(종합|재무|회계|특정|사안)?감사.*$", "", post_title)
    names = re.findall(r"([가-힣A-Za-z]+(?:대학원대학교|대학교|대학|과학기술원))(?!육|원|교)", t)   # '한국대학교육협의회' 제외
    names = [n for n in names if not n.startswith("학교법인")]
    if names: return names[-1]
    return org.split(",")[-1].strip() or org or t.strip()


def audit_type(post_title):
    t0 = post_title.replace(" ", "")
    for t in ("종합감사", "재무감사", "회계부분감사", "회계감사", "특정감사", "특별감사", "사안감사", "실태조사"):
        if t in t0: return t
    return "기타감사"
    return "기타감사"


SECTION_HEAD = re.compile(
    r"교\s*육\s*부[ \t]*\n(?P<acts>(?:(?![ \t]*제\s*목)[^\n]*\n){1,5}?)[ \t]*제[ \t]*목[ \t]+(?P<title>.{2,200}?)\n\s*소[ \t]*관[ \t]*기[ \t]*관[ \t]+(?P<org>[^\n]+)",
    re.S,
)


def parse_report(text, post):
    findings = []
    heads = list(SECTION_HEAD.finditer(text))
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        body = text[m.end():end]
        org = clean(m.group("org"))
        title = clean(m.group("title"))
        for o in [org] + [x.strip() for x in org.split(",")]:
            if o and title.endswith(o) and len(title) > len(o): title = title[: -len(o)].strip()
        acts = norm_actions(clean(m.group("acts")))
        law_sec = re.search(r"관계\s*법령[^\n]*\n(.*?)(?:\n\s*\d\.\s*감사결과|\n\s*3\.)", body, re.S)
        laws = re.findall(r"[「｢]\s*([^」｣]{2,40}?)\s*[」｣]", law_sec.group(1) if law_sec else body[:3000])
        law = ", ".join(dict.fromkeys(clean(l) for l in laws))[:120]
        prob = re.search(r"감사결과\s*확인된\s*문제점\s*\n(.*?)(?:\n\s*\d\.\s*관계\s*기관|\n\s*\d\.\s*조치할|\n\s*\d\.\s*징계)", body, re.S)
        detail = clean(prob.group(1))[:400] if prob else ""
        todo = re.search(r"조치할\s*사항\s*\n(.*)", body, re.S)
        todo_text = todo.group(1) if todo else ""
        todo_text = re.split(r"【\s*(?:붙임|별표|별첨)|<\s*별\s*도\s*조\s*치\s*>", todo_text)[0]
        findings.append({
            "institution": main_institution(post["title"], org),
            "org": org,
            "auditType": audit_type(post["title"]),
            "category": classify(title, detail),
            "issue": title,
            "detail": detail,
            "law": law,
            "action": ", ".join(acts),
            "amount": recovery_amount(todo_text),
            "persons": count_persons(todo_text),
            "year": int(post["date"][:4]),
            "url": f"https://www.moe.go.kr/boardCnts/viewRenew.do?boardID=345&boardSeq={post['seq']}&lev=0&statusYN=W&page=1&s=moe&m=041202&opType=N",
            "source": post["title"], "_body": clean(body[:3000]),
        })
    return findings


# ---------------------------------------------------------------------------
# 표 형식(2019~2023년 '감사결과 처분서'): 연번 | 지적사항 | 처분 의 2열 표.
# pdftotext -raw 는 왼쪽 열(지적사항)을 먼저, 오른쪽 열(처분)을 뒤에 출력한다.
# ---------------------------------------------------------------------------
def to_raw_text(pdf):
    out = os.path.join(TEXT_DIR, os.path.basename(pdf) + ".raw.txt")
    if not os.path.exists(out):
        subprocess.run([PDFTOTEXT, "-enc", "UTF-8", "-raw", pdf, out], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return open(out, encoding="utf-8", errors="replace").read()


NO_SPACE_BEFORE = re.compile(r"^[)\]’”】｣」,.·ㆍ%]")
NO_SPACE_AFTER = re.compile(r"[(\[‘“【｢「<]$")


def join_raw(lines):
    out = ""
    for ln in lines:
        ln = ln.strip()
        if not ln: continue
        if not out:
            out = ln; continue
        glue = " "
        if NO_SPACE_BEFORE.match(ln) or NO_SPACE_AFTER.search(out): glue = ""
        elif re.search(r"[\d,]$", out) and re.match(r"^[\d,]", ln): glue = ""   # 쪼개진 숫자
        elif re.search(r"제$", out) and re.match(r"^\d", ln): glue = ""        # 제\n5\n조
        elif re.search(r"\d$", out) and re.match(r"^(조|항|호|명|건|차례|회|년|월|일|개)", ln): glue = ""
        out += glue + ln
    return out


PAGE_NO = re.compile(r"^-\s*\d+\s*-$")


HEADER = re.compile(r"^연\s*번\s*지\s*적\s*사\s*항(?:\s*처\s*분\s*(?:\(\s*안\s*\))?)?$")
LONE_BULLET = ("ㅇ", "○", "o", "◦")
ACTION_WORDS = r"(?:기관경고|기관주의|중징계|경징계|징계|문책|경고|주의|시정|회수|통보|개선|권고|고발|수사의뢰|변상|파면|해임|정직|감봉|견책|임원취임승인)"
ACTION_LINE = re.compile(r"^[ㅇ○◦o]\s*" + ACTION_WORDS)


def table_segments(raw):
    """raw 텍스트를 쪽 머리글('연번 지적사항 처분') 단위 구간으로 나누고, 첨부 표 구간은 버린다.
    반환: [(기관명, [줄...]), ...]"""
    segs, cur, org, skipping, prev_page = [], None, "", False, False
    raw = re.sub(r"연\s*\n\s*번(?=\s*지)", "연번", raw)                 # '연⏎번 지적사항 처분'
    raw = re.sub(r"처\s*분\s*\(\s*\n\s*안\s*\)", "처분(안)", raw)
    raw = re.sub(r"(지\s*적\s*사\s*항)\s*\n\s*(처\s*분)", r"\1 \2", raw)      # '연번 지적사항⏎처분'
    lines = raw.splitlines()
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if PAGE_NO.match(s):
            prev_page = True; i += 1; continue
        # 쪽 맨 위의 【붙임】/【별표】/【참고】 → 첨부 표 시작 (다음 머리글까지 건너뜀)
        nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
        if prev_page and s.startswith("【") and re.search(r"붙\s*임|별\s*표|별\s*첨|참\s*고", s + nxt):
            skipping = True
        if re.match(r"^기관명", s):
            buf = []
            i += 1
            while i < len(lines) and not HEADER.match(lines[i].strip()):
                buf.append(lines[i]); i += 1
            org = re.sub(r"^:\s*", "", join_raw(buf))
            continue
        if HEADER.match(s):
            skipping = False
            cur = (org, []); segs.append(cur)
        elif re.match(r"^감사결과\s*처분서$", s):
            skipping = False
        elif cur is not None and not skipping:
            cur[1].append(s)
        prev_page = False
        i += 1
    return segs


TITLE_LINE = re.compile(r"^(\d{1,3})\s+((?!\d{2,4}[.\-/])[^\s(（].{1,110})$")   # 날짜로 시작하는 표 행 제외


def parse_table_report(raw, post):
    # 1) 쪽 구간별로 왼쪽 열(지적사항)과 오른쪽 열(처분)을 나눈다: 오른쪽 열은 단독 'ㅇ' 줄에서 시작.
    findings, cur, expect = [], None, 1
    for org, seg in table_segments(raw):
        # 새 지적사항 시작 확인 (연번이 1, 2, 3 … 순서대로 이어질 때만 인정)
        start = 0
        if seg:
            m = TITLE_LINE.match(seg[0])
            # 쪽 맨 위 '번호 제목'은 강한 신호 → 중간에 1~2건이 빠져도(쪽 중간에서 시작한 지적사항) 이어서 받는다
            if m and expect <= int(m.group(1)) <= expect + 2 and re.search(r"[가-힣]", m.group(2)):
                if cur: findings.append(cur)
                cur = {"org": org, "title": m.group(2).strip(), "body": [], "act": []}
                expect = int(m.group(1)) + 1; start = 1
        if cur is None: continue
        rest = seg[start:]
        k = next((i for i, l in enumerate(rest) if (l in LONE_BULLET and i > 0) or ACTION_LINE.match(l)), None)
        if k is None:
            cur["body"] += rest; continue
        j = k
        while j > 0 and (rest[j - 1].startswith(("【", "<", "〈")) or rest[j - 1].endswith(("】", ">", "〉"))):
            j -= 1
        cur["body"] += rest[:j]
        cur["act"] += rest[j:]
    if cur: findings.append(cur)

    result = []
    for f in findings:
        body = join_raw(f["body"])
        act_text = join_raw(f["act"])
        main_act = re.split(r"<\s*별\s*도\s*조\s*치\s*>", act_text)[0]
        acts = norm_actions("·".join(re.findall(r"[ㅇ○◦]\s*([^ㅇ○◦\-]+?)(?=\s*(?:[ㅇ○◦]|-|$|【))", main_act)))
        persons = sum(int(n) for n in re.findall(r"\((\d+)\s*명\)", main_act))
        laws = re.findall(r"[「｢]\s*([^」｣]{2,40}?)\s*[」｣]", body)
        prob = body.split("있는데도,", 1)[-1] if "있는데도," in body else body
        prob = re.sub(r"^\s*-\s*", "", prob).strip()
        title = re.sub(r"\s+", " ", f["title"])
        result.append({
            "institution": main_institution(post["title"], f["org"]),
            "org": f["org"],
            "auditType": audit_type(post["title"]),
            "category": classify(title, prob),
            "issue": title,
            "detail": prob[:400],
            "law": ", ".join(dict.fromkeys(clean(l) for l in laws))[:120],
            "action": ", ".join(acts),
            "amount": recovery_amount(main_act),
            "persons": persons,
            "year": int(post["date"][:4]),
            "url": f"https://www.moe.go.kr/boardCnts/viewRenew.do?boardID=345&boardSeq={post['seq']}&lev=0&statusYN=W&page=1&s=moe&m=041202&opType=N",
            "source": post["title"], "_body": clean(body[:3000]),
        })
    return result


# ---------------------------------------------------------------------------
# 3열 목록 형식(2019년 회계부분감사 등): 지적건명 | 지적내용 | 처분(안)
# -raw 출력 순서: '1.' → 제목 줄들 → ◦ 지적내용 → 【관련규정】 → 【기관명】 → ◦ 처분 …
# ---------------------------------------------------------------------------
LIST_HEADER = re.compile(r"^(?:연\s*번\s*)?지\s*적\s*건\s*명\s*지\s*적\s*내\s*용\s*처\s*분")


def is_org_bracket(txt):
    inner = txt.strip("【】 \t")
    return bool(inner) and not re.search(r"제\s*\d|규칙|규정|법\s*제|,", inner) and re.search(r"(학원|대학교?|학교|재단|법인|병원)$", inner.replace(" ", ""))


def parse_list_report(raw, post):
    raw = re.sub(r"처\s*분\s*\(\s*\n\s*안\s*\)", "처분(안)", raw)
    lines, seen_header = [], False
    for l in raw.splitlines():
        s = l.strip()
        if LIST_HEADER.match(s): seen_header = True; continue
        if not seen_header or not s or PAGE_NO.match(s): continue   # 표지·개요 부분 제외
        if re.match(r"^【\s*(법인|교비|산학협력단|부속병원|수익사업)?\s*회계\s*】$", s): continue  # 구분 표시
        s = re.sub(r"^○", "◦", s)                                     # 글머리 통일
        if "◦" in s and not s.startswith("◦"):                       # '제목 ◦' 한 줄 분리
            a, b = s.split("◦", 1)
            lines.append(a.strip()); s = "◦" + b
        lines.append(s)
    # 지적사항 시작: 'n.' / 'n' 단독 줄 또는 'n. 제목' (1, 2, 3 … 순서)
    def find_starts(dotted_only):
        st, expect = [], 1
        for i, s in enumerate(lines):
            pat = r"^(\d{1,3})\.\s*(.*)$" if dotted_only else r"^(\d{1,3})(?:\.\s*(.*)|\s+(.*)|)$"   # '1.제목' '1. 제목' '1 제목' '1'
            m = re.match(pat, s)
            if not m: continue
            rest_txt = next((g for g in m.groups()[1:] if g), "")
            looks_numeric = re.match(r"^\d{2,}|^\d+\s*[.,/]\s*\d", rest_txt)          # 날짜·금액 (단, '4대 폭력'은 허용)
            n = int(m.group(1))
            ok_num = n == expect or (dotted_only and n == expect + 1)               # 점 붙은 번호는 1건 건너뛰기 허용
            if ok_num and not looks_numeric and (rest_txt or (i + 1 < len(lines) and re.search(r"[가-힣一-鿿]", lines[i + 1]))):
                st.append(i); expect = n + 1
        return st
    # 본문 속 숫자('15명' 등)를 번호로 오인하면 이후 번호가 모두 밀리므로, 두 방식 중 더 많이 이어지는 쪽을 쓴다.
    starts = max(find_starts(True), find_starts(False), key=len)
    result = []
    for n, si in enumerate(starts):
        seg = lines[si: starts[n + 1] if n + 1 < len(starts) else len(lines)]
        first = re.sub(r"^\d{1,2}(?:\.\s*|\s+|$)", "", seg[0])
        seg = ([first] if first else []) + seg[1:]
        # 제목: 첫 '◦' 전까지
        t_end = next((i for i, s in enumerate(seg) if s.startswith(("◦", "ㅇ", "○"))), None)
        if t_end is None: continue
        title_parts = seg[:t_end]
        head, sep, tail = (seg[t_end].partition("◦") if "◦" in seg[t_end] else (seg[t_end], "", ""))
        title = join_raw(title_parts).replace(" ", "") if all(len(p) < 12 for p in title_parts) else join_raw(title_parts)
        title = re.sub(r"\s*◦.*$", "", title).strip()
        rest = seg[t_end:]
        # 처분 열 시작: 기관명 괄호 또는 '◦' 다음 처분 단어
        a = None
        for i in range(len(rest)):
            s = rest[i]
            nxt = rest[i + 1] if i + 1 < len(rest) else ""
            if s.startswith("【") and is_org_bracket(s if s.endswith("】") else s + nxt):
                a = i; break
            if (s in ("◦", "ㅇ") and re.match(ACTION_WORDS, nxt)) or (i > 0 and ACTION_LINE.match(s)):
                a = i; break
        if a is None: continue
        body = join_raw(rest[:a])
        act = join_raw(rest[a:])
        laws = re.findall(r"【([^【】]*?(?:법|규칙|규정|지침|안내)[^【】]*?)】", body)
        law = ", ".join(dict.fromkeys(clean(re.split(r"\s*제\s*\d", l)[0]) for l in re.split(r",\s*", ", ".join(laws)) if l.strip()))[:120]
        body_wo_law = re.sub(r"【[^【】]*】", " ", body)
        acts = norm_actions("·".join(re.findall(r"[◦ㅇ○]\s*([^◦ㅇ○\-]+?)(?=\s*(?:[◦ㅇ○]|-|$|【))", act)))
        persons = sum(int(p) for p in re.findall(r"-\s*(\d+)\s*명", act))
        result.append({
            "institution": main_institution(post["title"], ""),
            "org": ", ".join(dict.fromkeys(x.strip("【】 ") for x in re.findall(r"【[^【】]*】", act) if is_org_bracket(x))),
            "auditType": audit_type(post["title"]),
            "category": classify(title, body_wo_law),
            "issue": title,
            "detail": clean(body_wo_law.lstrip("◦ "))[:400],
            "law": law,
            "action": ", ".join(acts),
            "amount": recovery_amount(act),
            "persons": persons,
            "year": int(post["date"][:4]),
            "url": f"https://www.moe.go.kr/boardCnts/viewRenew.do?boardID=345&boardSeq={post['seq']}&lev=0&statusYN=W&page=1&s=moe&m=041202&opType=N",
            "source": post["title"], "_body": clean(body[:3000]),
        })
    return result


def to_hwp_text(path):
    """HWP/HWPX 본문을 PDF -raw 결과와 같은 모양으로 맞춘다."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import hwp_text
    out = os.path.join(TEXT_DIR, os.path.basename(path) + ".txt")
    if not os.path.exists(out):
        open(out, "w", encoding="utf-8").write(hwp_text.extract(path))
    t = open(out, encoding="utf-8").read()
    t = re.sub(r"\n[ \t]*\n+", "\n", t)
    t = re.sub(r"연\s*번\s*\n\s*지\s*적\s*사\s*항\s*\n\s*처\s*분(\s*\(\s*안\s*\))?", "연번 지적사항 처분", t)
    t = re.sub(r"(?:연\s*번\s*\n\s*)?지\s*적\s*건\s*명\s*\n\s*지\s*적\s*내\s*용\s*\n\s*처\s*분(\s*\(\s*안\s*\))?", "지적건명 지적내용 처분(안)", t)
    t = re.sub(r"(연번 지적사항 처분)\n\s*(\d{1,3})\s*\n\s*", r"\1\n\2 ", t)          # 연번과 제목이 다른 셀
    t = re.sub(r"(?m)^[ \t]*【\s*(붙\s*임|별\s*표|별\s*첨)\s*\d*\s*】[ \t]*$", "- 0 -\n【붙임】", t)  # 첨부 시작 표시
    return t


def main(out_path):
    manifest = json.load(open(os.path.join(REPORTS, "manifest.json"), encoding="utf-8"))
    cases, report_stats = [], []
    for seq, post in sorted(manifest.items(), key=lambda kv: kv[1]["date"], reverse=True):
        got = []
        for f in post["files"]:
            path = os.path.join(ROOT, f["local"])
            if path.lower().endswith((".hwp", ".hwpx")):
                try:
                    t = to_hwp_text(path)
                    got += parse_table_report(t, post) or parse_list_report(t, post)
                except Exception as e:
                    print("HWP 읽기 실패", path, e, file=sys.stderr)
                continue
            if not path.lower().endswith(".pdf"): continue
            try:
                found = parse_report(to_text(path), post)
                if not found:
                    found = parse_table_report(to_raw_text(path), post)
                if not found:
                    found = parse_list_report(to_raw_text(path), post)
                got += found
            except subprocess.CalledProcessError:
                pass
        report_stats.append({"seq": seq, "date": post["date"], "title": post["title"], "files": len(post["files"]),
                             "pdfs": sum(f["local"].endswith(".pdf") for f in post["files"]), "findings": len(got)})
        cases += got
    LAW_NAME = re.compile(r"((?:[가-힣·]+\s?){0,6}?[가-힣·]*(?:법률|법|법\s?시행령|법\s?시행규칙|시행령|규칙|규정|지침|훈령|정관))\s*제\s*\d+\s*조")
    BAD_LAW = re.compile(r"같은|동법|^(?:항|조|호|및|등|위|또는|따라|따르면|의한|에)\b|^(?:항|조|호|및)\s")
    for i, c in enumerate(cases, 1):
        c["id"] = f"M{i:05d}"
        body = c.pop("_body", "")
        if not c["law"]:                                  # 괄호 없이 '사립학교법 제29조'처럼 쓴 경우 보완
            names = [re.sub(r"\s+", " ", n).strip() for n in LAW_NAME.findall(body + " " + c["detail"])]
            names = [re.sub(r"^(?:및|또는|그리고|따라|따르면|의한)\s+", "", n) for n in names]
            names = [n for n in names if 2 < len(n) <= 30 and not BAD_LAW.search(n)]
            if names: c["law"] = ", ".join(dict.fromkeys(names))[:120]
        # 공통 정리: '같은 법 시행령' 같은 지시어 항목·빈 항목 제거
        parts = [p.strip() for p in c["law"].split(",")]
        c["law"] = ", ".join(dict.fromkeys(p for p in parts if p and not re.match(r"^(같은|동)\s?법", p)))
    import datetime
    meta = {"name": "교육부 감사결과 (2019~)", "isSample": False, "unit": "천원",
            "source": "교육부 관할기관 감사정보 게시판 감사결과 보고서(공개본)",
            "note": "PDF·HWP에서 자동 추출. 금액은 '조치할 사항(처분)'의 회수·징수·세입 요구 금액 중 최댓값, 관련자는 처분 대상 인원(추정).",
            "reports": sum(1 for r in report_stats if r["findings"]), "reportsCollected": len(report_stats),
            "collectedAt": datetime.date.today().isoformat()}
    json.dump({"meta": meta, "cases": cases}, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(report_stats, open(os.path.join(ROOT, "raw", "extract_report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({"reports": len(report_stats), "cases": len(cases),
                      "no_findings": [r["title"] for r in report_stats if r["findings"] == 0]}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
