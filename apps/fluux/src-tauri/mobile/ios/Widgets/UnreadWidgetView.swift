import SwiftUI
import WidgetKit
#if canImport(UIKit)
import UIKit
#endif

struct UnreadEntry: TimelineEntry {
    let date: Date
    /// Nil until the app has signed in and written a list.
    let list: UnreadList?
    let names: SharedNames
}

struct UnreadWidgetView: View {
    let entry: UnreadEntry
    @Environment(\.widgetFamily) private var family

    /// The scheme the app registers; a row opens its conversation through it.
    private var scheme: String? { Bundle.main.object(forInfoDictionaryKey: "FluuxAppScheme") as? String }

    private var rowLimit: Int {
        switch family {
        case .systemLarge: return 6
        case .systemMedium: return 3
        default: return 2
        }
    }

    /// Opens the conversation list: a tap anywhere but on a row, and the whole of the small and
    /// lock-screen sizes. The app reads a link without a conversation as that request.
    private var listURL: URL? { scheme.flatMap { URL(string: "\($0)://shortcut") } }

    var body: some View {
        content.widgetURL(listURL)
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryCircular: circular
        case .accessoryInline: inline
        default: home
        }
    }

    private var total: Int { entry.list?.total ?? 0 }

    // MARK: Lock screen: the unread total only

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "bubble.left.fill").font(.caption2)
                Text(entry.list == nil ? "–" : "\(total)").font(.title3.bold()).minimumScaleFactor(0.6)
            }
        }
        .widgetAccentable()
    }

    private var inline: some View {
        Text(entry.list == nil ? LocalizedStringKey("widget.signin") : Self.unreadText(total))
    }

    // MARK: Home screen

    @ViewBuilder private var home: some View {
        if let list = entry.list {
            if list.rows.isEmpty && list.total == 0 {
                message("widget.empty")
            } else if family == .systemSmall {
                small(list)
            } else {
                rows(list)
            }
        } else {
            message("widget.signin")
        }
    }

    private func message(_ key: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Fluux").font(.caption.bold()).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text(key).font(.headline)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func small(_ list: UnreadList) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Fluux").font(.caption.bold()).foregroundStyle(.secondary)
            Text("\(list.total)").font(.system(size: 40, weight: .bold, design: .rounded))
            Text(Self.unreadLabel(list.total)).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 4)
            ForEach(list.rows.prefix(rowLimit)) { row in
                HStack(spacing: 2) {
                    Text(row.name).font(.caption).lineLimit(1)
                    if row.mentions > 0 { Text("@").font(.caption.bold()).foregroundStyle(.tint) }
                }
            }
            .privacySensitive()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rows(_ list: UnreadList) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Self.unreadText(list.total)).font(.caption.bold()).foregroundStyle(.secondary)
            ForEach(list.rows.prefix(rowLimit)) { row in
                link(row, list: list)
            }
            .privacySensitive()
            Spacer(minLength: 0)
            let hidden = list.total - min(list.rows.count, rowLimit)
            if hidden > 0 && !list.rows.isEmpty {
                Text("+\(hidden)").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func link(_ row: UnreadList.Row, list: UnreadList) -> some View {
        if let url = url(for: row, account: list.account) {
            Link(destination: url) { UnreadRowView(row: row, image: avatar(row), now: entry.date) }
        } else {
            UnreadRowView(row: row, image: avatar(row), now: entry.date)
        }
    }

    private func url(for row: UnreadList.Row, account: String) -> URL? {
        guard let scheme = scheme else { return nil }
        return ShortcutConversation(id: row.id, name: row.name, kind: row.kind, account: account).url(scheme: scheme)
    }

    private func avatar(_ row: UnreadList.Row) -> Image? {
        #if canImport(UIKit)
        guard let url = NotificationMirror.imageURL(for: row.id, names: entry.names),
              let image = UIImage(contentsOfFile: url.path) else { return nil }
        return Image(uiImage: image)
        #else
        return nil
        #endif
    }

    // MARK: Wording

    static func unreadLabel(_ count: Int) -> LocalizedStringKey {
        count == 1 ? "widget.unread.one" : "widget.unread.other"
    }

    /// "6 unread" or "1 unread", in the reader's language.
    static func unreadText(_ count: Int) -> LocalizedStringKey {
        count == 1 ? "widget.count.one \(count)" : "widget.count.other \(count)"
    }
}

struct UnreadRowView: View {
    let row: UnreadList.Row
    let image: Image?
    /// The entry's time, so the labels are right at each midnight without a redraw.
    let now: Date

    var body: some View {
        HStack(spacing: 8) {
            avatar.frame(width: 28, height: 28).clipShape(Circle())
            HStack(spacing: 3) {
                Text(row.name).font(.subheadline).lineLimit(1)
                if row.mentions > 0 { Text("@").font(.subheadline.bold()).foregroundStyle(.tint) }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 1) {
                Text("\(row.unread)").font(.caption.bold())
                if let date = row.date {
                    Text(Self.when(date, now: now)).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder private var avatar: some View {
        if let image = image {
            image.resizable().scaledToFill()
        } else {
            ZStack {
                Circle().fill(.tint.opacity(0.25))
                Text(row.kind == "groupchat" ? "#" : Self.initials(row.name)).font(.caption.bold())
            }
        }
    }

    static func initials(_ name: String) -> String {
        let letters = name.split(separator: " ").prefix(2).compactMap { $0.first }
        return String(letters).uppercased()
    }

    /// The time today, "Yesterday", the weekday within a week, then the date.
    static func when(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = .current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        switch days {
        case ..<1:
            formatter.timeStyle = .short
            formatter.dateStyle = .none
        case 1:
            formatter.timeStyle = .none
            formatter.dateStyle = .medium
            formatter.doesRelativeDateFormatting = true
        case 2..<7:
            formatter.setLocalizedDateFormatFromTemplate("EEE")
        default:
            formatter.timeStyle = .none
            formatter.dateStyle = .short
        }
        return formatter.string(from: date)
    }
}
