import UserNotifications

/// Applies presentation metadata and attempts an opted-in authenticated OX preview.
final class NotificationService: UNNotificationServiceExtension {
    private var delivery: PreviewDelivery?
    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        delivery?.finish()
        let delivery = PreviewDelivery()
        self.delivery = delivery
        let content = NotificationPresentation.content(for: request.content)
        delivery.begin(content, completion: contentHandler)
        let names = SharedNames.load()
        let sender = (content.userInfo["from"] as? String).flatMap(NotificationPresentation.bareJid)
        let snapshot = PreviewKeychain.read()
        guard let sender = sender, names.rooms[sender] == nil, let snapshot = snapshot,
              let values = (try? JSONSerialization.jsonObject(with: snapshot)) as? [String: Any],
              values["account"] as? String == names.account,
              let sessionData = try? JSONSerialization.data(withJSONObject: values["ledger"] as Any),
              let session = try? JSONDecoder().decode(PreviewLedger.Session.self, from: sessionData),
              let root = NotificationMirror.root, let ledger = try? PreviewLedger(root: root) else { delivery.finish(); return }
        let words = (try? JSONSerialization.data(withJSONObject: values["words"] as Any))
            .flatMap { try? JSONDecoder().decode(PreviewWords.self, from: $0) } ?? PreviewWords.localized
        let fallback = content.mutableCopy() as? UNMutableNotificationContent
        fallback?.body = words.activity
        // Expiry, unknown events and duplicates all keep a nonempty stage-1 alert.
        let original: UNNotificationContent = fallback ?? content
        delivery.updateFallback(original)
        UNUserNotificationCenter.current().getNotificationSettings { [delivery] settings in
            delivery.start(original, snapshot: snapshot, sender: sender, allowed: settings.showPreviewsSetting != .never,
                           isCurrent: { PreviewKeychain.read() == $0 && (try? ledger.current()) == session }, engine: NotificationPreviewEngine.run,
                           prepare: { input in
                               let now = Date()
                               guard now.timeIntervalSince1970 >= session.activated else { return false }
                               let formatter = ISO8601DateFormatter()
                               input["window_start"] = formatter.string(from: Date(timeIntervalSince1970: ceil(max(session.activated, now.timeIntervalSince1970 - PreviewLedger.horizon))))
                               input["window_end"] = formatter.string(from: now)
                               guard let known = try? ledger.knownIDs(session: session, conversation: sender) else { return false }
                               input["known_ids"] = known
                               return true
                           },
                           select: { result in
                               var selection = (try? ledger.claim(result, session: session, conversation: sender, request: request.identifier,
                                                  nickname: SenderTitle(from: sender, names: names).title, words: words)) ?? PreviewSelection()
                               if (try? ledger.deliverable(selection, session: session, conversation: sender)) != true { selection.body = nil }
                               return selection
                           },
                           completion: contentHandler)
        }
    }
    override func serviceExtensionTimeWillExpire() { delivery?.finish() }
}
