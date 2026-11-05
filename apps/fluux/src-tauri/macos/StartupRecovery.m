#import "StartupRecovery.h"
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <stdio.h>
#include <stdlib.h>

// C event numbers are mirrored by startup_recovery/macos.rs.
enum { Tick = 1, SampleResult = 2, SampleTimeout = 3, Restart = 4, Copy = 5, Quit = 6, EligibilityChanged = 7 };

uint32_t fluux_startup_eligibility_failures(bool hidden, bool visible, bool miniaturized, bool occluded, bool asleep, bool locked) {
    return (hidden ? 1 : 0) | (miniaturized ? 2 : 0) | (occluded ? 4 : 0)
        | (asleep ? 8 : 0) | (locked ? 16 : 0) | (!visible ? 32 : 0);
}

void fluux_startup_request_clock_advance(FluuxStartupRequestClock *clock, double now, bool eligible) {
    if (clock->eligible && eligible) clock->elapsed += MAX(0, now - clock->last_tick);
    clock->last_tick = now;
    clock->eligible = eligible;
}
uint32_t fluux_startup_pattern_rgb(uint64_t generation, uint64_t sequence) {
    // Moderate sRGB colors; distinct cycles avoid quickly repeating the tuple.
    uint32_t red = 100 + (generation * 17 + sequence * 13) % 61;
    uint32_t green = 100 + (generation * 29 + sequence * 23) % 59;
    uint32_t blue = 100 + (generation * 37 + sequence * 31) % 53;
    return red << 16 | green << 8 | blue;
}
// Read the NSImage's actual CGImage, not a TIFF decoded with an inferred
// Generic RGB label. Device RGB has no profile: preserve its component bytes
// by assigning sRGB before drawing; tagged images undergo the proper conversion.
int fluux_startup_compare_snapshot(void *snapshot, uint32_t expected, uint32_t *observed, char *spaceName, size_t capacity) {
    *observed = UINT32_MAX;
    if (capacity) snprintf(spaceName, capacity, "unavailable");
    NSImage *image = (__bridge NSImage *)snapshot;
    if (!image) return 2;
    NSRect proposed = NSMakeRect(0, 0, image.size.width, image.size.height);
    CGImageRef source = [image CGImageForProposedRect:&proposed context:nil hints:nil];
    if (!source || !CGImageGetWidth(source) || !CGImageGetHeight(source)) return 2;
    CGColorSpaceRef sourceSpace = CGImageGetColorSpace(source);
    CGColorSpaceRef device = CGColorSpaceCreateDeviceRGB();
    BOOL deviceRGB = sourceSpace && CFEqual(sourceSpace, device);
    CGColorSpaceRelease(device);
    NSString *name = sourceSpace ? CFBridgingRelease(CGColorSpaceCopyName(sourceSpace)) : nil;
    if (!name) name = deviceRGB ? @"Device RGB (raw components)" : @"unnamed color space";
    if (capacity) snprintf(spaceName, capacity, "%s", name.UTF8String);
    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGImageRef center = CGImageCreateWithImageInRect(source, CGRectMake(CGImageGetWidth(source) / 2, CGImageGetHeight(source) / 2, 1, 1));
    if (!center || !srgb) { if (center) CGImageRelease(center); if (srgb) CGColorSpaceRelease(srgb); return 2; }
    if (deviceRGB) {
        CGImageRef raw = CGImageCreateCopyWithColorSpace(center, srgb);
        CGImageRelease(center);
        center = raw;
    }
    uint8_t rgba[4] = {0};
    CGContextRef context = CGBitmapContextCreate(rgba, 1, 1, 8, sizeof(rgba), srgb,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(srgb);
    if (!center || !context) { if (center) CGImageRelease(center); if (context) CGContextRelease(context); return 2; }
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextSetInterpolationQuality(context, kCGInterpolationNone);
    CGContextDrawImage(context, CGRectMake(0, 0, 1, 1), center);
    CGContextRelease(context);
    CGImageRelease(center);
    // The injected pattern is opaque. Do not accept an unpainted/alpha pixel.
    if (rgba[3] != 255) return 2;
    *observed = (uint32_t)rgba[0] << 16 | (uint32_t)rgba[1] << 8 | rgba[2];
    return abs(rgba[0] - (int)((expected >> 16) & 255)) < 5
        && abs(rgba[1] - (int)((expected >> 8) & 255)) < 5
        && abs(rgba[2] - (int)(expected & 255)) < 5 ? 0 : 1;
}

@interface FluuxStartupCover : NSView
@property(nonatomic) BOOL recoveryControlsVisible;
@end
@implementation FluuxStartupCover
- (BOOL)acceptsFirstResponder { return YES; }
- (void)keyDown:(NSEvent *)event {
    if (self.recoveryControlsVisible) [super keyDown:event];
    // During startup, never forward typing to WebKit.
}
- (void)mouseDown:(NSEvent *)event { [self.window makeFirstResponder:self]; }
- (BOOL)isOpaque { return NO; }
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirtyRect {
    [[NSColor windowBackgroundColor] setFill];
    NSRectFill(dirtyRect);
}
@end

// Both asynchronous stages use the same identity boundary before reading or
// writing adapter state now owned by the new document.
bool fluux_startup_request_matches(bool pending, uint64_t active_generation, uint64_t active_sequence, uint64_t generation, uint64_t sequence) {
    return pending && active_generation == generation && active_sequence == sequence;
}

@interface FluuxStartupAdapter : NSObject
@property(nonatomic, strong) WKWebView *web;
@property(nonatomic, strong) FluuxStartupCover *cover;
@property(nonatomic, strong) NSTextField *title;
@property(nonatomic, strong) NSStackView *buttons;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, strong) NSMutableArray *observers;
@property(nonatomic) FluuxStartupEvent callback;
@property(nonatomic) BOOL eligibilityKnown;
@property(nonatomic) uint32_t eligibilityFailures;
@property(nonatomic) BOOL sleeping;
@property(nonatomic) BOOL locked;
@property(nonatomic) BOOL stopped;
@property(nonatomic) BOOL requestPending;
@property(nonatomic) BOOL requestExpired;
@property(nonatomic) uint64_t requestGeneration;
@property(nonatomic) uint64_t requestSequence;
@property(nonatomic) FluuxStartupRequestClock requestClock;
@property(nonatomic) BOOL credentialWaiting;
@property(nonatomic) BOOL reloaded;
@property(nonatomic) uint32_t expectedRGB;
@property(nonatomic) uint32_t observedRGB;
@property(nonatomic, copy) NSString *snapshotColorSpace;
- (uint32_t)currentEligibilityFailures;
@end

