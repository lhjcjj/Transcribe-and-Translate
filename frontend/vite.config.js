import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        host: "0.0.0.0", // 允许内网访问：本机 IP:5173
        proxy: {
            "/api": { target: "http://localhost:8000", changeOrigin: true },
            "/health": { target: "http://localhost:8000", changeOrigin: true },
        },
    },
});
