/** @vitest-environment jsdom */
import { afterEach, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { showStartupStatus } from '../startupStatus';

afterEach(() => document.body.replaceChildren());

it('announces wallet initialization while keeping the spinner decorative', () => {
  document.body.innerHTML = '<main id="root"></main>';

  const startupStatus = showStartupStatus();

  const status = document.querySelector('#root [role="status"]');
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(status).toHaveTextContent('Starting wallet…');
  expect(status?.querySelector('.wallet-spinner')).toHaveAttribute(
    'aria-hidden',
    'true'
  );
  expect(status?.querySelector('.startup-status-brand')).toHaveAttribute(
    'src',
    '/assets/images/OPTNWelcome1.png'
  );

  startupStatus.setMessage('Loading security module…');
  expect(status).toHaveTextContent('Loading security module…');

  startupStatus.clear();
  expect(document.querySelector('#root [role="status"]')).toBeNull();
});

it('does nothing when the application root is unavailable', () => {
  expect(() => showStartupStatus()).not.toThrow();
});
