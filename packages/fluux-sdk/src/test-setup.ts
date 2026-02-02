/**
 * Global test setup file for Vitest.
 *
 * This file is loaded before each test file and sets up global mocks.
 */

import { vi } from 'vitest'

// Mock global fetch to prevent real network calls in tests
// This prevents XEP-0156 WebSocket discovery from making actual HTTP requests
const mockFetch = () =>
  Promise.reject(new Error('Test mock: Network request not allowed'))

global.fetch = mockFetch as typeof fetch

// Silence console output in tests to reduce noise
// This silences expected debug output like FLUUX debug utilities
// Individual tests can restore console methods if they need to test console output
vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'error').mockImplementation(() => {})
