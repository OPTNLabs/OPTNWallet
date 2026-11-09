/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleExternalLinkClick } from '../openExternalLink';

afterEach(() => {
  vi.restoreAllMocks();
});

function event(overrides: Partial<MouseEvent> = {}): MouseEvent {
  const anchor = document.createElement('a');
  anchor.href = 'https://explorer.example/tx/abc';
  return {
    button: 0,
    currentTarget: anchor,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as unknown as MouseEvent;
}

describe('handleExternalLinkClick', () => {
  it('reports a popup block instead of silently failing', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const click = event();

    handleExternalLinkClick(click, 'Browser failed');

    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('Browser failed');
  });

  it('opens normal browser links and preserves modified clicks', () => {
    const opened = { opener: window } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(opened);
    const click = event();

    handleExternalLinkClick(click, 'Browser failed');

    expect(open).toHaveBeenCalledWith(
      'https://explorer.example/tx/abc',
      '_blank'
    );
    expect(opened.opener).toBeNull();
    expect(click.preventDefault).toHaveBeenCalledOnce();

    const modified = event({ ctrlKey: true });
    handleExternalLinkClick(modified, 'Browser failed');
    expect(open).toHaveBeenCalledOnce();
    expect(modified.preventDefault).not.toHaveBeenCalled();
  });
});
