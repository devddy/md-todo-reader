import SwiftUI
import WidgetKit

struct BriefEntry: TimelineEntry {
    let date: Date
    let brief: DayBrief
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> BriefEntry {
        BriefEntry(date: Date(), brief: .sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (BriefEntry) -> Void) {
        completion(BriefEntry(date: Date(), brief: context.isPreview ? .sample : BriefLoader.load()))
    }

    /// Re-reads the notes every 15 minutes, and right after midnight so the date rolls over.
    func getTimeline(in context: Context, completion: @escaping (Timeline<BriefEntry>) -> Void) {
        let now = Date()
        let entry = BriefEntry(date: now, brief: BriefLoader.load(now: now))
        let midnight = Calendar.current.startOfDay(for: now).addingTimeInterval(24 * 60 * 60 + 60)
        let next = min(now.addingTimeInterval(15 * 60), midnight)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

@main
struct MDTodoWidgetBundle: WidgetBundle {
    var body: some Widget {
        MDTodoWidget()
    }
}

struct MDTodoWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "MDTodoWidget", provider: Provider()) { entry in
            MDTodoWidgetView(brief: entry.brief)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("MD Todo")
        .description("Daily Brief 노트의 오늘 할 일과 내일 할 일")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
