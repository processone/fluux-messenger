#import "CommunicationNotification.h"
#import <AppKit/AppKit.h>
#import <CommonCrypto/CommonDigest.h>

static NSString *opaque(NSArray *parts) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:parts options:0 error:nil];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *result = [NSMutableString stringWithString:@"fluux-prototype-"];
    for (NSUInteger i = 0; i < sizeof(digest); i++) [result appendFormat:@"%02x", digest[i]];
    return result;
}
static NSString *group(NSDictionary *p) {
    return opaque(@[p[@"accountId"] ?: @"", p[@"navType"] ?: @"", p[@"navTarget"] ?: @""]);
}
static NSString *text(id value) { return [value isKindOfClass:NSString.class] ? value : @""; }
static INImage *image(NSString *path) API_AVAILABLE(macos(12.0));
static INImage *image(NSString *path) {
    if (!path.length) return nil;
    NSData *data = [NSData dataWithContentsOfFile:path];
    // Reject invalid files before giving them to Intents. No attachment file is transferred here.
    return data && [[NSImage alloc] initWithData:data] ? [INImage imageWithImageData:data] : nil;
}

API_AVAILABLE(macos(12.0))
@interface FluuxCommunicationRecord : NSObject
@property NSDictionary *payload;
@property UNNotificationContent *content;
@property NSString *identifier;
@property NSString *interactionID;
@property NSDate *created;
@property BOOL cancelled;
@property BOOL enriched;
@end
@implementation FluuxCommunicationRecord
@end

