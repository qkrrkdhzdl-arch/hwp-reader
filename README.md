# HWP 뷰어 — 브라우저에서 여는 한글(HWP 5.0) 문서 / HWP Viewer

**HWP 5.0 바이너리 문서를 설치 없이, 업로드 없이, 브라우저에서 직접 파싱해 읽는 정적 웹 앱입니다.**
A static web app that opens Korean **HWP 5.0** binary documents directly in the browser — the OLE2/CFB container
and the HWP record streams are parsed in JavaScript, on the user's device. Nothing is uploaded; there is no server.

> Kiroween 2026 — *Resurrection* track. Built with Kiro (specs, steering and hooks live in `.kiro/`).

---

## 왜 필요한가 / Why

한국의 공공기관·학교·기업은 지금도 신청서·공고문·양식을 `.hwp`(HWP 5.0, 1996년 형식)로 요구합니다.
이 형식은 OLE2 복합 문서(CFB) 컨테이너에 자체 레코드 스트림을 담고 있어 **브라우저가 읽지 못합니다.**
사용자는 유료 뷰어를 설치하거나 PDF로 변환해야 하고, 변환하면 표·문단 구조가 사라집니다.
휴대폰에서는 첨부된 `.hwp`가 그냥 "열리지 않는 파일"이 됩니다.

이 앱은 **웹 표준만으로** 그 형식을 되살립니다: 파일은 기기 밖으로 나가지 않고, 설치도, 서버도 없습니다.

Korean public institutions, schools and companies still require `.hwp` (HWP 5.0) for applications and notices.
Browsers cannot read it: users install proprietary viewers or convert to PDF and lose the structure. On a phone,
an attached `.hwp` is simply an unopenable file. This project revives that format with web standards only —
the file never leaves the device.

## 사용법 / Usage

1. `index.html`을 브라우저에서 엽니다. GitHub Pages 주소 또는 로컬 파일(`file://`) 둘 다 동작합니다.
2. `.hwp` 파일을 끌어다 놓거나 "파일 선택"을 누릅니다.
3. 문서 트리·본문(문단/표)·구조 검사기(CFB 섹터, 스트림, 레코드)가 표시됩니다.
4. `JSON 내보내기` / `HTML 내보내기`로 구조화된 결과를 저장할 수 있습니다.

## 구현한 것 / What it actually parses

| 단계 | 내용 |
| --- | --- |
| CFB (OLE2) | 헤더·섹터 크기, FAT/DIFAT, mini-FAT과 mini 스트림, 디렉터리 엔트리(UTF-16LE 이름, 트리 링크), 스트림 읽기 |
| FileHeader | 32바이트 서명 `HWP Document File`, 버전(5.x), 플래그(압축·암호·배포용·DRM·스크립트) |
| 압축 | HWP는 스트림을 **raw DEFLATE**로 압축하며, 한 스트림에 여러 멤버가 이어 붙기도 합니다 → 멤버 단위로 풀어 합칩니다(순수 JS inflate, 소비 바이트 보고) |
| 레코드 | 4바이트 헤더(tagId 10bit / level 10bit / size 12bit, 확장 크기 지원), 실제 HWPTAG 값(0x10–0x60) |
| 본문 | `PARA_HEADER`→`PARA_TEXT`(UTF-16LE), 제어 문자(0x0D 문단, 0x0A 줄바꿈, 0x09 탭, 0x1F 묶음 빈칸, 블록 컨트롤의 12바이트 페이로드) |
| 표 | `CTRL_HEADER`("tbl ") → `TABLE`(행/열) → `LIST_HEADER`(셀, 행 우선) → 셀 문단 |
| 미리보기 | `PrvText` 스트림(한글이 만든 미리보기 텍스트) |

**정직한 실패 / Honest failure** — 이 앱은 "성공한 척"하지 않습니다. 다음 경우 명확한 코드와 한국어/영어 메시지를 보여줍니다:
`ERR_NOT_CFB`, `ERR_NOT_HWP`, `ERR_HWP_VERSION`, `ERR_ENCRYPTED`(암호 문서), `ERR_DISTRIBUTION`(배포용/DRM),
`ERR_DECOMPRESS_FAILED`, `ERR_RECORD_OVERRUN`, `ERR_NO_BODY`, `ERR_STREAM_NOT_FOUND`, `ERR_CFB_CORRUPT`.

## 하지 않는 것 / Not supported (의도적)

- 편집·저장 (읽기 전용)
- 픽셀 단위 조판 재현 (글꼴·여백·페이지 나눔은 재현하지 않고, 내용과 구조를 정직하게 보여줍니다)
- 문서 안의 이미지 디코딩 (참조만 표시)
- HWPX(OWPML), HWP 3.0 이하 — 다른 형식이므로 "다른 형식"이라고 알려줍니다

## 구조 / Layout

```
index.html            화면 뼈대 (드롭존·툴바·오류 배너·검사기)
styles/app.css        레이아웃/테마
src/cfb.js            CFB(OLE2) 컨테이너 파서, HwpError/ERR_* 코드
src/inflate.js        순수 JS raw-DEFLATE (stored/fixed/dynamic), 소비 바이트 보고
src/records.js        레코드 디코더, HWPTAG 상수, PARA_TEXT 해석
src/hwp.js            FileHeader, 스트림 압축 해제, 섹션/표 파서, buildDocument
src/render.js         문서 트리·본문·구조 검사기·내보내기
src/app.js            파이프라인 연결, 오류 표시, 큰 파일 확인
tests/                node:test 단위 테스트 + 픽스처(자체 생성 HWP)
.kiro/                Kiro 스펙/스티어링/훅
```

## 테스트 / Tests

```bash
node --test tests/       # Node 20+ (외부 의존성 없음)
```

- 65개 테스트: CFB 왕복/순환 FAT, inflate, FileHeader, 레코드 프레이밍, 문단 텍스트, 표, 오류 분류, 골든 문서
- `tests/fixtures/build-hwp.mjs`가 최소 HWP 5.0 파일을 **직접 생성**합니다(형식 문서 역할). 생성물 `sample.hwp`가 골든 테스트 입력입니다.

**실제 문서 검증**: 한국에서 실제로 배포된 HWP 5.0 문서 66개(공고문·신청서·이력서·동의서)에 대해
64개 파싱 성공, `PrvText`(한글이 만든 미리보기)와의 문자 일치도 평균 0.925였습니다.
실패 2건은 확장자만 `.hwp`인 HTML/ZIP 파일로, 앱은 이를 "HWP 5.0이 아님"으로 정확히 알립니다.

## Kiro 산출물 / Built with Kiro

`.kiro/specs/hwp-reader/` — requirements(요구사항) · design(설계) · tasks(작업 목록)
`.kiro/steering/` — product(제품 원칙) · tech(기술 표준) · structure(구조 규칙)
`.kiro/hooks/` — 저장 시 테스트 실행, 작업 목록 갱신 알림

## License

MIT — see [LICENSE](LICENSE).
