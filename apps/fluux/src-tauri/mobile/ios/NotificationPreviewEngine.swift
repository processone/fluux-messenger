import Foundation

@_silgen_name("fluux_nse_new") private func newHandle() -> UnsafeMutableRawPointer
@_silgen_name("fluux_nse_cancel") private func cancelHandle(_ handle: UnsafeMutableRawPointer)
@_silgen_name("fluux_nse_free") private func freeHandle(_ handle: UnsafeMutableRawPointer)
@_silgen_name("fluux_nse_preview") private func preview(_ handle: UnsafeMutableRawPointer, _ input: UnsafePointer<UInt8>, _ count: Int,
                                                     _ output: UnsafeMutablePointer<UInt8>, _ capacity: Int) -> Int

private final class RustPreviewInvocation {
    let handle = newHandle()
    deinit { freeHandle(handle) }
    func cancel() { cancelHandle(handle) }
}
enum NotificationPreviewEngine {
    static func run(_ input: Data, completion: @escaping (String?) -> Void) -> () -> Void {
        let invocation = RustPreviewInvocation()
        DispatchQueue.global(qos: .utility).async {
            var output = [UInt8](repeating: 0, count: 4096)
            let count = input.withUnsafeBytes { input in
                output.withUnsafeMutableBufferPointer { output in
                    preview(invocation.handle, input.bindMemory(to: UInt8.self).baseAddress!, input.count, output.baseAddress!, output.count)
                }
            }
            guard count > 0, count <= output.count,
                  let result = try? JSONSerialization.jsonObject(with: Data(output.prefix(count))) as? [String: Any],
                  let body = result["preview"] as? String, !body.isEmpty else { completion(nil); return }
            completion(body)
        }
        return { invocation.cancel() }
    }
}
