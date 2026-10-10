import Foundation

struct PreviewEvent: Codable {
    let uid: String
    let id: String
    var originId: String? = nil
    let kind: String
    var body: String?
    let mutation: String?
    let target: String?
    let text: String?
}
struct PreviewResult: Codable {
    let events: [PreviewEvent]
    let complete: Bool
}
struct PreviewSelection {
    var body: String?
    var claimed: [String] = []
    var removeRequests: [String] = []
}
struct PreviewWords: Codable {
    static var localized: PreviewWords {
        func word(_ key: String) -> String { NSLocalizedString(key, tableName: "NotificationPreviews", bundle: .main, value: key == "activity" ? "New activity" : key, comment: "") }
        return PreviewWords(activity: word("activity"), reaction: word("reaction"), edit: word("edit"), retraction: word("retraction"), messages: word("messages"))
    }
    let activity: String
    let reaction: String
    let edit: String
    let retraction: String
    let messages: String
    func format(_ template: String, nickname: String, text: String = "", count: Int = 0) -> String {
        template.replacingOccurrences(of: "{{nickname}}", with: nickname)
            .replacingOccurrences(of: "{{text}}", with: text)
            .replacingOccurrences(of: "{{count}}", with: String(count))
    }
}
