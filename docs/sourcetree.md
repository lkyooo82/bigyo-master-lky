# SourceTree와 Git에서 외부 비교 도구로 쓰기

비교 마스터는 명령줄로 받은 두 경로를 바로 비교합니다.

```
bigyo-master <왼쪽> <오른쪽>
```

- 두 경로가 파일이면 파일 비교(바이너리면 16진수 보기)로, 폴더이면 폴더 비교로 열립니다.
- 한쪽 경로가 없으면(추가되거나 삭제된 파일) 빈 파일과 비교합니다.
- 실행 파일 이름은 v0.4.0부터 `bigyo-master`입니다.

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

5. **확인**을 누릅니다. 병합 도구(Merge Tool)는 3-way 병합이 생길 때까지 그대로 둡니다.

이제 파일 목록에서 파일을 오른쪽 클릭 → **외부 비교(External Diff)**를 고르거나 **Ctrl+D**를 누르면 비교 마스터가 열립니다.

## git difftool 설정

```sh
git config --global difftool.bigyo.cmd '"C:/Users/<사용자 이름>/AppData/Local/Bigyo Master/bigyo-master.exe" "$LOCAL" "$REMOTE"'
git config --global diff.tool bigyo
git difftool          # 바뀐 파일마다 비교 마스터가 열립니다
git difftool --dir-diff   # 바뀐 파일 전체를 폴더 비교로 엽니다
```
