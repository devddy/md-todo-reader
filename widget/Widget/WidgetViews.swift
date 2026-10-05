import SwiftUI
import WidgetKit

struct MDTodoWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let brief: DayBrief

    var body: some View {
        switch family {
        case .systemSmall:
            SmallView(brief: brief)
        case .systemMedium:
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 12) {
                    TodoColumn(title: "오늘", items: brief.today, limit: 5)
                    Divider()
                    TodoColumn(title: "내일", items: brief.tomorrow, limit: 5)
                }
                StatusLine(text: brief.status)
            }
        default:
            VStack(alignment: .leading, spacing: 12) {
                Text(brief.dateLabel).font(.headline)
                TodoColumn(title: "오늘 할 일", items: brief.today, limit: 9)
                TodoColumn(title: "내일 할 일", items: brief.tomorrow, limit: 5)
                Spacer(minLength: 0)
                StatusLine(text: brief.status)
            }
        }
    }
}

private struct SmallView: View {
    let brief: DayBrief

    var body: some View {
        let open = brief.today.filter { !$0.done }
        VStack(alignment: .leading, spacing: 4) {
            Text(brief.dateLabel).font(.caption).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(open.count)").font(.system(size: 30, weight: .bold, design: .rounded))
                Text("남은 할 일").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(open.prefix(3), id: \.self) { item in
                TodoRow(item: item)
            }
            Spacer(minLength: 0)
            StatusLine(text: brief.status)
        }
    }
}

private struct TodoColumn: View {
    let title: String
    let items: [TodoItem]
    let limit: Int

    var body: some View {
        let done = items.filter(\.done).count
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(title).font(.caption.weight(.semibold))
                Spacer()
                if !items.isEmpty {
                    Text("\(done)/\(items.count)").font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            if items.isEmpty {
                Text("없음").font(.caption).foregroundStyle(.tertiary)
            }
            // Open items first so the useful ones survive the cut.
            let ordered = items.filter { !$0.done } + items.filter(\.done)
            ForEach(ordered.prefix(limit), id: \.self) { item in
                TodoRow(item: item)
            }
            if items.count > limit {
                Text("+\(items.count - limit)개 더").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct TodoRow: View {
    let item: TodoItem

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: item.done ? "checkmark.circle.fill" : "circle")
                .font(.caption2)
                .foregroundStyle(item.done ? Color.accentColor : Color.secondary)
            if item.carried {
                Text("이월")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.orange)
            }
            Text(item.text)
                .font(.caption)
                .lineLimit(1)
                .strikethrough(item.done)
                .foregroundStyle(item.done ? Color.secondary : Color.primary)
        }
    }
}

private struct StatusLine: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

#Preview(as: .systemMedium) {
    MDTodoWidget()
} timeline: {
    BriefEntry(date: .now, brief: .sample)
}
