#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <dlfcn.h>
#include <stdint.h>

// Keep the host's old deployment target free of Swift runtime dependencies. The optional
// writer is a macOS 14 library inside this app, never a library found through a search path.
int32_t fluux_desktop_widgets_apply(const char *operation, const char *json) {
    if (NSProcessInfo.processInfo.operatingSystemVersion.majorVersion < 14) return 0;
    typedef int32_t (*Apply)(const char *, const char *);
    static Apply apply = NULL;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *frameworks = NSBundle.mainBundle.privateFrameworksPath;
        if (!frameworks) return;
        NSString *path = [frameworks stringByAppendingPathComponent:@"libFluuxWidgets.dylib"];
        // Retain the handle for the process lifetime: Swift owns shared state inside the library.
        void *library = dlopen(path.fileSystemRepresentation, RTLD_NOW | RTLD_LOCAL);
        if (library) apply = (Apply)dlsym(library, "fluux_widgets_apply");
    });
    return apply ? apply(operation, json) : -2;
}
