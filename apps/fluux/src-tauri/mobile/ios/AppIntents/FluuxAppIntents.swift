import AppIntents
import UIKit

@available(iOS 16.0, *)
struct FluuxConversationEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Conversation or room"
    static var defaultQuery = FluuxConversationQuery()

    let entry: ShortcutConversation
    var id: String { entry.destination.identifier! }
    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(entry.name)", subtitle: "\(entry.account)")
    }
}

@available(iOS 16.0, *)
struct FluuxConversationQuery: EntityStringQuery {
    private func entries() -> [FluuxConversationEntity] {
        ShortcutConversation.available(in: SharedNames.load()).map { FluuxConversationEntity(entry: $0) }
    }

    func entities(for identifiers: [String]) async throws -> [FluuxConversationEntity] {
        ShortcutConversation.resolve(identifiers: identifiers, in: SharedNames.load()).map { FluuxConversationEntity(entry: $0) }
    }

    func entities(matching string: String) async throws -> [FluuxConversationEntity] {
        entries().filter { $0.entry.name.localizedCaseInsensitiveContains(string) || $0.entry.id.localizedCaseInsensitiveContains(string) }
    }

    func suggestedEntities() async throws -> [FluuxConversationEntity] { entries() }
}

@available(iOS 16.0, *)
struct OpenFluuxConversationIntent: AppIntent {
    static var title: LocalizedStringResource = "Open conversation or room"
    static var openAppWhenRun = true

    @Parameter(title: "Conversation or room")
    var conversation: FluuxConversationEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$conversation)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        // Custom schemes use UIKit; OpenURLIntent accepts universal links only.
        // The WebView revalidates account and destination against its live stores.
        if let scheme = Bundle.main.object(forInfoDictionaryKey: "FluuxAppScheme") as? String,
           let url = conversation.entry.url(scheme: scheme) {
            await UIApplication.shared.open(url)
        }
        return .result()
    }
}

@available(iOS 16.0, *)
struct FluuxUnreadCountIntent: AppIntent {
    static var title: LocalizedStringResource = "Unread count"
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog {
        let count = SharedBadge.load()?.count ?? 0
        return .result(value: count, dialog: "Unread count: \(count)")
    }
}

@available(iOS 16.0, *)
struct FluuxAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: OpenFluuxConversationIntent(), phrases: [
            "Open a conversation in \(.applicationName)",
            "Open \(\.$conversation) in \(.applicationName)",
        ], shortTitle: "Open conversation", systemImageName: "bubble.left.and.bubble.right")
        AppShortcut(intent: FluuxUnreadCountIntent(), phrases: [
            "Unread count in \(.applicationName)",
        ], shortTitle: "Unread count", systemImageName: "number.circle")
    }
}
