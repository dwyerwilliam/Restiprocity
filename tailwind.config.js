/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/renderer/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Restiprocity custom palette
        primary: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
        sidebar: {
          bg: '#1e1e2e',
          hover: '#2a2a3c',
          active: '#33334d',
          text: '#cdd6f4',
        },
        editor: {
          bg: '#181825',
          gutter: '#313244',
          border: '#45475a',
        },
      },
    },
  },
  plugins: [],
};
