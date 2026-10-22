import Foundation
import Tauri

private struct PhotoPath: Decodable {
    let path: String
}

private struct PhotoEncoding: Decodable {
    let source: String
    let destination: String
    let maxSide: Int
    let quality: Double
}

class ShareInboxPlugin: Plugin {
    @objc public func inboxPath(_ invoke: Invoke) {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FluuxShareGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            invoke.reject("Shared container unavailable")
            return
        }
        invoke.resolve(["path": root.appendingPathComponent("ShareInbox").path])
    }

    // Paths come from the Rust commands, which confine them to an import or a staged photo.
    @objc public func probePhoto(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(PhotoPath.self) else { return invoke.reject("Invalid photo") }
        DispatchQueue.global(qos: .userInitiated).async {
            guard let probe = PhotoPreparation.probe(URL(fileURLWithPath: args.path)) else {
                return invoke.reject("Unreadable photo")
            }
            // Dimensions as displayed, with the orientation applied.
            invoke.resolve(["type": probe.type, "width": probe.rotated ? probe.height : probe.width,
                            "height": probe.rotated ? probe.width : probe.height, "reducible": probe.reducible])
        }
    }

    @objc public func encodePhoto(_ invoke: Invoke) {
        guard let args = try? invoke.parseArgs(PhotoEncoding.self) else { return invoke.reject("Invalid photo") }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let encoded = try autoreleasepool {
                    try PhotoPreparation.encode(URL(fileURLWithPath: args.source), maxSide: args.maxSide,
                                                quality: args.quality, to: URL(fileURLWithPath: args.destination))
                }
                invoke.resolve(["width": encoded.width, "height": encoded.height, "size": encoded.size])
            } catch {
                invoke.reject("Photo could not be reduced")
            }
        }
    }
}

@_cdecl("init_plugin_share_inbox")
func initPlugin() -> Plugin { ShareInboxPlugin() }
