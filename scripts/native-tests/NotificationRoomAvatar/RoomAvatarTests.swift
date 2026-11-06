import XCTest
import Intents
import UserNotifications
@testable import AvatarLab

final class RoomAvatarTests: XCTestCase {
    // Accepted intent: attribute incoming room alerts to the room's bare identity,
    // show only its picture, and place the nickname before unchanged message text.
    // Real project images pass through the production mirror and native Intents.
    func testRoomAvatarAndRoomFirstText() throws {
        let names = try Fixture.prepare()
        let original = Fixture.original()
        let source = try XCTUnwrap(NotificationMirror.imageURL(for: Fixture.room, names: names))
        let bytes = try Data(contentsOf: source)
        let from = try XCTUnwrap(NotificationPresentation.sender(of: original.userInfo, names: names))
        let incoming = try XCTUnwrap(NotificationPresentation.incomingIntent(from: from, body: original.body, names: names),
                                    "Reported defect: a known room has no image-bearing incoming presentation")
        XCTAssertEqual(incoming.sender?.personHandle?.value, Fixture.room)
        XCTAssertEqual(incoming.sender?.displayName, names.rooms[Fixture.room])
        XCTAssertNotNil(incoming.sender?.image, "The room identity must carry its own cached image")
        XCTAssertNil(incoming.speakableGroupName, "Do not restore the occupant-first group presentation")
        XCTAssertEqual(incoming.conversationIdentifier,
                       ConversationDestination(account: Fixture.account, jid: Fixture.room, type: "groupchat").identifier)
        for _ in 0..<2 {
            let result = NotificationPresentation.content(for: original, names: names)
            XCTAssertEqual(result.title, incoming.sender?.displayName)
            XCTAssertTrue(result.subtitle.isEmpty, "The nickname appears once, in the first message line")
            XCTAssertEqual(result.body, incoming.content)
            XCTAssertEqual(result.threadIdentifier, original.threadIdentifier)
            XCTAssertTrue(NSDictionary(dictionary: result.userInfo).isEqual(to: original.userInfo))
            XCTAssertNotNil(result.sound)
            XCTAssertTrue(result.attachments.isEmpty, "The room picture is not a media attachment")
            XCTAssertEqual(try Data(contentsOf: source), bytes, "Presentation must preserve the mirrored room picture")
        }
        XCTAssertEqual(original.body, Fixture.body, "Do not mutate the incoming request")
        let direct = try XCTUnwrap(NotificationPresentation.incomingIntent(from: "seve@example.com", body: "Hello", names: names))
        XCTAssertNotNil(direct.sender?.image, "Direct-message communication images are unchanged")
        print("ROOM AVATAR: room identity owns the picture; room first; nickname once; cache and routing preserved")
    }

    func testNicknameStartsMessageWithoutChangingItsText() throws {
        let names = try Fixture.prepare()
        for nick in ["Seve", ""] {
            let original = Fixture.original()
            original.userInfo["muc_nick"] = nick
            let from = try XCTUnwrap(NotificationPresentation.sender(of: original.userInfo, names: names))
            let incoming = try XCTUnwrap(NotificationPresentation.incomingIntent(from: from, body: original.body, names: names))
            let expected = nick.isEmpty ? original.body : nick + "\n" + original.body
            XCTAssertEqual(incoming.content, expected)
        }
    }

    func testMissingAndCorruptRoomImageNeverUsesSenderImage() throws {
        var names = try Fixture.prepare()
        let source = try XCTUnwrap(NotificationMirror.imageURL(for: Fixture.room, names: names))
        // A distinct, valid contact image remains available in both adverse cases.
        names.avatars.removeValue(forKey: Fixture.room)
        let from = Fixture.room + "/Seve"
        let missing = try XCTUnwrap(NotificationPresentation.incomingIntent(from: from, body: Fixture.body, names: names))
        XCTAssertNil(missing.sender?.image)
        XCTAssertEqual(missing.sender?.personHandle?.value, Fixture.room)
        names = try Fixture.prepare()
        try Data("corrupt image".utf8).write(to: source)
        let corrupt = try XCTUnwrap(NotificationPresentation.incomingIntent(from: from, body: Fixture.body, names: names))
        XCTAssertNil(corrupt.sender?.image)
        XCTAssertEqual(corrupt.sender?.personHandle?.value, Fixture.room)
        let content = NotificationPresentation.content(for: Fixture.original(), names: names)
        XCTAssertEqual(content.title, names.rooms[Fixture.room])
        XCTAssertEqual(content.body, corrupt.content)
        XCTAssertTrue(content.subtitle.isEmpty)
        XCTAssertNotNil(NotificationPresentation.incomingIntent(from: "seve@example.com", body: "Hello", names: names)?.sender?.image,
                        "A valid occupant/contact picture must not replace the missing room picture")
        print("FALLBACKS: absent/corrupt room image retains room identity and room-first text without a contact-picture fallback")
    }
}
