import UserNotifications

/// Applies the shared iOS notification presentation to remote pushes.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        contentHandler(NotificationPresentation.content(for: request.content))
    }
}
