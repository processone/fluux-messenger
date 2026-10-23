import Foundation
open class Plugin: NSObject {
    public static var event: ((String, Data) -> Void)?
    public func trigger<T: Encodable>(_ name: String, data: T) throws { Self.event?(name, try JSONEncoder().encode(data)) }
    open func requestPermissions(_ invoke: Invoke) {}
    open func checkPermissions(_ invoke: Invoke) {}
}
@objc public class Invoke: NSObject {
    let data: Data
    public init(data: Data) { self.data = data }
    public func parseArgs<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: data) }
    public func resolve(_ value: Any? = nil) {}
    public func reject(_ value: String) { fatalError(value) }
}
