/**
 * Avatar + banner colors per role. Admin keeps the default purple.
 * Used by the header avatar and the profile modal so both show the same color.
 */
export const ROLE_THEME = {
  admin: {
    avatar: 'radial-gradient(circle at 32% 26%, #8b8cff, #5b5bd6 60%, #4a49b8)',
    solid: '#5b5bd6',
    shadow: 'rgba(74, 73, 184, 0.35)',
    banner: '#1a2133',
  },
  marketing: {
    avatar: 'radial-gradient(circle at 32% 26%, #ff8a8a, #e5484d 60%, #b42328)',
    solid: '#e5484d',
    shadow: 'rgba(229, 72, 77, 0.35)',
    banner: '#2a1719',
  },
  sales: {
    avatar: 'radial-gradient(circle at 32% 26%, #7ee8a4, #2fb36a 60%, #1f8a50)',
    solid: '#2fb36a',
    shadow: 'rgba(47, 179, 106, 0.35)',
    banner: '#132a1d',
  },
  logistics: {
    avatar: 'radial-gradient(circle at 32% 26%, #c99a6b, #8b5a2b 60%, #6b4220)',
    solid: '#8b5a2b',
    shadow: 'rgba(139, 90, 43, 0.35)',
    banner: '#2a2019',
  },
};

export function roleTheme(role) {
  return ROLE_THEME[role] || ROLE_THEME.admin;
}
