import Foundation
import os

/// Notification delivery decisions in the device log, subsystem `net.processone.fluux`.
///
/// Entries carry decisions, counts and durations, and the random identifier of a
/// notification request to pair the app with the extension. They never carry a sender,
/// a message body or a message identifier.
enum PreviewTrace {
    private static let log = Logger(subsystem: "net.processone.fluux", category: "notification")

    static func note(_ message: String) {
        log.notice("\(message, privacy: .public)")
    }
}
