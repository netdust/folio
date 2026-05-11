import type { Config } from 'tailwindcss';
import tailwindcssAnimate from 'tailwindcss-animate';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        shell:      'var(--color-shell)',
        content:    'var(--color-content)',
        'brand-2':  'var(--color-brand-2)',
        card:       'var(--color-card)',
        'border-light': 'var(--color-border-light)',
        'border-row':   'var(--color-border-row)',

        fg:    'var(--color-fg)',
        'fg-2':'var(--color-fg-2)',
        'fg-3':'var(--color-fg-3)',
        'fg-on-primary': 'var(--color-fg-on-primary)',

        primary:    'var(--color-primary)',
        'primary-fg': 'var(--color-primary-fg)',

        success: 'var(--color-success)',
        danger:  'var(--color-danger)',
        warning: 'var(--color-warning)',
        info:    'var(--color-info)',

        'bg-success': 'var(--color-bg-success)',
        'bg-danger':  'var(--color-bg-danger)',
        'bg-warning': 'var(--color-bg-warning)',
        'bg-info':    'var(--color-bg-info)',
      },
      borderRadius: {
        sm:   'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md:   'var(--radius-md)',
        lg:   'var(--radius-lg)',
        xl:   'var(--radius-xl)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        surface: 'var(--shadow-surface)',
        card:    'var(--shadow-card)',
        popover: 'var(--shadow-popover)',
      },
      transitionTimingFunction: {
        default: 'var(--ease-default)',
      },
      transitionDuration: {
        fast:    '120ms',
        default: '200ms',
        slow:    '280ms',
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
