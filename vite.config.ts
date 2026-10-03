import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run build:static` sets VITE_STATIC=1: the online build, served from www.wouterschreuders.com/fonts/
// as plain files with no server behind it (README, "Online version"). Dev and `npm run build` are unchanged.
// server/export-static.ts writes its catalog and font files for the same base.
const STATIC = process.env.VITE_STATIC === "1";

export default defineConfig({
  plugins: [react()],
  base: STATIC ? "/fonts/" : "/",
  build: STATIC ? { outDir: "dist-static" } : {},
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? 8787}` },
  },
});
