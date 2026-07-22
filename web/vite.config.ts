import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.TOKEMBER_DEV_API || 'http://localhost:3147'
    }
  },
  build: {
    outDir: 'dist'
  }
})
