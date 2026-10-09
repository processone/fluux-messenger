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
              values["account"] as? String == names.account else { delivery.finish(); return }
        UNUserNotificationCenter.current().getNotificationSettings { [delivery] settings in
            delivery.start(content, snapshot: snapshot, sender: sender, allowed: settings.showPreviewsSetting != .never,
                           isCurrent: { PreviewKeychain.read() == $0 }, engine: NotificationPreviewEngine.run,
                           completion: contentHandler)
        }
    }
    override func serviceExtensionTimeWillExpire() { delivery?.finish() }
}
