# SourceTree와 Git에서 외부 비교·병합 도구로 쓰기

비교 마스터는 명령줄로 받은 경로를 바로 엽니다.

```
bigyo-master <왼쪽> <오른쪽>                  # 비교
bigyo-master <왼쪽> <오른쪽> <기준> <결과>     # 3-way 병합 (v0.5.0부터)
```

- 두 경로가 파일이면 파일 비교(바이너리면 16진수 보기)로, 폴더이면 폴더 비교로 열립니다.
- 한쪽 경로가 없으면(추가되거나 삭제된 파일) 빈 파일과 비교합니다.
- 실행 파일 이름은 v0.4.0부터 `bigyo-master`입니다. 병합은 v0.5.0부터 됩니다.

## 실행 파일 위치

| 운영체제 | 기본 설치 위치 |
|---|---|
| Windows | `C:\Users\<사용자 이름>\AppData\Local\Bigyo Master\bigyo-master.exe` |
| macOS | `/Applications/Bigyo Master.app/Contents/MacOS/bigyo-master` |
| Linux (.deb) | `/usr/bin/bigyo-master` |

Windows에서 위치가 다르면 시작 메뉴의 **Bigyo Master**를 오른쪽 클릭 → **파일 위치 열기**로 찾을 수 있습니다.

## SourceTree 설정

1. SourceTree에서 **도구(Tools) → 옵션(Options) → 비교(Diff)** 탭을 엽니다.
2. **외부 비교 도구(External Diff Tool)**를 **사용자 정의(Custom)**로 고릅니다.
3. **비교 명령(Diff Command)**에 위의 실행 파일 경로를 넣습니다.
4. **인수(Arguments)**에 다음을 넣습니다.

   ```
   "$LOCAL" "$REMOTE"
   ```

5. **병합 도구(Merge Tool)**도 **사용자 정의(Custom)**로 고르고, **병합 명령(Merge Command)**에 같은 실행 파일 경로를 넣습니다.
6. 병합 쪽 **인수(Arguments)**에 다음을 넣습니다.

   ```
   "$LOCAL" "$REMOTE" "$BASE" "$MERGED"
   ```

7. **확인**을 누릅니다.

이제 파일 목록에서 파일을 오른쪽 클릭 → **외부 비교(External Diff)**를 고르거나 **Ctrl+D**를 누르면 비교 마스터가 열립니다.

충돌이 난 파일은 오른쪽 클릭 → **충돌 해결(Resolve Conflicts) → 외부 병합 도구 실행(Launch External Merge Tool)**을 고르면 병합 화면이 열립니다. 충돌을 모두 고른 뒤 **저장**하고 **닫기**를 누르면 SourceTree가 결과를 받아 갑니다. 저장하지 않고 닫으면 파일은 충돌 상태로 남습니다.

## git difftool 설정

```sh
git config --global difftool.bigyo.cmd '"C:/Users/<사용자 이름>/AppData/Local/Bigyo Master/bigyo-master.exe" "$LOCAL" "$REMOTE"'
git config --global diff.tool bigyo
git difftool          # 바뀐 파일마다 비교 마스터가 열립니다
git difftool --dir-diff   # 바뀐 파일 전체를 폴더 비교로 엽니다

git config --global mergetool.bigyo.cmd '"C:/Users/<사용자 이름>/AppData/Local/Bigyo Master/bigyo-master.exe" "$LOCAL" "$REMOTE" "$BASE" "$MERGED"'
git config --global mergetool.bigyo.trustExitCode false
git config --global merge.tool bigyo
git mergetool         # 충돌 난 파일마다 병합 화면이 열립니다
```
