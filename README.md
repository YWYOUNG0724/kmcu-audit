# KMCU 감사 대비 지적사례 현황판

계명문화대학교 자체 감사 대비용 웹앱(PWA)입니다. 서버·DB 없이 정적 파일만으로 동작합니다.

**사이트:** https://ywyoung0724.github.io/kmcu-audit/

## 실행
```bash
cd E:/Program/KMCU_AUDIT
python -m http.server 8765
```
브라우저에서 http://localhost:8765 을 엽니다. (index.html을 더블클릭해 직접 열면 데이터 파일을 읽지 못합니다.)

## 기본 데이터
`data/moe-cases.json` — 교육부 관할기관 감사정보 게시판의 2019년 이후 대학 감사결과 보고서 134건에서 추출한 지적사항 2,987건.
화면 위쪽 **학교 종류** 버튼(전체·전문대학·일반대학…)을 누르면 대시보드·사례목록·기관별·담당업무·AI 도우미가 모두 그 종류로 좁혀집니다. 선택은 브라우저에 기억됩니다.
수집·검증 과정은 [docs/04_실제데이터_정리보고서.md](docs/04_실제데이터_정리보고서.md), 갱신 방법은 `tools/` 참고.

## 다른 데이터 추가로 넣기
1. 상단 **데이터 관리** → **CSV 양식 받기**
2. 교육부 등 공개 감사결과를 양식에 맞춰 정리 (금액 단위: 천원). `학교종류` 열은 비워 두면 `data/school-types.json`과 교명으로 자동 분류합니다.
3. **CSV / JSON 불러오기** — 데이터는 사용자 브라우저에만 저장됩니다.
4. 여러 사람에게 같은 데이터를 배포하려면 정리한 JSON을 `data/sample-cases.json` 형식으로 저장해 교체하고 `meta.isSample`을 `false`로 바꾸세요.

## 수정 포인트
| 파일 | 내용 |
|---|---|
| `data/departments.json` | 부서 이름·업무·매핑 키워드 |
| `data/school-types.json` | 기관별 학교 종류(전문대학 명단 포함). `tools/05_school_types.py`로 다시 만듦 |
| `js/guide.js` | 분야별 점검표, 준비서류 |
| `js/chatbot.js` | 동의어 사전(SYNONYMS) |

## 배포
GitHub Pages(저장소 `YWYOUNG0724/kmcu-audit`, `main` 브랜치 루트)로 배포됩니다. `main`에 올리면 1~2분 뒤 사이트에 반영됩니다.
파일을 바꾼 뒤에는 `sw.js`의 `CACHE` 이름(버전)을 올려야 설치된 앱에도 반영됩니다. 학내 웹서버에 올릴 때도 폴더를 그대로 복사하면 됩니다(`raw/` 제외).

## 문서
- [docs/00_REA_분석결과.md](docs/00_REA_분석결과.md)
- [docs/01_PRD.md](docs/01_PRD.md)
- [docs/02_MVP.md](docs/02_MVP.md)
- [docs/03_검증보고서.md](docs/03_검증보고서.md)
- [docs/04_실제데이터_정리보고서.md](docs/04_실제데이터_정리보고서.md)

`data/sample-cases.json`은 기능 시연용 가상 예시이며, `moe-cases.json`이 없을 때만 사용됩니다.
배포 시 `raw/`(원본 보고서·추출 텍스트, 약 200MB)와 `tools/`는 올리지 않아도 됩니다.
