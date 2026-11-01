/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/client/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        vibely: {
          bg: '#09090f',
          panel: '#12121e',
          card: '#181828',
          border: '#272740',
          accent: '#ec4899',
          violet: '#8b5cf6',
          gold: '#f59e0b'
        }
      }
    }
  },
  plugins: []
};
