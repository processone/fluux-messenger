import SwiftUI
import WidgetKit

@main
struct FluuxWidgets: WidgetBundle {
    var body: some Widget { UnreadWidget() }
}

/// Lists the conversations with unread messages that the app last wrote into the shared folder.
/// It never connects to the server: it shows the list as the app, or a push, left it.
struct UnreadWidget: Widget {
    private static var families: [WidgetFamily] {
        #if os(macOS)
        return [.systemSmall, .systemMedium, .systemLarge]
        #else
        return [.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryInline]
        #endif
    }
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: UnreadList.widgetKind, provider: UnreadProvider()) { entry in
            UnreadWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("widget.name")
        .description("widget.description")
        .supportedFamilies(Self.families)
    }
}

struct UnreadProvider: TimelineProvider {
    func placeholder(in context: Context) -> UnreadEntry { sample }

    func getSnapshot(in context: Context, completion: @escaping (UnreadEntry) -> Void) {
        completion(context.isPreview ? sample : current())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UnreadEntry>) -> Void) {
        // The app asks for a redraw whenever the list changes. Between changes the labels still move
        // on: an entry at each midnight turns a time into "Yesterday" and then a weekday.
        let (now, awaitingAccount) = shown()
        // A list whose account the names do not yet confirm is the app mid-sign-in: the two files are
        // written moments apart. Look again soon, so a signed-out entry is not kept for days.
        if awaitingAccount {
            completion(Timeline(entries: [now], policy: .after(now.date.addingTimeInterval(60))))
            return
        }
        var dates = UnreadList.midnights(after: now.date)
        #if os(macOS)
        if let stale = now.list?.staleDate, stale > now.date { dates.append(stale) }
        #endif
        let midnights = dates.sorted()
        let entries = [now] + midnights.map { UnreadEntry(date: $0, list: now.list, names: now.names, root: now.root) }
        #if os(macOS)
        completion(Timeline(entries: entries, policy: .atEnd))
        #else
        // iOS may refuse the app's redraw request, which would leave the counter frozen until the app opens.
        // Ask to be built again in about an hour, within the system's refresh budget.
        completion(Timeline(entries: entries, policy: .after(UnreadList.nextReread(after: now.date))))
        #endif
    }

    private func current() -> UnreadEntry { shown().0 }

    private func shown() -> (UnreadEntry, Bool) {
        let root = NotificationMirror.root
        let names = SharedNames.load(root: root)
        // The list belongs to the account the app is signed in with; a signed-out or switched app leaves none to show.
        let shown = UnreadList.shown(root: root, account: names.account)
        return (UnreadEntry(date: Date(), list: shown.list, names: names, root: root), shown.awaitingAccount)
    }

    /// Sample data for the gallery, not the user's conversations.
    private var sample: UnreadEntry {
        let now = Date().timeIntervalSince1970 * 1000
        let rows: [UnreadList.Row] = [
            .init(id: "alice@example.com", kind: "chat", name: "Alice Martin", unread: 2, mentions: 0, last: now),
            .init(id: "dev@conference.example.com", kind: "groupchat", name: "ejabberd-dev", unread: 14, mentions: 1, last: now - 600_000),
            .init(id: "bruno@example.com", kind: "chat", name: "Bruno Roux", unread: 1, mentions: 0, last: now - 2_400_000),
        ]
        return UnreadEntry(date: Date(), list: UnreadList(account: "me@example.com", total: rows.count, rows: rows, updated: now),
                           names: SharedNames())
    }
}
