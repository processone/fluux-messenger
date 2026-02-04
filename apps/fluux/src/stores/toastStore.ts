import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  type: ToastType
  message: string
  createdAt: number
}

interface ToastState {
  toasts: Toast[]
  addToast: (type: ToastType, message: string, duration?: number) => string
  removeToast: (id: string) => void
}

const MAX_TOASTS = 3
const DEFAULT_DURATION_MS = 4000

let nextId = 0
const timeouts = new Map<string, ReturnType<typeof setTimeout>>()

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (type, message, duration = DEFAULT_DURATION_MS) => {
    const id = `toast-${++nextId}`
    const toast: Toast = { id, type, message, createdAt: Date.now() }

    set((state) => {
      // Clear timeout for evicted toast
      if (state.toasts.length >= MAX_TOASTS) {
        const evictedId = state.toasts[0].id
        const evictedTimeout = timeouts.get(evictedId)
        if (evictedTimeout) {
          clearTimeout(evictedTimeout)
          timeouts.delete(evictedId)
        }
      }
      const toasts = state.toasts.length >= MAX_TOASTS
        ? [...state.toasts.slice(1), toast]
        : [...state.toasts, toast]
      return { toasts }
    })

    if (duration > 0) {
      const timeout = setTimeout(() => {
        timeouts.delete(id)
        get().removeToast(id)
      }, duration)
      timeouts.set(id, timeout)
    }

    return id
  },

  removeToast: (id) => {
    const timeout = timeouts.get(id)
    if (timeout) {
      clearTimeout(timeout)
      timeouts.delete(id)
    }
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }))
  },
}))
