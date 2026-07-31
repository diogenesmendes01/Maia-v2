/**
 * Single source of truth for the console's information architecture.
 *
 * The IA is agent-first: the operator's daily loop is
 *   Agentes → (configurar / aprovar) → Aprovações → Observabilidade.
 * Platform-wide settings live at the bottom, founder-only entries flagged.
 */
export interface NavItem {
  href: string;
  label: string;
  icon:
    | 'home'
    | 'bot'
    | 'inbox'
    | 'gitBranch'
    | 'alertTriangle'
    | 'search'
    | 'brain'
    | 'layers'
    | 'zap'
    | 'wrench'
    | 'activity'
    | 'message'
    | 'users'
    | 'settings'
    | 'sparkles'
    | 'shield';
  founderOnly?: boolean;
  /** When set, the item is active for any path under this prefix. */
  activePrefix?: string;
}

export interface NavSection {
  label: string | null;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      { href: '/dashboard', label: 'Visão geral', icon: 'home' },
      { href: '/agents', label: 'Agentes', icon: 'bot', activePrefix: '/agents' },
      { href: '/inbox', label: 'Aprovações', icon: 'inbox', activePrefix: '/proposals' },
    ],
  },
  {
    label: 'Governança',
    items: [
      { href: '/identities', label: 'Identidades', icon: 'sparkles' },
      { href: '/versions', label: 'Versões', icon: 'gitBranch' },
      { href: '/drift', label: 'Drift', icon: 'alertTriangle' },
      { href: '/traces', label: 'Traces', icon: 'search', activePrefix: '/traces' },
      { href: '/audit', label: 'Auditoria', icon: 'shield' },
    ],
  },
  {
    label: 'Capacidades',
    items: [
      { href: '/capabilities', label: 'Capacidades', icon: 'brain' },
      { href: '/skills', label: 'Skills', icon: 'zap' },
      { href: '/procedures', label: 'Procedures', icon: 'layers' },
      { href: '/knowledge', label: 'Conhecimento', icon: 'activity' },
      { href: '/tools', label: 'Ferramentas', icon: 'wrench' },
    ],
  },
  {
    label: 'Plataforma',
    items: [
      // Issue #519 — a jornada de provisionamento ponta a ponta. Fica em
      // Plataforma (e não em Agentes) porque uma run pode criar o TENANT antes
      // de existir agente algum.
      { href: '/onboarding', label: 'Onboarding', icon: 'sparkles', activePrefix: '/onboarding' },
      { href: '/setup/channels', label: 'Canais', icon: 'message' },
      { href: '/setup/mcp', label: 'Conexões MCP', icon: 'wrench' },
      { href: '/setup/tenants', label: 'Tenants', icon: 'users', founderOnly: true },
      {
        href: '/setup/llm-settings',
        label: 'Modelos LLM',
        icon: 'settings',
        founderOnly: true,
      },
    ],
  },
];
