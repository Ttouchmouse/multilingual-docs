# DATA_MODEL: 화면 기반 다국어 텍스트 QA 맵

## 1. 개요

이 문서는 MVP 구현에 필요한 주요 데이터 구조를 정의한다.

이 도구의 핵심 관계는 다음과 같다.

`화면 이미지` → `화면 위 텍스트 영역` → `다국어 번역 항목 key`

즉, 화면 위 특정 좌표에 존재하는 텍스트 박스가 DB화된 번역 데이터의 특정 항목과 연결되는 구조다.

## 2. 주요 엔티티

## 2.1 TranslationSource

업로드된 번역 HTML 파일 정보를 저장한다.

| 필드명 | 타입 | 필수 | 설명 |
|---|---|---:|---|
| id | string | Y | 내부 ID |
| fileName | string | Y | 업로드한 HTML 파일명 |
| uploadedAt | datetime | Y | 업로드 일시 |
| parsedAt | datetime | N | 파싱 완료 일시 |
| totalCount | number | N | 파싱된 번역 항목 수 |
| status | enum | Y | uploaded, parsing, parsed, failed |
| errorMessage | string | N | 파싱 실패 시 오류 메시지 |

## 2.2 TranslationItem

HTML에서 파싱된 다국어 번역 항목이다.

| 필드명 | 타입 | 필수 | 설명 |
|---|---|---:|---|
| id | string | Y | 내부 고유 ID |
| sourceId | string | Y | TranslationSource ID |
| key | string | Y | HTML 내 key 또는 내부 생성 key |
| kr | string | N | 한국어 |
| en | string | N | 영어 |
| sc | string | N | 간체 |
| tc | string | N | 번체 |
| es | string | N | 스페인어 |
| it | string | N | 이탈리아어 |
| pt | string | N | 포르투갈어 |
| de | string | N | 독일어 |
| fr | string | N | 프랑스어 |
| jp | string | N | 일본어 |
| th | string | N | 태국어 |
| rawData | json | N | 원본 파싱 데이터 |
| createdAt | datetime | Y | 생성 일시 |
| updatedAt | datetime | Y | 수정 일시 |

### 언어 코드 기준

| 코드 | 언어 |
|---|---|
| kr | Korean |
| en | English |
| sc | Simplified Chinese |
| tc | Traditional Chinese |
| es | Spanish |
| it | Italian |
| pt | Portuguese |
| de | German |
| fr | French |
| jp | Japanese |
| th | Thai |

## 2.3 Screen

피그마에서 export한 주요 화면 이미지 단위다.

| 필드명 | 타입 | 필수 | 설명 |
|---|---|---:|---|
| id | string | Y | 내부 ID |
| name | string | Y | 화면명 |
| group | enum/string | Y | 화면 그룹 |
| platform | enum | Y | mobile_web, pc_web, app, common |
| baseLanguage | enum | Y | 기본값 kr |
| figmaUrl | string | N | 피그마 링크 |
| imageUrl | string | Y | 업로드된 화면 이미지 URL |
| imageWidth | number | Y | 원본 이미지 너비 |
| imageHeight | number | Y | 원본 이미지 높이 |
| memo | string | N | 화면 메모 |
| createdAt | datetime | Y | 생성 일시 |
| updatedAt | datetime | Y | 수정 일시 |

### 권장 화면 그룹

- payment
- subscription
- adult_verification
- cookie
- login
- signup
- viewer
- event
- mypage
- account
- common
- etc

## 2.4 TextRegion

화면 이미지 위에 사용자가 직접 지정한 텍스트 영역이다.

| 필드명 | 타입 | 필수 | 설명 |
|---|---|---:|---|
| id | string | Y | 내부 ID |
| screenId | string | Y | Screen ID |
| visibleText | string | Y | 화면에 보이는 텍스트 |
| x | number | Y | 원본 이미지 기준 x 좌표 |
| y | number | Y | 원본 이미지 기준 y 좌표 |
| width | number | Y | 영역 너비 |
| height | number | Y | 영역 높이 |
| translationItemId | string | N | 연결된 TranslationItem ID |
| status | enum | Y | 미연결, 연결 완료 등 |
| memo | string | N | 해당 텍스트 영역 메모 |
| createdAt | datetime | Y | 생성 일시 |
| updatedAt | datetime | Y | 수정 일시 |

### 좌표 저장 기준

좌표는 화면 뷰어의 현재 확대/축소 상태가 아니라, 원본 이미지 기준으로 저장한다.

