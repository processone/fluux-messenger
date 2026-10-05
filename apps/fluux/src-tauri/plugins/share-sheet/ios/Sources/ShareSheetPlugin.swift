import Foundation
import Tauri
import UIKit
import WebKit

private struct SharedFile: Decodable {
    let path: String
    let name: String
}

/// Presents the system share sheet for one local file.
///
/// The sheet shows the file under its own name, so it is first copied to a
/// temporary directory under the name the user knows (cached media is stored
/// under a content hash). The copy is removed once the sheet is dismissed.
class ShareSheetPlugin: Plugin {
    @objc public func shareFile(_ invoke: Invoke) {
        let file: SharedFile
        do {
            file = try invoke.parseArgs(SharedFile.self)
        } catch {
            invoke.reject(error.localizedDescription)
            return
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("share", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let copy = directory.appendingPathComponent(ShareSheetPlugin.fileName(file.name))
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: file.path), to: copy)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            invoke.reject(error.localizedDescription)
            return
        }

        DispatchQueue.main.async {
            guard let presenter = self.manager.viewController else {
                try? FileManager.default.removeItem(at: directory)
                invoke.reject("No view controller to present the share sheet")
                return
            }
            let sheet = UIActivityViewController(activityItems: [copy], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, completed, _, _ in
                try? FileManager.default.removeItem(at: directory)
                invoke.resolve(["completed": completed])
            }
            // An iPad presents the sheet as a popover, which needs an anchor.
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            presenter.present(sheet, animated: true)
        }
    }

    /// The last path component of `name`, so a received file name cannot point elsewhere.
    private static func fileName(_ name: String) -> String {
        let last = (name as NSString).lastPathComponent
        return last.isEmpty || last == "." || last == ".." ? "file" : last
    }
}

@_cdecl("init_plugin_share_sheet")
func initPlugin() -> Plugin { ShareSheetPlugin() }
