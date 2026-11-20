import { useState, type ReactNode } from 'react';
import {
  Cpu,
  FolderGit2,
  HardDrive,
  LayoutDashboard,
  RefreshCw,
  Shield,
} from 'lucide-react';
import { t } from '../../i18n/translations';
import type { Locale } from '../../types/commandCenter';

export type NavTabId =
  | 'dashboard'
  | 'wings'
  | 'projects'
  | 'storage'
  | 'device'
  | 'audit'
  | 'roadmap';

interface CommandShellProps {
  locale: Locale;
  activeTab: NavTabId;
  demoMode?: boolean;
  onSelectTab: (tab: NavTabId) => void;
  onRunSystemCheck: () => void;
  isChecking: boolean;
  children: ReactNode;
}

const CREST_SRC = '/src/assets/images/ng_ilmf_crest_1794980198705.jpg';

export function CommandShell({
  locale,
  activeTab,
  demoMode = false,
  onSelectTab,
  onRunSystemCheck,
  isChecking,
  children,
}: CommandShellProps) {
  const copy = t(locale);
  const [crestFailed, setCrestFailed] = useState(false);

  const navItems: Array<{ id: NavTabId; label: string; icon: typeof LayoutDashboard }> = [
    { id: 'dashboard', label: copy.navDashboard, icon: LayoutDashboard },
    { id: 'wings', label: copy.navWings, icon: Cpu },
    { id: 'projects', label: copy.navProjects, icon: FolderGit2 },
    { id: 'storage', label: copy.navStorage, icon: HardDrive },
    { id: 'device', label: copy.navDeviceSec, icon: Shield },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#FFF8E8] text-[#26170F]">
      {/* Top Bar Contract: Exactly 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 h-14 bg-[#26170F] text-[#FFF8E8] border-b border-[#D4AF37]/30 px-4 lg:px-8 flex items-center justify-between gap-8">
        {/* Zone 1: Brand mark & single-line wordmark */}
        <button
          type="button"
          onClick={() => {
            if (!demoMode) onSelectTab('dashboard');
          }}
          className="flex items-center gap-3 whitespace-nowrap shrink-0 min-h-[44px] focus-visible:outline-2 focus-visible:outline-[#D4AF37] rounded-md"
        >
          {!crestFailed ? (
            <img
              src={CREST_SRC}
              alt="NG-ILMF Crest"
              referrerPolicy="no-referrer"
              onError={() => setCrestFailed(true)}
              className="h-8 w-8 rounded-md object-cover border border-[#D4AF37]/50 shrink-0"
            />
          ) : (
            <div className="h-8 w-8 rounded-md bg-[#3B2419] border border-[#D4AF37]/60 flex items-center justify-center text-[#D4AF37] font-mono text-xs font-bold shrink-0">
              NG
            </div>
          )}
          <span className="font-display text-base lg:text-lg font-bold tracking-wider text-[#F3D989] whitespace-nowrap shrink-0">
            {copy.brandShort}
          </span>
        </button>

        {/* Zone 2: 5 clean single-line navigation links (Hidden in Isolated Demo Mode) */}
        {!demoMode ? (
          <nav
            aria-label="Primary Navigation"
            className="hidden md:flex items-center gap-5 lg:gap-6 text-sm font-medium"
          >
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectTab(item.id)}
                  className={`min-h-[44px] px-1 inline-flex items-center whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-[#D4AF37] ${
                    isActive
                      ? 'border-[#D4AF37] text-[#F3D989]'
                      : 'border-transparent text-[#FFF8E8]/80 hover:text-[#F3D989] hover:border-[#D4AF37]/40'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        ) : (
          <div className="hidden md:block font-mono text-xs font-bold text-[#F3D989] tracking-wider">
            ISOLATED DEMO SANDBOX
          </div>
        )}

        {/* Zone 3: 1 primary action (Hidden in Isolated Demo Mode) */}
        <div className="shrink-0">
          {!demoMode ? (
            <button
              type="button"
              onClick={onRunSystemCheck}
              disabled={isChecking}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-[#D4AF37] hover:bg-[#F3D989] disabled:opacity-60 text-[#26170F] font-semibold text-xs inline-flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F3D989]"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isChecking ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>{isChecking ? copy.actionVerifying : copy.actionVerifySystem}</span>
            </button>
          ) : (
            <span className="font-mono text-xs text-[#FFF8E8]/70">READ-ONLY</span>
          )}
        </div>
      </header>

      {/* Main Content Canvas */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-24 md:pb-12">
        {children}
      </main>

      {/* Mobile Thumb-Zone Bottom Navigation (< 768px) — hidden in Isolated Demo Mode */}
      {!demoMode && (
        <nav
          aria-label="Mobile Navigation"
          className="md:hidden fixed bottom-0 inset-x-0 z-40 h-14 bg-[#26170F]/95 backdrop-blur-md border-t border-[#D4AF37]/30 grid grid-cols-5"
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 px-1 transition-colors cursor-pointer ${
                  isActive ? 'text-[#F3D989]' : 'text-[#FFF8E8]/70 hover:text-[#FFF8E8]'
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                <span className="text-[11px] font-medium whitespace-nowrap truncate max-w-full">
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