예를 들어 원본 이미지가 390x844이고, 텍스트 박스가 원본 기준 x=24, y=680, width=342, height=48에 위치한다면 해당 값을 그대로 저장한다.

뷰어에서 이미지가 확대/축소될 경우 좌표는 렌더링 시 비율로 변환한다.

## 2.5 TextRegionStatus

텍스트 영역과 번역 항목 연결 상태다.

| 값 | 의미 |
|---|---|
| unlinked | 미연결 |
| linked | 연결 완료 |
| needs_check | 확인 필요 |
| missing_translation | 번역 누락 |
| needs_revision | 수정 필요 |

## 3. 주요 관계

### Screen → TextRegion
하나의 화면은 여러 개의 텍스트 영역을 가질 수 있다.

`Screen.id = TextRegion.screenId`

### TextRegion → TranslationItem
하나의 텍스트 영역은 하나의 번역 항목과 연결될 수 있다.

`TextRegion.translationItemId = TranslationItem.id`

MVP에서는 하나의 텍스트 영역이 여러 번역 항목과 연결되는 구조는 지원하지 않는다.

## 4. 검색 요구사항

### TranslationItem 검색
검색 대상 필드:

- key
- kr
- en
- sc
- tc
- es
- it
- pt
- de
- fr
- jp
- th

MVP에서는 부분 일치 검색을 기본으로 한다.

### Screen 검색
검색 대상 필드:

- name
- group
- platform
- memo

### TextRegion 검색
검색 대상 필드:

- visibleText
- memo
- status

## 5. 기본 리스트 표시 구조

화면 상세 페이지의 오른쪽 리스트는 TextRegion 기준으로 표시한다.

각 항목은 다음 정보를 포함한다.

- 화면 표시 문구
- 연결된 key
- 연결 상태
- 메모
- KR
- EN
- SC
- TC
- ES
- IT
- PT
- DE
- FR
- JP
- TH

TranslationItem이 연결되지 않은 경우 11개 언어 영역은 비어 있거나 “미연결” 상태로 표시한다.

## 6. 예시 데이터

### TranslationItem 예시

```json
{
  "id": "tr_001",
  "sourceId": "src_20260108",
  "key": "app_1234",
  "kr": "베이직 멤버십 시작하기",
  "en": "Start Basic Membership",
  "sc": "",
  "tc": "",
  "es": "Iniciar suscripción básica",
  "it": "",
  "pt": "",
  "de": "",
  "fr": "",
  "jp": "",
  "th": "",
  "createdAt": "2026-01-08T00:00:00.000Z",
  "updatedAt": "2026-01-08T00:00:00.000Z"
}
```

### Screen 예시

```json
{
  "id": "screen_payment_mobile_001",
  "name": "결제 페이지 - 모바일",
  "group": "payment",
  "platform": "mobile_web",
  "baseLanguage": "kr",
  "figmaUrl": "https://figma.com/...",
  "imageUrl": "/uploads/screens/payment_mobile.png",
  "imageWidth": 390,
  "imageHeight": 844,
  "memo": "KR 기준 결제 페이지",
  "createdAt": "2026-01-08T00:00:00.000Z",
  "updatedAt": "2026-01-08T00:00:00.000Z"
}
```

### TextRegion 예시

```json
{
  "id": "region_001",
  "screenId": "screen_payment_mobile_001",
  "visibleText": "베이직 멤버십 시작하기",
  "x": 24,
  "y": 680,
  "width": 342,
  "height": 48,
  "translationItemId": "tr_001",
  "status": "linked",
  "memo": "결제 페이지 하단 CTA. DE/FR 길이 확인 필요.",
  "createdAt": "2026-01-08T00:00:00.000Z",
  "updatedAt": "2026-01-08T00:00:00.000Z"
}
```

## 7. 구현 시 주의사항

1. 원본 이미지 좌표 기준으로 TextRegion을 저장해야 한다.
2. 화면 확대/축소 상태와 좌표 저장값을 분리해야 한다.
3. 동일 KR 문구가 여러 TranslationItem에 존재할 수 있으므로 자동 연결을 확정하면 안 된다.
4. 연결 확신이 낮은 항목은 needs_check 상태를 허용해야 한다.
5. 번역 HTML 재업로드 시 기존 TextRegion 연결이 깨질 수 있으므로 key 유지 여부를 확인해야 한다.
6. MVP에서는 사용처 정확성보다, 사용자가 검증한 연결 정보를 누적하는 것이 우선이다.
