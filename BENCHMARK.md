# 유사 서비스 벤치마크 (기준일 2026-07-15)

> PRODUCT_SPEC.md v2.0의 시장 근거 자료. 3갈래(계정 발견형 / 인박스 클리너 / 삭제 대행형) + 국내 시장을 조사했다.
> 검증 안 된 항목은 (미확인)으로 표기.

## 한 줄 결론

**"이메일 근거로 계정을 발견하고 탈퇴를 안내한다"는 카테고리는 글로벌·국내 모두 사실상 비어 있다.** 선행자(Mine, Deseat.me, Jumbo)는 전부 죽거나 인수됐고, 유일한 생존 직접 경쟁자는 McAfee+ 번들 기능이며 한국 커버리지가 없다. 다만 죽은 이유가 수요 부재가 아니라 ① 소비자 구독 경제학 실패 ② 신뢰 역설(프라이버시 서비스가 메일 전체 접근을 요구)이라는 점이 핵심 교훈이다 — 우리 설계(클라이언트 처리, 일회성 패스 가설)는 정확히 이 두 사인(死因)을 피해 간다.

## 1. 계정 발견형 — 우리와 같은 축

| 서비스 | 상태(2026) | 메커니즘 | 교훈 |
|---|---|---|---|
| **Mine** (saymine.com, 이스라엘) | 2025-11 McAfee에 소비자 앱 매각, 종료 수순. 회사는 B2B(MineOS) 피벗 | `gmail.readonly` **서버 처리**, 메타데이터 in-memory 주장. 반자동 GDPR 삭제 메일을 **사용자 본인 메일함에서 발송**(대리인 아님) | 500만 사용자로도 단독 생존 실패. Trustpilot 1.6 — "reclaim이 결국 회사별 수동 폼으로 되돌아옴", 가격 다크패턴($1/월 표기, $12/년 선결제) |
| **McAfee Online Account Cleanup** | 활성. Mine 기술 흡수, **유일한 생존 직접 경쟁자** | 메일 스캔 → 계정 목록 + **위험도 점수** + 월간 재스캔. 기본 티어=탈퇴 안내(human-in-the-loop), Ultimate=삭제 요청 대행 | 미국 번들 중심, 한국 커버리지 미확인. 안내형/대행형을 유료 티어로 가른 구조는 참고 가치 |
| Deseat.me | 사망 추정 (DNS 무응답) | 원조 "Gmail 스캔 → 계정 목록 → 삭제 링크" (2016) | 카테고리 원형이지만 수익화 실패 |
| Jumbo Privacy | 2024-06 앱 스토어 철수 | 프라이버시 설정 일괄 정리 (메일 스캔 아님) | $17M 투자에도 유료 전환 ~2.5만 명에서 멈춤 |

