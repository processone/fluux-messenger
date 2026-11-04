import SwiftUI
import WidgetKit

@main
struct FluuxWidgets: WidgetBundle {
    var body: some Widget { UnreadWidget() }
}

/// Lists the conversations with unread messages that the app last wrote into the shared folder.
/// It never connects to the server: it shows the list as the app, or a push, left it.
struct UnreadWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: UnreadList.widgetKind, provider: UnreadProvider()) { entry in
            UnreadWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("widget.name")
        .description("widget.description")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryInline])
    }
}

struct UnreadProvider: TimelineProvider {
    func placeholder(in context: Context) -> UnreadEntry { sample }

    func getSnapshot(in context: Context, completion: @escaping (UnreadEntry) -> Void) {
        completion(context.isPreview ? sample : current())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UnreadEntry>) -> Void) {
        // The app asks for a redraw whenever the list changes.
        completion(Timeline(entries: [current()], policy: .never))
    }

    private func current() -> UnreadEntry {
        let root = NotificationMirror.root
        return UnreadEntry(date: Date(), list: UnreadList.load(root: root), names: SharedNames.load(root: root))
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
