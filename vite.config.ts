import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react({ jsxImportSource: "/src/jsx" })], // Apple emoji in all text, see src/jsx/jsx-runtime.ts
  // the rust crypto package loads its .wasm via new URL(..., import.meta.url); pre-bundling breaks that
  optimizeDeps: { exclude: ["@matrix-org/matrix-sdk-crypto-wasm"] },
});
