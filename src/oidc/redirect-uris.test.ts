import {
  expandOidcRedirectUris,
  normalizeRedirectUri,
  redirectUrisMatch,
} from './redirect-uris.js';
import { inferGrafanaStyleLaunchUrl } from './portal-launch.js';

describe('redirect-uris', () => {
  it('matches PMM /graph/login to /graph/login/generic_oauth', () => {
    const registered = 'https://pmm-eks.lenskart.com/graph/login';
    const requested = 'https://pmm-eks.lenskart.com/graph/login/generic_oauth';
    expect(redirectUrisMatch(registered, requested)).toBe(true);
    expect(inferGrafanaStyleLaunchUrl(registered)).toBe(requested);
  });

  it('expands Grafana login URIs on registration', () => {
    const expanded = expandOidcRedirectUris([
      'https://grafana.example.com/login',
    ]);
    expect(expanded).toContain('https://grafana.example.com/login/generic_oauth');
  });

  it('normalizes trailing slashes', () => {
    const a = normalizeRedirectUri('https://app.example.com/callback/');
    const b = normalizeRedirectUri('https://app.example.com/callback');
    expect(a).toBe(b);
  });
});
