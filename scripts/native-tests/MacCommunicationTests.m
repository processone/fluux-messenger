// Source intent: issue #1386, development-only local communication prototype.
#import "../../apps/fluux/src-tauri/macos/CommunicationNotification.h"
#import <AppKit/AppKit.h>

#define CHECK(value) do { if (!(value)) { NSLog(@"failed line %d: %s", __LINE__, #value); abort(); } } while (0)

static NSMutableDictionary *message(BOOL room, NSString *messageID) {
    NSDictionary *target = @{@"navType": room ? @"room" : @"conversation", @"navTarget": room ? @"team@conference.example.com" : @"alice@example.com",
        @"accountId": @"tester@example.com", @"messageId": messageID};
    NSMutableDictionary *p = target.mutableCopy;
    p[@"identifier"] = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:target options:NSJSONWritingSortedKeys error:nil] encoding:NSUTF8StringEncoding];
    p[@"target"] = target;
    p[@"title"] = room ? @"Alice @ Team" : @"Alice";
    p[@"body"] = @"See you at the meeting";
    p[@"communication"] = room ? @{@"senderId":@"Alice", @"senderName":@"Alice", @"roomName":@"Team", @"ownNick":@"Tester", @"participants":@[@"Alice", @"Tester", @"Bob"]} : @{@"senderId":@"alice@example.com", @"senderName":@"Alice"};
    return p;
}
static FluuxCommunicationNotifications *fixture(NSMutableArray *requests) {
    FluuxCommunicationNotifications *engine = [FluuxCommunicationNotifications new];
    engine.delivered = ^(void (^done)(NSArray *)) { done(@[]); };
    engine.donate = ^(INInteraction *interaction, void (^done)(NSError *)) {
        CHECK(interaction.direction == INInteractionDirectionIncoming);
        CHECK(interaction.groupIdentifier.length > 0);
        done(nil);
    };
    engine.transform = ^UNNotificationContent *(UNNotificationContent *c, INSendMessageIntent *i, NSError **e) { return c.copy; };
    engine.schedule = ^(UNNotificationRequest *r, void (^done)(NSError *)) { [requests addObject:r]; done(nil); };
    engine.deleteGroup = ^(NSString *g) {};
    engine.deleteInteraction = ^(NSString *identifier) {};
    return engine;
}
@interface DeliveredFixture : NSObject
@property UNNotificationRequest *request;
@end
@implementation DeliveredFixture
@end
@interface MemoryPreferences : NSUserDefaults
@property NSMutableDictionary *values;
@end
@implementation MemoryPreferences
- (NSDictionary *)dictionaryForKey:(NSString *)key { return self.values[key]; }
- (void)setObject:(id)value forKey:(NSString *)key { self.values[key] = [value copy]; }
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (@available(macOS 12.0, *)) {
            NSMutableArray *requests = [NSMutableArray array];
            FluuxCommunicationNotifications *engine = fixture(requests);
            // Captain's F5 choice: retransform current names after the existing donation, schedule once, preserve content/identity.
            for (NSNumber *isRoom in @[@NO, @YES]) {
                NSMutableArray *renamedRequests = [NSMutableArray array];
                FluuxCommunicationNotifications *renaming = fixture(renamedRequests);
                NSMutableArray<INInteraction *> *donations = [NSMutableArray array];
                NSMutableArray<INSendMessageIntent *> *providers = [NSMutableArray array];
                renaming.donate = ^(INInteraction *i, void (^done)(NSError *)) { [donations addObject:i]; done(nil); };
                renaming.transform = ^UNNotificationContent *(UNNotificationContent *c, INSendMessageIntent *i, NSError **e) {
                    [providers addObject:i]; return c.copy;
                };
                NSMutableDictionary *arrival = message(isRoom.boolValue, @"rename-current");
                NSString *token = [renaming prepare:arrival];
                NSDictionary *names = isRoom.boolValue ? @{@"title":@"Alice @ Projects", @"senderName":@"Alice", @"roomName":@"Projects"}
                    : @{@"title":@"Alicia", @"senderName":@"Alicia"};
                [renaming finish:token commit:YES names:names];
                [renaming finish:token commit:YES names:names];
                CHECK(renamedRequests.count == 1);
                CHECK(donations.count == 1 && providers.count == 2);
                CHECK([providers.lastObject.sender.displayName isEqual:names[@"senderName"]]);
                if (isRoom.boolValue) CHECK([providers.lastObject.speakableGroupName.spokenPhrase isEqual:@"Projects"]);
                UNNotificationRequest *shown = renamedRequests.firstObject;
                CHECK([shown.content.title isEqual:names[@"title"]]);
                CHECK([shown.content.body isEqual:arrival[@"body"]]);
                CHECK([shown.identifier isEqual:arrival[@"identifier"]]);
                CHECK([shown.content.userInfo isEqual:arrival[@"target"]]);
                // Read/account cleanup can still cancel during the refreshed transformation.
                NSMutableArray *cancelled = [NSMutableArray array];
                FluuxCommunicationNotifications *cancelling = fixture(cancelled);
                NSString *cancelToken = [cancelling prepare:arrival];
                cancelling.transform = ^UNNotificationContent *(UNNotificationContent *c, INSendMessageIntent *i, NSError **e) {
                    [cancelling cancelTarget:arrival]; return c.copy;
                };
                [cancelling finish:cancelToken commit:YES names:names];
                CHECK(cancelled.count == 0);
            }
            NSMutableDictionary *direct = message(NO, @"direct-1");
            INSendMessageIntent *intent = [engine intent:direct];
            CHECK(intent.content == nil);
            CHECK([intent.sender.displayName isEqual:@"Alice"]);
            CHECK(![intent.sender.personHandle.value containsString:@"example.com"]);
            NSMutableDictionary *other = direct.mutableCopy;
            other[@"accountId"] = @"second@example.com";
            CHECK(![[engine intent:other].conversationIdentifier isEqual:intent.conversationIdentifier]);
            CHECK(![[engine intent:other].sender.personHandle.value isEqual:intent.sender.personHandle.value]);
            NSMutableDictionary *room = message(YES, @"room-1");
            INSendMessageIntent *groupIntent = [engine intent:room];
            CHECK([groupIntent.speakableGroupName.spokenPhrase isEqual:@"Team"]);
            CHECK(groupIntent.sender.image == nil);
            CHECK(groupIntent.recipients.count == 1);
            CHECK([groupIntent.recipients.firstObject.displayName isEqual:@"Bob"]);
            // The same known occupant keeps one person handle when their nick or sender/recipient role changes.
            NSMutableDictionary *renamed = room.mutableCopy;
            renamed[@"communication"] = @{@"senderId":@"bob-occupant-id", @"senderNick":@"Robert", @"senderName":@"Robert", @"roomName":@"Team", @"ownNick":@"Tester",
                @"participants":@[@"Alice", @"Tester", @"Robert"], @"participantIds":@{@"Robert":@"bob-occupant-id", @"Alice":@"alice-occupant-id"}};
            NSMutableDictionary *beforeRename = room.mutableCopy;
            beforeRename[@"communication"] = @{@"senderId":@"alice-occupant-id", @"senderNick":@"Alice", @"senderName":@"Alice", @"roomName":@"Team", @"ownNick":@"Tester",
                @"participants":@[@"Alice", @"Tester", @"Bob"], @"participantIds":@{@"Bob":@"bob-occupant-id", @"Alice":@"alice-occupant-id"}};
            CHECK([[[engine intent:renamed].sender.personHandle value] isEqual:[engine intent:beforeRename].recipients.firstObject.personHandle.value]);
            NSMutableDictionary *unknown = room.mutableCopy;
            unknown[@"communication"] = @{@"senderId":@"Newcomer", @"senderName":@"Newcomer", @"roomName":@"Team", @"ownNick":@"Tester", @"participants":@[@"Tester"]};
            CHECK([engine intent:unknown] == nil);
            for (NSMutableDictionary *p in @[direct, room]) {
                NSString *token = [engine prepare:p];
                CHECK(token.length > 0);
                CHECK(requests.count == (p == direct ? 0 : 1)); // preparation never schedules
                CHECK([[engine prepare:p] isEqual:@""]); // concurrent/repeated reservation
                [engine finish:token commit:YES];
                [engine finish:token commit:YES];
                CHECK([[engine prepare:p] isEqual:@""]); // delivered identifier cannot alert again
                UNNotificationRequest *r = requests.lastObject;
                CHECK([r.content.body isEqual:p[@"body"]]);
                CHECK([r.content.userInfo isEqual:p[@"target"]]);
                CHECK(r.content.sound == nil);
            }
            CHECK(requests.count == 2);
            // Relaunch sees the delivered identifier and does not replace/re-alert it.
            DeliveredFixture *delivered = [DeliveredFixture new];
            delivered.request = requests.firstObject;
            engine = fixture(requests);
            engine.delivered = ^(void (^done)(NSArray *)) { done(@[delivered]); };
            CHECK([[engine prepare:direct] isEqual:@""]);
            // Simultaneous deliveries of the same message reserve exactly one token.
            engine = fixture(requests);
            NSUInteger concurrentBefore = requests.count;
            dispatch_apply(8, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^(size_t index) {
                NSString *t = [engine prepare:message(NO, @"simultaneous")];
                if (t.length) [engine finish:t commit:YES];
            });
            CHECK(requests.count == concurrentBefore + 1);
            // Captain's R4 choice: saturation falls back only for new identities, never for known duplicates.
            engine = fixture(requests);
            __block NSUInteger capacityAdds = 0;
            engine.schedule = ^(UNNotificationRequest *r, void (^done)(NSError *)) { capacityAdds++; done(nil); };
            for (NSUInteger index = 0; index < FluuxCommunicationPreparationLimit - 1; index++) {
                @autoreleasepool {
                    NSString *messageID = [NSString stringWithFormat:@"capacity-%lu", (unsigned long)index];
                    NSString *prepared = [engine prepare:message(NO, messageID)];
                    CHECK(prepared.length > 0);
                    [engine finish:prepared commit:YES];
                }
            }
            NSDictionary *lastCapacity = message(NO, @"capacity-last");
            NSString *lastCapacityToken = [engine prepare:lastCapacity];
            CHECK(lastCapacityToken.length > 0);
            CHECK([[engine prepare:lastCapacity] isEqual:@""]); // known pending, even at capacity
            CHECK([engine prepare:message(NO, @"capacity-new")] == nil);
            [engine finish:lastCapacityToken commit:YES];
            CHECK(capacityAdds == FluuxCommunicationPreparationLimit);
            CHECK([[engine prepare:message(NO, @"capacity-0")] isEqual:@""]); // known attempted
            CHECK([engine prepare:message(NO, @"capacity-new")] == nil);
            // Donation failure and transformation failure each choose the existing fallback before one add.
            for (NSNumber *failDonation in @[@YES, @NO]) {
                engine = fixture(requests);
                __block NSUInteger transformations = 0;
                engine.donate = ^(INInteraction *i, void (^done)(NSError *)) { done(failDonation.boolValue ? [NSError errorWithDomain:@"probe" code:1 userInfo:nil] : nil); };
                engine.transform = ^UNNotificationContent *(UNNotificationContent *c, INSendMessageIntent *i, NSError **e) { transformations++; *e = [NSError errorWithDomain:@"probe" code:2 userInfo:nil]; return nil; };
                NSUInteger before = requests.count;
                [engine finish:[engine prepare:message(NO, @"failed")] commit:YES];
                CHECK(requests.count == before + 1);
                CHECK(transformations == (failDonation.boolValue ? 0 : 1));
                CHECK([((UNNotificationRequest *)requests.lastObject).content.body isEqual:direct[@"body"]]);
            }
            // A schedule error is not proof of non-delivery: no retry or fallback resend.
            engine = fixture(requests);
            __block NSUInteger adds = 0;
            engine.schedule = ^(UNNotificationRequest *r, void (^done)(NSError *)) { adds++; done([NSError errorWithDomain:@"UNErrorDomain" code:104 userInfo:nil]); };
            NSString *token = [engine prepare:direct];
            [engine finish:token commit:YES];
            [engine finish:token commit:YES];
            CHECK(adds == 1);
            // Reading or changing accounts during donation must cancel the pending record.
            for (NSNumber *account in @[@YES, @NO]) {
                engine = fixture(requests);
                FluuxCommunicationNotifications *current = engine;
                engine.donate = ^(INInteraction *i, void (^done)(NSError *)) {
                    [current cancelTarget:account.boolValue ? @{@"accountId":@"tester@example.com"} : direct];
                    done(nil);
                };
                NSUInteger before = requests.count;
                [engine finish:[engine prepare:direct] commit:YES];
                CHECK(requests.count == before);
            }
            // Cancellation by the frontend also schedules nothing.
            engine = fixture(requests);
            NSUInteger before = requests.count;
            [engine finish:[engine prepare:direct] commit:NO];
            CHECK(requests.count == before);
            // Immutable provider result is forwarded unchanged, even if its concrete class is mutable.
            engine = fixture(requests);
            UNMutableNotificationContent *providerResult = [UNMutableNotificationContent new];
            providerResult.body = @"Provider result";
            engine.transform = ^UNNotificationContent *(UNNotificationContent *c, INSendMessageIntent *i, NSError **e) { return providerResult; };
            [engine finish:[engine prepare:direct] commit:YES];
            CHECK([((UNNotificationRequest *)requests.lastObject).content.body isEqual:@"Provider result"]);
            CHECK(providerResult.attachments.count == 0);
            // Missing/invalid avatars preserve the text; fallback never consumes the original file.
            NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
            [NSFileManager.defaultManager createDirectoryAtPath:root withIntermediateDirectories:YES attributes:nil error:nil];
            NSString *invalid = [root stringByAppendingPathComponent:@"invalid.png"];
            [@"not an image" writeToFile:invalid atomically:YES encoding:NSUTF8StringEncoding error:nil];
            for (NSString *path in @[[root stringByAppendingPathComponent:@"missing.png"], invalid]) {
                engine = fixture(requests);
                direct[@"avatarPath"] = path;
                CHECK([engine intent:direct].sender.image == nil);
                engine.donate = ^(INInteraction *i, void (^done)(NSError *)) { done([NSError errorWithDomain:@"probe" code:1 userInfo:nil]); };
                [engine finish:[engine prepare:direct] commit:YES];
                CHECK([((UNNotificationRequest *)requests.lastObject).content.body isEqual:direct[@"body"]]);
            }
            CHECK(argc > 1);
            NSString *avatar = [NSString stringWithUTF8String:argv[1]];
            direct[@"avatarPath"] = avatar;
            engine = fixture(requests);
            CHECK([engine intent:direct].sender.image != nil);
            room[@"avatarPath"] = avatar;
            CHECK([engine intent:room].sender.image == nil);
            engine.donate = ^(INInteraction *i, void (^done)(NSError *)) { done([NSError errorWithDomain:@"probe" code:1 userInfo:nil]); };
            __block NSUInteger copies = 0;
            engine.schedule = ^(UNNotificationRequest *r, void (^done)(NSError *)) {
                CHECK(r.content.attachments.count == 1);
                NSURL *copy = r.content.attachments.firstObject.URL;
                CHECK(![copy.path isEqual:avatar]);
                CHECK([[NSData dataWithContentsOfURL:copy] isEqual:[NSData dataWithContentsOfFile:avatar]]);
                // Model the system's transferable-file ownership without ever moving the cache source.
                [NSFileManager.defaultManager removeItemAtURL:copy error:nil];
                copies++;
                done(nil);
            };
            [engine finish:[engine prepare:direct] commit:YES];
            [engine finish:[engine prepare:message(NO, @"no-avatar")] commit:NO];
            CHECK(copies == 1);
            CHECK([NSFileManager.defaultManager fileExistsAtPath:avatar]);
            // Only this account's opaque donated groups are removed, including after engine recreation.
            MemoryPreferences *storage = [MemoryPreferences new];
            storage.values = [NSMutableDictionary dictionary];
            engine = fixture(requests);
            engine.storage = storage;
            [engine finish:[engine prepare:direct] commit:YES];
            engine = fixture(requests);
            engine.storage = storage;
            __block NSUInteger deletes = 0;
            engine.deleteGroup = ^(NSString *g) { deletes++; CHECK([g hasPrefix:@"fluux-prototype-"]); };
            [engine cancelTarget:@{@"accountId":@"other@example.com"}];
            CHECK(deletes == 0);
            [engine cancelTarget:@{@"accountId":@"tester@example.com"}];
            CHECK(deletes == 1);
            puts("Native API fixture: direct=Alice, group=Team, recipients=Bob; intent body=nil; handles account-scoped hashes");
            puts("Prepared request fixture: preview and account/message click target preserved; no OS sound; scheduling occurs only on commit");
            puts("Delivery fixtures: duplicate and concurrent replay suppressed; donation/transform failure selects one fallback; error 104 never resends");
            CHECK([NSFileManager.defaultManager fileExistsAtPath:invalid]);
            [NSFileManager.defaultManager removeItemAtPath:root error:nil];
            puts("#1386 native intent, fallback, one-add, duplicate, account/read and immutable-provider contracts passed");
        }
    }
}
