# DeckPet — 에이전트 CLI 프론트엔드 데스크톱 펫

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | **한국어** | [Español](README.es.md)

Windows 10/11 데스크톱 펫 앱. 사진을 올리면 캐릭터가 배경 제거 후 기어다니는 스프라이트로 다시 그려져 화면 위에 살아납니다——창틀을 기어다니고, 가장자리에 매달리고, 말풍선으로 대화합니다(음성 없이 텍스트만). 남부적으로는 실제 에이전트 백엔드(ACP를 통한 Kimi Code CLI, DeepSeek Harness, OpenAI 호환 API)와 연동되며, 파일 쓰기·명령 실행은 모두 독립된 권한 레이어가 통제합니다.

## 기능

- **사진 → 펫**: rembg 배경 제거 + AI 포즈 재생성(Volcengine Seedream i2i 또는 OpenAI 호환 이미지 API)으로 15종 액션 스프라이트 세트(기기, 오르기, 매달리기, 구르기, 휴식, 입모양 3종, 손짓, 점프, 좌절, 생각, 겁먹기, 넘어졌다 일어나기) 생성. 이미지 API가 없어도 기본 프리셋 스프라이트로 바로 동작합니다.
- **데스크톱 런타임**: 전체 화면 투명 항상 위 창. 빈 공간은 클릭 통과, 펫 몸은 드래그 가능(관성으로 던지기, 넘어졌다 일어남). Win32 실시간 창 열거——창 상단을 기고, 옆면을 오르고, 화면 맨 위에서 철봉처럼 매달립니다.
- **kimi web 스타일 채팅**: 클릭=지정 대사, 더블클릭=채팅 말풍선. 스트리밍 답변+입모양, 긴 답변은 요약으로 접고「전체 보기」리더 패널(Markdown+코드 하이라이트). DEV 토글로 도구 호출 과정 표시, 전체 과정은 로컬 웹 로그 페이지에 기록.
- **멀티 에이전트 4계층 구조**: 표현층(renderer) → 오케스트레이터(라우팅, 협업 모드: 분해→보고→종합) → 어댑터(플러그인 등록 driver: ACP / dsh / openai-http) → 권한 레이어(fs 쓰기/shell/네트워크 유일 관문).
- **권한**: 읽기 전용 / 매번 확인 / 자동 실행을 캐릭터별로. 디렉터리 화이트리스트, 명령 블랙리스트, 네트워크 스위치, 인트라넷 예외. 비밀키는 Windows DPAPI로 암호화되어 평문 저장 없음.
- **웹 콘솔**(`http://127.0.0.1:17890`): 사진 업로드, 키 설정, 외형 프롬프트 조정, 스프라이트 버전 저장·전환·삭제, 리마인더 관리.

## 빠른 시작(포터블 exe)

1. Releases에서 `DeckPet-<버전>-portable.exe`를 받아 실행합니다.
2. 첫 실행: 내장된 **나이롱(奶龙)** 펫이 바로 바탕화면에 나타나고(설정 불필요), 동시에 **설정 페이지**가 자동으로 열립니다:
   - 백엔드 추가——Kimi Code CLI가 있다면 `kimi acp`가 가장 간단(type: acp, command: kimi, args: acp). 또는 OpenAI 호환 엔드포인트+API 키.
   - (선택) 이미지 API 키를 입력하면 AI 포즈 스프라이트 활성화.
   - 사진 업로드 → 나이롱을 내 사진으로 만든 펫으로 교체.
3. 조작: **클릭**=대사, **더블클릭**=채팅, **드래그**=들어올리기(겁먹음), 화면 상단에서 놓기=철봉 매달리기, 우클릭=메뉴. 트레이 아이콘: 숨기기/보이기, 설정, 웹 콘솔, 종료.

요구 사항: Windows 10/11 x64. ACP 백엔드는 해당 에이전트 CLI 설치·로그인 필요. AI 스프라이트는 이미지 편집 API 키 필요(Volcengine Ark 권장, 물론 물약 500회).

## 개발

Node.js ≥ 20, Python ≥ 3.10(Python은 선택: rembg 배경 제거와 AI 소재 후처리용).

```bash
npm install
npm run build
npm start        # 펫 실행
npm test         # vitest: 권한/접기/감정/오케스트레이터
npm run pack     # electron-builder → release/ 포터블 exe
```

에이전트 코어 CLI 검증(GUI 없이):

```bash
npm run build:core
node dist/core/cli/index.js backends add --type acp --name Kimi --command kimi --args "acp"
node dist/core/cli/index.js chars add --id char-1 --name 버디 --line-a "안녕!"
node dist/core/cli/index.js chat --char char-1 "한 문장으로 자기소개해줘"
node dist/core/cli/index.js collab --chars char-1,char-2 --task "슬로건을 만들어줘"
```

## 아키텍처

```
src/renderer/   표현층(순수 DOM/TS, window.deckpet IPC만 사용)
src/main/       Electron 메인: 창/IPC/Win32/트레이/웹 콘솔
src/core/orchestrator/  라우팅, 세션, 멀티 에이전트 협업
src/core/adapters/      Driver 플러그인 레지스트리(acp / dsh / openai-http)
src/core/permission/    정책 엔진——위험 동작은 모두 authorize() 경유
pipeline/               소재 파이프라인(cutout.py / placeholder_gen.py /
                        frame_post.py / gen_frames.ts)
```

계층 간 계약은 `src/core/types.ts`, `src/core/ipc-contract.ts`, `src/core/sprite-contract.ts`에 집중. 새 백엔드 추가는 [docs/adapter-api.md](docs/adapter-api.md), 실행 상세는 [docs/run.md](docs/run.md), 패키징은 [docs/packaging.md](docs/packaging.md) 참고.

## 데이터 위치

- 설정 및 기록: `%USERPROFILE%/.deckpet/`(`DECKPET_HOME`으로 변경 가능)
- 비밀키: `%USERPROFILE%/.deckpet/keys/`(DPAPI 암호화)
- 스프라이트: 패키지판 `%APPDATA%/deckpet/assets/sprites/`, 개발 시 `assets/sprites/`

## 참고

- DeepSeek Harness는 developer preview로 완전한 보안 감사를 거치지 않았습니다. 승인 플러그인에만 의존하지 않고 DeckPet 권한 레이어가 항상 최종 판단을 합니다.
- AI 스프라이트 생성은 API 호출을 소모합니다(캐릭터당 전체 15회). 재생성 전 자동 아카이브되며 웹 콘솔에서 언제든 이전 버전으로 전환 가능합니다.

## 라이선스

MIT
