import Foundation

@_silgen_name("fluux_nse_new") private func newHandle() -> UnsafeMutableRawPointer
@_silgen_name("fluux_nse_cancel") private func cancelHandle(_ handle: UnsafeMutableRawPointer)
@_silgen_name("fluux_nse_free") private func freeHandle(_ handle: UnsafeMutableRawPointer)
@_silgen_name("fluux_nse_preview") private func preview(_ handle: UnsafeMutableRawPointer, _ input: UnsafePointer<UInt8>, _ count: Int,
                                                     _ output: UnsafeMutablePointer<UInt8>, _ capacity: Int) -> Int

private final class RustPreviewInvocation {
    let handle = newHandle()
    private let lock = NSLock()
    private var cancelled = false
    deinit { freeHandle(handle) }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func cancel() {
        lock.lock(); cancelled = true; lock.unlock()
        cancelHandle(handle)
    }
}
enum NotificationPreviewEngine {
    // Storage closures let the native regression harness exercise the actual worker and FFI
    // ordering with in-memory credentials, without accessing a real keychain.
    static func run(_ input: Data, account: String, root: URL, isCurrent: @escaping () -> Bool,
                    loadToken: @escaping (String) -> PreviewToken = { PreviewToken.load(for: $0) },
                    recordToken: @escaping (PreviewToken.Change, PreviewToken) -> Void = { change, credential in
                        PreviewToken.recordLocked(change, after: credential,
                            snapshotCurrent: { PreviewKeychain.publishedAccount() == credential.account })
                    }, completion: @escaping (PreviewResult?) -> Void) -> () -> Void {
        let invocation = RustPreviewInvocation()
        DispatchQueue.global(qos: .utility).async {
            // The server rotates FAST tokens during sign-in, not during local storage.
            // Read the latest credential only after the previous lookup has stored its successor.
            let result: PreviewResult? = PreviewToken.withSignInLock(root: root) {
                guard !invocation.isCancelled, isCurrent(),
                      var values = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] else { return nil }
                let credential = loadToken(account)
                values["user_agent_id"] = credential.userAgentId
                values["fast_token"] = credential.token
                guard let bytes = try? JSONSerialization.data(withJSONObject: values) else { return nil }
                var output = [UInt8](repeating: 0, count: 64 * 1024)
                let count = bytes.withUnsafeBytes { input in
                    output.withUnsafeMutableBufferPointer { output in
                        preview(invocation.handle, input.bindMemory(to: UInt8.self).baseAddress!, input.count, output.baseAddress!, output.count)
                    }
                }
                guard count > 0, count <= output.count,
                      let result = try? JSONDecoder().decode(PreviewResult.self, from: Data(output.prefix(count))),
                      result.events.count <= 100 else { return nil }
                // Preserve server rotation/refusal even when delivery expired. Do not reacquire
                // the same file lock here; capability publication/revocation shares this lock.
                let change = result.fastToken.map { PreviewToken.Change.rotate(token: $0.token, expiry: $0.expiry) }
                    ?? (result.tokenRefused == true ? .clear : nil)
                if let change = change { recordToken(change, credential) }
                return result
            } ?? nil
            completion(result)
        }
        return { invocation.cancel() }
    }
}
