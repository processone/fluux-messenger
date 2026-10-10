import Foundation

struct NotificationSoundSettings: Codable {
    let account: String?
    let enabled: Bool
    let tone: String
    static let tones = ["default", "bell", "chime", "pulse", "silent"]

    func soundName(originalHasSound: Bool, owner: String?) -> String? {
        guard originalHasSound, let account, account == owner, enabled, Self.tones.contains(tone), tone != "silent" else { return nil }
        return tone == "default" ? "default" : "fluux-\(tone).wav"
    }

    static func load(root: URL?) -> Self? {
        guard let root, let data = try? Data(contentsOf: root.appendingPathComponent("NotificationSound.json")) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
    func write(root: URL) throws {
        guard Self.tones.contains(tone) else { throw CocoaError(.coderInvalidValue) }
        try JSONEncoder().encode(self).write(to: root.appendingPathComponent("NotificationSound.json"),
                                            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
