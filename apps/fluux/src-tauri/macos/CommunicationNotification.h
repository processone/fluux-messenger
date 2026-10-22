#import <Foundation/Foundation.h>
#import <Intents/Intents.h>
#import <UserNotifications/UserNotifications.h>

// Internal prototype seam: tests replace only OS side effects, not intent construction.
API_AVAILABLE(macos(12.0))
@interface FluuxCommunicationNotifications : NSObject
@property(copy) void (^donate)(INInteraction *, void (^)(NSError *));
@property(copy) UNNotificationContent * (^transform)(UNNotificationContent *, INSendMessageIntent *, NSError **);
@property(copy) void (^schedule)(UNNotificationRequest *, void (^)(NSError *));
@property(copy) void (^delivered)(void (^)(NSArray<UNNotification *> *));
@property(copy) void (^deleteGroup)(NSString *);
@property(copy) void (^deleteInteraction)(NSString *);
@property(nonatomic) NSUserDefaults *storage;
- (NSString *)prepare:(NSDictionary *)payload;
- (void)finish:(NSString *)token commit:(BOOL)commit;
- (void)cancelTarget:(NSDictionary *)target;
- (INSendMessageIntent *)intent:(NSDictionary *)payload;
@end

// NSString results follow the +1 ownership convention across the Rust boundary.
void *fluux_communication_prepare(const char *json);
void fluux_communication_finish(const char *token, bool commit);
void fluux_communication_cancel(const char *json);
