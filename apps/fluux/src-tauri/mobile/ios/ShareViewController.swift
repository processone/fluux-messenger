#if os(macOS)
import AppKit
typealias ShareController = NSViewController
#else
import UIKit
typealias ShareController = UIViewController
#endif
import UniformTypeIdentifiers
#if os(iOS)
import Intents
import os.log
#endif

/// The extension imports only. XMPP and account selection stay in the main app.
final class ShareViewController: ShareController {
    #if os(macOS)
    private let status = NSTextField(wrappingLabelWithString: "Fluux")
    override func loadView() { view = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 220)) }
    #else
    private let status = UILabel()
    #endif
    private var started = false
    #if os(iOS)
    private var suggestedDestination: ConversationDestination?
    #endif

    override func viewDidLoad() {
        super.viewDidLoad()
        #if os(macOS)
        status.alignment = .center
        let done = NSButton(title: NSLocalizedString("share_close", comment: ""), target: self, action: #selector(close))
        let stack = NSStackView(views: [status, done])
        stack.orientation = .vertical
        #else
        view.backgroundColor = .systemBackground
        status.text = "Fluux"
        status.numberOfLines = 0
        status.textAlignment = .center
        let done = UIButton(type: .system)
        done.setTitle(NSLocalizedString("share_close", comment: ""), for: .normal)
        done.addTarget(self, action: #selector(close), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [status, done])
        stack.axis = .vertical
        #endif
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    #if os(macOS)
    override func viewDidAppear() { super.viewDidAppear(); importItems() }
    #else
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); importItems() }
    #endif

    private func importItems() {
        guard !started else { return }
        started = true
        guard let items = extensionContext?.inputItems as? [NSExtensionItem],
              let group = Bundle.main.object(forInfoDictionaryKey: "FluuxShareGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            report(false); return
        }
        #if os(iOS)
        let intent = extensionContext?.intent as? INSendMessageIntent
        suggestedDestination = ConversationDestination.decode(intent?.conversationIdentifier)
        #endif
        let providers = items.flatMap { $0.attachments ?? [] }
        guard providers.count == 1, let provider = providers.first else { report(false); return }
        let root = container.appendingPathComponent("ShareInbox", isDirectory: true)
        let text = items.compactMap { $0.attributedContentText?.string }.joined(separator: "\n")
        #if os(iOS)
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            importImage(provider, root: root, text: text)
            return
        }
        #endif
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) &&
            !provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                guard let url = sharedURL(item), url.isFileURL else { self.report(false); return }
                self.save(root: root, text: text, file: url, name: url.lastPathComponent,
                          mime: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream")
            }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) ||
            (!provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) &&
             !provider.hasItemConformingToTypeIdentifier(UTType.text.identifier)) {
            let type = provider.registeredTypeIdentifiers.first { id in
                UTType(id)?.conforms(to: .data) == true && id != UTType.fileURL.identifier
            } ?? UTType.data.identifier
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                guard let url else { self.report(false); return }
                // NSItemProvider owns the temporary file only until this callback returns.
                self.save(root: root, text: text, file: url,
                          name: provider.suggestedName ?? url.lastPathComponent,
                          mime: UTType(type)?.preferredMIMEType ?? "application/octet-stream")
            }
        } else {
            let type = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier)
                ? UTType.url.identifier : UTType.text.identifier
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
                let value = type == UTType.url.identifier ? sharedURL(item)?.absoluteString
                    : (item as? String) ?? (item as? Data).flatMap { String(data: $0, encoding: .utf8) }
                guard let value else { self.report(false); return }
                self.save(root: root, text: value, file: nil, name: nil, mime: nil)
            }
        }
    }

    #if os(iOS)
    private func importImage(_ provider: NSItemProvider, root: URL, text: String) {
        // UIImage's object representation conforms to data but is an archive, not an image file.
        // Prefer encoded files so HEIC, JPEG and PNG retain their original representation.
        let type = provider.registeredTypeIdentifiers.compactMap { UTType($0) }.first {
            $0.conforms(to: .image) && $0.preferredMIMEType != nil && $0.preferredFilenameExtension != nil
        }
        if let type, let mime = type.preferredMIMEType, let ext = type.preferredFilenameExtension {
            provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                if let url {
                    // This temporary file belongs to NSItemProvider; copy it before returning.
                    self.save(root: root, text: text, file: url,
                              name: self.imageName(provider.suggestedName ?? url.lastPathComponent, extension: ext), mime: mime)
                } else {
                    self.importImageObject(provider, root: root, text: text)
                }
            }
        } else {
            importImageObject(provider, root: root, text: text)
        }
    }

    private func importImageObject(_ provider: NSItemProvider, root: URL, text: String) {
        // UIActivityViewController can vend a legacy NSSecureCoding UIImage as public.image.
        // That provider reports canLoadObject(UIImage.self) == false; loadItem decodes it correctly.
        provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, _ in
            let inputURL = (item as? URL).flatMap { $0.isFileURL ? $0 : nil }
            let granted = inputURL?.startAccessingSecurityScopedResource() ?? false
            defer { if granted { inputURL?.stopAccessingSecurityScopedResource() } }
            let image = (item as? UIImage)
                ?? (item as? Data).flatMap { UIImage(data: $0) }
                ?? inputURL.flatMap { UIImage(contentsOfFile: $0.path) }
            guard let data = image?.pngData() else { self.report(false); return }
            let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("png")
            defer { try? FileManager.default.removeItem(at: file) }
            do {
                try data.write(to: file)
                self.save(root: root, text: text, file: file,
                          name: self.imageName(provider.suggestedName, extension: "png"), mime: "image/png")
            } catch { self.report(false) }
        }
    }

    private func imageName(_ suggested: String?, extension ext: String) -> String {
        let name = ((suggested ?? "image") as NSString).lastPathComponent
        let stem = (name as NSString).deletingPathExtension
        return "\(stem.isEmpty ? "image" : stem).\(ext)"
    }
    #endif

    private func save(root: URL, text: String, file: URL?, name: String?, mime: String?) {
        let fm = FileManager.default
        let id = UUID().uuidString.lowercased()
        let staging = root.appendingPathComponent(".\(id)", isDirectory: true)
        do {
            guard text.utf8.count <= 65536, file != nil || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CocoaError(.fileWriteFileExists) }
            try fm.createDirectory(at: root, withIntermediateDirectories: true)
            let existing = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])
            for entry in existing where entry.lastPathComponent.hasPrefix(".") {
                if let modified = try? entry.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                   Date().timeIntervalSince(modified) > 86400 { try? fm.removeItem(at: entry) }
            }
            let pending = existing.filter { !$0.lastPathComponent.hasPrefix(".") }
            guard pending.count < 20 else { throw CocoaError(.fileWriteOutOfSpace) }
            let limit = ImportLimits(mime: mime)
            // Bytes already waiting in the inbox count towards its total.
            let waiting = pending.reduce(0) { total, entry in
                total + ((try? entry.appendingPathComponent("data").resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            }
            try fm.createDirectory(at: staging, withIntermediateDirectories: false)
            var size = 0
            let target = staging.appendingPathComponent("data")
            if let file {
                let granted = file.startAccessingSecurityScopedResource()
                defer { if granted { file.stopAccessingSecurityScopedResource() } }
                guard let input = InputStream(url: file), let output = OutputStream(url: target, append: false) else {
                    throw CocoaError(.fileReadUnknown)
                }
                input.open(); output.open()
                defer { input.close(); output.close() }
                var buffer = [UInt8](repeating: 0, count: 65536)
                while true {
                    let count = input.read(&buffer, maxLength: buffer.count)
                    guard count >= 0 else { throw CocoaError(.fileReadUnknown) }
                    if count == 0 { break }
                    size += count
                    guard size <= limit.file, waiting + size <= ImportLimits.total else { throw CocoaError(.fileWriteOutOfSpace) }
                    try buffer.withUnsafeBufferPointer { bytes in
                        var written = 0
                        while written < count {
                            let n = output.write(bytes.baseAddress!.advanced(by: written), maxLength: count - written)
                            guard n > 0 else { throw CocoaError(.fileWriteUnknown) }
                            written += n
                        }
                    }
                }
            }
            // Only a real still photo may use the larger allowance, as the app's reader also checks.
            if size > ImportLimits.other, !ImportLimits.isPhoto(target) { throw CocoaError(.fileWriteOutOfSpace) }
            var entry: [String: Any] = ["id": id, "text": text, "name": name.map { String($0.prefix(255)) } as Any? ?? NSNull(),
                                        "mime": mime as Any? ?? NSNull(), "size": size]
            #if os(iOS)
            if let destination = suggestedDestination {
                entry["suggestedDestination"] = ["account": destination.account, "jid": destination.jid, "type": destination.type]
            }
            #endif
            try JSONSerialization.data(withJSONObject: entry).write(to: staging.appendingPathComponent("entry.json"), options: .atomic)
            try fm.moveItem(at: staging, to: root.appendingPathComponent(id))
            report(true)
        } catch {
            try? fm.removeItem(at: staging)
            report(false)
        }
    }
    private func report(_ success: Bool) {
        DispatchQueue.main.async {
            #if os(iOS)
            let failure = "share_import_error_photos"
            #else
            let failure = "share_import_error"
            #endif
            let message = NSLocalizedString(success ? "share_saved" : failure, comment: "")
            #if os(macOS)
            self.status.stringValue = message
            if success, let app = containingApplication(for: Bundle.main.bundleURL) {
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                NSWorkspace.shared.openApplication(at: app, configuration: configuration) { application, error in
                    // Keep the saved-import instructions visible if launching fails.
                    if application != nil && error == nil {
                        DispatchQueue.main.async { self.close() }
                    }
                }
            }
            #else
            self.status.text = message
            // The saved-import instructions stay visible if Fluux cannot be opened.
            if success, let scheme = Bundle.main.object(forInfoDictionaryKey: "FluuxAppScheme") as? String,
               let url = URL(string: "\(scheme)://share") {
                self.openContainingApp(url) { opened in
                    if opened { DispatchQueue.main.async { self.close() } }
                }
            }
            #endif
        }
    }
    @objc private func close() { extensionContext?.completeRequest(returningItems: nil) }

    #if !os(macOS)
    /// iOS gives share extensions no API to open their app, but the extension
    /// process still has a UIApplication in its responder chain that can.
    private func openContainingApp(_ url: URL, completion: @escaping (Bool) -> Void) {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        let log = OSLog(subsystem: Bundle.main.bundleIdentifier ?? "net.processone.fluux.share", category: "ShareHandoff")
        os_log("Share handoff requested; selector=%{public}@", log: log, type: .default, NSStringFromSelector(selector))
        var responder: UIResponder? = self
        while let current = responder {
            if current is UIApplication, current.responds(to: selector) {
                typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, (@convention(block) (Bool) -> Void)?) -> Void
                let open = unsafeBitCast(current.method(for: selector), to: Open.self)
                os_log("Share handoff responder found=%{public}@; selector=%{public}@", log: log, type: .default,
                       String(describing: type(of: current)), NSStringFromSelector(selector))
                let done: @convention(block) (Bool) -> Void = { opened in
                    os_log("Share handoff completion opened=%{public}@", log: log, type: .default, opened ? "true" : "false")
                    completion(opened)
                }
                open(current, selector, url as NSURL, NSDictionary(), done)
                return
            }
            responder = current.next
        }
        os_log("Share handoff responder found=false; selector=%{public}@; opened=false", log: log, type: .default, NSStringFromSelector(selector))
        completion(false)
    }
    #endif
}

