import Foundation

enum Config {
    /// Folder holding the `YYYY-MM-DD.md` notes, relative to the home folder.
    /// Must match the read-only path in Widget/Widget.entitlements.
    static let dailyRelativePath = "be3/work/daily"
}

struct TodoItem: Hashable {
    let text: String
    let done: Bool
    let carried: Bool
}

struct DayBrief {
    var dateLabel: String
    var today: [TodoItem]
    var tomorrow: [TodoItem]
    /// Short status shown under the lists, e.g. when today's note is missing.
    var status: String?

    static let sample = DayBrief(
        dateLabel: "10/5 (월)",
        today: [
            TodoItem(text: "위클리 자료 준비", done: false, carried: true),
            TodoItem(text: "기한 지난 BE3 티켓 상태 정리", done: false, carried: false),
            TodoItem(text: "STG 오류 알림 확인", done: true, carried: false),
        ],
        tomorrow: [TodoItem(text: "리뷰어 리마인드", done: false, carried: false)],
        status: nil
    )
}

/// Reads the Daily Brief notes directly, so the widget works without the main app running.
enum BriefLoader {
    /// The sandbox redirects `homeDirectoryForCurrentUser` into the container; ask for the real one.
    static func realHome() -> URL {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: dir), isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    static var dailyDir: URL {
        realHome().appendingPathComponent(Config.dailyRelativePath, isDirectory: true)
    }

    static func fileName(for date: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date) + ".md"
    }

    static func label(for date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ko_KR")
        f.dateFormat = "M/d (E)"
        return f.string(from: date)
    }

    static func read(_ date: Date, in dir: URL) -> String? {
        try? String(contentsOf: dir.appendingPathComponent(fileName(for: date)), encoding: .utf8)
    }

    static func load(now: Date = Date(), dir: URL = dailyDir) -> DayBrief {
        if let text = read(now, in: dir) {
            return DayBrief(
                dateLabel: label(for: now),
                today: items(in: text, where: isTodaySection),
                tomorrow: items(in: text, where: isTomorrowSection),
                status: nil
            )
        }
        // Brief hasn't run yet today: show the latest note's "내일 할 것" as today's plan.
        for back in 1...7 {
            guard let day = Calendar.current.date(byAdding: .day, value: -back, to: now),
                  let text = read(day, in: dir) else { continue }
            let planned = items(in: text, where: isTomorrowSection)
                .map { TodoItem(text: $0.text, done: $0.done, carried: true) }
            return DayBrief(dateLabel: label(for: now), today: planned, tomorrow: [],
                            status: "브리프 전 · \(label(for: day))에 적은 계획")
        }
        let readable = FileManager.default.isReadableFile(atPath: dir.path)
        return DayBrief(dateLabel: label(for: now), today: [], tomorrow: [],
                        status: readable ? "오늘 노트 없음" : "~/\(Config.dailyRelativePath) 를 읽을 수 없음")
    }

    // MARK: - Parsing (mirrors src/lib/notes.ts)

    static func isTomorrowSection(_ heading: String) -> Bool {
        heading.contains("내일") || heading.lowercased().contains("tomorrow")
    }

    static func isTodaySection(_ heading: String) -> Bool {
        let h = heading.lowercased()
        let todoish = ["오늘 꼭", "할 일", "할일", "할 것", "todo", "to-do", "task"].contains { h.contains($0) }
        return todoish && !isTomorrowSection(heading)
    }

    /// Top-level bullets under the `##` sections that match.
    static func items(in text: String, where matches: (String) -> Bool) -> [TodoItem] {
        var section = ""
        var inCode = false
        var out: [TodoItem] = []
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                inCode.toggle()
                continue
            }
            if inCode { continue }
            if line.hasPrefix("## ") {
                section = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("# ") {
                section = ""
            } else if matches(section), let item = parseItem(line) {
                out.append(item)
            }
        }
        return out
    }

    private static let linkRE = try! NSRegularExpression(
        pattern: #"\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))+\)"#)
    private static let trailingLinksRE = try! NSRegularExpression(
        pattern: #"\s+—\s+(?:\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\)(?:,\s*)?)+$"#)

    static func parseItem(_ line: String) -> TodoItem? {
        guard let first = line.first, "-*+".contains(first), line.dropFirst().first == " " else { return nil }
        var body = String(line.dropFirst(2))
        var done = false
        var carried = false

        func takeCheckbox() {
            for (mark, isDone) in [("[ ] ", false), ("[x] ", true), ("[X] ", true)] where body.hasPrefix(mark) {
                done = isDone
                body = String(body.dropFirst(mark.count))
            }
        }
        takeCheckbox()
        if body.hasPrefix("(이월)") {
            carried = true
            body = body.dropFirst("(이월)".count).trimmingCharacters(in: .whitespaces)
            takeCheckbox()
        }

        let whole = { NSRange(body.startIndex..., in: body) }
        body = trailingLinksRE.stringByReplacingMatches(in: body, range: whole(), withTemplate: "")
        body = linkRE.stringByReplacingMatches(in: body, range: whole(), withTemplate: "$1")
        body = body.replacingOccurrences(of: "**", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespaces)
        return body.isEmpty ? nil : TodoItem(text: body, done: done, carried: carried)
    }
}
