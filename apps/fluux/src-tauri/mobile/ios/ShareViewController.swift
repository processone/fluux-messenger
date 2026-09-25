import UIKit
import UniformTypeIdentifiers

/// The extension imports only. XMPP and account selection stay in the main app.
final class ShareViewController: UIViewController {
    private let status = UILabel()
    private var started = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.text = "Fluux"
        status.numberOfLines = 0
        status.textAlignment = .center
        let done = UIButton(type: .system)
        done.setTitle(NSLocalizedString("share_close", comment: ""), for: .normal)
        done.addTarget(self, action: #selector(close), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [status, done])
        stack.axis = .vertical
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        guard let items = extensionContext?.inputItems as? [NSExtensionItem],
              let group = Bundle.main.object(forInfoDictionaryKey: "FluuxShareGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            report(false); return
        }
        let providers = items.flatMap { $0.attachments ?? [] }
        guard providers.count == 1, let provider = providers.first else { report(false); return }
        let root = container.appendingPathComponent("ShareInbox", isDirectory: true)
        let text = items.compactMap { $0.attributedContentText?.string }.joined(separator: "\n")
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) &&
            !provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                guard let url = item as? URL, url.isFileURL else { self.report(false); return }
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
                let value = (item as? URL)?.absoluteString ?? (item as? String)
                guard let value else { self.report(false); return }
                self.save(root: root, text: value, file: nil, name: nil, mime: nil)
            }
        }
    }

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
            guard existing.filter({ !$0.lastPathComponent.hasPrefix(".") }).count < 20 else { throw CocoaError(.fileWriteOutOfSpace) }
            try fm.createDirectory(at: staging, withIntermediateDirectories: false)
            var size = 0
            if let file {
                let granted = file.startAccessingSecurityScopedResource()
                defer { if granted { file.stopAccessingSecurityScopedResource() } }
                let target = staging.appendingPathComponent("data")
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
                    guard size <= 20 * 1024 * 1024 else { throw CocoaError(.fileWriteOutOfSpace) }
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
            let entry: [String: Any] = ["id": id, "text": text, "name": name.map { String($0.prefix(255)) } as Any? ?? NSNull(),
                                        "mime": mime as Any? ?? NSNull(), "size": size]
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
            self.status.text = NSLocalizedString(success ? "share_saved" : "share_import_error", comment: "")
        }
    }
    @objc private func close() { extensionContext?.completeRequest(returningItems: nil) }
}
