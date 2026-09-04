import {
  inferGrafanaStyleLaunchUrl,
  isLikelySpOAuthLaunchUrl,
  pickOidcSpLaunchUrl,
} from './portal-launch.js';

describe('portal-launch', () => {
  it('detects Grafana/PMM generic_oauth URLs', () => {
    const url = 'https://pmm-eks.lenskart.com/graph/login/generic_oauth';
    expect(isLikelySpOAuthLaunchUrl(url)).toBe(true);
    expect(pickOidcSpLaunchUrl([url])).toBe(url);
  });

  it('derives generic_oauth from /graph/login redirect', () => {
    expect(inferGrafanaStyleLaunchUrl('https://pmm-eks.lenskart.com/graph/login')).toBe(
      'https://pmm-eks.lenskart.com/graph/login/generic_oauth',
    );
  });

  it('derives generic_oauth from root /login redirect', () => {
    expect(inferGrafanaStyleLaunchUrl('https://grafana.example.com/login')).toBe(
      'https://grafana.example.com/login/generic_oauth',
    );
  });

  it('does not treat bare callback URLs as launch URLs', () => {
    const callback = 'https://app.example.com/oauth/callback';
    expect(isLikelySpOAuthLaunchUrl(callback)).toBe(false);
    expect(pickOidcSpLaunchUrl([callback])).toBeNull();
  });

  it('prefers generic_oauth redirect over login page', () => {
    const launch = pickOidcSpLaunchUrl([
      'https://pmm-eks.lenskart.com/graph/login',
      'https://pmm-eks.lenskart.com/graph/login/generic_oauth',
    ]);
    expect(launch).toBe('https://pmm-eks.lenskart.com/graph/login/generic_oauth');
  });
});