@implementation FluuxStartupAdapter
- (void)send:(int)event generation:(uint64_t)generation sample:(uint64_t)sample value:(int)value {
    if (!self.stopped && self.callback) self.callback(event, generation, sample, value, 0);
}
- (BOOL)eligible {
    return [self currentEligibilityFailures] == 0;
}
- (uint32_t)currentEligibilityFailures {
    NSWindow *window = self.web.window;
    return fluux_startup_eligibility_failures(NSApp.hidden, window.visible, window.miniaturized,
        (window.occlusionState & NSWindowOcclusionStateVisible) == 0, self.sleeping, self.locked);
}
- (void)tick {
    if (!self.buttons.hidden) { /* Native recovery buttons keep keyboard focus. */ }
    else if (self.web.window.firstResponder != self.cover) [self.web.window makeFirstResponder:self.cover];
    uint32_t failures = [self currentEligibilityFailures];
    if (!self.eligibilityKnown || failures != self.eligibilityFailures) {
        self.eligibilityKnown = YES;
        self.eligibilityFailures = failures;
        [self send:EligibilityChanged generation:0 sample:0 value:(int)failures];
    }
    [self send:Tick generation:0 sample:0 value:failures == 0];
    if (self.requestPending && !self.requestExpired) {
        BOOL eligible = [self eligible] && !self.credentialWaiting;
        fluux_startup_request_clock_advance(&_requestClock, NSProcessInfo.processInfo.systemUptime, eligible);
        if (eligible && _requestClock.elapsed >= 3) {
            self.requestExpired = YES;
            [self send:SampleTimeout generation:self.requestGeneration sample:self.requestSequence value:0];
        }
    }
}
- (void)observe:(NSNotificationName)name center:(NSNotificationCenter *)center change:(void (^)(void))change {
    __weak FluuxStartupAdapter *weak = self;
    id observer = [center addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
        FluuxStartupAdapter *self = weak;
        if (!self || self.stopped) return;
        change();
        [self tick];
    }];
    [self.observers addObject:@[center, observer]];
}
- (instancetype)initWithWebview:(WKWebView *)web callback:(FluuxStartupEvent)callback {
    self = [super init];
    if (!self) return nil;
    self.web = web;
    self.callback = callback;
    self.observers = [NSMutableArray array];
    // This is an AppKit sibling of WebKit, not HTML. It intercepts interaction
    // until qualification completes, and remains usable if WebKit stops drawing.
    NSView *parent = web.superview;
    self.cover = [[FluuxStartupCover alloc] initWithFrame:web.frame];
    self.cover.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [parent addSubview:self.cover positioned:NSWindowAbove relativeTo:web];
    [web.window makeFirstResponder:self.cover];
    self.title = [NSTextField labelWithString:@"Starting Fluux…"];
    self.title.font = [NSFont systemFontOfSize:18];
    NSButton *restart = [NSButton buttonWithTitle:@"Restart Fluux" target:self action:@selector(restart:)];
    NSButton *copy = [NSButton buttonWithTitle:@"Copy diagnostics" target:self action:@selector(copy:)];
    NSButton *quit = [NSButton buttonWithTitle:@"Quit" target:self action:@selector(quit:)];
    self.buttons = [NSStackView stackViewWithViews:@[restart, copy, quit]];
    self.buttons.orientation = NSUserInterfaceLayoutOrientationVertical;
    self.buttons.spacing = 12;
    self.buttons.hidden = YES;
    NSStackView *stack = [NSStackView stackViewWithViews:@[self.title, self.buttons]];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.spacing = 24;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    [self.cover addSubview:stack];
    [NSLayoutConstraint activateConstraints:@[
        [stack.centerXAnchor constraintEqualToAnchor:self.cover.centerXAnchor],
        [stack.centerYAnchor constraintEqualToAnchor:self.cover.centerYAnchor]
    ]];
    __weak FluuxStartupAdapter *weak = self;
    NSNotificationCenter *workspace = NSWorkspace.sharedWorkspace.notificationCenter;
    [self observe:NSWorkspaceWillSleepNotification center:workspace change:^{ weak.sleeping = YES; }];
    [self observe:NSWorkspaceDidWakeNotification center:workspace change:^{ weak.sleeping = NO; }];
    // NSWorkspace session notifications are public; no private lock APIs.
    [self observe:NSWorkspaceSessionDidResignActiveNotification center:workspace change:^{ weak.locked = YES; }];
    [self observe:NSWorkspaceSessionDidBecomeActiveNotification center:workspace change:^{ weak.locked = NO; }];
    for (NSNotificationName name in @[NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification,
            NSWindowDidChangeOcclusionStateNotification, NSApplicationDidHideNotification, NSApplicationDidUnhideNotification]) {
        [self observe:name center:NSNotificationCenter.defaultCenter change:^{}];
    }
    self.timer = [NSTimer timerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) { [weak tick]; }];
    [NSRunLoop.mainRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];
    return self;
}
- (void)stopSampling {
    [self.timer invalidate];
    self.timer = nil;
    for (NSArray *pair in self.observers) [(NSNotificationCenter *)pair[0] removeObserver:pair[1]];
    [self.observers removeAllObjects];
}
- (void)present:(int)state {
    if (state == 0) {
        // Do not wait for JavaScript to remove the native cover.
        [self stopSampling];
        self.stopped = YES;
        [self.cover removeFromSuperview];
        [self.web.window makeFirstResponder:self.web];
        [self.web evaluateJavaScript:@"document.getElementById('__fluuxStartupSample')?.remove()" completionHandler:nil];
    } else if (state == 1) {
        self.credentialWaiting = NO;
        self.title.stringValue = @"Trying to recover…";
    } else if (state == 4) {
        self.credentialWaiting = YES;
        self.title.stringValue = @"Waiting for credential access…";
    } else if (state == 5) {
        self.credentialWaiting = NO;
        self.title.stringValue = @"Starting Fluux…";
    } else {
        [self stopSampling];
        self.title.stringValue = @"Fluux cannot display";
        self.buttons.hidden = NO;
        self.cover.recoveryControlsVisible = YES;
        // Keep the cover opaque and the buttons native. No more auto attempts.
    }
}
- (void)restart:(id)sender { [self send:Restart generation:0 sample:0 value:0]; }
- (void)copy:(id)sender { [self send:Copy generation:0 sample:0 value:0]; }
- (void)quit:(id)sender { [self send:Quit generation:0 sample:0 value:0]; }
- (void)sample:(uint64_t)generation sequence:(uint64_t)sequence {
    if (self.stopped || self.requestPending || ![self eligible]) return;
    self.requestPending = YES;
    self.requestExpired = NO;
    self.requestGeneration = generation;
    self.requestSequence = sequence;
    _requestClock = (FluuxStartupRequestClock){ .last_tick = NSProcessInfo.processInfo.systemUptime, .eligible = true };
    // Sample only known pixels, never messages. Completion alone is not a pass.
    self.expectedRGB = fluux_startup_pattern_rgb(generation, sequence);
    self.observedRGB = UINT32_MAX;
    self.snapshotColorSpace = @"unavailable";
#if FLUUX_STARTUP_LAB
    // Lab fault: withhold the snapshot so the request clock expires exactly as
    // it would if WebKit never answered. "first-page" stalls until the first
    // recovery reload; "every-page" stalls every document and ends on the controls.
    NSString *stall = NSProcessInfo.processInfo.environment[@"FLUUX_STARTUP_LAB_STALL"];
    if ([stall isEqualToString:@"every-page"] || ([stall isEqualToString:@"first-page"] && !self.reloaded)) {
        NSLog(@"startup-lab-stall generation=%llu sample=%llu", generation, sequence);
        return;
    }
#endif
    unsigned red = self.expectedRGB >> 16, green = (self.expectedRGB >> 8) & 255, blue = self.expectedRGB & 255;
    NSString *script = [NSString stringWithFormat:
        @"(()=>{let p=document.getElementById('__fluuxStartupSample');if(!p){p=document.createElement('div');p.id='__fluuxStartupSample';document.documentElement.appendChild(p)}p.style.cssText='all:initial!important;position:fixed!important;left:0!important;top:0!important;width:16px!important;height:16px!important;z-index:2147483647!important;background:rgb(%u,%u,%u)!important;opacity:1!important;transform:none!important;filter:none!important;transition:none!important;animation:none!important';})()", red, green, blue];
    __weak FluuxStartupAdapter *weak = self;
    [self.web evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
        FluuxStartupAdapter *self = weak;
        if (!self || self.stopped || !fluux_startup_request_matches(self.requestPending, self.requestGeneration, self.requestSequence, generation, sequence)) return;
        if (self.requestExpired) { [self complete:generation sequence:sequence result:2]; return; }
        if (error) { [self complete:generation sequence:sequence result:2]; return; }
        WKSnapshotConfiguration *config = [WKSnapshotConfiguration new];
        config.rect = CGRectMake(0, 0, 16, 16);
        [self.web takeSnapshotWithConfiguration:config completionHandler:^(NSImage *image, NSError *error) {
            FluuxStartupAdapter *self = weak;
            if (!self || self.stopped || !fluux_startup_request_matches(self.requestPending, self.requestGeneration, self.requestSequence, generation, sequence)) return;
            if (self.requestExpired) { [self complete:generation sequence:sequence result:2]; return; }
            if (error || !image) { [self complete:generation sequence:sequence result:2]; return; }
            uint32_t observed;
            char spaceName[128];
            int result = fluux_startup_compare_snapshot((__bridge void *)image, self.expectedRGB, &observed, spaceName, sizeof(spaceName));
            self.snapshotColorSpace = [NSString stringWithUTF8String:spaceName];
            self.observedRGB = observed;
            [self complete:generation sequence:sequence result:result];
        }];
    }];
}
- (void)complete:(uint64_t)generation sequence:(uint64_t)sequence result:(int)result {
    if (!fluux_startup_request_matches(self.requestPending, self.requestGeneration, self.requestSequence, generation, sequence)) return;
    NSLog(@"startup-snapshot generation=%llu sample=%llu colorSpace=%@ expectedRGB=%06x observedRGB=%06x result=%d", generation, sequence, self.snapshotColorSpace, self.expectedRGB, self.observedRGB, result);
    self.requestPending = NO;
    // Rebaseline visibility before accepting any completed callback.
    [self send:Tick generation:0 sample:0 value:[self eligible]];
    uint64_t pixels = (uint64_t)self.expectedRGB << 32 | self.observedRGB;
    // The policy owns qualification; the adapter forwards the comparison as is.
    if (!self.stopped && self.callback) self.callback(SampleResult, generation, sequence, result, pixels);
}
@end

static FluuxStartupAdapter *adapter;
void fluux_startup_install(void *webview, FluuxStartupEvent callback) {
    NSCAssert(NSThread.isMainThread, @"startup adapter must run on main thread");
    adapter = [[FluuxStartupAdapter alloc] initWithWebview:(__bridge WKWebView *)webview callback:callback];
}
void fluux_startup_sample(uint64_t generation, uint64_t sample) { [adapter sample:generation sequence:sample]; }
void fluux_startup_present(int state) { [adapter present:state]; }
void fluux_startup_reload(void) {
    adapter.reloaded = YES;
    [adapter.web reload];
}
void fluux_startup_page_started(uint64_t generation) {
    NSCAssert(NSThread.isMainThread, @"document retirement must run on main thread");
    adapter.requestPending = NO;
    adapter.requestExpired = YES;
    adapter.requestGeneration = generation;
    adapter.requestSequence = 0;
}
void fluux_startup_copy(const char *diagnostics) {
    NSString *text = [NSString stringWithUTF8String:diagnostics];
    if (text) {
        [NSPasteboard.generalPasteboard clearContents];
        [NSPasteboard.generalPasteboard setString:text forType:NSPasteboardTypeString];
    }
}
