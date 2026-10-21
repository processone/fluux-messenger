import Foundation
import SQLite3

/// FLM-41: real app/extension lock contention must recover without weakening FLM-31's lifecycle regression.
@main struct DiagnosticContentionChecks {
    static let writerCount = 4
    static let entriesPerWriter = 50

    static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "DiagnosticContentionChecks", code: 1,
                                      userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func entry(version: String, correlation: UUID = UUID()) -> NotificationDiagnostic.Entry {
        .init(version: version, time: Date().timeIntervalSince1970, correlation: correlation,
              decision: .received, durationMs: nil)
    }
    static func main() throws {
        setbuf(stdout, nil)
        if CommandLine.arguments[1] == "writer" {
            let root = URL(fileURLWithPath: CommandLine.arguments[2])
            let marker = UUID(uuidString: CommandLine.arguments[3])!
            let version = CommandLine.arguments[4]
            let correlation = UUID()
            FileHandle.standardOutput.write(Data("ready\n".utf8))
            _ = FileHandle.standardInput.readData(ofLength: 1)
            for _ in 0..<entriesPerWriter {
                let store = try NotificationDiagnostic(root: root)
                let value = entry(version: version, correlation: correlation)
                try store.append(value, session: marker)
            }
            return
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let version = CommandLine.arguments[1]
        let store = try NotificationDiagnostic(root: root)
        try store.activate()
        let marker = try store.session()!
        var blocker: OpaquePointer?
        try require(sqlite3_open(root.appendingPathComponent("NotificationDiagnostic.sqlite").path, &blocker) == SQLITE_OK,
                    "open competing SQLite connection")
        defer { sqlite3_close(blocker) }
        func sql(_ text: String) throws {
            try require(sqlite3_exec(blocker, text, nil, nil, nil) == SQLITE_OK, "competing transaction: \(text)")
        }
        func exported() throws -> [[String: Any]] {
            try JSONSerialization.jsonObject(with: store.export()) as! [[String: Any]]
        }

        // Hold a real writer beyond the former allowance (some Apple SQLite versions overrun 150 ms).
        // This is an intentional lock duration, not a delay for asynchronous settling.
        try sql("BEGIN IMMEDIATE")
        let started = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
        var outcome: Result<Void, Error>?
        DispatchQueue.global().async {
            started.signal()
            outcome = Result {
                let value = entry(version: version)
                try store.append(value, session: marker)
            }
            finished.signal()
        }
        started.wait()
        let premature = finished.wait(timeout: .now() + .milliseconds(1250))
        try sql("COMMIT")
        if premature == .timedOut { finished.wait() }
        print("Held writer for 1250 ms; blocked append result: \(String(describing: outcome))")
        try require(premature == .timedOut, "append exhausted its lock allowance before the competing writer finished")
        try outcome!.get()
        try require(exported().count == 1, "released writer must persist exactly one diagnostic entry")

        // A sustained lock must still fail closed, leave committed entries intact and release its transaction.
        try sql("BEGIN IMMEDIATE")
        let began = ProcessInfo.processInfo.systemUptime
        var unavailable = false
        do { try store.append(entry(version: version), session: marker) }
        catch NotificationDiagnostic.Failure.unavailable { unavailable = true }
        let elapsed = ProcessInfo.processInfo.systemUptime - began
        try sql("COMMIT")
        try require(unavailable, "sustained contention must remain a recoverable storage failure")
        try require(elapsed < 15, "diagnostic lock wait must remain bounded")
        try require(exported().count == 1, "failed acquisition must not alter committed diagnostics")
        try store.append(entry(version: version), session: marker)
        try require(exported().count == 2, "same connection must recover after contention")
        print("Sustained lock returned unavailable after \(elapsed) seconds; committed entries survived and the connection recovered")

        try store.reset(active: true)
        let next = try store.session()!
        var children: [(Process, Pipe)] = []
        for _ in 0..<writerCount {
            let process = Process(), input = Pipe(), output = Pipe()
            process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            process.arguments = ["writer", root.path, next.uuidString, version]
            process.standardInput = input
            process.standardOutput = output
            try process.run()
            let ready = output.fileHandleForReading.readData(ofLength: 6)
            try require(ready == Data("ready\n".utf8), "child writer must reach the shared start gate")
            children.append((process, input))
        }
        for (_, input) in children { input.fileHandleForWriting.write(Data([1])); try input.fileHandleForWriting.close() }
        for (process, _) in children {
            process.waitUntilExit()
            try require(process.terminationStatus == 0, "concurrent app/extension writer must finish without a trap")
        }
        let entries = try exported()
        let runs = Dictionary(grouping: entries, by: { $0["correlation"] as! String })
        print("Exported \(entries.count) entries across \(runs.count) processing markers: \(runs.values.map { $0.count }.sorted())")
        try require(entries.count == writerCount * entriesPerWriter && runs.count == writerCount &&
                    runs.values.allSatisfy { $0.count == entriesPerWriter },
                    "all four processes must persist their 50 diagnostic entries")
        print("\(writerCount) processes exported \(entries.count) entries: \(entriesPerWriter) per random processing marker")
        print(String(data: try store.export(), encoding: .utf8)!)
        try store.reset(active: false)
        try store.append(entry(version: version), session: next)
        try require(exported().isEmpty && store.session() == nil, "logout must reject late work after concurrent writes")
        print("FLM-41 contention recovery, bounded failure, cross-process writes and logout passed")
    }
}
