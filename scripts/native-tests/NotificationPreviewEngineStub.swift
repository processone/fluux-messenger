import Foundation
// Presentation-only fixtures must never fetch or decrypt.
enum NotificationPreviewEngine {
    static func run(_ input: Data, account: String, root: URL, isCurrent: @escaping () -> Bool,
                    completion: @escaping (PreviewResult?) -> Void) -> () -> Void {
        preconditionFailure("Unexpected preview fetch in presentation fixture")
    }
}
