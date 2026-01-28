# Development

This are a few commands to get you started building the client locally.

## Quick Start

```bash
# Install dependencies
npm install

# Build the client
npm run build

# Start dev server
npm run dev
```

Open http://localhost:5173 and connect with your XMPP credentials.

## Available Scripts

| Command               | Description                         |
|-----------------------|-------------------------------------|
| `npm run dev`         | Start the web client dev server     |
| `npm run build`       | Build SDK and app for production    |
| `npm run build:sdk`   | Build the React SDK only            |
| `npm run build:app`   | Build the web client only           |
| `npm run test`        | Run all tests                       |
| `npm run typecheck`   | Type-check all packages             |
| `npm run lint`        | Run ESLint on all packages          |
| `npm run tauri:dev`   | Run desktop app in development mode |
| `npm run tauri:build` | Build desktop app for distribution  |
