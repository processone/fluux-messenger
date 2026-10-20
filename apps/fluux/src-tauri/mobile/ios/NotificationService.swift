import UserNotifications

/// Applies presentation metadata and attempts an opted-in authenticated OX preview.
final class NotificationService: UNNotificationServiceExtension {
    private var delivery: PreviewDelivery?
    var loadNames: () -> SharedNames = { SharedNames.load() }
    var readSnapshot: () -> Data? = { PreviewKeychain.read() }
    var ledgerRoot: () -> URL? = { NotificationMirror.root }
    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        delivery?.finish()
        let delivery = PreviewDelivery()
        self.delivery = delivery
        let names = loadNames()
        guard NotificationPresentation.belongsToSignedInAccount(request.content, names: names) else {
            contentHandler(NotificationPresentation.neutralContent())
            return
        }
        let finish: (UNNotificationContent) -> Void = { [loadNames] content in
            // Recheck after asynchronous preview work and on system expiry.
            contentHandler(NotificationPresentation.belongsToSignedInAccount(request.content, names: loadNames())
                           ? content : NotificationPresentation.neutralContent())
        }
        let content = NotificationPresentation.content(for: request.content, names: names)
        delivery.begin(content, completion: finish)
        let sender = (content.userInfo["from"] as? String).flatMap(NotificationPresentation.bareJid)
        let snapshot = readSnapshot()
        // Only covered direct pushes can replace their transport-safe body with an archive preview.
        guard content.userInfo["encrypted"] as? Bool != false,
              let sender = sender, names.rooms[sender] == nil, let snapshot = snapshot,
              PreviewDelivery.covers(sender, snapshot: snapshot),
              let values = (try? JSONSerialization.jsonObject(with: snapshot)) as? [String: Any],
              let account = values["account"] as? String, account == names.account,
              // JSONSerialization raises an Objective-C exception, not a Swift error, on a non-container.
              let ledgerValue = values["ledger"], JSONSerialization.isValidJSONObject(ledgerValue),
              let sessionData = try? JSONSerialization.data(withJSONObject: ledgerValue),
              let session = try? JSONDecoder().decode(PreviewLedger.Session.self, from: sessionData),
              let root = ledgerRoot(), let ledger = try? PreviewLedger(root: root) else { delivery.finish(); return }
        let words = values["words"].flatMap { JSONSerialization.isValidJSONObject($0) ? try? JSONSerialization.data(withJSONObject: $0) : nil }
            .flatMap { try? JSONDecoder().decode(PreviewWords.self, from: $0) } ?? PreviewWords.localized
        let credential = PreviewToken.load(for: account)
        let fallback = content.mutableCopy() as? UNMutableNotificationContent
        fallback?.body = words.activity
        // Expiry, unknown events and duplicates all keep a nonempty stage-1 alert.
        let original: UNNotificationContent = fallback ?? content
        delivery.updateFallback(original)
        UNUserNotificationCenter.current().getNotificationSettings { [delivery] settings in
            delivery.start(original, snapshot: snapshot, sender: sender, allowed: settings.showPreviewsSetting != .never,
                           isCurrent: { PreviewKeychain.read() == $0 && (try? ledger.current()) == session },
                           engine: { input, completion in
                               NotificationPreviewEngine.run(input) { result in
                                   // The server has already rotated the token; keep it whatever happens to the preview.
                                   if let issued = result?.fastToken {
                                       var rotated = credential
                                       rotated.token = issued.token
                                       rotated.expiry = issued.expiry
                                       try? rotated.save()
                                   }
                                   completion(result)
                               }
                           },
                           prepare: { input in
                               input["user_agent_id"] = credential.userAgentId
                               input["fast_token"] = credential.token
                               let now = Date()
                               guard now.timeIntervalSince1970 >= session.activated else { return false }
                               let formatter = ISO8601DateFormatter()
                               let end = now.addingTimeInterval(PreviewLedger.archiveSlack)
                               input["window_start"] = formatter.string(from: Date(timeIntervalSince1970: ceil(max(session.activated, end.timeIntervalSince1970 - PreviewLedger.horizon))))
                               input["window_end"] = formatter.string(from: end)
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
                           completion: finish)
        }
    }
    override func serviceExtensionTimeWillExpire() { delivery?.finish() }
}
