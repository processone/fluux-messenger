"""Print the number of the largest normal-layer window owned by a process.

usage: python3 -I window.py <pid>
Exit status 1 when that process has no window on screen yet.
"""
import ctypes
import ctypes.util
import sys

CFTypeRef = ctypes.c_void_p
cg = ctypes.CDLL(ctypes.util.find_library("CoreGraphics"))
cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))
cg.CGWindowListCopyWindowInfo.restype = CFTypeRef
cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
cf.CFArrayGetCount.restype = ctypes.c_long
cf.CFArrayGetCount.argtypes = [CFTypeRef]
cf.CFArrayGetValueAtIndex.restype = CFTypeRef
cf.CFArrayGetValueAtIndex.argtypes = [CFTypeRef, ctypes.c_long]
cf.CFDictionaryGetValue.restype = CFTypeRef
cf.CFDictionaryGetValue.argtypes = [CFTypeRef, CFTypeRef]
cf.CFStringCreateWithCString.restype = CFTypeRef
cf.CFStringCreateWithCString.argtypes = [CFTypeRef, ctypes.c_char_p, ctypes.c_uint32]
cf.CFNumberGetValue.restype = ctypes.c_bool
cf.CFNumberGetValue.argtypes = [CFTypeRef, ctypes.c_int, ctypes.c_void_p]
cf.CFRelease.argtypes = [CFTypeRef]

ON_SCREEN_ONLY, EXCLUDE_DESKTOP_ELEMENTS = 1 << 0, 1 << 4
SINT64, UTF8 = 4, 0x08000100


def key(name):
    return cf.CFStringCreateWithCString(None, name.encode(), UTF8)


def number(dictionary, name):
    value = cf.CFDictionaryGetValue(dictionary, key(name))
    if not value:
        return None
    out = ctypes.c_int64()
    cf.CFNumberGetValue(value, SINT64, ctypes.byref(out))
    return out.value


def main():
    pid = int(sys.argv[1])
    windows = cg.CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS, 0)
    best = None
    for index in range(cf.CFArrayGetCount(windows)):
        entry = cf.CFArrayGetValueAtIndex(windows, index)
        if number(entry, "kCGWindowOwnerPID") != pid or number(entry, "kCGWindowLayer") != 0:
            continue
        bounds = cf.CFDictionaryGetValue(entry, key("kCGWindowBounds"))
        area = (number(bounds, "Width") or 0) * (number(bounds, "Height") or 0)
        if best is None or area > best[0]:
            best = (area, number(entry, "kCGWindowNumber"))
    cf.CFRelease(windows)
    if best is None:
        return 1
    print(best[1])
    return 0


if __name__ == "__main__":
    sys.exit(main())
