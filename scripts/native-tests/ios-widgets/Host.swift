import SwiftUI
import UIKit
import UserNotifications
import WidgetKit

/// Lab host: stands in for the app. It uses the production shared-folder code to write what the app
/// writes, runs the production NotificationService in-process for the push step, and shows the link
/// a widget row opens. It is not the Fluux app: routing from the link is not exercised here.
@main
struct LabHost: App {
    @State private var opened = "none"
    @State private var status = "starting"
    @State private var pushed = "none"
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 12) {
                Text("Widget lab host")
                Text(status).accessibilityIdentifier("status")
                Text(opened).accessibilityIdentifier("openedURL")
                Text(pushed).accessibilityIdentifier("pushResult")
            }
            .onOpenURL { opened = $0.absoluteString }
            .task { await run() }
        }
    }

    @MainActor func run() async {
        guard let root = NotificationMirror.root else { status = "ready no-root"; return }
        let arguments = ProcessInfo.processInfo.arguments
        do {
            if arguments.contains("-seed") { try seed(root) }
            if arguments.contains("-push") { pushed = await push(root) }
            if arguments.contains("-signout") { try signOut(root) }
            WidgetCenter.shared.reloadAllTimelines()
            status = "ready"
        } catch { status = "ready error \(error)" }
    }
}

let labAccount = "me@lab.test"

func avatarPNG() -> Data {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64))
    return renderer.image { context in
        UIColor.systemRed.setFill(); context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        UIColor.white.setFill(); context.cgContext.fillEllipse(in: CGRect(x: 16, y: 16, width: 32, height: 32))
    }.pngData()!
}

/// What the app writes when signed in with one unread chat: names and avatar, the badge, the widget list.
func seed(_ root: URL) throws {
    let hash = String(repeating: "ab", count: 20)
    var names = SharedNames(contacts: ["alice@lab.test": "Alice Lab", "bob@lab.test": "Bob Lab"],
                            avatars: ["alice@lab.test": hash], account: labAccount)
    names.conversations = [.init(id: "alice@lab.test", name: "Alice Lab", kind: "chat", account: labAccount)]
    try NotificationMirror.writeNames(names, root: root)
    let mirrored = try NotificationMirror.writeAvatar(.init(account: labAccount, hash: hash, data: avatarPNG().base64EncodedString()), root: root)
    precondition(mirrored, "avatar mirrored")
    let badge = SharedBadge(unread: ["alice@lab.test"], events: 0, notifyAllRooms: [])
    try JSONEncoder().encode(badge).write(to: root.appendingPathComponent("NotificationBadge.json"), options: .atomic)
    let now = Date().timeIntervalSince1970 * 1000
    try UnreadList(account: labAccount, total: 1,
                   rows: [.init(id: "alice@lab.test", kind: "chat", name: "Alice Lab", unread: 1, mentions: 0, last: now)],
                   updated: now).write(root: root)
}

/// Production sign-out leaves no account, no names and no list.
func signOut(_ root: URL) throws {
    try NotificationMirror.writeNames(SharedNames(), root: root)
    try UnreadList.clear(root: root)
    try? FileManager.default.removeItem(at: root.appendingPathComponent("NotificationBadge.json"))
}

/// The push step: the production NotificationService handles a push from a conversation not yet listed.
/// Delivered pushes reach it in a separate process on a device; the simulator does not wake the extension.
func push(_ root: URL) async -> String {
    let content = UNMutableNotificationContent()
    content.title = "Bob Lab"
    content.body = "New message"
    content.userInfo = ["from": "bob@lab.test/phone", "to": labAccount]
    let request = UNNotificationRequest(identifier: "lab-push", content: content, trigger: nil)
    let service = NotificationService()
    return await withCheckedContinuation { continuation in
        service.didReceive(request) { result in
            continuation.resume(returning: "delivered title=\(result.title)")
        }
    }
}
