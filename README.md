# 비교 마스터 (Bigyo Master)

Beyond Compare를 넘어서는 것을 목표로 하는 파일·폴더 비교/병합 도구입니다. 데스크톱(Windows, macOS, Linux)과 웹에서 같은 엔진과 같은 화면으로 동작합니다.

## 지금 되는 것 (MVP 1: 텍스트 비교)

- 좌우 비교, 양쪽 줄 정렬(빈 줄 자리 표시), 줄 안 단어·글자 단위 강조
- 공백 무시(앞뒤 / 개수 / 전부), 대소문자 무시
- 이전·다음 차이 이동(Alt+↑/↓), 차이 블록 복사(Alt+→/←), 오른쪽 차이 지도
- 양쪽 편집과 즉시 재비교, 파일 열기·저장(Ctrl+O / Ctrl+S), 끌어다 놓기, 줄바꿈(LF/CRLF) 유지
- 수십만 줄도 빠르게 비교 (Rust 엔진, 히스토그램 diff)

## 구조

```
crates/diff-core      Rust 비교 엔진 (줄 diff, 줄 안 diff, 옵션)
crates/diff-wasm      diff-core를 브라우저용 WebAssembly로 노출
packages/engine       TS 타입과 엔진 연결 (웹 = WASM, 데스크톱 = Tauri 명령)
packages/ui           React + CodeMirror 6 비교 화면 (웹과 데스크톱 공용)
apps/web              웹 앱 (Vite, 서버 없이 브라우저에서 비교)
apps/desktop          데스크톱 앱 (Tauri 2)
```

UI는 `DiffEngine` 인터페이스만 사용하므로 화면 코드는 한 벌이고, 엔진도 Rust 한 벌입니다.

## 개발

필요한 것: Rust(stable), Node 22, pnpm 10, `rustup target add wasm32-unknown-unknown`, `cargo install wasm-bindgen-cli --version 0.2.129`.
데스크톱 빌드는 [Tauri 사전 준비](https://tauri.app/start/prerequisites/)도 필요합니다.

```sh
pnpm install
pnpm dev:web          # 웹 앱 (http://localhost:5173)
pnpm dev:desktop      # 데스크톱 앱
pnpm test             # JS 테스트 (먼저 pnpm build:wasm)
cargo test            # 엔진 테스트
pnpm build:web        # apps/web/dist
pnpm build:desktop    # 설치 파일 (target/release/bundle)
```

## 다음 단계

계획은 [docs/plan.md](docs/plan.md)에 있습니다. 다음은 MVP 2 폴더 비교, 그다음 3-way 병합입니다.
