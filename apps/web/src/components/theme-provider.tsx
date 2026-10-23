/**
 * Theme provider for the app.
 */

import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import type { ReactNode } from 'react';

export function ThemeProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}

export const useThemeSafe = useTheme;