@implementation FluuxCommunicationNotifications {
    NSMutableDictionary<NSString *, FluuxCommunicationRecord *> *_pending;
    NSMutableSet<NSString *> *_attempted;
    NSMutableDictionary<NSString *, NSArray<NSString *> *> *_donationGroups;
}
- (instancetype)init {
    if ((self = [super init])) {
        _pending = [NSMutableDictionary dictionary];
        _attempted = [NSMutableSet set];
        _donationGroups = [NSMutableDictionary dictionary];
        self.donate = ^(INInteraction *i, void (^done)(NSError *)) { [i donateInteractionWithCompletion:done]; };
        self.transform = ^(UNNotificationContent *c, INSendMessageIntent *i, NSError **e) {
            return [c contentByUpdatingWithProvider:i error:e];
        };
        self.schedule = ^(UNNotificationRequest *r, void (^done)(NSError *)) {
            [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:r withCompletionHandler:done];
        };
        self.delivered = ^(void (^done)(NSArray<UNNotification *> *)) {
            [UNUserNotificationCenter.currentNotificationCenter getDeliveredNotificationsWithCompletionHandler:done];
        };
        self.deleteGroup = ^(NSString *g) { [INInteraction deleteInteractionsWithGroupIdentifier:g completion:nil]; };
        self.deleteInteraction = ^(NSString *identifier) { [INInteraction deleteInteractionsWithIdentifiers:@[identifier] completion:nil]; };
    }
    return self;
}
- (void)setStorage:(NSUserDefaults *)storage {
    @synchronized(self) {
        _storage = storage;
        _donationGroups = [[storage dictionaryForKey:@"FluuxCommunicationPrototypeGroups"] mutableCopy] ?: [NSMutableDictionary dictionary];
    }
}
- (void)rememberGroup:(NSDictionary *)p {
    @synchronized(self) {
        NSString *account = opaque(@[p[@"accountId"] ?: @""]);
        NSMutableSet *groups = [NSMutableSet setWithArray:_donationGroups[account] ?: @[]];
        [groups addObject:group(p)];
        _donationGroups[account] = groups.allObjects;
        [self.storage setObject:_donationGroups forKey:@"FluuxCommunicationPrototypeGroups"];
    }
}
- (INSendMessageIntent *)intent:(NSDictionary *)p {
    NSDictionary *metadata = p[@"communication"];
    if (![metadata isKindOfClass:NSDictionary.class]) return nil;
    NSString *account = text(p[@"accountId"]), *destination = text(p[@"navTarget"]);
    NSString *senderID = text(metadata[@"senderId"]), *senderName = text(metadata[@"senderName"]);
    if (!account.length || !destination.length || !senderID.length || !senderName.length) return nil;
    BOOL room = [p[@"navType"] isEqual:@"room"];
    NSMutableArray *recipients = nil;
    if (room) {
        NSArray *participants = metadata[@"participants"];
        NSString *own = text(metadata[@"ownNick"]);
        NSString *senderNick = text(metadata[@"senderNick"]);
        if (!senderNick.length) senderNick = senderID;
        NSDictionary *participantIDs = metadata[@"participantIds"];
        if (![participantIDs isKindOfClass:NSDictionary.class]) participantIDs = @{};
        if (![participants isKindOfClass:NSArray.class] || !own.length ||
            ![participants containsObject:own] || ![participants containsObject:senderNick] ||
            !text(metadata[@"roomName"]).length) return nil;
        recipients = [NSMutableArray array];
        for (NSString *nick in participants) {
            if (![nick isKindOfClass:NSString.class] || !nick.length) return nil;
            if ([nick isEqual:senderNick] || [nick isEqual:own]) continue;
            NSString *participantID = text(participantIDs[nick]);
            NSString *handle = opaque(@[account, destination, @"occupant", participantID.length ? participantID : nick]);
            [recipients addObject:[[INPerson alloc] initWithPersonHandle:[[INPersonHandle alloc] initWithValue:handle type:INPersonHandleTypeUnknown]
                nameComponents:nil displayName:nick image:nil contactIdentifier:nil customIdentifier:handle]];
        }
    }
    NSString *handle = opaque(room ? @[account, destination, @"occupant", senderID] : @[account, @"contact", senderID]);
    INPerson *sender = [[INPerson alloc] initWithPersonHandle:[[INPersonHandle alloc] initWithValue:handle type:INPersonHandleTypeUnknown]
        nameComponents:nil displayName:senderName image:room ? nil : image(text(p[@"avatarPath"])) contactIdentifier:nil customIdentifier:handle];
    INSendMessageIntent *intent = [[INSendMessageIntent alloc] initWithRecipients:recipients outgoingMessageType:INOutgoingMessageTypeOutgoingMessageText
        content:nil speakableGroupName:room ? [[INSpeakableString alloc] initWithSpokenPhrase:metadata[@"roomName"]] : nil
        conversationIdentifier:group(p) serviceName:nil sender:sender attachments:nil];
    if (room) {
        INImage *avatar = image(text(p[@"avatarPath"]));
        if (avatar) [intent setImage:avatar forParameterNamed:@"speakableGroupName"];
    }
    return intent;
}
- (NSString *)prepare:(NSDictionary *)p {
    NSString *identifier = text(p[@"identifier"]);
    if (!identifier.length) return @"";
    FluuxCommunicationRecord *record = [FluuxCommunicationRecord new];
    record.payload = p;
    record.identifier = identifier;
    record.created = NSDate.date;
    NSString *token = NSUUID.UUID.UUIDString;
    @synchronized(self) {
        // Bound identity history without evicting known duplicates; new messages fall back at capacity.
        for (NSString *key in _pending.allKeys) {
            FluuxCommunicationRecord *old = _pending[key];
            if ([old.created timeIntervalSinceNow] < -30) {
                old.cancelled = YES;
                [_pending removeObjectForKey:key];
                if (old.interactionID) self.deleteInteraction(old.interactionID);
            }
        }
        if ([_attempted containsObject:identifier]) return @"";
        for (FluuxCommunicationRecord *old in _pending.allValues) if ([old.identifier isEqual:identifier]) return @"";
        if (_attempted.count + _pending.count >= FluuxCommunicationPreparationLimit) return nil;
        _pending[token] = record;
    }
    // Do not replace a notification already delivered before this process started.
    dispatch_semaphore_t lookup = dispatch_semaphore_create(0);
    __block BOOL duplicate = NO;
    self.delivered(^(NSArray<UNNotification *> *notifications) {
        for (UNNotification *n in notifications) if ([n.request.identifier isEqual:identifier]) duplicate = YES;
        dispatch_semaphore_signal(lookup);
    });
    if (dispatch_semaphore_wait(lookup, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) || duplicate) {
        [self finish:token commit:NO];
        return @"";
    }
    @synchronized(self) { if (record.cancelled) return @""; }
    UNMutableNotificationContent *base = [UNMutableNotificationContent new];
    base.title = text(p[@"title"]);
    base.body = text(p[@"body"]);
    base.threadIdentifier = group(p);
    base.userInfo = p[@"target"] ?: @{};
    // macOS's existing path has no OS sound; the frontend owns its sound preference.
    base.sound = nil;
    record.content = base;
    INSendMessageIntent *intent = [self intent:p];
    if (intent) {
        INInteraction *interaction = [[INInteraction alloc] initWithIntent:intent response:nil];
        interaction.direction = INInteractionDirectionIncoming;
        interaction.identifier = opaque(@[identifier]);
        record.interactionID = interaction.identifier;
        interaction.groupIdentifier = group(p);
        dispatch_semaphore_t donated = dispatch_semaphore_create(0);
        __block BOOL accepted = NO;
        @synchronized(self) {
            if (record.cancelled) return @"";
            [self rememberGroup:p];
            self.donate(interaction, ^(NSError *error) {
                @synchronized(self) {
                    accepted = error == nil;
                    if (record.cancelled) self.deleteInteraction(interaction.identifier);
                }
                dispatch_semaphore_signal(donated);
            });
        }
        if (!dispatch_semaphore_wait(donated, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) && accepted) {
            NSError *error = nil;
            UNNotificationContent *updated = self.transform(base, intent, &error);
            if (updated && !error) { record.content = updated; record.enriched = YES; } // Never mutate Apple's result.
        }
    }
    return token;
}
- (void)finish:(NSString *)token commit:(BOOL)commit {
    @synchronized(self) {
        FluuxCommunicationRecord *record = _pending[token];
        if (!record) return;
        [_pending removeObjectForKey:token];
        if (!commit || record.cancelled || [record.created timeIntervalSinceNow] < -30) {
            record.cancelled = YES;
            if (record.interactionID) self.deleteInteraction(record.interactionID);
            return;
        }
        [_attempted addObject:record.identifier];
        UNNotificationContent *content = record.content;
        __block NSURL *directory = nil;
        // Only the untransformed fallback gets an attachment, on an independent transferable file.
        if (!record.enriched) {
            NSString *path = text(record.payload[@"avatarPath"]);
            if (path.length) {
                directory = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString] isDirectory:YES];
                NSFileManager *files = NSFileManager.defaultManager;
                if ([files createDirectoryAtURL:directory withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:nil]) {
                    NSURL *copy = [directory URLByAppendingPathComponent:path.lastPathComponent];
                    if ([files copyItemAtPath:path toPath:copy.path error:nil]) {
                        UNNotificationAttachment *attachment = [UNNotificationAttachment attachmentWithIdentifier:@"avatar" URL:copy options:nil error:nil];
                        if (attachment) ((UNMutableNotificationContent *)content).attachments = @[attachment];
                    }
                }
            }
        }
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:record.identifier content:content trigger:nil];
        self.schedule(request, ^(NSError *error) {
            if (directory) [NSFileManager.defaultManager removeItemAtURL:directory error:nil];
            // Even an attachment-import error may accompany delivery. Never resend.
            if (error) NSLog(@"Fluux prototype notification scheduling reported an error (%ld)", (long)error.code);
        });
    }
}
- (void)cancelTarget:(NSDictionary *)target {
    @synchronized(self) {
        for (NSString *token in _pending.allKeys) {
            FluuxCommunicationRecord *r = _pending[token];
            BOOL account = [r.payload[@"accountId"] isEqual:target[@"accountId"]];
            if (account && (!target[@"navTarget"] || [group(r.payload) isEqual:group(target)])) {
                r.cancelled = YES;
                [_pending removeObjectForKey:token];
            }
        }
        if (target[@"navTarget"]) self.deleteGroup(group(target));
        // Persisted opaque group IDs let account cleanup find this prototype's donations after restart.
        if (!target[@"navTarget"]) {
            NSString *account = opaque(@[target[@"accountId"] ?: @""]);
            for (NSString *g in _donationGroups[account]) self.deleteGroup(g);
            // Retain the small registry: deletion is asynchronous and may fail; a later cleanup can retry.
        }
    }
}
@end

