/* KMCU 감사 대비 현황판 — 메인 로직 */
(function () {
  "use strict";

  const STORE_DATA = "kmcu.audit.data.v1";
  const STORE_CHECK = "kmcu.audit.checks.v1";
  const STORE_THEME = "kmcu.audit.theme";
  const STORE_SCOPE = "kmcu.audit.scope";
  const SCHOOL_TYPES = ["전문대학", "일반대학", "교육대학", "원격·사이버대학", "대학원대학", "기타기관", "미분류"];
  const PAGE_SIZE = 20;
  const CATEGORIES = ["예산·회계", "채용·인사", "교육·학사", "연구비·과제", "시설·공사", "계약·입찰", "복무·겸직", "징계·법령", "개인정보·공시", "학생·장학", "기타"];

  const state = {
    all: [], cases: [], scope: "", schoolMap: {}, meta: {}, depts: [], sample: null,
    filtered: [], sortKey: "amount", sortDir: -1, page: 1,
    instSort: "count", charts: {}, checks: {}
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  };

  // ---------- 금액 표시 (단위: 천원) ----------
  function fmtAmt(thousand) {
    const won = (thousand || 0) * 1000;
    if (won >= 1e12) return (won / 1e12).toFixed(2) + "조원";
    if (won >= 1e8) return (won / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + "억원";
    if (won >= 1e4) return Math.round(won / 1e4).toLocaleString("ko-KR") + "만원";
    return won ? won.toLocaleString("ko-KR") + "원" : "-";
  }
  const toEok = t => +(((t || 0) * 1000) / 1e8).toFixed(2);
  const actionsOf = c => String(c.action || "").split(/[,·/]/).map(s => s.trim()).filter(Boolean);

  // ---------- 데이터 정규화 ----------
  const ALIASES = {
    institution: ["institution", "기관명", "기관", "대학명", "대상기관"],
    auditType: ["auditType", "감사종류", "감사유형"],
    category: ["category", "지적유형", "분야", "유형"],
    issue: ["issue", "지적내용", "지적사항", "내용", "제목"],
    law: ["law", "관련규정", "근거", "관련법령"],
    action: ["action", "처분", "처분유형", "조치"],
    amount: ["amount", "금액", "부당집행금액", "금액(천원)"],
    persons: ["persons", "관련자", "관련자수", "인원"],
    year: ["year", "연도", "감사연도"],
    url: ["url", "링크", "원문"]
  };
  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    const n = parseFloat(String(v ?? "").replace(/[^\d.\-]/g, ""));
    return isFinite(n) ? n : 0;
  }
  function normCategory(v) {
    const s = String(v || "").trim();
    if (CATEGORIES.includes(s)) return s;
    const hit = CATEGORIES.find(k => k.split("·").some(p => s.includes(p)));
    return hit || (s || "기타");
  }
  function normalize(row, i) {
    const pick = f => { for (const a of ALIASES[f]) if (row[a] !== undefined && row[a] !== "") return row[a]; return ""; };
    return {
      id: row.id || `U${String(i + 1).padStart(4, "0")}`,
      institution: String(pick("institution")).trim() || "(기관 미상)",
      auditType: String(pick("auditType")).trim() || "기타",
      category: normCategory(pick("category")),
      issue: String(pick("issue")).trim(),
      law: String(pick("law")).trim(),
      action: String(pick("action")).trim(),
      amount: num(pick("amount")),
      persons: Math.round(num(pick("persons"))),
      year: Math.round(num(pick("year"))) || "",
      url: /^https?:\/\//i.test(String(pick("url"))) ? String(pick("url")).trim() : "",
      detail: String(row.detail ?? row["확인된문제점"] ?? row["상세"] ?? "").trim(),
      org: String(row.org ?? row["소관기관"] ?? "").trim(),
      source: String(row.source ?? row["출처"] ?? "").trim(),
      schoolType: schoolTypeOf(String(row.schoolType ?? row["학교종류"] ?? "").trim(), String(pick("institution")).trim())
    };
  }
  // 학교 종류: 값이 있으면 그대로, 없으면 data/school-types.json → 교명 규칙 순으로 추정
  function schoolTypeOf(v, inst) {
    if (SCHOOL_TYPES.includes(v)) return v;
    if (/전문/.test(v)) return "전문대학";
    const known = state.schoolMap[inst];
    if (known) return known.type;
    if (/대학원대학교$/.test(inst)) return "대학원대학";
    if (/사이버|방송통신/.test(inst)) return "원격·사이버대학";
    if (/교육대학교$/.test(inst)) return "교육대학";
    return "미분류";
  }

  // RFC4180 수준의 CSV 파서 (따옴표 안 쉼표·줄바꿈 처리)
  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    const nonEmpty = rows.filter(r => r.some(c => c.trim() !== ""));
    if (nonEmpty.length < 2) return [];
    const head = nonEmpty[0].map(h => h.trim());
    return nonEmpty.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
  }

  async function loadJSON(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }

  async function loadData() {
    // 기본 데이터: 교육부 감사결과(data/moe-cases.json). 없으면 가상 예시 데이터.
    const base = await loadJSON("data/moe-cases.json").catch(() => loadJSON("data/sample-cases.json"));
    const depts = await loadJSON("data/departments.json");
    state.schoolMap = (await loadJSON("data/school-types.json").catch(() => ({}))).institutions || {};
    const sample = base;
    state.sample = sample;
    state.depts = depts.departments || [];
    const saved = store.get(STORE_DATA);
    if (saved && Array.isArray(saved.cases) && saved.cases.length) setData(saved.cases, saved.meta || {}, false);
    else setData(sample.cases, sample.meta, false);
  }

  function setData(cases, meta, persist) {
    state.all = cases.map(normalize).filter(c => c.issue || c.institution);
    state.meta = meta || {};
    if (persist) {
      if (!store.set(STORE_DATA, { meta: state.meta, cases: state.all })) {
        showMsg("브라우저 저장 공간이 부족해 이번 세션에서만 사용됩니다.", "err");
      }
    }
    applyScope(state.scope);
  }

  // ---------- 학교 종류 범위 (모든 화면에 적용) ----------
  function applyScope(scope) {
    const types = group(state.all, x => x.schoolType).map(x => x[0]);
    state.scope = types.includes(scope) ? scope : "";
    state.cases = state.scope ? state.all.filter(c => c.schoolType === state.scope) : state.all;
    chatCtx.vocab = null;
    renderScopeBar();
    renderAll();
  }
  function renderScopeBar() {
    const bar = $("#scopeBar");
    const cnt = group(state.all, x => x.schoolType);
    const order = t => { const i = SCHOOL_TYPES.indexOf(t); return i < 0 ? 99 : i; };
    cnt.sort((a, b) => order(a[0]) - order(b[0]));
    bar.hidden = cnt.length < 2;
    const btn = (v, label, n) => `<button type="button" class="scope-btn${state.scope === v ? " active" : ""}" data-scope="${esc(v)}" aria-pressed="${state.scope === v}">${esc(label)} <small>${n.toLocaleString("ko-KR")}</small></button>`;
    $("#scopeBtns").innerHTML = btn("", "전체", state.all.length) + cnt.map(([t, n]) => btn(t, t, n)).join("");
  }

  // ---------- 탭 ----------
  function showPage(id) {
    $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.page === id)));
    $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + id));
    if (id === "dashboard") Object.values(state.charts).forEach(c => c.resize());
    try { history.replaceState(null, "", "#" + id); } catch { /* ignore */ }
  }

  // ---------- 대시보드 ----------
  function renderKpis() {
    const c = state.cases;
    const total = c.reduce((a, x) => a + x.amount, 0);
    const inst = new Set(c.map(x => x.institution)).size;
    const persons = c.reduce((a, x) => a + x.persons, 0);
    const money = c.filter(x => x.amount > 0).length;
    const k = [
      ["총 지적사례", c.length.toLocaleString("ko-KR"), "건", state.scope ? `${state.scope} 사례` : "불러온 전체 사례"],
      ["재정상 조치 금액", fmtAmt(total), "", "회수·징수·세입 요구 합계"],
      ["대상 기관 수", inst.toLocaleString("ko-KR"), "개", "대학·법인 포함"],
      ["관련자 합계", persons.toLocaleString("ko-KR"), "명", "징계·처분 관련 인원"],
      ["금액 발생 사례", money.toLocaleString("ko-KR"), "건", c.length ? `전체의 ${Math.round(money / c.length * 100)}%` : ""]
    ];
    $("#kpis").innerHTML = k.map(([l, v, u, h]) => `<div class="card kpi"><div class="label">${l}</div><div class="value" data-kpi="${l}">${esc(v)}<small>${u}</small></div><div class="hint">${h}</div></div>`).join("");
  }

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  const PALETTE = ["#2f6fb5", "#1f9a8a", "#d08a1c", "#c2475a", "#7b5cc4", "#4c9bd6", "#6a9a2f", "#b0663a", "#8a8f99", "#3f7f7f", "#a2559c"];

  function makeChart(id, type, labels, data, opts = {}) {
    if (!window.Chart) return;
    if (state.charts[id]) state.charts[id].destroy();
    const text = cssVar("--text"), grid = cssVar("--border"), muted = cssVar("--muted");
    const isPie = type === "doughnut";
    state.charts[id] = new Chart(document.getElementById(id), {
      type,
      data: { labels, datasets: [{ data, backgroundColor: isPie ? PALETTE : (opts.color || PALETTE[0]), borderColor: isPie ? cssVar("--surface") : "transparent", borderWidth: isPie ? 2 : 0, borderRadius: isPie ? 0 : 4, maxBarThickness: 28 }] },
      options: {
        responsive: true, maintainAspectRatio: false, indexAxis: opts.horizontal ? "y" : "x",
        plugins: {
          legend: { display: isPie, position: "right", labels: { color: text, boxWidth: 12, font: { size: 12 } } },
          tooltip: { callbacks: { label: ctx => `${ctx.label}: ${(ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed).toLocaleString("ko-KR")}${opts.unit || ""}` } }
        },
        scales: isPie ? {} : {
          x: { ticks: { color: muted, font: { size: 11 }, autoSkip: false, maxRotation: opts.horizontal ? 0 : 45 }, grid: { color: opts.horizontal ? grid : "transparent" } },
          y: { ticks: { color: muted, font: { size: 11 } }, grid: { color: opts.horizontal ? "transparent" : grid }, beginAtZero: true }
        },
        onClick: opts.onClick ? (_, el) => { if (el[0]) opts.onClick(labels[el[0].index]); } : undefined
      }
    });
  }

  function group(arr, keyFn, valFn = () => 1) {
    const m = new Map();
    arr.forEach(x => { [].concat(keyFn(x)).forEach(k => m.set(k, (m.get(k) || 0) + valFn(x))); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderCharts() {
    const c = state.cases;
    const goCat = cat => { $("#fCat").value = cat; applyFilter(); showPage("cases"); };
    const goInst = name => { showPage("institutions"); showInst(name); };
    const cc = group(c, x => x.category);
    makeChart("chCatCount", "bar", cc.map(x => x[0]), cc.map(x => x[1]), { unit: "건", onClick: goCat });
    const ca = group(c.filter(x => x.amount > 0), x => x.category, x => x.amount).map(([k, v]) => [k, toEok(v)]);
    makeChart("chCatAmount", "bar", ca.map(x => x[0]), ca.map(x => x[1]), { unit: "억원", color: PALETTE[1], onClick: goCat });
    const at = group(c, x => x.auditType);
    makeChart("chAuditType", "doughnut", at.map(x => x[0]), at.map(x => x[1]), { unit: "건" });
    const ac = group(c, actionsOf);
    makeChart("chAction", "bar", ac.map(x => x[0]), ac.map(x => x[1]), { unit: "건", color: PALETTE[2] });
    const ic = group(c, x => x.institution).slice(0, 10);
    makeChart("chInstCount", "bar", ic.map(x => x[0]), ic.map(x => x[1]), { unit: "건", horizontal: true, onClick: goInst });
    const ia = group(c.filter(x => x.amount > 0), x => x.institution, x => x.amount).slice(0, 10).map(([k, v]) => [k, toEok(v)]);
    makeChart("chInstAmount", "bar", ia.map(x => x[0]), ia.map(x => x[1]), { unit: "억원", horizontal: true, color: PALETTE[3], onClick: goInst });
    // 학교 종류별 기관당 평균 지적건수 (항상 전체 데이터 기준 — 우리 학교 유형과 비교용)
    const st = new Map();
    state.all.forEach(x => { const s = st.get(x.schoolType) || { n: 0, inst: new Set() }; s.n++; s.inst.add(x.institution); st.set(x.schoolType, s); });
    const sl = [...st.entries()].filter(([k]) => k !== "기타기관" && k !== "미분류").sort((a, b) => SCHOOL_TYPES.indexOf(a[0]) - SCHOOL_TYPES.indexOf(b[0]));
    $("#schoolCard").hidden = sl.length < 2;
    makeChart("chSchoolType", "bar", sl.map(([k, v]) => `${k} (${v.inst.size}곳)`), sl.map(([, v]) => Math.round(v.n / v.inst.size * 10) / 10),
      { unit: "건/기관", color: PALETTE[4], onClick: lab => { const v = lab.replace(/ \(.*$/, ""); store.set(STORE_SCOPE, v); applyScope(v); } });
  }

  // ---------- 사례목록 ----------
  function fillSelect(sel, values, allLabel) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>` + values.map(v => `<option>${esc(v)}</option>`).join("");
    if (values.includes(cur)) sel.value = cur;
  }
  function initFilters() {
    fillSelect($("#fCat"), group(state.cases, x => x.category).map(x => x[0]), "전체 유형");
    fillSelect($("#fType"), group(state.cases, x => x.auditType).map(x => x[0]), "전체 감사");
    fillSelect($("#fAction"), group(state.cases, actionsOf).map(x => x[0]), "전체 처분");
  }
  function applyFilter() {
    const t = $("#fText").value.trim().toLowerCase();
    const terms = t.split(/\s+/).filter(Boolean);
    const cat = $("#fCat").value, ty = $("#fType").value, ac = $("#fAction").value, money = $("#fMoney").checked;
    state.filtered = state.cases.filter(c => {
      if (cat && c.category !== cat) return false;
      if (ty && c.auditType !== ty) return false;
      if (ac && !actionsOf(c).includes(ac)) return false;
      if (money && !(c.amount > 0)) return false;
      if (terms.length) {
        const hay = `${c.institution} ${c.org} ${c.issue} ${c.detail} ${c.law} ${c.category} ${c.action}`.toLowerCase();
        if (!terms.every(w => hay.includes(w))) return false;
      }
      return true;
    });
    state.page = 1;
    renderTable();
  }
  function sortRows(rows) {
    const k = state.sortKey, d = state.sortDir;
    return [...rows].sort((a, b) => {
      const x = a[k], y = b[k];
      if (typeof x === "number" || typeof y === "number") return ((+x || 0) - (+y || 0)) * d;
      return String(x).localeCompare(String(y), "ko") * d;
    });
  }
  function renderTable() {
    const rows = sortRows(state.filtered);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const slice = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    const sum = state.filtered.reduce((a, c) => a + c.amount, 0);
    $("#caseCount").textContent = `${state.filtered.length.toLocaleString("ko-KR")}건 · 금액 합계 ${fmtAmt(sum)}`;
    $("#caseBody").innerHTML = slice.length ? slice.map(c => `
      <tr data-id="${esc(c.id)}" tabindex="0">
        <td>${esc(c.institution)}</td>
        <td><span class="chip cat">${esc(c.category)}</span></td>
        <td>${esc(c.issue)}</td>
        <td>${actionsOf(c).map(a => `<span class="chip">${esc(a)}</span>`).join("")}</td>
        <td class="num">${fmtAmt(c.amount)}</td>
        <td class="num">${esc(c.year)}</td>
      </tr>`).join("") : `<tr><td colspan="6" class="empty">조건에 맞는 사례가 없습니다.</td></tr>`;
    $$(".data-table th").forEach(th => th.setAttribute("aria-sort", th.dataset.sort === state.sortKey ? (state.sortDir > 0 ? "ascending" : "descending") : "none"));
    renderPager(pages);
  }
  function renderPager(pages) {
    const p = state.page, el = $("#pager");
    if (pages <= 1) { el.innerHTML = ""; return; }
    const nums = new Set([1, pages, p - 2, p - 1, p, p + 1, p + 2].filter(n => n >= 1 && n <= pages));
    let html = `<button class="btn" data-page="${p - 1}" ${p === 1 ? "disabled" : ""} aria-label="이전">‹</button>`, last = 0;
    [...nums].sort((a, b) => a - b).forEach(n => {
      if (n - last > 1) html += `<span class="muted">…</span>`;
      html += `<button class="btn" data-page="${n}" ${n === p ? 'aria-current="page"' : ""}>${n}</button>`; last = n;
    });
    html += `<button class="btn" data-page="${p + 1}" ${p === pages ? "disabled" : ""} aria-label="다음">›</button>`;
    el.innerHTML = html;
  }

  function openCase(id) {
    const c = state.cases.find(x => x.id === id);
    if (!c) return;
    $("#caseDetail").innerHTML = `
      <h2>${esc(c.issue || "(지적내용 없음)")}</h2>
      <span class="chip cat">${esc(c.category)}</span> ${actionsOf(c).map(a => `<span class="chip">${esc(a)}</span>`).join("")}
      ${c.detail ? `<p class="detail-text">${esc(c.detail)}${c.detail.length >= 400 ? "…" : ""}</p>` : ""}
      <dl class="dl">
        <dt>기관</dt><dd>${esc(c.institution)} <span class="chip">${esc(c.schoolType)}</span></dd>
        ${c.org && c.org !== c.institution ? `<dt>소관기관</dt><dd>${esc(c.org)}</dd>` : ""}
        <dt>감사종류</dt><dd>${esc(c.auditType)}</dd>
        ${c.source ? `<dt>출처</dt><dd>${esc(c.source)}</dd>` : ""}
        <dt>연도</dt><dd>${esc(c.year || "-")}</dd>
        <dt>관련규정</dt><dd>${esc(c.law || "-")}</dd>
        <dt>금액</dt><dd>${fmtAmt(c.amount)}</dd>
        <dt>관련자</dt><dd>${c.persons}명</dd>
        <dt>담당 부서</dt><dd>${esc(deptsFor(c).map(d => d.name).join(", ") || "-")}</dd>
        ${c.url ? `<dt>원문</dt><dd><a href="${esc(c.url)}" target="_blank" rel="noopener">교육부 게시글 열기 ↗</a></dd>` : ""}
      </dl>`;
    const d = $("#caseDialog");
    if (!d.open) d.showModal();
  }

  // ---------- 기관별 ----------
  function instStats() {
    const m = new Map();
    state.cases.forEach(c => {
      const s = m.get(c.institution) || { name: c.institution, count: 0, amount: 0 };
      s.count++; s.amount += c.amount; m.set(c.institution, s);
    });
    return [...m.values()];
  }
  function renderInstList() {
    const q = $("#instSearch").value.trim();
    let list = instStats().filter(s => !q || s.name.includes(q));
    const k = state.instSort;
    list.sort((a, b) => k === "name" ? a.name.localeCompare(b.name, "ko") : b[k] - a[k]);
    const cur = $("#instDetail").dataset.inst;
    $("#instList").innerHTML = list.length ? list.map(s => `<li><button type="button" data-inst="${esc(s.name)}" class="${s.name === cur ? "active" : ""}"><span>${esc(s.name)}</span><span class="meta">${s.count}건 · ${fmtAmt(s.amount)}</span></button></li>`).join("") : `<li class="empty">검색 결과 없음</li>`;
  }
  function caseListHTML(list, limit = 50) {
    if (!list.length) return `<p class="empty">관련 사례가 없습니다.</p>`;
    return `<ul class="mini-list">${list.slice(0, limit).map(c => `<li data-id="${esc(c.id)}" tabindex="0"><div class="t">${esc(c.issue)}</div><div class="m">${esc(c.institution)} · ${esc(c.category)} · ${esc(c.action)} · ${fmtAmt(c.amount)}</div></li>`).join("")}</ul>` + (list.length > limit ? `<p class="muted small">외 ${list.length - limit}건</p>` : "");
  }
  function showInst(name) {
    const list = state.cases.filter(c => c.institution === name).sort((a, b) => b.amount - a.amount);
    const el = $("#instDetail");
    el.dataset.inst = name;
    const cats = group(list, x => x.category).map(([k, v]) => `<span class="chip">${esc(k)} ${v}</span>`).join("");
    el.innerHTML = `<h2>${esc(name)}</h2>
      <div class="stat-row"><span>사례 <strong>${list.length}건</strong></span><span>금액 <strong>${fmtAmt(list.reduce((a, c) => a + c.amount, 0))}</strong></span><span>관련자 <strong>${list.reduce((a, c) => a + c.persons, 0)}명</strong></span></div>
      <div>${cats}</div>${caseListHTML(list)}`;
    renderInstList();
  }

  // ---------- 준비가이드 ----------
  function renderGuide() {
    const q = $("#guideSearch").value.trim();
    const counts = Object.fromEntries(group(state.cases, x => x.category));
    const guide = window.KMCU_GUIDE.filter(g => !q || g.category.includes(q) || g.dept.includes(q) || g.checks.some(c => c.includes(q)) || g.docs.some(c => c.includes(q)));
    const riskLabel = { high: "위험 높음", mid: "위험 보통", low: "위험 낮음" };
    $("#guideList").innerHTML = guide.length ? guide.map(g => {
      const done = g.checks.filter((_, i) => state.checks[`${g.id}.${i}`]).length;
      return `<details class="card guide-item" data-gid="${g.id}" ${q ? "open" : ""}>
        <summary><span class="title">${esc(g.category)}</span><span class="risk ${g.risk}">${riskLabel[g.risk]}</span>
          <span class="g-count">사례 ${counts[g.category] || 0}건 · 점검 ${done}/${g.checks.length}</span></summary>
        <div class="guide-body">
          <div><h4>주요 점검사항</h4><ul class="checks">${g.checks.map((c, i) => `<li><label><input type="checkbox" data-check="${g.id}.${i}" ${state.checks[`${g.id}.${i}`] ? "checked" : ""}><span>${esc(c)}</span></label></li>`).join("")}</ul>
            <div class="must">⚠️ ${esc(g.must)}</div></div>
          <div><h4>담당</h4><p>${esc(g.dept)}</p><h4>준비 서류</h4><ul class="docs">${g.docs.map(d => `<li>${esc(d)}</li>`).join("")}</ul>
            <button class="btn ghost related-link" type="button" data-gocat="${esc(g.category)}">관련 사례 보기 →</button></div>
        </div></details>`;
    }).join("") : `<p class="empty">검색 결과가 없습니다.</p>`;
    updateGuideProgress();
  }
  function updateGuideProgress() {
    const total = window.KMCU_GUIDE.reduce((a, g) => a + g.checks.length, 0);
    const done = Object.values(state.checks).filter(Boolean).length;
    const pct = total ? Math.round(done / total * 100) : 0;
    $("#guideBar").style.width = pct + "%";
    $("#guidePct").textContent = `${pct}% (${done}/${total})`;
  }

  // ---------- 담당업무 ----------
  function deptMatches(d, c) {
    if (d.categories.includes(c.category)) return true;
    return d.keywords.some(k => c.issue.includes(k));
  }
  function deptsFor(c) { return state.depts.filter(d => deptMatches(d, c)); }
  function renderDepts() {
    $("#deptGrid").innerHTML = state.depts.map(d => {
      const n = state.cases.filter(c => deptMatches(d, c)).length;
      return `<button type="button" class="dept-card" data-dept="${d.id}"><span class="ic" aria-hidden="true">${d.icon}</span><span class="nm">${esc(d.name)}</span><span class="du">${esc(d.duties)}</span><span class="ct">관련 사례 ${n}건</span></button>`;
    }).join("");
  }
  function showDept(id) {
    const d = state.depts.find(x => x.id === id);
    if (!d) return;
    $$(".dept-card").forEach(b => b.classList.toggle("active", b.dataset.dept === id));
    const list = state.cases.filter(c => deptMatches(d, c)).sort((a, b) => b.amount - a.amount);
    const g = window.KMCU_GUIDE.filter(x => d.categories.includes(x.category));
    const el = $("#deptCases");
    el.hidden = false;
    el.innerHTML = `<h2>${d.icon} ${esc(d.name)} 관련 지적사례 ${list.length}건</h2>
      <p class="muted small">매핑 기준 — 유형: ${esc(d.categories.join(", ") || "없음")} / 키워드: ${esc(d.keywords.join(", "))}</p>
      ${g.length ? `<p>${g.map(x => `<button class="btn ghost" type="button" data-goguide="${x.id}">✅ ${esc(x.category)} 점검표</button>`).join(" ")}</p>` : ""}
      ${caseListHTML(list)}`;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- AI 도우미 ----------
  const chatCtx = { get cases() { return state.cases; }, categories: CATEGORIES, fmtAmt, vocab: null };
  const QUICK = ["업무추진비 지적사례", "수의계약 관련 사례", "연구비 감사 준비", "채용 심사위원 문제", "지적유형별 건수 통계", "부당집행금액이 가장 많은 분야"];
  function chatAppend(role, text, cases) {
    const div = document.createElement("div");
    div.className = role === "u" ? "msg-u" : "msg-b";
    div.textContent = text;
    if (cases && cases.length) {
      const box = document.createElement("div");
      box.className = "cases";
      cases.forEach(c => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "case-mini"; b.dataset.id = c.id;
        b.innerHTML = `<strong>${esc(c.issue)}</strong><br><span class="muted">${esc(c.institution)} · ${esc(c.action)} · ${fmtAmt(c.amount)}</span>`;
        box.appendChild(b);
      });
      div.appendChild(box);
    }
    $("#chatLog").appendChild(div);
    $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
  }
  function chatSend(q) {
    q = q.trim();
    if (!q) return;
    chatAppend("u", q);
    const r = window.KMCU_CHAT.respond(q, chatCtx);
    chatAppend("b", (state.scope ? `[${state.scope} 사례 기준]\n` : "") + r.text, r.cases);
  }

  // ---------- 데이터 관리 ----------
  function showMsg(t, kind) { const m = $("#importMsg"); m.textContent = t; m.className = "msg " + (kind || ""); }
  function updateBadge() {
    const isSample = !!state.meta.isSample;
    const b = $("#dataBadge");
    b.textContent = isSample ? "예시 데이터" : `${state.meta.name || "불러온 데이터"} · ${state.all.length.toLocaleString("ko-KR")}건`;
    b.classList.toggle("sample", isSample);
    const n = $("#sampleNotice");
    if (isSample) {
      n.innerHTML = `지금 보이는 자료는 <strong>기능 시연용 가상 예시 데이터</strong>입니다. 실제 감사결과는 <button class="linklike" type="button" data-open-data>데이터 관리</button>에서 불러오세요.`;
      n.hidden = false;
    } else if (state.meta.source) {
      n.innerHTML = `출처: <strong>${esc(state.meta.source)}</strong>${state.meta.reports ? ` ${state.meta.reports}건` : ""}${state.meta.collectedAt ? ` (수집 ${esc(state.meta.collectedAt)})` : ""}. 보고서(PDF·HWP)에서 자동 추출한 자료이므로 중요한 내용은 사례 상세의 원문 링크로 확인하세요.`;
      n.hidden = false;
    } else n.hidden = true;
    $("#dataInfo").textContent = `현재: ${state.meta.name || "불러온 데이터"} (${state.all.length}건)${state.meta.importedAt ? " · 불러온 시각 " + state.meta.importedAt : ""}`;
  }
  async function importFile(file) {
    try {
      const text = await file.text();
      let rows;
      if (/\.json$/i.test(file.name) || text.trim().startsWith("{") || text.trim().startsWith("[")) {
        const j = JSON.parse(text);
        rows = Array.isArray(j) ? j : (j.cases || []);
      } else rows = parseCSV(text);
      if (!rows.length) throw new Error("읽을 수 있는 행이 없습니다. 첫 줄에 열 이름이 있는지 확인하세요.");
      const base = $("#appendMode").checked && !state.meta.isSample ? state.all : [];
      const start = base.length;
      const incoming = rows.map((r, i) => normalize({ ...r, id: r.id || `U${String(start + i + 1).padStart(4, "0")}` }, start + i));
      const ids = new Set(base.map(c => c.id));
      incoming.forEach(c => { while (ids.has(c.id)) c.id += "_"; ids.add(c.id); });
      setData(base.concat(incoming), { name: file.name, isSample: false, importedAt: new Date().toLocaleString("ko-KR") }, true);
      showMsg(`${incoming.length}건을 불러왔습니다. (전체 ${state.all.length}건)`, "ok");
    } catch (e) {
      showMsg("불러오기 실패: " + e.message, "err");
    }
  }
  function exportJSON() {
    const blob = new Blob([JSON.stringify({ meta: state.meta, cases: state.all }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kmcu-audit-cases-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- 테마 ----------
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    renderCharts();
  }

  function renderAll() {
    updateBadge();
    renderKpis();
    renderCharts();
    initFilters();
    applyFilter();
    renderInstList();
    const cur = $("#instDetail").dataset.inst;
    if (cur && state.cases.some(c => c.institution === cur)) showInst(cur);
    else { delete $("#instDetail").dataset.inst; $("#instDetail").innerHTML = `<p class="empty">왼쪽에서 기관을 선택하세요.</p>`; }
    renderGuide();
    renderDepts();
    $("#deptCases").hidden = true;
  }

  // ---------- 이벤트 ----------
  function bind() {
    $$(".tab").forEach(t => {
      t.setAttribute("aria-label", t.textContent.replace(/\s+/g, " ").trim());
      t.addEventListener("click", () => showPage(t.dataset.page));
    });
    $(".tabs").addEventListener("keydown", e => {
      if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const tabs = $$(".tab"), i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const n = tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      n.focus(); showPage(n.dataset.page);
    });
    let tmr;
    $("#fText").addEventListener("input", () => { clearTimeout(tmr); tmr = setTimeout(applyFilter, 150); });
    ["#fCat", "#fType", "#fAction", "#fMoney"].forEach(s => $(s).addEventListener("change", applyFilter));
    $("#fReset").addEventListener("click", () => { $("#fText").value = ""; $("#fCat").value = ""; $("#fType").value = ""; $("#fAction").value = ""; $("#fMoney").checked = false; applyFilter(); });
    $$(".data-table th").forEach(th => th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = ["amount", "year"].includes(k) ? -1 : 1; }
      renderTable();
    }));
    $("#pager").addEventListener("click", e => { const b = e.target.closest("button[data-page]"); if (b && !b.disabled) { state.page = +b.dataset.page; renderTable(); $("#page-cases").scrollIntoView({ block: "start" }); } });

    // 사례 상세 열기 (표, 목록, 챗 공통)
    document.addEventListener("click", e => {
      const row = e.target.closest("[data-id]");
      if (row && !e.target.closest("dialog")) openCase(row.dataset.id);
      const gc = e.target.closest("[data-gocat]");
      if (gc) { $("#fReset").click(); $("#fCat").value = gc.dataset.gocat; applyFilter(); showPage("cases"); }
      const gg = e.target.closest("[data-goguide]");
      if (gg) { showPage("guide"); const d = $(`[data-gid="${gg.dataset.goguide}"]`); if (d) { d.open = true; d.scrollIntoView({ block: "start" }); } }
      if (e.target.closest("[data-open-data]")) $("#dataDialog").showModal();
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target.matches("tr[data-id], li[data-id]")) openCase(e.target.dataset.id);
    });

    $("#scopeBtns").addEventListener("click", e => {
      const b = e.target.closest("[data-scope]");
      if (!b) return;
      store.set(STORE_SCOPE, b.dataset.scope);
      applyScope(b.dataset.scope);
    });
    $("#instSearch").addEventListener("input", renderInstList);
    $("#instList").addEventListener("click", e => { const b = e.target.closest("[data-inst]"); if (b) showInst(b.dataset.inst); });
    $$(".seg-btn").forEach(b => b.addEventListener("click", () => {
      state.instSort = b.dataset.isort;
      $$(".seg-btn").forEach(x => x.classList.toggle("active", x === b));
      renderInstList();
    }));

    $("#guideSearch").addEventListener("input", renderGuide);
    $("#guideList").addEventListener("change", e => {
      const k = e.target.dataset.check;
      if (!k) return;
      state.checks[k] = e.target.checked;
      if (!e.target.checked) delete state.checks[k];
      store.set(STORE_CHECK, state.checks);
      const det = e.target.closest(".guide-item"), g = window.KMCU_GUIDE.find(x => x.id === det.dataset.gid);
      const done = g.checks.filter((_, i) => state.checks[`${g.id}.${i}`]).length;
      det.querySelector(".g-count").textContent = det.querySelector(".g-count").textContent.replace(/점검 \d+\//, `점검 ${done}/`);
      updateGuideProgress();
    });
    $("#guideClear").addEventListener("click", () => {
      if (!confirm("모든 점검표 체크를 해제할까요?")) return;
      state.checks = {}; store.set(STORE_CHECK, {}); renderGuide();
    });

    $("#deptGrid").addEventListener("click", e => { const b = e.target.closest("[data-dept]"); if (b) showDept(b.dataset.dept); });

    $("#chatQuick").innerHTML = QUICK.map(q => `<button class="btn ghost" type="button">${esc(q)}</button>`).join("");
    $("#chatQuick").addEventListener("click", e => { const b = e.target.closest("button"); if (b) chatSend(b.textContent); });
    $("#chatForm").addEventListener("submit", e => { e.preventDefault(); chatSend($("#chatInput").value); $("#chatInput").value = ""; });
    $("#chatInput").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#chatForm").requestSubmit(); } });
    $("#chatInput").addEventListener("input", e => { e.target.style.height = "auto"; e.target.style.height = Math.min(140, e.target.scrollHeight) + "px"; });
    chatAppend("b", "안녕하세요. 감사 지적사례 도우미입니다.\n'업무추진비 사례', '계약 감사 준비', '지적유형별 건수' 처럼 물어보세요.");

    $("#btnData").addEventListener("click", () => { showMsg(""); $("#dataDialog").showModal(); });
    $("#fileInput").addEventListener("change", e => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ""; });
    $("#btnExport").addEventListener("click", exportJSON);
    $("#btnReset").addEventListener("click", () => {
      if (!confirm("불러온 데이터를 지우고 기본 데이터로 되돌릴까요? (이 브라우저에 저장된 데이터가 삭제됩니다)")) return;
      store.del(STORE_DATA);
      setData(state.sample.cases, state.sample.meta, false);
      showMsg("기본 데이터로 되돌렸습니다.", "ok");
    });

    $("#btnTheme").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      const t = dark ? "light" : "dark";
      store.set(STORE_THEME, t); applyTheme(t);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (!document.documentElement.dataset.theme) renderCharts(); });

    // PWA 설치
    let deferred = null;
    window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; $("#btnInstall").hidden = false; });
    $("#btnInstall").addEventListener("click", async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $("#btnInstall").hidden = true; });
    window.addEventListener("appinstalled", () => { $("#btnInstall").hidden = true; });
  }

  async function init() {
    state.checks = store.get(STORE_CHECK) || {};
    state.scope = store.get(STORE_SCOPE) || "";
    const t = store.get(STORE_THEME);
    if (t) document.documentElement.dataset.theme = t;
    bind();
    try {
      await loadData();
    } catch (e) {
      document.querySelector("main").insertAdjacentHTML("afterbegin", `<div class="notice">데이터 파일을 읽지 못했습니다(${esc(e.message)}). 파일을 직접 열었다면 웹서버(예: <code>python -m http.server</code>)로 실행하세요.</div>`);
      return;
    }
    const h = location.hash.slice(1);
    if (h && document.getElementById("page-" + h)) showPage(h);
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("sw.js").catch(() => { /* 오프라인 기능만 비활성 */ });
    }
  }

  // 테스트용 노출
  window.KMCU_APP = { state, fmtAmt, parseCSV, normalize, deptMatches, applyFilter, showPage, applyScope };
  document.addEventListener("DOMContentLoaded", init);
})();
