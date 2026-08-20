# Start Development Server

Start the reportflow Express + tRPC dev server with hot reload. Runs the real `appRouter` (not a stub), so local calls exercise the same routes and auth flow as production.

```bash
pnpm dev
```

Frontend dev server (Vite) runs separately:

```bash
pnpm dev:app
```
