import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class'],
  theme: {
    extend: {
      fontFamily: {
        // Editorial display - book-like, distinctive
        display: ['Fraunces', 'ui-serif', 'Georgia', 'serif'],
        // Workhorse body - refined, neutral but characterful (NOT Inter)
        sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        // Paper-like neutrals, warm
        paper: {
          50: '#fbfaf7',
          100: '#f5f2eb',
          200: '#e8e2d4',
          300: '#d3cab5',
          400: '#a89e85',
          500: '#7a705a',
          600: '#574e3d',
          700: '#3d3528',
          800: '#241e15',
          900: '#14110b',
          950: '#0a0807',
        },
        // Ink-blue accent - quiet, professional
        ink: {
          50: '#eef3f9',
          100: '#d6e2f0',
          200: '#a8c0db',
          300: '#7a9ec6',
          400: '#4d7bb1',
          500: '#345e96',
          600: '#274774',
          700: '#1b3a5c',
          800: '#132a44',
          900: '#0c1b2c',
        },
      },
      borderRadius: {
        DEFAULT: '0.375rem',
      },
    },
  },
  plugins: [],
} satisfies Config;