static FluuxCommunicationNotifications *engine(void) API_AVAILABLE(macos(12.0));
static FluuxCommunicationNotifications *engine(void) {
    static FluuxCommunicationNotifications *instance;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ instance = [FluuxCommunicationNotifications new]; instance.storage = NSUserDefaults.standardUserDefaults; });
    return instance;
}
static NSDictionary *payload(const char *json) {
    return [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
}
static BOOL enabled(void) {
    NSBundle *bundle = NSBundle.mainBundle;
    return [bundle.bundleIdentifier isEqual:@"net.processone.fluux.communication-prototype"] &&
        [bundle.infoDictionary[@"FluuxCommunicationPrototype"] boolValue];
}
void *fluux_communication_prepare(const char *json) {
    @autoreleasepool {
        if (@available(macOS 12.0, *)) {
            if (!enabled()) return NULL;
            return (__bridge_retained void *)[engine() prepare:payload(json)];
        }
        return NULL;
    }
}
void fluux_communication_finish(const char *token, bool commit) {
    @autoreleasepool { if (@available(macOS 12.0, *)) if (enabled()) [engine() finish:[NSString stringWithUTF8String:token] commit:commit]; }
}
void fluux_communication_cancel(const char *json) {
    @autoreleasepool { if (@available(macOS 12.0, *)) if (enabled()) [engine() cancelTarget:payload(json)]; }
}
