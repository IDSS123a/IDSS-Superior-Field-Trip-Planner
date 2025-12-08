import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  // Set the third parameter to '' to load all env regardless of the `VITE_` prefix.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    // Base path is important for Vercel deployment structure
    base: './', 
    define: {
      // Explicitly replace these variables with their string values during build
      // The JSON.stringify is crucial because Vite expects the value to be a code snippet string
      'process.env.API_KEY': JSON.stringify(env.VITE_API_KEY || env.API_KEY || ''),
      'process.env.VITE_GEMINI_API_KEYS': JSON.stringify(env.VITE_GEMINI_API_KEYS || ''),
      
      // Fallback for any other process.env access (safety net)
      // This combined with the index.html script ensures robustness
      'process.env': JSON.stringify({}), 
    },
  };
});