#import <Foundation/Foundation.h>
#include <stdbool.h>

// All calls and event callbacks run on the AppKit main thread. The adapter owns
// Cocoa objects; Rust owns policy, generations, deadlines and the retry budget.
typedef void (*FluuxStartupEvent)(int event, uint64_t generation, uint64_t sample, int value, uint64_t pixels);
typedef struct {
    double elapsed;
    double last_tick;
    bool eligible;
} FluuxStartupRequestClock;
void fluux_startup_request_clock_advance(FluuxStartupRequestClock *clock, double now, bool eligible);
// Eligibility mask: hidden=1, miniaturized=2, occluded=4, asleep=8, locked=16, invisible=32.
uint32_t fluux_startup_eligibility_failures(bool hidden, bool visible, bool miniaturized, bool occluded, bool asleep, bool locked);
uint32_t fluux_startup_pattern_rgb(uint64_t generation, uint64_t sequence);
int fluux_startup_compare_snapshot(void *snapshot, uint32_t expected, uint32_t *observed, char *space_name, size_t capacity);
void fluux_startup_install(void *webview, FluuxStartupEvent callback);
void fluux_startup_sample(uint64_t generation, uint64_t sample);
void fluux_startup_present(int state);
void fluux_startup_reload(void);
void fluux_startup_page_started(uint64_t generation);
bool fluux_startup_request_matches(bool pending, uint64_t active_generation, uint64_t active_sequence, uint64_t generation, uint64_t sequence);
void fluux_startup_copy(const char *diagnostics);
