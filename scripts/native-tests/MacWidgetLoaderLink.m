#import <Foundation/Foundation.h>
#include <stdint.h>
#include <stdio.h>

extern int32_t fluux_desktop_widgets_apply(const char *, const char *);

// Review E1: a host linked at the existing deployment target must run without Swift.
// This unbundled probe deliberately has no optional library or App Group metadata.
int main(void) {
    @autoreleasepool {
        int32_t expected = NSProcessInfo.processInfo.operatingSystemVersion.majorVersion < 14 ? 0 : -2;
        if (fluux_desktop_widgets_apply("list", "null") != expected) return 1;
        puts("Swift-free host loader handles unsupported or unbundled hosts");
    }
    return 0;
}
