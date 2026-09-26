import Foundation
@main struct Check {
    static func main() {
        let url = URL(fileURLWithPath: "/tmp/space and ü.txt")
        precondition(sharedURL(url as NSURL) == url)
        precondition(sharedURL(url.dataRepresentation as NSData) == url)
        precondition(sharedURL(url.absoluteString as NSString) == url)
        precondition(sharedURL(NSNumber(value: 42)) == nil)
        let host = URL(fileURLWithPath: "/Applications/Fluux Messenger Dev.app", isDirectory: true)
        let nested = host.appendingPathComponent("Contents/PlugIns/FluuxShare.appex", isDirectory: true)
        precondition(containingApplication(for: nested)?.standardizedFileURL == host.standardizedFileURL)
        precondition(containingApplication(for: URL(fileURLWithPath: "/tmp/FluuxShare.appex")) == nil)
        print("Shared URL representations passed")
    }
}
