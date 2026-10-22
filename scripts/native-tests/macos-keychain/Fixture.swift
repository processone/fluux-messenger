// FLM-66: explicit scratch keychains only. The approved fixture creates an
// equivalent combined item trusting both test apps, as Always Allow would.
import Foundation
import Security

func die(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!); exit(2)
}
func check(_ status: OSStatus) {
    guard status == errSecSuccess else { die("fixture status: \(status)") }
}
let args = CommandLine.arguments
let env = ProcessInfo.processInfo.environment
guard let home = env["HOME"], args.count >= 4,
      FileManager.default.fileExists(atPath: home + "/.fluux-keychain-test-home") else { die("scratch HOME required") }
let root = URL(fileURLWithPath: home).resolvingSymlinksInPath().path
for path in [args[2], args[3]] {
    let parent = URL(fileURLWithPath: path).deletingLastPathComponent().resolvingSymlinksInPath().path
    guard parent == root else { die("scratch paths required") }
}
check(SecKeychainSetUserInteractionAllowed(false))
let password = try String(contentsOfFile: args[3], encoding: .utf8)
var keychain: SecKeychain?
check(SecKeychainCreate(args[2], UInt32(password.utf8.count), password, false, nil, &keychain))
if args[1] == "approved" {
    guard args.count == 6 else { die("two test identities required") }
    let service = "com.processone.fluux", account = "secrets-v1"
    let data = try Data(contentsOf: URL(fileURLWithPath: home + "/approved-item.json"))
    var trusted: [SecTrustedApplication] = []
    for path in [args[4], args[5]] {
        var app: SecTrustedApplication?
        check(SecTrustedApplicationCreateFromPath(path, &app)); trusted.append(app!)
    }
    var access: SecAccess?
    check(SecAccessCreate(service as CFString, trusted as CFArray, &access))
    let status = service.withCString { s in account.withCString { a in
        var attributes = [
            SecKeychainAttribute(tag: SecItemAttr.serviceItemAttr.rawValue, length: UInt32(service.utf8.count), data: UnsafeMutableRawPointer(mutating: s)),
            SecKeychainAttribute(tag: SecItemAttr.accountItemAttr.rawValue, length: UInt32(account.utf8.count), data: UnsafeMutableRawPointer(mutating: a))]
        return attributes.withUnsafeMutableBufferPointer { buffer in
            var list = SecKeychainAttributeList(count: UInt32(buffer.count), attr: buffer.baseAddress)
            return data.withUnsafeBytes { bytes in
                SecKeychainItemCreateFromContent(SecItemClass.genericPasswordItemClass, &list,
                    UInt32(data.count), bytes.baseAddress, keychain, access, nil)
            }
        }
    } }
    check(status)
    print("created equivalent combined item trusting both test identities (simulated Always Allow)")
} else {
    guard args[1] == "create" else { die("unknown fixture action") }
    print("created disposable keychain")
}
