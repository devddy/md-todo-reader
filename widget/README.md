# MD Todo 위젯 (macOS)

바탕화면/알림 센터용 WidgetKit 위젯. `~/be3/work/daily/YYYY-MM-DD.md` 를 직접 읽어서
오늘 노트의 `## 오늘 꼭` 과 `## 내일 할 것` 항목을 보여 줍니다. 본 앱(Tauri)이 꺼져 있어도 동작합니다.

- 작은 크기: 남은 오늘 할 일 수 + 앞의 3개
- 중간 크기: 오늘 | 내일 두 열
- 큰 크기: 오늘 할 일 9개, 내일 할 일 5개
- 오늘 노트가 아직 없으면(브리프 실행 전) 가장 최근 노트의 "내일 할 것"을 오늘 칸에 보여 줌
- 15분마다, 그리고 자정 직후에 다시 읽음. 바로 반영하려면 호스트 앱의 "위젯 새로고침"

## 설치

준비물: Xcode 15 이상, macOS 14 이상

```sh
brew install xcodegen
cd widget
xcodegen                     # MDTodoWidget.xcodeproj 생성
open MDTodoWidget.xcodeproj
```

1. Xcode > Settings > Accounts 에 Apple ID 추가 (무료 계정 가능)
2. 두 타깃(MDTodoWidgetHost, MDTodoWidgetExtension)의 Signing & Capabilities 에서 Team 선택
3. MDTodoWidgetHost 스킴으로 Run (⌘R) → 앱 창이 뜨면 성공
4. 바탕화면 우클릭 > 위젯 편집… > "MD Todo" 추가
5. 계속 쓰려면 Product > Archive 대신, 빌드된 `MD Todo Widget.app` 을 /Applications 로 복사해 두면 됩니다

## 폴더 경로 바꾸기

두 곳을 같이 고칩니다.
- `Shared/BriefLoader.swift` 의 `Config.dailyRelativePath`
- `project.yml` 의 `home-relative-path.read-only` 항목 (앞뒤 `/` 유지)

그다음 `xcodegen` 을 다시 실행합니다.

## 알려진 점

- 이 코드는 Linux 환경에서 작성해 아직 맥에서 빌드해 보지 않았습니다. 빌드 오류가 나면 메시지를 알려 주세요.
- 위젯은 샌드박스 안에서 돌기 때문에 위 폴더 하나만 읽기 전용으로 열어 두었습니다 (temporary-exception 권한, 개인 빌드용).
- 위젯에서 바로 체크하는 기능은 아직 없습니다.
