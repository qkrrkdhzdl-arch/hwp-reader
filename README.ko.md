# HWP 뷰어

[English (README.md)](./README.md)

**한글(HWP 5.0) 문서를 브라우저에서 바로 엽니다. 설치도, 업로드도 없습니다.**

HWP 5.0 바이너리 문서를 기기 안에서 직접 파싱하는 정적 웹 앱입니다. OLE2 복합 문서(CFB) 컨테이너와 HWP 레코드 스트림을 자바스크립트로 읽습니다. 파일은 기기 밖으로 나가지 않고, 서버도 없습니다.

앱: **https://qkrrkdhzdl-arch.github.io/hwp-reader/**

> Kiroween 2026, *Resurrection* 트랙. Kiro로 만들었습니다(스펙·스티어링·훅은 `.kiro/`에 있습니다).

---

## 왜 필요한가

한국의 공공기관·학교·기업은 지금도 신청서와 공고문을 `.hwp`(HWP 5.0, 1996년 형식)로 요구합니다. 이 형식은 OLE2 복합 문서 안에 자체 레코드 스트림을 담고 있어서 브라우저가 읽지 못합니다. 사용자는 유료 뷰어를 설치하거나 PDF로 변환해야 하고, 변환하면 표와 문단 구조가 사라집니다. 휴대폰에서는 첨부된 `.hwp`가 그냥 열리지 않는 파일이 됩니다.

이 앱은 웹 표준만으로 그 형식을 되살립니다.

## 사용법

1. 브라우저에서 `index.html`을 엽니다. GitHub Pages 주소와 로컬 파일(`file://`) 모두 동작합니다.
2. `.hwp` 파일을 화면에 끌어다 놓거나 "파일 선택"을 누릅니다.
3. 문서 트리, 본문(문단과 표), 구조 검사기(CFB 섹터·스트림·레코드)가 나타납니다.
4. "JSON 내보내기"와 "HTML 내보내기"로 파싱 결과를 저장합니다.

화면은 한국어와 영어를 지원합니다. 브라우저 언어로 열리고, 헤더의 KR/EN 전환으로 바꿀 수 있습니다.

## 실제로 파싱하는 것

| 단계 | 처리 내용 |
| --- | --- |
| CFB (OLE2) | 헤더와 섹터 크기, FAT/DIFAT, 미니 FAT과 미니 스트림, 디렉터리 엔트리(UTF-16LE 이름, 트리 링크), 스트림 읽기 |
| FileHeader | 32바이트 `HWP Document File` 서명, 버전(5.x), 플래그(압축·암호·배포용·DRM·스크립트) |
| 압축 | HWP는 스트림을 raw DEFLATE로 압축하고, 한 스트림에 여러 멤버가 이어 붙기도 합니다. 멤버 단위로 풀어 합칩니다(순수 JS inflate, 소비 바이트 보고) |
| 레코드 | 4바이트 헤더(tagId 10비트 / level 10비트 / size 12비트, 확장 크기 지원), 실제 HWPTAG 값(0x10–0x60) |
| 본문 | `PARA_HEADER` → `PARA_TEXT`(UTF-16LE), 제어 문자(0x0D 문단, 0x0A 줄바꿈, 0x09 탭, 0x1F 고정폭 빈칸, 블록 컨트롤의 12바이트 페이로드) |
| 표 | `CTRL_HEADER`("tbl ") → `TABLE`(행/열) → `LIST_HEADER`(셀, 행 우선) → 셀 문단 |
| 미리보기 | `PrvText` 스트림, 한글이 직접 만든 미리보기 텍스트 |

**정직한 실패.** 이 앱은 성공한 척하지 않습니다. 다음 경우에는 분명한 코드와 메시지를 보여 줍니다: `ERR_NOT_CFB`, `ERR_NOT_HWP`, `ERR_HWP_VERSION`, `ERR_ENCRYPTED`(암호 문서), `ERR_DISTRIBUTION`(배포용/DRM), `ERR_DECOMPRESS_FAILED`, `ERR_RECORD_OVERRUN`, `ERR_NO_BODY`, `ERR_STREAM_NOT_FOUND`, `ERR_CFB_CORRUPT`.

## 하지 않는 것

- 편집과 저장. 읽기 전용입니다.
- 픽셀 단위 조판 재현. 글꼴, 여백, 페이지 나눔은 재현하지 않고 내용과 구조를 보여 줍니다.
- 문서 안 이미지 디코딩. 참조로만 표시합니다.
- HWPX(OWPML), HWP 3.0 이하. 다른 형식이므로 그렇게 알려 줍니다.

## 구조

```
index.html            화면 뼈대(드롭존, 툴바, 오류 배너, 검사기)
styles/app.css        레이아웃과 테마
src/cfb.js            CFB(OLE2) 컨테이너 파서, HwpError / ERR_* 코드
src/inflate.js        순수 JS raw DEFLATE(고정·동적 허프만), 소비 바이트 보고
src/records.js        레코드 디코더, HWPTAG 상수, PARA_TEXT 해석
src/hwp.js            FileHeader, 스트림 압축 해제, 섹션·표 파서, buildDocument
src/render.js         문서 트리, 본문, 구조 검사기, 내보내기
src/i18n.js           한국어·영어 문구, 언어 감지, KR/EN 전환
src/app.js            파이프라인 연결, 오류 표시, 큰 파일 확인
tests/                node:test 단위 테스트와 픽스처(직접 생성한 HWP)
.kiro/                Kiro 스펙, 스티어링, 훅
```

## 테스트

```bash
node --test tests/*.test.js     # Node 20 이상, 외부 의존성 없음
```

- 65개 테스트: CFB 왕복과 순환 FAT, inflate, FileHeader, 레코드 프레이밍, 문단 텍스트, 표, 오류 분류, 골든 문서
- `tests/fixtures/build-hwp.mjs`가 최소 HWP 5.0 파일을 직접 생성합니다. 형식 문서 역할을 겸하고, 그 결과물 `sample.hwp`가 골든 테스트 입력입니다.

**실제 문서 검증.** 한국에서 실제로 배포된 HWP 5.0 문서 66개(공고문·신청서·이력서·동의서) 가운데 64개를 파싱했고, 각 파일의 `PrvText`(한글이 만든 미리보기)와 문자 일치도는 평균 0.925였습니다. 실패한 2건은 확장자만 `.hwp`인 HTML·ZIP 파일이었고, 앱은 이를 "HWP 5.0이 아님"으로 정확히 알렸습니다.

## Kiro로 만든 것

`.kiro/specs/hwp-reader/`에 요구사항, 설계, 작업 목록이 있습니다. `.kiro/steering/`에는 제품·기술·구조 원칙이, `.kiro/hooks/`에는 저장 시 테스트 실행과 작업 목록 알림이 있습니다.

## 라이선스

MIT. [LICENSE](LICENSE)를 보세요.
