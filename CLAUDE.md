# 작업 규칙

## 문서 언어

- README와 모든 Markdown(.md) 문서는 **한국어**로 작성합니다. 새 문서를 만들 때도, 기존 문서를 고칠 때도 마찬가지입니다.
- 코드 식별자, 명령어, 파일 경로, 패키지 이름은 원래 표기 그대로 둡니다.

## 저장소 구조

- `crates/diff-core`: Rust 비교 엔진 (텍스트, 바이트)
- `crates/diff-wasm`: 웹용 WebAssembly 바인딩
- `packages/engine`, `packages/ui`: 엔진 연결과 공용 화면 (React + CodeMirror 6)
- `apps/web`, `apps/desktop`: 웹 앱(Vite)과 데스크톱 앱(Tauri 2)

엔진 기능은 `diff-core`에 넣고, `diff-wasm`과 Tauri 명령 양쪽으로 노출합니다. 화면은 `DiffEngine` 인터페이스만 사용합니다.

## 확인 명령

```sh
cargo test -p diff-core
cargo clippy -p diff-core -p diff-wasm --all-targets -- -D warnings
pnpm build:wasm && pnpm typecheck && pnpm test
```
