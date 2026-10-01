# MessageList Testing Strategy

This document outlines the testing strategy for the complex scroll, keyboard navigation, mouse management, and position saving behavior in the message list components.

## Overview of Interacting Features

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MessageList System                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐ │
│  │ Scroll Behavior │◄──►│ Keyboard Nav    │◄──►│ Mouse Tracking  │ │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘ │
│           │                      │                      │          │
│           ▼                      ▼                      ▼          │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐ │
│  │ Position Save   │    │ Selection State │    │ Hover State     │ │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## 1. State Machine Modeling

Model each feature as a state machine to ensure all transitions are tested.

### 1.1 Scroll State Machine

Use the [positioning contract's entry and follow-live rules](../../../../../docs/2026-07-23-scroll-positioning-contract.md#entry-arbitration-and-later-supersession)
for scroll transitions, including unread-marker holds and keyboard completion. The contract's
[test standard](../../../../../docs/2026-07-23-scroll-positioning-contract.md#test-standard)
owns the required positioning controls.

### 1.2 Selection State Machine

```
States:
- NO_SELECTION: No message selected
- KEYBOARD_SELECTION: Message selected via keyboard
- HOVER_TRACKED: Mouse hovering over message (no selection)

Transitions:
- NO_SELECTION → KEYBOARD_SELECTION: Arrow key (from hover or last visible)
- NO_SELECTION → HOVER_TRACKED: Mouse moves over message
- KEYBOARD_SELECTION → NO_SELECTION: clearSelection() or mouse takes over
- KEYBOARD_SELECTION → KEYBOARD_SELECTION: Arrow key navigation
- HOVER_TRACKED → KEYBOARD_SELECTION: Arrow key pressed
- HOVER_TRACKED → NO_SELECTION: Mouse leaves message area
```

### 1.3 Position Save State Machine

```
States:
- UNINITIALIZED: First time viewing conversation
- VIEWING: Currently viewing conversation
- SAVED: Position saved (was scrolled up when switching)
- UNSAVED: No position saved (was at bottom when switching)

Transitions:
- UNINITIALIZED → VIEWING: Conversation opened (entry arbitration from §1.1)
- VIEWING → SAVED: Switch conversation while scrolled up
- VIEWING → UNSAVED: Switch conversation while at bottom
- SAVED → VIEWING: Return to conversation (restore position)
- UNSAVED → VIEWING: Return to conversation (entry arbitration from §1.1)
```

## 2. Test Categories

### 2.1 Unit Tests (Pure Logic)

Test individual functions and hooks in isolation:

```typescript
// Example: Test scroll position calculation
describe('scroll position tracking', () => {
  it('detects at bottom when within threshold', () => {
    const isAtBottom = calculateIsAtBottom({
      scrollHeight: 1000,
      scrollTop: 960,
      clientHeight: 100,
    })
    expect(isAtBottom).toBe(true) // 1000 - 960 - 100 = -60 < 50
  })

  it('detects scrolled up when beyond threshold', () => {
    const isAtBottom = calculateIsAtBottom({
      scrollHeight: 1000,
      scrollTop: 800,
      clientHeight: 100,
    })
    expect(isAtBottom).toBe(false) // 1000 - 800 - 100 = 100 > 50
  })
})
```

### 2.2 Integration Tests (Feature Interactions)

Test how features interact with each other:

```typescript
describe('keyboard-mouse interaction', () => {
  it('keyboard navigation disables auto-scroll', () => {
    // 1. Start at bottom (auto-scroll enabled)
    // 2. Press ArrowUp
    // 3. Verify isAtBottom is false
    // 4. New message arrives
    // 5. Verify we did NOT auto-scroll
  })

  it('mouse movement re-enables auto-scroll after clearing selection', () => {
    // 1. Navigate with keyboard (selection active)
    // 2. Move mouse significantly
    // 3. Verify selection cleared
    // 4. Scroll to bottom manually
    // 5. New message arrives
    // 6. Verify we DID auto-scroll
  })
})
```

### 2.3 Scenario Tests (User Journeys)

Test complete user workflows:

```typescript
describe('user scenarios', () => {
  it('Scenario: Read history then return to live messages', () => {
    // 1. Open conversation (at bottom)
    // 2. Scroll up to read history
    // 3. Switch to another conversation
    // 4. Switch back
    // 5. Verify position restored (not at bottom)
    // 6. Scroll to bottom
    // 7. Switch away and back
    // 8. Verify now at bottom (position not saved)
  })

  it('Scenario: Keyboard navigate while messages arrive', () => {
    // 1. Open conversation
    // 2. Move keyboard selection above the live edge
    // 3. New message arrives
    // 4. Verify we did NOT auto-scroll
    // 5. Selected message still visible
    // 6. Clear selection
    // 7. Scroll to bottom
    // 8. New message arrives
    // 9. Verify we DID auto-scroll
  })
})
```

## 3. Test Utilities

### 3.1 Mock Scroll Container

```typescript
// src/test-utils/mockScrollContainer.ts
export function createMockScrollContainer(options: {
  scrollHeight: number
  clientHeight: number
  initialScrollTop?: number
}) {
  let scrollTop = options.initialScrollTop ?? options.scrollHeight - options.clientHeight

  return {
    get scrollHeight() { return options.scrollHeight },
    get clientHeight() { return options.clientHeight },
    get scrollTop() { return scrollTop },
    set scrollTop(value: number) { scrollTop = value },
    scrollTo: vi.fn(({ top }) => { scrollTop = top }),
    getBoundingClientRect: () => ({
      top: 0,
      bottom: options.clientHeight,
      height: options.clientHeight,
    }),
  }
}
```

### 3.2 Mock Message Elements

```typescript
// src/test-utils/mockMessageElements.ts
export function createMockMessageElements(
  messages: { id: string }[],
  container: MockScrollContainer
) {
  const messageHeight = 60

  return {
    querySelector: (selector: string) => {
      const match = selector.match(/\[data-message-id="(.+)"\]/)
      if (!match) return null

      const messageId = match[1]
      const index = messages.findIndex(m => m.id === messageId)
      if (index === -1) return null

      const top = index * messageHeight - container.scrollTop
      return {
        getBoundingClientRect: () => ({
          top,
          bottom: top + messageHeight,
          height: messageHeight,
        }),
        scrollIntoView: vi.fn(),
      }
    },
  }
}
```

### 3.3 Scenario Builder

```typescript
// src/test-utils/scenarioBuilder.ts
export class MessageListScenario {
  private actions: Array<() => void | Promise<void>> = []
  private assertions: Array<() => void> = []

  scrollTo(position: 'bottom' | 'top' | number) {
    this.actions.push(() => { /* ... */ })
    return this
  }

  pressKey(key: 'ArrowUp' | 'ArrowDown') {
    this.actions.push(() => { /* ... */ })
    return this
  }

  hoverMessage(messageId: string) {
    this.actions.push(() => { /* ... */ })
    return this
  }

  moveMouse(dx: number, dy: number) {
    this.actions.push(() => { /* ... */ })
    return this
  }

  switchConversation(conversationId: string) {
    this.actions.push(() => { /* ... */ })
    return this
  }

  receiveNewMessage() {
    this.actions.push(() => { /* ... */ })
    return this
  }

  waitMs(ms: number) {
    this.actions.push(() => vi.advanceTimersByTime(ms))
    return this
  }

  expectScrollPosition(expected: 'bottom' | 'top' | number) {
    this.assertions.push(() => { /* ... */ })
    return this
  }

  expectSelection(messageId: string | null) {
    this.assertions.push(() => { /* ... */ })
    return this
  }

  async run() {
    for (const action of this.actions) {
      await action()
    }
    for (const assertion of this.assertions) {
      assertion()
    }
  }
}
```

## 4. Edge Case Matrix

Create a matrix of scenarios to ensure coverage:

| Scenario | Scroll | Keyboard | Mouse | Position | Expected |
|----------|--------|----------|-------|----------|----------|
| First open | - | - | - | uninitialized | Entry arbitration (§1.1) |
| At bottom + new msg | bottom | - | - | - | Follow-live policy (§1.1) |
| Scrolled up + new msg | up | - | - | - | Stay in place |
| Keyboard nav + new msg | - | active | - | - | Follow-live policy (§1.1) |
| Switch while at bottom | bottom | - | - | - | Don't save |
| Switch while scrolled | up | - | - | - | Save position |
| Return with saved pos | - | - | - | saved | Restore position |
| Return without saved | - | - | - | unsaved | Entry arbitration (§1.1) |
| Arrow from hover | - | - | hovering | - | Start from hover |
| Arrow without hover | - | - | not hovering | - | Start from visible |
| Mouse after keyboard | - | active | moves | - | Clear selection |
| Mouse during cooldown | - | cooldown | moves | - | Keep selection |

## 5. Regression Test Suite

Create a dedicated regression test file for bugs that were fixed:

Conversation-entry regression coverage follows the positioning contract linked in §1.1.

```typescript
// src/components/conversation/__tests__/MessageList.regression.test.tsx
describe('MessageList Regressions', () => {
  describe('ISSUE-002: Position not restored when returning to conversation', () => {
    it('should restore saved scroll position', async () => {
      // Bug: Returning to scrolled-up conversation would scroll to bottom
      // Fix: Track isAtBottom and only save when scrolled up
    })
  })

  describe('ISSUE-003: Alt+Arrow navigating both sidebar and messages', () => {
    it('should pass Alt+Arrow through to sidebar', () => {
      // Bug: Alt+Arrow moved selection in both areas
      // Fix: Add `if (e.altKey) return` to let event bubble
    })
  })

  describe('ISSUE-004: Keyboard navigation not starting from hovered message', () => {
    it('should start navigation from hovered message', () => {
      // Bug: Arrow key started from last visible, ignoring hover
      // Fix: Track hoveredMessageIdRef and use it as starting point
    })
  })
})
```

## 6. Test Implementation Plan

### Phase 1: Extract Testable Units
- [ ] Extract scroll position calculation to pure function
- [ ] Extract isAtBottom calculation to pure function
- [ ] Extract message visibility detection to pure function
- [ ] Create mock utilities (scroll container, message elements)

### Phase 2: State Machine Tests
- [ ] Test all scroll state transitions
- [ ] Test all selection state transitions
- [ ] Test all position save state transitions
- [ ] Add invalid transition tests (ensure they're handled)

### Phase 3: Integration Tests
- [ ] Test keyboard-mouse interaction
- [ ] Test scroll-keyboard interaction
- [ ] Test position save-restore cycle
- [ ] Test new message arrival scenarios

### Phase 4: Scenario Tests
- [ ] "Read history and return" scenario
- [ ] "Keyboard navigate during live chat" scenario
- [ ] "Switch conversations rapidly" scenario
- [ ] "Mixed keyboard and mouse usage" scenario

### Phase 5: Regression Suite
- [ ] Document each fixed bug as a test case
- [ ] Add test that reproduces the original bug
- [ ] Verify the fix prevents regression

## 7. Continuous Monitoring

### 7.1 Test Coverage Thresholds

```javascript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      thresholds: {
        'src/hooks/useMessageSelection.ts': {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
        },
        'src/components/conversation/MessageList.tsx': {
          statements: 80,
          branches: 75,
          functions: 85,
          lines: 80,
        },
      },
    },
  },
})
```

### 7.2 Performance Benchmarks

Track render performance to catch regressions:

```typescript
describe('performance', () => {
  it('should render 100 messages in under 100ms', () => {
    const start = performance.now()
    render(<MessageList messages={createMessages(100)} />)
    const duration = performance.now() - start
    expect(duration).toBeLessThan(100)
  })

  it('should handle rapid scroll events without lag', () => {
    // Simulate 60fps scroll events
    // Measure frame drops
  })
})
```

## 8. File Organization

```
src/components/conversation/
├── MessageList.tsx
├── MessageList.test.tsx           # Main component tests
├── __tests__/
│   ├── MessageList.regression.test.tsx  # Regression suite
│   ├── MessageList.scenarios.test.tsx   # User journey tests
│   └── MessageList.integration.test.tsx # Feature interaction tests
├── __mocks__/
│   └── scrollContainer.ts         # Mock utilities
└── TESTING_STRATEGY.md            # This document

src/hooks/
├── useMessageSelection.ts
├── useMessageSelection.test.tsx   # Unit tests
└── __tests__/
    └── useMessageSelection.integration.test.tsx
```
