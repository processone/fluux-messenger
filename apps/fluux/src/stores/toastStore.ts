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

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (type, message, duration = DEFAULT_DURATION_MS) => {
    const id = `toast-${++nextId}`
    const toast: Toast = { id, type, message, createdAt: Date.now() }

    set((state) => {
      const toasts = state.toasts.length >= MAX_TOASTS
        ? [...state.toasts.slice(1), toast]
        : [...state.toasts, toast]
      return { toasts }
    })

    if (duration > 0) {
      setTimeout(() => {
        get().removeToast(id)
      }, duration)
    }

    return id
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }))
  },
}))
