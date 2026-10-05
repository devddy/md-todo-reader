import SwiftUI
import WidgetKit

/// macOS widgets ship inside an app. This one only explains how to add the widget.
@main
struct HostApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(alignment: .leading, spacing: 10) {
                Text("MD Todo 위젯").font(.title2.bold())
                Text("바탕화면을 우클릭하고 \"위젯 편집…\"에서 MD Todo를 추가하세요.")
                Text("읽는 폴더: ~/\(Config.dailyRelativePath)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Button("위젯 새로고침") {
                    WidgetCenter.shared.reloadAllTimelines()
                }
            }
            .padding(28)
            .frame(width: 420)
            .onAppear { WidgetCenter.shared.reloadAllTimelines() }
        }
        .windowResizability(.contentSize)
    }
}
