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
        let diagnostic = PreviewTrace.recorder(root: ledgerRoot())
        delivery.diagnostic = diagnostic
        diagnostic(.received, nil)
        let tag = String(request.identifier.prefix(8))
        guard NotificationPresentation.belongsToSignedInAccount(request.content, names: names) else {
            diagnostic(.wrongAccount, nil)
            PreviewTrace.note("push \(tag): neutral, not for the signed-in account")
            contentHandler(NotificationPresentation.neutralContent())
            return
        }
        guard !NotificationPresentation.isOwnRoomMessage(request.content, names: names) else {
            diagnostic(.ownRoomMessage, nil)
            PreviewTrace.note("push \(tag): passive, own message in a room")
            contentHandler(NotificationPresentation.ownMessageContent(request.content, names: names))
            return
        }
        delivery.trace = { PreviewTrace.note("push \(tag): \($0)") }
        let finish: (UNNotificationContent) -> Void = { [loadNames] content in
            // Recheck after asynchronous preview work and on system expiry.
            contentHandler(NotificationPresentation.belongsToSignedInAccount(request.content, names: loadNames())
                           ? content : NotificationPresentation.neutralContent())
        }
        let content = NotificationPresentation.content(for: request.content, names: names)
        delivery.begin(content, completion: finish)
        let sender = (content.userInfo["from"] as? String).flatMap(NotificationPresentation.bareJid)
        let snapshot = readSnapshot()
        let skip = { (decision: PreviewDecision, reason: String) in
            diagnostic(decision, nil)
            delivery.trace("no preview, \(reason)")
            delivery.finish()
        }
        // Only covered direct pushes can replace their transport-safe body with an archive preview.
        guard content.userInfo["encrypted"] as? Bool != false else { return skip(.notEncrypted, "not encrypted") }
        guard let sender = sender else { return skip(.noSender, "no sender") }
        guard names.rooms[sender] == nil else {
            let nick = (content.userInfo["from"] as? String)?.contains("/") == true
            return skip(.groupChat, "group chat, occupant nick \(nick ? "present" : "absent"), own nick \(names.roomParticipants[sender] == nil ? "unknown" : "known")")
        }
        guard let snapshot = snapshot else { return skip(.previewsOff, "previews off") }
        guard PreviewDelivery.covers(sender, snapshot: snapshot) else { return skip(.senderNotCovered, "sender not covered") }
        guard let values = (try? JSONSerialization.jsonObject(with: snapshot)) as? [String: Any],
              let account = values["account"] as? String, account == names.account else {
            return skip(.snapshotChanged, "snapshot for another account")
        }
        // JSONSerialization raises an Objective-C exception, not a Swift error, on a non-container.
        guard let ledgerValue = values["ledger"], JSONSerialization.isValidJSONObject(ledgerValue),
              let sessionData = try? JSONSerialization.data(withJSONObject: ledgerValue),
              let session = try? JSONDecoder().decode(PreviewLedger.Session.self, from: sessionData) else {
            return skip(.noSession, "no ledger session")
        }
        guard let root = ledgerRoot(), let ledger = try? PreviewLedger(root: root) else { return skip(.ledgerUnavailable, "ledger unavailable") }
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
                                   // The server has already rotated or refused the token; keep that whatever happens to
                                   // the preview, unless the capability was revoked or another run changed the token.
                                   let change = result?.fastToken.map { PreviewToken.Change.rotate(token: $0.token, expiry: $0.expiry) }
                                       ?? (result?.tokenRefused == true ? .clear : nil)
                                   if let change = change {
                                       PreviewToken.record(change, after: credential, root: root,
                                                           snapshotCurrent: { PreviewKeychain.publishedAccount() == account })
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
    override func serviceExtensionTimeWillExpire() { delivery?.finish(expiration: .systemExpiry) }
}