/// Size limits of one import. On iOS a JPEG or HEIF photo may be larger, because the app
/// reduces it before sending; the app's reader (`share-inbox/src/inbox.rs`) applies the same limits.
struct ImportLimits {
    static let other = 20 * 1024 * 1024
    #if os(iOS)
    static let photo = 64 * 1024 * 1024
    static let total = 400 * 1024 * 1024
    #else
    static let photo = other
    static let total = Int.max
    #endif
    let file: Int
    init(mime: String?) {
        file = ["image/jpeg", "image/heic", "image/heif"].contains(mime ?? "") ? Self.photo : Self.other
    }
    /// Checks the file's own signature: a JPEG, or a still HEIF image rather than a sequence.
    static func isPhoto(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        let header = [UInt8](handle.readData(ofLength: 12))
        guard header.count == 12 else { return false }
        return header.starts(with: [0xff, 0xd8, 0xff]) ||
            (header[4..<8].elementsEqual("ftyp".utf8) && ["heic", "heix", "mif1"].contains(String(decoding: header[8..<12], as: UTF8.self)))
    }
}

// Finder can vend public.file-url as serialized URL data instead of NSURL.
func sharedURL(_ item: NSSecureCoding?) -> URL? {
    if let url = item as? URL { return url }
    if let data = item as? Data { return URL(dataRepresentation: data, relativeTo: nil) }
    if let value = item as? String { return URL(string: value) }
    return nil
}

#if os(macOS)
func containingApplication(for extensionURL: URL) -> URL? {
    let plugins = extensionURL.deletingLastPathComponent()
    let contents = plugins.deletingLastPathComponent()
    let app = contents.deletingLastPathComponent()
    guard extensionURL.isFileURL, extensionURL.pathExtension == "appex",
          plugins.lastPathComponent == "PlugIns", contents.lastPathComponent == "Contents",
          app.pathExtension == "app" else { return nil }
    // Resolve the containing bundle, not a potentially different installed copy.
    return app
}
#endif
