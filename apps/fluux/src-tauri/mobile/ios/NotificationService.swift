import UserNotifications

/// Applies presentation metadata and attempts an opted-in authenticated OX preview.
final class NotificationService: UNNotificationServiceExtension {
    private var delivery: PreviewDelivery?
    var loadNames: () -> SharedNames = { SharedNames.load() }
    var readSnapshot: () -> Data? = { PreviewKeychain.read() }
    var ledgerRoot: () -> URL? = { NotificationMirror.root }
    var previewsAllowed: (@escaping (Bool) -> Void) -> Void = { complete in
        UNUserNotificationCenter.current().getNotificationSettings { complete($0.showPreviewsSetting != .never) }
    }
    var runPreview: (Data, String, URL, @escaping () -> Bool, @escaping (PreviewResult?) -> Void) -> (() -> Void) = {
        NotificationPreviewEngine.run($0, account: $1, root: $2, isCurrent: $3, completion: $4)
    }
    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        delivery?.finish()
        let delivery = PreviewDelivery()
        self.delivery = delivery
        let names = loadNames()
        let root = ledgerRoot()
        // Capture one session for both paths: logout must reject every late event from this push.
        let record = PreviewTrace.batchRecorder(root: root, correlation: UUID())
        let diagnostic: (PreviewDecision, Int?) -> Void = { decision, duration in
            record([.init(decision: decision, time: Date().timeIntervalSince1970, durationMs: duration)])
        }
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
        let snapshot = readSnapshot()
        let values = snapshot.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
        // Use only this signed-in account's published app wording. Device wording is
        // the fallback when there is no matching capability, not a replacement for it.
        let wordValue = values?["account"] as? String == names.account ? values?["words"] : nil
        let words = wordValue.flatMap { JSONSerialization.isValidJSONObject($0) ? try? JSONSerialization.data(withJSONObject: $0) : nil }
            .flatMap { try? JSONDecoder().decode(PreviewWords.self, from: $0) } ?? PreviewWords.localized
        // The widget lists counted membership, even when another push does not raise its total.
        var widgetCounted = false
        let storedBadge = SharedBadge.load(root: root)
        let badge = storedBadge.flatMap { $0.account == names.account ? $0 : nil }
        func recordCountedWidget(_ bare: String, isRoom: Bool, refreshCurrent: Bool) {
            widgetCounted = true
            let events = UnreadList.recordPush(conversation: bare, kind: isRoom ? "groupchat" : "chat",
                                               name: (isRoom ? names.rooms[bare] : names.contacts[bare]) ?? bare,
                                               account: names.account,
                                               // Read one owned membership/total snapshot under the shared writer lock.
                                               badge: SharedBadge.load(root: root).map {
                                                   .init(account: $0.account, unread: $0.unread, total: $0.count, updated: $0.updated)
                                               }, root: root, refreshCurrent: refreshCurrent)
            record(events.map(\.diagnostic))
        }
        let content = NotificationPresentation.content(for: request.content, names: names, activity: words.activity,
                                                       badge: badge, badgeRoot: root) { bare, isRoom, _ in
            recordCountedWidget(bare, isRoom: isRoom, refreshCurrent: true)
        }
        // A counted conversation can be missing from a stale list. Reconcile it without
        // incrementing the badge or spending another redraw when the list is already correct.
        if !widgetCounted, let badge,
           let from = NotificationPresentation.sender(of: request.content.userInfo, names: names),
           let bare = NotificationPresentation.bareJid(from), badge.unread.contains(bare) {
            recordCountedWidget(bare, isRoom: names.rooms[bare] != nil || badge.notifyAllRooms.contains(bare), refreshCurrent: false)
        }
        if !widgetCounted {
            let time = Date().timeIntervalSince1970
            if let storedBadge, badge == nil {
                record([.init(decision: .widgetAccountMismatch, time: time),
                        .init(decision: storedBadge.account == nil ? .widgetBadgeOwnerMissing : .widgetBadgeOwnerMismatch, time: time)])
            } else {
                record([.init(decision: badge == nil ? .widgetBadgeUnavailable : .widgetNotCounted, time: time)])
            }
        }
        delivery.begin(content, completion: finish)
        let sender = (content.userInfo["from"] as? String).flatMap(NotificationPresentation.bareJid)
        let skip = { (decision: PreviewDecision, reason: String) in
            diagnostic(decision, nil)
            delivery.trace("no preview, \(reason)")
            delivery.finish()
        }
        // Only covered direct pushes can replace their transport-safe body with an archive preview.
        guard content.userInfo["encrypted"] as? Bool != false else { return skip(.notEncrypted, "not encrypted") }
        guard let sender = sender else { return skip(.noSender, "no sender") }
        guard names.rooms[sender] == nil else {
            let nick = NotificationPresentation.sender(of: content.userInfo, names: names)?.contains("/") == true
            return skip(.groupChat, "group chat, occupant nick \(nick ? "present" : "absent"), own nick \(names.roomParticipants[sender] == nil ? "unknown" : "known")")
        }
        guard let snapshot = snapshot else { return skip(.previewsOff, "previews off") }
        guard PreviewDelivery.covers(sender, snapshot: snapshot) else { return skip(.senderNotCovered, "sender not covered") }
        guard let values = values,
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
        // Presentation already filtered encrypted placeholders. A lookup miss must not
        // discard readable text from this push, including a later push in a burst.
        previewsAllowed { [delivery, readSnapshot, runPreview] allowed in
            delivery.start(content, snapshot: snapshot, sender: sender, allowed: allowed,
                           isCurrent: { readSnapshot() == $0 && (try? ledger.current()) == session },
                           engine: { input, completion in
                               runPreview(input, account, root, {
                                   readSnapshot() == snapshot && (try? ledger.current()) == session
                               }, completion)
                           },
                           prepare: { input in
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

private extension UnreadList.PushEvent {
    var diagnostic: PreviewTrace.Event {
        let value: PreviewDecision
        switch decision {
        case .listUnavailable: value = .widgetListUnavailable
        case .badgeUnavailable: value = .widgetBadgeUnavailable
        case .notCounted: value = .widgetNotCounted
        case .accountMismatch: value = .widgetAccountMismatch
        case .badgeOwnerMissing: value = .widgetBadgeOwnerMissing
        case .badgeOwnerMismatch: value = .widgetBadgeOwnerMismatch
        case .listOwnerMismatch: value = .widgetListOwnerMismatch
        case .alreadyListed: value = .widgetAlreadyListed
        case .rowSelected: value = .widgetRowSelected
        case .writeSucceeded: value = .widgetWriteSucceeded
        case .writeFailed: value = .widgetWriteFailed
        case .countMismatch: value = .widgetCountMismatch
        case .reloadRequested: value = .widgetReloadRequested
        case .reloadUnavailable: value = .widgetReloadUnavailable
        }
        return .init(decision: value, time: time)
    }
}
