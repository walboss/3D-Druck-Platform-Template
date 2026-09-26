import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * Eigenes PrimeNG-Preset auf Aura-Basis.
 * Primärfarbe: Teal (passend zu "Maker"/3D-Druck), etwas rundere Ecken.
 */
export const AppPreset = definePreset(Aura, {
  primitive: {
    borderRadius: {
      none: '0',
      xs: '4px',
      sm: '6px',
      md: '10px',
      lg: '14px',
      xl: '20px',
    },
  },
  semantic: {
    primary: {
      50: '{teal.50}',
      100: '{teal.100}',
      200: '{teal.200}',
      300: '{teal.300}',
      400: '{teal.400}',
      500: '{teal.500}',
      600: '{teal.600}',
      700: '{teal.700}',
      800: '{teal.800}',
      900: '{teal.900}',
      950: '{teal.950}',
    },
    colorScheme: {
      light: {
        primary: {
          color: '{teal.600}',
          contrastColor: '#ffffff',
          hoverColor: '{teal.700}',
          activeColor: '{teal.800}',
        },
        highlight: {
          background: '{teal.50}',
          focusBackground: '{teal.100}',
          color: '{teal.800}',
          focusColor: '{teal.900}',
        },
      },
      dark: {
        primary: {
          color: '{teal.400}',
          contrastColor: '{teal.950}',
          hoverColor: '{teal.300}',
          activeColor: '{teal.200}',
        },
        highlight: {
          background: 'color-mix(in srgb, {teal.400}, transparent 84%)',
          focusBackground: 'color-mix(in srgb, {teal.400}, transparent 76%)',
          color: 'rgba(255, 255, 255, 0.9)',
          focusColor: 'rgba(255, 255, 255, 0.9)',
        },
      },
    },
  },
});
