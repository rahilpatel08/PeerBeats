import { useEffect, useRef } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLabLinks } from '../lib/demoMode';
import { roleOf, type Role } from '../lib/role';
import { cameFromLabTab, focusLabTab } from '../lib/labTabs';
import { endSession } from '../lib/session';
import { useAuth } from '../store/auth';
import { useContributor } from '../store/contributor';
import { usePlan } from '../store/plan';
import { ConnectionBanner } from './ConnectionBanner';
import { DebugPanel } from './DebugPanel';
import { Icon } from './Icon';
import { NowPlayingBar } from './NowPlayingBar';

const HOME = { to: '/', label: 'Home', icon: 'home' };
const SEARCH = { to: '/search', label: 'Search', icon: 'search' };
const LIBRARY = { to: '/library', label: 'Library', icon: 'library' };
const PLAN = { to: '/subscribe', label: 'Plan', icon: 'card' };
const CONTRIBUTE = { to: '/share', label: 'Contribute', icon: 'share' };
const ACCOUNT = { to: '/account', label: 'Account', icon: 'user' };

/** Each role sees only its own menu. */
const MENUS: Record<Role, { to: string; label: string; icon: string }[]> = {
  listener: [HOME, SEARCH, LIBRARY, PLAN, ACCOUNT],
  // A contributor shares and earns, and listens like anyone else.
  contributor: [CONTRIBUTE, HOME, SEARCH, LIBRARY, PLAN, ACCOUNT],
  admin: [HOME, SEARCH, LIBRARY, CONTRIBUTE, PLAN, { to: '/monitor', label: 'Monitor', icon: 'monitor' }, { to: '/catalog', label: 'Catalog', icon: 'catalog' }, ACCOUNT],
};

const LISTENING_PAGES = ['/', '/search', '/library', '/now'];
const ADMIN_PAGES = ['/monitor', '/catalog'];

/**
 * Where this role may not be, or null if it may. A listener only ever sees listening, and with no
 * plan goes to Plan first. A contributor sees everything but the admin pages, and can browse songs
 * without a plan: pressing play then says a plan is needed.
 */
function redirectFor(role: Role, path: string, hasPlan: boolean | null): string | null {
  const listening = LISTENING_PAGES.some((page) => (page === '/' ? path === '/' : path.startsWith(page)));
  if (role === 'contributor') return ADMIN_PAGES.includes(path) ? '/share' : null;
  if (role === 'listener') {
    if (path === '/share' || ADMIN_PAGES.includes(path)) return '/';
    if (listening && hasPlan === false) return '/subscribe';
  }
  return null;
}

export function Logo() {
  return (
    <span className="text-base font-bold">PeerBeats</span>
  );
}

export function Layout() {
  const location = useLocation();
  const user = useAuth((s) => s.user);
  const sharing = useContributor((s) => s.sharing);
  const navigate = useNavigate();
  const labLinks = useLabLinks();
  const role = user ? roleOf(user) : 'listener';
  const access = usePlan((s) => s.access);
  const items = MENUS[role];
  // Another tab keeps the Lab open on a laptop. On a phone it's a page in this same tab,
  // and moving within the app keeps the music and sharing running.
  const goToLab = () => (cameFromLabTab() ? focusLabTab() : navigate('/lab'));
  const onPlayerPage = location.pathname === '/now';
  const mainRef = useRef<HTMLElement>(null);

  // The scrolling area outlives page changes, so each new page has to start at the top.
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [location.pathname]);

  const redirect = redirectFor(role, location.pathname, access ? access.active : null);
  if (redirect && redirect !== location.pathname) return <Navigate to={redirect} replace />;

  return (
    <div className="flex h-full flex-col">
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-56 shrink-0 flex-col border-r border-line p-4 md:flex" aria-label="Main">
          <Logo />
          {labLinks && (
            <button
              onClick={goToLab}
              className="mt-4 text-left text-sm text-accent underline underline-offset-2"
            >
              Back to Lab
            </button>
          )}
          <ul className="mt-4 border-t border-line">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `flex items-center gap-2 border-b border-line py-2 text-sm transition ${isActive ? 'font-semibold text-fg' : 'text-fg-2 hover:text-fg'}`
                  }
                >
                  {item.label}
                  {item.to === '/share' && sharing && <span className="ml-auto h-2 w-2 rounded-full bg-accent" aria-label="Sharing is on" />}
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3">
            <span className="min-w-0 truncate text-xs text-fg-2">{user?.displayName}</span>
            <button
              onClick={endSession}
              aria-label="Log out"
              className="rounded p-1 text-fg-3 transition hover:text-fg"
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </nav>
        <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      {!onPlayerPage && <NowPlayingBar />}

      <nav className="no-scrollbar flex overflow-x-auto border-t border-line bg-ink-2 pb-[var(--bottom-inset,env(safe-area-inset-bottom))] md:hidden" aria-label="Main">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex min-w-[3.75rem] flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${isActive ? 'text-accent' : 'text-fg-2'}`
            }
          >
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
        {labLinks && (
          <button onClick={goToLab} className="flex min-w-[3.75rem] flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-fg-2">
            <Icon name="lab" />
            Lab
          </button>
        )}
      </nav>

      <DebugPanel />
    </div>
  );
}
