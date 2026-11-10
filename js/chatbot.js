/* 로컬 검색형 감사 도우미 — 서버 없이 이 기기 안에서 사례를 찾는다. */
(function () {
  "use strict";

  // 동의어·관련어 사전 (질의 확장용)
  const SYNONYMS = {
    "업무추진비": ["업추비", "접대비", "법인카드"],
    "교비": ["교비회계", "등록금회계"],
    "회계": ["예산", "결산", "집행", "교비"],
    "채용": ["임용", "신규채용", "공채", "심사위원"],
    "인사": ["승진", "채용", "임용"],
    "연구비": ["인건비", "간접비", "과제", "연구장비"],
    "계약": ["수의계약", "입찰", "발주", "구매"],
    "공사": ["시설", "설계변경", "준공"],
    "성적": ["학점", "출석", "학사"],
    "장학": ["장학금", "등록금"],
    "겸직": ["사외이사", "복무"],
    "징계": ["시효", "감경", "처분"],
    "공시": ["정보공시", "개인정보"],
    "이사회": ["회의록", "정관", "법인"]
  };
  const STOP = ["관련", "사례", "알려줘", "알려", "주세요", "줘", "보여줘", "어떤", "있어", "있나요", "무엇", "뭐", "좀", "대해", "대한", "지적", "지적사례", "감사", "어떻게", "해야", "하나요", "해"];
  const SUFFIX = ["에서는", "에서", "으로", "에게", "까지", "부터", "이랑", "하고", "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만"];

  function levenshtein(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  function stem(word) {
    for (const s of SUFFIX) {
      if (word.length > s.length + 1 && word.endsWith(s)) return word.slice(0, -s.length);
    }
    return word;
  }

  function tokenize(q) {
    return q.replace(/[^\p{L}\p{N}\s·]/gu, " ").split(/\s+/).map(w => stem(w.trim())).filter(w => w && w.length > 1 && !STOP.includes(w));
  }

  // 데이터에 등장하는 어휘에서 가장 가까운 단어 찾기 (오타 보정)
  function buildVocab(cases) {
    const v = new Set(Object.keys(SYNONYMS));
    Object.values(SYNONYMS).forEach(a => a.forEach(x => v.add(x)));
    cases.forEach(c => {
      (c.issue + " " + c.category + " " + c.law).split(/[\s·(),]+/).forEach(w => { const s = stem(w); if (s.length > 1) v.add(s); });
    });
    return [...v];
  }

  function correct(token, vocab) {
    // 2글자 단어는 오타 보정 시 엉뚱한 단어로 바뀌기 쉬워 그대로 둔다.
    if (vocab.includes(token) || token.length < 3) return token;
    let best = null, bestD = Infinity;
    const maxD = token.length <= 4 ? 1 : 2;
    for (const w of vocab) {
      if (Math.abs(w.length - token.length) > maxD) continue;
      const d = levenshtein(token, w);
      if (d < bestD) { bestD = d; best = w; }
    }
    return bestD <= maxD ? best : token;
  }

  function expand(tokens) {
    const out = new Set(tokens);
    tokens.forEach(t => {
      if (SYNONYMS[t]) SYNONYMS[t].forEach(x => out.add(x));
      Object.entries(SYNONYMS).forEach(([k, arr]) => { if (arr.includes(t)) out.add(k); });
    });
    return [...out];
  }

  function classifyIntent(q) {
    if (/(몇\s*건|건수|합계|총|통계|금액이?\s*(가장|제일)|가장\s*많|순위|top|상위)/i.test(q)) return "stats";
    if (/(준비|점검|체크|대비|서류|어떻게)/.test(q)) return "guide";
    return "search";
  }

  function search(cases, terms) {
    const scored = [];
    for (const c of cases) {
      const hay = (c.issue + " " + c.category + " " + c.law + " " + c.institution + " " + c.action).toLowerCase();
      let s = 0;
      terms.forEach((t, i) => { if (hay.includes(t.toLowerCase())) s += i < 3 ? 3 : 1; });
      if (s > 0) scored.push({ c, s: s + Math.min(2, (c.amount || 0) / 500000) });
    }
    return scored.sort((a, b) => b.s - a.s).map(x => x.c);
  }

  function respond(q, ctx) {
    const cases = ctx.cases;
    const vocab = ctx.vocab || (ctx.vocab = buildVocab(cases));
    const raw = tokenize(q);
    const fixed = raw.map(t => correct(t, vocab));
    const corrections = raw.map((t, i) => t !== fixed[i] ? `${t}→${fixed[i]}` : null).filter(Boolean);
    const terms = expand(fixed);
    const intent = classifyIntent(q);
    const fmt = ctx.fmtAmt;
    let text = "", list = [];
    const note = corrections.length ? `(검색어 보정: ${corrections.join(", ")})\n` : "";

    // 분야 판별
    const catOf = list => ctx.categories.find(k => k !== "기타" && list.some(t => k.includes(t) || k.split("·").some(p => t.includes(p))));
    const cat = catOf(fixed) || catOf(terms);

    if (intent === "stats") {
      const pool = cat ? cases.filter(c => c.category === cat) : cases;
      const total = pool.reduce((a, c) => a + (c.amount || 0), 0);
      const byMoney = /금액|돈|액수/.test(q);
      const byCat = {};
      pool.forEach(c => { byCat[c.category] = (byCat[c.category] || 0) + (byMoney ? (c.amount || 0) : 1); });
      const top = Object.entries(byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => `${k} ${byMoney ? fmt(v) : v + "건"}`).join(", ");
      text = `${cat ? `[${cat}] ` : ""}현재 데이터 기준 지적사례는 ${pool.length}건, 재정상 조치 금액 합계는 ${fmt(total)}입니다.` +
        (cat ? "" : `\n${byMoney ? "금액이 많은" : "많이 지적된"} 분야: ${top}`);
      list = [...pool].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 3);
      if (list.length) text += "\n금액이 큰 사례:";
    } else if (intent === "guide") {
      const g = window.KMCU_GUIDE.find(x => x.category === cat) || (raw.length ? null : window.KMCU_GUIDE[0]);
      if (g) {
        text = `[${g.category}] 준비 포인트 (담당: ${g.dept})\n` + g.checks.slice(0, 4).map(x => "• " + x).join("\n") + `\n\n필수 확인: ${g.must}\n자세한 점검표는 '준비가이드' 탭에서 확인하세요.`;
        list = search(cases, terms).slice(0, 3);
        if (list.length) text += "\n\n참고 사례:";
      } else {
        text = "어느 분야의 준비가 궁금하신가요? 예: '계약 감사 준비', '연구비 점검' 처럼 분야를 함께 적어 주세요.";
      }
    } else {
      list = search(cases, terms).slice(0, 5);
      if (list.length) {
        const all = search(cases, terms).length;
        text = `'${fixed.join(" ")}' 관련 사례 ${all}건을 찾았습니다. 관련도가 높은 ${list.length}건입니다:`;
      } else {
        text = "관련 사례를 찾지 못했습니다. 다른 표현(예: 업무추진비, 수의계약, 채용, 연구비)으로 다시 질문해 보세요.";
      }
    }
    return { text: note + text, cases: list, intent };
  }

  window.KMCU_CHAT = { respond, levenshtein, tokenize, classifyIntent };
})();