출처: [Mine 매각 보도](https://www.calcalistech.com/ctechnews/article/r1hsfefzzg) · [McAfee Online Account Cleanup](https://www.mcafee.com/learn/online-account-cleanup/) · [Jumbo 종료](https://blog.jumboprivacy.com/jumbo_wind_down) · [Mine Trustpilot](https://www.trustpilot.com/review/saymine.com)

## 2. 인박스 클리너 — 인접 카테고리 (구독 메일 정리, 계정 발견 아님)

| 서비스 | 상태 | 모델 | 교훈 |
|---|---|---|---|
| **Unroll.Me** (NielsenIQ) | 활성(미국), 2018 EU 철수 | 무료 + **인박스 데이터 판매**(2017 Lyft 영수증→Uber 판매 스캔들, FTC 제재) | "무료 메일 스캔 = 데이터 장사" 낙인의 진원지. 우리의 "데이터 판매 없음" 포지셔닝이 필요한 이유 |
| **Leave Me Alone** (영국 2인) | 활성, 부트스트랩 생존 | `gmail.modify` 최소 스코프, **CASA 연간 감사를 보안 페이지에 명시**. $19 일회성 7일 패스 | **이 카테고리에서 유일하게 검증된 소비자 가격 모델 = 일회성 패스.** 투명성 페이지 패턴은 그대로 카피할 것 |
| **Clean Email** (미국) | 활성 | "메타데이터-only + 45일 보존 + 구독-only 수익" 3줄 신뢰 스토리. ~$29.99/년 | 신뢰 스토리를 짧게 못 박는 화법 참고. 단 자동갱신 환불 불가로 신뢰 훼손 중 |
| Cleanfox (NielsenIQ) | 활성 | Unroll.Me와 동일한 데이터 추출 모델 | — |

출처: [Unroll.Me-Uber](https://www.cbsnews.com/news/unroll-me-uber-privacy-touting-email-service-backlash/) · [LMA 보안 페이지](https://leavemealone.com/security/) · [Clean Email](https://clean.email/llm-info)

## 3. 삭제 대행형 — 데이터브로커 제거 (계정 발견 없음)

| 서비스 | 가격 | 핵심 사실 |
|---|---|---|
| **Permission Slip** (Consumer Reports → **2026 DeleteMe 인수**) | 무료 / Plus $4.99/월 | CCPA 법적 대리인 모델. CR 자체 실험: 요청 1,666건 중 47%만 순조, **19% 무응답, 19%는 본인에게 되돌림** — 그 19%가 정확히 우리의 안내형 레인 |
| DeleteMe (Abine) | $129/년 | 브로커 750+ 수동 옵트아웃. CR 연구 중위권. 아시아는 싱가포르뿐 |
| **Incogni** (Surfshark) | $7.99/월 | 35개국. **한국 명시적 미지원 — 대리인 법제 부재가 이유.** 대행 모델 자체가 한국에 이식 불가라는 증거 |
| Mozilla Monitor Plus | **2025-12 종료** | 화이트라벨 벤더(Onerep) 스캔들 → 신뢰 브랜드도 대행 모델을 포기 |
| Optery | 무료 리포트+유료 | CR 연구 1위(68% 제거). **스크린샷 증거 리포트**가 차별점 |
| **JustDeleteMe** (jdm-contrib) | 무료, **MIT** | 커뮤니티 유지. `sites.json` 단일 파일: difficulty(easy~impossible)/삭제 URL/이메일 템플릿/domains 배열 → **우리 카탈로그 시드로 즉시 사용 가능**, 단 한국 서비스 커버리지 거의 없음 |

**핵심 실증**: CR/Tall Poppy 연구 — 대행 서비스는 4개월에 기록의 ~35% 제거 vs **본인이 직접 하면 1주일에 ~70%**. human-in-the-loop 설계의 외부 근거.
출처: [CR 연구](https://advocacy.consumerreports.org/press_release/consumer-reports-evaluation-of-people-search-site-removal-services-finds-that-they-are-largely-ineffective/) · [Incogni 지원 국가](https://support.incogni.com/hc/en-us/articles/5285682832402) · [jdm sites.json](https://raw.githubusercontent.com/jdm-contrib/jdm/master/_data/sites.json)

## 4. 국내 시장

| 도구 | 발견 범위 | 사각지대 (= 우리 기회) |
|---|---|---|
| **정보주체 권리행사** (구 e프라이버시 클린서비스, PIPC/KISA, 무료) | **본인확인 이력 기반**, 탈퇴 대행(KISA 위임 relay) 포함. **조회 창은 인증수단별로 다름 — 휴대폰 1년 / 신용카드 2년 / 주민번호·아이핀 5년** (흔히 인용되는 "일괄 5년"은 오류) | 이메일 가입 사이트·해외 서비스(구글/메타/SaaS)·조회창 밖 계정 전부 안 보임. 대행 처리 1주~1개월, "처리 불가" 반환 존재. 사용 최근성 정보 없음. 개인 조회 API 없음(data.go.kr 데이터셋은 연간 집계 통계뿐) |
| 털린 내 정보 찾기 | 유출 여부 플래그만 (5회/일) | 사이트명도 계정 목록도 없음 |
| Msafer/PASS (KAIT) | 통신 가입·본인확인 이력(PASS는 1년) | 웹/앱 계정은 원천 제외 |
| 네아로·카카오 연결관리 | OAuth 연결 앱만 (카카오는 연결일 표시) | 이메일/비번 가입 안 보임. **카카오 공식 경고: 연결 끊기 ≠ 회원탈퇴** |
| 왓섭·토스·뱅크샐러드 | 유료 정기결제만 (결제 레일 기반) | 무료 계정(대다수) 안 보임 |
| 디지털 장의사 업체들 | 발견 기능 없음, 게시물 삭제 대행 | 건당 ₩4만~30만, 무규제·악용 사례 보도 |

**이메일 스캔으로 계정을 발견하는 국내 스타트업: 발견되지 않음** (검색 커버리지 한계 내에서). Gmail 커뮤니티에 "가입한 사이트 찾는 법" 질문이 미해결로 굴러다니는 것이 수요의 방증.

> **후속 검증(2026-07-15)에서 정정된 사실 3건** — ① e프라이버시 클린서비스는 **「정보주체 권리행사」로 개명**되어 privacy.go.kr에서 운영된다(진입점을 eprivacy.go.kr로 하드코딩하지 말 것). ② 조회 창이 "5년"이 아니라 인증수단별이며, 가장 흔한 **휴대폰 본인확인은 1년**뿐이다 — 이 레일의 발견 가치는 알려진 것보다 훨씬 작다. ③ **네이버·카카오 모두 메일 읽기 OAuth API가 존재하지 않는다**(네이버 OpenAPI 카탈로그에 "메일" 0건). 국내 메일 지원은 IMAP뿐이고, 이는 앱 비밀번호를 보관하는 백엔드를 요구한다.

출처: [e프라이버시](https://www.eprivacy.go.kr/) · [털린 내 정보 찾기](https://kidc.eprivacy.go.kr/) · [Msafer](https://www.msafer.or.kr/protection_use/guide.do) · [카카오 연결관리 FAQ](https://devtalk.kakao.com/t/about-manage-connected-services/79279)

## 5. DFM에 주는 시사점

1. **포지셔닝 = 경쟁이 아니라 라우팅 레이어.** 본인확인 레일 사이트는 e프라이버시로 딥링크(`public_service` 경로 — 이미 스펙에 있음), 소셜 로그인 계정은 구글/카카오/네이버 연결관리 페이지로 안내, **이메일 가입 + 해외 서비스 + 5년 초과**가 어떤 국내외 도구도 못 보는 우리 독점 영역. 근거 컨텍스트(가입 시점·최근 흔적)를 보여주는 도구는 국내외에 하나도 없다.
2. **신뢰 아키텍처가 전장.** 생존자 전원이 스코프 최소화 + CASA 감사 배지로 싸운다. 우리의 **클라이언트-사이드 처리는 그 누구도 못 하는 주장**(전부 서버 처리) — Leave Me Alone식 투명성 페이지(스코프별 이유 + 감사 명시)를 출시 자산으로 만들 것.
3. **가격 모델 실증**: 무료 = 데이터 판매(Unroll.Me/Cleanfox), 소비자 구독 = 사망/매각(Mine, Jumbo). 유일하게 검증된 모델은 **일회성 패스**(LMA $19/7일) — 우리 ₩9,900 30일 Cleanup Pass 가설과 정확히 일치.
4. **대행의 한계 실증** (CR 4개월 35% vs 수동 1주 70%, Incogni의 한국 법제 포기, Mozilla 벤더 스캔들) → human-in-the-loop는 타협이 아니라 우월 전략.
5. **카피할 기능**: McAfee의 계정별 위험 점수 + 월간 재스캔(우리 cleanup score/재스캔과 동형 — 방향 검증됨) · Mine의 "사용자 본인 메일함에서 발송하는 정형 삭제 메일"(우리 `email_request` mailto 초안과 동일 패턴) · Optery의 증거 리포트 · JustDeleteMe JSON을 글로벌 서비스 시드로.
6. **검토 제안**: 소셜 로그인 계정은 메일 흔적이 없으므로(스펙 §3 커버리지 한계), 구글/카카오/네이버 "연결된 서비스" 페이지 확인 가이드를 Should로 복귀시킬 가치가 있음 — 링크 + 안내문뿐이라 구현 비용이 거의 없다.
