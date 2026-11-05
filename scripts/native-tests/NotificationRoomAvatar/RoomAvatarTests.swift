import XCTest
import Intents
import UserNotifications
@testable import AvatarLab

final class RoomAvatarTests: XCTestCase {
    // Regression source: room notifications must keep room-before-nickname text and
    // the room's own image, with no sender-image or sender-first fallback.
    // Real project image bytes pass through the production mirror and system attachment API.
    func testRoomAvatarAndRoomFirstText() throws {
        let names = try Fixture.prepare()
        let original = Fixture.original()
        let source = try XCTUnwrap(NotificationMirror.imageURL(for: Fixture.room, names: names))
        let bytes = try Data(contentsOf: source)
        for _ in 0..<2 {
            let result = NotificationPresentation.content(for: original, names: names)
            XCTAssertEqual(result.title, "XSF")
            XCTAssertEqual(result.subtitle, "Seve")
            XCTAssertEqual(result.body, original.body)
            XCTAssertEqual(result.threadIdentifier, original.threadIdentifier)
            XCTAssertEqual(result.userInfo["from"] as? String, Fixture.room)
            XCTAssertNotNil(result.sound)
            let image = try XCTUnwrap(result.attachments.first, "Reported defect: ordinary room alert drops the valid room avatar")
            _ = image.url.startAccessingSecurityScopedResource()
            defer { image.url.stopAccessingSecurityScopedResource() }
            XCTAssertEqual(try Data(contentsOf: image.url), bytes)
            XCTAssertEqual(try Data(contentsOf: source), bytes, "Attachment creation must not consume the cached avatar")
        }
        XCTAssertTrue(original.attachments.isEmpty, "Do not mutate the incoming request")
        XCTAssertNil(NotificationPresentation.incomingIntent(from: Fixture.room + "/Seve", body: Fixture.body, names: names),
                     "Do not restore the sender-first communication path")
        let direct = try XCTUnwrap(NotificationPresentation.incomingIntent(from: "seve@example.com", body: "Hello", names: names))
        XCTAssertNotNil(direct.sender?.image, "Direct-message communication images are unchanged")
        print("ROOM AVATAR: system attachment matches cached room bytes; title=XSF; subtitle=Seve; cached image survives repeated delivery")
    }

    func testMissingAndCorruptRoomImageNeverUsesSenderImage() throws {
        var names = try Fixture.prepare()
        let source = try XCTUnwrap(NotificationMirror.imageURL(for: Fixture.room, names: names))
        // A valid contact image remains available when the room image is absent.
        names.avatars.removeValue(forKey: Fixture.room)
        let missing = NotificationPresentation.content(for: Fixture.original(), names: names)
        XCTAssertTrue(missing.attachments.isEmpty)
        XCTAssertEqual(missing.title, "XSF")
        XCTAssertEqual(missing.subtitle, "Seve")
        names = try Fixture.prepare()
        try Data("corrupt image".utf8).write(to: source)
        let corrupt = NotificationPresentation.content(for: Fixture.original(), names: names)
        XCTAssertTrue(corrupt.attachments.isEmpty)
        XCTAssertEqual(corrupt.title, "XSF")
        XCTAssertEqual(corrupt.subtitle, "Seve")
        XCTAssertNotNil(NotificationPresentation.incomingIntent(from: "seve@example.com", body: "Hello", names: names)?.sender?.image,
                        "The sender image is still valid while the room image is corrupt")
        print("FALLBACKS: missing/corrupt room image keeps room-first text without substituting a contact image")
    }
}
