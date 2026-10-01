import SectionCard from '../../components/ui/SectionCard';
import { useTheme } from '../../app/theme/useTheme';
import {
  THEME_MODES,
  THEME_MODE_DESCRIPTIONS,
  THEME_MODE_LABELS,
  UI_SKINS,
  UI_SKIN_DESCRIPTIONS,
  UI_SKIN_LABELS,
} from '../../app/theme/themeContextCore';

/**
 * Appearance: four colour modes and a skin on top of them.
 *
 * The selection is application state, not renderer state — on desktop it is
 * stored by the Rust runtime, so the same choice applies whichever renderer
 * paints the wallet. Changing it touches no wallet, key or network.
 */
export function AppearanceSettings() {
  const { mode, skin, setMode, setSkin } = useTheme();

  return (
    <div className="space-y-3">
      <SectionCard className="p-4">
        <p className="text-sm font-semibold wallet-text-strong">Theme</p>
        <p className="mt-1 text-sm wallet-muted">
          Changing the theme does not change your wallets, keys, or network.
        </p>
        <div
          className="mt-3 grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label="Theme"
        >
          {THEME_MODES.map((candidate) => {
            const active = candidate === mode;
            return (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`theme-${candidate}`}
                onClick={() => setMode(candidate)}
                className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  active
                    ? 'border-[var(--wallet-accent)] bg-[var(--wallet-selectable-active-bg)]'
                    : 'border-[var(--wallet-border)] wallet-surface-strong'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`inline-block h-4 w-4 rounded-full border border-[var(--wallet-border)] theme-swatch-${candidate}`}
                  />
                  <span className="text-sm font-semibold wallet-text-strong">
                    {THEME_MODE_LABELS[candidate]}
                  </span>
                </span>
                <span className="mt-1 block text-xs wallet-muted">
                  {THEME_MODE_DESCRIPTIONS[candidate]}
                </span>
              </button>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard className="p-4">
        <p className="text-sm font-semibold wallet-text-strong">Skin</p>
        <p className="mt-1 text-sm wallet-muted">
          Chrome on top of the theme. Text contrast stays readable in both.
        </p>
        <div
          className="mt-3 grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label="Skin"
        >
          {UI_SKINS.map((candidate) => {
            const active = candidate === skin;
            return (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`skin-${candidate}`}
                onClick={() => setSkin(candidate)}
                className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  active
                    ? 'border-[var(--wallet-accent)] bg-[var(--wallet-selectable-active-bg)]'
                    : 'border-[var(--wallet-border)] wallet-surface-strong'
                }`}
              >
                <span className="text-sm font-semibold wallet-text-strong">
                  {UI_SKIN_LABELS[candidate]}
                </span>
                <span className="mt-1 block text-xs wallet-muted">
                  {UI_SKIN_DESCRIPTIONS[candidate]}
                </span>
              </button>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
}

export default AppearanceSettings;
